/** Protocol end-to-end checks: `bun run tests/e2e.ts`.
 * Spawns the real server over stdio and drives every tool the way an agent
 * would: search, follow a result into fetch_content, paginate, expand a
 * ref:// token, and handle bad input. Exits nonzero on any failure. */
import { spawn } from "node:child_process";

const failures: string[] = [];
let checked = 0;

function check(name: string, ok: boolean, detail = ""): void {
  checked++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Session {
  private proc: ReturnType<typeof spawn>;
  private buffer = "";
  private id = 0;
  private pending = new Map<number, (msg: unknown) => void>();
  constructor(env: Record<string, string>) {
    this.proc = spawn("bun", ["run", "src/index.ts"], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let leftover = "";
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      leftover += chunk.toString();
      const lines = leftover.split("\n");
      leftover = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number };
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        }
      }
    });
  }
  call(method: string, params?: unknown): Promise<Record<string, unknown>> {
    this.id++;
    const id = this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 90_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg as Record<string, unknown>);
      });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method: string): void {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }
  textOf(response: Record<string, unknown>): string {
    const result = response["result"] as { content: Array<{ text: string }> };
    return result.content.map((c) => c.text).join("\n");
  }
  kill(): void {
    this.proc.kill();
  }
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const out = await fn();
  console.log(`  ... ${label} took ${((Date.now() - start) / 1000).toFixed(1)}s`);
  return out;
}

const session = new Session({ SEARCHLOCK_REF_URL_THRESHOLD: "60" });
try {
  await timed("initialize", () =>
    session.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e", version: "1" },
    }),
  );
  session.notify("notifications/initialized");

  const listed = await timed("tools/list", () => session.call("tools/list"));
  const names = (
    (listed["result"] as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
  ).sort();
  check("tools/list exposes four tools", JSON.stringify(names) === JSON.stringify(["expand_link", "fetch_content", "search", "suggest"]), names.join(","));

  const both = await timed("search both/web", () =>
    session.call("tools/call", {
      name: "search",
      arguments: { query: "python asyncio tutorial", max_results: 5, provider: "both" },
    }),
  );
  const bothText = session.textOf(both);
  check("merged search has ddg section", bothText.includes("DuckDuckGo results:"));
  check("merged search has brave section", bothText.includes("Brave results ("));
  const firstUrl = /^\s*URL: (https?:\/\/\S+)/m.exec(bothText)?.[1] ?? "";
  check("merged search yields a fetchable url", firstUrl.startsWith("http"), firstUrl.slice(0, 60));
  const candidateUrls = [...bothText.matchAll(/^\s*URL: (https?:\/\/\S+)/gm)]
    .map((m) => m[1]!)
    .filter((u, i, all) => all.indexOf(u) === i)
    .slice(0, 3);

  for (const vertical of ["news", "images", "videos"]) {
    const res = await timed(`search vertical ${vertical}`, () =>
      session.call("tools/call", {
        name: "search",
        arguments: { query: "python", max_results: 3, provider: "brave", vertical },
      }),
    );
    const text = session.textOf(res);
    check(`${vertical} vertical returns urls`, (text.match(/^\s*URL: /gm) ?? []).length >= 1);
  }

  const onlyBrave = await timed("search brave-only", () =>
    session.call("tools/call", {
      name: "search",
      arguments: { query: "python asyncio tutorial", max_results: 2, provider: "brave" },
    }),
  );
  check("brave-only search answers", session.textOf(onlyBrave).includes("Brave results ("));

  const bad = await timed("search bad provider", () =>
    session.call("tools/call", { name: "search", arguments: { query: "x", provider: "nope" } }),
  );
  check("bad provider is a clean error", session.textOf(bad).startsWith("Error: Unknown provider"));

  const sug = await timed("suggest", () =>
    session.call("tools/call", { name: "suggest", arguments: { query: "python asy" } }),
  );
  const sugLines = session.textOf(sug).split("\n").filter((l) => l.startsWith("- "));
  check("suggest returns items", sugLines.length >= 1, `${sugLines.length} items`);

  // Some result pages sit behind bot protection. The fetcher must read an
  // ordinary page end to end and fail walled ones with a clean Error.
  let readableUrl = "";
  let walledExample = "";
  for (const candidate of candidateUrls) {
    const probe = await timed(`probe ${candidate.slice(0, 50)}`, () =>
      session.call("tools/call", {
        name: "fetch_content",
        arguments: { url: candidate, max_length: 4000 },
      }),
    );
    const probeText = session.textOf(probe);
    if (!probeText.startsWith("Error") && probeText.length > 500) {
      readableUrl = candidate;
      break;
    }
    if (!walledExample && probeText.startsWith("Error")) walledExample = probeText.slice(0, 60);
  }
  check("fetch reads a result page end to end", readableUrl !== "", readableUrl.slice(0, 60));
  if (walledExample) {
    check("walled pages fail with a clean error", true, walledExample);
  }

  if (readableUrl) {
    const md = await timed("fetch markdown + pagination", () =>
      session.call("tools/call", {
        name: "fetch_content",
        arguments: { url: readableUrl, max_length: 2000, start_index: 2000, parse_mode: "markdown" },
      }),
    );
    const mdText = session.textOf(md);
    check("markdown page two reads onward", mdText.includes("Showing characters 2000-"), mdText.slice(-120));

    const cached = await timed("fetch cache hit", () =>
      session.call("tools/call", {
        name: "fetch_content",
        arguments: { url: readableUrl, max_length: 500 },
      }),
    );
    check("repeat fetch hits cache", session.textOf(cached).includes("cache=hit"));
  }

  const tokenMatch = /ref:\/\/[0-9a-f]+/.exec(bothText);
  check("long urls become ref tokens", tokenMatch !== null, tokenMatch?.[0] ?? "none found");
  if (tokenMatch) {
    const expanded = await timed("expand_link", () =>
      session.call("tools/call", { name: "expand_link", arguments: { token: tokenMatch[0] } }),
    );
    const expandedText = session.textOf(expanded);
    check("ref token expands to real url", expandedText.startsWith("http"), expandedText.slice(0, 60));
    const fetched = await timed("fetch via ref token", () =>
      session.call("tools/call", {
        name: "fetch_content",
        arguments: { url: tokenMatch[0], max_length: 500 },
      }),
    );
    check("fetch accepts ref token", !session.textOf(fetched).startsWith("Error"));
  }

  const blocked = await timed("fetch refuses private url", () =>
    session.call("tools/call", { name: "fetch_content", arguments: { url: "http://169.254.169.254/" } }),
  );
  check("ssrf guard refuses metadata ip", session.textOf(blocked).startsWith("Error: Refusing to fetch"));
} finally {
  session.kill();
}

console.log(`\n${checked - failures.length}/${checked} passed`);
if (failures.length) {
  console.log(`Failures: ${failures.join(", ")}`);
  process.exit(1);
}
