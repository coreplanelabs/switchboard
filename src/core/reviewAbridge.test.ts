import { describe, expect, it, vi } from "vitest";
import { GithubApiError, InMemoryGithubApi } from "../execution/githubApi.js";
import type { MeatRun, MeatRunResult } from "./meatProcess.js";
import { READING_DIFF_CAP } from "./readingDiff.js";
import {
  AbridgeRefusal,
  ReviewAbridger,
  autoAbridgeOnPersist,
  meatArtifactOf,
  type AbridgerDeps,
  type ReviewArtifactEvent,
} from "./reviewAbridge.js";
import type { RunEvent } from "./runEvents.js";
import { analyzeRunFriction } from "./runFriction.js";

/** The reading-diff artifacts of a record's events (the `pr_description` kind is not one). */
const isReadingDiff = (e: RunEvent): e is ReviewArtifactEvent =>
  e.type === "review_artifact" && e.artifact === "reading_diff";
import type { RunRecord } from "./runRecord.js";
import { InMemoryRunStore } from "./runStore.js";

// Feature: docs/reference/specs/reading-diff.md items 5–10 — ONE abridge path on
// the bot host: `ReviewAbridger.abridge` is what the `review abridge` command
// and `provider: meat` auto mode both call. Its input is the complete diff
// from GitHub's compare endpoint, the recorded git artifact only as an
// untruncated fallback; its output is a `review_artifact` appended to the
// STORED record; its state machine is `absent | running | done | failed`.

const NOW = 1_700_000_000_000;
const HEAD = "e".repeat(40);
const GIT_DIFF = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n";
const GH_DIFF = GIT_DIFF + "diff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-x\n+y\n";

function reviewRecord(id: string, over: Partial<RunRecord> = {}, artifact: Partial<RunEvent> = {}): RunRecord {
  const events: RunEvent[] = over.events ?? [
    { type: "input", text: "agent:review https://github.com/acme/api/pull/42", seq: 1 },
    { type: "run_meta", agent: "review", repo: "acme/api", ref: "patch-1", pr: 42, headSha: HEAD, seq: 2 },
    {
      type: "review_artifact",
      artifact: "reading_diff",
      poweredBy: "git",
      baseRef: "main",
      diff: GIT_DIFF,
      truncated: false,
      seq: 3,
      ...(artifact as object),
    } as RunEvent,
    { type: "answer", text: "LGTM: looks correct", seq: 4 },
  ];
  return {
    id,
    label: `review · acme/api#42`,
    agent: "review",
    model: "anthropic/claude",
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey: `slack:C1:${id}`,
    channelVisibility: "public",
    startedAt: NOW - 60_000,
    finishedAt: NOW - 1000,
    status: "completed",
    eventCount: events.length,
    storedEventCount: events.length,
    truncated: false,
    events,
    diagnosis: analyzeRunFriction(events),
    ...over,
  };
}

/** A meat runner that answers from a queue, recording what it was asked. */
function fakeMeat(answers: MeatRunResult[] = []) {
  const runs: MeatRun[] = [];
  const impl = vi.fn(async (run: MeatRun): Promise<MeatRunResult> => {
    runs.push(run);
    return (
      answers.shift() ?? {
        ok: true,
        result: { diff: `abridged(${run.diff.length})`, summary: `sum ${run.model}`, inputTokens: 10, outputTokens: 2 },
      }
    );
  });
  return { runs, impl };
}

interface Harness {
  store: InMemoryRunStore;
  meat: ReturnType<typeof fakeMeat>;
  github: InMemoryGithubApi;
  warnings: string[];
  abridger: ReviewAbridger;
}

function harness(over: Partial<AbridgerDeps> = {}, meatAnswers: MeatRunResult[] = []): Harness {
  const store = new InMemoryRunStore({ now: () => NOW });
  const meat = fakeMeat(meatAnswers);
  const github = new InMemoryGithubApi({ "acme/api": { compares: { [`main...${HEAD}`]: GH_DIFF } } });
  const warnings: string[] = [];
  const abridger = new ReviewAbridger({
    store,
    github: () => github,
    meat: meat.impl,
    defaultModel: () => "claude-opus-5",
    timeoutMs: () => 240_000,
    clock: () => NOW,
    warn: (m) => warnings.push(m),
    ...over,
  });
  return { store, meat, github, warnings, abridger };
}

describe("ReviewAbridger.abridge — the one path", () => {
  it("absent → running: starts the job and answers the in-progress marker; the job appends a meat artifact fed the GitHub compare diff", async () => {
    const h = harness();
    await h.store.put(reviewRecord("r1"));
    expect(await h.abridger.status("r1")).toEqual({ state: "absent" });
    const first = await h.abridger.abridge({ runId: "r1" });
    expect(first).toEqual({ state: "running", startedAt: NOW });
    expect(await h.abridger.status("r1")).toEqual({ state: "running", startedAt: NOW });
    const done = await h.abridger.wait("r1");
    expect(done).toMatchObject({
      state: "done",
      reused: false,
      artifact: {
        model: "claude-opus-5",
        summary: "sum claude-opus-5",
        input: "github-compare",
        inputBytes: Buffer.byteLength(GH_DIFF),
        truncated: false,
        meatTokens: { input: 10, output: 2 },
      },
    });
    expect(h.meat.runs).toEqual([{ diff: GH_DIFF, model: "claude-opus-5", timeoutMs: 240_000 }]);
    const stored = (await h.store.get("r1"))!;
    const meat = meatArtifactOf(stored)!;
    expect(meat).toMatchObject({
      type: "review_artifact",
      artifact: "reading_diff",
      poweredBy: "meat",
      baseRef: "main",
      diff: `abridged(${GH_DIFF.length})`,
      summary: "sum claude-opus-5",
      input: "github-compare",
      inputBytes: Buffer.byteLength(GH_DIFF),
      model: "claude-opus-5",
      meatTokens: { input: 10, output: 2 },
      at: NOW,
      seq: 5, // after the record's own last stamp
    });
    expect(stored.eventCount).toBe(5);
    expect(stored.storedEventCount).toBe(5);
    expect(stored.events.filter(isReadingDiff).map((e) => e.poweredBy)).toEqual(["git", "meat"]);
  });

  it("is idempotent: a second call answers the stored artifact as done/reused without spending; --force recomputes and REPLACES it", async () => {
    const h = harness();
    await h.store.put(reviewRecord("r1"));
    await h.abridger.abridge({ runId: "r1" });
    await h.abridger.wait("r1");
    expect(await h.abridger.abridge({ runId: "r1" })).toMatchObject({ state: "done", reused: true });
    expect(await h.abridger.abridge({ runId: "r1", model: "claude-sonnet-5" })).toMatchObject({
      state: "done",
      reused: true,
    });
    expect(h.meat.runs).toHaveLength(1);
    expect(await h.abridger.abridge({ runId: "r1", force: true, model: "claude-sonnet-5" })).toEqual({
      state: "running",
      startedAt: NOW,
    });
    await h.abridger.wait("r1");
    expect(h.meat.runs).toHaveLength(2);
    expect(h.meat.runs[1].model).toBe("claude-sonnet-5");
    const stored = (await h.store.get("r1"))!;
    const artifacts = stored.events.filter(isReadingDiff);
    expect(artifacts.map((e) => e.poweredBy)).toEqual(["git", "meat"]); // replaced, not accumulated
    // The replacement takes the NEXT stamp after every event the record ever held
    // (the replaced one included), so an `afterSeq` cursor that saw 5 sees 6.
    expect(meatArtifactOf(stored)).toMatchObject({ model: "claude-sonnet-5", seq: 6 });
    expect(stored.eventCount).toBe(5);
  });

  it("a second call while the job runs is `running` — one spawn per run at a time, even with --force", async () => {
    let release!: (r: MeatRunResult) => void;
    const slow = new Promise<MeatRunResult>((r) => (release = r));
    const h = harness({ meat: vi.fn(() => slow) });
    await h.store.put(reviewRecord("r1"));
    expect(await h.abridger.abridge({ runId: "r1" })).toEqual({ state: "running", startedAt: NOW });
    expect(await h.abridger.abridge({ runId: "r1", force: true })).toEqual({ state: "running", startedAt: NOW });
    expect(h.abridger.running()).toEqual(["r1"]);
    release({ ok: true, result: { diff: "a", summary: "s" } });
    expect(await h.abridger.wait("r1")).toMatchObject({ state: "done" });
    expect(h.abridger.running()).toEqual([]);
  });

  it("two concurrent calls on the same run join ONE decision: both get the same marker, meat is spawned once, one artifact lands", async () => {
    let release!: (r: MeatRunResult) => void;
    const meat = vi.fn(() => new Promise<MeatRunResult>((r) => (release = r)));
    const h = harness({ meat });
    await h.store.put(reviewRecord("r1"));
    // Both calls are in flight before either has read the record — the race a
    // check-then-act would lose (two productions, two Opus calls).
    const [a, b] = await Promise.all([
      h.abridger.abridge({ runId: "r1" }),
      h.abridger.abridge({ runId: "r1", force: true }),
    ]);
    expect(a).toEqual({ state: "running", startedAt: NOW });
    expect(b).toEqual(a);
    expect(h.abridger.running()).toEqual(["r1"]);
    release({ ok: true, result: { diff: "a", summary: "s" } });
    expect(await h.abridger.wait("r1")).toMatchObject({ state: "done", reused: false });
    expect(meat).toHaveBeenCalledTimes(1);
    const stored = (await h.store.get("r1"))!;
    expect(stored.events.filter(isReadingDiff).map((e) => e.poweredBy)).toEqual(["git", "meat"]);
    expect(stored.eventCount).toBe(5);
  });

  it("an unknown run is not_found; a run with no git reading diff (a coding run, a review with none) is a named conflict", async () => {
    const h = harness();
    await expect(h.abridger.abridge({ runId: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await h.store.put(
      reviewRecord("coding", {
        agent: "coding",
        events: [
          { type: "input", text: "fix it", seq: 1 },
          { type: "run_meta", agent: "coding", repo: "acme/api", seq: 2 },
          { type: "answer", text: "done", seq: 3 },
        ],
      }),
    );
    const err = await h.abridger.abridge({ runId: "coding" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AbridgeRefusal);
    expect(err).toMatchObject({
      code: "conflict",
      message: "run coding carries no reading diff — only PR review runs record one",
    });
    expect(await h.abridger.status("coding")).toEqual({ state: "absent" });
    expect(h.meat.impl).not.toHaveBeenCalled();
  });
});

describe("ReviewAbridger — input completeness (compare first, recorded only when whole)", () => {
  it("compare 404 → falls back to the untruncated recorded diff and says so on the artifact", async () => {
    const h = harness({ github: () => new InMemoryGithubApi({ "acme/api": {} }) });
    await h.store.put(reviewRecord("r1"));
    await h.abridger.abridge({ runId: "r1" });
    const done = await h.abridger.wait("r1");
    expect(done).toMatchObject({
      state: "done",
      artifact: { input: "recorded", inputBytes: Buffer.byteLength(GIT_DIFF) },
    });
    expect(h.meat.runs[0].diff).toBe(GIT_DIFF);
    expect(h.warnings).toEqual(["[reading-diff] r1 using the recorded diff: GitHub compare failed (404)"]);
  });

  it("compare 406 (too large) with a TRUNCATED recorded diff → failed, naming both causes; nothing spent", async () => {
    const h = harness({
      github: () => new InMemoryGithubApi({ "acme/api": { compares: { [`main...${HEAD}`]: { status: 406 } } } }),
    });
    await h.store.put(reviewRecord("r1", {}, { truncated: true, diff: GIT_DIFF + "…[500 more chars]" }));
    await h.abridger.abridge({ runId: "r1" });
    expect(await h.abridger.wait("r1")).toEqual({
      state: "failed",
      reason: "diff unavailable: GitHub compare failed (406) and the recorded diff is truncated",
      at: NOW,
    });
    expect(h.meat.impl).not.toHaveBeenCalled();
    expect(meatArtifactOf((await h.store.get("r1"))!)).toBeUndefined();
  });

  it("a compare diff cut at the cap is not complete: the recorded diff serves when whole, else the refusal names the cut", async () => {
    const big = "x".repeat(2000);
    const github = new InMemoryGithubApi({ "acme/api": { compares: { [`main...${HEAD}`]: big } } });
    const h = harness({ github: () => github, compareMaxChars: 1000 });
    await h.store.put(reviewRecord("r1"));
    await h.abridger.abridge({ runId: "r1" });
    expect(await h.abridger.wait("r1")).toMatchObject({ state: "done", artifact: { input: "recorded" } });
    expect(h.meat.runs[0].diff).toBe(GIT_DIFF);
    const h2 = harness({ github: () => github, compareMaxChars: 1000 });
    await h2.store.put(reviewRecord("r2", {}, { truncated: true }));
    await h2.abridger.abridge({ runId: "r2" });
    expect(await h2.abridger.wait("r2")).toEqual({
      state: "failed",
      reason: "diff unavailable: GitHub compare diff exceeds 1000 chars and the recorded diff is truncated",
      at: NOW,
    });
    expect(h2.meat.impl).not.toHaveBeenCalled();
  });

  it("no GitHub credential, or a run_meta without repo/head → the recorded diff (whole) or the named refusal", async () => {
    const h = harness({ github: () => undefined });
    await h.store.put(reviewRecord("r1"));
    await h.abridger.abridge({ runId: "r1" });
    expect(await h.abridger.wait("r1")).toMatchObject({ state: "done", artifact: { input: "recorded" } });
    expect(h.warnings.join("\n")).toMatch(/no GitHub credential/);
    const h2 = harness();
    await h2.store.put(
      reviewRecord("r2", {
        events: [
          { type: "run_meta", agent: "review", repo: "acme/api", seq: 1 },
          {
            type: "review_artifact",
            artifact: "reading_diff",
            poweredBy: "git",
            baseRef: "main",
            diff: "d",
            truncated: true,
            seq: 2,
          },
        ],
      }),
    );
    await h2.abridger.abridge({ runId: "r2" });
    expect(await h2.abridger.wait("r2")).toEqual({
      state: "failed",
      reason: "diff unavailable: the run records no repo and head to compare and the recorded diff is truncated",
      at: NOW,
    });
  });

  it("a compare that throws something other than a GithubApiError is still a named compare failure", async () => {
    const h = harness({
      github: () => ({
        compareDiff: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    });
    await h.store.put(reviewRecord("r1", {}, { truncated: true }));
    await h.abridger.abridge({ runId: "r1" });
    expect(await h.abridger.wait("r1")).toMatchObject({
      reason: "diff unavailable: GitHub compare failed (fetch failed) and the recorded diff is truncated",
    });
    expect(GithubApiError).toBeDefined();
  });
});

describe("ReviewAbridger — failures and the append", () => {
  it("meat failing is `failed` with meat's reason, remembered until --force; the record is untouched", async () => {
    const h = harness({}, [{ ok: false, reason: "meat exited 1: no LLM credentials" }]);
    await h.store.put(reviewRecord("r1"));
    await h.abridger.abridge({ runId: "r1" });
    const failed = { state: "failed", reason: "meat exited 1: no LLM credentials", at: NOW };
    expect(await h.abridger.wait("r1")).toEqual(failed);
    expect(await h.abridger.status("r1")).toEqual(failed);
    expect(await h.abridger.abridge({ runId: "r1" })).toEqual(failed); // no second spend
    expect(h.meat.runs).toHaveLength(1);
    expect(meatArtifactOf((await h.store.get("r1"))!)).toBeUndefined();
    expect(await h.abridger.abridge({ runId: "r1", force: true })).toEqual({ state: "running", startedAt: NOW });
    expect(await h.abridger.wait("r1")).toMatchObject({ state: "done" });
  });

  it("the appended diff and summary are redacted and control-stripped before they reach the record, and capped", async () => {
    const secret = "ghp_" + "A".repeat(36);
    const h = harness({}, [
      {
        ok: true,
        result: {
          diff: `\u001b[31m+token=${secret}\u001b[m\n` + "z".repeat(READING_DIFF_CAP),
          summary: `adds ${secret} to .env`,
        },
      },
    ]);
    await h.store.put(reviewRecord("r1"));
    await h.abridger.abridge({ runId: "r1" });
    await h.abridger.wait("r1");
    const meat = meatArtifactOf((await h.store.get("r1"))!)!;
    expect(meat.diff).not.toContain(secret);
    expect(meat.diff).not.toContain("[");
    expect(meat.diff.startsWith("+token=«redacted")).toBe(true);
    expect(meat.summary).toContain("«redacted");
    expect(meat.truncated).toBe(true);
    expect(meat.diff).toMatch(/…\[\d+ more chars\]$/);
  });

  it("a record deleted between the read and the append fails by name rather than resurrecting it", async () => {
    let release!: (r: MeatRunResult) => void;
    const h = harness({ meat: vi.fn(() => new Promise<MeatRunResult>((r) => (release = r))) });
    await h.store.put(reviewRecord("r1"));
    await h.abridger.abridge({ runId: "r1" });
    await h.store.delete("r1");
    release({ ok: true, result: { diff: "a" } });
    expect(await h.abridger.wait("r1")).toEqual({
      state: "failed",
      reason: "the run's record is gone — nothing to append to",
      at: NOW,
    });
    expect(await h.store.get("r1")).toBeNull();
  });

  it("a rewrite the store answers `stored: false` (the record fell outside retention in its own write) is a named failure", async () => {
    const inner = new InMemoryRunStore({ now: () => NOW });
    const store = Object.assign(Object.create(inner) as InMemoryRunStore, {
      put: async (r: RunRecord) => ({ ...(await inner.put(r)), stored: false }),
    });
    const h = harness({ store });
    await inner.put(reviewRecord("r1"));
    await h.abridger.abridge({ runId: "r1" });
    expect(await h.abridger.wait("r1")).toEqual({
      state: "failed",
      reason: "the run's record fell outside the retention window; nothing was stored",
      at: NOW,
    });
  });
});

describe("autoAbridgeOnPersist — provider: meat is the same path, after the record is durable", () => {
  it("meat → abridge({ runId }) on persist; git or off → nothing; refusals (a coding run) are silent, failures are warned", async () => {
    const h = harness();
    await h.store.put(reviewRecord("r1"));
    await h.store.put(reviewRecord("c1", { agent: "coding", events: [{ type: "input", text: "x", seq: 1 }] }));
    const spy = vi.spyOn(h.abridger, "abridge");
    const hook = autoAbridgeOnPersist(
      () => h.abridger,
      () => ({ provider: "meat" }),
      {},
    );
    hook("r1");
    hook("c1");
    hook("missing");
    await h.abridger.settled();
    expect(spy.mock.calls.map((c) => c[0])).toEqual([{ runId: "r1" }, { runId: "c1" }, { runId: "missing" }]);
    expect(meatArtifactOf((await h.store.get("r1"))!)).toBeDefined();
    expect(h.warnings).toEqual([]); // refusals are the expected shape of a non-review run
    const off = autoAbridgeOnPersist(
      () => h.abridger,
      () => ({ provider: "git" }),
      {},
    );
    off("r1");
    const env = autoAbridgeOnPersist(
      () => h.abridger,
      () => ({ provider: "meat" }),
      { SWITCHBOARD_READING_DIFF: "off" },
    );
    env("r1");
    await h.abridger.settled();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("a failed auto abridge is warned with the run id and reason", async () => {
    const h = harness({}, [{ ok: false, reason: "meat exited 1: boom" }]);
    await h.store.put(reviewRecord("r1"));
    autoAbridgeOnPersist(
      () => h.abridger,
      () => ({ provider: "meat" }),
      {},
    )("r1");
    await h.abridger.settled();
    expect(h.warnings.at(-1)).toBe("[reading-diff] r1 meat did not land: meat exited 1: boom");
  });
});
