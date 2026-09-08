import { describe, expect, it } from "vitest";
import {
  MEAT_MODEL_DEFAULT,
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
// `review_artifact` reading diff: the git BASELINE, produced by the run's own
// executor and joined by the dispatcher before the answer. The abridged diff
// is reviewAbridge.ts's, after the review, on the bot host — nothing here runs
// meat; `provider: meat` only decides that the abridging happens automatically.

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
    expect(resolveReadingDiff({ provider: "off" }, {})).toBeNull();
  });

  it("meat without a model is Opus — the measured floor for a diff that is actually abridged; git names no model", () => {
    expect(MEAT_MODEL_DEFAULT).toBe("claude-opus-5");
    expect(resolveReadingDiff({ provider: "meat", meatTimeoutS: -5 }, {})).toEqual({
      provider: "meat",
      meatModel: "claude-opus-5",
      meatTimeoutS: 240,
    });
    expect(resolveReadingDiff({ provider: "git", meatModel: "claude-opus-4-8" }, {})).toEqual({
      provider: "git",
      meatModel: "claude-opus-4-8",
      meatTimeoutS: 240,
    });
  });

  it("SWITCHBOARD_READING_DIFF overrides config: git | meat | off", () => {
    expect(resolveReadingDiff({ provider: "meat" }, { SWITCHBOARD_READING_DIFF: "git" })).toEqual({
      provider: "git",
      meatTimeoutS: 240,
    });
    expect(resolveReadingDiff({ provider: "off" }, { SWITCHBOARD_READING_DIFF: "meat" })).toEqual({
      provider: "meat",
      meatModel: "claude-opus-5",
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
  it("a full diff against origin/<base>, option injection closed", () => {
    expect(readingDiffCommand("main")).toBe("git diff --no-color --end-of-options 'origin/main...HEAD'");
  });

  it("no base ref → origin/HEAD (the repository's default branch)", () => {
    expect(readingDiffCommand(undefined)).toBe("git diff --no-color --end-of-options 'origin/HEAD...HEAD'");
  });

  it("a hostile base ref is quoted into one inert token", () => {
    expect(readingDiffCommand("x; rm -rf /")).toBe("git diff --no-color --end-of-options 'origin/x; rm -rf /...HEAD'");
  });

  it("never names meat — no execution container runs it", () => {
    expect(readingDiffCommand("main")).not.toContain("meat");
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

  it("one git command → a git-powered artifact", async () => {
    const a = await produceReadingDiff(
      exec((cmd) => (cmd.startsWith("git diff") ? "diff --git a/f b/f\n+x" : "?")),
      { baseRef: "main" },
    );
    expect(a).toEqual({ poweredBy: "git", baseRef: "main", diff: "diff --git a/f b/f\n+x", truncated: false });
  });

  it("a git failure yields null (no artifact, never a throw into the run)", async () => {
    const a = await produceReadingDiff(
      exec(() => "fatal: ambiguous argument 'origin/gone...HEAD'"),
      { baseRef: "gone" },
    );
    expect(a).toBeNull();
    const b = await produceReadingDiff(
      exec(() => {
        throw new Error("sandbox dead");
      }),
      { baseRef: "main" },
    );
    expect(b).toBeNull();
  });

  it("an empty diff yields null — nothing to review, no artifact", async () => {
    expect(
      await produceReadingDiff(
        exec(() => ""),
        { baseRef: "main" },
      ),
    ).toBeNull();
  });

  it("caps the diff and marks truncation", async () => {
    const a = await produceReadingDiff(
      exec(() => "diff --git\n" + "y".repeat(READING_DIFF_CAP + 100)),
      { baseRef: "main" },
    );
    expect(a?.truncated).toBe(true);
  });

  // The artifact goes straight into the run stream, which the registry
  // publishes as-is — so this module owns the stream's
  // hygiene: control-strip + redact FIRST, cap after, on every string.
  it("redacts secrets and strips ANSI from the diff before it can reach the stream", async () => {
    const secret = "ghp_" + "A".repeat(36);
    const git = await produceReadingDiff(
      exec(() => `diff --git a/.env b/.env\n+[31mGITHUB_TOKEN=${secret}[m`),
      { baseRef: "main" },
    );
    expect(git?.diff).not.toContain(secret);
    expect(git?.diff).toContain("«redacted");
    expect(git?.diff).not.toContain("[31m");
  });

  it("never splits a surrogate pair at the cap", async () => {
    const emoji = "😀"; // one astral char = two UTF-16 units
    const body = "d".repeat(READING_DIFF_CAP - 1) + emoji + "tail";
    const a = await produceReadingDiff(
      exec(() => body),
      { baseRef: "main" },
    );
    expect(a?.truncated).toBe(true);
    const cut = a!.diff.slice(0, a!.diff.indexOf("…"));
    expect(cut.charCodeAt(cut.length - 1)).toBeLessThan(0xd800); // no lone high surrogate
  });
});

describe("startReviewReadingDiff (the baseline, guaranteed)", () => {
  const exec = (impl: (cmd: string) => string | Promise<string>) => ({ exec: async (cmd: string) => impl(cmd) });

  it("publishes the stamped envelope and resolves true", async () => {
    const published: RunEvent[] = [];
    const started = startReviewReadingDiff({
      executor: exec(() => "diff --git a/f b/f\n+x"),
      cfg: { provider: "git" },
      env: {},
      baseRef: "main",
      publish: (e) => published.push(e),
    });
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

  it("provider meat: the run still produces ONLY the git baseline — one command, no meat; the abridging is the host's, after the record is durable", async () => {
    const commands: string[] = [];
    const published: RunEvent[] = [];
    const started = startReviewReadingDiff({
      executor: exec((cmd) => {
        commands.push(cmd);
        return "diff --git a/f b/f\n+x";
      }),
      cfg: { provider: "meat" },
      env: {},
      baseRef: "main",
      publish: (e) => published.push(e),
    });
    expect(await started.baseline).toBe(true);
    expect(commands).toEqual(["git diff --no-color --end-of-options 'origin/main...HEAD'"]);
    expect(
      published.map((e) => (e.type === "review_artifact" && e.artifact === "reading_diff" ? e.poweredBy : "?")),
    ).toEqual(["git"]);
    expect(started).not.toHaveProperty("upgrade");
  });

  it("off (config or env) → baseline false, nothing published, nothing run", async () => {
    const published: RunEvent[] = [];
    let ran = 0;
    const a = startReviewReadingDiff({
      executor: exec(() => (ran++, "d")),
      cfg: { provider: "off" },
      env: {},
      baseRef: "main",
      publish: (e) => published.push(e),
    });
    const b = startReviewReadingDiff({
      executor: exec(() => (ran++, "d")),
      cfg: undefined,
      env: { SWITCHBOARD_READING_DIFF: "off" },
      baseRef: "main",
      publish: (e) => published.push(e),
    });
    expect(await a.baseline).toBe(false);
    expect(await b.baseline).toBe(false);
    expect(published).toEqual([]);
    expect(ran).toBe(0);
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
    await produceReadingDiff(executor, { baseRef: "main" }, span);
    await produceReadingDiff(executor, { baseRef: "main" });
    expect(seen).toEqual([span, undefined]);
  });

  it("under a root, the baseline is a run.reading_diff child with its outcome and the diff's exec under it; without a root the same result and no span", async () => {
    const log = recordingSink();
    const root = createTracer({ clock: () => 1_000 }).start("request", { sinks: [log] });
    const execSpans: string[] = [];
    const executor = {
      exec: async (_cmd: string, opts?: { span?: { name: string } }) => {
        execSpans.push(opts?.span?.name ?? "none");
        return "diff --git a/f b/f\n+x";
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
    expect(log.ends.map((e) => [e.name, e.parentSpanId, e.attrs] as const)).toEqual([
      ["run.reading_diff", root.id, { outcome: "published" }],
    ]);
    expect(execSpans).toEqual(["run.reading_diff"]);
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
    expect(log.ends).toHaveLength(1);
  });

  it("a baseline that produces nothing ends its span with outcome none", async () => {
    const log = recordingSink();
    const root = createTracer({ clock: () => 1_000 }).start("request", { sinks: [log] });
    const started = startReviewReadingDiff({
      executor: { exec: async () => "" },
      cfg: undefined,
      env: {},
      baseRef: "main",
      publish: () => {},
      parent: root,
    });
    expect(await started.baseline).toBe(false);
    expect(log.ends.map((e) => [e.name, e.attrs])).toEqual([["run.reading_diff", { outcome: "none" }]]);
  });
});
