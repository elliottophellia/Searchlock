import { collapseSpace, sleep, stripTags } from "./support.ts";

export type Vertical = "web" | "news" | "images" | "videos" | "goggles";

export interface WebHit {
  url: string;
  title: string | null;
  description: string | null;
  age: string | null;
  source: string | null;
}
export interface NewsHit {
  url: string;
  title: string | null;
  description: string | null;
  age: string | null;
  source: string | null;
  thumbnail: string | null;
}
export interface ImageHit {
  url: string;
  title: string | null;
  source: string | null;
}
export interface VideoHit {
  url: string;
  title: string | null;
  duration: string | null;
  channel: string | null;
  thumbnail: string | null;
}
export interface BraveResults {
  query: string;
  vertical: Vertical;
  web: WebHit[];
  news: NewsHit[];
  images: ImageHit[];
  videos: VideoHit[];
  hasMore: boolean | null;
}

const BASE = "https://search.brave.com";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

export class BraveError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export interface BraveOptions {
  country?: string;
  language?: string;
  timeoutMs?: number;
  maxRetries?: number;
  proxies?: string[];
}

export class BraveClient {
  private country: string;
  private timeoutMs: number;
  private maxRetries: number;
  private proxyIndex = 0;
  private opened = false;

  constructor(options: BraveOptions = {}) {
    this.country = options.country ?? "us";
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 3;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    // Warm up the session the same way a browser landing on the page would.
    await this.get(`${BASE}/ask`, "text/html");
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  private pickProxy(proxies: string[]): string | undefined {
    if (!proxies.length) return undefined;
    const proxy = proxies[this.proxyIndex! % proxies.length];
    this.proxyIndex += 1;
    return proxy;
  }

  private async get(url: string, accept: string, proxies: string[] = []): Promise<string> {
    let attempt = 0;
    let lastError: unknown = null;
    const tries = Math.max(1, this.maxRetries + 1);
    while (attempt < tries) {
      attempt++;
      try {
        const proxy = this.pickProxy(proxies);
        const response = await fetch(url, {
          headers: { "User-Agent": UA, Accept: accept, Referer: `${BASE}/` },
          proxy,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
          lastError = new BraveError(`HTTP ${response.status}`, response.status);
          await sleep(1500 * 2 ** (attempt - 1));
          continue;
        }
        if (!response.ok) throw new BraveError(`HTTP ${response.status}`, response.status);
        return await response.text();
      } catch (exc) {
        if (exc instanceof BraveError && exc.status !== undefined && exc.status < 500) throw exc;
        lastError = exc;
        await sleep(1500 * 2 ** (attempt - 1));
      }
    }
    if (lastError instanceof BraveError) throw lastError;
    throw new BraveError(`request failed: ${String(lastError)}`);
  }

  private searchUrl(path: string, query: string, offset: number, spellcheck: boolean): string {
    const params = new URLSearchParams({ q: query, source: "web" });
    if (offset > 0) params.set("offset", String(offset));
    if (!spellcheck) params.set("spellcheck", "0");
    return `${BASE}${path}?${params}`;
  }

  async searchWeb(query: string, offset = 0, spellcheck = true): Promise<BraveResults> {
    const html = await this.get(this.searchUrl("/search", query, offset, spellcheck), "text/html");
    const { web, news, hasMore } = parseSerp(html);
    return { query, vertical: "web", web, news, images: [], videos: [], hasMore };
  }

  async searchNews(query: string, offset = 0, spellcheck = true): Promise<BraveResults> {
    const html = await this.get(this.searchUrl("/news", query, offset, spellcheck), "text/html");
    const news = parseNewsVertical(html);
    return { query, vertical: "news", web: [], news, images: [], videos: [], hasMore: null };
  }

  async searchImages(query: string, offset = 0, spellcheck = true): Promise<BraveResults> {
    const html = await this.get(this.searchUrl("/images", query, offset, spellcheck), "text/html");
    return { query, vertical: "images", web: [], news: [], images: parseImages(html), videos: [], hasMore: null };
  }

  async searchVideos(query: string, offset = 0, spellcheck = true): Promise<BraveResults> {
    const html = await this.get(this.searchUrl("/videos", query, offset, spellcheck), "text/html");
    return { query, vertical: "videos", web: [], news: [], images: [], videos: parseVideos(html), hasMore: null };
  }

  async searchGoggles(query: string, offset = 0, spellcheck = true): Promise<BraveResults> {
    const html = await this.get(
      this.searchUrl("/goggles", query, offset, spellcheck),
      "text/html",
    );
    const { web } = parseSerp(html);
    return { query, vertical: "goggles", web, news: [], images: [], videos: [], hasMore: null };
  }

  async suggest(query: string, rich = true): Promise<string[]> {
    const params = new URLSearchParams({
      q: query,
      rich: rich ? "true" : "false",
      source: "web",
      country: this.country,
    });
    const body = await this.get(`${BASE}/api/suggest?${params}`, "*/*");
    return parseSuggest(body);
  }
}

// --- Parsing (written against the live markup; covered by live checks) ---

function cutBlocks(html: string, startRe: RegExp, stopRes: RegExp[] = []): string[] {
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  startRe.lastIndex = 0;
  while ((m = startRe.exec(html)) !== null) starts.push(m.index);
  const stops: number[] = [];
  for (const re of stopRes) {
    re.lastIndex = 0;
    let s: RegExpExecArray | null;
    while ((s = re.exec(html)) !== null) stops.push(s.index);
  }
  const bounds = [...starts, ...stops, html.length].sort((a, b) => a - b);
  return starts.map((from) => html.slice(from, bounds.find((b) => b > from) ?? html.length));
}

function firstExternalUrl(block: string): string | null {
  for (const m of block.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>/gi)) {
    const url = m[1]!;
    if (url.includes("search.brave.com/search")) continue;
    return url;
  }
  const data = /data-url="(https?:\/\/[^"]+)"/i.exec(block);
  if (data && !data[1]!.includes("search.brave.com/search")) return data[1];
  return null;
}

function textAfter(block: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(block);
    if (m) {
      const text = collapseSpace(stripTags(m[1]!)).replace(/^[A-Za-z]+ \d{1,2}, \d{4} -\s*/, "");
      if (text) return text;
    }
  }
  return null;
}

const TITLE_RES = [
  /<div[^>]+class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  /<span[^>]+class="[^"]*\bsnippet-title\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
];
const DESC_RES = [
  /<p[^>]+class="[^"]*\bsnippet-description\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
  /<div[^>]+class="[^"]*\binline-qa-question\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  /<div[^>]+class="[^"]*\bgeneric-snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
];

function parseSerp(html: string): { web: WebHit[]; news: NewsHit[]; hasMore: boolean | null } {
  const web: WebHit[] = [];
  const seen = new Set<string>();
  const blocks = cutBlocks(html, /<div[^>]+class="[^"]*\bsnippet\b[^"]*"[^>]+data-pos="\d+"/g, [
    /<div[^>]+class="[^"]*\bnews-article\b[^"]*"[^>]*>/g,
  ]);
  for (const block of blocks) {
    const url = firstExternalUrl(block);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    let title = textAfter(block, TITLE_RES);
    if (!title) {
      const cite = /<cite[^>]*>([\s\S]*?)<\/cite>/i.exec(block);
      title = cite ? collapseSpace(stripTags(cite[1]!)) : null;
    }
    if (!title) continue;
    web.push({ url, title, description: textAfter(block, DESC_RES), age: null, source: null });
  }
  const news: NewsHit[] = [];
  for (const block of cutBlocks(html, /<div[^>]+class="[^"]*\bnews-article\b[^"]*"[^>]*>/g)) {
    const url = firstExternalUrl(block);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const img = /<img[^>]+src="(https?:\/\/[^"]+)"/i.exec(block);
    news.push({
      url,
      title: textAfter(block, TITLE_RES),
      description: textAfter(block, DESC_RES),
      age: null,
      source: null,
      thumbnail: img ? img[1]! : null,
    });
  }
  return { web, news, hasMore: /class="pagination/.test(html) ? false : null };
}

function parseNewsVertical(html: string): NewsHit[] {
  const news: NewsHit[] = [];
  const seen = new Set<string>();
  const blocks = cutBlocks(
    html,
    /<div[^>]+class="[^"]*\bsnippet\b[^"]*"[^>]+data-pos="\d+"[^>]+data-type="news"/g,
  );
  for (const block of blocks) {
    const href = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>/i.exec(block);
    const url = href?.[1];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const field = (name: string): string | null => {
      const m = new RegExp(
        `<(?:span|div)[^>]+class="[^"]*\\b${name}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/(?:span|div)>`,
        "i",
      ).exec(block);
      return m ? collapseSpace(stripTags(m[1]!)) || null : null;
    };
    const img = /<img[^>]+src="(https?:\/\/[^"]+)"/i.exec(block);
    news.push({
      url,
      title: field("title"),
      description: field("description"),
      age: field("age-snippet"),
      source: field("site-name-content"),
      thumbnail: img ? img[1]! : null,
    });
  }
  return news;
}

function parseImages(html: string): ImageHit[] {
  const images: ImageHit[] = [];
  const seen = new Set<string>();
  for (const block of cutBlocks(html, /<button[^>]+class="[^"]*\bimage-result\b[^"]*"[^>]*>/g)) {
    const src = /<img[^>]+src="(https?:\/\/[^"]+)"/i.exec(block);
    const url = src?.[1];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const alt = /<img[^>]+alt="([^"]*)"/i.exec(block);
    images.push({ url, title: alt ? alt[1]! || null : null, source: null });
  }
  return images;
}

function parseVideos(html: string): VideoHit[] {
  const videos: VideoHit[] = [];
  const seen = new Set<string>();
  for (const block of cutBlocks(
    html,
    /<div[^>]+class="[^"]*\bsnippet\b[^"]*"[^>]+data-pos="\d+"[^>]+data-type="videos"/g,
  )) {
    const href = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>/i.exec(block);
    const url = href?.[1];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const field = (name: string): string | null => {
      const m = new RegExp(
        `<(?:span|div)[^>]+class="[^"]*\\b${name}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/(?:span|div)>`,
        "i",
      ).exec(block);
      return m ? collapseSpace(stripTags(m[1]!)) || null : null;
    };
    const img = /<img[^>]+src="(https?:\/\/[^"]+)"/i.exec(block);
    videos.push({
      url,
      title: field("title") ?? field("description"),
      duration: field("duration"),
      channel: field("site-name-content"),
      thumbnail: img ? img[1]! : null,
    });
  }
  return videos;
}

export function parseSuggest(body: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }
  const out: string[] = [];
  const push = (item: unknown): void => {
    if (typeof item === "string") {
      if (item) out.push(item);
      return;
    }
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const text = [record["q"], record["query"], record["text"]]
        .find((v): v is string => typeof v === "string" && v.trim().length > 0)
        ?.trim();
      if (text) out.push(text);
    }
  };
  if (Array.isArray(data) && data.length >= 2 && Array.isArray(data[1])) {
    (data[1] as unknown[]).forEach(push);
  } else if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const list = record["suggestions"] ?? record["results"];
    if (Array.isArray(list)) list.forEach(push);
  }
  return out;
}
