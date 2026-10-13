import { lookup } from "node:dns/promises";
import {
  HostLimiter,
  RefLinks,
  TtlCache,
  isRefToken,
  makeLimiter,
  type Limiter,
} from "./limits.ts";
import { canonicalUrl, collapseSpace, decodeEntities, sleep, stripTags } from "./support.ts";

export interface DdgHit {
  title: string;
  link: string;
  snippet: string;
  position: number;
}

export type SafeSearch = "off" | "moderate" | "strict";
const KP: Record<SafeSearch, string> = { strict: "1", moderate: "-1", off: "-2" };

const SEARCH_URL = "https://html.duckduckgo.com/html";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

export const sharedRefs = new RefLinks();

export function unknownRef(token: string): string {
  return (
    `Error: Unknown link reference '${token.trim()}'. Only ref:// tokens returned by ` +
    `this server's search results can be expanded, and they are forgotten when the ` +
    `server restarts. Run the search again to get a fresh token.`
  );
}

export class DdgSearcher {
  private limiter: Limiter;
  constructor(
    private safeSearch: SafeSearch = "moderate",
    private region = "",
    private refThreshold = 120,
    searchRpm = 30,
    strategy = "sliding",
    private refs: RefLinks = sharedRefs,
  ) {
    this.limiter = makeLimiter(strategy, searchRpm);
  }

  private displayUrl(url: string): string {
    if (!this.refThreshold || url.length <= this.refThreshold) return url;
    const token = this.refs.shorten(url);
    return `${token} (long URL shortened; pass to fetch_content as-is, or call expand_link for the full URL)`;
  }

  format(hits: DdgHit[]): string {
    if (!hits.length) {
      return (
        "No results were found for your search query. This could be due to " +
        "DuckDuckGo's bot detection or the query returned no matches. Please try " +
        "rephrasing your search or try again in a few minutes."
      );
    }
    const lines = [`Found ${hits.length} search results:\n`];
    for (const hit of hits) {
      lines.push(`${hit.position}. ${hit.title}`);
      lines.push(`   URL: ${this.displayUrl(hit.link)}`);
      lines.push(`   Summary: ${hit.snippet}`);
      lines.push("");
    }
    return lines.join("\n");
  }

  async search(
    query: string,
    log: { info(m: string): void; error(m: string): void } | null,
    maxResults = 10,
    region = "",
  ): Promise<DdgHit[]> {
    await this.limiter.take();
    const form = new URLSearchParams({
      q: query,
      b: "",
      kl: region || this.region,
      kp: KP[this.safeSearch],
    });
    log?.info(`Searching DuckDuckGo for: ${query}`);
    let html: string;
    try {
      const response = await fetch(SEARCH_URL, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429) {
        const wait = retryAfterMs(response.headers.get("retry-after"));
        await sleep(wait);
        const retry = await fetch(SEARCH_URL, {
          method: "POST",
          headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
          signal: AbortSignal.timeout(30_000),
        });
        if (!retry.ok) throw new Error(`HTTP ${retry.status}`);
        html = await retry.text();
      } else if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      } else {
        html = await response.text();
      }
    } catch (exc) {
      log?.error(`Search request failed: ${String(exc)}`);
      return [];
    }
    const hits = parseResultPage(html, maxResults);
    log?.info(`DuckDuckGo returned ${hits.length} results`);
    return hits;
  }
}

/** Pull result entries out of the DDG html endpoint response. */
export function parseResultPage(html: string, maxResults: number): DdgHit[] {
  const hits: DdgHit[] = [];
  const starts: number[] = [];
  const opener = /<div[^>]*class="result(?:\s|")[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(html)) !== null) starts.push(match.index);
  starts.push(html.length);
  for (let i = 0; i < starts.length - 1 && hits.length < maxResults; i++) {
    const block = html.slice(starts[i], starts[i + 1]!);
    const link = firstResultLink(block);
    if (!link) continue;
    const titleMatch = /class="result__title"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const title = titleMatch ? collapseSpace(stripTags(titleMatch[1]!)) : "";
    if (!title) continue;
    const snippetMatch = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:p|div|span|a)>/i.exec(block);
    const snippet = snippetMatch ? collapseSpace(stripTags(snippetMatch[1]!)) : "";
    hits.push({ title, link, snippet, position: hits.length + 1 });
  }
  return hits;
}

function firstResultLink(block: string): string | null {
  const anchors = block.matchAll(/<a[^>]*href="([^"]*)"[^>]*>/gi);
  for (const anchor of anchors) {
    let href = decodeEntities(anchor[1]!);
    if (href.includes("y.js")) continue;
    const uddg = /[?&]uddg=([^&]*)/.exec(href);
    if (uddg) {
      try {
        href = decodeURIComponent(uddg[1]!);
      } catch {
        continue;
      }
    }
    if (/^https?:\/\//i.test(href)) return href;
  }
  return null;
}

function retryAfterMs(header: string | null): number {
  if (!header) return 2000;
  const seconds = Number.parseFloat(header.trim());
  if (!Number.isFinite(seconds)) return 2000;
  return Math.min(Math.max(0, seconds) * 1000, 30_000);
}

// --- SSRF guard ---

function ipv4Private(bytes: number[]): boolean {
  const [a, b] = bytes;
  if (a === 10) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0 || a! >= 224) return true;
  if (a === 100 && b! >= 64 && b! <= 127) return true;
  if (a === 192 && (b === 0 || b === 18 || b === 19)) return true;
  if (a === 198 && (b === 18 || b === 19 || b! >= 51)) return true;
  if (a === 203 && b === 0) return true;
  return false;
}

function ipv6Blocked(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fec0:") || lower.startsWith("ff")) return true;
  if (lower.startsWith("::ffff:")) {
    const tail = lower.slice("::ffff:".length);
    if (tail.includes(".")) {
      const bytes = tail.split(".").map(Number);
      if (bytes.length === 4 && bytes.every((n) => Number.isInteger(n))) {
        return ipv4Private(bytes as number[]);
      }
    }
    return true;
  }
  if (/^(2001:db8|64:ff9b|100:|2001:|2002:)/.test(lower)) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

export async function assertPublicUrl(raw: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported scheme '${parsed.protocol}' (only http and https allowed)`);
  }
  const host = parsed.hostname;
  if (!host) throw new Error("URL has no host");
  if (host.toLowerCase() === "localhost" || host.toLowerCase().endsWith(".localhost")) {
    throw new Error(`refusing loopback host '${host}'`);
  }
  let records: string[];
  try {
    records = await lookup(host, { all: true }).then((all) => all.map((r) => r.address));
  } catch (exc) {
    throw new Error(`could not resolve host '${host}': ${String(exc)}`);
  }
  for (const address of records) {
    const blocked = address.includes(":")
      ? ipv6Blocked(address)
      : ipv4Private(address.split(".").map(Number));
    if (blocked) {
      throw new Error(`refusing to fetch '${host}' (resolves to non-public ${address})`);
    }
  }
}

// --- Page fetching ---

export type ParseMode = "text" | "main" | "markdown";
export type FetchBackend = "httpx" | "curl" | "auto";

const CHROME = ["script", "style", "nav", "header", "footer"];
const CHROME_MAIN = [...CHROME, "aside", "form", "noscript"];

function dropTags(html: string, tags: string[]): string {
  let out = html;
  for (const tag of tags) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }
  return out;
}

function innerOf(html: string, tag: string): string | null {
  const found = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html);
  return found ? found[1]! : null;
}

/** Prefer the article body; fall back to the whole document body. */
function mainRoot(html: string): string {
  for (const tag of ["article", "main"]) {
    const inner = innerOf(html, tag);
    if (inner && collapseSpace(stripTags(inner)).length >= 40) return inner;
  }
  const body = innerOf(html, "body");
  return body ?? html;
}

function markdownInline(fragment: string): string {
  let out = fragment;
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(
    /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, label: string) => {
      const clean = href.trim().replace(/\)/g, "%29");
      const text = collapseSpace(stripTags(label));
      if (/^https?:\/\/\S+$/i.test(clean) && text) return `[${text}](${clean})`;
      return text;
    },
  );
  out = out.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$2**");
  out = out.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$2*");
  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  return collapseSpace(stripTags(out));
}

function toMarkdown(root: string): string {
  const parts: string[] = [];
  const blocks = root.split(/<(h[1-6]|p|pre|ul|ol|blockquote|hr)\b([^>]*)>/gi);
  // blocks[0] is preamble; then repeating triples of tag, attrs, body.
  for (let i = 1; i < blocks.length; i += 3) {
    const tag = blocks[i]!.toLowerCase();
    const body = blocks[i + 2] ?? "";
    const inner = body.split(new RegExp(`</${tag}>`, "i"))[0] ?? "";
    if (tag === "hr") {
      parts.push("---", "");
    } else if (tag.startsWith("h")) {
      const text = collapseSpace(stripTags(inner));
      if (text) parts.push(`${"#".repeat(Number(tag[1]))} ${text}`, "");
    } else if (tag === "pre") {
      parts.push("```", inner.replace(/\n$/, ""), "```", "");
    } else if (tag === "ul" || tag === "ol") {
      const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)];
      items.forEach((item, index) => {
        const bullet = tag === "ol" ? `${index + 1}.` : "-";
        parts.push(`${bullet} ${collapseSpace(stripTags(item[1]!))}`);
      });
      if (items.length) parts.push("");
    } else if (tag === "blockquote") {
      const text = collapseSpace(stripTags(inner));
      if (text) parts.push(`> ${text}`, "");
    } else {
      const text = markdownInline(inner);
      if (text) parts.push(text, "");
    }
    void blocks[i + 1];
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function htmlToText(html: string, mode: ParseMode): string {
  if (mode === "text") {
    return collapseSpace(stripTags(dropTags(html, CHROME)));
  }
  const root = mainRoot(dropTags(html, CHROME_MAIN));
  if (mode === "main") return collapseSpace(stripTags(root));
  return toMarkdown(root);
}

export class PageFetcher {
  private limiter: Limiter;
  private hostLimiter: HostLimiter | null;
  private cache: TtlCache<string>;
  constructor(
    private allowPrivate = false,
    private rpm = 20,
    hostRpm = 0,
    strategy = "sliding",
    cacheTtlSec = 300,
    cacheMax = 64,
    private parseMode: ParseMode = "text",
    private refs: RefLinks = sharedRefs,
  ) {
    this.limiter = makeLimiter(strategy, rpm);
    this.hostLimiter = hostRpm > 0 ? new HostLimiter(strategy, hostRpm) : null;
    this.cache = new TtlCache<string>(cacheTtlSec * 1000, cacheMax);
  }

  private async get(url: string): Promise<string> {
    let current = url;
    for (let hop = 0; hop <= 5; hop++) {
      if (!this.allowPrivate) await assertPublicUrl(current);
      const response = await fetch(current, {
        headers: { "User-Agent": UA },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429) {
        await sleep(retryAfterMs(response.headers.get("retry-after")));
        continue;
      }
      const location = response.headers.get("location");
      if (location && [301, 302, 303, 307, 308].includes(response.status)) {
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    }
    throw new Error("too many redirects");
  }

  async fetch(
    url: string,
    log: { info(m: string): void; error(m: string): void } | null,
    startIndex = 0,
    maxLength = 8000,
    parseMode?: ParseMode,
  ): Promise<string> {
    if (isRefToken(url)) {
      const resolved = this.refs.resolve(url);
      if (!resolved) return unknownRef(url);
      url = resolved;
    }
    const mode = parseMode ?? this.parseMode;
    if (mode !== "text" && mode !== "main" && mode !== "markdown") {
      return `Error: Unknown parse_mode '${mode}'. Supported: text, main, markdown`;
    }
    const key = `${canonicalUrl(url)}|${mode}`;
    let text = this.cache.get(key);
    const hit = text !== undefined;
    if (!hit) {
      if (this.hostLimiter) await this.hostLimiter.take(url);
      await this.limiter.take();
      log?.info(`Fetching content from: ${url}`);
      try {
        text = htmlToText(await this.get(url), mode);
      } catch (exc) {
        const message = String(exc);
        if (message.startsWith("Error: refusing") || message.startsWith("Error: not a valid")) {
          return (
            `Error: Refusing to fetch ${url} (${message}). This server blocks requests to ` +
            `private/internal addresses. For trusted local use, set SEARCHLOCK_ALLOW_PRIVATE_URLS=1.`
          );
        }
        log?.error(`Fetch failed for ${url}: ${message}`);
        return `Error: Could not access the webpage (${message})`;
      }
      this.cache.set(key, text);
    } else {
      log?.info(`Cache hit for ${url}; skipping download`);
    }
    const total = text?.length ?? 0;
    const slice = (text ?? "").slice(startIndex, startIndex + maxLength);
    let meta =
      `\n\n---\n[Content info: Showing characters ${startIndex}-` +
      `${startIndex + slice.length} of ${total} total`;
    if (startIndex + maxLength < total) {
      meta += `. Use start_index=${startIndex + maxLength} to see more`;
    }
    if (this.cache.enabled) meta += ` | cache=${hit ? "hit" : "miss"}`;
    if (mode !== "text") meta += ` | parse=${mode}`;
    return slice + meta + "]";
  }
}
