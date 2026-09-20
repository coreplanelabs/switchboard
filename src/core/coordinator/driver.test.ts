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
      caps: { maxRounds: 2, maxMinutes: 240 },
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
  // The step sequence most tests read: every run-finished wait rides with its
  // two deploy-roll companions (`…/interrupted`, `…/resumed[/n]`, item 47a) —
  // asserted by their own tests below and elided here so the machine's own
  // step order stays legible.
  const names = () =>
    taken.filter((t) => !/\/(wait|busy)\/\d+\/(interrupted|resumed)(\/\d+)?$/.test(t.name)).map((t) => t.name);
  return { runner, taken, attempts, names };
}

type Scripted = BotReply | Error | ((body: Record<string, unknown>) => BotReply | Error);

/** A bot that answers each route from its queue, in order, and remembers every call. */
function bot(script: Partial<Record<CoordinatorStepRoute, Scripted[]>>) {
  const calls: Array<{ route: CoordinatorStepRoute; body: Record<string, unknown> }> = [];
  const queues: Partial<Record<CoordinatorStepRoute, Scripted[]>> = Object.fromEntries(
    Object.entries(script).map(([k, v]) => [k, [...(v ?? [])]]),
  );
  let lastPlan: BotReply | undefined;
  const client: CoordinatorBot = {
    async step(route, body) {
      calls.push({ route, body });
      const next = queues[route]?.shift();
      // The round's checks step (record 0055) answers green unless a test
      // scripts it: most scripts here are about the loop around it, and a
      // green head adds no wait — the red, pending and flake paths are the
      // machine's own (src/core/ship/coordinator.test.ts).
      if (next === undefined && route === "checks" && queues.checks === undefined)
        return ok({ ok: true, checks: { total: 2, pending: [], failed: [] } }, T0 + 20 * MIN);
      // The walk re-reads its selection at every unit boundary (the orchestration-plane plan): a test
      // that scripts one plan answer keeps its selection — the last answer is
      // replayed — and one probing the re-read scripts more.
      if (next === undefined && route === "plan" && lastPlan !== undefined) return lastPlan;
      if (next === undefined) throw new Error(`the test scripted no ${route} answer for ${JSON.stringify(body)}`);
      const answer = typeof next === "function" ? next(body) : next;
      if (answer instanceof Error) throw answer;
      if (route === "plan" && !(answer instanceof Error)) lastPlan = answer;
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
      "U10/1/review/checks/1",
      "U10/merge/1",
      "U10/end",
      "plan/2",
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
      {
        kind: "wait",
        name: "U10/0/coding/wait/1/interrupted",
        type: "child-interrupted-run-c0",
        timeout: WAIT_CHUNK_MS,
      },
      { kind: "wait", name: "U10/0/coding/wait/1/resumed", type: "child-resumed-run-c0", timeout: WAIT_CHUNK_MS },
      { kind: "wait", name: "U10/1/review/wait/1", type: "run-finished-run-r1", timeout: WAIT_CHUNK_MS },
      {
        kind: "wait",
        name: "U10/1/review/wait/1/interrupted",
        type: "child-interrupted-run-r1",
        timeout: WAIT_CHUNK_MS,
      },
      { kind: "wait", name: "U10/1/review/wait/1/resumed", type: "child-resumed-run-r1", timeout: WAIT_CHUNK_MS },
    ]);
    // What the bot was asked, in the machine's words — the plan twice: the
    // opening read and the unit boundary's re-read of the selection.
    expect(b.of("plan")).toEqual([{ parentInstanceId: INSTANCE }, { parentInstanceId: INSTANCE }]);
    expect(b.of("unit-start")).toEqual([{ parentInstanceId: INSTANCE, unit: "U10" }]);
    expect(b.of("branch")).toEqual([{ parentInstanceId: INSTANCE, unit: "U10" }]);
    expect(b.of("spawn")).toEqual([
      {
        parentInstanceId: INSTANCE,
        unit: "U10",
        step: "U10/0/coding",
        preset: "coding",
        // The coding preset's whole 90: the plan's 240-minute wall clock minus
        // the loop's reserve (two reviews, a fix and the merge, 44 min) holds it.
        budget: 90,
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
    // Twice: once before the branch (what already heads it), once after the
    // coding child — the second carrying the pull request the child's record
    // named, for the bot to follow when nothing heads the branch (issue 1799).
    expect(b.of("pr-check")).toEqual([
      { parentInstanceId: INSTANCE, unit: "U10", entry: true },
      { parentInstanceId: INSTANCE, unit: "U10", pr: 7 },
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
      "U10/s2/1/review/checks/1",
      "U10/s2/end/pr-facts",
      "U10/s2/end",
      "plan/2",
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
    expect(ends[0].ending.report).toContain(`budget renewed, 1 of 6, continues ${HEAD.slice(0, 7)}`);
    expect(ends[1].ending.kind).toBe("merge_ready");
    expect(ends[1].segment).toBeUndefined();
    expect(ends[1].ending.report).toContain("Renewals: 0 of 6 spent, cost cap $50 (granted by channel).");
  });

  // record 0051: nothing waits yet — the indexed wait and the wake land with
  // that plan's fifth unit — so an idle ending settles the walk as `failed`
  // here; this test is replaced there.
  it("an idle ending settles the unit failed in this unit: with the plan answering idleDays above zero, a segment's lease end maps to idle — the unit-end carries the why and the continuation facts, no segment row, no renewal — and the walk does not open a second segment", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event" });
    const lists = { deviations: [], followUps: [{ what: "tests", where: "src" }], unproven: [] };
    const b = bot({
      plan: [
        planAnswer([row("U10")], T0, "person", {
          grant: { renewals: 6, costCapUsd: 50 },
          grantSource: "channel",
          idleDays: 7,
        }),
      ],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0")],
      "read-record": [
        record(
          {
            id: "run-c0",
            finished: true,
            status: "completed",
            finalReply: "Budget reached: the parser is pushed, tests are next.",
            pushed: [{ ref: "plan/fixture/u10", sha: HEAD, at: T0 + 44 * MIN }],
            leaseStartedAt: T0,
            costUsd: 12.5,
            handoffLists: lists,
          },
          T0 + 45 * MIN,
        ),
      ],
      "pr-check": [prNone(), prNone(T0 + 45 * MIN)],
      round: [acked(), acked()],
      "unit-end": [ok({ ok: true, told: true }, T0 + 45 * MIN)],
      finish: [ok({ ok: true, runId: "run-parent" }, T0 + 45 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary).toEqual({ instance: INSTANCE, planId: "fixture", units: { U10: "idle" }, outcome: "failed" });
    // No second segment opened: the renewal is the wake's to spend, and nothing wakes yet.
    expect(s.names().some((n) => n.startsWith("U10/s2/"))).toBe(false);
    const [end] = b.of("unit-end") as Array<{
      ending: Record<string, unknown>;
      segment?: unknown;
      codingRunId?: string;
    }>;
    expect(end.ending).toMatchObject({
      kind: "idle",
      why: "continued",
      renewalsLeft: 6,
      from: HEAD,
      spendUsd: 12.5,
      handoff: lists,
    });
    expect(end.ending.report).toContain("🔁 The unit's budget ran out with the unit unfinished");
    // An idle ending writes no segment row: no renewal is spent.
    expect(end.segment).toBeUndefined();
    expect(end.codingRunId).toBe("run-c0");
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

  it("the ending carries two copies of the report (routing-and-config item 28): the full one for the row and the board, and the thread's at the plan answer's verbosity — quiet by default, which drops the level, grant and write-up asides", async () => {
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
      const [end] = b.of("unit-end") as Array<{ ending: { report: string; threadReport: string } }>;
      return end.ending;
    };
    const quiet = await run({});
    expect(quiet.report).toContain("Renewals: 0 of 0 spent (granted by org).");
    expect(quiet.report).toContain("Severity addressed:");
    expect(quiet.threadReport).toContain("✅ Merged after");
    expect(quiet.threadReport).not.toContain("Renewals:");
    expect(quiet.threadReport).not.toContain("Severity addressed");
    const verbose = await run({ verbosity: "verbose" });
    expect(verbose.threadReport).toBe(verbose.report);
    const loud = await run({ verbosity: "loud" });
    expect(loud.threadReport).not.toContain("Renewals:"); // an unknown word reads as the default, quiet
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
    expect(end.ending.report).toContain("the pipeline merged nothing");
  });

  it("a merge door answering enqueued keeps the unit live — the boundary rides the round route, every later ask carries `queued: true`, and the queue's merge ends the unit merged (issue 2011)", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event", "U10/1/review/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0"), spawned("run-r1", T0 + 10 * MIN)],
      "read-record": [codingDone("run-c0", T0 + 10 * MIN), reviewApproved("run-r1", T0 + 20 * MIN)],
      "pr-check": [prNone(), prOpen(T0 + 10 * MIN)],
      round: [acked(), acked(), acked(), acked(), acked()],
      merge: [
        ok({ ok: true, outcome: "enqueued", reason: "enqueued at the approved head" }, T0 + 21 * MIN),
        ok({ ok: true, outcome: "merged", by: "other", sha: MERGED, mergedAt: "2026-09-20T00:01:00Z" }, T0 + 27 * MIN),
      ],
      "unit-end": [acked()],
      finish: [acked()],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "merged" });
    expect(summary.outcome).toBe("completed");
    // The first ask is the squash's; from the enqueue on, the ask says `queued`
    // so the door reads the queue's outcome instead of squashing again.
    expect(b.of("merge")).toEqual([
      { parentInstanceId: INSTANCE, unit: "U10", prNumber: 7, headSha: HEAD },
      { parentInstanceId: INSTANCE, unit: "U10", prNumber: 7, headSha: HEAD, queued: true },
    ]);
    // The enqueue boundary is recorded on the unit through the round route.
    expect(b.of("round").map((r) => r.outcome)).toContain("enqueued");
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
      "U10/0/coding/wait/1/interrupted",
      "U10/0/coding/wait/1/resumed",
      "U10/1/review/wait/1",
      "U10/1/review/wait/1/interrupted",
      "U10/1/review/wait/1/resumed",
    ]);
    expect(b.of("pr-check")).toEqual([
      { parentInstanceId: INSTANCE, unit: "U10", entry: true },
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

  // Feature: docs/reference/specs/agent-ship.md item 9 (issue 1932) — the
  // transient re-run through the whole driver: the failure by name off the
  // record, the re-run under fresh step names, the `transient` round boundary
  // on the round route, and the re-run's success carrying the unit to merge.
  it("a coding child dead on a provider transient with nothing pushed re-runs round 0 once: the read-record carries `failure: provider_transient`, the re-run spawns under `/a2` step names, and its success carries the unit to merged", async () => {
    const s = steps({
      "U10/0/coding/wait/1": "event",
      "U10/0/coding/a2/wait/1": "event",
      "U10/1/review/wait/1": "event",
    });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0"), spawned("run-c1", T0 + 6 * MIN), spawned("run-r1", T0 + 15 * MIN)],
      "read-record": [
        record(
          { id: "run-c0", finished: true, status: "failed", failure: { kind: "provider_transient" } },
          T0 + 5 * MIN,
        ),
        codingDone("run-c1", T0 + 12 * MIN),
        reviewApproved("run-r1", T0 + 20 * MIN),
      ],
      "pr-check": [
        prNone(),
        ok({ ok: true, state: "none", unrecovered: "no_commits" }, T0 + 6 * MIN),
        prOpen(T0 + 12 * MIN),
      ],
      round: [acked(), acked(), acked(), acked(), acked(), acked()],
      merge: [ok({ ok: true, outcome: "merged", sha: MERGED }, T0 + 21 * MIN)],
      "unit-end": [ok({ ok: true, told: true }, T0 + 21 * MIN)],
      finish: [ok({ ok: true, runId: "run-parent" }, T0 + 21 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "merged" });
    // The dead attempt's recover pr-check named the dead run; the re-run's
    // steps ride fresh names so the Workflow's cache never replays attempt one.
    expect(s.names()).toContain("U10/0/coding/a2");
    expect(s.names()).toContain("U10/0/coding/a2/wait/1");
    // The round route heard the transient boundary and the re-run's start.
    const outcomes = (b.of("round") as Array<{ outcome: string }>).map((r) => r.outcome);
    expect(outcomes.slice(0, 3)).toEqual(["started", "transient", "started"]);
  });

  it("a deploy roll's child-interrupted event settles the wait beside run-finished (item 47a): the read-record confirms the interrupted child and the round ends at once with the child's own reason, never the budget clip", async () => {
    const s = steps({ "U10/0/coding/wait/1/interrupted": "event" });
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
    // One wait chunk: the interrupted companion settled it — no second chunk
    // was walked out, and the confirming read-record carried the reason.
    const waits = s.taken.filter((t) => t.kind === "wait").map((t) => t.name);
    expect(waits).toEqual(["U10/0/coding/wait/1", "U10/0/coding/wait/1/interrupted", "U10/0/coding/wait/1/resumed"]);
    const [end] = b.of("unit-end") as Array<{ ending: { kind: string; report: string } }>;
    expect(end.ending.kind).toBe("interrupted");
    expect(end.ending.report).toContain("the pipeline stopped");
  });

  it("a deploy roll's child-resumed event keeps the wait (item 47a): the signal is consumed, the next resumed wait is armed under the next durable name, and the chunk still ends as a timeout confirmed by read-record — a live child is waited on again, never a lost round", async () => {
    const s = steps({ "U10/0/coding/wait/1/resumed": "event", "U10/0/coding/wait/2": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0")],
      "read-record": [
        record({ finished: false }, T0 + 5 * MIN),
        record({ id: "run-c0", finished: true, status: "interrupted" }, T0 + 10 * MIN),
      ],
      "pr-check": [prNone(), prNone(T0 + 11 * MIN)],
      round: [acked(), acked()],
      "unit-end": [ok({ ok: true, told: true }, T0 + 11 * MIN)],
      finish: [ok({ ok: true, runId: "run-parent" }, T0 + 11 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "interrupted" });
    const waits = s.taken.filter((t) => t.kind === "wait").map((t) => t.name);
    // The resumed signal re-armed under `/resumed/2` and settled nothing: the
    // chunk timed out, the read-record found the child live, and the machine
    // waited the next chunk under the next step name.
    expect(waits).toEqual([
      "U10/0/coding/wait/1",
      "U10/0/coding/wait/1/interrupted",
      "U10/0/coding/wait/1/resumed",
      "U10/0/coding/wait/1/resumed/2",
      "U10/0/coding/wait/2",
      "U10/0/coding/wait/2/interrupted",
      "U10/0/coding/wait/2/resumed",
    ]);
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

  it("a pr-check that verified the followed pull request CLOSED carries `prClosed` through the parse: the machine never briefs a review on the record's pull request and the unit ends with round 0's own ending (issue 1799)", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0")],
      "read-record": [codingDone("run-c0", T0 + 5 * MIN)],
      "pr-check": [prNone(), ok({ ok: true, state: "none", prClosed: true }, T0 + 6 * MIN)],
      round: [acked(), acked()],
      "unit-end": [ok({ ok: true, told: true }, T0 + 6 * MIN)],
      finish: [ok({ ok: true, runId: "run-parent" }, T0 + 6 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "aborted" });
    // The check carried the record's pull request for the bot to follow.
    expect(b.of("pr-check")).toEqual([
      { parentInstanceId: INSTANCE, unit: "U10", entry: true },
      { parentInstanceId: INSTANCE, unit: "U10", pr: 7 },
    ]);
    expect(s.names()).not.toContain("U10/1/review");
  });

  it("a unit whose scope already landed ends already_landed through the parse — the pr-check's `aheadOfBase` and the record's `landed` list reach the machine — the unit-end carries the report naming the landing, its dependents run on the base that carries it, and the plan finishes completed", async () => {
    const LANDED = { what: "the empty state", where: "https://github.com/acme/api/pull/3377" };
    const s = steps({
      "U10/0/coding/wait/1": "event",
      "U11/0/coding/wait/1": "event",
      "U11/1/review/wait/1": "event",
    });
    const b = bot({
      plan: [planAnswer([row("U10"), row("U11", { dependsOn: ["U10"] })])],
      "unit-start": [started("U10"), started("U11", T0 + 8 * MIN)],
      branch: [branched("U10"), branched("U11", T0 + 8 * MIN)],
      spawn: [spawned("run-c0"), spawned("run-c1", T0 + 8 * MIN), spawned("run-r1", T0 + 18 * MIN)],
      "read-record": [
        record(
          {
            id: "run-c0",
            finished: true,
            status: "completed",
            finalReply: "Already on main via pull request 3377.",
            handoff: true,
            pushed: [{ ref: "plan/fixture/u10", sha: HEAD }],
            handoffLists: { deviations: [], followUps: [], unproven: [], landed: [LANDED] },
          },
          T0 + 8 * MIN,
        ),
        codingDone("run-c1", T0 + 18 * MIN),
        reviewApproved("run-r1", T0 + 28 * MIN),
      ],
      "pr-check": [
        prNone(),
        ok({ ok: true, state: "none", aheadOfBase: 0 }, T0 + 8 * MIN),
        prNone(T0 + 8 * MIN),
        prOpen(T0 + 18 * MIN),
      ],
      round: Array.from({ length: 8 }, () => acked()),
      merge: [ok({ ok: true, outcome: "merged", sha: MERGED }, T0 + 29 * MIN)],
      "unit-end": [ok({ ok: true, told: true }, T0 + 8 * MIN), ok({ ok: true, told: true }, T0 + 29 * MIN)],
      finish: [ok({ ok: true, runId: "run-parent" }, T0 + 29 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "already_landed", U11: "merged" });
    expect(summary.outcome).toBe("completed");
    const [end] = b.of("unit-end") as Array<{
      unit: string;
      ending: { kind: string; report: string };
      codingRunId?: string;
    }>;
    expect(end.unit).toBe("U10");
    expect(end.ending.kind).toBe("already_landed");
    expect(end.ending.report).toContain(LANDED.where);
    expect(end.ending.report).not.toContain("compare");
    expect(end.codingRunId).toBe("run-c0");
    // No renewal segment was written for a unit with nothing to do.
    expect(end).not.toHaveProperty("segment");
    expect(b.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "completed" }]);
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
    expect(s.names().slice(-6)).toEqual([
      "U10/merge/1",
      "U10/merge/wait/1",
      "U10/merge/2",
      "U10/end",
      "plan/2",
      "finish",
    ]);
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
        caps: { maxRounds: 2, maxMinutes: 240 },
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

  it("the plan answer's runPageBase reaches the machine: an aborted unit's report links the coding child's run page instead of repeating its write-up (issue 1806)", async () => {
    const b = bot({
      plan: [planAnswer([row("U10")], T0, "person", { runPageBase: "https://bot.example/runs" })],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0")],
      "read-record": [
        record({ id: "run-c0", finished: true, status: "completed", finalReply: "Which login flow?" }, T0 + 10 * MIN),
      ],
      "pr-check": [prNone(), prNone(T0 + 10 * MIN)],
      round: [acked(), acked()],
      "unit-end": [acked()],
      finish: [acked()],
    });
    const t = steps({ "U10/0/coding/wait/1": "event" });
    expect((await runPlan(t.runner, b.client, INSTANCE)).units).toEqual({ U10: "aborted" });
    const [end] = b.of("unit-end") as Array<{ ending: { report: string } }>;
    expect(end!.ending.report).toContain("https://bot.example/runs/run-c0");
    expect(end!.ending.report).not.toContain("Which login flow?");
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
              caps: { maxRounds: 2, maxMinutes: 240 },
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
      "plan/2",
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
    expect(s.taken.filter((t) => t.kind === "wait" && /^U10\/0\/coding\/wait\/\d+$/.test(t.name))).toEqual([
      { kind: "wait", name: "U10/0/coding/wait/1", type: "run-finished-run-c0", timeout: WAIT_CHUNK_MS },
      { kind: "wait", name: "U10/0/coding/wait/2", type: "run-finished-run-c0", timeout: WAIT_CHUNK_MS },
    ]);
    const [end] = b.of("unit-end") as Array<{ ending: { kind: string; report: string } }>;
    expect(end.ending.kind).toBe("refused");
    expect(end.ending.report).toContain("agent_allowlist");
    expect(b.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "failed" }]);
  });

  it("a gated approve — one the child's parser should have downgraded — reaches the `round` route with the gate the machine caught, and only that round carries it", async () => {
    const s = steps({
      "U10/0/coding/wait/1": "event",
      "U10/1/review/wait/1": "event",
      "U10/1/findings/wait/1": "event",
      "U10/2/review/wait/1": "event",
    });
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
        record(
          {
            id: "run-r1",
            finished: true,
            status: "completed",
            verdict: {
              verdict: "approve",
              summary: "approved over a minor",
              findings: [{ id: "F1", severity: "minor", file: "src/a.ts", line: 3, title: "off by one" }],
            },
            reviewPosted: true,
            reviewHead: HEAD,
          },
          T0 + 20 * MIN,
        ),
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
    const rounds = b.of("round") as Array<{ index: number; agent: string; outcome: string; gate?: unknown }>;
    expect(rounds.filter((r) => r.gate !== undefined)).toEqual([
      {
        parentInstanceId: INSTANCE,
        unit: "U10",
        index: 1,
        agent: "review",
        outcome: "approve",
        gate: { level: "minor", findings: ["F1 (minor)"] },
      },
    ]);
    expect(rounds.filter((r) => r.outcome === "approve")).toHaveLength(2); // round 2's clean approve carries no gate
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
      "U10/2/review/checks/1",
      "U10/merge/1",
      "U10/end",
      "plan/2",
      "finish",
    ]);
    expect(s.names().some((n) => /\/fix\b/.test(n))).toBe(false);
    expect(b.of("unit-start")).toEqual([{ parentInstanceId: INSTANCE, unit: "U10" }]);
    // The budgets are the presets' own: at the findings step (T0 + 20) the plan's
    // 240 leaves 220 minus the fix reserve (the re-review and the merge, 18 min —
    // never the round-0 child's 44), so the whole 90; the re-review its whole 25.
    expect(b.of("spawn")[2]).toEqual({
      parentInstanceId: INSTANCE,
      unit: "U10",
      step: "U10/1/findings",
      preset: "coding",
      budget: 90,
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
        caps: { maxRounds: 2, maxMinutes: 240 },
      },
      {
        ok: true,
        repo: "acme/api",
        base: "main",
        caps: { maxRounds: 2, maxMinutes: 240 },
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

  it("a 409 not_host on unit-start, round, unit-end and finish — a bot generation that no longer hosts the parent — is a transient refusal the step re-asks under its policy, and the plan completes once the host answers; a 409 busy stays the machine's answer, not a retry", async () => {
    const notHost = (at = T0): BotReply => ok({ ok: false, error: "not_host" }, at, 409);
    const s = steps({ "U10/0/coding/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [notHost(), started("U10")],
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
      round: [notHost(), acked(), notHost(T0 + 10 * MIN), acked(T0 + 10 * MIN)],
      "unit-end": [notHost(T0 + 10 * MIN), acked(T0 + 10 * MIN)],
      finish: [notHost(T0 + 10 * MIN), acked(T0 + 10 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "merged" });
    expect(summary.outcome).toBe("completed");
    // Each refused step was asked again under its own policy, not failed.
    expect(s.attempts["U10/start"]).toBe(2);
    expect(s.attempts["U10/note/1"]).toBe(2);
    expect(s.attempts["U10/note/2"]).toBe(2);
    expect(s.attempts["U10/end"]).toBe(2);
    expect(s.attempts.finish).toBe(2);
    // The same body without the bot's clock is not the bot's answer, as today.
    expect(readBotAnswer(409, JSON.stringify({ ok: false, error: "not_host" }))).toEqual({
      ok: false,
      reason: "HTTP 409 — not_host",
    });
  });

  it("a 409 queued on the spawn step — the plane holds the child's admission (record 0064) — is a passing condition like not_host: the spawn is re-asked under its own policy, never thrown out of the machine or read as its return, and the plan completes once the child is admitted", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event", "U10/1/review/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [
        ok({ ok: false, error: "queued", message: "position 1" }, T0, 409),
        spawned("run-c0", T0 + MIN),
        spawned("run-r1", T0 + 10 * MIN),
      ],
      "read-record": [codingDone("run-c0", T0 + 10 * MIN), reviewApproved("run-r1", T0 + 20 * MIN)],
      "pr-check": [prNone(), prOpen(T0 + 10 * MIN)],
      round: [acked(), acked(), acked(), acked()],
      merge: [ok({ ok: true, outcome: "merged", sha: MERGED }, T0 + 21 * MIN)],
      "unit-end": [ok({ ok: true, told: true }, T0 + 21 * MIN)],
      finish: [ok({ ok: true, runId: "run-parent" }, T0 + 21 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "merged" });
    expect(summary.outcome).toBe("completed");
    // The queued answer was a retry of the same spawn step — one step name,
    // two attempts — never a busy wait, a refusal or a failed instance.
    expect(s.attempts["U10/0/coding"]).toBe(2);
    expect(s.names().filter((n) => n === "U10/0/coding")).toHaveLength(1);
    expect(s.names().some((n) => n.startsWith("U10/0/coding/busy"))).toBe(false);
  });

  it("a selection that grows mid-walk (the orchestration-plane plan): the unit boundary's re-read — its own `plan/<n>` step — finds a unit appended to the rows and walks it after the current one", async () => {
    const s = steps({
      "U10/0/coding/wait/1": "event",
      "U10/1/review/wait/1": "event",
      "U11/0/coding/wait/1": "event",
      "U11/1/review/wait/1": "event",
    });
    const b = bot({
      plan: [
        planAnswer([row("U10")]),
        // The boundary's re-read: a later bot appended U11 while U10 ran.
        planAnswer([row("U10"), row("U11", { dependsOn: ["U10"] })], T0 + 22 * MIN),
      ],
      "unit-start": [started("U10"), started("U11", T0 + 22 * MIN)],
      branch: [branched("U10"), branched("U11", T0 + 22 * MIN)],
      spawn: [
        spawned("run-c0"),
        spawned("run-r1", T0 + 10 * MIN),
        spawned("run-c1", T0 + 23 * MIN),
        spawned("run-r2", T0 + 33 * MIN),
      ],
      "read-record": [
        codingDone("run-c0", T0 + 10 * MIN),
        reviewApproved("run-r1", T0 + 20 * MIN),
        codingDone("run-c1", T0 + 33 * MIN),
        reviewApproved("run-r2", T0 + 43 * MIN),
      ],
      "pr-check": [prNone(), prOpen(T0 + 10 * MIN), prNone(T0 + 22 * MIN), prOpen(T0 + 33 * MIN)],
      round: Array.from({ length: 8 }, () => acked()),
      merge: [
        ok({ ok: true, outcome: "merged", sha: MERGED }, T0 + 21 * MIN),
        ok({ ok: true, outcome: "merged", sha: MERGED }, T0 + 44 * MIN),
      ],
      "unit-end": [acked(), acked()],
      finish: [acked()],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "merged", U11: "merged" });
    expect(summary.outcome).toBe("completed");
    // Three reads: the opening one and one per unit boundary, each its own
    // durable step; the appended unit started only after the re-read saw it.
    expect(s.names().filter((n) => n === "plan" || n.startsWith("plan/"))).toEqual(["plan", "plan/2", "plan/3"]);
    expect(s.names().indexOf("U11/start")).toBeGreaterThan(s.names().indexOf("plan/2"));
    expect(b.of("plan")).toHaveLength(3);
  });

  it("a selection that shrinks (the orchestration-plane plan): a unit gone from the rows at the boundary's re-read — merged by hand — is walked as merged with nothing run and nothing told for it, and a dependency on it counts satisfied like any dependency outside the selection", async () => {
    const s = steps({
      "U10/0/coding/wait/1": "event",
      "U10/1/review/wait/1": "event",
      "U12/0/coding/wait/1": "event",
      "U12/1/review/wait/1": "event",
    });
    const b = bot({
      plan: [
        planAnswer([row("U10"), row("U11"), row("U12", { dependsOn: ["U11"] })]),
        // The re-read after U10: U11 was merged by hand and its row removed;
        // U12's row keeps naming it, a dependency now outside the selection.
        planAnswer([row("U10"), row("U12", { dependsOn: ["U11"] })], T0 + 22 * MIN),
      ],
      "unit-start": [started("U10"), started("U12", T0 + 22 * MIN)],
      branch: [branched("U10"), branched("U12", T0 + 22 * MIN)],
      spawn: [
        spawned("run-c0"),
        spawned("run-r1", T0 + 10 * MIN),
        spawned("run-c1", T0 + 23 * MIN),
        spawned("run-r2", T0 + 33 * MIN),
      ],
      "read-record": [
        codingDone("run-c0", T0 + 10 * MIN),
        reviewApproved("run-r1", T0 + 20 * MIN),
        codingDone("run-c1", T0 + 33 * MIN),
        reviewApproved("run-r2", T0 + 43 * MIN),
      ],
      "pr-check": [prNone(), prOpen(T0 + 10 * MIN), prNone(T0 + 22 * MIN), prOpen(T0 + 33 * MIN)],
      round: Array.from({ length: 8 }, () => acked()),
      merge: [
        ok({ ok: true, outcome: "merged", sha: MERGED }, T0 + 21 * MIN),
        ok({ ok: true, outcome: "merged", sha: MERGED }, T0 + 44 * MIN),
      ],
      "unit-end": [acked(), acked()],
      finish: [acked()],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    // The hand-merged unit reads merged in the summary — walked as merged —
    // and its dependent ran on the assertion its removal makes.
    expect(summary.units).toEqual({ U10: "merged", U11: "merged", U12: "merged" });
    expect(summary.outcome).toBe("completed");
    expect(s.names().some((n) => n.startsWith("U11/"))).toBe(false);
    expect((b.of("unit-end") as Array<{ unit: string }>).map((e) => e.unit)).toEqual(["U10", "U12"]);
  });

  it("transientRefusal: the answers the bot itself calls a passing condition — GitHub unavailable, no channel to rebuild the thread on, a unit not yet started, a bot that is not the host, a spawn the plane holds queued — are a reason to retry the step; every other answer, refusals included, is the machine's to judge", () => {
    expect(transientRefusal(answer({ ok: false, error: "github_unavailable", message: "HTTP 502" }, T0, 502))).toBe(
      "the bot answered github_unavailable: HTTP 502",
    );
    expect(transientRefusal(answer({ ok: false, error: "no_channel" }, T0, 503))).toBe("the bot answered no_channel");
    expect(transientRefusal(answer({ ok: false, error: "thread_failed", message: "no ts" }, T0, 502))).toContain(
      "thread_failed",
    );
    expect(transientRefusal(answer({ ok: false, error: "unit_not_started" }, T0, 409))).toContain("unit_not_started");
    expect(transientRefusal(answer({ ok: false, error: "not_host" }, T0, 409))).toBe("the bot answered not_host");
    expect(transientRefusal(answer({ ok: false, error: "queued", message: "position 2" }, T0, 409))).toBe(
      "the bot answered queued: position 2",
    );
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
          caps: { maxRounds: 2, maxMinutes: 240 },
          units: [row("U10")],
        }),
      ],
      "unit-start": [ok({ ok: true, threadKey: "slack:C1:1.0" })],
      branch: [ok({ ok: true })],
      spawn: [spawned("run-c0")],
      "read-record": [codingDone("run-c0", T0 + 205 * MIN)],
      // The pre-check, then the round's check: the pull request is open at the child's head with 35 minutes
      // left — the review holds 36 for the fix, the re-review and the merge, so it falls under its floor of 5.
      "pr-check": [prNone(), prOpen(T0 + 205 * MIN)],
      round: [acked(), acked()],
      "unit-end": [acked()],
      finish: [acked()],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "review_pending" });
    // The coding child's directive is its carve: 240 minus the 44 held for two reviews, a fix and the merge leaves room for its whole 90.
    expect(b.of("spawn")[0]).toMatchObject({ step: "U10/0/coding", preset: "coding", budget: 90 });
    const [end] = b.of("unit-end") as Array<{
      ending: { kind: string; report: string };
      pr: unknown;
      headSha?: string;
    }>;
    expect(end.ending.kind).toBe("review_pending");
    expect(end.pr).toEqual({ number: 7, url: PR_URL });
    expect(end.headSha).toBe(HEAD);
    expect(end.ending.report).toContain("⏳ Review pending");
    expect(end.ending.report).toContain("Budget split (240 min):");
  });

  // record 0051: an idled review_pending keeps its resume-at-review fact — the
  // pending head is the idle's `from` and still rides the body as `headSha`,
  // so the row's lastPush is written as for the plain ending.
  it("an idled review_pending continues from the pending head: the unit-end's idle carries it as `from` and the body still names it as headSha, so the row's lastPush survives the idle", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event" });
    const b = bot({
      plan: [
        ok({
          ok: true,
          planId: "fixture",
          merge: "person",
          repo: "acme/api",
          base: "main",
          caps: { maxRounds: 2, maxMinutes: 240 },
          units: [row("U10")],
          idleDays: 7,
        }),
      ],
      "unit-start": [ok({ ok: true, threadKey: "slack:C1:1.0" })],
      branch: [ok({ ok: true })],
      spawn: [spawned("run-c0")],
      "read-record": [codingDone("run-c0", T0 + 205 * MIN)],
      "pr-check": [prNone(), prOpen(T0 + 205 * MIN)],
      round: [acked(), acked()],
      "unit-end": [acked()],
      finish: [acked()],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "idle" });
    const [end] = b.of("unit-end") as Array<{ ending: Record<string, unknown>; pr: unknown; headSha?: string }>;
    expect(end.ending).toMatchObject({ kind: "idle", why: "review_pending", from: HEAD });
    expect(end.pr).toEqual({ number: 7, url: PR_URL });
    expect(end.headSha).toBe(HEAD);
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
          caps: { maxRounds: 2, maxMinutes: 240 },
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

describe("the plan runner's driver — the entry checks resume a re-issued plan's unit (agent-ship item 10, issue 1689)", () => {
  it("a pre-check that finds the unit's open pull request at the branch's own head resumes the attempt at the review round: the call carries entry: true, no branch and no coding child run, and the review is briefed with the pull request at that head", async () => {
    const s = steps({ "U10/1/review/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")], T0, "person")],
      "unit-start": [started("U10")],
      spawn: [spawned("run-r1")],
      "read-record": [reviewApproved("run-r1", T0 + 5 * MIN)],
      // The entry answer carries the branch's own tip beside the listing's
      // head; the second check is the merge_ready ending's facts read.
      "pr-check": [prOpen(T0, { branchHead: HEAD }), prOpen(T0 + 5 * MIN)],
      round: [acked(), acked()],
      "unit-end": [acked()],
      finish: [acked()],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "merge_ready" });
    expect(b.of("branch")).toEqual([]);
    expect(b.of("pr-check")[0]).toEqual({ parentInstanceId: INSTANCE, unit: "U10", entry: true });
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

  it("a pre-check that finds the pull request approved with green checks at the branch head resumes straight at the merge-ready check: no child at all, the unit ends merge_ready and the ending's facts are still read fresh at the head", async () => {
    const s = steps();
    const b = bot({
      plan: [planAnswer([row("U10")], T0, "person")],
      "unit-start": [started("U10")],
      "pr-check": [
        prOpen(T0, { branchHead: HEAD, approved: true, checks: { total: 2, pending: [], failed: [] } }),
        prOpen(T0 + MIN),
      ],
      "unit-end": [acked()],
      finish: [acked()],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "merge_ready" });
    expect(b.of("branch")).toEqual([]);
    expect(b.of("spawn")).toEqual([]);
    expect(b.of("pr-check")).toEqual([
      { parentInstanceId: INSTANCE, unit: "U10", entry: true },
      { parentInstanceId: INSTANCE, unit: "U10", checks: true },
    ]);
    const [end] = b.of("unit-end") as Array<{ ending: { kind: string } }>;
    expect(end.ending.kind).toBe("merge_ready");
  });

  it("the seal's remedy holds (issue 2100): a re-issue in a thread whose pull request is approved and clean resumes at the checks step — under merge: runner the merge door is asked at exactly the approved head with no branch step and no coding child, never a fresh coding round", async () => {
    const s = steps();
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      "pr-check": [
        prOpen(T0, {
          branchHead: HEAD,
          approved: true,
          checks: { total: 30, pending: [], failed: [] },
          mergeableState: "clean",
        }),
      ],
      merge: [ok({ ok: true, outcome: "merged", sha: MERGED }, T0 + MIN)],
      "unit-end": [acked(T0 + MIN)],
      finish: [acked(T0 + MIN)],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "merged" });
    expect(b.of("branch")).toEqual([]);
    expect(b.of("spawn")).toEqual([]);
    expect(b.of("merge")).toEqual([{ parentInstanceId: INSTANCE, unit: "U10", prNumber: 7, headSha: HEAD }]);
    expect(s.names().some((n) => n.includes("/coding"))).toBe(false);
  });
});

describe("the plan runner's driver — a step that throws inside the walk becomes the unit's ending (issue 2100)", () => {
  const HEAD_2 = "b".repeat(40);
  const red = { total: 2, pending: [], failed: [{ name: "ci", conclusion: "failure" }] };

  it("the incident's shape pinned: a round-2 approve whose read-record stores a stamped non-transient refusal (HTTP 404 not_found — the walk's instant death, no retry ladder) posts the unit's ending before the instance fails — kind failed, cause step_threw, the read step and round 2, the one-line message in the user's words — and the finish still says failed; never the bare 'no ending was recorded' seal", async () => {
    const s = steps({
      "U10/0/coding/wait/1": "event",
      "U10/1/review/wait/1": "event",
      "U10/1/findings/wait/1": "event",
      "U10/2/review/wait/1": "event",
    });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [
        spawned("run-c0"),
        spawned("run-r1", T0 + 10 * MIN),
        spawned("run-f1", T0 + 21 * MIN),
        spawned("run-r2", T0 + 30 * MIN),
      ],
      "read-record": [
        codingDone("run-c0", T0 + 10 * MIN),
        reviewApproved("run-r1", T0 + 20 * MIN),
        record({ id: "run-f1", finished: true, status: "completed", headSha: HEAD_2 }, T0 + 30 * MIN),
        // Round 2's LGTM landed on GitHub, but the record read answers a
        // stamped refusal outside the transient set: the mapper throws
        // OUTSIDE the step — the platform retries nothing — and before this
        // fix the instance died two seconds after the approve with no ending.
        ok({ ok: false, error: "not_found" }, T0 + 40 * MIN, 404),
      ],
      // Round 1's checks step reads a red head (the incident's seq 39–42:
      // approve, then checks_failed, then the fix round and the re-review).
      checks: [ok({ ok: true, checks: red }, T0 + 21 * MIN)],
      "pr-check": [
        prNone(),
        prOpen(T0 + 10 * MIN),
        ok({ ok: true, state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_2 }, T0 + 30 * MIN),
      ],
      round: Array.from({ length: 10 }, () => acked()),
      "unit-end": [acked(T0 + 40 * MIN)],
      finish: [acked(T0 + 40 * MIN)],
    });
    await expect(runPlan(s.runner, b.client, INSTANCE)).rejects.toThrow(
      "the bot's read-record answer could not be read",
    );
    // The ending was told before the rethrow: the row carries the cause and
    // the thread hears it in the user's words.
    const ends = b.of("unit-end") as Array<{
      ending: { kind: string; cause?: string; step?: string; round?: number; report: string; threadReport: string };
    }>;
    expect(ends).toHaveLength(1);
    expect(ends[0]!.ending).toMatchObject({
      kind: "failed",
      cause: "step_threw",
      step: "U10/2/review/read/1",
      round: 2,
    });
    expect(ends[0]!.ending.report).toContain("The runner failed after round 2's review verdict");
    expect(ends[0]!.ending.report).toContain("not_found");
    expect(ends[0]!.ending.report).toContain("Re-issue `agent:ship` in this thread to continue");
    // One line: the message never carries a stack or a second line.
    expect(ends[0]!.ending.report.split("\n")[0]).toContain("HTTP 404");
    expect(s.names()).toContain("U10/end/threw");
    expect(b.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "failed" }]);
  });

  it("a step whose retries are exhausted inside the platform's ladder ends the same way: the checks step's twelve retries spent, the ending names the checks step of round 1 and the throw's message, and the original error still fails the instance", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event", "U10/1/review/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0"), spawned("run-r1", T0 + 10 * MIN)],
      "read-record": [codingDone("run-c0", T0 + 10 * MIN), reviewApproved("run-r1", T0 + 20 * MIN)],
      "pr-check": [prNone(), prOpen(T0 + 10 * MIN)],
      checks: Array.from({ length: STEP_RETRIES.limit + 1 }, () => new Error("GitHub melted")),
      round: Array.from({ length: 6 }, () => acked()),
      "unit-end": [acked(T0 + 21 * MIN)],
      finish: [acked(T0 + 21 * MIN)],
    });
    await expect(runPlan(s.runner, b.client, INSTANCE)).rejects.toThrow("GitHub melted");
    const ends = b.of("unit-end") as Array<{
      ending: { kind: string; cause?: string; step?: string; round?: number; report: string };
    }>;
    expect(ends).toHaveLength(1);
    expect(ends[0]!.ending).toMatchObject({
      kind: "failed",
      cause: "step_threw",
      step: "U10/1/review/checks/1",
      round: 1,
    });
    expect(ends[0]!.ending.report).toContain("The runner failed after round 1's review verdict");
    expect(b.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "failed" }]);
  });

  it("unit-start exhausting its retries is inside the same net: its own step is recorded before the original error fails the instance, never a bare seal", async () => {
    const s = steps();
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": Array.from({ length: STEP_RETRIES.limit + 1 }, () => new Error("the start door is down")),
      "unit-end": [acked()],
      finish: [acked()],
    });
    await expect(runPlan(s.runner, b.client, INSTANCE)).rejects.toThrow("the start door is down");
    const [end] = b.of("unit-end") as Array<{ ending: { cause?: string; step?: string; round?: number } }>;
    expect(end!.ending).toMatchObject({ cause: "step_threw", step: "U10/start" });
    expect(end!.ending).not.toHaveProperty("round");
    expect(b.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "failed" }]);
  });

  it("a round-note throw names the note that failed, not the preceding machine action, and keeps the round structured", async () => {
    const s = steps();
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      "pr-check": [prNone()],
      branch: [branched("U10")],
      spawn: [spawned("run-c0")],
      round: Array.from({ length: STEP_RETRIES.limit + 1 }, () => new Error("the round writer is down")),
      "unit-end": [acked()],
      finish: [acked()],
    });
    await expect(runPlan(s.runner, b.client, INSTANCE)).rejects.toThrow("the round writer is down");
    const [end] = b.of("unit-end") as Array<{ ending: { cause?: string; step?: string; round?: number } }>;
    expect(end!.ending).toMatchObject({ cause: "step_threw", step: "U10/note/1", round: 0 });
  });

  it("a normal unit-end throw names the ending write that failed, not the preceding merge step", async () => {
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
      "unit-end": [
        ...Array.from({ length: STEP_RETRIES.limit + 1 }, () => new Error("the ending writer is down")),
        acked(),
      ],
      finish: [acked()],
    });
    await expect(runPlan(s.runner, b.client, INSTANCE)).rejects.toThrow("the ending writer is down");
    const ends = b.of("unit-end") as Array<{ ending: { cause?: string; step?: string; round?: number } }>;
    expect(ends.at(-1)!.ending).toMatchObject({ cause: "step_threw", step: "U10/end", round: 1 });
  });

  it("a stopped unit's unit-end throw is caught at the walk boundary: the alternate ending names that unit's end step before the original error fails the instance", async () => {
    const s = steps();
    const b = bot({
      plan: [planAnswer([row("U10")], T0, "runner", { stopped: true })],
      "unit-end": [
        ...Array.from({ length: STEP_RETRIES.limit + 1 }, () => new Error("the stopped ending writer is down")),
        acked(),
      ],
      finish: [acked()],
    });
    await expect(runPlan(s.runner, b.client, INSTANCE)).rejects.toThrow("the stopped ending writer is down");
    const ends = b.of("unit-end") as Array<{
      unit: string;
      ending: { kind: string; cause?: string; step?: string; round?: number };
    }>;
    expect(ends.at(-1)).toMatchObject({
      unit: "U10",
      ending: { kind: "failed", cause: "step_threw", step: "U10/end" },
    });
    expect(ends.at(-1)!.ending).not.toHaveProperty("round");
    expect(s.names()).toContain("U10/end/threw");
  });

  it("a blocked unit's unit-end throw is caught at the walk boundary: the alternate ending names the blocked unit's end step before the original error fails the instance", async () => {
    const s = steps();
    const b = bot({
      plan: [planAnswer([row("U10"), row("U11", { dependsOn: ["U10"] })])],
      "unit-start": [started("U10")],
      "pr-check": [prNone()],
      branch: [ok({ ok: false, reason: "HTTP 422 reference already exists" })],
      round: [acked()],
      "unit-end": [
        acked(),
        ...Array.from({ length: STEP_RETRIES.limit + 1 }, () => new Error("the blocked ending writer is down")),
        acked(),
      ],
      finish: [acked()],
    });
    await expect(runPlan(s.runner, b.client, INSTANCE)).rejects.toThrow("the blocked ending writer is down");
    const ends = b.of("unit-end") as Array<{
      unit: string;
      ending: { kind: string; cause?: string; step?: string; round?: number };
    }>;
    expect(ends.at(-1)).toMatchObject({
      unit: "U11",
      ending: { kind: "failed", cause: "step_threw", step: "U11/end" },
    });
    expect(ends.at(-1)!.ending).not.toHaveProperty("round");
    expect(s.names()).toContain("U11/end/threw");
  });

  it("the ending's post is best effort: a bot that cannot record it leaves the original throw to fail the instance — the finish is still asked as failed and the walk's error is the one rethrown", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0")],
      // The read's stored answer is a stamped refusal → the mapper throws.
      "read-record": [ok({ ok: false, error: "not_found" }, T0 + 10 * MIN, 404)],
      "pr-check": [prNone()],
      round: [acked()],
      "unit-end": Array.from({ length: STEP_RETRIES.limit + 1 }, () => new Error("the bot is down")),
      finish: [acked(T0 + 11 * MIN)],
    });
    await expect(runPlan(s.runner, b.client, INSTANCE)).rejects.toThrow(
      "the bot's read-record answer could not be read",
    );
    expect(b.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "failed" }]);
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
          caps: { maxRounds: 2, maxMinutes: 240 },
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
      "pr-check": [
        prOpen(T0 + 5 * MIN, { autoMergeEnabled: true, checks: { total: 2, pending: [], failed: ["ci / package"] } }),
      ],
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
      "task/1/review/checks/1",
      "task/end/pr-facts",
      "task/end",
      "plan/2",
      "finish",
    ]);
    // The one pr-check is the ending's facts read at the approved head — no
    // pre-check ran (the resume path skips it).
    expect(b.of("pr-check")).toEqual([{ parentInstanceId: "ship-run-s", unit: "task", checks: true }]);
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
    // The facts read asked for the checks at the approved head and one is red
    // (record 0055): the report never calls the head merge-ready, while
    // the machine's ending kind is unchanged and the auto-merge fact still rides.
    expect(end.ending.report).toContain(`⚠️ Approved but not merge-ready after 1 review round: ${PR_URL}`);
    expect(end.ending.report).toContain("CI is red at the approved head: ci / package");
    expect(end.ending.report).not.toContain("✅ Merge-ready");
    expect(end.ending.report).toContain(
      "Auto-merge is on for this pull request: the approval merges it once checks pass.",
    );
    expect(end.ending.report).not.toContain("Remaining gate");
    expect(end.pr).toEqual({ number: 7, url: PR_URL });
    expect(end.codingRunId).toBeUndefined();
  });

  it("the ending's facts read carries the ready state beside the checks (agent-ship item 9): a conflicting head is reported approved-but-not-merge-ready naming the rebase — over green checks, before the red-check line — and the unsquashed fix-up commits it carries ride the facts the same way", async () => {
    const s = steps({ "task/1/review/wait/1": "event" });
    const b = bot({
      plan: [
        ok({
          ok: true,
          repo: "acme/api",
          base: "main",
          merge: "person",
          generated: true,
          caps: { maxRounds: 2, maxMinutes: 240 },
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
      // The head conflicts with the base while every check is green, and it
      // still carries a self-declared fix-up commit: neither is merge-ready.
      "pr-check": [
        prOpen(T0 + 5 * MIN, {
          mergeableState: "dirty",
          fixupCommits: ["fixup! fix the login"],
          checks: { total: 2, pending: [], failed: [] },
        }),
      ],
      round: [acked(), acked()],
      "unit-end": [ok({ ok: true, told: true }, T0 + 5 * MIN)],
      finish: [ok({ ok: true, runId: "run-parent" }, T0 + 5 * MIN)],
    });
    const summary = await runPlan(s.runner, b.client, "ship-run-s");
    expect(summary).toEqual({ instance: "ship-run-s", units: { task: "merge_ready" }, outcome: "completed" });
    const [end] = b.of("unit-end") as Array<{ ending: { kind: string; report: string } }>;
    expect(end.ending.kind).toBe("merge_ready");
    expect(end.ending.report).toContain(`⚠️ Approved but not merge-ready after 1 review round: ${PR_URL}`);
    expect(end.ending.report).toContain("the head conflicts with `main`: `pulls rebase");
    expect(end.ending.report).not.toContain("✅ Merge-ready");
    expect(end.ending.report).not.toContain("checks green");
  });

  it("the ending's facts read can find the pull request already merged — auto-merge fired, or a person merged, between the approval and the ending: the unit still ends merge_ready (the machine's ending stands) and the report names the merge by commit and time instead of a gate that has passed", async () => {
    const s = steps({ "task/1/review/wait/1": "event" });
    const b = bot({
      plan: [
        ok({
          ok: true,
          repo: "acme/api",
          base: "main",
          caps: { maxRounds: 2, maxMinutes: 240 },
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
      `Already merged: ${PR_URL} (merge commit \`${MERGED.slice(0, 7)}\`, merged 2026-09-16T00:46:19Z) — auto-merge or a person merged it after the approval; the pipeline merged nothing.`,
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
    expect(s.names().slice(0, 8)).toEqual([
      "plan",
      "U10/start",
      "U10/pr-check",
      "U10/end",
      "plan/2",
      "U11/start",
      "U11/pr-check",
      "U11/branch",
    ]);
    expect(s.names()).not.toContain("U10/branch");
    expect(b.of("branch")).toEqual([{ parentInstanceId: INSTANCE, unit: "U11" }]);
    expect(b.of("spawn").map((c) => c.unit)).toEqual(["U11", "U11"]);
    expect(b.of("pr-check")).toEqual([
      { parentInstanceId: INSTANCE, unit: "U10", entry: true },
      { parentInstanceId: INSTANCE, unit: "U11", entry: true },
      // The round-0 check carries the pull request the child's record named.
      { parentInstanceId: INSTANCE, unit: "U11", pr: 7 },
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
      "plan/2",
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

// Feature: docs/reference/specs/agent-ship.md item 16 and live-view.md items 10
// and 16 (record 0060; issue 1924) — the hosted parent's hard stop also stops
// the runner: the seal writes a stop mark on the instance row, the bot's plan
// answer carries it (`stopped: true`), its spawn route refuses over it, and its
// read-record answer flags it — the walk honours the mark by ending every unit
// not yet ended `stopped` and running nothing more.
describe("the plan runner's driver — the hosted parent's hard stop stops the runner (record 0060, issue 1924)", () => {
  it("a stop between units spawns nothing more and ends the remaining units stopped: the boundary re-read carries the mark, the next unit never starts, its row is told a stopped ending, and the finish is failed", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event", "U10/1/review/wait/1": "event" });
    const b = bot({
      plan: [
        planAnswer([row("U10"), row("U11")]),
        planAnswer([row("U10"), row("U11")], T0 + 22 * MIN, "runner", { stopped: true }),
      ],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0"), spawned("run-r1", T0 + 10 * MIN)],
      "read-record": [codingDone("run-c0", T0 + 10 * MIN), reviewApproved("run-r1", T0 + 20 * MIN)],
      "pr-check": [prNone(), prOpen(T0 + 10 * MIN)],
      round: [acked(), acked(), acked(), acked()],
      merge: [ok({ ok: true, outcome: "merged", sha: MERGED }, T0 + 21 * MIN)],
      "unit-end": [acked(), acked()],
      finish: [acked()],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary).toEqual({
      instance: INSTANCE,
      planId: "fixture",
      units: { U10: "merged", U11: "stopped" },
      outcome: "failed",
    });
    // Nothing of U11 ran: no unit-start, no branch, no spawn — only its ending.
    expect(b.of("unit-start").map((c) => c.unit)).toEqual(["U10"]);
    expect(b.of("spawn").map((c) => c.unit)).toEqual(["U10", "U10"]);
    expect(s.names().slice(-3)).toEqual(["plan/2", "U11/end", "finish"]);
    const ends = b.of("unit-end") as Array<{ unit: string; ending: { kind: string; report: string } }>;
    expect(ends[1]).toMatchObject({ unit: "U11", ending: { kind: "stopped" } });
    expect(ends[1]!.ending.report).toContain("hard-stopped");
    expect(ends[1]!.ending.report).toContain("U11 was ended without running");
    expect(b.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "failed" }]);
  });

  it("a stop during a child ends the unit stopped when the child ends: the read-record answer carries the mark, the unit ends stopped whatever the child's own status, and no review child is spawned", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")]), planAnswer([row("U10")], T0 + 10 * MIN, "runner", { stopped: true })],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0")],
      "read-record": [
        ok(
          {
            ok: true,
            stopped: true,
            run: { id: "run-c0", finished: true, status: "completed", finalReply: "Done — branch pushed." },
          },
          T0 + 10 * MIN,
        ),
      ],
      "pr-check": [prNone()],
      round: [acked(), acked()],
      "unit-end": [acked()],
      finish: [acked()],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "stopped" });
    expect(summary.outcome).toBe("failed");
    expect(b.of("spawn")).toHaveLength(1);
    const [end] = b.of("unit-end") as Array<{ unit: string; ending: { kind: string } }>;
    expect(end).toMatchObject({ unit: "U10", ending: { kind: "stopped" } });
    expect(b.of("round").at(-1)).toMatchObject({ unit: "U10", index: 0, agent: "coding", outcome: "stopped" });
    expect(b.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "failed" }]);
  });

  it("a stop that lands between a child's end and the next spawn is honoured at the spawn: the bot refuses it `stopped` and the unit ends stopped, never refused", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")]), planAnswer([row("U10")], T0 + 11 * MIN, "runner", { stopped: true })],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0"), ok({ ok: false, error: "stopped" }, T0 + 11 * MIN, 409)],
      "read-record": [codingDone("run-c0", T0 + 10 * MIN)],
      "pr-check": [prNone(), prOpen(T0 + 10 * MIN)],
      round: [acked(), acked(), acked()],
      "unit-end": [acked()],
      finish: [acked()],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary.units).toEqual({ U10: "stopped" });
    expect(summary.outcome).toBe("failed");
    // The refused spawn retried nothing: the refusal is terminal, one ask.
    expect(s.attempts["U10/1/review"]).toBe(1);
    const [end] = b.of("unit-end") as Array<{ unit: string; ending: { kind: string } }>;
    expect(end).toMatchObject({ unit: "U10", ending: { kind: "stopped" } });
    expect(b.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "failed" }]);
  });

  it("a stop on a runner that already finished changes nothing: a mark first seen once every unit has ended adds no ending and keeps the finish completed", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event", "U10/1/review/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")]), planAnswer([row("U10")], T0 + 22 * MIN, "runner", { stopped: true })],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0"), spawned("run-r1", T0 + 10 * MIN)],
      "read-record": [codingDone("run-c0", T0 + 10 * MIN), reviewApproved("run-r1", T0 + 20 * MIN)],
      "pr-check": [prNone(), prOpen(T0 + 10 * MIN)],
      round: [acked(), acked(), acked(), acked()],
      merge: [ok({ ok: true, outcome: "merged", sha: MERGED }, T0 + 21 * MIN)],
      "unit-end": [acked()],
      finish: [acked()],
    });
    const summary = await runPlan(s.runner, b.client, INSTANCE);
    expect(summary).toEqual({ instance: INSTANCE, planId: "fixture", units: { U10: "merged" }, outcome: "completed" });
    expect(b.of("unit-end")).toHaveLength(1);
    expect(b.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "completed" }]);
  });
});
