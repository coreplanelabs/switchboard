import { describe, expect, it } from "vitest";
import { closeMarker, declaredRegions, openMarker, replaceRegion } from "./regions.js";

const page = ["# Reference", "", "prose above", "", openMarker("things"), "", "| old |", "", closeMarker("things"), "", "prose below", ""].join("\n");

describe("replaceRegion", () => {
  it("replaces only the region body and leaves every byte outside the markers alone", () => {
    const out = replaceRegion(page, "things", "| new |");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.changed).toBe(true);
    expect(out.text).toContain("| new |");
    expect(out.text).not.toContain("| old |");
    expect(out.text.startsWith("# Reference\n\nprose above\n")).toBe(true);
    expect(out.text.endsWith("\n\nprose below\n")).toBe(true);
  });

  it("is idempotent — regenerating identical content reports no change", () => {
    const first = replaceRegion(page, "things", "| new |");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = replaceRegion(first.text, "things", "| new |");
    expect(second.ok && second.changed).toBe(false);
  });

  it("still finds a region whose opening marker carries an older note, and rewrites the note", () => {
    const stale = page.replace(openMarker("things"), "<!-- generated:things · some older note -->");
    const out = replaceRegion(stale, "things", "| new |");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toContain(openMarker("things"));
    expect(out.text).not.toContain("some older note");
  });

  it("refuses when the region is missing, rather than appending or silently doing nothing", () => {
    const out = replaceRegion(page, "absent", "x");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.problem).toContain("no opening marker for region 'absent'");
  });

  it("refuses an unclosed region", () => {
    const out = replaceRegion(page.replace(closeMarker("things"), ""), "things", "x");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.problem).toContain("never closed");
  });

  it("does not treat the closing marker as an opening one", () => {
    const closeOnly = [closeMarker("things"), "", "body"].join("\n");
    expect(replaceRegion(closeOnly, "things", "x").ok).toBe(false);
  });
});

describe("declaredRegions", () => {
  it("lists every generated region a page declares, in order", () => {
    const two = `${page}\n${openMarker("more")}\n\nx\n\n${closeMarker("more")}\n`;
    expect(declaredRegions(two)).toEqual(["things", "more"]);
  });

  it("ignores ordinary HTML comments and closing markers", () => {
    expect(declaredRegions(["<!-- a note -->", closeMarker("things")].join("\n"))).toEqual([]);
  });
});
