/** Live end-to-end checks against the real endpoints: `bun run tests/live.ts`.
 * A provider that rate limits this network is reported as SKIP, not FAIL.
 * Any other error is a FAIL and the script exits nonzero. */
import { BraveClient, BraveError } from "../src/brave.ts";
import { loadConfig } from "../src/config.ts";
import { DdgSearcher, PageFetcher } from "../src/ddg.ts";
import { createServer } from "../src/server.ts";

const failures: string[] = [];
const skips: string[] = [];

function report(name: string, status: "PASS" | "SKIP" | "FAIL", detail = ""): void {
  console.log(`${status}: ${name}${detail ? ` (${detail})` : ""}`);
  if (status === "FAIL") failures.push(name);
  if (status === "SKIP") skips.push(name);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rateLimited = (exc: unknown): boolean =>
  exc instanceof BraveError && exc.message.includes("HTTP 429");

const config = loadConfig();
const searcher = new DdgSearcher(config.safesearch, config.ddgRegion, config.refThreshold);
const fetcher = new PageFetcher(false, 60, 0, "sliding", 300, 64);
const brave = new BraveClient({ maxRetries: 2 });

await wait(2000);
let firstUrl = "https://example.com";
try {
  const hits = await searcher.search("python asyncio tutorial", null, 5);
  if (hits.length < 3) throw new Error(`only ${hits.length} results`);
  if (!hits.every((h) => h.title && h.link)) throw new Error("empty title or link");
  firstUrl = hits[0]!.link;
  report("ddg_search_web", "PASS", `${hits.length} results`);
} catch (exc) {
  report("ddg_search_web", "FAIL", String(exc));
}

await wait(3000);
try {
  const hits = await searcher.search("news", null, 3, "jp-ja");
  if (!Array.isArray(hits)) throw new Error("not a list");
  report("ddg_search_region", "PASS", `${hits.length} results for jp-ja`);
} catch (exc) {
  report("ddg_search_region", "FAIL", String(exc));
}

await wait(3000);
try {
  const page = await fetcher.fetch(firstUrl, null, 0, 2000);
  if (page.startsWith("Error")) throw new Error(page.slice(0, 120));
  if (page.length < 200) throw new Error("page body too short");
  report("ddg_fetch_result_page", "PASS", `${page.length} chars`);
} catch (exc) {
  report("ddg_fetch_result_page", "FAIL", String(exc));
}

await wait(3000);
try {
  const text = await fetcher.fetch("https://example.com", null, 0, 5000, "text");
  const main = await fetcher.fetch("https://example.com", null, 0, 5000, "main");
  const markdown = await fetcher.fetch("https://example.com", null, 0, 5000, "markdown");
  for (const [name, body] of [["text", text], ["main", main], ["markdown", markdown]] as const) {
    if (!body.includes("This domain is for use")) throw new Error(`${name} mode missed body text`);
  }
  const again = await fetcher.fetch("https://example.com", null, 0, 100);
  if (!again.includes("cache=hit")) throw new Error("expected a cache hit on re-read");
  report("ddg_fetch_modes_and_cache", "PASS", "text/main/markdown plus cache hit");
} catch (exc) {
  report("ddg_fetch_modes_and_cache", "FAIL", String(exc));
}

await wait(3000);
try {
  await brave.open();
  try {
    const items = await brave.suggest("python asy");
    if (!items.length) throw new Error("no suggestions");
    report("brave_suggest", "PASS", `${items.length} suggestions`);
  } catch (exc) {
    if (rateLimited(exc)) report("brave_suggest", "SKIP", "HTTP 429 from this network");
    else throw exc;
  }
  const verticals = [
    ["brave_search_web", () => brave.searchWeb("python asyncio")] as const,
    ["brave_search_news", () => brave.searchNews("python release")] as const,
    ["brave_search_images", () => brave.searchImages("python logo")] as const,
    ["brave_search_videos", () => brave.searchVideos("python tutorial")] as const,
  ];
  for (const [name, call] of verticals) {
    await wait(4000);
    try {
      const result = await call();
      const count =
        result.web.length + result.news.length + result.images.length + result.videos.length;
      if (!count) throw new Error("no results parsed");
      report(name, "PASS", `${count} results`);
    } catch (exc) {
      if (rateLimited(exc)) report(name, "SKIP", "HTTP 429 from this network");
      else report(name, "FAIL", String(exc));
    }
  }
} catch (exc) {
  report("brave_session", "FAIL", String(exc));
} finally {
  await brave.close();
}

try {
  const server = createServer(config);
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
    ._registeredTools;
  if (!tools || !["search", "suggest", "fetch_content", "expand_link"].every((n) => n in tools)) {
    throw new Error("expected 4 registered tools");
  }
  report("server_registers_four_tools", "PASS");
} catch (exc) {
  report("server_registers_four_tools", "FAIL", String(exc));
}

console.log(`\n${failures.length} failed, ${skips.length} skipped`);
if (failures.length) {
  console.log(`Failures: ${failures.join(", ")}`);
  process.exit(1);
}
