// Feature: docs/reference/specs/live-view.md item 25 — one paint per word of the
// bar, shared by the segments, the legend and the phase heads.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PHASE_TERM, phasePaint, TERM_PAINT } from "./termPaint";

// The stylesheet as text, by this file's own directory — the same file whether
// vitest runs from the workspace or from the repository root (the browser
// environment gives `import.meta.url` an http scheme, so not through a URL).
const css = readFileSync(resolve(__dirname, "../assets/main.css"), "utf8");

const TERMS = [
  "getting ready",
  "thinking",
  "in tools",
  "finishing up",
  "Switchboard overhead",
  "not recorded",
  "not loaded",
] as const;

describe("TERM_PAINT", () => {
  it("every word of the bar has its own class — no two terms share a paint", () => {
    const classes = TERMS.map((t) => TERM_PAINT[t]);
    expect(classes.every((c) => /^paint-[a-z]+$/.test(c))).toBe(true);
    expect(new Set(classes).size).toBe(TERMS.length);
  });

  it("each class is defined once in the global stylesheet, and the four counted buckets paint with four different tokens", () => {
    const tokenOf = (cls: string): string => {
      const m = css.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`));
      expect(m, `${cls} is styled`).not.toBeNull();
      return m![1].replace(/\s+/g, " ").trim();
    };
    const counted = (["getting ready", "thinking", "in tools", "finishing up"] as const).map((t) =>
      tokenOf(TERM_PAINT[t]),
    );
    expect(new Set(counted).size).toBe(4); // thinking and in tools once shared the product green
    for (const rule of counted) expect(rule).toMatch(/^background: var\(--[a-z-]+\);$/); // one solid token each
    expect(tokenOf(TERM_PAINT["Switchboard overhead"])).toContain("repeating-linear-gradient"); // hatched: not work
  });

  it("a phase head wears the paint of the bar's word for it", () => {
    expect(PHASE_TERM).toEqual({ getting_ready: "getting ready", finishing_up: "finishing up" });
    expect(phasePaint("getting_ready")).toBe(TERM_PAINT["getting ready"]);
    expect(phasePaint("finishing_up")).toBe(TERM_PAINT["finishing up"]);
  });
});
