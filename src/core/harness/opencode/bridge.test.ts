import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../chatMessage.js";
import { analyzeRunFriction, isSetupInstallCommand } from "../../runFriction.js";
import { planResume, type KnownTool } from "../../runLedger/resume.js";
import type { RunEvent } from "../../runEvents.js";
import type { StepReport } from "../../runLedger/stepReport.js";
import { piDriver } from "../pi/testing/driver.js";
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
import { openCodeDriver } from "./testing/driver.js";

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

// Bind the record's disposition and observation types so a signature drift fails here.
const _obs: OpenCodeBridgeObservation = { replies: [], settled: false };
void _obs;
void assert;
