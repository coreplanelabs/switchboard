import { describe, expect, it } from "vitest";
import {
  READING_DIFF_CAP,
  capDiff,
  parseMeatJson,
  produceReadingDiff,
  readingDiffCommand,
  resolveReadingDiff,
  startReviewReadingDiff,
} from "./readingDiff.js";
import type { RunEvent } from "./runEvents.js";
import { recordingSink } from "./testing/recordingSink.js";
import { createTracer } from "./trace/tracer.js";

// Feature: docs/reference/specs/reading-diff.md — every PR review run carries a
// `review_artifact` reading diff. The git BASELINE is guaranteed (the
// dispatcher joins it before the answer); meat, when configured, is an
// unawaited UPGRADE artifact under its own runtime budget — it lands iff it
// finishes within the review. No timeout races anywhere in the pipeline.

describe("resolveReadingDiff (config + env)", () => {
  it("defaults to git with meat's default runtime budget when nothing is configured", () => {
    expect(resolveReadingDiff(undefined, {})).toEqual({ provider: "git", meatTimeoutS: 240 });
  });

  it("config selects the provider, the meat model, and meat's budget (floored, positive)", () => {
    expect(resolveReadingDiff({ provider: "meat", meatModel: "claude-opus-4-8", meatTimeoutS: 300.9 }, {})).toEqual({
      provider: "meat",
      meatModel: "claude-opus-4-8",
      meatTimeoutS: 300,
    });
    expect(resolveReadingDiff({ provider: "meat", meatTimeoutS: -5 }, {})).toEqual({
      provider: "meat",
      meatTimeoutS: 240,
    });
    expect(resolveReadingDiff({ provider: "off" }, {})).toBeNull();
  });

  it("SWITCHBOARD_READING_DIFF overrides config: git | meat | off", () => {
    expect(resolveReadingDiff({ provider: "meat" }, { SWITCHBOARD_READING_DIFF: "git" })).toEqual({
      provider: "git",
      meatTimeoutS: 240,
    });
    expect(resolveReadingDiff({ provider: "off" }, { SWITCHBOARD_READING_DIFF: "meat" })).toEqual({
      provider: "meat",
      meatTimeoutS: 240,
    });
    expect(resolveReadingDiff({ provider: "git" }, { SWITCHBOARD_READING_DIFF: "off" })).toBeNull();
    // an unknown env value is ignored, never a crash
    expect(resolveReadingDiff({ provider: "git" }, { SWITCHBOARD_READING_DIFF: "bogus" })).toEqual({
      provider: "git",
      meatTimeoutS: 240,
    });
  });
});

describe("readingDiffCommand", () => {
  it("git: a full diff against origin/<base>, option injection closed", () => {
    expect(readingDiffCommand("git", "main")).toBe("git diff --no-color --end-of-options 'origin/main...HEAD'");
  });

  it("no base ref → origin/HEAD (the repository's default branch)", () => {
    expect(readingDiffCommand("git", undefined)).toBe("git diff --no-color --end-of-options 'origin/HEAD...HEAD'");
  });

  it("meat: bounded by its own `timeout` (the producer's clock — the pipeline never waits on meat), -json, the pinned model, the same quoted range", () => {
    expect(readingDiffCommand("meat", "main", "claude-opus-4-8", 300)).toBe(
      "timeout 300 meat -json -model 'claude-opus-4-8' 'origin/main...HEAD'",
    );
    expect(readingDiffCommand("meat", "main")).toBe("timeout 240 meat -json 'origin/main...HEAD'");
  });

  it("a hostile base ref is quoted into one inert token", () => {
    expect(readingDiffCommand("git", "x; rm -rf /")).toBe(
      "git diff --no-color --end-of-options 'origin/x; rm -rf /...HEAD'",
    );
  });
});

describe("parseMeatJson", () => {
  it("parses the -json wire shape (smart_diff + summary + token counts)", () => {
    const raw = JSON.stringify({
      smart_diff: "diff --git a/x b/x",
      summary: "one line",
      input_tokens: 100,
      output_tokens: 20,
      elision: "",
    });
    expect(parseMeatJson(raw)).toEqual({
      diff: "diff --git a/x b/x",
      summary: "one line",
      inputTokens: 100,
      outputTokens: 20,
    });
  });

  it("throws on an exec error, non-JSON output, or JSON without smart_diff", () => {
    expect(() => parseMeatJson("exit 127: meat: command not found")).toThrow(/not JSON|command not found|Unexpected/i);
    expect(() => parseMeatJson("")).toThrow();
    expect(() => parseMeatJson(JSON.stringify({ summary: "no diff" }))).toThrow(/smart_diff/);
  });
});

describe("capDiff", () => {
  it("passes a small diff through and truncates a huge one at the cap with a note", () => {
    expect(capDiff("small")).toEqual({ diff: "small", truncated: false });
    const big = "x".repeat(READING_DIFF_CAP + 50);
    const capped = capDiff(big);
    expect(capped.truncated).toBe(true);
    expect(capped.diff.length).toBeLessThanOrEqual(READING_DIFF_CAP + 80);
    expect(capped.diff).toMatch(/…\[\d+ more chars\]$/);
  });
});

describe("produceReadingDiff", () => {
  const exec = (impl: (cmd: string) => string | Promise<string>) => ({ exec: async (cmd: string) => impl(cmd) });

  it("git provider: one git command → a git-powered artifact", async () => {
    const a = await produceReadingDiff(
      exec((cmd) => (cmd.startsWith("git diff") ? "diff --git a/f b/f\n+x" : "?")),
      { provider: "git", baseRef: "main" },
    );
    expect(a).toEqual({ poweredBy: "git", baseRef: "main", diff: "diff --git a/f b/f\n+x", truncated: false });
  });

  it("meat provider: meat's smart diff, summary, and token counts ride the artifact", async () => {
    const a = await produceReadingDiff(
      exec((cmd) =>
        cmd.includes("meat")
          ? JSON.stringify({ smart_diff: "abridged", summary: "s", input_tokens: 9, output_tokens: 3 })
          : "raw",
      ),
      { provider: "meat", baseRef: "main", meatModel: "claude-opus-4-8" },
    );
    expect(a).toMatchObject({ poweredBy: "meat", diff: "abridged", summary: "s", meatTokens: { input: 9, output: 3 } });
  });

  it("meat failing (missing binary, timeout's exit 124, bad JSON) yields null — the git BASELINE artifact is the fallback, structurally", async () => {
    expect(
      await produceReadingDiff(
        exec(() => "exit 127: zsh: command not found: meat"),
        { provider: "meat", baseRef: "main" },
      ),
    ).toBeNull();
    expect(
      await produceReadingDiff(
        exec(() => "exit 124: "),
        { provider: "meat", baseRef: "main" },
      ),
    ).toBeNull();
    expect(
      await produceReadingDiff(
        exec(() => "not json at all"),
        { provider: "meat", baseRef: "main" },
      ),
    ).toBeNull();
  });

  it("a git failure yields null (no artifact, never a throw into the run)", async () => {
    const a = await produceReadingDiff(
      exec(() => "fatal: ambiguous argument 'origin/gone...HEAD'"),
      { provider: "git", baseRef: "gone" },
    );
    expect(a).toBeNull();
    const b = await produceReadingDiff(
      exec(() => {
        throw new Error("sandbox dead");
      }),
      { provider: "git", baseRef: "main" },
    );
    expect(b).toBeNull();
  });

  it("an empty diff yields null — nothing to review, no artifact", async () => {
    expect(
      await produceReadingDiff(
        exec(() => ""),
        { provider: "git", baseRef: "main" },
      ),
    ).toBeNull();
  });

  it("caps the diff and marks truncation", async () => {
    const a = await produceReadingDiff(
      exec(() => "diff --git\n" + "y".repeat(READING_DIFF_CAP + 100)),
      { provider: "git", baseRef: "main" },
    );
    expect(a?.truncated).toBe(true);
  });

  // The artifact goes straight into the run stream, which the registry
  // publishes as-is — so this module owns the stream's
  // hygiene: control-strip + redact FIRST, cap after, on every string.
  it("redacts secrets and strips ANSI from the diff before it can reach the stream — git and meat alike, meat's summary included", async () => {
    const secret = "ghp_" + "A".repeat(36);
    const git = await produceReadingDiff(
      exec(() => `diff --git a/.env b/.env\n+[31mGITHUB_TOKEN=${secret}[m`),
      { provider: "git", baseRef: "main" },
    );
    expect(git?.diff).not.toContain(secret);
    expect(git?.diff).toContain("«redacted");
    expect(git?.diff).not.toContain("[31m");

    const meat = await produceReadingDiff(
      exec((cmd) =>
        cmd.includes("meat")
          ? JSON.stringify({
              smart_diff: `+token=${secret}`,
              summary: `adds ${secret} to .env`,
              input_tokens: 1,
              output_tokens: 1,
            })
          : "unused",
      ),
      { provider: "meat", baseRef: "main" },
    );
    expect(meat?.diff).not.toContain(secret);
    expect(meat?.summary).not.toContain(secret);
  });

  it("never splits a surrogate pair at the cap", async () => {
    const emoji = "😀"; // one astral char = two UTF-16 units
    const body = "d".repeat(READING_DIFF_CAP - 1) + emoji + "tail";
    const a = await produceReadingDiff(
      exec(() => body),
      { provider: "git", baseRef: "main" },
    );
    expect(a?.truncated).toBe(true);
    const cut = a!.diff.slice(0, a!.diff.indexOf("…"));
    expect(cut.charCodeAt(cut.length - 1)).toBeLessThan(0xd800); // no lone high surrogate
  });
});

describe("startReviewReadingDiff (baseline guaranteed, meat an unawaited upgrade)", () => {
  const exec = (impl: (cmd: string) => string | Promise<string>) => ({ exec: async (cmd: string) => impl(cmd) });

  it("git provider: the baseline publishes the stamped envelope, resolves true, and there is no upgrade", async () => {
    const published: RunEvent[] = [];
    const started = startReviewReadingDiff({
      executor: exec(() => "diff --git a/f b/f\n+x"),
      cfg: { provider: "git" },
      env: {},
      baseRef: "main",
      publish: (e) => published.push(e),
    });
    expect(started.upgrade).toBeUndefined();
    expect(await started.baseline).toBe(true);
    expect(published).toEqual([
      {
        type: "review_artifact",
        artifact: "reading_diff",
        poweredBy: "git",
        baseRef: "main",
        diff: "diff --git a/f b/f\n+x",
        truncated: false,
        at: expect.any(Number),
      },
    ]);
  });

  it("meat provider: the git baseline AND the meat upgrade each publish; readers prefer meat", async () => {
    const published: RunEvent[] = [];
    const started = startReviewReadingDiff({
      executor: exec((cmd) =>
        cmd.includes("meat") ? JSON.stringify({ smart_diff: "abridged", summary: "s" }) : "diff --git a/f b/f\n+x",
      ),
      cfg: { provider: "meat" },
      env: {},
      baseRef: "main",
      publish: (e) => published.push(e),
    });
    expect(await started.baseline).toBe(true);
    expect(await started.upgrade).toBe(true);
    const powered = published
      .map((e) => (e.type === "review_artifact" && e.artifact === "reading_diff" ? e.poweredBy : "?"))
      .sort();
    expect(powered).toEqual(["git", "meat"]);
  });

  it("a hanging meat never blocks the baseline — meat lands iff it finishes (the pipeline has no waits)", async () => {
    const published: RunEvent[] = [];
    const started = startReviewReadingDiff({
      executor: exec((cmd) => (cmd.includes("meat") ? new Promise<string>(() => {}) : "diff --git a/f b/f\n+x")),
      cfg: { provider: "meat" },
      env: {},
      baseRef: "main",
      publish: (e) => published.push(e),
    });
    expect(await started.baseline).toBe(true); // resolves while meat still hangs
    expect(published.filter((e) => e.type === "review_artifact")).toHaveLength(1);
  });

  it("off (config or env) → baseline false, no upgrade, nothing published", async () => {
    const published: RunEvent[] = [];
    const a = startReviewReadingDiff({
      executor: exec(() => "d"),
      cfg: { provider: "off" },
      env: {},
      baseRef: "main",
      publish: (e) => published.push(e),
    });
    const b = startReviewReadingDiff({
      executor: exec(() => "d"),
      cfg: undefined,
      env: { SWITCHBOARD_READING_DIFF: "off" },
      baseRef: "main",
      publish: (e) => published.push(e),
    });
    expect(await a.baseline).toBe(false);
    expect(await b.baseline).toBe(false);
    expect(a.upgrade).toBeUndefined();
    expect(published).toEqual([]);
  });

  it("a production failure resolves false — never rejects into the run", async () => {
    const published: RunEvent[] = [];
    const boom = {
      exec: async () => {
        throw new Error("sandbox dead");
      },
    };
    const started = startReviewReadingDiff({
      executor: boom,
      cfg: { provider: "meat" },
      env: {},
      baseRef: "main",
      publish: (e) => published.push(e),
    });
    await expect(started.baseline).resolves.toBe(false);
    await expect(started.upgrade!).resolves.toBe(false);
    expect(published).toEqual([]);
  });
});

describe("reading diff spans (docs/reference/specs/tracing.md items 17/18)", () => {
  it("produceReadingDiff hands its span to the executor's exec, and nothing without one", async () => {
    const seen: unknown[] = [];
    const executor = {
      exec: async (_cmd: string, opts?: { span?: unknown }) => {
        seen.push(opts?.span);
        return "diff --git a/f b/f\n+x";
      },
    };
    const span = createTracer({ clock: () => 1 }).start("run.reading_diff", { sinks: [] });
    await produceReadingDiff(executor, { provider: "git", baseRef: "main" }, span);
    await produceReadingDiff(executor, { provider: "git", baseRef: "main" });
    expect(seen).toEqual([span, undefined]);
  });

  it("under a root, the baseline is a run.reading_diff child and the upgrade a run.reading_diff.upgrade child, each with its outcome and each diff's exec under its own span; without a root the same result and no span", async () => {
    const log = recordingSink();
    const root = createTracer({ clock: () => 1_000 }).start("request", { sinks: [log] });
    const execSpans: string[] = [];
    const executor = {
      exec: async (cmd: string, opts?: { span?: { name: string } }) => {
        execSpans.push(opts?.span?.name ?? "none");
        return cmd.startsWith("git diff") ? "diff --git a/f b/f\n+x" : "exit 127: meat: command not found";
      },
    };
    const published: RunEvent[] = [];
    const started = startReviewReadingDiff({
      executor,
      cfg: { provider: "meat" },
      env: {},
      baseRef: "main",
      publish: (e) => published.push(e),
      parent: root,
    });
    expect(await started.baseline).toBe(true);
    expect(await started.upgrade).toBe(false);
    const ends = log.ends
      .map((e) => [e.name, e.parentSpanId, e.attrs] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
    expect(ends).toEqual([
      ["run.reading_diff", root.id, { outcome: "published" }],
      ["run.reading_diff.upgrade", root.id, { outcome: "did_not_land" }],
    ]);
    expect([...execSpans].sort()).toEqual(["run.reading_diff", "run.reading_diff.upgrade"]);
    expect(published.map((e) => e.type)).toEqual(["review_artifact"]);
    const bare = startReviewReadingDiff({
      executor,
      cfg: { provider: "git" },
      env: {},
      baseRef: "main",
      publish: () => {},
    });
    expect(await bare.baseline).toBe(true);
    expect(execSpans.at(-1)).toBe("none");
    expect(log.ends).toHaveLength(2);
  });
});
