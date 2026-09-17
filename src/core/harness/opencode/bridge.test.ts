import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../chatMessage.js";
import { analyzeRunFriction, isSetupInstallCommand } from "../../runFriction.js";
import { planResume, type KnownTool } from "../../runLedger/resume.js";
import { bearerHashOf } from "../../modelProxy/runBearers.js";
import type { RunEvent } from "../../runEvents.js";
import type { StepReport } from "../../runLedger/stepReport.js";
import { ExecInfraError } from "../../../execution/executor.js";
import { identityChangedCondition } from "../container.js";
import { HarnessContainerReplacedError } from "../contract.js";
import { piDriver } from "../pi/testing/driver.js";
import { TRANSPORT_LOST_TEXT } from "../testing/fakeContainer.js";
import type { DrivenRun, RunScript } from "../testing/scenarios.js";
import type { OpenCodeFeedRecord } from "./client.js";
import {
  judgeOpenCodeAsk,
  openCodeToolNameWord,
  OpenCodeBridge,
  projectStore,
  type OpenCodeBridgeObservation,
} from "./bridge.js";
import { OPENCODE_EVENT_DISPOSITION, openCodeDispositionCounts, openCodeDispositionOf } from "./dispositions.js";
import { openCodeReplacedCallNote } from "./session.js";
import { openCodeRunPaths } from "./process.js";
import { feedByteLength, openCodeDriver, TAILER_READY_NOTES } from "./testing/driver.js";
import { loopClock, MINUTE_MS } from "../../budgets.js";
import { CONFORMANCE_MAX_MINUTES, FAILED_MODEL_CALL_ERROR } from "../testing/scenarios.js";
import {
  finaleAbortReason,
  finaleTimedOutNote,
  MODEL_CALL_IN_FLIGHT,
  softStopAnswer,
  softStopNote,
  timeBudgetAnswer,
  timeBudgetNote,
  windDownFailureNote,
} from "../windDown.js";
import { FIRST_EVENT_BOUND_MS } from "./bridge.js";

/** The finale bound the conformance run's lease carries (the drivers' preset runs no post-step). */
const FINALE_MS = loopClock(0, CONFORMANCE_MAX_MINUTES * MINUTE_MS, "conformance").finaleMs;

// Feature: docs/reference/specs/harness.md items 2 and 4 — OpenCode's gate and
// record. Every tool call is decided in the bot over the HTTP ask; a reply the
// bot did not send fails the run closed (the honest cannot); every event has a
// disposition; the transcript is mirrored into ledger steps `planResume` reads
// as it reads pi's.

const NOW = 1_700_000_000_000;

function harness(opts: { identity?: "write" | "read" | "none"; relayed?: string[] } = {}) {
  const events: RunEvent[] = [];
  const steps: StepReport[] = [];
  const progress: string[] = [];
  const bridge = new OpenCodeBridge({
    emit: (e) => void events.push(e),
    onProgress: (n) => void progress.push(n),
    clock: () => NOW,
    rules: { identity: opts.identity ?? "write", checkout: "/workspace/threads/t/main", protectedBranches: ["main"] },
    relayedToolNames: new Set(opts.relayed ?? ["update_status"]),
    onStep: async (r) => void steps.push(r),
    seedLength: 1,
    remainingMs: () => 600_000,
  });
  return { bridge, events, steps, progress };
}

const ev = (type: string, data: Record<string, unknown> = {}): OpenCodeFeedRecord => ({
  feed: "event",
  at: NOW,
  event: { id: `evt_${type}`, type, created: NOW, data },
});
const notes = (events: RunEvent[]) =>
  events.filter((e): e is Extract<RunEvent, { type: "run_note" }> => e.type === "run_note");

describe("OPENCODE_EVENT_DISPOSITION — every event the server streams is decided", () => {
  it("names every type in the pinned protocol's server manifest (plus server.connected) and nothing else", async () => {
    const { EventManifest } = (await import("@opencode/schema/event-manifest")) as {
      EventManifest: { ServerDefinitions: ReadonlyArray<{ type: string }> };
    };
    const catalogue = new Set(EventManifest.ServerDefinitions.map((d) => d.type));
    for (const type of catalogue) expect(openCodeDispositionOf(type), `${type} has no disposition`).toBeDefined();
    // The table's keys are exactly the catalogue plus the stream's own marker.
    const expected = new Set([...catalogue, "server.connected"]);
    expect(new Set(Object.keys(OPENCODE_EVENT_DISPOSITION))).toEqual(expected);
  });

  it("classifies the record's kinds as the clause needs: the tool call mapped, the deltas folded, the step boundaries structure, the asks and failures notes, the reverts and shell features impossible; an rpc event is folded and an unknown kind is undecided", () => {
    expect(openCodeDispositionOf("session.tool.called")).toBe("mapped");
    expect(openCodeDispositionOf("session.tool.success")).toBe("mapped");
    expect(openCodeDispositionOf("session.compaction.ended")).toBe("mapped");
    // The narration's end is written (the `assistant` event, the answer); its
    // start and the reasoning land nowhere and say so.
    expect(openCodeDispositionOf("session.text.ended")).toBe("mapped");
    expect(openCodeDispositionOf("session.text.started")).toBe("structure");
    expect(openCodeDispositionOf("session.reasoning.started")).toBe("structure");
    expect(openCodeDispositionOf("session.reasoning.ended")).toBe("structure");
    expect(openCodeDispositionOf("session.text.delta")).toBe("folded");
    expect(openCodeDispositionOf("session.step.streamed")).toBe("folded");
    expect(openCodeDispositionOf("session.step.ended")).toBe("structure");
    expect(openCodeDispositionOf("permission.asked")).toBe("note");
    expect(openCodeDispositionOf("session.execution.failed")).toBe("note");
    expect(openCodeDispositionOf("session.revert.staged")).toBe("impossible");
    expect(openCodeDispositionOf("session.shell.started")).toBe("impossible");
    expect(openCodeDispositionOf("rpc.some.plugin.call")).toBe("folded");
    expect(openCodeDispositionOf("session.made.up.kind")).toBeUndefined();
  });

  it("its counts by class — the record table at a glance", () => {
    const counts = openCodeDispositionCounts();
    expect(counts.mapped + counts.structure + counts.folded + counts.note + counts.impossible).toBe(
      Object.keys(OPENCODE_EVENT_DISPOSITION).length,
    );
    expect(counts.mapped).toBeGreaterThan(0);
    expect(counts.note).toBeGreaterThan(0);
    expect(counts.impossible).toBeGreaterThan(0);
  });
});

describe("projectStore — the store's messages as pi-shaped turns, the seed skipped", () => {
  it("splits an assistant message with a completed tool into its assistant turn and a user turn for the result; a text-only turn is one assistant turn; the leading seed message is skipped", () => {
    const store = [
      { id: "msg_u0", type: "user", text: "do the thing", time: { created: NOW } },
      {
        id: "msg_a0",
        type: "assistant",
        content: [
          { type: "text", text: "checking" },
          {
            type: "tool",
            id: "c1",
            name: "shell",
            state: { status: "completed", input: { command: "echo hi" }, content: [{ type: "text", text: "hi" }] },
          },
        ],
      },
      { id: "msg_a1", type: "assistant", content: [{ type: "text", text: "all done" }] },
    ] as never;
    expect(projectStore(store, 1)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "c1", name: "bash", input: { command: "echo hi" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "c1", content: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "all done" }] },
    ]);
  });

  it("a rejected tool becomes an error tool_result carrying the reason", () => {
    const store = [
      { id: "msg_u0", type: "user", text: "go", time: { created: NOW } },
      {
        id: "msg_a0",
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "c1",
            name: "shell",
            state: {
              status: "error",
              input: { command: "git push origin main" },
              content: [{ type: "text", text: "repo:use — push to `main`" }],
            },
          },
        ],
      },
    ] as never;
    expect(projectStore(store, 1)).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "git push origin main" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "c1", content: "repo:use — push to `main`", isError: true }],
      },
    ]);
  });
});

describe("openCodeToolNameWord and judgeOpenCodeAsk — the gate in pi's words", () => {
  it("maps the tool name for the record and the action for the gate", () => {
    expect(openCodeToolNameWord("shell")).toBe("bash");
    expect(openCodeToolNameWord("glob")).toBe("find");
    expect(openCodeToolNameWord("read")).toBe("read");
  });

  it("allows a read under the checkout and refuses a push to the protected base, with the rule's reason as the reply message", () => {
    const rules = { identity: "write" as const, checkout: "/w/threads/t/main", protectedBranches: ["main"] };
    const relayed = new Set<string>();
    expect(judgeOpenCodeAsk("grep", ["needle"], rules, relayed).reply).toBe("once");
    const push = judgeOpenCodeAsk("shell", ["git push origin main"], rules, relayed);
    expect(push.reply).toBe("reject");
    expect(push.message).toMatch(/main/);
    // A relayed tool is allowed by name (it runs in the bot under the bot's gates).
    expect(judgeOpenCodeAsk("update_status", ["*"], rules, new Set(["update_status"])).reply).toBe("once");
  });

  it("under identity none the model's shell is refused as outside its reach", () => {
    const none = { identity: "none" as const, checkout: "/w", protectedBranches: [] };
    expect(judgeOpenCodeAsk("shell", ["ls"], none, new Set()).reply).toBe("reject");
  });
});

/** One ask on the stream: the call, what it asks, as `permission.asked` carries it. */
const asked = (requestID: string, callId: string, action: string, resource: string) =>
  ev("permission.asked", {
    id: requestID,
    sessionID: "ses_c",
    action,
    resources: [resource],
    source: { type: "tool", messageID: "msg_a0", id: callId },
  });
const replied = (requestID: string, reply: "once" | "reject") =>
  ev("permission.replied", { sessionID: "ses_c", requestID, reply });
const settled = (type: "session.tool.success" | "session.tool.failed", callId: string) =>
  ev(type, {
    sessionID: "ses_c",
    assistantMessageID: "msg_a0",
    id: callId,
    ...(type === "session.tool.success"
      ? { content: [{ type: "text", text: "ran" }] }
      : { error: { type: "permission.rejected", message: "rejected" } }),
    executed: false,
  });

describe("the gate's honest cannot, the compaction row, the budget stop, the unknown kind", () => {
  it("a permission.replied the bot did not send — one that raced ahead of the bot's decision, for an ask it never saw — is a bypass (a forged approval)", () => {
    const { bridge, events } = harness();
    const obs = bridge.observe(replied("per_forged", "once"));
    expect(obs.bypass).toBeDefined();
    expect(obs.bypass?.message).toMatch(/forged|did not send|not decided/);
    expect(notes(events).some((n) => n.kind === "harness_error")).toBe(true);
  });

  it("the bot's own reply — decided at the ask, the same effect, the first echo — is not a bypass", () => {
    const { bridge } = harness();
    const ask = bridge.observe(asked("per_1", "c1", "shell", "ls"));
    expect(ask.replies).toEqual([{ requestID: "per_1", callId: "c1", reply: "once" }]);
    expect(bridge.observe(replied("per_1", "once")).bypass).toBeUndefined();
  });

  it("a forged `once` for an ask the bot rejected — the effect differs from the bot's recorded decision — is a bypass", () => {
    const { bridge, events } = harness();
    const ask = bridge.observe(asked("per_2", "c2", "shell", "git push origin main"));
    expect(ask.replies[0]?.reply).toBe("reject");
    const forged = bridge.observe(replied("per_2", "once"));
    expect(forged.bypass).toBeDefined();
    expect(forged.bypass?.message).toMatch(/once.*reject|overrid/i);
    expect(notes(events).some((n) => n.kind === "harness_error" && /per_2/.test(n.summary))).toBe(true);
  });

  it("a second permission.replied for the same request id — a duplicate after the bot's echo — is a bypass", () => {
    const { bridge } = harness();
    bridge.observe(asked("per_3", "c3", "shell", "ls"));
    expect(bridge.observe(replied("per_3", "once")).bypass).toBeUndefined();
    const duplicate = bridge.observe(replied("per_3", "once"));
    expect(duplicate.bypass).toBeDefined();
    expect(duplicate.bypass?.message).toMatch(/second|duplicate/i);
  });

  it("a tool success for a call the bot rejected ran against the reject and is a bypass; the rejection's own failure is not", () => {
    const { bridge } = harness();
    bridge.observe(asked("per_4", "c4", "shell", "git push origin main"));
    // OpenCode fails the rejected call with the bot's feedback: that is the reject landing, not a run.
    expect(bridge.observe(settled("session.tool.failed", "c4")).bypass).toBeUndefined();
    const ranAnyway = harness();
    ranAnyway.bridge.observe(asked("per_5", "c5", "shell", "git push origin main"));
    const success = ranAnyway.bridge.observe(settled("session.tool.success", "c5"));
    expect(success.bypass).toBeDefined();
    expect(success.bypass?.message).toMatch(/a success after the bot's refusal/);
  });

  it("a session.compaction.ended with text is a compacted note and a compaction row; without text it is a note alone", async () => {
    const withText = harness();
    withText.bridge.observe(
      ev("session.compaction.ended", { sessionID: "ses_c", reason: "auto", text: "the summary of the earlier turns" }),
    );
    await withText.bridge.flush();
    expect(notes(withText.events).some((n) => n.kind === "compacted")).toBe(true);
    expect(withText.steps.some((s) => s.compaction?.summary === "the summary of the earlier turns")).toBe(true);

    const noText = harness();
    noText.bridge.observe(ev("session.compaction.ended", { sessionID: "ses_c", reason: "auto", text: "" }));
    await noText.bridge.flush();
    expect(notes(noText.events).some((n) => n.kind === "compacted")).toBe(true);
    expect(noText.steps.some((s) => s.compaction !== undefined)).toBe(false);
  });

  it("the budget stop is the proxy's typed 403 refusal — `turn_budget_exhausted` — not any 403 and not any message that mentions 403", () => {
    const { bridge } = harness();
    const failed = (error: Record<string, unknown>) =>
      bridge.observe(ev("session.execution.failed", { sessionID: "ses_c", error }));
    // The proxy's refusal body, as the provider library hands it on.
    expect(
      failed({ status: 403, message: '{"error":{"type":"turn_budget_exhausted","message":"past the turn guard"}}' })
        .budgetStop,
    ).toBe(true);
    // A 403 of another kind — the bearer revoked — is the run's failure, not its budget.
    const revoked = failed({ status: 403, message: '{"error":{"type":"revoked","message":"the run ended"}}' });
    expect(revoked.budgetStop).toBeUndefined();
    expect(revoked.providerError).toMatch(/revoked/);
    // A body that merely mentions 403 is not the refusal either.
    const mentions = failed({ status: 500, message: "upstream answered HTTP 403 for an unrelated asset" });
    expect(mentions.budgetStop).toBeUndefined();
    expect(mentions.providerError).toMatch(/upstream/);
  });

  it("an event kind the table does not name is a harness_error note naming it; an impossible kind is one too", () => {
    const { bridge, events } = harness();
    bridge.observe(ev("session.made.up.kind"));
    bridge.observe(ev("session.revert.staged", { sessionID: "ses_c" }));
    const errs = notes(events).filter((n) => n.kind === "harness_error");
    expect(errs.some((n) => n.summary.includes("session.made.up.kind"))).toBe(true);
    expect(errs.some((n) => n.summary.includes("session.revert.staged"))).toBe(true);
  });
});

const inputStarted = (callId: string, name: string) =>
  ev("session.tool.input.started", { sessionID: "ses_c", assistantMessageID: "msg_a0", id: callId, name });
const called = (callId: string) =>
  ev("session.tool.called", {
    sessionID: "ses_c",
    assistantMessageID: "msg_a0",
    id: callId,
    input: {},
    executed: false,
  });

describe("a pre-execution settlement is narrated by what the facts prove (F2), and a call open when the container is replaced is settled on the record", () => {
  it("a tool the identity's deny rules removed — absent from its own tools — settled with no ask is a tool_refused note naming the deny rules; a tool that is on the roster but errors before it runs is a harness_error, never dressed as a refusal", () => {
    // Under identity read, `write` is not one of the run's own tools: OpenCode
    // failed it with no ask because the tool was never there — the deny rules.
    const removed = harness({ identity: "read" });
    removed.bridge.observe(inputStarted("c1", "write"));
    removed.bridge.observe(called("c1"));
    removed.bridge.observe(settled("session.tool.failed", "c1"));
    const refusedNote = notes(removed.events).find((n) => n.kind === "tool_refused");
    expect(refusedNote?.summary).toMatch(/deny rules removed it/);
    expect(notes(removed.events).some((n) => n.kind === "harness_error")).toBe(false);

    // `read` IS on the run's own tools under identity read: a settlement with no
    // ask and nothing run is some other pre-execution failure, said as that —
    // never the deny rules, which did not remove `read`.
    const errored = harness({ identity: "read" });
    errored.bridge.observe(inputStarted("c2", "read"));
    errored.bridge.observe(called("c2"));
    errored.bridge.observe(settled("session.tool.failed", "c2"));
    const errNote = notes(errored.events).find((n) => n.kind === "harness_error");
    expect(errNote?.summary).toMatch(/before it ran, with no ask/);
    expect(notes(errored.events).some((n) => n.kind === "tool_refused")).toBe(false);
  });

  it("closeOpenSpans settles every call still open with the replaced note: each is a failed tool_result on the record carrying the note, and none is left open", () => {
    const { bridge, events } = harness();
    bridge.observe(inputStarted("c1", "shell"));
    bridge.observe(called("c1"));
    // The call is open (no success/failed): the container was replaced under it.
    bridge.closeOpenSpans((open) => openCodeReplacedCallNote(open.tool));
    const results = events.filter((e): e is Extract<RunEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ tool: "bash", ok: false, callId: "c1" });
    expect(results[0].summary).toBe(openCodeReplacedCallNote("bash"));
    // Idempotent: a second close settles nothing more (no span left open).
    bridge.closeOpenSpans((open) => openCodeReplacedCallNote(open.tool));
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(1);
  });
});

/** One end-to-end run through the fake serve. */
async function run(script: RunScript): Promise<DrivenRun> {
  return openCodeDriver().run(script);
}
const toolResults = (r: DrivenRun) =>
  r.events.filter((e): e is Extract<RunEvent, { type: "tool_result" }> => e.type === "tool_result");
const answered = (r: DrivenRun): string => (r.outcome.kind === "answered" ? r.outcome.answer : "");

describe("the acceptance examples, end to end against the fake serve", () => {
  it("AE1 — the gate decides each call: a read is allowed once and a push to the protected base is refused with the rule's reason, which the model reads in the tool's result", async () => {
    const r = await run({
      turns: [
        {
          content: [{ type: "tool_use", id: "g1", name: "grep", input: { pattern: "needle" } }],
          stopReason: "tool_use",
        },
        {
          content: [{ type: "tool_use", id: "p1", name: "bash", input: { command: "git push origin main" } }],
          stopReason: "tool_use",
        },
        { content: [{ type: "text", text: "stopped" }], stopReason: "end_turn" },
      ],
    });
    expect(answered(r)).toBe("stopped");
    expect(toolResults(r).map((t) => [t.callId, t.ok])).toEqual([
      ["g1", true],
      ["p1", false],
    ]);
    const refused = notes(r.events).find((n) => n.kind === "tool_refused");
    expect(refused?.summary).toMatch(/main/);
    // The model reads the reason: the refused call's result carries it.
    const push = toolResults(r).find((t) => t.callId === "p1");
    expect(push?.output ?? push?.summary).toMatch(/main/);
  });

  it("AE2 — a tool success for a call that never asked fails the run closed naming the tool, exactly as pi's GateBypassed (a named failure the table asserts, not a skip)", async () => {
    const r = await run({
      turns: [
        { content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "ls" } }], stopReason: "tool_use" },
        { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
      ],
      bypassGate: true,
    });
    expect(r.outcome.kind).toBe("failed");
    if (r.outcome.kind === "failed") expect(r.outcome.error.message).toMatch(/bypassed/);
    expect(notes(r.events).some((n) => n.kind === "harness_error" && /c1/.test(n.summary))).toBe(true);
    expect(r.killed.length).toBeGreaterThan(0);
  });
});

const TOOLS: KnownTool[] = [{ name: "bash" }, { name: "read", sideEffectFree: true }, { name: "update_status" }];

/** A transcript and last-step from a driver's mirrored steps, as `planResume` reads them. */
function planFor(request: string, steps: StepReport[]) {
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: request }] },
    ...steps.flatMap((s) => s.turns),
  ];
  const last = steps[steps.length - 1];
  return planResume({
    transcript: { complete: true, turns: messages.length, messages, compactions: [] },
    lastStep: {
      step: steps.length - 1,
      seq: steps.length,
      turnIndex: messages.length,
      inFlight: last.inFlight,
      inboxConsumedSeq: last.inboxConsumedSeq,
      remainingMs: last.remainingMs,
      turn: last.turn,
      iteration: last.iteration,
    },
    tools: TOOLS,
  });
}

describe("parity with pi — the mirror and the friction analyzer read OpenCode's record as they read pi's", () => {
  const script: RunScript = {
    turns: [
      { content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "npm ci" } }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "installed" }], stopReason: "end_turn" },
    ],
  };

  it("the mirrored steps have the same shape, and planResume yields the same plan kind over each", async () => {
    const oc = await openCodeDriver().run(script);
    const pi = await piDriver().run(script);
    expect(answered(oc)).toBe("installed");
    expect(answered(pi)).toBe("installed");
    // One step per assistant turn, the call in flight on the first, none on the second.
    expect(oc.steps.map((s) => s.inFlight)).toEqual([[{ callId: "c1", tool: "bash" }], []]);
    expect(pi.steps.map((s) => s.inFlight)).toEqual([[{ callId: "c1", tool: "bash" }], []]);
    expect(planFor("do the thing", oc.steps).kind).toBe(planFor("do the thing", pi.steps).kind);
    expect(planFor("do the thing", oc.steps).kind).toBe("finish");
  });

  it("analyzeRunFriction classifies the `$ cmd` summaries alike — the same command word, the same setup classification", async () => {
    const oc = await openCodeDriver().run(script);
    const pi = await piDriver().run(script);
    const summariesOf = (r: DrivenRun) =>
      r.events
        .filter((e): e is Extract<RunEvent, { type: "tool_call" }> => e.type === "tool_call")
        .map((e) => e.summary);
    expect(summariesOf(oc)).toEqual(["$ npm ci"]);
    expect(summariesOf(pi)).toEqual(["$ npm ci"]);
    expect(isSetupInstallCommand("$ npm ci")).toBe(true);
    const ocDiag = analyzeRunFriction(oc.events);
    const piDiag = analyzeRunFriction(pi.events);
    expect(ocDiag.toolCalls).toBe(piDiag.toolCalls);
  });
});

// Feature: docs/reference/specs/harness.md item 13 — the join by message id.
// The real tailer's refills carry only the messages that changed since its
// previous refill of the session (the first carries the whole store); a
// restarted tailer's first refill carries the whole store again. The bridge
// upserts every refill into one store by message id and projects the whole,
// so each turn lands on the ledger once whichever shape the refill has.
describe("the store's join by message id — a refill of the changed messages alone, or of the whole store again, writes each step once", () => {
  const user = { id: "msg_u0", type: "user", text: "do the thing", time: { created: NOW } };
  const a1 = {
    id: "msg_a1",
    type: "assistant",
    agent: "switchboard",
    model: { providerID: "switchboard", id: "m" },
    content: [
      {
        type: "tool",
        id: "c1",
        name: "shell",
        state: { status: "completed", input: { command: "echo hi" }, content: [{ type: "text", text: "hi" }] },
      },
    ],
    time: { created: NOW, completed: NOW },
  };
  const a2 = {
    id: "msg_a2",
    type: "assistant",
    agent: "switchboard",
    model: { providerID: "switchboard", id: "m" },
    content: [{ type: "text", text: "all done" }],
    time: { created: NOW, completed: NOW },
  };
  const refill = (data: unknown[]): OpenCodeFeedRecord =>
    ({ feed: "messages", at: NOW, sessionID: "ses_run-c", reason: "session.step.ended", data }) as OpenCodeFeedRecord;

  it("the second refill carrying only the new assistant message (the real tailer's shape) lands as the second step, and the answer is its text", async () => {
    const h = harness();
    h.bridge.observe(refill([user, a1]));
    h.bridge.observe(refill([a2]));
    await h.bridge.flush();
    expect(h.steps.map((s) => s.turns.map((t) => t.role))).toEqual([["assistant"], ["user", "assistant"]]);
    expect(h.steps[1].turns[0].content[0]).toMatchObject({ type: "tool_result", toolUseId: "c1", content: "hi" });
    expect(h.bridge.answer()).toBe("all done");
  });

  it("a refill of the whole store again (a restarted tailer's first refill, the fake's every refill) writes nothing twice, and a message that changed is read in its place", async () => {
    const h = harness();
    const a1Running = {
      ...a1,
      content: [{ type: "tool", id: "c1", name: "shell", state: { status: "running", input: {} } }],
    };
    h.bridge.observe(refill([user, a1Running]));
    h.bridge.observe(refill([user, a1, a2]));
    h.bridge.observe(refill([user, a1, a2]));
    await h.bridge.flush();
    expect(h.steps).toHaveLength(2);
    expect(h.steps[1].turns[0].content[0]).toMatchObject({ type: "tool_result", toolUseId: "c1", content: "hi" });
    expect(h.bridge.answer()).toBe("all done");
  });
});

describe("the loop — a reply that cannot be posted, and the narration's timing", () => {
  const oneCall: RunScript = {
    turns: [
      {
        content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo hi" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ],
  };

  it("a permission-reply POST the server answers outside 2xx stops the run by name — a harness_error, the process ended, never a turn left hanging on an unanswered ask", async () => {
    const r = await openCodeDriver({ failReplyPosts: 1 }).run(oneCall);
    expect(r.outcome.kind).toBe("failed");
    if (r.outcome.kind === "failed") {
      expect(r.outcome.error.name).toBe("OpenCodeReplyFailedError");
      expect(r.outcome.error.message).toMatch(/per_c1/);
      expect(r.outcome.error.message).toMatch(/could not be posted/);
      expect(r.outcome.error.message).toMatch(/answered 500/);
    }
    expect(notes(r.events).some((n) => n.kind === "harness_error" && /could not be posted/.test(n.summary))).toBe(true);
    // One POST: no retry — a pending ask means the tool has not run, so stopping loses nothing.
    expect(r.requests.filter((q) => /\/permission\/[^/]+\/reply$/.test(q.path))).toHaveLength(1);
    expect(r.killed.length).toBeGreaterThan(0);
  });

  it("a permission-reply POST that throws (the container gone under the request) stops the run by the same name", async () => {
    const r = await openCodeDriver({ replyPostThrows: true }).run(oneCall);
    expect(r.outcome.kind).toBe("failed");
    if (r.outcome.kind === "failed") {
      expect(r.outcome.error.name).toBe("OpenCodeReplyFailedError");
      expect(r.outcome.error.message).toMatch(/container is gone/);
    }
    expect(r.killed.length).toBeGreaterThan(0);
  });

  it("narration beside a call is emitted before that turn's tool_call — for every tool turn, the last included — and a final text-only turn is the answer, never narration", async () => {
    const r = await run({
      turns: [
        {
          content: [
            { type: "text", text: "checking the tree" },
            { type: "tool_use", id: "c1", name: "bash", input: { command: "ls" } },
          ],
          stopReason: "tool_use",
        },
        {
          content: [
            { type: "text", text: "one more look" },
            { type: "tool_use", id: "c2", name: "bash", input: { command: "ls src" } },
          ],
          stopReason: "tool_use",
        },
        { content: [{ type: "text", text: "all done" }], stopReason: "end_turn" },
      ],
    });
    expect(answered(r)).toBe("all done");
    const order = r.events
      .filter(
        (e): e is Extract<RunEvent, { type: "assistant" | "tool_call" }> =>
          e.type === "assistant" || e.type === "tool_call",
      )
      .map((e) => (e.type === "assistant" ? `assistant:${e.text}` : `tool_call:${e.callId}`));
    expect(order).toEqual(["assistant:checking the tree", "tool_call:c1", "assistant:one more look", "tool_call:c2"]);
  });
});

// Feature: docs/reference/specs/harness.md items 5 and 13 — the answer to every
// request the harness makes is read and a refusal fails the run by name at
// once; an admitted prompt owes the feed its first event within a bound, past
// which the run fails by name with the diagnostics; and the wind-down's ending
// seals on a turn that never answers: the finale bound interrupts it, the loop
// leaves without waiting on a settle, the process is ended, and the run closes
// by the wind-down's own answer — never a replaced verdict, never a wait to the
// budget. The two live runs that met the model-reference defect hung for the
// want of all three.
describe("the loop — a refused request, a silent server, and a hung turn", () => {
  const oneTurn: RunScript = { turns: [{ content: [{ type: "text", text: "done" }], stopReason: "end_turn" }] };
  const hung: RunScript = {
    turns: [
      {
        content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo hi" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
    ],
    hangModelCall: 2,
  };
  const harnessErrors = (r: DrivenRun) =>
    notes(r.events)
      .filter((n) => n.kind === "harness_error")
      .map((n) => n.summary);
  const posts = (r: DrivenRun, suffix: string) =>
    r.requests.filter((q) => q.method === "POST" && q.path.endsWith(suffix));
  const steers = (r: DrivenRun) =>
    posts(r, "/prompt").filter((q) => (JSON.parse(q.body ?? "{}") as { delivery?: string }).delivery === "steer");
  const failedWith = (r: DrivenRun, name: string): Error => {
    expect(r.outcome.kind).toBe("failed");
    const err = r.outcome.kind === "failed" ? r.outcome.error : new Error("answered");
    expect(err.name).toBe(name);
    return err;
  };

  it("the prompt the server refuses fails the run by name at once — a harness_error naming the prompt and the server's answer, the outcome OpenCodeRequestRefusedError, one POST and no wait on the feed, the process ended", async () => {
    const r = await openCodeDriver({ promptPostFails: 1 }).run(oneTurn);
    const err = failedWith(r, "OpenCodeRequestRefusedError");
    expect(err.message).toBe('OpenCode refused the prompt (500): {"error":"the store hiccuped"}');
    expect(harnessErrors(r)).toEqual([`${err.message} — the run is stopped`]);
    expect(posts(r, "/prompt")).toHaveLength(1);
    expect(r.killed.length).toBeGreaterThan(0);
    expect(r.removed).toEqual([openCodeRunPaths("run-c").dir]);
    expect(notes(r.events).some((n) => n.kind === "sandbox_restarted")).toBe(false);
  });

  it("a resume's continue the server refuses is named as the continue", async () => {
    const driver = openCodeDriver({ promptPostFails: 1 });
    const r = await driver.run({
      ...oneTurn,
      resume: {
        messages: [{ role: "user", content: [{ type: "text", text: "carry on" }] }],
        settlements: [],
        remainingMs: 300_000,
        turn: 0,
        inboxConsumedSeq: 0,
        facts: driver.facts({ pid: 999, container: "vm-old" }),
      },
    });
    const err = failedWith(r, "OpenCodeRequestRefusedError");
    expect(err.message).toMatch(/^OpenCode refused the continue \(500\)/);
    expect(harnessErrors(r)).toEqual([`${err.message} — the run is stopped`]);
  });

  it("the prime the server refuses — the seed's import, or the create of a seedless run — fails the run by name with a harness_error first, before any prompt", async () => {
    const seeded = await openCodeDriver({ primePostFails: true }).run({
      seed: [
        { role: "user", content: [{ type: "text", text: "earlier" }] },
        { role: "assistant", content: [{ type: "text", text: "answered" }] },
      ],
      turns: oneTurn.turns,
    });
    const imported = failedWith(seeded, "OpenCodeRequestRefusedError");
    expect(imported.message).toBe('OpenCode refused the session import (500): {"error":"the store hiccuped"}');
    expect(harnessErrors(seeded)).toEqual([`${imported.message} — the run is stopped`]);
    expect(posts(seeded, "/prompt")).toHaveLength(0);
    expect(seeded.killed.length).toBeGreaterThan(0);

    const bare = await openCodeDriver({ primePostFails: true }).run(oneTurn);
    const created = failedWith(bare, "OpenCodeRequestRefusedError");
    expect(created.message).toBe('OpenCode refused the session create (500): {"error":"the store hiccuped"}');
    expect(harnessErrors(bare)).toEqual([`${created.message} — the run is stopped`]);
    expect(posts(bare, "/prompt")).toHaveLength(0);
  });

  it("an admitted prompt the feed then carries nothing for within the bound fails the run by name with the diagnostics — the phase, the session, the feed offset, the last feed record (the tailer's own note lifts nothing), both error logs' tails — the interrupt posted, the process ended, never a replaced verdict", async () => {
    const r = await openCodeDriver({ silentAfterPrompt: 1 }).run(oneTurn);
    const err = failedWith(r, "OpenCodeSilentError");
    const reconnected = { feed: "tailer", at: NOW, note: "reconnected", connections: 2 };
    const offset = feedByteLength([...TAILER_READY_NOTES, reconnected]);
    expect(err.message).toBe(
      `OpenCode produced no event for session ses_run-c within ${FIRST_EVENT_BOUND_MS / 1000} s of the prompt — the server admitted it and nothing followed; ` +
        `feed offset ${offset}, last feed record: ${JSON.stringify(reconnected)}; ` +
        "serve.err: provider: connect ETIMEDOUT 10.0.0.1:443 (the proxy did not answer); " +
        "tailer.err: tailer: event stream idle; no records for the session",
    );
    expect(harnessErrors(r)).toEqual([`${err.message} — the run is stopped`]);
    expect(posts(r, "/interrupt")).toHaveLength(1);
    expect(r.killed.length).toBeGreaterThan(0);
    expect(r.removed).toEqual([openCodeRunPaths("run-c").dir]);
    expect(notes(r.events).some((n) => n.kind === "sandbox_restarted")).toBe(false);
  });

  it("a resume's continue answered by silence names the continue", async () => {
    const driver = openCodeDriver({ silentAfterPrompt: 1 });
    const r = await driver.run({
      ...oneTurn,
      resume: {
        messages: [{ role: "user", content: [{ type: "text", text: "carry on" }] }],
        settlements: [],
        remainingMs: 300_000,
        turn: 0,
        inboxConsumedSeq: 0,
        facts: driver.facts({ pid: 999, container: "vm-old" }),
      },
    });
    const err = failedWith(r, "OpenCodeSilentError");
    expect(err.message).toMatch(/ within \d+ s of the continue — /);
  });

  it("the budget on a hung turn: the wind-down's note names the finale bound, one write-up steer and one interrupt are posted, the server and its tailer are ended and the root removed, and the run answers the budget's reason-alone line with the clause — never a failed run, never a replaced verdict", async () => {
    const r = await run(hung);
    expect(answered(r)).toBe(timeBudgetAnswer("", CONFORMANCE_MAX_MINUTES, finaleAbortReason(FINALE_MS)));
    expect(
      notes(r.events)
        .filter((n) => n.kind === "time_budget_exhausted")
        .map((n) => n.summary),
    ).toEqual([timeBudgetNote(MODEL_CALL_IN_FLIGHT)]);
    expect(harnessErrors(r)).toEqual([windDownFailureNote(finaleAbortReason(FINALE_MS))]);
    expect(r.progress).toContain(finaleTimedOutNote());
    expect(steers(r)).toHaveLength(1);
    expect(posts(r, "/interrupt")).toHaveLength(1);
    expect(r.killed).toEqual([4242, 4242]);
    expect(r.removed).toEqual([openCodeRunPaths("run-c").dir]);
    expect(notes(r.events).some((n) => n.kind === "sandbox_restarted")).toBe(false);
  });

  it("a soft stop on a hung turn ends the same way: the stopped note in mode soft, the write-up steered, the finale's interrupt, the process ended, and the ⏹ reason-alone line with the clause", async () => {
    const r = await run({ ...hung, softStopBeforeModelCall: 2 });
    expect(answered(r)).toBe(softStopAnswer("", finaleAbortReason(FINALE_MS)));
    const stopped = notes(r.events).filter((n) => n.kind === "stopped");
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ mode: "soft", summary: softStopNote() });
    expect(harnessErrors(r)).toEqual([windDownFailureNote(finaleAbortReason(FINALE_MS))]);
    expect(steers(r)).toHaveLength(1);
    expect(posts(r, "/interrupt")).toHaveLength(1);
    expect(r.killed).toEqual([4242, 4242]);
  });

  it("a soft stop whose write-up comes answers under the ⏹ label with the write-up, and the relayed tools are refused meanwhile", async () => {
    const r = await run({
      turns: [
        {
          content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo hi" } }],
          stopReason: "tool_use",
        },
        {
          content: [{ type: "tool_use", id: "c2", name: "update_status", input: { checklist: "○ late" } }],
          stopReason: "tool_use",
        },
        { content: [{ type: "text", text: "findings so far" }], stopReason: "end_turn" },
      ],
      softStopBeforeModelCall: 2,
    });
    expect(answered(r)).toBe(softStopAnswer("findings so far"));
    expect(notes(r.events).filter((n) => n.kind === "stopped")).toHaveLength(1);
    const refused = notes(r.events).find((n) => n.kind === "tool_refused" && /update_status/.test(n.summary));
    expect(refused?.summary).toMatch(/an operator asked this run to stop/);
    expect(r.statusReports).toEqual([]);
    expect(harnessErrors(r)).toEqual([]);
  });

  it("a model call that fails outside the wind-down fails the run by the provider's words at once — the execution settled on the failure, nothing awaited past it, the process ended", async () => {
    const r = await run({ ...oneTurn, failModelCall: 1 });
    expect(r.outcome.kind).toBe("failed");
    if (r.outcome.kind === "failed")
      expect(r.outcome.error.message).toBe(`the model call failed: ${FAILED_MODEL_CALL_ERROR}`);
    expect(harnessErrors(r)).toEqual([]);
    expect(posts(r, "/interrupt")).toHaveLength(0);
    expect(r.killed.length).toBeGreaterThan(0);
    expect(r.removed).toEqual([openCodeRunPaths("run-c").dir]);
  });

  it("a write-up steer the server refuses is a harness_error at once, never swallowed, and the finale still ends the run by the wind-down", async () => {
    const r = await openCodeDriver({ steerPostFails: true }).run(hung);
    expect(answered(r)).toBe(timeBudgetAnswer("", CONFORMANCE_MAX_MINUTES, finaleAbortReason(FINALE_MS)));
    expect(harnessErrors(r)).toEqual([
      'the write-up steer did not reach the server: it answered 500 ({"error":"the store hiccuped"})',
      windDownFailureNote(finaleAbortReason(FINALE_MS)),
    ]);
    expect(r.killed.length).toBeGreaterThan(0);
  });
});

describe("wind-down parity, an undelivered follow-up, and the alive-here reconciliation", () => {
  // The budget note says what the run was at when the clock ran out, in pi's
  // words: the open tool calls by name, the model call a started step has under
  // way, or nothing between steps.
  it("doingNow: nothing before a step, the model call while a step is open, the open tools by name while they run, nothing once the execution settles", () => {
    const { bridge } = harness();
    expect(bridge.doingNow()).toBeUndefined();
    bridge.observe(ev("session.step.started", { sessionID: "ses_c", assistantMessageID: "msg_a0" }));
    expect(bridge.doingNow()).toBe(MODEL_CALL_IN_FLIGHT);
    bridge.observe(ev("session.tool.input.started", { sessionID: "ses_c", id: "c1", name: "shell" }));
    bridge.observe(ev("session.tool.called", { sessionID: "ses_c", id: "c1", input: { command: "ls" } }));
    expect(bridge.doingNow()).toBe("running bash");
    bridge.observe(ev("session.tool.success", { sessionID: "ses_c", id: "c1", content: [], executed: true }));
    expect(bridge.doingNow()).toBe(MODEL_CALL_IN_FLIGHT);
    bridge.observe(ev("session.step.ended", { sessionID: "ses_c", assistantMessageID: "msg_a0" }));
    expect(bridge.doingNow()).toBeUndefined();
    bridge.observe(ev("session.step.started", { sessionID: "ses_c", assistantMessageID: "msg_a1" }));
    bridge.observe(ev("session.execution.failed", { sessionID: "ses_c", error: { message: "the stream closed" } }));
    bridge.observe(ev("session.idle", { sessionID: "ses_c" }));
    expect(bridge.doingNow()).toBeUndefined();
  });

  it("F1: a steer the server never took is recorded as undelivered and handed back to the inbox, never as folded in, and no input event carries it", async () => {
    const r = await openCodeDriver({ steerPostFails: true }).run({
      turns: [
        {
          content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo hi" } }],
          stopReason: "tool_use",
        },
        { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
      ],
      followUp: "also check the docs",
    });
    expect(answered(r)).toBe("done");
    const follow = notes(r.events).filter((n) => n.kind === "follow_up");
    expect(follow.some((n) => /not delivered/.test(n.summary))).toBe(true);
    expect(follow.some((n) => /folded in/.test(n.summary))).toBe(false);
    // The follow-up never reached the model: no input event carries it.
    expect(r.events.some((e) => e.type === "input")).toBe(false);
  });

  it("MINOR: a relayed tool asked during the write-up is refused with the write-up's words, so OpenCode and pi refuse alike", async () => {
    // No budget left: the first check opens the write-up, and the relayed tool
    // asked in it is refused at the plugin's authorize, its side effect never run.
    // (The row's server does not answer here, so the resume starts fresh.)
    const driver = openCodeDriver();
    const r = await driver.run({
      turns: [
        {
          content: [{ type: "tool_use", id: "c1", name: "update_status", input: { checklist: "○ step" } }],
          stopReason: "tool_use",
        },
        { content: [{ type: "text", text: "wrapped up" }], stopReason: "end_turn" },
      ],
      resume: {
        messages: [{ role: "user", content: [{ type: "text", text: "carry on" }] }],
        settlements: [],
        remainingMs: 0,
        turn: 0,
        inboxConsumedSeq: 0,
        facts: driver.facts({ pid: 31, container: driver.containerWord }),
      },
    });
    const refused = notes(r.events).find((n) => n.kind === "tool_refused" && /update_status/.test(n.summary));
    expect(refused, "the relayed tool was not refused during the write-up").toBeDefined();
    expect(refused?.summary).toMatch(/time budget|no more tool calls/);
    // The relay never ran: its side effect (the status report) did not land.
    expect(r.statusReports).toEqual([]);
  });

  it("MAJOR 2: a resume naming this container whose server still answers but refuses the session ends it and its tailer before a fresh start, removes nothing else, and says so", async () => {
    const root = openCodeRunPaths("run-c").dir;
    const driver = openCodeDriver({ reattach: { refuseSession: true } });
    const rowFacts = {
      ...driver.facts({ pid: 999, container: driver.containerWord, bearerHash: bearerHashOf(driver.bearer) }),
      tailerPid: 888,
    };
    const r = await driver.run({
      turns: [{ content: [{ type: "text", text: "resumed" }], stopReason: "end_turn" }],
      processAliveOnResume: true,
      resume: {
        messages: [{ role: "user", content: [{ type: "text", text: "carry on" }] }],
        settlements: [],
        remainingMs: 300_000,
        turn: 0,
        inboxConsumedSeq: 0,
        facts: rowFacts,
      },
    });
    expect(answered(r)).toBe("resumed");
    // The row's server was found on its recorded port — another than the fresh
    // launch's — with the row's password, and refused the session there before
    // anything was ended; nothing else was asked of it.
    const recordedPort = rowFacts.harness === "opencode" ? rowFacts.port : -1;
    expect(r.requests.filter((q) => q.port === recordedPort).map((q) => q.path)).toEqual([
      "/api/health",
      "/api/session/ses_run-c/message?order=asc&limit=200",
    ]);
    // Both the row's server and its tailer are ended before the fresh start.
    expect(r.killed).toContain(999);
    expect(r.killed).toContain(888);
    expect(r.removed).toContain(root);
    // Exactly one fresh OpenCode is started on the record.
    expect(r.starts).toHaveLength(1);
    const resumed = notes(r.events).find((n) => n.kind === "resumed");
    expect(resumed?.summary).toMatch(/still answers in this container but could not be re-attached/);
    expect(resumed?.summary).toMatch(/the server refused the session \(404\)/);
    expect(resumed?.summary).toMatch(/ended it and its tailer before a fresh start/);
  });
});

// Feature: docs/reference/specs/harness.md item 6 — one more command before the
// crash judgement. The platform's rollout kills the container's processes first
// while exec still answers, so OpenCode is found dead before any read has
// failed with the executor's word; `driveOpenCode` takes one more container
// command before judging, and reads the verdict off it.
describe("an OpenCode found dead before any command returned the executor's word — one more container command before the crash judgement", () => {
  const oneCallOpen: RunScript = {
    turns: [
      {
        content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo one" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
    ],
    deadWithoutWordBeforeModelCall: 2,
  };
  const verdictOf = (r: DrivenRun): HarnessContainerReplacedError => {
    expect(r.outcome.kind).toBe("failed");
    const err = r.outcome.kind === "failed" ? r.outcome.error : undefined;
    expect(err).toBeInstanceOf(HarnessContainerReplacedError);
    expect(err?.name).toBe("OpenCodeContainerReplacedError");
    return err as HarnessContainerReplacedError;
  };

  it("the one more command failing with the word is the executor's word: the replaced verdict by type carrying the record with the open call settled, one sandbox_restarted note that is the verdict's message, the call's failed tool_result with the replaced note, the server and its tailer neither ended nor their root removed — never 'the OpenCode run ended before its execution settled'", async () => {
    const r = await run(oneCallOpen);
    const err = verdictOf(r);
    expect(err.message).toMatch(
      /^the container running OpenCode was replaced \(vm-conformance → vm-conformance; the executor said: harness container: identity failed — runtime-replaced: /,
    );
    expect(err).toMatchObject({ was: "vm-conformance", now: "vm-conformance", condition: "word" });
    expect(err.said).toMatch(/runtime-replaced/);
    expect(err.record.settlements).toEqual([
      expect.objectContaining({ action: "synthetic", text: openCodeReplacedCallNote("bash") }),
    ]);
    expect(err.record.settlements[0].toolUse.id).toBe("c1");
    expect(
      notes(r.events)
        .filter((n) => n.kind === "sandbox_restarted")
        .map((n) => n.summary),
    ).toEqual([err.message]);
    expect(toolResults(r).filter((t) => t.callId === "c1")).toEqual([
      expect.objectContaining({ ok: false, summary: openCodeReplacedCallNote("bash") }),
    ]);
    expect(r.killed).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it("the one more command answering another identity than the launch recorded is the verdict too, the changed identity its condition — said in the note where the executor's words would be, `said` nothing — with the same record, settlement and nothing ended", async () => {
    const r = await run({ ...oneCallOpen, deadWithoutWordThen: "renamed" });
    const err = verdictOf(r);
    expect(err.message).toBe(
      `the container running OpenCode was replaced (vm-conformance → vm-conformance-2; ${identityChangedCondition()})`,
    );
    expect(err).toMatchObject({
      was: "vm-conformance",
      now: "vm-conformance-2",
      said: undefined,
      condition: "identity",
    });
    expect(err.record.settlements.map((s) => s.toolUse.id)).toEqual(["c1"]);
    expect(
      notes(r.events)
        .filter((n) => n.kind === "sandbox_restarted")
        .map((n) => n.summary),
    ).toEqual([err.message]);
    expect(toolResults(r).filter((t) => t.callId === "c1")).toEqual([
      expect.objectContaining({ ok: false, summary: openCodeReplacedCallNote("bash") }),
    ]);
    expect(r.killed).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it("the same identity on the one more command leaves the crash judgement standing: 'the OpenCode run ended before its execution settled', no sandbox_restarted note, the server and its tailer ended and the root removed", async () => {
    const r = await run({ ...oneCallOpen, deadWithoutWordThen: "same" });
    expect(r.outcome.kind).toBe("failed");
    if (r.outcome.kind === "failed") {
      expect(r.outcome.error).not.toBeInstanceOf(HarnessContainerReplacedError);
      expect(r.outcome.error.message).toBe("the OpenCode run ended before its execution settled");
    }
    expect(notes(r.events).some((n) => n.kind === "sandbox_restarted")).toBe(false);
    expect(r.killed.length).toBeGreaterThan(0);
    expect(r.removed).toEqual([openCodeRunPaths("run-c").dir]);
  });
});

describe("an OpenCode whose container command fails on its transport with no word — the one more command runs here too, and waits through a container that is down", () => {
  const oneCallOpen: RunScript = {
    turns: [
      {
        content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo one" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
    ],
    transportLostBeforeModelCall: 2,
  };
  const verdictOf = (r: DrivenRun): HarnessContainerReplacedError => {
    expect(r.outcome.kind).toBe("failed");
    const err = r.outcome.kind === "failed" ? r.outcome.error : undefined;
    expect(err).toBeInstanceOf(HarnessContainerReplacedError);
    expect(err?.name).toBe("OpenCodeContainerReplacedError");
    return err as HarnessContainerReplacedError;
  };
  const noteSummaries = (r: DrivenRun, kind: string) =>
    notes(r.events)
      .filter((n) => n.kind === kind)
      .map((n) => n.summary);

  it("the feed read failing with the WebSocket's 1006 close (the executor's infra failure, no word) is not judged a plain failure: one more command, and that command failing with the word is the executor's word — the replaced verdict by type with the open call settled, one sandbox_restarted note, the server and its tailer neither ended nor their root removed", async () => {
    const r = await run(oneCallOpen);
    const err = verdictOf(r);
    expect(err.message).toMatch(
      /^the container running OpenCode was replaced \(vm-conformance → vm-conformance; the executor said: harness container: identity failed — runtime-replaced: /,
    );
    expect(err).toMatchObject({ was: "vm-conformance", now: "vm-conformance", condition: "word" });
    expect(err.record.settlements).toEqual([
      expect.objectContaining({ action: "synthetic", text: openCodeReplacedCallNote("bash") }),
    ]);
    expect(noteSummaries(r, "sandbox_restarted")).toEqual([err.message]);
    expect(toolResults(r).filter((t) => t.callId === "c1")).toEqual([
      expect.objectContaining({ ok: false, summary: openCodeReplacedCallNote("bash") }),
    ]);
    expect(r.killed).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it("the one more command answering another identity than the launch recorded is the verdict by the changed identity, as after a wordless death", async () => {
    const r = await run({ ...oneCallOpen, transportLostThen: "renamed" });
    const err = verdictOf(r);
    expect(err.message).toBe(
      `the container running OpenCode was replaced (vm-conformance → vm-conformance-2; ${identityChangedCondition()})`,
    );
    expect(err).toMatchObject({
      was: "vm-conformance",
      now: "vm-conformance-2",
      said: undefined,
      condition: "identity",
    });
    expect(err.record.settlements.map((s) => s.toolUse.id)).toEqual(["c1"]);
    expect(r.killed).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it("the same identity on the one more command leaves the failure standing, named as the transport error it was — never the verdict, never 'the OpenCode run ended before its execution settled' — with a harness_error note saying the one more command named no replacement, no sandbox_restarted note, the server and its tailer ended and the root removed", async () => {
    const r = await run({ ...oneCallOpen, transportLostThen: "same" });
    expect(r.outcome.kind).toBe("failed");
    if (r.outcome.kind === "failed") {
      expect(r.outcome.error).toBeInstanceOf(ExecInfraError);
      expect(r.outcome.error.message).toBe(TRANSPORT_LOST_TEXT);
    }
    expect(noteSummaries(r, "sandbox_restarted")).toEqual([]);
    expect(noteSummaries(r, "harness_error")).toEqual([
      expect.stringMatching(
        /^a container command failed on its transport \(resident \/exec: Peer closed WebSocket: 1006 .*\); the one more command named no replacement, so the failure stands$/,
      ),
    ]);
    expect(r.killed.length).toBeGreaterThan(0);
    expect(r.removed).toEqual([openCodeRunPaths("run-c").dir]);
  });

  it("the one more command waits through a container that is down — 'The container is not running' from the probe itself is re-sent after the executor's backoff, never judged — and the container that then answers the same identity leaves the failure standing with the wait on the record", async () => {
    const r = await run({ ...oneCallOpen, transportLostThen: "same", containerDownForProbes: 2 });
    expect(r.outcome.kind).toBe("failed");
    if (r.outcome.kind === "failed") expect(r.outcome.error.message).toBe(TRANSPORT_LOST_TEXT);
    expect(noteSummaries(r, "sandbox_restarted")).toEqual([]);
    expect(noteSummaries(r, "harness_error")).toEqual([
      expect.stringMatching(
        /^the one more command finds the container down \(harness container: identity failed — resident \/exec: The container is not running, consider calling start\(\)\); waiting for it to answer, up to 300s$/,
      ),
      "the container answered after 15s of waiting",
      expect.stringMatching(/the one more command named no replacement, so the failure stands$/),
    ]);
    expect(r.killed.length).toBeGreaterThan(0);
  });
});

// Bind the record's disposition and observation types so a signature drift fails here.
const _obs: OpenCodeBridgeObservation = { replies: [], settled: false };
void _obs;
void assert;
