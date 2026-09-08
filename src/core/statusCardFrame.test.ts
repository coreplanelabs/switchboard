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

  it("the elapsed time floors in clock style like every other duration surface (features/tracing.md), never a second ahead of the run page", () => {
    expect(shellAt(1_499).live().title).toBe(`◐ ${LABEL} · 1s`);
    expect(shellAt(1_999).live().title).toBe(`◐ ${LABEL} · 1s`);
    expect(shellAt(50_850).live().title).toBe(`◐ ${LABEL} · 50s`);
    expect(shellAt(184_000).live().title).toBe(`◐ ${LABEL} · 3m 04s`);
  });

  it("a note appended to the label reaches every later frame; the glyph sequence is unaffected", () => {
    const shell = shellAt(3_000);
    shell.setLabel(`${shell.label} · resumed`);
    expect(shell.label).toBe(`${LABEL} · resumed`);
    expect(shell.live().title).toBe(`◐ ${LABEL} · resumed · 3s`);
    expect(shell.close({ kind: "done", icon: "✅" }).title).toBe(`✅ ${LABEL} · resumed · 3s`);
  });

  // The eight closes, pinned as a table: what each paints today — every close
  // carries the request's elapsed time from the ack's clock (features/tracing.md).
  const link = { url: "https://sb.example/runs/r1?t=tok", label: "Live run" };
  const CLOSES: Array<[CardClose, { title: string; detail?: string; link?: typeof link }]> = [
    [
      { kind: "not_started", icon: "📦", reason: "repo not onboarded" },
      { title: `📦 ${LABEL} · not started (repo not onboarded) · 3m 04s`, detail: undefined },
    ],
    [
      { kind: "not_started", icon: "📦", reason: "repo could not be verified" },
      { title: `📦 ${LABEL} · not started (repo could not be verified) · 3m 04s`, detail: undefined },
    ],
    [
      { kind: "not_started", icon: "🚫", reason: "repo access" },
      { title: `🚫 ${LABEL} · not started (repo access) · 3m 04s`, detail: undefined },
    ],
    [
      { kind: "not_started", icon: "🔀", reason: "PR head unknown" },
      { title: `🔀 ${LABEL} · not started (PR head unknown) · 3m 04s`, detail: undefined },
    ],
    [
      { kind: "not_started", icon: "🌿", reason: "which branch?" },
      { title: `🌿 ${LABEL} · not started (which branch?) · 3m 04s`, detail: undefined },
    ],
    [
      { kind: "not_started", icon: "🔀", reason: "branch moved" },
      { title: `🔀 ${LABEL} · not started (branch moved) · 3m 04s`, detail: undefined },
    ],
    [
      { kind: "refused", icon: "🚫", reason: "not started (no ship target)" },
      { title: `🚫 ${LABEL} · not started (no ship target) · 3m 04s`, detail: undefined },
    ],
    [
      { kind: "setup_failed", reason: "resident attach timed out" },
      { title: "❌ setup failed · resident attach timed out · 3m 04s", detail: undefined },
    ],
  ];

  it.each(CLOSES)("a close before the run started paints %j with the elapsed time and no link", (close, expected) => {
    const shell = shellAt(184_000);
    shell.setLink(link);
    expect(shell.close(close)).toEqual(expected);
  });

  it("a setup label rides live frames after the elapsed time until it is cleared", () => {
    const shell = shellAt(12_000);
    shell.setSetupLabel("attaching the workspace…");
    expect(shell.live().title).toBe(`◐ ${LABEL} · 12s — attaching the workspace…`);
    expect(shell.live({ suffix: " (slow)" }).title).toBe(`◓ ${LABEL} · 12s — attaching the workspace… (slow)`);
    shell.setSetupLabel(undefined);
    expect(shell.live().title).toBe(`◑ ${LABEL} · 12s`);
  });

  it("a close's shape and queued lines lead its detail, in that order, on runless closes and done closes alike", () => {
    const shell = shellAt(184_000);
    expect(
      shell.close({
        kind: "setup_failed",
        reason: "resident attach timed out",
        shape: "3m 00s getting ready · 4s Switchboard overhead",
        queued: "queued 6m 00s before we saw it",
      }),
    ).toEqual({
      title: "❌ setup failed · resident attach timed out · 3m 04s",
      detail: "3m 00s getting ready · 4s Switchboard overhead\nqueued 6m 00s before we saw it",
    });
    expect(
      shell.close({ kind: "done", icon: "✅", detail: "✓ done", shape: "2m 30s thinking · 34s in tools" }),
    ).toEqual({
      title: `✅ ${LABEL} · 3m 04s`,
      detail: "2m 30s thinking · 34s in tools\n✓ done",
      link: undefined,
    });
    expect(
      shell.close({ kind: "not_started", icon: "📦", reason: "repo access", queued: "queued 1m 00s before we saw it" }),
    ).toEqual({
      title: `📦 ${LABEL} · not started (repo access) · 3m 04s`,
      detail: "queued 1m 00s before we saw it",
    });
  });

  it("a done close carries the icon, the duration, the detail and the link — any outcome", () => {
    const shell = shellAt(252_000);
    shell.setLink(link);
    for (const icon of ["✅", "❌", "⏹", "⛔", "⚠️"]) {
      expect(shell.close({ kind: "done", icon, detail: "✓ done" })).toEqual({
        title: `${icon} ${LABEL} · 4m 12s`,
        detail: "✓ done",
        link,
      });
    }
    expect(shell.close({ kind: "done", icon: "❌" })).toEqual({
      title: `❌ ${LABEL} · 4m 12s`,
      detail: undefined,
      link,
    });
  });

  it("freeze(finishedAt) ends every later frame's elapsed at the run's finish stamp, so a done close painted late still reads the run's duration", () => {
    let now = 1_000_000;
    const shell = createCardShell({ label: LABEL, startedAt: 1_000_000, now: () => now });
    now += 252_000; // the agent stopped here
    shell.freeze(now);
    now += 9_000; // the card close lands 9 s later (the reply took its time)
    expect(shell.close({ kind: "done", icon: "✅" }).title).toBe(`✅ ${LABEL} · 4m 12s`);
    expect(shell.live().title).toBe(`◐ ${LABEL} · 4m 12s`);
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
