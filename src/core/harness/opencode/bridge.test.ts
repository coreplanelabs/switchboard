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
import { readStoreSince, type OpenCodeFeedRecord } from "./client.js";
import {
  InboxFate,
  judgeOpenCodeAsk,
  openCodeToolNameWord,
  OpenCodeBridge,
  projectStore,
  type OpenCodeBridgeObservation,
} from "./bridge.js";
import { OPENCODE_EVENT_DISPOSITION, openCodeDispositionCounts, openCodeDispositionOf } from "./dispositions.js";
import { openCodeReplacedCallNote } from "./session.js";
import { openCodeRunPaths } from "./process.js";
import { feedByteLength, openCodeDriver, silentPromptRecords, TAILER_READY_NOTES } from "./testing/driver.js";
import { loopClock, MINUTE_MS } from "../../budgets.js";
import { CONFORMANCE_MAX_MINUTES, FAILED_MODEL_CALL_ERROR } from "../testing/scenarios.js";
import {
  finaleAbortReason,
  finaleTimedOutNote,
  HARD_STOP_MESSAGE,
  MODEL_CALL_IN_FLIGHT,
  softStopAnswer,
  softStopNote,
  timeBudgetAnswer,
  timeBudgetNote,
  windDownFailureNote,
} from "../windDown.js";
import { doingWords, FIRST_EVENT_BOUND_MS } from "./bridge.js";

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
/** A `permission.asked` event for one call, as the server raises it. */
const asked_ = (requestID: string, callId: string, action: string, resource: string): OpenCodeFeedRecord =>
  ev("permission.asked", {
    id: requestID,
    sessionID: "ses_c",
    action,
    resources: [resource],
    source: { type: "tool", messageID: "msg_a0", id: callId },
  });

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

  it("classifies the record's kinds as the clause needs: the tool call mapped, the deltas folded, the step boundaries and the shell tool's own process structure, the asks and failures notes, the reverts and the session's shell messages impossible; an rpc event is folded and an unknown kind is undecided", () => {
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
    // The `shell` tool's own process lifecycle — the server's Shell service
    // says it for every shell call the model makes — lands nowhere of its
    // own: the call's rows already carry the command and the exit.
    expect(openCodeDispositionOf("shell.created")).toBe("structure");
    expect(openCodeDispositionOf("shell.exited")).toBe("structure");
    expect(openCodeDispositionOf("shell.deleted")).toBe("structure");
    // The server's provider catalogue changing is its own shape, denied tool or not.
    expect(openCodeDispositionOf("websearch.updated")).toBe("structure");
    // A shell command a client posts INTO the session as a message of its own
    // is something no one does under the run; the ptys stay off too.
    expect(openCodeDispositionOf("session.shell.started")).toBe("impossible");
    expect(openCodeDispositionOf("session.shell.ended")).toBe("impossible");
    expect(openCodeDispositionOf("pty.created")).toBe("impossible");
    expect(openCodeDispositionOf("persistent-pty.added")).toBe("impossible");
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
    // OpenCode's repeat guard — the same call made over and over — is refused
    // under the guard's own name, so the model changes course. What the pinned
    // binary does with the refusal is unmeasured: fourteen identical shell calls,
    // successful and failing alike, raised no doom_loop ask under the launch's
    // rules, so this verdict is an assumption about an ask that may never come.
    const loop = judgeOpenCodeAsk("doom_loop", ["*"], rules, relayed);
    expect(loop.reply).toBe("reject");
    expect(loop.tool).toBe("doom_loop");
    expect(loop.message).toMatch(/repeat guard/);
    // A relayed tool that happens to be named `loop` does not turn the guard's ask into its allowance.
    expect(judgeOpenCodeAsk("doom_loop", ["*"], rules, new Set(["loop"])).reply).toBe("reject");
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
    expect(ask.replies).toEqual([{ requestID: "per_1", callId: "c1", stepID: "msg_a0", reply: "once" }]);
    expect(bridge.observe(replied("per_1", "once")).bypass).toBeUndefined();
  });

  it("the refusals held for a step — what a withdrawn sibling's note is explained by — are dropped when the step ends or fails, so the map never grows over a long run", () => {
    const ended = harness();
    ended.bridge.observe(asked("per_1", "c1", "shell", "git push origin main"));
    expect(ended.bridge.stepsWithHeldRefusals()).toEqual(["msg_a0"]);
    ended.bridge.observe(ev("session.step.ended", { sessionID: "ses_c", assistantMessageID: "msg_a0" }));
    expect(ended.bridge.stepsWithHeldRefusals()).toEqual([]);

    const failed = harness();
    failed.bridge.observe(asked("per_2", "c2", "shell", "git push origin main"));
    expect(failed.bridge.stepsWithHeldRefusals()).toEqual(["msg_a0"]);
    failed.bridge.observe(
      ev("session.step.failed", {
        sessionID: "ses_c",
        assistantMessageID: "msg_a0",
        error: { type: "aborted", message: "Step interrupted" },
      }),
    );
    expect(failed.bridge.stepsWithHeldRefusals()).toEqual([]);
  });

  it("two withdrawn calls in one cascaded step accumulate: the one re-prompt names both, consumed once", () => {
    const { bridge } = harness();
    // The gate refuses c1 (a push to a protected branch); the server then
    // withdraws the step's other two asks — the cascade.
    bridge.observe(asked("per_1", "c1", "shell", "git push origin main"));
    bridge.askWithdrawn({ requestID: "per_2", callId: "c2", stepID: "msg_a0", reply: "once" });
    bridge.askWithdrawn({ requestID: "per_3", callId: "c3", stepID: "msg_a0", reply: "once" });
    const prompt = bridge.takeCascadeRePrompt();
    expect(prompt).toMatch(/refused/);
    expect(prompt).toMatch(/\(call c2\) and \S+ \(call c3\) were declined with it — the step ended/);
    expect(bridge.takeCascadeRePrompt()).toBeUndefined();
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

  it("an event kind the table does not name is a harness_error note naming it; an impossible kind is one too — each said once per kind, however often the kind arrives", () => {
    const { bridge, events } = harness();
    bridge.observe(ev("session.made.up.kind"));
    bridge.observe(ev("session.revert.staged", { sessionID: "ses_c" }));
    // The same kinds again: the first arrival was the finding; a flood of one
    // wrong table entry is not one note per event (measured live: two notes
    // per shell call while `shell.created`/`shell.exited` sat as impossible).
    bridge.observe(ev("session.made.up.kind"));
    bridge.observe(ev("session.revert.staged", { sessionID: "ses_c" }));
    bridge.observe(ev("session.made.up.kind"));
    const errs = () => notes(events).filter((n) => n.kind === "harness_error");
    expect(errs().map((n) => n.summary)).toEqual([
      "OpenCode emitted an event kind this build does not know: session.made.up.kind (said once: later events of this kind are not noted)",
      "OpenCode emitted session.revert.staged, which this run's configuration turns off (said once: later events of this kind are not noted)",
    ]);
    // Another kind of each class is its own first arrival, said once too.
    bridge.observe(ev("session.forked", { sessionID: "ses_c" }));
    bridge.observe(ev("session.other.made.up.kind"));
    bridge.observe(ev("session.forked", { sessionID: "ses_c" }));
    expect(errs().map((n) => n.summary.replace(/ \(said once.*$/, ""))).toEqual([
      "OpenCode emitted an event kind this build does not know: session.made.up.kind",
      "OpenCode emitted session.revert.staged, which this run's configuration turns off",
      "OpenCode emitted session.forked, which this run's configuration turns off",
      "OpenCode emitted an event kind this build does not know: session.other.made.up.kind",
    ]);
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

  // Feature: docs/reference/specs/harness.md item 2 — a reply the server
  // answers 404 is read against its pending asks: the ask gone is the server's
  // withdrawal (the reject cascade after a sibling's refusal), said once and
  // continued; the ask still pending is a reply that failed, fail closed.
  const twoCalls: RunScript = {
    turns: [
      {
        content: [
          { type: "tool_use", id: "c1", name: "bash", input: { command: "git push origin main" } },
          { type: "tool_use", id: "c2", name: "bash", input: { command: "echo sibling" } },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ],
  };
  const replyPosts = (r: DrivenRun) => r.requests.filter((q) => /\/permission\/[^/]+\/reply$/.test(q.path));
  const pendingLists = (r: DrivenRun) => r.requests.filter((q) => q.method === "GET" && /\/permission$/.test(q.path));

  it("a permission-reply POST the server answers 404 for an ask its pending list no longer carries — the reject cascade after a sibling's refusal — is the ask withdrawn: one ask_withdrawn note naming the sibling's refusal, no reply-failed error, the server's own reject echo no bypass, the sibling settled by the server's aborted failure; the step.failed {aborted} is not a harness_error; the loop re-prompts the model with the refusal (a decline_cascade note) so the model continues — the run answers with the next step, not answerless", async () => {
    const r = await openCodeDriver({ declineCascade: true }).run(twoCalls);
    expect(r.outcome.kind).toBe("answered");
    if (r.outcome.kind === "answered") expect(r.outcome.answer).toBe("done");
    const withdrawn = notes(r.events).filter((n) => n.kind === "ask_withdrawn");
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0].summary).toMatch(
      /withdrew the ask for bash \(call c2\) before the gate's reply \(once\) landed/,
    );
    expect(withdrawn[0].summary).toMatch(/the gate refused bash \(call c1\) in the same step/);
    expect(notes(r.events).filter((n) => n.kind === "tool_refused")).toHaveLength(1);
    // The cascade step's aborted failure is not a harness_error: it is the server's expected end.
    expect(
      notes(r.events).filter(
        (n) => n.kind === "harness_error" && /Step interrupted|could not be posted|bypassed/.test(n.summary),
      ),
    ).toEqual([]);
    // A decline_cascade note says the loop re-prompted the model.
    const cascade = notes(r.events).filter((n) => n.kind === "decline_cascade");
    expect(cascade).toHaveLength(1);
    expect(cascade[0].summary).toMatch(/re-prompting the model with the refusal/);
    // Two replies posted, one listing after the 404 — never a blind re-send.
    expect(replyPosts(r)).toHaveLength(2);
    expect(pendingLists(r)).toHaveLength(1);
    // The sibling settled by the server's own word: its result on the record, not ok, the call never run.
    const sibling = r.events.find(
      (e): e is Extract<RunEvent, { type: "tool_result" }> => e.type === "tool_result" && e.callId === "c2",
    );
    expect(sibling).toMatchObject({ ok: false });
    expect(sibling?.summary).toMatch(/declined this tool call/);
    // The step ended interrupted by the binary, not by a loop-posted interrupt.
    expect(r.requests.filter((q) => q.method === "POST" && /\/interrupt$/.test(q.path))).toHaveLength(0);
  });

  it("a permission-reply POST the server answers 404 for an ask its pending list no longer carries, with no refusal of the bot's in the step to explain it, is still withdrawn and not a fatal reply — the note says no refusal is on the record — but the server's own reject echo is judged as any reply is: a reject where the bot decided once is a bypass, fail closed", async () => {
    const r = await openCodeDriver({ replyRefusedAskDropped: true }).run(oneCall);
    expect(r.outcome.kind).toBe("failed");
    if (r.outcome.kind === "failed") {
      expect(r.outcome.error.name).toBe("OpenCodeGateBypassedError");
      expect(r.outcome.error.message).toMatch(/answering `reject` where the bot decided `once` \(request per_c1\)/);
    }
    const withdrawn = notes(r.events).filter((n) => n.kind === "ask_withdrawn");
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0].summary).toMatch(
      /withdrew the ask for bash \(call c1\) before the gate's reply \(once\) landed/,
    );
    expect(withdrawn[0].summary).toMatch(/no refusal of the same step is on the record/);
    expect(notes(r.events).filter((n) => n.kind === "harness_error" && /could not be posted/.test(n.summary))).toEqual(
      [],
    );
    expect(notes(r.events).some((n) => n.kind === "harness_error" && /bypassed/.test(n.summary))).toBe(true);
    expect(replyPosts(r)).toHaveLength(1);
    expect(pendingLists(r)).toHaveLength(1);
    expect(r.killed.length).toBeGreaterThan(0);
  });

  it("a permission-reply POST the server answers 404 while its pending list still carries the ask stops the run by name, as any reply that did not land — fail closed, no ask_withdrawn note", async () => {
    const r = await openCodeDriver({ replyRefusedWhilePending: true }).run(oneCall);
    expect(r.outcome.kind).toBe("failed");
    if (r.outcome.kind === "failed") {
      expect(r.outcome.error.name).toBe("OpenCodeReplyFailedError");
      expect(r.outcome.error.message).toMatch(/per_c1/);
      expect(r.outcome.error.message).toMatch(/answered 404/);
    }
    expect(notes(r.events).filter((n) => n.kind === "ask_withdrawn")).toEqual([]);
    expect(notes(r.events).some((n) => n.kind === "harness_error" && /could not be posted/.test(n.summary))).toBe(true);
    // One POST and one listing: the 404 is read against the pending asks, never retried blind.
    expect(replyPosts(r)).toHaveLength(1);
    expect(pendingLists(r)).toHaveLength(1);
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

  it("an admitted prompt whose execution never starts within the bound fails the run by name with the diagnostics — the tailer's reconnect sweep (its note and the session's two refills, as the real tailer writes them) and a global event lift nothing; the phase, the session, the feed offset, the last feed record and both error logs' tails on the note; the interrupt posted, the process ended, never a replaced verdict", async () => {
    const r = await openCodeDriver({ silentAfterPrompt: 1 }).run(oneTurn);
    const err = failedWith(r, "OpenCodeSilentError");
    // The feed after the admitted prompt: the reconnect's note, the two refills for the session, a catalogue event — none the session's execution.
    const carried = silentPromptRecords("ses_run-c", [], NOW);
    const offset = feedByteLength([...TAILER_READY_NOTES, ...carried]);
    expect(err.message).toBe(
      `OpenCode produced no event for session ses_run-c within ${FIRST_EVENT_BOUND_MS / 1000} s of the prompt — the server admitted it and nothing followed; ` +
        `feed offset ${offset}, last feed record: ${JSON.stringify(carried.at(-1))}; ` +
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

  it("the refill the execution's end owed fails in the tailer: the loop settles on the tailer's failure note for that reason, not on the event and not never — the run ends on what landed, the failure on the card", async () => {
    const r = await openCodeDriver({ terminalRefillFails: true }).run({
      turns: [
        {
          content: [{ type: "tool_use", id: "g1", name: "grep", input: { pattern: "needle" } }],
          stopReason: "tool_use",
        },
        { content: [{ type: "text", text: "the last word" }], stopReason: "end_turn" },
      ],
    });
    // The last step's own refill still landed (after the terminal event), so the answer is read;
    // the terminal reason's refill is the one the tailer failed, and its note is the settle.
    expect(r.outcome.kind).toBe("answered");
    expect(answered(r)).toBe("the last word");
    expect(r.stopRequested).toBeUndefined();
    expect(r.progress.some((p) => p.includes("message refill failed"))).toBe(true);
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

  it("the interrupt an ending posts that answers only once the caller's kill cuts it leaves no note: the record carries the wind-down's harness_error alone, never the kill's own effect said as a failure", async () => {
    const r = await openCodeDriver({ interruptAnswersAfterKill: true }).run(hung);
    expect(answered(r)).toBe(timeBudgetAnswer("", CONFORMANCE_MAX_MINUTES, finaleAbortReason(FINALE_MS)));
    expect(harnessErrors(r)).toEqual([windDownFailureNote(finaleAbortReason(FINALE_MS))]);
    expect(posts(r, "/interrupt")).toHaveLength(1);
    expect(r.killed.length).toBeGreaterThan(0);
  });

  it("a soft stop requested once the budget's write-up is under way is acknowledged: one stopped note in mode soft, no second steer, and the answer keeps the ending that was already under way — the budget's label", async () => {
    const r = await run({
      turns: [
        {
          content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo hi" } }],
          stopReason: "tool_use",
        },
        { content: [{ type: "text", text: "findings so far" }], stopReason: "end_turn" },
      ],
      budgetBeforeModelCall: 2,
      softStopBeforeModelCall: 2,
    });
    expect(answered(r)).toBe(timeBudgetAnswer("findings so far", CONFORMANCE_MAX_MINUTES));
    expect(notes(r.events).filter((n) => n.kind === "time_budget_exhausted")).toHaveLength(1);
    const stopped = notes(r.events).filter((n) => n.kind === "stopped");
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ mode: "soft", summary: softStopNote() });
    expect(steers(r)).toHaveLength(1);
    expect(harnessErrors(r)).toEqual([]);
  });

  it("the interrupt an ending posts that the server refuses is a harness_error whenever the answer comes — after the loop has left included — beside the wind-down's note, on the record alone and never on the closed card", async () => {
    const r = await openCodeDriver({ interruptPostFails: true }).run(hung);
    expect(answered(r)).toBe(timeBudgetAnswer("", CONFORMANCE_MAX_MINUTES, finaleAbortReason(FINALE_MS)));
    expect(harnessErrors(r)).toEqual([
      windDownFailureNote(finaleAbortReason(FINALE_MS)),
      'the interrupt did not reach the server: it answered 500 ({"error":"interrupt refused"})',
    ]);
    expect(posts(r, "/interrupt")).toHaveLength(1);
    // The answer came after the loop left: the record has it, the card's progress line does not.
    expect(r.progress.some((p) => /the interrupt did not reach the server/.test(p))).toBe(false);
  });

  it("a soft stop then a hard stop write two stopped notes, soft then hard, and the hard stop's abort line is the answer", async () => {
    const r = await run({
      turns: [
        {
          content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo hi" } }],
          stopReason: "tool_use",
        },
        { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
      ],
      softStopBeforeModelCall: 2,
      hardStopBeforeModelCall: 2,
    });
    expect(answered(r)).toBe(HARD_STOP_MESSAGE);
    expect(
      notes(r.events)
        .filter((n) => n.kind === "stopped")
        .map((n) => n.mode),
    ).toEqual(["soft", "hard"]);
    expect(posts(r, "/interrupt")).toHaveLength(1);
    expect(harnessErrors(r)).toEqual([]);
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

// Feature: docs/reference/specs/harness.md item 13 — the bridge's one
// `observing` mode: `own` decides; `earlier` reads an earlier execution's tail
// (before the loop's own execution has started) and decides nothing of it — no
// reply, no bypass, no settle, no tool event; a settle is set aside whenever it
// lands, own mode included, when its `assistantMessageID` names a step this
// loop never saw start — an earlier execution's by construction; `catching-up`
// reads the feed a dead generation already read. In every mode the record's
// own state lands (a compaction row, the store's refills) and what carries no
// decision is surfaced (a tailer note, an unknown kind, a failure said as whose
// it was — the proxy's turn-budget refusal by its own name).
describe("the bridge's observing mode — an earlier execution's tail is not this loop's to decide", () => {
  const earlier = () => {
    const h = harness();
    h.bridge.observing = "earlier";
    return h;
  };
  const toolEvents = (events: RunEvent[]) => events.filter((e) => e.type === "tool_call" || e.type === "tool_result");

  it("an ask is not replied to and a tool that settles with no decision is no bypass; neither reaches the record as a tool event", () => {
    const { bridge, events } = earlier();
    const asked = bridge.observe(asked_("per_old", "c-old", "shell", "echo late"));
    expect(asked.replies).toEqual([]);
    bridge.observe(ev("session.tool.input.started", { sessionID: "ses_c", id: "c-old", name: "shell" }));
    bridge.observe(ev("session.tool.called", { sessionID: "ses_c", id: "c-old", input: { command: "echo late" } }));
    const settled = bridge.observe(
      ev("session.tool.success", { sessionID: "ses_c", id: "c-old", content: [], executed: true }),
    );
    expect(settled.bypass).toBeUndefined();
    expect(toolEvents(events)).toEqual([]);
    expect(notes(events).filter((n) => n.kind === "tool_refused" || n.kind === "harness_error")).toEqual([]);
  });

  it("a call of the tail's step that settles only once the loop's own execution has started is that execution's still: set aside in own mode under the note naming the call and the step, no bypass, no tool event", () => {
    const { bridge, events } = earlier();
    bridge.observe(ev("session.step.started", { sessionID: "ses_c", assistantMessageID: "msg_old", agent: "x" }));
    bridge.observe(
      ev("session.tool.input.started", {
        sessionID: "ses_c",
        assistantMessageID: "msg_old",
        id: "c-old",
        name: "shell",
      }),
    );
    bridge.observing = "own";
    const late = bridge.observe(
      ev("session.tool.success", {
        sessionID: "ses_c",
        assistantMessageID: "msg_old",
        id: "c-old",
        content: [{ type: "text", text: "slept" }],
        executed: true,
      }),
    );
    expect(late.bypass).toBeUndefined();
    expect(toolEvents(events)).toEqual([]);
    expect(notes(events).map((n) => [n.kind, n.summary])).toEqual([
      [
        "settle_set_aside",
        "OpenCode settled bash (call c-old) of a step this loop never saw start (msg_old); set aside — an earlier execution's late settle, or a step lost with the stream",
      ],
    ]);
  });

  it("catching up, a settle of a step this bridge never saw start is the dead generation's, narrated again under its own rules — no set-aside note", () => {
    const { bridge, events } = harness();
    bridge.observing = "catching-up";
    const dead = bridge.observe(
      ev("session.tool.success", {
        sessionID: "ses_c",
        assistantMessageID: "msg_dead",
        id: "c-dead",
        content: [{ type: "text", text: "done long ago" }],
        executed: true,
      }),
    );
    expect(dead.bypass).toBeUndefined();
    expect(events.filter((e) => e.type === "tool_result").map((e) => e.callId)).toEqual(["c-dead"]);
    expect(notes(events)).toEqual([]);
  });

  it("the dead generation's end, replayed while catching up, owes this loop no refill: a later refill of the same terminal kind settles nothing, and only the loop's own end is paid by its refill", () => {
    const { bridge } = harness();
    const refill = (reason: string): OpenCodeFeedRecord => ({
      feed: "messages",
      at: NOW,
      sessionID: "ses_c",
      reason,
      data: [],
    });
    bridge.observing = "catching-up";
    const replayed = bridge.observe(ev("session.execution.succeeded", { sessionID: "ses_c" }));
    // Catching up, the end is history: the loop discards its `settled`, and nothing dangles from it.
    expect(replayed.settled).toBe(true);
    bridge.observing = "own";
    expect(bridge.observe(refill("session.execution.succeeded")).settled).toBe(false);
    // The loop's own end owes its refill; the event alone settles nothing, the refill does.
    expect(bridge.observe(ev("session.execution.succeeded", { sessionID: "ses_c" })).settled).toBe(false);
    expect(bridge.observe(refill("session.step.ended")).settled).toBe(false);
    expect(bridge.observe(refill("session.execution.succeeded")).settled).toBe(true);
  });

  it("a settle whose step this loop never saw start — an earlier execution's, landing however late, no hand-over needed — is set aside in own mode under a settle_set_aside note naming the call and the step, while a settle of the loop's own step with no decision is still the bypass it always was", () => {
    const { bridge, events } = harness();
    bridge.observing = "earlier";
    bridge.observe(
      ev("session.tool.input.started", {
        sessionID: "ses_c",
        assistantMessageID: "msg_prev",
        id: "c-prev",
        name: "shell",
      }),
    );
    bridge.observing = "own";
    const prev = bridge.observe(
      ev("session.tool.success", {
        sessionID: "ses_c",
        assistantMessageID: "msg_prev",
        id: "c-prev",
        content: [{ type: "text", text: "slept" }],
        executed: true,
      }),
    );
    expect(prev.bypass).toBeUndefined();
    expect(toolEvents(events)).toEqual([]);
    expect(notes(events).map((n) => [n.kind, n.summary])).toEqual([
      [
        "settle_set_aside",
        "OpenCode settled bash (call c-prev) of a step this loop never saw start (msg_prev); set aside — an earlier execution's late settle, or a step lost with the stream",
      ],
    ]);
    bridge.observe(ev("session.step.started", { sessionID: "ses_c", assistantMessageID: "msg_own", agent: "x" }));
    bridge.observe(
      ev("session.tool.input.started", {
        sessionID: "ses_c",
        assistantMessageID: "msg_own",
        id: "c-new",
        name: "shell",
      }),
    );
    const undecided = bridge.observe(
      ev("session.tool.success", {
        sessionID: "ses_c",
        assistantMessageID: "msg_own",
        id: "c-new",
        content: [],
        executed: true,
      }),
    );
    expect(undecided.bypass?.message).toMatch(/call c-new\) with no ask the bot answered/);
  });

  it("a settle, an interrupt and a permissions refill decide nothing; a failure is noted as an earlier execution's, the proxy's turn-budget refusal by its own name", () => {
    const { bridge, events } = earlier();
    expect(bridge.observe(ev("session.execution.interrupted", { sessionID: "ses_c", reason: "user" })).settled).toBe(
      false,
    );
    expect(bridge.observe(ev("session.execution.succeeded", { sessionID: "ses_c" })).settled).toBe(false);
    expect(
      bridge.observe({ feed: "permissions", at: NOW, sessionID: "ses_c", reason: "reconnect", data: [] }).replies,
    ).toEqual([]);
    const failed = bridge.observe(
      ev("session.execution.failed", { sessionID: "ses_c", error: { message: "the proxy answered 400" } }),
    );
    expect(failed.settled).toBe(false);
    expect(failed.providerError).toBeUndefined();
    const budget = bridge.observe(
      ev("session.execution.failed", {
        sessionID: "ses_c",
        error: { status: 403, message: "403 turn_budget_exhausted: the run is past its 60-turn guard" },
      }),
    );
    expect(budget.budgetStop).toBeUndefined();
    expect(notes(events).map((n) => n.summary)).toEqual([
      "a model call of an earlier execution failed (the proxy answered 400); continuing",
      "an earlier execution reached the proxy's turn budget (403 turn_budget_exhausted: the run is past its 60-turn guard); continuing",
    ]);
  });

  it("what carries no decision is surfaced as in every mode — a tailer note on the card, an unknown event kind as a harness_error, a compaction as its note and its row, a failed compaction and a scheduled retry as notes — while the aborted execution's failed step is not said again, and a messages refill still feeds the mirror", async () => {
    const { bridge, events, progress, steps } = earlier();
    bridge.observe({ feed: "tailer", at: NOW, note: "stream closed" });
    expect(progress).toContain("opencode feed: stream closed");
    bridge.observe(ev("made_up_kind", { sessionID: "ses_c" }));
    expect(notes(events).some((n) => n.kind === "harness_error" && /made_up_kind/.test(n.summary))).toBe(true);
    bridge.observe(
      ev("session.compaction.ended", { sessionID: "ses_c", reason: "auto", text: "the earlier turns, summarised" }),
    );
    bridge.observe(ev("session.compaction.failed", { sessionID: "ses_c", error: { message: "no room" } }));
    bridge.observe(ev("session.retry.scheduled", { sessionID: "ses_c", error: { message: "429" } }));
    bridge.observe(
      ev("session.step.failed", { sessionID: "ses_c", error: { type: "aborted", message: "Step interrupted" } }),
    );
    expect(notes(events).map((n) => n.kind)).toEqual(["harness_error", "compacted", "harness_error", "harness_error"]);
    expect(notes(events).some((n) => /step failed/.test(n.summary))).toBe(false);
    bridge.observe({
      feed: "messages",
      at: NOW,
      sessionID: "ses_c",
      reason: "reconnect",
      data: [
        { id: "u0", type: "user", text: "do the thing", time: { created: NOW } },
        {
          id: "a0",
          type: "assistant",
          agent: "switchboard",
          model: { providerID: "switchboard", id: "m" },
          content: [{ type: "text", text: "earlier answer" }],
          time: { created: NOW, completed: NOW },
        },
      ],
    });
    await bridge.flush();
    expect(steps.some((s) => s.compaction?.summary === "the earlier turns, summarised")).toBe(true);
    expect(bridge.answer()).toBe("earlier answer");
  });

  it("an ask answered from the store's permissions refill — the stream dropped before the step's events — teaches its step as the event would: the tool's settle is judged and recorded, never set aside as foreign", async () => {
    const { bridge, events } = harness();
    const refilled = bridge.observe({
      feed: "permissions",
      at: NOW,
      sessionID: "ses_c",
      reason: "reconnect",
      data: [
        {
          id: "per_c-lost",
          sessionID: "ses_c",
          action: "shell",
          resources: ["echo hi"],
          source: { type: "tool", messageID: "msg_lost", id: "c-lost" },
        },
      ],
    });
    expect(refilled.replies.map((r) => r.reply)).toEqual(["once"]);
    bridge.observe(ev("permission.replied", { sessionID: "ses_c", requestID: "per_c-lost", reply: "once" }));
    const settled = bridge.observe(
      ev("session.tool.success", {
        sessionID: "ses_c",
        assistantMessageID: "msg_lost",
        id: "c-lost",
        content: [{ type: "text", text: "hi" }],
        executed: true,
      }),
    );
    expect(settled.bypass).toBeUndefined();
    // The call the stream never announced is opened from the ask — the tool named, its command summarised — so the result lands on a call the record knows.
    expect(
      events
        .filter((e) => e.type === "tool_call" || e.type === "tool_result")
        .map((e) => `${e.type}:${e.callId}:${e.tool}${e.type === "tool_call" ? `:${e.command ?? ""}` : `:${e.ok}`}`),
    ).toEqual(["tool_call:c-lost:bash:echo hi", "tool_result:c-lost:bash:true"]);
    expect(notes(events).filter((n) => n.kind === "harness_error")).toEqual([]);
  });

  it("a refilled ask of a built-in outside the action table (todowrite) with a tool source opens its call under the record's word for the action, and its settle lands on that call — never an orphan result", () => {
    const { bridge, events } = harness();
    const refilled = bridge.observe({
      feed: "permissions",
      at: NOW,
      sessionID: "ses_c",
      reason: "reconnect",
      data: [
        {
          id: "per_todo",
          sessionID: "ses_c",
          action: "todowrite",
          resources: ["*"],
          source: { type: "tool", messageID: "msg_todo", id: "c-todo" },
        },
      ],
    });
    expect(refilled.replies.map((r) => r.reply)).toEqual(["reject"]);
    bridge.observe(ev("permission.replied", { sessionID: "ses_c", requestID: "per_todo", reply: "reject" }));
    const settled = bridge.observe(
      ev("session.tool.failed", {
        sessionID: "ses_c",
        assistantMessageID: "msg_todo",
        id: "c-todo",
        error: { name: "PermissionDeniedError", message: "todowrite is not in any bundle the write identity reaches" },
      }),
    );
    expect(settled.bypass).toBeUndefined();
    expect(
      events
        .filter((e) => e.type === "tool_call" || e.type === "tool_result")
        .map((e) => `${e.type}:${e.callId}:${e.tool}${e.type === "tool_result" ? `:${e.ok}` : ""}`),
    ).toEqual(["tool_call:c-todo:todowrite", "tool_result:c-todo:todowrite:false"]);
    expect(doingWords(bridge.doingNow())).toBeUndefined();
  });

  it("a refilled ask naming no call opens nothing; a permission over something other than a tool (external_directory, doom_loop) with a tool source opens the call under the tool the store names for it — the ask's source read against the mirror's assistant message and its tool part — and the settle lands there, never an orphan result", () => {
    const { bridge, events } = harness();
    const noSource = bridge.observe({
      feed: "permissions",
      at: NOW,
      sessionID: "ses_c",
      reason: "reconnect",
      data: [{ id: "per_free", sessionID: "ses_c", action: "shell", resources: ["echo hi"] }],
    });
    expect(noSource.replies.map((r) => r.reply)).toEqual(["once"]);
    expect(events.filter((e) => e.type === "tool_call")).toEqual([]);
    // The store's refill names the calls: msg_x's tool parts c-dir (read) and c-loop (shell).
    bridge.observe({
      feed: "messages",
      at: NOW,
      sessionID: "ses_c",
      reason: "reconnect",
      data: [
        {
          id: "msg_x",
          type: "assistant",
          agent: "switchboard",
          model: { providerID: "switchboard", id: "m" },
          content: [
            {
              type: "tool",
              id: "c-dir",
              name: "read",
              state: { status: "running", input: { filePath: "/w/src/a.ts" } },
            },
            { type: "tool", id: "c-loop", name: "shell", state: { status: "running", input: { command: "echo hi" } } },
          ],
          time: { created: NOW },
        },
      ],
    });
    const directory = bridge.observe({
      feed: "permissions",
      at: NOW,
      sessionID: "ses_c",
      reason: "reconnect",
      data: [
        {
          id: "per_dir",
          sessionID: "ses_c",
          action: "external_directory",
          resources: ["/workspace/threads/t/main/src"],
          source: { type: "tool", messageID: "msg_x", id: "c-dir" },
        },
        {
          id: "per_loop",
          sessionID: "ses_c",
          action: "doom_loop",
          resources: ["*"],
          source: { type: "tool", messageID: "msg_x", id: "c-loop" },
        },
      ],
    });
    expect(directory.replies.map((r) => `${r.requestID}:${r.reply}`)).toEqual(["per_dir:once", "per_loop:reject"]);
    bridge.observe(ev("permission.replied", { sessionID: "ses_c", requestID: "per_dir", reply: "once" }));
    bridge.observe(ev("permission.replied", { sessionID: "ses_c", requestID: "per_loop", reply: "reject" }));
    const settledDir = bridge.observe(
      ev("session.tool.success", {
        sessionID: "ses_c",
        assistantMessageID: "msg_x",
        id: "c-dir",
        content: [{ type: "text", text: "the file" }],
        executed: true,
      }),
    );
    const settledLoop = bridge.observe(
      ev("session.tool.failed", {
        sessionID: "ses_c",
        assistantMessageID: "msg_x",
        id: "c-loop",
        error: { name: "PermissionDeniedError", message: "refused" },
      }),
    );
    expect(settledDir.bypass).toBeUndefined();
    expect(settledLoop.bypass).toBeUndefined();
    expect(
      events
        .filter((e) => e.type === "tool_call" || e.type === "tool_result")
        .map((e) => `${e.type}:${e.callId}:${e.tool}${e.type === "tool_result" ? `:${e.ok}` : ""}`),
    ).toEqual([
      "tool_call:c-dir:read",
      "tool_call:c-loop:bash",
      "tool_result:c-dir:read:true",
      "tool_result:c-loop:bash:false",
    ]);
    // The tool's own path leads the call's line; the directory the call reached follows it on the record.
    const dirCall = events.find((e) => e.type === "tool_call" && e.callId === "c-dir");
    expect(dirCall?.type === "tool_call" ? dirCall.summary : "").toBe(
      "read /w/src/a.ts (reaching /workspace/threads/t/main/src)",
    );
    // The repeat guard's call carries the tool's own input from the store's part: the command the record shows.
    const loopCall = events.find((e) => e.type === "tool_call" && e.callId === "c-loop");
    expect(loopCall?.type === "tool_call" ? loopCall.command : undefined).toBe("echo hi");
    expect(notes(events).filter((n) => n.kind === "tool_unnamed")).toEqual([]);
    expect(
      notes(events)
        .filter((n) => n.kind === "tool_refused")
        .map((n) => n.summary),
    ).toEqual([expect.stringMatching(/^doom_loop refused: OpenCode's repeat guard/)]);
    expect(doingWords(bridge.doingNow())).toBeUndefined();
  });

  it("a permission over something other than a tool whose call the store does not name yet — no part of the ask's source in the store — is answered and its call held unopened; a messages refill that names the part then opens it under the tool's word with the part's input, and the settle lands there", () => {
    const { bridge, events } = harness();
    const directory = bridge.observe({
      feed: "permissions",
      at: NOW,
      sessionID: "ses_c",
      reason: "reconnect",
      data: [
        {
          id: "per_dir3",
          sessionID: "ses_c",
          action: "external_directory",
          resources: ["/workspace/threads/t/main/vendor"],
          source: { type: "tool", messageID: "msg_z", id: "c-dir3" },
        },
      ],
    });
    expect(directory.replies.map((r) => r.reply)).toEqual(["once"]);
    expect(events.filter((e) => e.type === "tool_call")).toEqual([]);
    bridge.observe({
      feed: "messages",
      at: NOW,
      sessionID: "ses_c",
      reason: "session.step.ended",
      data: [
        {
          id: "msg_z",
          type: "assistant",
          agent: "switchboard",
          model: { providerID: "switchboard", id: "m" },
          content: [
            {
              type: "tool",
              id: "c-dir3",
              name: "shell",
              state: { status: "running", input: { command: "ls /workspace/threads/t/main/vendor" } },
            },
          ],
          time: { created: NOW },
        },
      ],
    });
    bridge.observe(ev("permission.replied", { sessionID: "ses_c", requestID: "per_dir3", reply: "once" }));
    const settled = bridge.observe(
      ev("session.tool.success", {
        sessionID: "ses_c",
        assistantMessageID: "msg_z",
        id: "c-dir3",
        content: [{ type: "text", text: "listed" }],
        executed: true,
      }),
    );
    expect(settled.bypass).toBeUndefined();
    expect(
      events
        .filter((e) => e.type === "tool_call" || e.type === "tool_result")
        .map((e) => `${e.type}:${e.callId}:${e.tool}${e.type === "tool_call" ? `:${e.command ?? ""}` : `:${e.ok}`}`),
    ).toEqual(["tool_call:c-dir3:bash:ls /workspace/threads/t/main/vendor", "tool_result:c-dir3:bash:true"]);
    expect(notes(events).filter((n) => n.kind === "tool_unnamed")).toEqual([]);
  });

  it("a call opened from a held ask by the refill that named it is not opened again by the stream's session.tool.called that follows: one tool_call, one span, one count, and the settle lands once", () => {
    const { bridge, events } = harness();
    bridge.observe({
      feed: "permissions",
      at: NOW,
      sessionID: "ses_c",
      reason: "reconnect",
      data: [
        {
          id: "per_race",
          sessionID: "ses_c",
          action: "external_directory",
          resources: ["/workspace/threads/t/main/vendor"],
          source: { type: "tool", messageID: "msg_r", id: "c-race" },
        },
      ],
    });
    bridge.observe({
      feed: "messages",
      at: NOW,
      sessionID: "ses_c",
      reason: "session.step.ended",
      data: [
        {
          id: "msg_r",
          type: "assistant",
          agent: "switchboard",
          model: { providerID: "switchboard", id: "m" },
          content: [
            {
              type: "tool",
              id: "c-race",
              name: "shell",
              state: { status: "running", input: { command: "ls /workspace/threads/t/main/vendor" } },
            },
          ],
          time: { created: NOW },
        },
      ],
    });
    bridge.observe(
      ev("session.tool.called", {
        sessionID: "ses_c",
        assistantMessageID: "msg_r",
        id: "c-race",
        tool: "shell",
        input: { command: "ls /workspace/threads/t/main/vendor" },
      }),
    );
    bridge.observe(ev("permission.replied", { sessionID: "ses_c", requestID: "per_race", reply: "once" }));
    bridge.observe(
      ev("session.tool.success", {
        sessionID: "ses_c",
        assistantMessageID: "msg_r",
        id: "c-race",
        content: [{ type: "text", text: "listed" }],
        executed: true,
      }),
    );
    expect(events.filter((e) => e.type === "tool_call").map((e) => e.callId)).toEqual(["c-race"]);
    expect(events.filter((e) => e.type === "tool_result").map((e) => e.callId)).toEqual(["c-race"]);
    expect(bridge.toolCalls).toBe(1);
    expect(doingWords(bridge.doingNow())).toBeUndefined();
  });

  it("two resource permissions held for one call — external_directory, then doom_loop — are both kept: the refill that names the part opens the call once with every held ask's input folded in, the directory among them", () => {
    const { bridge, events } = harness();
    const ask = (id: string, action: string, resources: string[]) =>
      bridge.observe(
        ev("permission.asked", {
          id,
          sessionID: "ses_c",
          action,
          resources,
          source: { type: "tool", messageID: "msg_two", id: "c-two" },
        }),
      );
    expect(
      ask("per_dir", "external_directory", ["/workspace/threads/t/main/vendor"]).replies.map((r) => r.reply),
    ).toEqual(["once"]);
    expect(ask("per_loop", "doom_loop", ["*"]).replies.map((r) => r.reply)).toEqual(["reject"]);
    expect(events.filter((e) => e.type === "tool_call")).toEqual([]);
    // The part names the tool but carries no input of its own: the directory the
    // external_directory ask named is the path the record has.
    bridge.observe({
      feed: "messages",
      at: NOW,
      sessionID: "ses_c",
      reason: "session.step.ended",
      data: [
        {
          id: "msg_two",
          type: "assistant",
          agent: "switchboard",
          model: { providerID: "switchboard", id: "m" },
          content: [{ type: "tool", id: "c-two", name: "read", state: { status: "running" } }],
          time: { created: NOW },
        },
      ],
    });
    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls.map((e) => `${e.callId}:${e.tool}:${e.summary}`)).toEqual([
      "c-two:read:read /workspace/threads/t/main/vendor",
    ]);
    expect(bridge.toolCalls).toBe(1);
  });

  it("two external_directory asks held for one call — a tool reaching two roots — keep every directory on the record: the tool's own path leads the call's line and each directory it reached follows once, none overwritten by the ask that came after", () => {
    const { bridge, events } = harness();
    const ask = (id: string, resources: string[]) =>
      bridge.observe(
        ev("permission.asked", {
          id,
          sessionID: "ses_c",
          action: "external_directory",
          resources,
          source: { type: "tool", messageID: "msg_two", id: "c-two" },
        }),
      );
    const vendor = "/workspace/threads/t/main/vendor";
    const tools = "/workspace/threads/t/main/tools";
    expect(ask("per_a", [vendor]).replies.map((r) => r.reply)).toEqual(["once"]);
    expect(ask("per_b", [tools, vendor]).replies.map((r) => r.reply)).toEqual(["once"]);
    bridge.observe({
      feed: "messages",
      at: NOW,
      sessionID: "ses_c",
      reason: "session.step.ended",
      data: [
        {
          id: "msg_two",
          type: "assistant",
          agent: "switchboard",
          model: { providerID: "switchboard", id: "m" },
          content: [
            {
              type: "tool",
              id: "c-two",
              name: "read",
              state: { status: "running", input: { filePath: `${vendor}/x.txt` } },
            },
          ],
          time: { created: NOW },
        },
      ],
    });
    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls.map((e) => `${e.callId}:${e.tool}:${e.summary}`)).toEqual([
      `c-two:read:read ${vendor}/x.txt (reaching ${vendor}, ${tools})`,
    ]);
  });

  it("an external_directory ask that arrives once its call is already open — the tool's own ask opened it first — is answered, and since the call's line is on the record and cannot be amended, a directory_reached note names the call and the directory it reached", () => {
    const { bridge, events } = harness();
    expect(
      bridge
        .observe(asked_("per_r", "c-late", "read", "/workspace/threads/t/main/src/a.ts"))
        .replies.map((r) => r.reply),
    ).toEqual(["once"]);
    expect(
      bridge
        .observe(asked_("per_d", "c-late", "external_directory", "/workspace/threads/t/main/vendor"))
        .replies.map((r) => r.reply),
    ).toEqual(["once"]);
    expect(events.filter((e) => e.type === "tool_call").map((e) => `${e.callId}:${e.summary}`)).toEqual([
      "c-late:read /workspace/threads/t/main/src/a.ts",
    ]);
    expect(
      notes(events)
        .filter((n) => n.kind === "directory_reached")
        .map((n) => n.summary),
    ).toEqual([
      "read (call c-late) reached /workspace/threads/t/main/vendor after its line was written; the line does not name it",
    ]);
  });

  it("an external_directory ask held for a call the store had not named — the tool's own ask then opens the call: the directory rides the call's line, no note is needed, and the settle lands paired", () => {
    const { bridge, events } = harness();
    const vendor = "/workspace/threads/t/main/vendor";
    expect(bridge.observe(asked_("per_d", "c-held", "external_directory", vendor)).replies.map((r) => r.reply)).toEqual(
      ["once"],
    );
    expect(
      bridge
        .observe(asked_("per_r", "c-held", "read", "/workspace/threads/t/main/src/a.ts"))
        .replies.map((r) => r.reply),
    ).toEqual(["once"]);
    bridge.observe(settled("session.tool.success", "c-held"));
    expect(events.filter((e) => e.type === "tool_call").map((e) => `${e.callId}:${e.summary}`)).toEqual([
      `c-held:read /workspace/threads/t/main/src/a.ts (reaching ${vendor})`,
    ]);
    expect(events.filter((e) => e.type === "tool_result").map((e) => `${e.callId}:${e.ok}`)).toEqual(["c-held:true"]);
    expect(notes(events).filter((n) => n.kind === "directory_reached")).toEqual([]);
  });

  it("an external_directory ask held before the stream's session.tool.called opens the call: the directory rides the line the call opens with, beside the tool's own input, and no note is written", () => {
    const { bridge, events } = harness();
    const vendor = "/workspace/threads/t/main/vendor";
    bridge.observe(inputStarted("c-call", "read"));
    expect(bridge.observe(asked_("per_d", "c-call", "external_directory", vendor)).replies.map((r) => r.reply)).toEqual(
      ["once"],
    );
    bridge.observe(
      ev("session.tool.called", {
        sessionID: "ses_c",
        assistantMessageID: "msg_a0",
        id: "c-call",
        input: { filePath: "/workspace/threads/t/main/src/b.ts" },
        executed: false,
      }),
    );
    expect(events.filter((e) => e.type === "tool_call").map((e) => `${e.callId}:${e.summary}`)).toEqual([
      `c-call:read /workspace/threads/t/main/src/b.ts (reaching ${vendor})`,
    ]);
    expect(notes(events).filter((n) => n.kind === "directory_reached")).toEqual([]);
  });

  // harness.md item 13: a call the stream named (`session.tool.input.started`)
  // whose `session.tool.called` was lost is still the model's call — its own
  // ask names the tool and its target — and a call the record never opens is
  // one no interrupt or end can cut, its command invisible to the release.
  it("a call the stream named whose own ask arrives with its session.tool.called lost opens at the ask under the stream's name, so the loop's end can cut it: the cut lands on its line", () => {
    const { bridge, events } = harness();
    bridge.observe(inputStarted("c-own", "read"));
    expect(
      bridge
        .observe(asked_("per_o", "c-own", "read", "/workspace/threads/t/main/src/a.ts"))
        .replies.map((r) => r.reply),
    ).toEqual(["once"]);
    expect(events.filter((e) => e.type === "tool_call").map((e) => `${e.callId}:${e.tool}:${e.summary}`)).toEqual([
      "c-own:read:read /workspace/threads/t/main/src/a.ts",
    ]);
    bridge.closeOpenSpans(() => "cut at the loop's end", { cut: true });
    expect(events.filter((e) => e.type === "tool_result").map((e) => `${e.callId}:${e.ok}:${e.cut}`)).toEqual([
      "c-own:false:true",
    ]);
  });

  it("an external_directory ask held for a call the stream named but never opened — `session.tool.input.started` gave the name, `session.tool.called` was lost — opens the call at its settle under the stream's name with the held directory on its line, no tool_unnamed and no directory_reached note, so the settle lands on an announced call", () => {
    const { bridge, events } = harness();
    const vendor = "/workspace/threads/t/main/vendor";
    bridge.observe(inputStarted("c-named", "read"));
    expect(
      bridge.observe(asked_("per_d", "c-named", "external_directory", vendor)).replies.map((r) => r.reply),
    ).toEqual(["once"]);
    expect(events.filter((e) => e.type === "tool_call")).toEqual([]);
    bridge.observe(settled("session.tool.success", "c-named"));
    expect(
      events
        .filter((e) => e.type === "tool_call" || e.type === "tool_result")
        .map((e) => `${e.type}:${e.callId}:${e.tool}:${e.type === "tool_result" ? e.ok : e.summary}`),
    ).toEqual([`tool_call:c-named:read:read ${vendor}`, "tool_result:c-named:read:true"]);
    expect(notes(events).filter((n) => n.kind === "tool_unnamed" || n.kind === "directory_reached")).toEqual([]);
  });

  it("the tool's own ask and a resource permission's ask for the same call are both answered, in either order — the second is never mistaken for a refill of the first", () => {
    for (const order of [
      ["shell", "doom_loop"],
      ["doom_loop", "shell"],
    ] as const) {
      const { bridge } = harness();
      const replies: string[] = [];
      for (const [i, action] of order.entries()) {
        const out = bridge.observe(
          ev("permission.asked", {
            id: `per_${i}`,
            sessionID: "ses_c",
            action,
            resources: [action === "shell" ? "echo hi" : "*"],
            source: { type: "tool", messageID: "msg_a0", id: "c-same" },
          }),
        );
        replies.push(...out.replies.map((r) => `${r.requestID}:${r.reply}`));
      }
      expect(replies).toEqual(order[0] === "shell" ? ["per_0:once", "per_1:reject"] : ["per_0:reject", "per_1:once"]);
    }
  });

  it("a refusal on a call is sticky: the tool's own ask allowed after the repeat guard refused the call does not lift the refusal, so a success executed anyway is the gate bypassed", () => {
    const { bridge } = harness();
    bridge.observe(asked_("per_g", "c-stick", "doom_loop", "*"));
    bridge.observe(asked_("per_t", "c-stick", "shell", "echo hi"));
    bridge.observe(ev("permission.replied", { sessionID: "ses_c", requestID: "per_g", reply: "reject" }));
    bridge.observe(ev("permission.replied", { sessionID: "ses_c", requestID: "per_t", reply: "once" }));
    const ran = bridge.observe(
      ev("session.tool.success", {
        sessionID: "ses_c",
        assistantMessageID: "msg_a0",
        id: "c-stick",
        content: [{ type: "text", text: "hi" }],
        executed: true,
      }),
    );
    expect(ran.bypass).toBeDefined();
    expect(ran.bypass?.message).toMatch(/a success after the bot's refusal/);
  });

  it("a permission over something other than a tool whose call the store never names before the settle opens the call at the settle under the permission's own name, with a tool_unnamed note naming the call and the step, so the settle still lands on an announced call", () => {
    const { bridge, events } = harness();
    const directory = bridge.observe({
      feed: "permissions",
      at: NOW,
      sessionID: "ses_c",
      reason: "reconnect",
      data: [
        {
          id: "per_dir2",
          sessionID: "ses_c",
          action: "external_directory",
          resources: ["/workspace/threads/t/main/src"],
          source: { type: "tool", messageID: "msg_y", id: "c-dir2" },
        },
      ],
    });
    expect(directory.replies.map((r) => r.reply)).toEqual(["once"]);
    expect(events.filter((e) => e.type === "tool_call")).toEqual([]);
    bridge.observe(ev("permission.replied", { sessionID: "ses_c", requestID: "per_dir2", reply: "once" }));
    const settled = bridge.observe(
      ev("session.tool.success", {
        sessionID: "ses_c",
        assistantMessageID: "msg_y",
        id: "c-dir2",
        content: [{ type: "text", text: "the file" }],
        executed: true,
      }),
    );
    expect(settled.bypass).toBeUndefined();
    expect(
      events
        .filter((e) => e.type === "tool_call" || e.type === "tool_result")
        .map((e) => `${e.type}:${e.callId}:${e.tool}${e.type === "tool_result" ? `:${e.ok}` : ""}`),
    ).toEqual(["tool_call:c-dir2:external_directory", "tool_result:c-dir2:external_directory:true"]);
    expect(notes(events).filter((n) => n.kind === "tool_unnamed")).toHaveLength(1);
    expect(notes(events)[0]?.summary).toMatch(/c-dir2/);
    expect(notes(events)[0]?.summary).toMatch(/msg_y/);
    expect(doingWords(bridge.doingNow())).toBeUndefined();
  });

  it("catching up on a dead generation's feed, its execution failing is history the bridge says — a model call failed while the bot was away, or the proxy's turn budget reached while the bot was away — never this generation's settle, and its step is closed", () => {
    const { bridge, events } = harness();
    bridge.observing = "catching-up";
    bridge.observe(ev("session.step.started", { sessionID: "ses_c", assistantMessageID: "msg_dead", agent: "x" }));
    expect(doingWords(bridge.doingNow())).toBe(MODEL_CALL_IN_FLIGHT);
    const failed = bridge.observe(
      ev("session.execution.failed", { sessionID: "ses_c", error: { message: "the proxy answered 400" } }),
    );
    expect(failed.settled).toBe(false);
    expect(failed.providerError).toBeUndefined();
    expect(doingWords(bridge.doingNow())).toBeUndefined();
    const budget = bridge.observe(
      ev("session.execution.failed", {
        sessionID: "ses_c",
        error: { status: 403, message: "403 turn_budget_exhausted: the run is past its 60-turn guard" },
      }),
    );
    expect(budget.budgetStop).toBeUndefined();
    expect(notes(events).map((n) => n.summary)).toEqual([
      "a model call failed while the bot was away (the proxy answered 400); continuing",
      "the execution reached the proxy's turn budget while the bot was away (403 turn_budget_exhausted: the run is past its 60-turn guard); continuing",
    ]);
  });
});

// Feature: docs/reference/specs/harness.md item 13 — a steer's fate is the
// server's own events, and only the loop's leaving closes the tracker: an
// interrupt drops the steers waiting at that moment, never one posted after it.
describe("InboxFate — delivery confirmed by event, an interrupt drops only what waits, close latches", () => {
  it("a delivery before or after the wait resolves it true", async () => {
    const fate = new InboxFate();
    fate.deliver("i1");
    await expect(fate.wait("i1")).resolves.toBe(true);
    const later = fate.wait("i2");
    fate.deliver("i2");
    await expect(later).resolves.toBe(true);
  });

  it("interruptAll drops the waiters pending at that moment — and no others: a steer posted after the interrupt (the write-up's execution) is still delivered true", async () => {
    const fate = new InboxFate();
    const dropped = fate.wait("i1");
    fate.interruptAll();
    await expect(dropped).resolves.toBe(false);
    // F2: the tracker stays open — the loop-end cut's interrupted end must not
    // latch a follow-up steered into the write-up's execution as dropped.
    const afterCut = fate.wait("i2");
    fate.deliver("i2");
    await expect(afterCut).resolves.toBe(true);
  });

  it("close resolves every pending waiter false and answers every later wait false on the spot — idempotent", async () => {
    const fate = new InboxFate();
    const pending = fate.wait("i1");
    fate.close();
    await expect(pending).resolves.toBe(false);
    await expect(fate.wait("i2")).resolves.toBe(false);
    fate.close();
    await expect(fate.wait("i3")).resolves.toBe(false);
  });
});

// Feature: docs/reference/specs/harness.md item 13 — the store read newest
// first for a write the reset left unknown: the order on every page, the read
// stopping at the first row the caller knew before the write.
describe("readStoreSince — the newest rows, page by page, down to what was there before", () => {
  const row = (i: number) => ({ id: `m${i}`, type: "user", text: `t${i}`, time: { created: NOW } });
  const page = (rows: unknown[], next?: string) => ({
    status: 200,
    body: JSON.stringify({ data: rows, cursor: next ? { next } : {} }),
  });

  it("asks for order=desc and the limit on the first page and on every cursor page, stops at the first row known before — not at a row learned since — and names the row it stopped at", async () => {
    const paths: string[] = [];
    const first = Array.from({ length: 200 }, (_, i) => row(400 - i));
    const second = [row(200), row(199), row(198)];
    const get = async (path: string) => {
      paths.push(path);
      return path.includes("cursor=") ? page(second) : page(first, "c:desc:200");
    };
    const read = await readStoreSince(get, "ses_c", new Set(["m199"]));
    expect(paths).toEqual([
      "/api/session/ses_c/message?order=desc&limit=200",
      "/api/session/ses_c/message?cursor=c%3Adesc%3A200&order=desc&limit=200",
    ]);
    expect(read.ok && read.messages.slice(0, 3).map((m) => m.id)).toEqual(["m400", "m399", "m398"]);
    expect(read.ok && read.messages.length).toBe(201);
    expect(read.ok && read.messages.at(-1)?.id).toBe("m200");
    expect(read.ok && read.stopped?.id).toBe("m199");
  });

  it("a store whose newest row is already known answers no rows and names that row as the one it stopped at — what a steer's resolution reads the session's state from", async () => {
    const read = await readStoreSince(
      async () => page([{ id: "idle1", type: "idle", time: { created: NOW } }, row(1)]),
      "ses_c",
      new Set(["idle1", "m1"]),
    );
    expect(read).toEqual({ ok: true, messages: [], stopped: { id: "idle1", type: "idle", time: { created: NOW } } });
  });

  it("a page the server refuses or a page of another shape leaves the read refused by name, never partial", async () => {
    expect(await readStoreSince(async () => ({ status: 500, body: "" }), "ses_c", new Set())).toEqual({
      ok: false,
      why: "the server refused the session (500)",
    });
    expect(await readStoreSince(async () => ({ status: 200, body: "nope" }), "ses_c", new Set())).toEqual({
      ok: false,
      why: "the session's messages answered something that is not the page shape",
    });
  });
});

describe("wind-down parity, an undelivered follow-up, and the alive-here reconciliation", () => {
  // The budget note says what the run was at when the clock ran out, in pi's
  // words: the open tool calls by name, the model call a started step has under
  // way, or nothing between steps.
  it("doingNow: nothing before a step, the model call while a step is open, the open tools by name while they run, nothing once the execution settles", () => {
    const { bridge } = harness();
    expect(doingWords(bridge.doingNow())).toBeUndefined();
    bridge.observe(ev("session.step.started", { sessionID: "ses_c", assistantMessageID: "msg_a0" }));
    expect(doingWords(bridge.doingNow())).toBe(MODEL_CALL_IN_FLIGHT);
    bridge.observe(ev("session.tool.input.started", { sessionID: "ses_c", id: "c1", name: "shell" }));
    bridge.observe(ev("session.tool.called", { sessionID: "ses_c", id: "c1", input: { command: "ls" } }));
    expect(doingWords(bridge.doingNow())).toBe("running bash");
    bridge.observe(ev("session.tool.success", { sessionID: "ses_c", id: "c1", content: [], executed: true }));
    expect(doingWords(bridge.doingNow())).toBe(MODEL_CALL_IN_FLIGHT);
    bridge.observe(ev("session.step.ended", { sessionID: "ses_c", assistantMessageID: "msg_a0" }));
    expect(doingWords(bridge.doingNow())).toBeUndefined();
    bridge.observe(ev("session.step.started", { sessionID: "ses_c", assistantMessageID: "msg_a1" }));
    bridge.observe(ev("session.execution.failed", { sessionID: "ses_c", error: { message: "the stream closed" } }));
    bridge.observe(ev("session.idle", { sessionID: "ses_c" }));
    expect(doingWords(bridge.doingNow())).toBeUndefined();
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

  it("the wait observes the run: a hard stop requested while the container is down ends the wait at once and the run ends as the hard stop — the abort line as the answer, one stopped note in mode hard, the wait's note saying why, no verdict, the server and its tailer ended", async () => {
    const r = await run({
      ...oneCallOpen,
      transportLostThen: "same",
      containerDownForProbes: 50,
      hardStopDuringProbeWait: true,
    });
    expect(r.outcome).toEqual({ kind: "answered", answer: HARD_STOP_MESSAGE });
    expect(noteSummaries(r, "sandbox_restarted")).toEqual([]);
    expect(notes(r.events).filter((n) => n.kind === "stopped")).toEqual([expect.objectContaining({ mode: "hard" })]);
    expect(noteSummaries(r, "harness_error")).toEqual([
      expect.stringMatching(/^the one more command finds the container down/),
      "the wait ended after 0s: a hard stop was requested",
    ]);
    expect(r.killed.length).toBeGreaterThan(0);
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
