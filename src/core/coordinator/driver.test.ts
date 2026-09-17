import { describe, expect, it } from "vitest";
import { MERGE_WAIT_CHUNK_MS, WAIT_CHUNK_MS } from "../ship/coordinator.js";
import { checksSettledEventType, RUN_FINISHED_EVENT_PREFIX, type CoordinatorUnit } from "./contract.js";
import {
  SPAWN_STEP_CONFIG,
  STEP_CONFIG,
  STEP_RETRIES,
  readBotAnswer,
  runPlan,
  transientRefusal,
  type BotAnswer,
  type BotReply,
  type CoordinatorBot,
  type CoordinatorStepRoute,
  type StepConfig,
  type StepRunner,
} from "./driver.js";

// Feature: docs/reference/specs/http-ingress.md item 9 — the plan runner's
// driver, the `ShipCoordinator` Workflow's `run()` body over a structural step
// runner and a bot client, so plain Node proves what the platform replays:
// which steps are taken, under which names, in which order; how the bot's
// answers become the machine's returns; what is left to the platform's retry.

const MIN = 60_000;
const T0 = 1_700_000_000_000;
const INSTANCE = "plan-fixture";
const PR_URL = "https://github.com/acme/api/pull/7";
const HEAD = "a".repeat(40);
const MERGED = "9".repeat(40);

const row = (unit: string, over: Partial<CoordinatorUnit> = {}): CoordinatorUnit => ({
  instanceId: INSTANCE,
  unit,
  slug: unit.toLowerCase(),
  title: `Unit ${unit}`,
  branch: `plan/fixture/${unit.toLowerCase()}`,
  dependsOn: [],
  rounds: [],
  ...over,
});

/** The bot's reply as the wire carries it: the fixture object, stamped with the bot's clock, as text. */
const ok = (body: object, at = T0, status = 200): BotReply => ({ status, text: JSON.stringify({ ...body, at }) });
/** The same, read — what the mappers see. */
const answer = (body: object, at = T0, status = 200): BotAnswer => ({
  status,
  body: { ...(body as Record<string, unknown>), at },
});

/** The bot's `plan` answer for the given rows: who merges is the instance's field, as the route answers it. */
const planAnswer = (
  units: CoordinatorUnit[],
  at = T0,
  merge: "runner" | "person" = "runner",
  extra: Record<string, unknown> = {},
): BotReply =>
  ok(
    {
      ok: true,
      planId: "fixture",
      merge,
      repo: "acme/api",
      base: "main",
      caps: { maxRounds: 2, maxMinutes: 120 },
      units,
      ...extra,
    },
    at,
  );

const started = (unit: string, at = T0): BotReply =>
  ok({ ok: true, threadKey: `slack:C1:${unit}`, branch: `plan/fixture/${unit.toLowerCase()}`, base: "main" }, at);
const branched = (unit: string, at = T0): BotReply =>
  ok({ ok: true, branch: `plan/fixture/${unit.toLowerCase()}`, base: "main" }, at);
const spawned = (runId: string, at = T0): BotReply => ok({ ok: true, runId, threadKey: "slack:C1:x" }, at);
const record = (run: object, at = T0): BotReply => ok({ ok: true, run }, at);
const codingDone = (runId: string, at: number) =>
  record(
    {
      id: runId,
      finished: true,
      status: "completed",
      pr: { number: 7, url: PR_URL, created: true },
      finalReply: "Done — branch pushed.",
      handoff: true,
    },
    at,
  );
const reviewApproved = (runId: string, at: number) =>
  record(
    {
      id: runId,
      finished: true,
      status: "completed",
      verdict: { verdict: "approve", summary: "clean", findings: [] },
      reviewPosted: true,
      reviewHead: HEAD,
    },
    at,
  );
const prOpen = (at = T0, over: Record<string, unknown> = {}): BotReply =>
  ok({ ok: true, state: "open", prNumber: 7, url: PR_URL, headSha: HEAD, ...over }, at);
const prNone = (at = T0): BotReply => ok({ ok: true, state: "none" }, at);
const prMerged = (at = T0, mergedAt = "2026-09-13T23:55:59Z"): BotReply =>
  ok({ ok: true, state: "merged", prNumber: 7, url: PR_URL, sha: MERGED, mergedAt }, at);
const acked = (at = T0): BotReply => ok({ ok: true }, at);

type Taken =
  | { kind: "do"; name: string; config: StepConfig }
  | { kind: "sleep"; name: string; ms: number }
  | { kind: "wait"; name: string; type: string; timeout?: number };

/** A step runner that runs each step at once and remembers what it was asked:
 *  a `do` retries a throwing callback under its own policy (no delay), a wait
 *  answers from the script by step name — `event` resolves, anything else
 *  rejects the way the platform's timeout does. */
function steps(waits: Record<string, "event" | "timeout"> = {}) {
  const taken: Taken[] = [];
  const attempts: Record<string, number> = {};
  const runner: StepRunner = {
    async do(name, config, callback) {
      taken.push({ kind: "do", name, config });
      for (let attempt = 0; ; attempt++) {
        attempts[name] = attempt + 1;
        try {
          return await callback();
        } catch (err) {
          if (attempt >= config.retries.limit) throw err;
        }
      }
    },
    async sleep(name, ms) {
      taken.push({ kind: "sleep", name, ms });
    },
    async waitForEvent(name, options) {
      taken.push({ kind: "wait", name, type: options.type, timeout: options.timeout });
      const answer = waits[name] ?? "timeout";
      if (answer === "event") return { payload: { runId: options.type.slice(RUN_FINISHED_EVENT_PREFIX.length) } };
      throw new Error(`timeout waiting for ${options.type}`);
    },
  };
  const names = () => taken.map((t) => t.name);
  return { runner, taken, attempts, names };
}

type Scripted = BotReply | Error | ((body: Record<string, unknown>) => BotReply | Error);

/** A bot that answers each route from its queue, in order, and remembers every call. */
function bot(script: Partial<Record<CoordinatorStepRoute, Scripted[]>>) {
  const calls: Array<{ route: CoordinatorStepRoute; body: Record<string, unknown> }> = [];
  const queues: Partial<Record<CoordinatorStepRoute, Scripted[]>> = Object.fromEntries(
    Object.entries(script).map(([k, v]) => [k, [...(v ?? [])]]),
  );
  const client: CoordinatorBot = {
    async step(route, body) {
      calls.push({ route, body });
      const next = queues[route]?.shift();
      if (next === undefined) throw new Error(`the test scripted no ${route} answer for ${JSON.stringify(body)}`);
      const answer = typeof next === "function" ? next(body) : next;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const of = (route: CoordinatorStepRoute) => calls.filter((c) => c.route === route).map((c) => c.body);
  return { client, calls, of };
}

describe("the plan runner's driver — the Workflow body over the step runner (item 9)", () => {
  it("a one-unit plan runs coding, then review to approve, then the runner's merge at the approved head, and ends merged: the steps in order under the machine's names, every spawn typed by its brief and clipped budget, every wait typed `run-finished-<runId>` for one chunk and followed by a read-record, the round boundaries and the ending told to the bot, the finish completed", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event", "U10/1/review/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0"), spawned("run-r1", T0 + 10 * MIN)],
      "read-record": [codingDone("run-c0", T0 + 10 * MIN), reviewApproved("run-r1", T0 + 20 * MIN)],
      "pr-check": [prNone(), prOpen(T0 + 10 * MIN)],
      round: [acked(), acked(), acked(), acked()],
      merge: [ok({ ok: true, outcome: "merged", sha: MERGED }, T0 + 21 * MIN)],
      "unit-end": [ok({ ok: true, told: true }, T0 + 21 * MIN)],
      finish: [ok({ ok: true, runId: "run-parent" }, T0 + 21 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary).toEqual({
      instance: INSTANCE,
      planId: "fixture",
      units: { U10: "merged" },
      outcome: "completed",
    });
    expect(s.names()).toEqual([
      "plan",
      "U10/start",
      "U10/pr-check",
      "U10/branch",
      "U10/0/coding",
      "U10/note/1",
      "U10/0/coding/wait/1",
      "U10/0/coding/read/1",
      "U10/0/coding/pr-check",
      "U10/note/2",
      "U10/1/review",
      "U10/note/3",
      "U10/1/review/wait/1",
      "U10/1/review/read/1",
      "U10/note/4",
      "U10/merge/1",
      "U10/end",
      "finish",
    ]);
    // The merge is asked for at exactly the head the review approved.
    expect(b.of("merge")).toEqual([{ parentInstanceId: INSTANCE, unit: "U10", prNumber: 7, headSha: HEAD }]);
    // Every step retries under the one policy; the spawn alone has the longer timeout (an attach can take minutes).
    for (const t of s.taken) {
      if (t.kind !== "do") continue;
      expect(t.config.retries, t.name).toEqual(STEP_RETRIES);
      expect(t.config.timeout, t.name).toBe(
        /^U10\/\d+\/(coding|review|findings)$/.test(t.name) ? SPAWN_STEP_CONFIG.timeout : undefined,
      );
    }
    expect(STEP_RETRIES).toEqual({ limit: 12, delay: 2 * MIN, backoff: "constant" });
    expect(STEP_CONFIG).toEqual({ retries: STEP_RETRIES });
    // The waits: one chunk each, typed by the run the spawn answered in the platform's alphabet — the machine
    // walks the child's budget plus the margin in chunks, a read-record between them.
    expect(s.taken.filter((t) => t.kind === "wait")).toEqual([
      { kind: "wait", name: "U10/0/coding/wait/1", type: "run-finished-run-c0", timeout: WAIT_CHUNK_MS },
      { kind: "wait", name: "U10/1/review/wait/1", type: "run-finished-run-r1", timeout: WAIT_CHUNK_MS },
    ]);
    // What the bot was asked, in the machine's words.
    expect(b.of("plan")).toEqual([{ parentInstanceId: INSTANCE }]);
    expect(b.of("unit-start")).toEqual([{ parentInstanceId: INSTANCE, unit: "U10" }]);
    expect(b.of("branch")).toEqual([{ parentInstanceId: INSTANCE, unit: "U10" }]);
    expect(b.of("spawn")).toEqual([
      {
        parentInstanceId: INSTANCE,
        unit: "U10",
        step: "U10/0/coding",
        preset: "coding",
        // The coding preset's 45 clipped to the 45-minute wall clock minus the
        // loop's reserve (two review rounds and the merge poll, 11 min).
        budget: 45,
        brief: { kind: "contract", unit: "U10", rebase: { branch: "plan/fixture/u10", onto: "main" } },
      },
      {
        parentInstanceId: INSTANCE,
        unit: "U10",
        step: "U10/1/review",
        preset: "review",
        budget: 25,
        brief: { kind: "review", unit: "U10", pr: 7, headSha: HEAD, round: 1 },
      },
    ]);
    expect(b.of("read-record")).toEqual([
      { parentInstanceId: INSTANCE, unit: "U10", runId: "run-c0" },
      { parentInstanceId: INSTANCE, unit: "U10", runId: "run-r1" },
    ]);
    // Twice: once before the branch (what already heads it), once after the coding child.
    expect(b.of("pr-check")).toEqual([
      { parentInstanceId: INSTANCE, unit: "U10" },
      { parentInstanceId: INSTANCE, unit: "U10" },
    ]);
    expect(b.of("round")).toEqual([
      { parentInstanceId: INSTANCE, unit: "U10", index: 0, agent: "coding", outcome: "started" },
      { parentInstanceId: INSTANCE, unit: "U10", index: 0, agent: "coding", outcome: "pr_opened" },
      { parentInstanceId: INSTANCE, unit: "U10", index: 1, agent: "review", outcome: "started" },
      { parentInstanceId: INSTANCE, unit: "U10", index: 1, agent: "review", outcome: "approve" },
    ]);
    const [end] = b.of("unit-end") as Array<{
      ending: { kind: string; report: string };
      pr: unknown;
      unit: string;
      codingRunId?: string;
    }>;
    expect(end.unit).toBe("U10");
    expect(end.pr).toEqual({ number: 7, url: PR_URL });
    expect(end.codingRunId).toBe("run-c0"); // the last coding child, whose record carries the unit's handoff
    expect(end.ending.kind).toBe("merged");
    expect(end.ending.report).toContain(`✅ Merged after 1 review round: ${PR_URL} (squash \`${MERGED.slice(0, 7)}\`)`);
    expect(end.ending.report).toContain("plan:merge");
    expect(b.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "completed" }]);
  });

  it("a segment that ends `continued` opens the next: the unit runs again under `U10/s2/…` step names with the session — the sha to continue from, the previous run, the renewals spent and the spend — the unit-end carries the segment row, and the plan settles on the last segment's ending", async () => {
    const budgetEnded = (runId: string, at: number) =>
      record(
        {
          id: runId,
          finished: true,
          status: "completed",
          finalReply: "Budget reached: the parser is pushed, tests are next.",
          pushed: [{ ref: "plan/fixture/u10", sha: HEAD, at: at - MIN }],
          leaseStartedAt: T0,
          costUsd: 12.5,
          handoffLists: { deviations: [], followUps: [{ what: "tests", where: "src" }], unproven: [] },
        },
        at,
      );
    const s = steps({
      "U10/0/coding/wait/1": "event",
      "U10/s2/0/coding/wait/1": "event",
      "U10/s2/1/review/wait/1": "event",
    });
    const b = bot({
      plan: [
        planAnswer([row("U10")], T0, "person", { grant: { renewals: 6, costCapUsd: 50 }, grantSource: "channel" }),
      ],
      "unit-start": [started("U10"), started("U10", T0 + 46 * MIN)],
      branch: [branched("U10"), branched("U10", T0 + 46 * MIN)],
      spawn: [spawned("run-c0"), spawned("run-c1", T0 + 47 * MIN), spawned("run-r1", T0 + 60 * MIN)],
      "read-record": [
        budgetEnded("run-c0", T0 + 45 * MIN),
        codingDone("run-c1", T0 + 60 * MIN),
        reviewApproved("run-r1", T0 + 70 * MIN),
      ],
      // Segment one: nothing heads the branch before or after its child. Segment two: the pull request.
      "pr-check": [prNone(), prNone(T0 + 45 * MIN), prNone(T0 + 46 * MIN), prOpen(T0 + 60 * MIN)],
      round: [acked(), acked(), acked(), acked(), acked(), acked()],
      "unit-end": [ok({ ok: true, told: true }, T0 + 45 * MIN), ok({ ok: true, told: true }, T0 + 71 * MIN)],
      finish: [ok({ ok: true, runId: "run-parent" }, T0 + 71 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary).toEqual({
      instance: INSTANCE,
      planId: "fixture",
      units: { U10: "merge_ready" },
      outcome: "completed",
    });
    expect(s.names()).toEqual([
      "plan",
      "U10/start",
      "U10/pr-check",
      "U10/branch",
      "U10/0/coding",
      "U10/note/1",
      "U10/0/coding/wait/1",
      "U10/0/coding/read/1",
      "U10/0/coding/pr-check",
      "U10/note/2",
      "U10/end",
      "U10/s2/start",
      "U10/s2/pr-check",
      "U10/s2/branch",
      "U10/s2/0/coding",
      "U10/s2/note/1",
      "U10/s2/0/coding/wait/1",
      "U10/s2/0/coding/read/1",
      "U10/s2/0/coding/pr-check",
      "U10/s2/note/2",
      "U10/s2/1/review",
      "U10/s2/note/3",
      "U10/s2/1/review/wait/1",
      "U10/s2/1/review/read/1",
      "U10/s2/note/4",
      "U10/s2/end/pr-facts",
      "U10/s2/end",
      "finish",
    ]);
    // Segment two's coding child is briefed as a continuation from the recorded sha and the previous run.
    expect(b.of("spawn")[1]).toMatchObject({
      step: "U10/s2/0/coding",
      brief: { kind: "contract", unit: "U10", continue: { segment: 2, from: HEAD, previousRunId: "run-c0" } },
    });
    expect(b.of("round").map((r) => `${(r as { index: number }).index} ${(r as { outcome: string }).outcome}`)).toEqual(
      ["0 started", "0 continued", "0 started", "0 pr_opened", "1 started", "1 approve"],
    );
    const ends = b.of("unit-end") as Array<{ ending: { kind: string; report: string }; segment?: unknown }>;
    expect(ends[0].ending.kind).toBe("continued");
    expect(ends[0].segment).toEqual({ index: 2, from: HEAD, runId: "run-c0" });
    expect(ends[0].ending.report).toContain(`renewal 1 of 6, continues ${HEAD.slice(0, 7)}`);
    expect(ends[1].ending.kind).toBe("merge_ready");
    expect(ends[1].segment).toBeUndefined();
    expect(ends[1].ending.report).toContain("Renewals: 0 of 6 spent, cost cap $50 (granted by channel).");
  });

  it("the grant rides the plan answer into the unit's report — spent of granted, the cap and the granter — and a count the route answers above the module's ceiling reads as the default, so nothing renews on a guess (decision 0046)", async () => {
    const run = async (extra: Record<string, unknown>) => {
      const s = steps({ "U10/0/coding/wait/1": "event", "U10/1/review/wait/1": "event" });
      const b = bot({
        plan: [planAnswer([row("U10")], T0, "runner", extra)],
        "unit-start": [started("U10")],
        branch: [branched("U10")],
        spawn: [spawned("run-c0"), spawned("run-r1", T0 + 10 * MIN)],
        "read-record": [codingDone("run-c0", T0 + 10 * MIN), reviewApproved("run-r1", T0 + 20 * MIN)],
        "pr-check": [prNone(), prOpen(T0 + 10 * MIN)],
        round: [acked(), acked(), acked(), acked()],
        merge: [ok({ ok: true, outcome: "merged", sha: MERGED }, T0 + 21 * MIN)],
        "unit-end": [ok({ ok: true, told: true }, T0 + 21 * MIN)],
        finish: [ok({ ok: true, runId: "run-parent" }, T0 + 21 * MIN)],
      });
      await runPlan(s.runner, b.client, INSTANCE);
      const [end] = b.of("unit-end") as Array<{ ending: { report: string } }>;
      return end.ending.report;
    };
    expect(await run({ grant: { renewals: 3, costCapUsd: 20 }, grantSource: "channel" })).toContain(
      "Renewals: 0 of 3 spent, cost cap $20 (granted by channel).",
    );
    expect(await run({})).toContain("Renewals: 0 of 0 spent (granted by org).");
    expect(await run({ grant: { renewals: 99 }, grantSource: "user" })).toContain(
      "Renewals: 0 of 0 spent (granted by user).",
    );
  });
  it("a merge door answering merged by other — the pull request was merged after the approval — completes the plan: the unit ends merged and the report reads the Already-merged sentence", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event", "U10/1/review/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0"), spawned("run-r1", T0 + 10 * MIN)],
      "read-record": [codingDone("run-c0", T0 + 10 * MIN), reviewApproved("run-r1", T0 + 20 * MIN)],
      "pr-check": [prNone(), prOpen(T0 + 10 * MIN)],
      round: [acked(), acked(), acked(), acked()],
      merge: [
        ok({ ok: true, outcome: "merged", by: "other", sha: MERGED, mergedAt: "2026-09-16T00:46:19Z" }, T0 + 21 * MIN),
      ],
      "unit-end": [ok({ ok: true, told: true }, T0 + 21 * MIN)],
      finish: [ok({ ok: true, runId: "run-parent" }, T0 + 21 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "merged" });
    expect(summary.outcome).toBe("completed");
    const [end] = b.of("unit-end") as Array<{ ending: { kind: string; report: string } }>;
    expect(end.ending.kind).toBe("merged");
    expect(end.ending.report).toContain(`✅ Already merged: ${PR_URL} (merge commit \`${MERGED.slice(0, 7)}\``);
    expect(end.ending.report).toContain("the runner merged nothing");
  });

  it("an interrupted coding child settles the round through its run-finished event and the confirming read-record; the recover pr-check names the dead run, and the pull request the bot opened from the pushed branch carries the round on to review — the round ends with the interruption's reason, never the budget clip", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event", "U10/1/review/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0"), spawned("run-r1", T0 + 10 * MIN)],
      "read-record": [
        record({ id: "run-c0", finished: true, status: "interrupted" }, T0 + 5 * MIN),
        reviewApproved("run-r1", T0 + 20 * MIN),
      ],
      "pr-check": [prNone(), prOpen(T0 + 6 * MIN)],
      round: [acked(), acked(), acked(), acked()],
      merge: [ok({ ok: true, outcome: "merged", sha: MERGED }, T0 + 21 * MIN)],
      "unit-end": [ok({ ok: true, told: true }, T0 + 21 * MIN)],
      finish: [ok({ ok: true, runId: "run-parent" }, T0 + 21 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    // The event woke the one wait chunk; the recover pr-check carried the run,
    // and the recovered pull request took the unit on to review and the merge.
    expect(summary.units).toEqual({ U10: "merged" });
    expect(s.taken.filter((t) => t.kind === "wait").map((t) => t.name)).toEqual([
      "U10/0/coding/wait/1",
      "U10/1/review/wait/1",
    ]);
    expect(b.of("pr-check")).toEqual([
      { parentInstanceId: INSTANCE, unit: "U10" },
      { parentInstanceId: INSTANCE, unit: "U10", recover: { runId: "run-c0" } },
    ]);
  });

  it("an interrupted coding child whose recover pr-check finds nothing pushed ends the unit interrupted — with the reason, never the budget clip", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0")],
      "read-record": [record({ id: "run-c0", finished: true, status: "interrupted" }, T0 + 5 * MIN)],
      "pr-check": [prNone(), prNone(T0 + 6 * MIN)],
      round: [acked(), acked()],
      "unit-end": [ok({ ok: true, told: true }, T0 + 6 * MIN)],
      finish: [ok({ ok: true, runId: "run-parent" }, T0 + 6 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "interrupted" });
    const [end] = b.of("unit-end") as Array<{ ending: { kind: string; report: string } }>;
    expect(end.ending.kind).toBe("interrupted");
    expect(end.ending.report).toContain("the pipeline stopped");
  });

  it("a failed coding child whose recover pr-check answers none with a reason carries that reason into the abort — the parse keeps `unrecovered`", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0")],
      "read-record": [record({ id: "run-c0", finished: true, status: "failed" }, T0 + 5 * MIN)],
      "pr-check": [prNone(), ok({ ok: true, state: "none", unrecovered: "no_base" }, T0 + 6 * MIN)],
      round: [acked(), acked()],
      "unit-end": [ok({ ok: true, told: true }, T0 + 6 * MIN)],
      finish: [ok({ ok: true, runId: "run-parent" }, T0 + 6 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "aborted" });
    const [end] = b.of("unit-end") as Array<{ ending: { kind: string; report: string } }>;
    expect(end.ending.kind).toBe("aborted");
    expect(end.ending.report).toContain("names no base branch");
  });

  it("the merge's pending wait: checks still running answer pending, the runner waits on the checks-settled event at the approved head under a bounded timeout and asks again under the next step name, and a merge GitHub refuses ends the unit merge_refused with the refusal in its report; a task string's ship branch is a person's merge — the machine ends merge-ready and never asks", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event", "U10/1/review/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0"), spawned("run-r1", T0 + 10 * MIN)],
      "read-record": [codingDone("run-c0", T0 + 10 * MIN), reviewApproved("run-r1", T0 + 20 * MIN)],
      "pr-check": [prNone(), prOpen(T0 + 10 * MIN)],
      round: [acked(), acked(), acked(), acked()],
      merge: [
        ok({ ok: true, outcome: "pending", reason: "2 check(s) still running" }, T0 + 21 * MIN),
        ok(
          { ok: true, outcome: "refused", reason: "GitHub refused the merge (HTTP 405): not mergeable" },
          T0 + 27 * MIN,
        ),
      ],
      "unit-end": [acked()],
      finish: [acked()],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "merge_refused" });
    expect(summary.outcome).toBe("failed");
    expect(s.names().slice(-5)).toEqual(["U10/merge/1", "U10/merge/wait/1", "U10/merge/2", "U10/end", "finish"]);
    // The wait is `waitForEvent` typed with the approved head — the intake's
    // event, not a poll — with one chunk (the old poll cadence) as the fallback
    // timeout, so an undelivered event never slows the door's re-ask.
    expect(s.taken.find((t) => t.name === "U10/merge/wait/1")).toEqual({
      kind: "wait",
      name: "U10/merge/wait/1",
      type: checksSettledEventType(HEAD),
      timeout: MERGE_WAIT_CHUNK_MS,
    });
    const [end] = b.of("unit-end") as Array<{ ending: { kind: string; report: string } }>;
    expect(end.ending.kind).toBe("merge_refused");
    expect(end.ending.report).toContain("GitHub refused the merge (HTTP 405): not mergeable");
    expect(end.ending.report).toContain("A person decides");

    // A task unit: the route answers the instance's field — `person` — so the merge is a person's.
    const t = steps({ "task/0/coding/wait/1": "event", "task/1/review/wait/1": "event" });
    const tb = bot({
      plan: [planAnswer([row("task", { slug: "task", branch: "ship/warm-the-cache-abc123" })], T0, "person")],
      "unit-start": [started("task")],
      branch: [ok({ ok: true, branch: "ship/warm-the-cache-abc123", base: "main" })],
      spawn: [spawned("run-c0"), spawned("run-r1", T0 + 10 * MIN)],
      "read-record": [codingDone("run-c0", T0 + 10 * MIN), reviewApproved("run-r1", T0 + 20 * MIN)],
      "pr-check": [prNone(), prOpen(T0 + 10 * MIN)],
      round: [acked(), acked(), acked(), acked()],
      "unit-end": [acked()],
      finish: [acked()],
    });
    const task = await runPlan(t.runner, tb.client, INSTANCE);
    expect(task.units).toEqual({ task: "merge_ready" });
    expect(task.outcome).toBe("completed");
    expect(tb.of("merge")).toEqual([]);
    expect(t.names().filter((n) => n.includes("merge"))).toEqual([]);
  });

  it("the plan answer's `generated` mark reaches the machine: a generated unit's ending is re-issued with the request's text, a plan answer without the mark is a seeded plan re-issued by its plan", async () => {
    const script = (generated: boolean | undefined) => {
      const units = [row("U10", { slug: "u10", branch: "plan/warm-the-cache-abc123/u10" })];
      const base = {
        ok: true,
        planId: "warm-the-cache-abc123",
        merge: "person",
        repo: "acme/api",
        base: "main",
        caps: { maxRounds: 2, maxMinutes: 120 },
        units,
      };
      return bot({
        plan: [ok(generated === undefined ? base : { ...base, generated })],
        "unit-start": [started("U10")],
        branch: [ok({ ok: true, branch: "plan/warm-the-cache-abc123/u10", base: "main" })],
        spawn: [spawned("run-c0"), spawned("run-r1", T0 + 10 * MIN)],
        "read-record": [
          codingDone("run-c0", T0 + 10 * MIN),
          record(
            {
              id: "run-r1",
              finished: true,
              status: "completed",
              verdict: { verdict: "approve", summary: "x", findings: [] },
              reviewPosted: false,
              reviewHead: HEAD,
            },
            T0 + 20 * MIN,
          ),
        ],
        "pr-check": [prNone(), prOpen(T0 + 10 * MIN)],
        round: [acked(), acked(), acked(), acked()],
        "unit-end": [acked()],
        finish: [acked()],
      });
    };
    const waits = { "U10/0/coding/wait/1": "event", "U10/1/review/wait/1": "event" } as const;
    const report = async (generated: boolean | undefined) => {
      const b = script(generated);
      expect((await runPlan(steps(waits).runner, b.client, INSTANCE)).units).toEqual({ U10: "aborted" });
      const [end] = b.of("unit-end") as Array<{ ending: { report: string } }>;
      return end!.ending.report;
    };
    expect(await report(true)).toContain("re-issue `agent:ship` in this thread with the same text");
    expect(await report(undefined)).toContain("the unit runs again when the plan is re-issued");
  });

  it("the instance's field decides, never the branch's name: a plan branch whose route answers merge: person ends merge_ready with no merge step asked, and a plan answer without the field is a person's merge the same way", async () => {
    const script = (merge?: "runner" | "person") => {
      const units = [row("U10")];
      const plan =
        merge === undefined
          ? ok({
              ok: true,
              planId: "fixture",
              repo: "acme/api",
              base: "main",
              caps: { maxRounds: 2, maxMinutes: 120 },
              units,
            })
          : planAnswer(units, T0, merge);
      return bot({
        plan: [plan],
        "unit-start": [started("U10")],
        branch: [branched("U10")],
        spawn: [spawned("run-c0"), spawned("run-r1", T0 + 10 * MIN)],
        "read-record": [codingDone("run-c0", T0 + 10 * MIN), reviewApproved("run-r1", T0 + 20 * MIN)],
        "pr-check": [prNone(), prOpen(T0 + 10 * MIN)],
        round: [acked(), acked(), acked(), acked()],
        "unit-end": [acked()],
        finish: [acked()],
      });
    };
    const waits = { "U10/0/coding/wait/1": "event", "U10/1/review/wait/1": "event" } as const;
    const person = script("person");
    const p = steps(waits);
    expect((await runPlan(p.runner, person.client, INSTANCE)).units).toEqual({ U10: "merge_ready" });
    expect(person.of("merge")).toEqual([]);
    expect(p.names().filter((n) => n.includes("merge"))).toEqual([]);
    // A plan answer without the field — a record written before it existed — is a person's merge.
    const absent = script(undefined);
    const a = steps(waits);
    expect((await runPlan(a.runner, absent.client, INSTANCE)).units).toEqual({ U10: "merge_ready" });
    expect(absent.of("merge")).toEqual([]);
  });

  it("a lost event costs one chunk, not the budget: a wait that times out is confirmed by read-record like an event, a live child is waited on again under the next step name, a finished one advances; a spawn answered busy naming the run holding the thread waits on that run, one without a run id sleeps the busy retry", async () => {
    const s = steps({ "U10/0/coding/wait/2": "event", "U10/0/coding/busy/2": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [
        ok({ ok: false, error: "busy" }, T0, 409),
        ok({ ok: false, error: "busy", runId: "run-other", agent: "coding" }, T0 + MIN, 409),
        spawned("run-c0", T0 + 2 * MIN),
        // The review child: its spawn is refused by the requester's grant, which ends the unit.
        ok({ ok: false, error: "agent_allowlist", message: "review is not allowed here" }, T0 + 12 * MIN, 403),
      ],
      "read-record": [
        record({ id: "run-c0", finished: false, status: "running" }, T0 + 5 * MIN),
        codingDone("run-c0", T0 + 10 * MIN),
      ],
      "pr-check": [prNone(), prOpen(T0 + 11 * MIN)],
      round: [acked(), acked()],
      "unit-end": [ok({ ok: true, told: true }, T0 + 12 * MIN)],
      finish: [ok({ ok: true }, T0 + 12 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "refused" });
    expect(summary.outcome).toBe("failed");
    expect(s.names()).toEqual([
      "plan",
      "U10/start",
      "U10/pr-check",
      "U10/branch",
      "U10/0/coding",
      "U10/0/coding/busy/1",
      "U10/0/coding",
      "U10/0/coding/busy/2",
      "U10/0/coding",
      "U10/note/1",
      "U10/0/coding/wait/1",
      "U10/0/coding/read/1",
      "U10/0/coding/wait/2",
      "U10/0/coding/read/2",
      "U10/0/coding/pr-check",
      "U10/note/2",
      "U10/1/review",
      "U10/end",
      "finish",
    ]);
    expect(s.taken.find((t) => t.name === "U10/0/coding/busy/1")).toEqual({
      kind: "sleep",
      name: "U10/0/coding/busy/1",
      ms: 2 * MIN,
    });
    expect(s.taken.find((t) => t.name === "U10/0/coding/busy/2")).toMatchObject({
      kind: "wait",
      type: "run-finished-run-other",
    });
    // The wait the engine never answered was one chunk — the read-record after it is what found the child finished.
    expect(s.taken.filter((t) => t.kind === "wait" && t.name.startsWith("U10/0/coding/wait/"))).toEqual([
      { kind: "wait", name: "U10/0/coding/wait/1", type: "run-finished-run-c0", timeout: WAIT_CHUNK_MS },
      { kind: "wait", name: "U10/0/coding/wait/2", type: "run-finished-run-c0", timeout: WAIT_CHUNK_MS },
    ]);
    const [end] = b.of("unit-end") as Array<{ ending: { kind: string; report: string } }>;
    expect(end.ending.kind).toBe("refused");
    expect(end.ending.report).toContain("agent_allowlist");
    expect(b.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "failed" }]);
  });

  it("a review that requests changes is followed by the findings step under `<unit>/<round>/findings`: a coding spawn briefed with the review run, its wait and read under that name, its pr-check, then the re-review briefed with the review run and the coding run that answered it; one unit-start per unit, and never a `fix` step", async () => {
    const s = steps({
      "U10/0/coding/wait/1": "event",
      "U10/1/review/wait/1": "event",
      "U10/1/findings/wait/1": "event",
      "U10/2/review/wait/1": "event",
    });
    const reviewChanged = (runId: string, at: number) =>
      record(
        {
          id: runId,
          finished: true,
          status: "completed",
          verdict: {
            verdict: "request_changes",
            summary: "one nit",
            findings: [{ id: "F1", severity: "minor", file: "src/a.ts", line: 3, title: "off by one" }],
          },
          reviewPosted: true,
          reviewHead: HEAD,
        },
        at,
      );
    const HEAD_2 = "b".repeat(40);
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [
        spawned("run-c0"),
        spawned("run-r1", T0 + 10 * MIN),
        spawned("run-f1", T0 + 20 * MIN),
        spawned("run-r2", T0 + 30 * MIN),
      ],
      "read-record": [
        codingDone("run-c0", T0 + 10 * MIN),
        reviewChanged("run-r1", T0 + 20 * MIN),
        record(
          {
            id: "run-f1",
            finished: true,
            status: "completed",
            headSha: HEAD_2,
            dispositions: [{ findingId: "F1", disposition: "fixed", note: "counted from zero" }],
          },
          T0 + 30 * MIN,
        ),
        record(
          {
            id: "run-r2",
            finished: true,
            status: "completed",
            verdict: { verdict: "approve", summary: "clean", findings: [] },
            reviewPosted: true,
            reviewHead: HEAD_2,
          },
          T0 + 40 * MIN,
        ),
      ],
      "pr-check": [
        prNone(),
        prOpen(T0 + 10 * MIN),
        ok({ ok: true, state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_2 }, T0 + 30 * MIN),
      ],
      round: [acked(), acked(), acked(), acked(), acked(), acked(), acked(), acked()],
      merge: [ok({ ok: true, outcome: "merged", sha: MERGED }, T0 + 41 * MIN)],
      "unit-end": [acked(T0 + 41 * MIN)],
      finish: [acked(T0 + 41 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "merged" });
    expect(s.names()).toEqual([
      "plan",
      "U10/start",
      "U10/pr-check",
      "U10/branch",
      "U10/0/coding",
      "U10/note/1",
      "U10/0/coding/wait/1",
      "U10/0/coding/read/1",
      "U10/0/coding/pr-check",
      "U10/note/2",
      "U10/1/review",
      "U10/note/3",
      "U10/1/review/wait/1",
      "U10/1/review/read/1",
      "U10/note/4",
      "U10/1/findings",
      "U10/note/5",
      "U10/1/findings/wait/1",
      "U10/1/findings/read/1",
      "U10/1/findings/pr-check",
      "U10/note/6",
      "U10/2/review",
      "U10/note/7",
      "U10/2/review/wait/1",
      "U10/2/review/read/1",
      "U10/note/8",
      "U10/merge/1",
      "U10/end",
      "finish",
    ]);
    expect(s.names().some((n) => /\/fix\b/.test(n))).toBe(false);
    expect(b.of("unit-start")).toEqual([{ parentInstanceId: INSTANCE, unit: "U10" }]);
    // The budgets are the presets' own clipped to the plan's 45-minute wall clock:
    // 25 left at the findings step (T0 + 20) minus the fix reserve (the re-review
    // and the merge poll, 8 min — never the round-0 child's 11), 15 at the
    // re-review (T0 + 30).
    expect(b.of("spawn")[2]).toEqual({
      parentInstanceId: INSTANCE,
      unit: "U10",
      step: "U10/1/findings",
      preset: "coding",
      budget: 45,
      brief: { kind: "findings", unit: "U10", pr: 7, reviewRunId: "run-r1" },
    });
    expect(b.of("spawn")[3]).toEqual({
      parentInstanceId: INSTANCE,
      unit: "U10",
      step: "U10/2/review",
      preset: "review",
      budget: 25,
      brief: {
        kind: "review",
        unit: "U10",
        pr: 7,
        headSha: HEAD_2,
        round: 2,
        prior: { reviewRunId: "run-r1", codingRunId: "run-f1" },
      },
    });
    expect(b.of("round").map((r) => `${r.index} ${r.agent} ${r.outcome}`)).toEqual([
      "0 coding started",
      "0 coding pr_opened",
      "1 review started",
      "1 review request_changes",
      "1 coding started",
      "1 coding pr_opened",
      "2 review started",
      "2 review approve",
    ]);
    const [end] = b.of("unit-end") as Array<{ codingRunId?: string; ending: { kind: string } }>;
    expect(end.codingRunId).toBe("run-f1");
    expect(end.ending.kind).toBe("merged");
  });

  it("units run in the plan's order, one at a time; a merged unit frees its dependents, which start with the rebase onto the base that now carries it; a unit whose merge GitHub refused blocks its dependents, each told so as its own ending without a thread, and the plan finishes failed; a unit whose branch could not be created ends aborted and blocks its dependents the same way; a unit blocked by a blocked unit the plan lists after it is told so, never an ending that is not there", async () => {
    const s = steps({
      "U10/0/coding/wait/1": "event",
      "U10/1/review/wait/1": "event",
      "U11/0/coding/wait/1": "event",
      "U11/1/review/wait/1": "event",
    });
    const b = bot({
      plan: [
        planAnswer([
          row("U10"),
          row("U20"),
          // U22 waits on U21, which the plan lists AFTER it and which U20's failure blocks.
          row("U22", { dependsOn: ["U21"] }),
          row("U11", { dependsOn: ["U10"] }),
          row("U12", { dependsOn: ["U11"] }),
          row("U21", { dependsOn: ["U20"] }),
        ]),
      ],
      "unit-start": [started("U10"), started("U20"), started("U11")],
      branch: [
        branched("U10"),
        ok({ ok: false, reason: "HTTP 422 reference already exists" }, T0 + 30 * MIN),
        branched("U11"),
      ],
      spawn: [
        spawned("run-c0"),
        spawned("run-r1", T0 + 10 * MIN),
        spawned("run-c1", T0 + 31 * MIN),
        spawned("run-r2", T0 + 35 * MIN),
      ],
      "read-record": [
        codingDone("run-c0", T0 + 10 * MIN),
        reviewApproved("run-r1", T0 + 20 * MIN),
        codingDone("run-c1", T0 + 35 * MIN),
        reviewApproved("run-r2", T0 + 40 * MIN),
      ],
      // U10's pre-check and round 0; U20's pre-check (its branch then fails); U11's pre-check and round 0.
      "pr-check": [prNone(), prOpen(T0 + 10 * MIN), prNone(), prNone(), prOpen(T0 + 35 * MIN)],
      round: [acked(), acked(), acked(), acked(), acked(), acked(), acked(), acked()],
      merge: [
        ok({ ok: true, outcome: "merged", sha: MERGED }, T0 + 21 * MIN),
        ok(
          { ok: true, outcome: "refused", reason: "GitHub refused the merge (HTTP 405): not mergeable" },
          T0 + 41 * MIN,
        ),
      ],
      "unit-end": [acked(), acked(), acked(), acked(), acked(), acked()],
      finish: [acked()],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({
      U10: "merged",
      U20: "aborted",
      U11: "merge_refused",
      U22: "blocked",
      U12: "blocked",
      U21: "blocked",
    });
    expect(summary.outcome).toBe("failed");
    expect(s.names().filter((n) => n.endsWith("/start"))).toEqual(["U10/start", "U20/start", "U11/start"]);
    // The dependent's coding child is briefed with the rebase onto the base — which carries the merged unit.
    expect(b.of("spawn")[2]).toMatchObject({
      unit: "U11",
      brief: { kind: "contract", unit: "U11", rebase: { branch: "plan/fixture/u11", onto: "main" } },
    });
    const ends = b.of("unit-end") as Array<{ unit: string; ending: { kind: string; report: string } }>;
    expect(ends.map((e) => [e.unit, e.ending.kind])).toEqual([
      ["U10", "merged"],
      ["U20", "aborted"],
      ["U11", "merge_refused"],
      ["U22", "blocked"],
      ["U12", "blocked"],
      ["U21", "blocked"],
    ]);
    expect(ends[1]!.ending.report).toContain("Could not create the pipeline branch `plan/fixture/u20`");
    expect(ends[3]!.ending.report).toBe(
      "⛔ Blocked: U22 waits on U21, which is blocked itself. Re-issue the plan naming the remaining units once it is resolved.",
    );
    expect(ends[4]!.ending.report).toBe(
      "⛔ Blocked: U12 waits on U11, which ended merge_refused. Re-issue the plan naming the remaining units once it is resolved.",
    );
    expect(ends[5]!.ending.report).toContain("waits on U20, which ended aborted");
    for (const e of ends) expect(e.ending.report).not.toContain("undefined");
    expect(b.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "failed" }]);
  });

  it("the bot's transport is the platform's to retry: a call that throws is asked again under the step's policy and the driver never catches it; past the policy the failure ends the instance after the finish is asked as failed, best effort", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event" });
    const b = bot({
      plan: [new Error("connection reset"), new Error("connection reset"), planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      "pr-check": [prNone()],
      branch: [branched("U10")],
      spawn: Array.from({ length: 13 }, () => new Error("the bot is deploying")),
      finish: [acked()],
    });
    await expect(runPlan(s.runner, b.client, INSTANCE)).rejects.toThrow("the bot is deploying");
    expect(s.attempts.plan).toBe(3);
    expect(s.attempts["U10/0/coding"]).toBe(13);
    expect(b.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "failed" }]);
    // The finish's own failure never hides the cause.
    const silent = bot({
      plan: Array.from({ length: 13 }, () => new Error("gone")),
      finish: Array.from({ length: 13 }, () => new Error("still gone")),
    });
    const s2 = steps();
    await expect(runPlan(s2.runner, silent.client, INSTANCE)).rejects.toThrow("gone");
    expect(silent.of("finish")).toHaveLength(13);
  });

  it("a plan answer the runner cannot read — no units array, a row that is not a unit row, missing caps — fails the instance at once, before any unit starts", async () => {
    for (const body of [
      {
        ok: true,
        repo: "acme/api",
        base: "main",
        caps: { maxRounds: 2, maxMinutes: 120 },
      },
      {
        ok: true,
        repo: "acme/api",
        base: "main",
        caps: { maxRounds: 2, maxMinutes: 120 },
        units: [{ unit: "U10" }],
      },
      { ok: true, repo: "acme/api", base: "main", units: [row("U10")] },
      { ok: false, error: "unknown_instance" },
    ]) {
      const s = steps();
      const b = bot({ plan: [ok(body)], finish: [acked()] });
      await expect(runPlan(s.runner, b.client, INSTANCE), JSON.stringify(body)).rejects.toThrow(/plan/);
      expect(s.attempts.plan).toBe(1);
      expect(b.of("unit-start")).toEqual([]);
    }
  });

  it("readBotAnswer: a JSON object stamped with the bot's clock is an answer at any status; non-JSON, a non-object and a body without the stamp are not — the door's refusals and the shim's own errors look like that", () => {
    expect(readBotAnswer(200, JSON.stringify({ ok: true, runId: "r", at: T0 }))).toEqual({
      ok: true,
      answer: { status: 200, body: { ok: true, runId: "r", at: T0 } },
    });
    expect(readBotAnswer(403, JSON.stringify({ ok: false, error: "agent_allowlist", at: T0 }))).toMatchObject({
      ok: true,
    });
    expect(readBotAnswer(403, JSON.stringify({ ok: false, error: "forbidden: identity holds no grant" }))).toEqual({
      ok: false,
      reason: "HTTP 403 — forbidden: identity holds no grant",
    });
    expect(readBotAnswer(502, "<html>bad gateway</html>")).toEqual({
      ok: false,
      reason: "HTTP 502 — <html>bad gateway</html>",
    });
    expect(readBotAnswer(200, "[1,2]")).toEqual({ ok: false, reason: "HTTP 200 — [1,2]" });
    expect(readBotAnswer(500, "x".repeat(400))).toEqual({ ok: false, reason: `HTTP 500 — ${"x".repeat(200)}…` });
  });

  it("transientRefusal: the answers the bot itself calls a passing condition — GitHub unavailable, no channel to rebuild the thread on, a unit not yet started — are a reason to retry the step; every other answer, refusals included, is the machine's to judge", () => {
    expect(transientRefusal(answer({ ok: false, error: "github_unavailable", message: "HTTP 502" }, T0, 502))).toBe(
      "the bot answered github_unavailable: HTTP 502",
    );
    expect(transientRefusal(answer({ ok: false, error: "no_channel" }, T0, 503))).toBe("the bot answered no_channel");
    expect(transientRefusal(answer({ ok: false, error: "thread_failed", message: "no ts" }, T0, 502))).toContain(
      "thread_failed",
    );
    expect(transientRefusal(answer({ ok: false, error: "unit_not_started" }, T0, 409))).toContain("unit_not_started");
    expect(transientRefusal(answer({ ok: false, error: "busy" }, T0, 409))).toBeUndefined();
    expect(transientRefusal(answer({ ok: false, error: "agent_allowlist" }, T0, 403))).toBeUndefined();
    expect(transientRefusal(answer({ ok: false, error: "spawn_failed", message: "x" }, T0, 502))).toBeUndefined();
    expect(transientRefusal(answer({ ok: false, reason: "HTTP 422" }))).toBeUndefined();
    expect(transientRefusal(answer({ ok: true, state: "none" }))).toBeUndefined();
  });
});

describe("the plan runner's driver — a shipped pull request at the wall-clock cap (review pending)", () => {
  it("the cap after the coding child shipped ends the unit review_pending: the unit-end names the pull request and the child's own last push (headSha) so the re-issue's row can carry it, and the report says review pending with the budget split", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event" });
    const b = bot({
      plan: [
        ok({
          ok: true,
          planId: "fixture",
          merge: "person",
          repo: "acme/api",
          base: "main",
          caps: { maxRounds: 2, maxMinutes: 120 },
          units: [row("U10")],
        }),
      ],
      "unit-start": [ok({ ok: true, threadKey: "slack:C1:1.0" })],
      branch: [ok({ ok: true })],
      spawn: [spawned("run-c0")],
      "read-record": [codingDone("run-c0", T0 + 85 * MIN)],
      // The pre-check, then the round's check: the pull request is open at the child's head with 35 minutes
      // left — the review holds 31 for the fix, the re-review and the merge, so it falls under its floor of 5.
      "pr-check": [prNone(), prOpen(T0 + 85 * MIN)],
      round: [acked(), acked()],
      "unit-end": [acked()],
      finish: [acked()],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "review_pending" });
    // The coding child's directive is its carve: 120 minus the 39 held for two reviews, a fix and the merge leaves room for its whole 45.
    expect(b.of("spawn")[0]).toMatchObject({ step: "U10/0/coding", preset: "coding", budget: 45 });
    const [end] = b.of("unit-end") as Array<{
      ending: { kind: string; report: string };
      pr: unknown;
      headSha?: string;
    }>;
    expect(end.ending.kind).toBe("review_pending");
    expect(end.pr).toEqual({ number: 7, url: PR_URL });
    expect(end.headSha).toBe(HEAD);
    expect(end.ending.report).toContain("⏳ Review pending");
    expect(end.ending.report).toContain("Budget split (120 min):");
  });

  it("a unit row carrying lastPush starts the attempt at the review round when the pre-check finds the open pull request still at that head: no branch and no coding child run again on the shipped pull request", async () => {
    const s = steps({ "U10/1/review/wait/1": "event" });
    const b = bot({
      plan: [
        ok({
          ok: true,
          planId: "fixture",
          merge: "person",
          repo: "acme/api",
          base: "main",
          caps: { maxRounds: 2, maxMinutes: 120 },
          units: [row("U10", { lastPush: HEAD })],
        }),
      ],
      "unit-start": [ok({ ok: true, threadKey: "slack:C1:1.0" })],
      spawn: [spawned("run-r1")],
      "read-record": [reviewApproved("run-r1", T0 + 5 * MIN)],
      // The pre-check finds the pull request open at exactly the child's last
      // push, then the merge_ready ending reads the facts at the approved head.
      "pr-check": [prOpen(), prOpen(T0 + 5 * MIN)],
      round: [acked(), acked()],
      "unit-end": [acked()],
      finish: [acked()],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "merge_ready" });
    expect(b.of("branch")).toEqual([]);
    expect(b.of("spawn")).toEqual([
      {
        parentInstanceId: INSTANCE,
        unit: "U10",
        step: "U10/1/review",
        preset: "review",
        budget: 25,
        brief: { kind: "review", unit: "U10", pr: 7, headSha: HEAD, round: 1 },
      },
    ]);
  });
});

describe("the plan runner's driver — a resume at review (agent-ship item 10)", () => {
  it("a task row carrying a resume opens the unit at its first review round: no pr-check, no branch, no coding child; the review child is briefed with the pull request and the head, the approve on a ship branch ends merge-ready for a person, and the ending names no coding run", async () => {
    const s = steps({ "task/1/review/wait/1": "event" });
    const b = bot({
      plan: [
        ok({
          ok: true,
          repo: "acme/api",
          base: "main",
          caps: { maxRounds: 2, maxMinutes: 120 },
          units: [
            row("task", {
              slug: "task",
              branch: "ship/fix-the-login-abc123",
              resume: { pr: 7, headSha: HEAD, url: PR_URL },
            }),
          ],
        }),
      ],
      "unit-start": [ok({ ok: true, threadKey: "slack:C1:1.0", branch: "ship/fix-the-login-abc123", base: "main" })],
      spawn: [spawned("run-r1")],
      "read-record": [reviewApproved("run-r1", T0 + 5 * MIN)],
      // The merge_ready ending reads the facts once more AT THE APPROVED HEAD
      // (agent-ship item 9): auto-merge was off at entry and is on now.
      "pr-check": [prOpen(T0 + 5 * MIN, { autoMergeEnabled: true })],
      round: [acked(), acked()],
      "unit-end": [ok({ ok: true, told: true }, T0 + 5 * MIN)],
      finish: [ok({ ok: true, runId: "run-parent" }, T0 + 5 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, "ship-run-s");
    expect(summary).toEqual({ instance: "ship-run-s", units: { task: "merge_ready" }, outcome: "completed" });
    expect(s.names()).toEqual([
      "plan",
      "task/start",
      "task/1/review",
      "task/note/1",
      "task/1/review/wait/1",
      "task/1/review/read/1",
      "task/note/2",
      "task/end/pr-facts",
      "task/end",
      "finish",
    ]);
    // The one pr-check is the ending's facts read at the approved head — no
    // pre-check ran (the resume path skips it).
    expect(b.of("pr-check")).toEqual([{ parentInstanceId: "ship-run-s", unit: "task" }]);
    expect(b.of("branch")).toEqual([]);
    expect(b.of("spawn")).toEqual([
      {
        parentInstanceId: "ship-run-s",
        unit: "task",
        step: "task/1/review",
        preset: "review",
        budget: 25,
        brief: { kind: "review", unit: "task", pr: 7, headSha: HEAD, round: 1 },
      },
    ]);
    const [end] = b.of("unit-end") as Array<{
      ending: { kind: string; report: string };
      pr: unknown;
      codingRunId?: string;
    }>;
    expect(end.ending.kind).toBe("merge_ready");
    expect(end.ending.report).toContain(`✅ Merge-ready after 1 review round: ${PR_URL}`);
    expect(end.ending.report).toContain(
      "Auto-merge is on for this pull request: the approval merges it once checks pass.",
    );
    expect(end.ending.report).not.toContain("Remaining gate");
    expect(end.pr).toEqual({ number: 7, url: PR_URL });
    expect(end.codingRunId).toBeUndefined();
  });

  it("the ending's facts read can find the pull request already merged — auto-merge fired, or a person merged, between the approval and the ending: the unit still ends merge_ready (the machine's ending stands) and the report names the merge by commit and time instead of a gate that has passed", async () => {
    const s = steps({ "task/1/review/wait/1": "event" });
    const b = bot({
      plan: [
        ok({
          ok: true,
          repo: "acme/api",
          base: "main",
          caps: { maxRounds: 2, maxMinutes: 120 },
          units: [
            row("task", {
              slug: "task",
              branch: "ship/fix-the-login-abc123",
              resume: { pr: 7, headSha: HEAD, url: PR_URL },
            }),
          ],
        }),
      ],
      "unit-start": [ok({ ok: true, threadKey: "slack:C1:1.0", branch: "ship/fix-the-login-abc123", base: "main" })],
      spawn: [spawned("run-r1")],
      "read-record": [reviewApproved("run-r1", T0 + 5 * MIN)],
      "pr-check": [prMerged(T0 + 5 * MIN, "2026-09-16T00:46:19Z")],
      round: [acked(), acked()],
      "unit-end": [ok({ ok: true, told: true }, T0 + 5 * MIN)],
      finish: [ok({ ok: true, runId: "run-parent" }, T0 + 5 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, "ship-run-s");
    expect(summary).toEqual({ instance: "ship-run-s", units: { task: "merge_ready" }, outcome: "completed" });
    expect(s.names()).toContain("task/end/pr-facts");
    const [end] = b.of("unit-end") as Array<{ ending: { kind: string; report: string } }>;
    expect(end.ending.kind).toBe("merge_ready");
    expect(end.ending.report).toContain(`✅ Merge-ready after 1 review round: ${PR_URL}`);
    expect(end.ending.report).toContain(
      `Already merged: ${PR_URL} (merge commit \`${MERGED.slice(0, 7)}\`, merged 2026-09-16T00:46:19Z) — auto-merge or a person merged it after the approval; the runner merged nothing.`,
    );
    expect(end.ending.report).not.toContain("Remaining gate");
    expect(end.ending.report).not.toContain("Auto-merge is on");
  });
});

describe("the plan runner's driver — a unit whose pull request already merged (item 9)", () => {
  it("a unit merged before the attempt — a person's merge, or an earlier attempt's — ends merged at its start: the pr-check under `<unit>/pr-check` answers merged, no branch is created and no child spawned, the ending is told with the pull request and says it was already merged and when, its dependent starts and the plan completes", async () => {
    const s = steps({ "U11/0/coding/wait/1": "event", "U11/1/review/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10"), row("U11", { dependsOn: ["U10"] })])],
      "unit-start": [started("U10"), started("U11", T0 + MIN)],
      "pr-check": [prMerged(T0, "2026-09-13T23:55:59Z"), prNone(T0 + MIN), prOpen(T0 + 10 * MIN)],
      branch: [branched("U11", T0 + MIN)],
      spawn: [spawned("run-c1", T0 + MIN), spawned("run-r1", T0 + 10 * MIN)],
      "read-record": [codingDone("run-c1", T0 + 10 * MIN), reviewApproved("run-r1", T0 + 20 * MIN)],
      round: [acked(), acked(), acked(), acked()],
      merge: [ok({ ok: true, outcome: "merged", sha: MERGED }, T0 + 21 * MIN)],
      "unit-end": [acked(), acked()],
      finish: [acked()],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary).toEqual({
      instance: INSTANCE,
      planId: "fixture",
      units: { U10: "merged", U11: "merged" },
      outcome: "completed",
    });
    expect(s.names().slice(0, 7)).toEqual([
      "plan",
      "U10/start",
      "U10/pr-check",
      "U10/end",
      "U11/start",
      "U11/pr-check",
      "U11/branch",
    ]);
    expect(s.names()).not.toContain("U10/branch");
    expect(b.of("branch")).toEqual([{ parentInstanceId: INSTANCE, unit: "U11" }]);
    expect(b.of("spawn").map((c) => c.unit)).toEqual(["U11", "U11"]);
    expect(b.of("pr-check")).toEqual([
      { parentInstanceId: INSTANCE, unit: "U10" },
      { parentInstanceId: INSTANCE, unit: "U11" },
      { parentInstanceId: INSTANCE, unit: "U11" },
    ]);
    // No round boundary is drawn for a unit that ran nothing.
    expect(b.of("round").every((r) => r.unit === "U11")).toBe(true);
    const ends = b.of("unit-end") as Array<{ unit: string; ending: { kind: string; report: string }; pr: unknown }>;
    expect(ends[0]).toMatchObject({ unit: "U10", pr: { number: 7, url: PR_URL } });
    expect(ends[0]!.ending.kind).toBe("merged");
    expect(ends[0]!.ending.report).toContain(`✅ Already merged: ${PR_URL} (merge commit \`${MERGED.slice(0, 7)}\``);
    expect(ends[0]!.ending.report).toContain("merged 2026-09-13T23:55:59Z");
    expect(ends[0]!.ending.report).not.toContain("plan:merge");
    expect(ends[1]!.ending.kind).toBe("merged");
    expect(ends[1]!.ending.report).toContain("plan:merge");
    expect(b.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "completed" }]);
  });

  it("a merge that lands during round 0 — the coding child finds nothing to ship and the round's pr-check answers merged — ends the unit merged with round 0 noted completed and no review child; a merged answer without its merge commit is one the runner cannot read and fails the instance at once", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      "pr-check": [prNone(), prMerged(T0 + 10 * MIN)],
      branch: [branched("U10")],
      spawn: [spawned("run-c0")],
      "read-record": [
        record(
          {
            id: "run-c0",
            finished: true,
            status: "completed",
            finalReply: "Unit U10 is already done — nothing to ship this run.",
            handoff: true,
          },
          T0 + 10 * MIN,
        ),
      ],
      round: [acked(), acked()],
      "unit-end": [acked()],
      finish: [acked()],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "merged" });
    expect(summary.outcome).toBe("completed");
    expect(s.names()).toEqual([
      "plan",
      "U10/start",
      "U10/pr-check",
      "U10/branch",
      "U10/0/coding",
      "U10/note/1",
      "U10/0/coding/wait/1",
      "U10/0/coding/read/1",
      "U10/0/coding/pr-check",
      "U10/note/2",
      "U10/end",
      "finish",
    ]);
    expect(b.of("round")).toEqual([
      { parentInstanceId: INSTANCE, unit: "U10", index: 0, agent: "coding", outcome: "started" },
      { parentInstanceId: INSTANCE, unit: "U10", index: 0, agent: "coding", outcome: "completed" },
    ]);
    expect(b.of("spawn")).toHaveLength(1);
    const [end] = b.of("unit-end") as Array<{ ending: { kind: string; report: string }; pr: unknown }>;
    expect(end.pr).toEqual({ number: 7, url: PR_URL });
    expect(end.ending.kind).toBe("merged");
    expect(end.ending.report).toContain("✅ Already merged");

    const bad = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      "pr-check": [ok({ ok: true, state: "merged", prNumber: 7, url: PR_URL })],
      finish: [acked()],
    });
    const s2 = steps();
    await expect(runPlan(s2.runner, bad.client, INSTANCE)).rejects.toThrow(/pr-check answer could not be read/);
    expect(s2.attempts["U10/pr-check"]).toBe(1);
    expect(bad.of("branch")).toEqual([]);
    expect(bad.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "failed" }]);
  });
});
