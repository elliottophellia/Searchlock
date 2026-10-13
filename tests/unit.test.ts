import { describe, expect, test } from "bun:test";
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
