import { describe, expect, test } from "bun:test";
import { RefLinks, SlidingWindow, TokenBucket, TtlCache, isRefToken } from "../src/limits.ts";
import { canonicalUrl, collapseSpace, stripTags } from "../src/support.ts";

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
