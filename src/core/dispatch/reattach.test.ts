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
  carriedRunIdentity,
  carriedWorkspaceBinding,
  lostWorkspaceNote,
  prepareRestartTurn,
  recordRestartDeath,
} from "./reattach.js";
import type { PersonFollowUp } from "./settle.js";
import { RESTART_CLAIM_GRACE_MS } from "../budgets.js";

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
    expect(restart?.request).toMatchObject({
      text: "agent:coding fix the resolver",
      threadKey: "slack:CX:1.0",
      userId: "slack:UX",
    });
    // The closed record rides back with the request (issue 2081): the caller
    // keeps it so a restart dispatch that dies before the successor's claim
    // can end the record for real.
    expect(restart?.closed).toMatchObject({ id: "run-old", status: "interrupted", restarting: true });
    expect(w.refusals).toEqual(["workspace_lost"]);
    const note = w.registry
      .snapshotById("run-old")!
      .events.find((e) => e.type === "run_note" && (e as { kind: string }).kind === "resumed") as { summary: string };
    expect(note.summary).toBe(
      "resumed after a restart: the run's workspace could not be re-attached (reuse-refused: no worktree at /workspace/threads/t/main); the run restarts from its request under the same run id",
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
    expect(note.summary).toMatch(
      /this is a bug: the row's request cannot be read, so the run ends here and no replacement run starts$/,
    );
    expect(JSON.stringify(w.closes)).toContain(
      "this is a bug: the workspace was lost across the restart, the request could not be read, and no replacement run starts",
    );
    expect(w.puts[0]).toMatchObject({ id: "run-old", status: "interrupted" });
  });

  it("a coordinator's child whose request RESTARTS publishes child_resumed and sends child-resumed-<runId>: the resume succeeded, so the parent keeps waiting and the pipeline never ends over it (issues 1903/1876)", async () => {
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
    expect(w.registry.snapshotById("run-old")!.events.some((e) => e.type === "child_interrupted")).toBe(false);
    const event = w.registry.snapshotById("run-old")!.events.find((e) => e.type === "child_resumed") as {
      parentInstanceId: string;
      summary: string;
    };
    expect(event.parentInstanceId).toBe("plan-fix-1");
    expect(event.summary).toContain("the run's workspace could not be re-attached");
    expect(sent).toEqual([
      {
        instance: "plan-fix-1",
        type: "child-resumed-run-old",
        payload: {
          runId: "run-old",
          kind: "resumed",
          reason: event.summary,
          at: NOW,
          parentInstanceId: "plan-fix-1",
        },
      },
    ]);
    // The closed row's record carries the typed event past the highest replayed seq.
    const recorded = w.puts[0].events.map((e) => e as { type: string; seq?: number });
    expect(recorded.map((e) => e.type)).toEqual(["input", "run_note", "child_resumed"]);
    expect(recorded[2]).toMatchObject({ seq: 6 });
  });

  it("a coordinator's child whose request CANNOT restart publishes child_interrupted and sends child-interrupted-<runId>, so the parent's wait settles with the reason — the resume failed, the unit ends (run-history item 47a)", async () => {
    const sent: Array<{ instance: string; type: string; payload: unknown }> = [];
    const workflow: WorkflowSender = {
      get: (instance) =>
        Promise.resolve({
          sendEvent: async (event: { type: string; payload: unknown }) => {
            sent.push({ instance, ...event });
          },
        }),
    };
    const w = world(resumeOf(row({}, { request: { text: 12 } })));
    const restart = await abandonLostWorkspace({
      ...w.ctx,
      coordinator: { parentInstanceId: "plan-fix-1", idempotencyKey: "plan-fix-1:U10/0/coding" },
      workflow,
    });
    expect(restart).toBeUndefined();
    const event = w.registry.snapshotById("run-old")!.events.find((e) => e.type === "child_interrupted") as {
      parentInstanceId: string;
      reason: string;
    };
    expect(event.parentInstanceId).toBe("plan-fix-1");
    expect(event.reason).toContain("the run's workspace could not be re-attached");
    expect(sent.map((s) => s.type)).toEqual(["child-interrupted-run-old"]);
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
      "resumed after a restart: the run's workspace could not be re-attached (resident unreachable (fetch failed)); the run restarts from its request under the same run id",
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

  it("carries the predecessor's identity onto the dispatch options (run-history item 54): the restart keeps the run's id, its events, its token and its start, and the replacement's user-words note rides along", () => {
    const registry = new RunRegistry({ genId: () => "run-old", genToken: () => "tok-old" });
    const run = registry.create("label", undefined, { startedAt: 5_000 });
    registry.publish(run.id, { type: "input", messageId: "m1", text: "fix it", at: 6_000 });
    const carried = carriedRunIdentity(registry, "run-old", "container replaced, resumed from the request");
    expect(carried).toMatchObject({
      token: "tok-old",
      startedAt: 5_000,
      note: "container replaced, resumed from the request",
    });
    expect(carried?.events.map((e) => e.type)).toEqual(["input"]);
    const turn = prepareRestartTurn(
      { clock: () => NOW },
      { request: REQUEST, pending: [], clock: () => NOW, restartOf: "run-old", carried },
    );
    expect(turn.opts.restartCarried).toBe(carried);
    // A row already gone — discarded, evicted — carries nothing: the restart
    // runs under a fresh id, a page that moved, never a request that vanished.
    expect(carriedRunIdentity(registry, "run-gone", "x")).toBeUndefined();
  });

  it("names the run it restarts on the dispatch options, so admission never steers the request into that run's row (thread-admission item 5)", () => {
    const turn = prepareRestartTurn(
      { clock: () => NOW },
      { request: REQUEST, pending: [], clock: () => NOW, restartOf: "run-closed" },
    );
    expect(turn.opts.restartOf).toBe("run-closed");
  });

  it("stamps the predecessor on its root at start (restartOfRunId) and no queued numbers, so the page names the run it restarts instead of counting its lifetime as a wait", () => {
    const turn = prepareRestartTurn(
      { clock: () => NOW },
      { request: { ...REQUEST, originAt: NOW - 1_718_000 }, pending: [], clock: () => NOW, restartOf: "run-old" },
    );
    expect(turn.opts.trace.root.record().attrs).toEqual({ channel: "slack", restartOfRunId: "run-old" });
    // Without a predecessor (nothing to name) the root carries neither.
    const bare = prepareRestartTurn({ clock: () => NOW }, { request: REQUEST, pending: [], clock: () => NOW });
    expect(bare.opts.trace.root.record().attrs).toEqual({ channel: "slack" });
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
    expect(turn.msg.text).toBe("agent:coding fix the resolver\n\nslack:UY: also bump the version");
    expect(turn.msg.images?.map((i) => i.data)).toEqual(["bb", "aa"]);
    expect(turn.msg.userId).toBe("slack:UX"); // the request's own sender, not the follow-up's
  });
});

describe("the restarting ending", () => {
  function world(resume: ResumeContext) {
    const registry = new RunRegistry({ genId: () => "run-old", genToken: () => "tok" });
    const run = registry.create("label", { channelId: "slack:CX", userId: "slack:UX", threadKey: "slack:CX:1.0" });
    const puts: RunRecord[] = [];
    const ledgerRun = new NullLedgerRun("run-old", { put: async (r) => void puts.push(r), abandoned: () => {} });
    const shell = createCardShell({ label: "*coding*", startedAt: 5_000, now: () => NOW });
    const ctx = {
      msg: REQUEST,
      io: {
        reply: async () => {},
        status: async () => ({ update: () => {}, done: async () => {} }),
        history: async () => [],
      },
      refuse: async <T>(_outcome: string, fn: () => Promise<T>) => fn(),
      card: { update: () => {}, done: async () => {} },
      shell,
      closeLines: () => ({}),
      clock: () => NOW,
      run,
      registry,
      resume,
      ledgerRun,
      why: "reuse-refused: no worktree",
    };
    return { ctx, puts };
  }
  const resumeWith = (r: LiveRunRow): ResumeContext => ({
    row: r,
    lastStep,
    plan: { kind: "finish", step: 1, answer: "x", stepRecorded: true } as unknown as ResumeContext["plan"],
    events: [{ type: "input", messageId: "m1", text: "fix the resolver", at: 1, seq: 1 }],
    lastSeq: 4,
    repoCtx: { repo: "acme/api" },
    inbox: [],
  });

  it("a close a restart follows carries `restarting: true` on its record, and one no restart follows does not — the ending says the run carries on, so a waiting parent re-arms instead of ending its unit (run-history item 47a)", async () => {
    const restarts = world(resumeWith(row()));
    expect(await abandonLostWorkspace(restarts.ctx)).toBeDefined();
    expect(restarts.puts[0]).toMatchObject({
      status: "interrupted",
      restarting: true,
      finishedAt: NOW,
      restartUntil: NOW + RESTART_CLAIM_GRACE_MS,
    });
    const ends = world(resumeWith(row({}, { request: undefined })));
    expect(await abandonLostWorkspace(ends.ctx)).toBeUndefined();
    expect(ends.puts[0].status).toBe("interrupted");
    expect(ends.puts[0].restarting).toBeUndefined();
    expect(ends.puts[0].restartUntil).toBeUndefined();
  });
});

// Feature: issue 2081 — a restart dispatch that dies between the `restarting`
// close and the successor's claim must not leave the record answering
// still-running until the unit's wall clock runs out: the death is recorded as
// the ending, and the record reads `interrupted` with the roll's own cause.
describe("recordRestartDeath: the restart died between the restarting close and the successor's claim (issue 2081)", () => {
  async function closedRestartingRecord(): Promise<RunRecord> {
    const registry = new RunRegistry({ genId: () => "run-old", genToken: () => "tok" });
    const run = registry.create("label", { channelId: "slack:CX", userId: "slack:UX", threadKey: "slack:CX:1.0" });
    const puts: RunRecord[] = [];
    const ledgerRun = new NullLedgerRun("run-old", { put: async (r) => void puts.push(r), abandoned: () => {} });
    const shell = createCardShell({ label: "*coding*", startedAt: 5_000, now: () => NOW });
    await abandonLostWorkspace({
      msg: REQUEST,
      io: {
        reply: async () => {},
        status: async () => ({ update: () => {}, done: async () => {} }),
        history: async () => [],
      },
      refuse: async <T>(_outcome: string, fn: () => Promise<T>) => fn(),
      card: { update: () => {}, done: async () => {} },
      shell,
      closeLines: () => ({}),
      clock: () => NOW,
      run,
      registry,
      resume: {
        row: row(),
        lastStep,
        plan: { kind: "finish", step: 1, answer: "x", stepRecorded: true } as unknown as ResumeContext["plan"],
        events: [{ type: "input", messageId: "m1", text: "fix the resolver", at: 1, seq: 1 }],
        lastSeq: 4,
        repoCtx: { repo: "acme/api" },
        inbox: [],
      },
      ledgerRun,
      why: "reuse-refused: no worktree",
    });
    return puts[0];
  }

  it("ends the record for real: `restarting` dropped, one `restart_died` note appended past the highest seq naming how the dispatch ended, every earlier event kept — so the interruption's cause is still the roll's own words, never the dispatch error's", async () => {
    const closed = await closedRestartingRecord();
    expect(closed).toMatchObject({ restarting: true });
    const written: RunRecord[] = [];
    await recordRestartDeath({
      writer: { write: (r) => void written.push(r) },
      closed,
      why: "boom at admission",
      clock: () => NOW + 1,
    });
    expect(written).toHaveLength(1);
    const ended = written[0];
    expect(ended.id).toBe("run-old");
    expect(ended.status).toBe("interrupted");
    expect(ended.restarting).toBeUndefined();
    expect(ended.restartUntil).toBeUndefined();
    // The earlier events — the workspace-lost `resumed` note among them — stand
    // untouched, and the death note lands past the highest replayed seq.
    expect(ended.events.slice(0, closed.events.length)).toEqual(closed.events);
    const death = ended.events.at(-1) as { type: string; kind?: string; summary?: string; seq?: number; at?: number };
    expect(death).toMatchObject({ type: "run_note", kind: "restart_died", seq: 6, at: NOW + 1 });
    expect(death.summary).toBe(
      "the restart from the request died before it claimed the run (boom at admission); this close is the run's end",
    );
    expect(ended.eventCount).toBe(closed.eventCount + 1);
  });

  it("a coordinator's child tells its parent `child-interrupted-<runId>` with the death as the reason, so the wait settles now instead of at its chunk's end", async () => {
    const closed = await closedRestartingRecord();
    const sent: Array<{ instance: string; type: string; payload: unknown }> = [];
    const workflow: WorkflowSender = {
      get: (instance) =>
        Promise.resolve({
          sendEvent: async (event: { type: string; payload: unknown }) => {
            sent.push({ instance, ...event });
          },
        }),
    };
    await recordRestartDeath({
      writer: { write: () => {} },
      closed,
      why: "the restart's dispatch ended failed",
      clock: () => NOW + 1,
      coordinator: { parentInstanceId: "plan-fix-1", idempotencyKey: "plan-fix-1:U10/0/coding" },
      workflow,
    });
    expect(sent).toEqual([
      {
        instance: "plan-fix-1",
        type: "child-interrupted-run-old",
        payload: {
          runId: "run-old",
          parentInstanceId: "plan-fix-1",
          kind: "interrupted",
          reason:
            "the restart from the request died before it claimed the run (the restart's dispatch ended failed); this close is the run's end",
          at: NOW + 1,
        },
      },
    ]);
  });

  it("a refusing workflow engine is swallowed, never thrown — the record's write already happened and the next read-record answers interrupted anyway", async () => {
    const closed = await closedRestartingRecord();
    const written: RunRecord[] = [];
    const refusing: WorkflowSender = {
      get: () =>
        Promise.resolve({
          sendEvent: async () => {
            throw new Error("instance ended");
          },
        }),
    };
    await expect(
      recordRestartDeath({
        writer: { write: (r) => void written.push(r) },
        closed,
        why: "boom",
        clock: () => NOW + 1,
        coordinator: { parentInstanceId: "plan-fix-1", idempotencyKey: "plan-fix-1:U10/0/coding" },
        workflow: refusing,
      }),
    ).resolves.toBeUndefined();
    expect(written).toHaveLength(1);
  });
});
