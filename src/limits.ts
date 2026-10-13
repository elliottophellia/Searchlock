import { createHash } from "node:crypto";
import { sleep } from "./support.ts";

/** Sliding window: at most `perMinute` acquisitions per rolling 60 seconds. */
export class SlidingWindow {
  private stamps: number[] = [];
  constructor(private perMinute: number) {
    this.perMinute = Math.max(1, Math.floor(perMinute));
  }
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 60_000);
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(now);
        return;
      }
      const wait = 60_000 - (now - this.stamps[0]!);
      if (wait > 0) await sleep(wait);
      else this.stamps.shift();
    }
  }
  get idle(): boolean {
    const now = Date.now();
    return !this.stamps.some((t) => now - t < 60_000);
  }
}

/** Token bucket: bursts up to `perMinute`, then refills at that rate. */
export class TokenBucket {
  private tokens: number;
  private updated = Date.now();
  constructor(private perMinute: number) {
    this.perMinute = Math.max(1, Math.floor(perMinute));
    this.tokens = this.perMinute;
  }
  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(
      this.perMinute,
      this.tokens + ((now - this.updated) / 60_000) * this.perMinute,
    );
    this.updated = now;
  }
  async take(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      await sleep(((1 - this.tokens) / this.perMinute) * 60_000);
      this.refill();
    }
    this.tokens -= 1;
  }
  get idle(): boolean {
    this.refill();
    return this.tokens >= this.perMinute;
  }
}

export type Limiter = { take(): Promise<void>; readonly idle: boolean };

export function makeLimiter(strategy: string, perMinute: number): Limiter {
  if (strategy === "token_bucket") return new TokenBucket(perMinute);
  return new SlidingWindow(perMinute);
}

/** Per-host limiter so one site cannot spend the whole fetch budget. */
export class HostLimiter {
  private limiters = new Map<string, Limiter>();
  constructor(
    private strategy: string,
    private perMinute: number,
  ) {}
  async take(url: string): Promise<void> {
    let host = "unknown";
    try {
      host = new URL(url).hostname.toLowerCase() || "unknown";
    } catch {
      /* keep unknown */
    }
    for (const [name, limiter] of this.limiters) {
      if (name !== host && limiter.idle) this.limiters.delete(name);
    }
    let limiter = this.limiters.get(host);
    if (!limiter) {
      limiter = makeLimiter(this.strategy, this.perMinute);
      this.limiters.set(host, limiter);
    }
    await limiter.take();
  }
}

/** Tiny TTL map with LRU eviction for fetched pages. */
export class TtlCache<V> {
  private store = new Map<string, { expires: number; value: V }>();
  constructor(
    private ttlMs: number,
    private maxEntries: number,
  ) {}
  get enabled(): boolean {
    return this.ttlMs > 0 && this.maxEntries > 0;
  }
  get(key: string): V | undefined {
    if (!this.enabled) return undefined;
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expires) {
      this.store.delete(key);
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }
  set(key: string, value: V): void {
    if (!this.enabled) return;
    const now = Date.now();
    for (const [k, entry] of this.store) {
      if (now >= entry.expires) this.store.delete(k);
    }
    this.store.delete(key);
    if (this.store.size >= this.maxEntries) {
      this.store.delete(this.store.keys().next().value!);
    }
    this.store.set(key, { expires: now + this.ttlMs, value });
  }
}

/**
 * Short stable tokens for over-long result URLs so they stop eating
 * context. `fetch_content` accepts a token wherever a URL goes.
 */
export class RefLinks {
  private table = new Map<string, string>();
  constructor(private maxEntries = 2048) {}
  get size(): number {
    return this.table.size;
  }
  shorten(url: string): string {
    const digest = createHash("sha256").update(url, "utf8").digest("hex");
    let id = digest.slice(0, 8);
    for (let len = 8; len <= digest.length; len++) {
      id = digest.slice(0, len);
      const known = this.table.get(id);
      if (known === undefined || known === url) break;
    }
    this.table.delete(id);
    this.table.set(id, url);
    while (this.table.size > this.maxEntries) {
      this.table.delete(this.table.keys().next().value!);
    }
    return `ref://${id}`;
  }
  resolve(token: string): string | undefined {
    let id = token.trim();
    if (id.toLowerCase().startsWith("ref://")) id = id.slice("ref://".length);
    id = id.replace(/^\/+|\/+$/g, "").toLowerCase();
    const url = this.table.get(id);
    if (url !== undefined) {
      this.table.delete(id);
      this.table.set(id, url);
    }
    return url;
  }
}

export function isRefToken(value: string): boolean {
  return value.trim().toLowerCase().startsWith("ref://");
}
