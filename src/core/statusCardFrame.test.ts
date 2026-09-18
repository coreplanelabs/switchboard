// Feature: docs/reference/specs/run-visibility.md item 2 — the status card's one frame builder.
import { describe, expect, it } from "vitest";
import type { Verbosity } from "./verbosity.js";
import { createCardShell, LIVE_CARD_PREFIXES, SPINNER_GLYPHS, type CardClose } from "./statusCardFrame.js";

const LABEL = "*review* on `anthropic/claude-fable-5`";

function shellAt(elapsedMs: number, verbosity?: Verbosity) {
  let now = 1_000_000;
  const shell = createCardShell({
    label: LABEL,
    startedAt: 1_000_000,
    now: () => now,
    ...(verbosity !== undefined ? { verbosity } : {}),
  });
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

  it("a live frame carries the typed activity beside the detail; a frame without one has no activity key; a close never carries it", () => {
    const shell = shellAt(1_000);
    const activity = { kind: "command" as const, tool: "bash", command: "git diff --stat" };
    expect(shell.live({ detail: ["✱ reading"], activity })).toEqual({
      title: `◐ ${LABEL} · 1s`,
      detail: "✱ reading",
      activity,
      link: undefined,
    });
    expect("activity" in shell.live({ detail: ["✱ reading"] })).toBe(false);
    expect("activity" in shell.close({ kind: "done", icon: "✅", detail: "✓ read" })).toBe(false);
  });

  it("lead lines (a routed conductor's parts) open the ack's and every live frame's detail, ahead of the run's own lines; a close carries none", () => {
    let now = 1_000_000;
    const shell = createCardShell({
      label: LABEL,
      startedAt: now,
      now: () => now,
      lead: ["review: look at PR 7", "research: why the resident went down"],
    });
    expect(shell.ack()).toEqual({
      title: `👀 ${LABEL} · preparing workspace…`,
      detail: "review: look at PR 7\nresearch: why the resident went down",
    });
    now += 5_000;
    expect(shell.live().detail).toBe("review: look at PR 7\nresearch: why the resident went down");
    expect(shell.live({ detail: ["○ review child", undefined, "$ spawn_run"] }).detail).toBe(
      "review: look at PR 7\nresearch: why the resident went down\n○ review child\n$ spawn_run",
    );
    expect(shell.close({ kind: "done", icon: "✅", detail: "✓ review child" })).toEqual({
      title: `✅ ${LABEL} · 5s`,
      detail: "✓ review child",
      link: undefined,
    });
    // No lead: the ack is title-only, exactly as before.
    expect(shellAt(0).ack()).toEqual({ title: `👀 ${LABEL} · preparing workspace…` });
  });

  it("notes paint at the request's verbosity (routing-and-config item 28): a quiet card paints quiet notes alone, verbose adds the verbose ones, debug all — in the order they were added, on every later frame, never on the notes it hides", () => {
    const at = (verbosity: Verbosity) => {
      const shell = shellAt(5_000, verbosity);
      shell.note("debug", "route reason: PR review requested by link");
      shell.note("verbose", "resident · acme/api · main@abc1234");
      shell.note("quiet", "1 file left behind");
      shell.note("verbose", "budget 45 min (channel boundary; preset asks 90)");
      return shell;
    };
    expect(at("quiet").label).toBe(`${LABEL} · 1 file left behind`);
    expect(at("verbose").label).toBe(
      `${LABEL} · resident · acme/api · main@abc1234 · 1 file left behind · budget 45 min (channel boundary; preset asks 90)`,
    );
    expect(at("debug").label).toBe(
      `${LABEL} · route reason: PR review requested by link · resident · acme/api · main@abc1234 · 1 file left behind · budget 45 min (channel boundary; preset asks 90)`,
    );
    // Every paint reads the same label: the ack, a live frame, every close kind.
    const quiet = at("quiet");
    expect(quiet.ack().title).toBe(`👀 ${LABEL} · 1 file left behind · preparing workspace…`);
    expect(quiet.live().title).toBe(`◐ ${LABEL} · 1 file left behind · 5s`);
    expect(quiet.close({ kind: "done", icon: "✅" }).title).toBe(`✅ ${LABEL} · 1 file left behind · 5s`);
    expect(quiet.close({ kind: "not_started", icon: "📦", reason: "repo access" }).title).toBe(
      `📦 ${LABEL} · 1 file left behind · not started (repo access) · 5s`,
    );
    expect(quiet.close({ kind: "refused", icon: "🚫", reason: "no plan" }).title).toBe(
      `🚫 ${LABEL} · 1 file left behind · no plan · 5s`,
    );
    // No verbosity given: quiet — the card of a caller with no resolved request.
    const bare = shellAt(5_000);
    bare.note("debug", "untracked by the ledger");
    expect(bare.label).toBe(LABEL);
  });

  it("no close carries an override footer: a routed card's close is its own lines and nothing after them", () => {
    const shell = shellAt(5_000, "debug");
    shell.note("debug", "route reason: a review by link");
    expect(shell.close({ kind: "done", icon: "✅", detail: "✓ reading the diff" })).toEqual({
      title: `✅ ${LABEL} · route reason: a review by link · 5s`,
      detail: "✓ reading the diff",
      link: undefined,
    });
    expect(shell.close({ kind: "done", icon: "❌" }).detail).toBeUndefined();
    expect(shell.close({ kind: "setup_failed", reason: "attach timed out" }).detail).toBeUndefined();
  });

  it("the elapsed time floors in clock style like every other duration surface (docs/reference/specs/tracing.md), never a second ahead of the run page", () => {
    expect(shellAt(1_499).live().title).toBe(`◐ ${LABEL} · 1s`);
    expect(shellAt(1_999).live().title).toBe(`◐ ${LABEL} · 1s`);
    expect(shellAt(50_850).live().title).toBe(`◐ ${LABEL} · 50s`);
    expect(shellAt(184_000).live().title).toBe(`◐ ${LABEL} · 3m 04s`);
  });

  it("a note appended to the label reaches every later frame; the glyph sequence is unaffected", () => {
    const shell = shellAt(3_000);
    shell.note("quiet", "resumed");
    expect(shell.label).toBe(`${LABEL} · resumed`);
    expect(shell.live().title).toBe(`◐ ${LABEL} · resumed · 3s`);
    expect(shell.close({ kind: "done", icon: "✅" }).title).toBe(`✅ ${LABEL} · resumed · 3s`);
  });

  // The eight closes, pinned as a table: what each paints today — every close
  // carries the request's elapsed time from the ack's clock (docs/reference/specs/tracing.md).
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

  it("a close's shape and queued lines lead its detail, in that order, on runless closes and done closes alike — at verbose and above; a quiet close drops both (item 28)", () => {
    const quiet = shellAt(184_000);
    expect(
      quiet.close({
        kind: "setup_failed",
        reason: "resident attach timed out",
        shape: "3m 00s getting ready · 4s Switchboard overhead",
        queued: "queued 6m 00s before we saw it",
      }),
    ).toEqual({ title: "❌ setup failed · resident attach timed out · 3m 04s", detail: undefined });
    expect(
      quiet.close({ kind: "done", icon: "✅", detail: "✓ done", shape: "2m 30s thinking · 34s in tools" }).detail,
    ).toBe("✓ done");
    const shell = shellAt(184_000, "verbose");
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
