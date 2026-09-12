import { describe, expect, it } from "vitest";
import {
  COORDINATOR_IDENTITY,
  COORDINATOR_STEP_ACTION,
  coordinatorFields,
  IDEMPOTENCY_KEY_PATTERN,
  idempotencyKeyFor,
  INSTANCE_ID_PATTERN,
  isCoordinatorInstance,
  runFinishedEventType,
  sendRunFinished,
  STEP_NAME_PATTERN,
  type CoordinatorInstance,
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
  it("the identity is the `coordinator` ingress subject and the action is `coordinator:step`", () => {
    expect(COORDINATOR_IDENTITY).toBe("coordinator");
    expect(COORDINATOR_STEP_ACTION).toBe("coordinator:step");
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

  it("the event type carries the run id, so each wait matches its own child", () => {
    expect(runFinishedEventType("run-abc")).toBe("run finished:run-abc");
  });

  it("coordinatorFields spreads a tag into the two record fields and nothing without one", () => {
    expect(coordinatorFields({ parentInstanceId: "inst_1", idempotencyKey: "inst_1:s" })).toEqual({
      parentInstanceId: "inst_1",
      idempotencyKey: "inst_1:s",
    });
    expect(coordinatorFields(undefined)).toEqual({});
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

  it("sends exactly one `run finished:<runId>` to the record's instance, the payload naming the run, its status and the instance", async () => {
    const w = workflow();
    const out = await sendRunFinished(w.sender, finished);
    expect(out).toEqual({ kind: "sent", instance: "inst_1", type: "run finished:run-1" });
    expect(w.sent).toEqual([
      {
        instance: "inst_1",
        type: "run finished:run-1",
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
      type: "run finished:run-1",
      reason: "instance is not running",
    });
  });
});
