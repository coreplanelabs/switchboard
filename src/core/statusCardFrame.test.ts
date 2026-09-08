// Feature: features/run-visibility.md item 2 — the status card's one frame builder.
import { describe, expect, it } from "vitest";
import { createCardShell, LIVE_CARD_PREFIXES, SPINNER_GLYPHS, type CardClose } from "./statusCardFrame.js";

const LABEL = "*review* on `anthropic/claude-fable-5`";

function shellAt(elapsedMs: number) {
  let now = 1_000_000;
  const shell = createCardShell({ label: LABEL, startedAt: 1_000_000, now: () => now });
  now += elapsedMs;
  return shell;
}

describe("createCardShell — every paint comes from one builder", () => {
  it("the ack is the 👀 frame with no duration", () => {
    expect(shellAt(0).ack()).toEqual({ title: `👀 ${LABEL} · preparing workspace…` });
  });

  it("a live frame rotates the spinner glyph per call and carries the elapsed seconds, the suffix, the notice, the joined detail and the link", () => {
    const shell = shellAt(42_400);
    expect(shell.live()).toEqual({ title: `◐ ${LABEL} · 42s`, detail: undefined, link: undefined });
    shell.setLink({ url: "https://sb.example/runs/r1?t=tok", label: "Live run" });
    expect(
      shell.live({
        suffix: " — running bash (25s)",
        notice: "restarting for a deploy",
        detail: [undefined, "✱ reading the diff", "", "$ git diff --stat"],
      }),
    ).toEqual({
      title: `◓ ${LABEL} · 42s — running bash (25s) · restarting for a deploy`,
      detail: "✱ reading the diff\n$ git diff --stat",
      link: { url: "https://sb.example/runs/r1?t=tok", label: "Live run" },
    });
    expect(shell.live().title.startsWith("◑ ")).toBe(true);
    expect(shell.live().title.startsWith("◒ ")).toBe(true);
    expect(shell.live().title.startsWith("◐ ")).toBe(true); // wraps
  });

  it("the elapsed seconds round half up, like the card always has", () => {
    expect(shellAt(1_499).live().title).toBe(`◐ ${LABEL} · 1s`);
    expect(shellAt(1_500).live().title).toBe(`◐ ${LABEL} · 2s`);
  });

  it("a note appended to the label reaches every later frame; the glyph sequence is unaffected", () => {
    const shell = shellAt(3_000);
    shell.setLabel(`${shell.label} · resumed`);
    expect(shell.label).toBe(`${LABEL} · resumed`);
    expect(shell.live().title).toBe(`◐ ${LABEL} · resumed · 3s`);
    expect(shell.close({ kind: "done", icon: "✅" }).title).toBe(`✅ ${LABEL} · resumed · 3s`);
  });

  // The eight closes, pinned as a table: what each paints today. 2d-ii and 5a
  // each move this table once, as the duration's anchor and the shape land.
  const link = { url: "https://sb.example/runs/r1?t=tok", label: "Live run" };
  const CLOSES: Array<[CardClose, { title: string; detail?: string; link?: typeof link }]> = [
    [
      { kind: "not_started", icon: "📦", reason: "repo not onboarded" },
      { title: `📦 ${LABEL} · not started (repo not onboarded)` },
    ],
    [
      { kind: "not_started", icon: "📦", reason: "repo could not be verified" },
      { title: `📦 ${LABEL} · not started (repo could not be verified)` },
    ],
    [{ kind: "not_started", icon: "🚫", reason: "repo access" }, { title: `🚫 ${LABEL} · not started (repo access)` }],
    [
      { kind: "not_started", icon: "🔀", reason: "PR head unknown" },
      { title: `🔀 ${LABEL} · not started (PR head unknown)` },
    ],
    [
      { kind: "not_started", icon: "🌿", reason: "which branch?" },
      { title: `🌿 ${LABEL} · not started (which branch?)` },
    ],
    [
      { kind: "not_started", icon: "🔀", reason: "branch moved" },
      { title: `🔀 ${LABEL} · not started (branch moved)` },
    ],
    [
      { kind: "refused", icon: "🚫", reason: "not started (no ship target)" },
      { title: `🚫 ${LABEL} · not started (no ship target)` },
    ],
    [
      { kind: "setup_failed", reason: "resident attach timed out" },
      { title: "❌ setup failed · resident attach timed out" },
    ],
  ];

  it.each(CLOSES)("a close before the run started paints %j with no duration and no link", (close, expected) => {
    const shell = shellAt(184_000);
    shell.setLink(link);
    expect(shell.close(close)).toEqual(expected);
  });

  it("a done close carries the icon, the duration, the detail and the link — any outcome", () => {
    const shell = shellAt(252_000);
    shell.setLink(link);
    for (const icon of ["✅", "❌", "⏹", "⛔", "⚠️"]) {
      expect(shell.close({ kind: "done", icon, detail: "✓ done" })).toEqual({
        title: `${icon} ${LABEL} · 252s`,
        detail: "✓ done",
        link,
      });
    }
    expect(shell.close({ kind: "done", icon: "❌" })).toEqual({ title: `❌ ${LABEL} · 252s`, detail: undefined, link });
  });

  it("freeze(finishedAt) ends every later frame's elapsed at the run's finish stamp, so a done close painted late still reads the run's duration", () => {
    let now = 1_000_000;
    const shell = createCardShell({ label: LABEL, startedAt: 1_000_000, now: () => now });
    now += 252_000; // the agent stopped here
    shell.freeze(now);
    now += 9_000; // the card close lands 9 s later (the reply took its time)
    expect(shell.close({ kind: "done", icon: "✅" }).title).toBe(`✅ ${LABEL} · 252s`);
    expect(shell.live().title).toBe(`◐ ${LABEL} · 252s`);
  });

  it("the live prefixes are the spinner glyphs plus the 👀 ack — derived, so they cannot drift", () => {
    expect(LIVE_CARD_PREFIXES).toEqual([...SPINNER_GLYPHS, "👀"]);
    const shell = shellAt(0);
    expect(LIVE_CARD_PREFIXES.some((p) => shell.ack().title.startsWith(p))).toBe(true);
    for (let i = 0; i < SPINNER_GLYPHS.length; i++) {
      const { title } = shell.live();
      expect(LIVE_CARD_PREFIXES.some((p) => title.startsWith(p))).toBe(true);
    }
    expect(LIVE_CARD_PREFIXES.some((p) => shell.close({ kind: "done", icon: "✅" }).title.startsWith(p))).toBe(false);
  });
});
