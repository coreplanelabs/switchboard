import { describe, expect, it } from "vitest";
import { durableInboxMessage } from "../runLedger/inboxMessage.js";
import type { LiveRunRow, StepRecord } from "../runLedger/types.js";
import { NullLedgerRun } from "../runLedger/writeThrough.js";
import type { RunRecord } from "../runRecord.js";
import { RunRegistry } from "../runRegistry.js";
import { createCardShell } from "../statusCardFrame.js";
import type { IncomingMessage, StatusUpdate } from "../types.js";
import type { ResumeContext } from "./admission.js";
import type { WorkflowSender } from "../coordinator/contract.js";
import {
  abandonLostWorkspace,
  announceChildRoll,
  carriedCoordinatorTag,
  carriedWorkspaceBinding,
  lostWorkspaceNote,
  prepareRestartTurn,
} from "./reattach.js";
import type { PersonFollowUp } from "./settle.js";

// Feature: docs/reference/specs/run-history.md item 54: a resumed run re-attaches
// where its row says it ran; when it cannot, the run closes saying why and its
// request runs again as a new run, never migrated silently onto another backend.

const NOW = 10_000;
const REQUEST: IncomingMessage = {
  channelId: "slack:CX",
  userId: "slack:UX",
  threadKey: "slack:CX:1.0",
  text: "agent:coding fix the resolver",
  sourceUrl: "https://slack/p1",
};

function row(over: Partial<LiveRunRow> = {}, meta: Partial<LiveRunRow["meta"]> = {}): LiveRunRow {
  return {
    runId: "run-old",
    threadKey: "slack:CX:1.0",
    ownerGen: "gen-T",
    leaseUntil: NOW + 30_000,
    startedAt: 5_000,
    phase: "live",
    stop: null,
    meta: {
      channelId: "slack:CX",
      userId: "slack:UX",
      threadKey: "slack:CX:1.0",
      agent: "coding",
      model: "anthropic/coding-model",
      repo: "acme/api",
      request: durableInboxMessage(REQUEST, REQUEST.text, 4_000),
      ...meta,
    },
    card: { channel: "CX", ts: "1.2" },
    system: "sys",
    tools: [],
    state: {},
    ...over,
  };
}

const lastStep: StepRecord = {
  step: 1,
  seq: 4,
  turnIndex: 2,
  inFlight: [],
  inboxConsumedSeq: 0,
  remainingMs: 240_000,
  turn: 1,
  iteration: 0,
};

describe("carriedWorkspaceBinding: where the row says the run's workspace is", () => {
  it("reads the binding the claim recorded on the row's state", () => {
    const r = row({
      state: {
        binding: { backend: "resident", workspace: "/workspace/threads/t/main", user: "worker2", container: "vm-1" },
      },
    });
    expect(carriedWorkspaceBinding(r)).toEqual({
      backend: "resident",
      workspace: "/workspace/threads/t/main",
      user: "worker2",
      container: "vm-1",
    });
  });

  it("a row written before the binding was recorded still names its backend through its meta: a resident with the worktree the prompt named, a per-thread backend bare", () => {
    expect(carriedWorkspaceBinding(row({}, { selection: "resident", workspace: "/workspace/threads/t/main" }))).toEqual(
      {
        backend: "resident",
        workspace: "/workspace/threads/t/main",
      },
    );
    expect(carriedWorkspaceBinding(row({}, { selection: "sandbox" }))).toEqual({ backend: "sandbox" });
  });

  it("a run without a workspace has nothing to re-attach", () => {
    expect(carriedWorkspaceBinding(row({}, { selection: "none" }))).toBeUndefined();
    expect(carriedWorkspaceBinding(row())).toBeUndefined();
    expect(carriedWorkspaceBinding(row({ state: { binding: { backend: "mainframe" } } }))).toBeUndefined();
  });
});

// Feature: docs/reference/specs/run-history.md item 48a: the
// coordinator tag is a fact of the run — a resumed child rebuilds it from the
// row's meta and the `coordinator_tag` event its spawning dispatch published,
// so the plan's base survives a bot roll instead of living only in the
// spawning process's dispatch options.
describe("carriedCoordinatorTag: the tag a resumed run carries forward", () => {
  const tagged = row({}, { parentInstanceId: "plan-p-2", idempotencyKey: "plan-p-2:U16/1/coding" });

  it("rebuilds the tag from the row's meta with the base the coordinator_tag event carried", () => {
    const tag = carriedCoordinatorTag(tagged, [
      { type: "input", messageId: "m1", text: "go", at: 1 },
      { type: "coordinator_tag", parentInstanceId: "plan-p-2", unit: "U16", base: "feat/trunk", at: 2 },
    ]);
    expect(tag).toEqual({ parentInstanceId: "plan-p-2", idempotencyKey: "plan-p-2:U16/1/coding", base: "feat/trunk" });
  });

  it("a row written before the event existed carries the two meta fields and no base — the store guard's case", () => {
    expect(carriedCoordinatorTag(tagged, [{ type: "input", messageId: "m1", text: "go", at: 1 }])).toEqual({
      parentInstanceId: "plan-p-2",
      idempotencyKey: "plan-p-2:U16/1/coding",
    });
  });

  it("a run no coordinator spawned carries nothing, even when an event is present", () => {
    expect(
      carriedCoordinatorTag(row(), [{ type: "coordinator_tag", parentInstanceId: "plan-p-2", base: "main", at: 2 }]),
    ).toBeUndefined();
  });
});

describe("abandonLostWorkspace: the resumed run closes saying why, and hands its request back", () => {
  function world(resume: ResumeContext) {
    const registry = new RunRegistry({ genId: () => "run-old", genToken: () => "tok" });
    const run = registry.create("label", { channelId: "slack:CX", userId: "slack:UX", threadKey: "slack:CX:1.0" });
    const puts: RunRecord[] = [];
    const ledgerRun = new NullLedgerRun("run-old", { put: async (r) => void puts.push(r), abandoned: () => {} });
    const closes: StatusUpdate[] = [];
    const refusals: string[] = [];
    const shell = createCardShell({ label: "*coding*", startedAt: 5_000, now: () => NOW });
    const ctx = {
      msg: REQUEST,
      io: {
        reply: async () => {},
        status: async () => ({ update: () => {}, done: async () => {} }),
        history: async () => [],
      },
      refuse: async <T>(outcome: string, fn: () => Promise<T>) => {
        refusals.push(outcome);
        return fn();
      },
      card: { update: () => {}, done: async (f: StatusUpdate) => void closes.push(f) },
      shell,
      closeLines: () => ({}),
      clock: () => NOW,
      run,
      registry,
      resume,
      ledgerRun,
      why: "reuse-refused: no worktree at /workspace/threads/t/main",
    };
    return { ctx, registry, run, puts, closes, refusals };
  }
  const resumeOf = (r: LiveRunRow): ResumeContext => ({
    row: r,
    lastStep,
    plan: { kind: "finish", step: 1, answer: "x", stepRecorded: true } as unknown as ResumeContext["plan"],
    events: [{ type: "input", messageId: "m1", text: "fix the resolver", at: 1, seq: 1 }],
    lastSeq: 4,
    repoCtx: { repo: "acme/api" },
    inbox: [],
  });

  it("publishes the resumed note on the run's stream, closes the card, closes the adopted row interrupted with the note in its record, and hands back the row's request", async () => {
    const w = world(resumeOf(row()));
    const restart = await abandonLostWorkspace(w.ctx);
    expect(restart).toMatchObject({
      text: "agent:coding fix the resolver",
      threadKey: "slack:CX:1.0",
      userId: "slack:UX",
    });
    expect(w.refusals).toEqual(["workspace_lost"]);
    const note = w.registry
      .snapshotById("run-old")!
      .events.find((e) => e.type === "run_note" && (e as { kind: string }).kind === "resumed") as { summary: string };
    expect(note.summary).toBe(
      "resumed after a restart: the run's workspace could not be re-attached (reuse-refused: no worktree at /workspace/threads/t/main); the run restarts from its request as a new run in this thread",
    );
    expect(JSON.stringify(w.closes)).toContain("workspace lost across the restart; restarting from the request");
    expect(w.puts).toHaveLength(1);
    expect(w.puts[0]).toMatchObject({ id: "run-old", status: "interrupted" });
    const recorded = w.puts[0].events.map((e) => e as { type: string; kind?: string; seq?: number });
    expect(recorded.map((e) => e.type)).toEqual(["input", "run_note"]);
    expect(recorded[1]).toMatchObject({ kind: "resumed", seq: 5 });
  });

  it("a row whose request cannot be read hands nothing back: the note and the card say the run ends here", async () => {
    const w = world(resumeOf(row({}, { request: { text: 12 } })));
    expect(await abandonLostWorkspace(w.ctx)).toBeUndefined();
    const note = w.registry.snapshotById("run-old")!.events.find((e) => e.type === "run_note") as { summary: string };
    expect(note.summary).toMatch(/the row's request cannot be read, so the run ends here; re-send it to run it again$/);
    expect(JSON.stringify(w.closes)).toContain("workspace lost across the restart; re-send to run again");
    expect(w.puts[0]).toMatchObject({ id: "run-old", status: "interrupted" });
  });

  it("a coordinator's child publishes child_interrupted on its record and sends child-interrupted-<runId> to its instance, so the parent's wait settles with the reason instead of walking out the budget (run-history item 47a)", async () => {
    const sent: Array<{ instance: string; type: string; payload: unknown }> = [];
    const workflow: WorkflowSender = {
      get: (instance) =>
        Promise.resolve({
          sendEvent: async (event: { type: string; payload: unknown }) => {
            sent.push({ instance, ...event });
          },
        }),
    };
    const w = world(resumeOf(row()));
    const restart = await abandonLostWorkspace({
      ...w.ctx,
      coordinator: { parentInstanceId: "plan-fix-1", idempotencyKey: "plan-fix-1:U10/0/coding" },
      workflow,
    });
    expect(restart).toBeDefined();
    const event = w.registry.snapshotById("run-old")!.events.find((e) => e.type === "child_interrupted") as {
      parentInstanceId: string;
      reason: string;
    };
    expect(event.parentInstanceId).toBe("plan-fix-1");
    expect(event.reason).toContain("the run's workspace could not be re-attached");
    expect(sent).toEqual([
      {
        instance: "plan-fix-1",
        type: "child-interrupted-run-old",
        payload: {
          runId: "run-old",
          kind: "interrupted",
          reason: event.reason,
          at: NOW,
          parentInstanceId: "plan-fix-1",
        },
      },
    ]);
    // The closed row's record carries the typed event past the highest replayed seq.
    const recorded = w.puts[0].events.map((e) => e as { type: string; seq?: number });
    expect(recorded.map((e) => e.type)).toEqual(["input", "run_note", "child_interrupted"]);
    expect(recorded[2]).toMatchObject({ seq: 6 });
  });

  it("a run no coordinator spawned publishes no child event and sends nothing", async () => {
    const w = world(resumeOf(row()));
    await abandonLostWorkspace(w.ctx);
    expect(w.registry.snapshotById("run-old")!.events.some((e) => e.type === "child_interrupted")).toBe(false);
  });

  it("announceChildRoll for a resumed child publishes child_resumed and sends child-resumed-<runId>; a refusing engine is swallowed, never thrown (run-history item 47a)", async () => {
    const w = world(resumeOf(row()));
    const refusing: WorkflowSender = {
      get: () =>
        Promise.resolve({
          sendEvent: async () => {
            throw new Error("instance ended");
          },
        }),
    };
    const event = await announceChildRoll({
      registry: w.registry,
      runId: "run-old",
      coordinator: { parentInstanceId: "plan-fix-1", idempotencyKey: "plan-fix-1:U10/0/coding" },
      kind: "resumed",
      reason: "resumed after a restart: the run's workspace was re-attached and the run carries on",
      clock: () => NOW,
      workflow: refusing,
    });
    expect(event).toEqual({
      type: "child_resumed",
      parentInstanceId: "plan-fix-1",
      summary: "resumed after a restart: the run's workspace was re-attached and the run carries on",
      at: NOW,
    });
    const published = w.registry.snapshotById("run-old")!.events.find((e) => e.type === "child_resumed");
    expect(published).toMatchObject({ parentInstanceId: "plan-fix-1" });
  });

  it("lostWorkspaceNote names the refusal and whether the run restarts", () => {
    expect(lostWorkspaceNote("resident unreachable (fetch failed)", true)).toBe(
      "resumed after a restart: the run's workspace could not be re-attached (resident unreachable (fetch failed)); the run restarts from its request as a new run in this thread",
    );
  });
});

describe("prepareRestartTurn: the request runs again as its own dispatch", () => {
  it("carries the coordinator tag the interrupted run had, so a ship child restarted from its request keeps its unit branch as its own push target and the plan's base as its pull request's base (run-history item 48a)", () => {
    const coordinator = { parentInstanceId: "plan-p", idempotencyKey: "plan-p:u1/0/coding", base: "main" };
    const turn = prepareRestartTurn(
      { clock: () => NOW },
      { request: REQUEST, pending: [], clock: () => NOW, restartOf: "run-old", coordinator },
    );
    expect(turn.opts.coordinator).toEqual(coordinator);
    expect(turn.opts.restartOf).toBe("run-old");
    // a run no coordinator spawned restarts without one
    expect(
      "coordinator" in
        prepareRestartTurn({ clock: () => NOW }, { request: REQUEST, pending: [], clock: () => NOW }).opts,
    ).toBe(false);
  });
  it("keeps the request as the row carried it, stamps a fresh receipt, and opens a root of its own", () => {
    const turn = prepareRestartTurn({ clock: () => NOW }, { request: REQUEST, pending: [], clock: () => NOW });
    expect(turn.msg).toMatchObject({ ...REQUEST, receivedAt: NOW });
    expect(turn.msg.originAt).toBeUndefined();
    expect(turn.opts.trace.root.name).toBe("request");
    expect(turn.opts).not.toHaveProperty("restartOf");
  });

  it("names the run it restarts on the dispatch options, so admission never steers the request into that run's row (thread-admission item 5)", () => {
    const turn = prepareRestartTurn(
      { clock: () => NOW },
      { request: REQUEST, pending: [], clock: () => NOW, restartOf: "run-closed" },
    );
    expect(turn.opts.restartOf).toBe("run-closed");
  });

  it("appends the follow-ups the resumed run never consumed, their attachments merged after the request's own", () => {
    const pending: PersonFollowUp[] = [
      {
        text: "also bump the version",
        userId: "slack:UY",
        at: 7_000,
        images: [{ data: "aa", mediaType: "image/png" }],
        msg: { ...REQUEST, text: "also bump the version" },
        io: {
          reply: async () => {},
          status: async () => ({ update: () => {}, done: async () => {} }),
          history: async () => [],
        },
      },
    ];
    const turn = prepareRestartTurn(
      { clock: () => NOW },
      { request: { ...REQUEST, images: [{ data: "bb", mediaType: "image/png" }] }, pending, clock: () => NOW },
    );
    expect(turn.msg.text).toBe("agent:coding fix the resolver\n\nalso bump the version");
    expect(turn.msg.images?.map((i) => i.data)).toEqual(["bb", "aa"]);
    expect(turn.msg.userId).toBe("slack:UX"); // the request's own sender, not the follow-up's
  });
});
