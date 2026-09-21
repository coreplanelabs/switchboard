import { describe, expect, it } from "vitest";
import {
  COORDINATOR_IDENTITY,
  COORDINATOR_STEP_ACTION,
  PLAN_MERGE_ACTION,
  coordinatorFields,
  IDEMPOTENCY_KEY_PATTERN,
  idempotencyKeyFor,
  INSTANCE_ID_PATTERN,
  isCoordinatorInstance,
  runFinishedEventType,
  childInterruptedEventType,
  childResumedEventType,
  sendChildSignal,
  sendRunFinished,
  STEP_NAME_PATTERN,
  isCoordinatorUnit,
  parseUnitKey,
  UNIT_KEY_PATTERN,
  unitKeyOf,
  unitOfIdempotencyKey,
  UNIT_PATTERN,
  unitNudgeEventType,
  capThreadEvent,
  isThreadEvent,
  THREAD_EVENT_MAX_BYTES,
  type CoordinatorInstance,
  type CoordinatorUnit,
  type WorkflowSender,
} from "./contract.js";

// Feature: docs/reference/specs/run-history.md items 47–48 — the coordinator's
// node-free contract: the identity and the action the routes decide on, the
// key a spawn carries, the event a finished child's record sends, and the
// parent record the spawn route reads the requester from. Every Worker and the
// bot import this one module, so the shapes agree by construction.

const instance: CoordinatorInstance = {
  id: "ship_acme_api_20260911T1200",
  kind: "ship",
  userId: "slack:UALICE",
  userName: "alice",
  channelId: "slack:C1",
  threadKey: "slack:C1:1.0",
  sourceUrl: "https://acme.slack.com/archives/C1/p1",
  repo: "acme/api",
  branch: "plan/orchestration/u12-run-finished",
  base: "main",
  createdAt: 1_000,
};

describe("the coordinator's names", () => {
  it("the identity is the `coordinator` ingress subject, the step action is `coordinator:step` and the merge action is `plan:merge`", () => {
    expect(COORDINATOR_IDENTITY).toBe("coordinator");
    expect(COORDINATOR_STEP_ACTION).toBe("coordinator:step");
    expect(PLAN_MERGE_ACTION).toBe("plan:merge");
  });

  it("an instance id is the platform's alphabet, at most 100 characters; a step name may carry `/` and `.`; the key is `<instance>:<step>`", () => {
    expect(INSTANCE_ID_PATTERN.test("ship_acme_api_1")).toBe(true);
    expect(INSTANCE_ID_PATTERN.test("-leading-dash")).toBe(false);
    expect(INSTANCE_ID_PATTERN.test("a".repeat(101))).toBe(false);
    expect(INSTANCE_ID_PATTERN.test("has:colon")).toBe(false);
    expect(STEP_NAME_PATTERN.test("u12/0/coding")).toBe(true);
    expect(STEP_NAME_PATTERN.test("")).toBe(false);
    expect(STEP_NAME_PATTERN.test("a:b")).toBe(false);
    const key = idempotencyKeyFor("ship_acme_api_1", "u12/0/coding");
    expect(key).toBe("ship_acme_api_1:u12/0/coding");
    expect(IDEMPOTENCY_KEY_PATTERN.test(key)).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test("no-step")).toBe(false);
  });

  it("the event type is run-finished-<runId>, the run id under a prefix in the platform's alphabet (letters, digits, hyphen, underscore), so each wait matches its own child and the engine accepts the send; the old run finished: shape is outside it", () => {
    const runId = "8b5a233a-e63d-4da4-b18d-8314f1b08a88";
    // Cloudflare Workflows' own rule for an event type; anything else is refused as `workflow.invalid_event_type`.
    const platform = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;
    expect(runFinishedEventType(runId)).toBe(`run-finished-${runId}`);
    expect(runFinishedEventType(runId)).toMatch(platform);
    expect(`run finished:${runId}`).not.toMatch(platform);
  });

  it("the deploy-roll signals ride the same alphabet: child-interrupted-<runId> and child-resumed-<runId> (run-history item 47a)", () => {
    const runId = "8b5a233a-e63d-4da4-b18d-8314f1b08a88";
    const platform = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;
    expect(childInterruptedEventType(runId)).toBe(`child-interrupted-${runId}`);
    expect(childResumedEventType(runId)).toBe(`child-resumed-${runId}`);
    expect(childInterruptedEventType(runId)).toMatch(platform);
    expect(childResumedEventType(runId)).toMatch(platform);
  });

  it("coordinatorFields spreads a tag into the two record fields and nothing without one", () => {
    expect(coordinatorFields({ parentInstanceId: "inst_1", idempotencyKey: "inst_1:s" })).toEqual({
      parentInstanceId: "inst_1",
      idempotencyKey: "inst_1:s",
    });
    expect(coordinatorFields(undefined)).toEqual({});
  });

  it("the tag's base is an instruction to the child's post-step, not a record field: coordinatorFields leaves it out, so rows and records keep the shape written before it existed", () => {
    expect(coordinatorFields({ parentInstanceId: "inst_1", idempotencyKey: "inst_1:s", base: "main" })).toEqual({
      parentInstanceId: "inst_1",
      idempotencyKey: "inst_1:s",
    });
  });
});

describe("a unit's key — the instance and the unit, the prefix of every child's idempotency key", () => {
  it("unitKeyOf spells the row's instance and unit, parseUnitKey reads them back, and the key is the head of each child's idempotency key", () => {
    const key = unitKeyOf({ instanceId: "plan-p-2", unit: "U16" });
    expect(key).toBe("plan-p-2:U16");
    expect(UNIT_KEY_PATTERN.test(key)).toBe(true);
    expect(parseUnitKey(key)).toEqual({ instanceId: "plan-p-2", unit: "U16" });
    expect(parseUnitKey(unitKeyOf({ instanceId: "ship-abc_1", unit: "task" }))).toEqual({
      instanceId: "ship-abc_1",
      unit: "task",
    });
    expect(idempotencyKeyFor("plan-p-2", "U16/1/coding").startsWith(`${key}/`)).toBe(true);
  });

  it("unitOfIdempotencyKey reads the unit off a child's key — the head of its step — and answers nothing for a malformed key or a step without a unit prefix", () => {
    expect(unitOfIdempotencyKey("plan-p-2:U16/1/coding")).toBe("U16");
    expect(unitOfIdempotencyKey("ship-abc_1:task/2/review")).toBe("task");
    expect(unitOfIdempotencyKey("plan-p-2:U16")).toBe("U16");
    expect(unitOfIdempotencyKey("plan-p-2")).toBeUndefined();
    expect(unitOfIdempotencyKey(`plan-p-2:${"u".repeat(33)}/1/coding`)).toBeUndefined();
  });

  it("refuses what is not a key: no colon, an empty half, a unit with a slash or a colon, an instance over 100 characters", () => {
    for (const bad of [
      "plan-p-2",
      ":U16",
      "plan-p-2:",
      "plan-p-2:U16/1/coding",
      "plan-p-2:U16:6",
      `${"a".repeat(101)}:U16`,
    ])
      expect(parseUnitKey(bad), bad).toBeUndefined();
  });
});

describe("isCoordinatorInstance — the parent ship record", () => {
  it("accepts the ship record, also after a JSON round-trip, and one without its optional fields", () => {
    expect(isCoordinatorInstance(instance)).toBe(true);
    expect(isCoordinatorInstance(JSON.parse(JSON.stringify(instance)))).toBe(true);
    const { userName: _u, sourceUrl: _s, base: _b, ...bare } = instance;
    expect(isCoordinatorInstance(bare)).toBe(true);
  });

  it("refuses a bad id, an unknown kind, a missing requester or thread, a repo that is not a slug, and a non-object", () => {
    expect(isCoordinatorInstance({ ...instance, id: "has:colon" })).toBe(false);
    expect(isCoordinatorInstance({ ...instance, kind: "review" })).toBe(false);
    expect(isCoordinatorInstance({ ...instance, userId: "" })).toBe(false);
    expect(isCoordinatorInstance({ ...instance, threadKey: 7 })).toBe(false);
    expect(isCoordinatorInstance({ ...instance, repo: "not a slug" })).toBe(false);
    expect(isCoordinatorInstance({ ...instance, branch: "" })).toBe(false);
    expect(isCoordinatorInstance({ ...instance, createdAt: "yesterday" })).toBe(false);
    expect(isCoordinatorInstance(null)).toBe(false);
    expect(isCoordinatorInstance("x")).toBe(false);
  });

  // run-history item 49: the instance's own surfaces — the plan it runs, the
  // clipped caps, the card the bot redraws and the record it writes at the end.
  it("accepts the plan, the caps, the card, the run id and the label when present, each shaped, and refuses a malformed one", () => {
    const full: CoordinatorInstance = {
      ...instance,
      plan: { id: "feat-program-plan", path: "docs/plans/feat-program-plan.md" },
      caps: { maxRounds: 3, maxMinutes: 45 },
      card: { channel: "C1", ts: "1.5" },
      runId: "run-parent",
      label: "*ship* · acme/api",
    };
    expect(isCoordinatorInstance(full)).toBe(true);
    expect(isCoordinatorInstance(JSON.parse(JSON.stringify(full)))).toBe(true);
    // A `plan` without a `path` is the generated one-unit plan's mark (agent-ship item 16).
    expect(isCoordinatorInstance({ ...full, plan: { id: "p" } })).toBe(true);
    expect(isCoordinatorInstance({ ...full, plan: { id: "p", path: 7 } })).toBe(false);
    expect(isCoordinatorInstance({ ...full, plan: { path: "docs/p.md" } })).toBe(false);
    expect(isCoordinatorInstance({ ...full, caps: { maxRounds: "3", maxMinutes: 45 } })).toBe(false);
    expect(isCoordinatorInstance({ ...full, card: { channel: "C1" } })).toBe(false);
    expect(isCoordinatorInstance({ ...full, runId: 7 })).toBe(false);
    // A re-issue's attempt is the second or later; the first carries none.
    expect(isCoordinatorInstance({ ...full, attempt: 2 })).toBe(true);
    expect(isCoordinatorInstance({ ...full, attempt: 1 })).toBe(false);
    expect(isCoordinatorInstance({ ...full, attempt: 2.5 })).toBe(false);
    // The idle flag (record 0051): an integer count of days within the module's bounds.
    expect(isCoordinatorInstance({ ...full, idleDays: 0 })).toBe(true);
    expect(isCoordinatorInstance({ ...full, idleDays: 365 })).toBe(true);
    expect(isCoordinatorInstance({ ...full, idleDays: 366 })).toBe(false);
    expect(isCoordinatorInstance({ ...full, idleDays: -1 })).toBe(false);
    expect(isCoordinatorInstance({ ...full, idleDays: "7" })).toBe(false);
  });
});

// run-history item 50: one row per unit of the plan an instance runs.
describe("isCoordinatorUnit — one unit's row", () => {
  const unit: CoordinatorUnit = {
    instanceId: instance.id,
    unit: "U12",
    slug: "u12-run-finished",
    title: "run finished from every terminal record write",
    branch: "plan/orchestration/u12-run-finished",
    dependsOn: ["U20", "U21"],
    threadKey: "slack:C1:2.0",
    sourceUrl: "https://acme.slack.com/archives/C1/p2",
    reviewThread: { threadKey: "slack:C1:3.0", sourceUrl: "https://acme.slack.com/archives/C1/p3" },
    issue: 834,
    pr: { number: 979, url: "https://github.com/acme/api/pull/979" },
    resume: { pr: 979, headSha: "a".repeat(40), url: "https://github.com/acme/api/pull/979" },
    rounds: [{ index: 0, agent: "coding", outcome: "started", at: 1_000 }],
    ending: {
      kind: "failed",
      cause: "step_threw",
      step: "U12/2/review/read/1",
      round: 2,
      report: "The runner failed while reading the review",
      at: 2_000,
    },
    startedAt: 900,
  };

  it("accepts a full row, its JSON round-trip and a bare one (the branch, the dependencies and no rounds)", () => {
    expect(isCoordinatorUnit(unit)).toBe(true);
    expect(isCoordinatorUnit(JSON.parse(JSON.stringify(unit)))).toBe(true);
    expect(
      isCoordinatorUnit({
        instanceId: instance.id,
        unit: "task",
        slug: "task",
        branch: "ship/x-1a2b3c",
        dependsOn: [],
        rounds: [],
      }),
    ).toBe(true);
  });

  it("segments are the renewals the unit spent — an index from two up, an optional sha and run id, a time; a first-segment row, a non-array, a malformed index or sha is refused", () => {
    expect(isCoordinatorUnit({ ...unit, segments: [] })).toBe(true);
    expect(
      isCoordinatorUnit({ ...unit, segments: [{ index: 2, from: "a".repeat(40), runId: "run-c0", at: 3_000 }] }),
    ).toBe(true);
    expect(isCoordinatorUnit({ ...unit, segments: [{ index: 3, at: 3_000 }] })).toBe(true);
    expect(isCoordinatorUnit({ ...unit, segments: [{ index: 1, at: 3_000 }] })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, segments: [{ index: 2 }] })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, segments: [{ index: 2, from: 7, at: 3_000 }] })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, segments: { index: 2, at: 3_000 } })).toBe(false);
  });

  it("the idle on a row (record 0051, run-history item 50): why, at, renewalsLeft, wakes and the optional continuation facts accepted; a missing why, a negative count, a malformed spendUsd or handoff refused", () => {
    const idle = { why: "wall_clock_cap", at: 3_000, renewalsLeft: 2, spendUsd: 12.5, wakes: 0 };
    expect(isCoordinatorUnit({ ...unit, idle })).toBe(true);
    expect(
      isCoordinatorUnit({
        ...unit,
        idle: {
          ...idle,
          from: "a".repeat(40),
          runId: "run-c0",
          spendUsd: null,
          handoff: { deviations: [], followUps: [], unproven: [] },
        },
      }),
    ).toBe(true);
    expect(isCoordinatorUnit({ ...unit, idle: { ...idle, why: undefined } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, idle: { ...idle, renewalsLeft: -1 } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, idle: { ...idle, wakes: 0.5 } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, idle: { ...idle, spendUsd: "12" } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, idle: { ...idle, handoff: { deviations: "none" } } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, idle: "wall_clock_cap" })).toBe(false);
  });

  it("wake answers are keyed by the indexed wait and retain every segment continuation fact; malformed keys and answers are refused", () => {
    const segment = {
      kind: "segment",
      index: 3,
      from: "a".repeat(40),
      runId: "run-c0",
      spendUsd: 12.5,
      handoff: { deviations: [], followUps: [], unproven: [] },
      texts: ["Ada: continue"],
      senders: ["Ada"],
      leaseMs: 120_000,
    } as const;
    expect(isCoordinatorUnit({ ...unit, wakes: { "U10/idle/1": segment } })).toBe(true);
    expect(isCoordinatorUnit({ ...unit, wakes: { "U10/idle/2": { kind: "answered", reply: "not yet" } } })).toBe(true);
    expect(isCoordinatorUnit({ ...unit, wakes: { "U10/idle/3": { kind: "stopped" } } })).toBe(true);
    expect(isCoordinatorUnit({ ...unit, wakes: { "U10/idle/4": { kind: "expired" } } })).toBe(true);
    expect(isCoordinatorUnit({ ...unit, wakes: { "bad:wait": segment } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, wakes: { "U10/idle/1": { ...segment, texts: "Ada: continue" } } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, wakes: [] })).toBe(false);
  });

  it("a resume at review is the pull request number with an optional head and url; a resume without the number, or with a malformed head or url, is refused", () => {
    expect(isCoordinatorUnit({ ...unit, resume: { pr: 7 } })).toBe(true);
    expect(isCoordinatorUnit({ ...unit, resume: { pr: 7, headSha: "b".repeat(40) } })).toBe(true);
    expect(isCoordinatorUnit({ ...unit, resume: { headSha: "b".repeat(40) } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, resume: { pr: "7" } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, resume: { pr: 7, headSha: 42 } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, resume: { pr: 7, url: "" } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, resume: "7" })).toBe(false);
  });

  it("the review thread is a thread key with an optional link, beside the unit's own thread; a review thread without its key, with a malformed link, or as a bare string is refused", () => {
    expect(isCoordinatorUnit({ ...unit, reviewThread: { threadKey: "slack:C1:3.0" } })).toBe(true);
    expect(isCoordinatorUnit({ ...unit, reviewThread: undefined })).toBe(true);
    expect(isCoordinatorUnit({ ...unit, reviewThread: { sourceUrl: "https://acme.slack.com/x" } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, reviewThread: { threadKey: "" } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, reviewThread: { threadKey: 7 } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, reviewThread: { threadKey: "slack:C1:3.0", sourceUrl: "" } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, reviewThread: "slack:C1:3.0" })).toBe(false);
  });

  it("refuses a bad instance id, a missing unit, slug or branch, a non-array dependency list, a malformed pull request, round or ending, and a non-object", () => {
    expect(isCoordinatorUnit({ ...unit, instanceId: "has:colon" })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, unit: "" })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, slug: 7 })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, branch: "" })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, dependsOn: "U20" })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, pr: { number: "979" } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, rounds: [{ index: 0 }] })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, ending: { kind: "merged" } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, ending: { ...unit.ending!, step: "bad:step" } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, ending: { ...unit.ending!, round: -1 } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, ending: { ...unit.ending!, round: 1.5 } })).toBe(false);
    expect(isCoordinatorUnit({ ...unit, issue: "834" })).toBe(false);
    expect(isCoordinatorUnit(null)).toBe(false);
  });
});

describe("sendRunFinished — the event a terminal record sends", () => {
  function workflow(behaviour: "ok" | "not-running" = "ok") {
    const sent: Array<{ instance: string; type: string; payload: unknown }> = [];
    const sender: WorkflowSender = {
      get: async (id) => ({
        sendEvent: async (event) => {
          if (behaviour === "not-running") throw new Error("instance is not running");
          sent.push({ instance: id, type: event.type, payload: event.payload });
        },
      }),
    };
    return { sender, sent };
  }
  const finished = { id: "run-1", status: "completed" as const, finishedAt: 5_000, parentInstanceId: "inst_1" };

  it("sends exactly one `run-finished-<runId>` to the record's instance, the payload naming the run, its status and the instance", async () => {
    const w = workflow();
    const out = await sendRunFinished(w.sender, finished);
    expect(out).toEqual({ kind: "sent", instance: "inst_1", type: "run-finished-run-1" });
    expect(w.sent).toEqual([
      {
        instance: "inst_1",
        type: "run-finished-run-1",
        payload: { runId: "run-1", status: "completed", finishedAt: 5_000, parentInstanceId: "inst_1" },
      },
    ]);
  });

  it("a record without parentInstanceId sends nothing", async () => {
    const w = workflow();
    const { parentInstanceId: _p, ...plain } = finished;
    expect(await sendRunFinished(w.sender, plain)).toEqual({ kind: "none" });
    expect(w.sent).toEqual([]);
  });

  it("no binding → nothing sent, said by name; the caller's commit is unaffected", async () => {
    expect(await sendRunFinished(undefined, finished)).toEqual({ kind: "no-binding", instance: "inst_1" });
  });

  it("a send the engine refuses — the instance ended — is swallowed and reported with the reason, never thrown", async () => {
    const w = workflow("not-running");
    expect(await sendRunFinished(w.sender, finished)).toEqual({
      kind: "failed",
      instance: "inst_1",
      type: "run-finished-run-1",
      reason: "instance is not running",
    });
  });
});

// Feature: docs/reference/specs/run-history.md item 47a — the deploy-roll
// signal a child's reattach path sends its parent, beside the finish event.
describe("sendChildSignal — the deploy-roll signal a child sends its parent", () => {
  function workflow(behaviour: "ok" | "not-running" = "ok") {
    const sent: Array<{ instance: string; type: string; payload: unknown }> = [];
    const sender: WorkflowSender = {
      get: async (id) => ({
        sendEvent: async (event) => {
          if (behaviour === "not-running") throw new Error("instance is not running");
          sent.push({ instance: id, type: event.type, payload: event.payload });
        },
      }),
    };
    return { sender, sent };
  }
  const signal = {
    runId: "run-1",
    parentInstanceId: "inst_1",
    kind: "interrupted" as const,
    reason: "workspace lost across the restart",
    at: 5_000,
  };

  it("sends child-interrupted-<runId> for an interruption and child-resumed-<runId> for a resume, the payload naming the run, the kind, the reason and the instance", async () => {
    const w = workflow();
    expect(await sendChildSignal(w.sender, signal)).toEqual({
      kind: "sent",
      instance: "inst_1",
      type: "child-interrupted-run-1",
    });
    expect(await sendChildSignal(w.sender, { ...signal, kind: "resumed", reason: "re-attached" })).toEqual({
      kind: "sent",
      instance: "inst_1",
      type: "child-resumed-run-1",
    });
    expect(w.sent).toEqual([
      {
        instance: "inst_1",
        type: "child-interrupted-run-1",
        payload: {
          runId: "run-1",
          kind: "interrupted",
          reason: "workspace lost across the restart",
          at: 5_000,
          parentInstanceId: "inst_1",
        },
      },
      {
        instance: "inst_1",
        type: "child-resumed-run-1",
        payload: { runId: "run-1", kind: "resumed", reason: "re-attached", at: 5_000, parentInstanceId: "inst_1" },
      },
    ]);
  });

  it("no binding → nothing sent, said by name; a refusing engine is swallowed and reported, never thrown", async () => {
    expect(await sendChildSignal(undefined, signal)).toEqual({ kind: "no-binding", instance: "inst_1" });
    const w = workflow("not-running");
    expect(await sendChildSignal(w.sender, signal)).toEqual({
      kind: "failed",
      instance: "inst_1",
      type: "child-interrupted-run-1",
      reason: "instance is not running",
    });
  });
});

// Feature: docs/reference/specs/http-ingress.md item 9 — the payload-free
// nudge a thread event sends its unit's instance (record 0051's reply-as-event rule).
describe("unitNudgeEventType — the nudge's type under the relay's alphabet", () => {
  // The relay's own pattern (instancesRoute.ts): letters, digits, `_` and `-`, at most 100 characters.
  const RELAY_EVENT_TYPE = /^[A-Za-z0-9_-]{1,100}$/;

  it("matches the relay's pattern for the longest legal instance id and unit, and a colon never appears", () => {
    const instanceId = `i${"x".repeat(99)}`; // 100 chars, INSTANCE_ID_PATTERN's cap
    const unit = "U".padEnd(32, "9"); // 32 chars, UNIT_PATTERN's cap
    expect(INSTANCE_ID_PATTERN.test(instanceId)).toBe(true);
    expect(UNIT_PATTERN.test(unit)).toBe(true);
    const type = unitNudgeEventType({ instanceId, unit });
    expect(type).toMatch(RELAY_EVENT_TYPE);
    expect(type).not.toContain(":");
    // The unit rides whole — the send addresses the instance by id, so the
    // type only has to name the unit within it; the instance id is the clipped half.
    expect(type.endsWith(`-${unit}`)).toBe(true);
    expect(type.startsWith("unit-nudge-")).toBe(true);
  });

  it("keeps short ids whole and is deterministic — both ends compute the same string", () => {
    expect(unitNudgeEventType({ instanceId: "ship_acme_api_1", unit: "U12" })).toBe("unit-nudge-ship_acme_api_1-U12");
    expect(unitNudgeEventType({ instanceId: "ship_acme_api_1", unit: "U12" })).toBe(
      unitNudgeEventType({ instanceId: "ship_acme_api_1", unit: "U12" }),
    );
  });
});

// Feature: docs/reference/specs/thread-admission.md — a thread event's shape and its cap (record 0051's reply-as-event rule).
describe("capThreadEvent and isThreadEvent — one event row of a unit's list", () => {
  const event = {
    sender: "slack:UALICE",
    text: "also update the readme",
    mode: "steer" as const,
    at: 5_000,
  };

  it("keeps attachments under the cap and drops them whole over it, recording the count", () => {
    const small = capThreadEvent({ ...event, attachments: [{ mediaType: "image/png", data: "aGk=" }] });
    expect(small.attachments).toHaveLength(1);
    expect(small.attachmentsDropped).toBeUndefined();
    const big = capThreadEvent({
      ...event,
      attachments: [
        { mediaType: "image/png", data: "x".repeat(THREAD_EVENT_MAX_BYTES) },
        { mediaType: "image/png", data: "y" },
      ],
    });
    expect(big.attachments).toBeUndefined();
    expect(big.attachmentsDropped).toBe(2);
    expect(big.text).toBe(event.text);
    expect(big.textDropped).toBeUndefined();
  });

  it("a text alone over the cap is cut from the end until the row fits, the cut counted; the same input caps the same way twice", () => {
    const long = { ...event, text: "é".repeat(THREAD_EVENT_MAX_BYTES) };
    const cut = capThreadEvent(long);
    expect(new TextEncoder().encode(JSON.stringify(cut)).length).toBeLessThanOrEqual(THREAD_EVENT_MAX_BYTES);
    expect(cut.text.length).toBeGreaterThan(0);
    expect(cut.text.length).toBeLessThan(long.text.length);
    expect(cut.textDropped).toBe(long.text.length - cut.text.length);
    expect(long.text.startsWith(cut.text)).toBe(true);
    expect(capThreadEvent(long)).toEqual(cut);
    // Attachments over the cap go first; the text is cut only when the row is still over without them.
    const both = capThreadEvent({ ...long, attachments: [{ mediaType: "image/png", data: "aGk=" }] });
    expect(both.attachmentsDropped).toBe(1);
    expect(both.textDropped).toBeGreaterThanOrEqual(cut.textDropped!);
    expect(new TextEncoder().encode(JSON.stringify(both)).length).toBeLessThanOrEqual(THREAD_EVENT_MAX_BYTES);
    expect(isThreadEvent({ ...cut, seq: 1 })).toBe(true);
    expect(
      isThreadEvent({
        ...event,
        seq: 1,
        attachments: [
          {
            mediaType: "image/png",
            data: "aGk=",
            staged: {
              name: "shot.png",
              size: 2,
              type: "image/png",
              url: "https://files.slack.com/shot.png",
              messageId: "1.0",
              workspaceIndex: 0,
            },
          },
        ],
      }),
    ).toBe(true);
    expect(isThreadEvent({ ...cut, seq: 1, textDropped: "many" })).toBe(false);
    expect(
      isThreadEvent({
        ...event,
        seq: 1,
        attachments: [
          {
            mediaType: "image/png",
            data: "aGk=",
            staged: { name: "shot.png", size: 2, type: "image/png", url: "u", messageId: "1.0", workspaceIndex: -1 },
          },
        ],
      }),
    ).toBe(false);
  });

  it("the counters are non-negative integers and the fixed fields are bounded, so a row's cap has a floor: a fraction, a negative, NaN or an oversized id is refused", () => {
    const row = { ...event, seq: 1 };
    expect(isThreadEvent({ ...row, attachmentsDropped: 0 })).toBe(true);
    expect(isThreadEvent({ ...row, attachmentsDropped: 1.5 })).toBe(false);
    expect(isThreadEvent({ ...row, attachmentsDropped: -1 })).toBe(false);
    expect(isThreadEvent({ ...row, textDropped: Number.NaN })).toBe(false);
    expect(isThreadEvent({ ...row, textDropped: -3 })).toBe(false);
    expect(isThreadEvent({ ...row, id: "1789742775.643859" })).toBe(true);
    expect(isThreadEvent({ ...row, id: "x".repeat(513) })).toBe(false);
    expect(isThreadEvent({ ...row, sender: "x".repeat(513) })).toBe(false);
    expect(isThreadEvent({ ...row, senderName: "x".repeat(513) })).toBe(false);
  });

  it("accepts a stored row and refuses a malformed one", () => {
    expect(isThreadEvent({ ...event, seq: 1 })).toBe(true);
    expect(isThreadEvent({ ...event, seq: 1, consumedBy: "spawn:U12/1/fix" })).toBe(true);
    expect(isThreadEvent({ ...event, seq: 0 })).toBe(false);
    expect(isThreadEvent({ ...event, seq: 1, mode: "queue" })).toBe(false);
    expect(isThreadEvent({ seq: 1, text: "x", mode: "steer", at: 1 })).toBe(false); // no sender
  });
});
