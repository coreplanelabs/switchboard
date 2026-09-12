import { describe, expect, it } from "vitest";
import type { CoordinatorUnit } from "./contract.js";
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

/** The bot's `plan` answer for the given rows. */
const planAnswer = (units: CoordinatorUnit[], at = T0): BotReply =>
  ok(
    {
      ok: true,
      planId: "fixture",
      repo: "acme/api",
      base: "main",
      caps: { maxRounds: 2, maxMinutes: 45 },
      childMinutes: { coding: 45, review: 25 },
      units,
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
const prOpen = (at = T0): BotReply => ok({ ok: true, state: "open", prNumber: 7, url: PR_URL, headSha: HEAD }, at);
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
      if (answer === "event") return { payload: { runId: options.type.slice("run finished:".length) } };
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
  it("a one-unit plan runs coding, then review to approve, then the runner's merge at the approved head, and ends merged: the steps in order under the machine's names, every spawn typed by its brief and clipped budget, every wait typed `run finished:<runId>` for the budget plus five minutes and followed by a read-record, the round boundaries and the ending told to the bot, the finish completed", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event", "U10/1/review/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0"), spawned("run-r1", T0 + 10 * MIN)],
      "read-record": [codingDone("run-c0", T0 + 10 * MIN), reviewApproved("run-r1", T0 + 20 * MIN)],
      "pr-check": [prOpen(T0 + 10 * MIN)],
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
        /^U10\/\d+\/(coding|review|fix)$/.test(t.name) ? SPAWN_STEP_CONFIG.timeout : undefined,
      );
    }
    expect(STEP_RETRIES).toEqual({ limit: 12, delay: 2 * MIN, backoff: "constant" });
    expect(STEP_CONFIG).toEqual({ retries: STEP_RETRIES });
    // The waits: the child's clipped budget plus the margin, typed by the run the spawn answered.
    expect(s.taken.filter((t) => t.kind === "wait")).toEqual([
      { kind: "wait", name: "U10/0/coding/wait/1", type: "run finished:run-c0", timeout: 45 * MIN + 5 * MIN },
      { kind: "wait", name: "U10/1/review/wait/1", type: "run finished:run-r1", timeout: 25 * MIN + 5 * MIN },
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
    expect(b.of("pr-check")).toEqual([{ parentInstanceId: INSTANCE, unit: "U10" }]);
    expect(b.of("round")).toEqual([
      { parentInstanceId: INSTANCE, unit: "U10", index: 0, agent: "coding", outcome: "started" },
      { parentInstanceId: INSTANCE, unit: "U10", index: 0, agent: "coding", outcome: "pr_opened" },
      { parentInstanceId: INSTANCE, unit: "U10", index: 1, agent: "review", outcome: "started" },
      { parentInstanceId: INSTANCE, unit: "U10", index: 1, agent: "review", outcome: "approve" },
    ]);
    const [end] = b.of("unit-end") as Array<{ ending: { kind: string; report: string }; pr: unknown; unit: string }>;
    expect(end.unit).toBe("U10");
    expect(end.pr).toEqual({ number: 7, url: PR_URL });
    expect(end.ending.kind).toBe("merged");
    expect(end.ending.report).toContain(`✅ Merged after 1 review round: ${PR_URL} (squash \`${MERGED.slice(0, 7)}\`)`);
    expect(end.ending.report).toContain("plan:merge");
    expect(b.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "completed" }]);
  });

  it("the merge's pending poll: checks still running answer pending, the runner sleeps the poll and asks again under the next step name, and a merge GitHub refuses ends the unit merge_refused with the refusal in its report; a task string's ship branch is a person's merge — the machine ends merge-ready and never asks", async () => {
    const s = steps({ "U10/0/coding/wait/1": "event", "U10/1/review/wait/1": "event" });
    const b = bot({
      plan: [planAnswer([row("U10")])],
      "unit-start": [started("U10")],
      branch: [branched("U10")],
      spawn: [spawned("run-c0"), spawned("run-r1", T0 + 10 * MIN)],
      "read-record": [codingDone("run-c0", T0 + 10 * MIN), reviewApproved("run-r1", T0 + 20 * MIN)],
      "pr-check": [prOpen(T0 + 10 * MIN)],
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
    expect(s.names().slice(-5)).toEqual(["U10/merge/1", "U10/merge/sleep/1", "U10/merge/2", "U10/end", "finish"]);
    expect(s.taken.find((t) => t.name === "U10/merge/sleep/1")).toEqual({
      kind: "sleep",
      name: "U10/merge/sleep/1",
      ms: 5 * MIN,
    });
    const [end] = b.of("unit-end") as Array<{ ending: { kind: string; report: string } }>;
    expect(end.ending.kind).toBe("merge_refused");
    expect(end.ending.report).toContain("GitHub refused the merge (HTTP 405): not mergeable");
    expect(end.ending.report).toContain("A person decides");

    // A task unit: the ship branch is not a plan branch, so the merge is a person's.
    const t = steps({ "task/0/coding/wait/1": "event", "task/1/review/wait/1": "event" });
    const tb = bot({
      plan: [planAnswer([row("task", { slug: "task", branch: "ship/warm-the-cache-abc123" })])],
      "unit-start": [started("task")],
      branch: [ok({ ok: true, branch: "ship/warm-the-cache-abc123", base: "main" })],
      spawn: [spawned("run-c0"), spawned("run-r1", T0 + 10 * MIN)],
      "read-record": [codingDone("run-c0", T0 + 10 * MIN), reviewApproved("run-r1", T0 + 20 * MIN)],
      "pr-check": [prOpen(T0 + 10 * MIN)],
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

  it("a wait that times out is confirmed by read-record like an event: a live child is waited on again under the next step name, a finished one advances; a spawn answered busy naming the run holding the thread waits on that run, one without a run id sleeps the busy retry", async () => {
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
      "pr-check": [prOpen(T0 + 11 * MIN)],
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
      type: "run finished:run-other",
    });
    const [end] = b.of("unit-end") as Array<{ ending: { kind: string; report: string } }>;
    expect(end.ending.kind).toBe("refused");
    expect(end.ending.report).toContain("agent_allowlist");
    expect(b.of("finish")).toEqual([{ parentInstanceId: INSTANCE, outcome: "failed" }]);
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
      "pr-check": [prOpen(T0 + 10 * MIN), prOpen(T0 + 35 * MIN)],
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
        caps: { maxRounds: 2, maxMinutes: 45 },
        childMinutes: { coding: 45, review: 25 },
      },
      {
        ok: true,
        repo: "acme/api",
        base: "main",
        caps: { maxRounds: 2, maxMinutes: 45 },
        childMinutes: { coding: 45, review: 25 },
        units: [{ unit: "U10" }],
      },
      { ok: true, repo: "acme/api", base: "main", childMinutes: { coding: 45, review: 25 }, units: [row("U10")] },
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
