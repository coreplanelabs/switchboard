import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Feature: docs/reference/specs/web-chat.md rule 10 — every transition the chat
// page adds is opacity plus at most 8px of translate, between 120 and 200 ms,
// ease-out, and under prefers-reduced-motion keeps its opacity and drops its
// travel. Three named exceptions run under a second and are off under reduced
// motion: the mark's route draw, the mark's pulse, the composer's ring sweep;
// the mark's idle float moves it 1px over 4.6 s. The rule is checked against
// the stylesheet itself, so a new `sb-` move that breaks it fails here before
// anyone sees it.

const css = readFileSync(resolve(__dirname, "../assets/main.css"), "utf8");

/** The vocabulary block: from its comment to the ring sweep's. */
const vocab = css.slice(css.indexOf("The home page's motion"), css.indexOf("The composer's ring sweep"));
const vocabReduced = vocab.slice(vocab.indexOf("@media (prefers-reduced-motion: reduce)"));
const vocabNormal = vocab.slice(0, vocab.indexOf("@media (prefers-reduced-motion: reduce)"));
/** The exceptions: the ring sweep and the mark's life, each with its own reduced-motion block. */
const ring = css.slice(css.indexOf("The composer's ring sweep"), css.indexOf("The mark's life"));
const mark = css.slice(css.indexOf("The mark's life"));

describe("the chat page's motion vocabulary", () => {
  it("exists, with the four moves and the mark's draw", () => {
    for (const cls of [
      ".sb-rise-enter-active",
      ".sb-fade-enter-active",
      ".sb-move-move",
      ".sb-stagger",
      ".mark-draw",
    ]) {
      expect(vocab).toContain(cls);
    }
  });

  it("every transition and animation runs 120–200 ms on ease-out, except the mark's one 600 ms draw", () => {
    const durations = [...vocabNormal.matchAll(/\b(\d+)ms\b/g)].map((m) => Number(m[1]));
    expect(durations.length).toBeGreaterThan(0);
    for (const ms of durations) {
      expect(ms === 600 || ms === 560 || (ms >= 120 && ms <= 200) || ms === 40).toBe(true);
    }
    for (const m of vocabNormal.matchAll(/(transition|animation):[^;]*;/g)) {
      expect(m[0]).toMatch(/ease-out/);
    }
  });

  it("travels at most 8px, and only along Y", () => {
    const travels = [...vocabNormal.matchAll(/translate[XY]?\((-?\d+)px\)/g)];
    expect(travels.length).toBeGreaterThan(0);
    for (const t of travels) {
      expect(t[0].startsWith("translateY(")).toBe(true);
      expect(Math.abs(Number(t[1]))).toBeLessThanOrEqual(8);
    }
    expect(vocabNormal).not.toMatch(/scale\(|rotate\(/);
  });

  it("under prefers-reduced-motion every move keeps its opacity and drops its travel", () => {
    expect(vocabReduced).toContain(".sb-rise-enter-active");
    expect(vocabReduced).toContain("transform: none");
    expect(vocabReduced).toContain(".sb-move-move");
    expect(vocabReduced).toContain(".mark-draw .route");
    expect(vocabReduced).not.toMatch(/translateY\(\d+px\)/);
    // The stagger keeps a fade, never a lift.
    expect(vocabReduced).toMatch(/\.sb-stagger\s*\{[^}]*animation-name: sb-fade-in/);
  });

  it("the exceptions run under a second, move nothing but the mark, and are off under reduced motion", () => {
    for (const [block, name] of [
      [ring, ".ring-sweep::before"],
      [mark, ".mark-pulse .pulse"],
    ] as const) {
      expect(block).toContain(name);
      const durations = [...block.matchAll(/\b(\d+)ms\b/g)].map((m) => Number(m[1]));
      expect(durations.length).toBeGreaterThan(0);
      for (const ms of durations) expect(ms).toBeLessThanOrEqual(1000);
      const reduced = block.slice(block.indexOf("@media (prefers-reduced-motion: reduce)"));
      expect(reduced).toContain(name);
      expect(reduced).toContain("animation: none");
    }
    // The ring sweep rotates a gradient: nothing on the page moves.
    expect(ring).not.toMatch(/translate[XY]?\(/);
    // The idle float: 1px of travel, slowly, and off under reduced motion.
    expect(mark).toMatch(/\.mark-idle\s*\{[^}]*4\.6s/);
    expect(mark).toMatch(/translateY\(-1px\)/);
    expect(mark.slice(mark.indexOf("@media (prefers-reduced-motion: reduce)"))).toContain(".mark-idle");
  });
});

describe("the chat page's touch sizes", () => {
  it("where the pointer is a finger, every control is at least 44px tall and nothing lifts on hover", () => {
    const touch = css.slice(css.indexOf("@media (pointer: coarse)"));
    expect(touch.length).toBeGreaterThan(0);
    for (const sel of [".chip", ".rail .row", ".rail .new", ".rail .filter", ".palette .item", ".composer .control"]) {
      expect(touch).toContain(sel);
    }
    expect(touch).toMatch(/min-height: 2\.75rem/);
    expect(touch).toMatch(/\.chip:hover,\s*\.rail \.new:hover\s*\{\s*transform: none;/);
  });
});
