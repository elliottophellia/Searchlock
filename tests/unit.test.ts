import { describe, expect, test } from "bun:test";
import { parseSuggest } from "../src/brave.ts";
import { htmlToText, parseResultPage, assertPublicUrl } from "../src/ddg.ts";
import { RefLinks, SlidingWindow, TokenBucket, TtlCache, isRefToken } from "../src/limits.ts";
import { canonicalUrl, collapseSpace, stripTags } from "../src/support.ts";

const DDG_HTML = `
<html><body>
<div class="result">
  <h2 class="result__title"><a href="https://example.com/a">Example A</a></h2>
  <p class="result__snippet">Snippet A here.</p>
</div>
<div class="result">
  <h2 class="result__title"><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb&amp;rut=x">Example B</a></h2>
  <p class="result__snippet">Snippet B here.</p>
</div>
<div class="result">
  <h2 class="result__title"><a href="https://example.com/y.js?v=1">Ad result</a></h2>
  <p class="result__snippet">Filtered.</p>
</div>
</body></html>`;

describe("support", () => {
  test("canonicalUrl lowercases host and drops fragments", () => {
    expect(canonicalUrl("HTTP://Example.COM:80/a?x=1#frag")).toBe("http://example.com/a?x=1");
  });
  test("stripTags decodes entities", () => {
    expect(stripTags('<p>a &amp; b&nbsp;c</p>')).toBe("a & b c");
  });
  test("collapseSpace squeezes whitespace", () => {
    expect(collapseSpace("  a\n  b   c ")).toBe("a b c");
  });
});

describe("RefLinks", () => {
  test("round trips urls and bare ids", () => {
    const refs = new RefLinks();
    const token = refs.shorten("https://example.com/some/page");
    expect(token.startsWith("ref://")).toBe(true);
    expect(refs.resolve(token)).toBe("https://example.com/some/page");
    expect(refs.resolve(token.replace("ref://", ""))).toBe("https://example.com/some/page");
  });
  test("unknown tokens resolve undefined", () => {
    expect(new RefLinks().resolve("ref://deadbeef")).toBeUndefined();
  });
  test("evicts oldest entries", () => {
    const refs = new RefLinks(2);
    refs.shorten("https://example.com/1");
    refs.shorten("https://example.com/2");
    refs.shorten("https://example.com/3");
    expect(refs.size).toBe(2);
  });
  test("isRefToken", () => {
    expect(isRefToken("ref://abc")).toBe(true);
    expect(isRefToken("https://example.com")).toBe(false);
  });
});

describe("limiters", () => {
  test("sliding window drops expired stamps", async () => {
    const limiter = new SlidingWindow(1);
    await limiter.take();
    expect(limiter.idle).toBe(false);
  });
  test("token bucket spends burst", async () => {
    const bucket = new TokenBucket(60);
    await bucket.take();
    expect(bucket.idle).toBe(false);
  });
});

describe("brave parsing", () => {
  test("parseSuggest handles tuple and object forms", () => {
    expect(parseSuggest(JSON.stringify(["q", ["one", "two"]]))).toEqual(["one", "two"]);
    expect(
      parseSuggest(JSON.stringify({ suggestions: [{ q: "three" }, { text: "four" }] })),
    ).toEqual(["three", "four"]);
    expect(parseSuggest(JSON.stringify({ unexpected: 1 }))).toEqual([]);
    expect(parseSuggest("not json")).toEqual([]);
  });
});

describe("ddg parsing", () => {
  test("parseResultPage extracts, unwraps, and filters ads", () => {
    const hits = parseResultPage(DDG_HTML, 10);
    expect(hits.map((h) => h.title)).toEqual(["Example A", "Example B"]);
    expect(hits[1]!.link).toBe("https://example.com/b");
    expect(hits.every((h) => !h.link.includes("y.js"))).toBe(true);
  });
  test("htmlToText modes", () => {
    const html =
      "<html><body><nav>menu</nav><article><h1>Head</h1><p>Body text.</p></article></body></html>";
    expect(htmlToText(html, "text")).toContain("Body text.");
    expect(htmlToText(html, "main")).not.toContain("menu");
    expect(htmlToText(html, "markdown")).toContain("# Head");
  });
  test("assertPublicUrl refuses local targets", async () => {
    await expect(assertPublicUrl("http://127.0.0.1/")).rejects.toThrow();
    await expect(assertPublicUrl("http://localhost/")).rejects.toThrow();
    await expect(assertPublicUrl("ftp://example.com/")).rejects.toThrow();
  });
});

describe("TtlCache", () => {
  test("round trip and expiry", async () => {
    const cache = new TtlCache<string>(20, 4);
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
    await new Promise((r) => setTimeout(r, 30));
    expect(cache.get("k")).toBeUndefined();
  });
  test("disabled when zero", () => {
    expect(new TtlCache<string>(0, 64).enabled).toBe(false);
    expect(new TtlCache<string>(300, 0).enabled).toBe(false);
  });
});
