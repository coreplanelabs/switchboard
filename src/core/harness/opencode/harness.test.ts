import { describe, expect, it } from "vitest";
import type { RunnableTool } from "../../../tools/runnableTool.js";
import { updateStatusTool } from "../../../tools/status.js";
import type { ChatMessage } from "../../chatMessage.js";
import type { RunEvent } from "../../runEvents.js";
import { callsInFlight } from "../../runRecord.js";
import { HarnessContainerError, OP_TIMEOUT_MS } from "../container.js";
import {
  openThroughSeam,
  type HarnessDeps,
  type HarnessResume,
  type HarnessRun,
  type OpenCodeHarnessFacts,
  type PiHarnessFacts,
} from "../contract.js";
import { HarnessRegistry, relayToolCall, type LiveHarness } from "../pi/relay.js";
import { CONTROL_RESET_RESUMED_NOTE } from "../reattach.js";
import { RunRegistry } from "../../runRegistry.js";
import { followUpPrompt } from "../../threadAdmission.js";
import { PROXY_PROVIDER } from "../pi/process.js";
import { FakeHarnessContainer } from "../testing/fakeContainer.js";
import { FAILED_MODEL_CALL_ERROR, type DrivenRun, type RunScript } from "../testing/scenarios.js";
import { loopClock, MINUTE_MS } from "../../budgets.js";
import { recordingSink } from "../../testing/recordingSink.js";
import {
  finaleAbortReason,
  finaleTimedOutNote,
  finaleWaitNote,
  HARD_STOP_MESSAGE,
  MODEL_CALL_IN_FLIGHT,
  timeBudgetAnswer,
  toolCutNote,
  unlabelledAnswer,
  windDownFailureNote,
  wrapUpNeverPostedNote,
} from "../windDown.js";
import { bearerHashOf, RunBearerStore, type RunBearerGrant } from "../../modelProxy/runBearers.js";
import { createTracer } from "../../trace/tracer.js";
import type { HarnessStart } from "../container.js";
import { OPENCODE_EVENT_DISPOSITION } from "./dispositions.js";
import { OpenCodeHarness, resumeOpenCodeFacts } from "./harness.js";
import { OPENCODE_PASSWORD_ENV, openCodeRunPaths, TAILER_BIN } from "./process.js";
import { openCodeReplacedCallNote } from "./session.js";
import { OPENCODE_SERVE_PID_ENV } from "./tailerSource.js";
import {
  feedByteLength,
  LATE_BUDGET_REFUSAL,
  LATE_FAILURE_ERROR,
  openCodeDriver,
  scriptOpenCodeServe,
  TAILER_READY_NOTES,
  type FakeServeOptions,
} from "./testing/driver.js";

// Feature: docs/reference/specs/harness.md item 7 (U12) — OpenCode as the
// contract's object: the tables the loop reads, the identity's own tools in the
// record's words, and `find`/`end` over the recorded port and root. The run
// itself (`open`) is proven end to end by the conformance table
// (`../conformance.test.ts`, the fake serve, and `./testing/realDriver.test.ts`
// against the real binary).

const facts = (over: Partial<OpenCodeHarnessFacts> = {}): OpenCodeHarnessFacts => ({
  harness: "opencode",
  pid: 4242,
  port: 41_000,
  logOffset: 0,
  sessionID: "ses_run-c",
  root: openCodeRunPaths("run-c").dir,
  relaunches: 0,
  ...over,
});

describe("OpenCodeHarness — the contract's object", () => {
  const object = new OpenCodeHarness();

  it("declares its name, the authored-session survival word, and OpenCode's disposition table", () => {
    expect(object.name).toBe("opencode");
    expect(object.history).toBe("authored-session");
    expect(object.dispositions).toBe(OPENCODE_EVENT_DISPOSITION);
  });

  it("offers the identity's own tools in the record's shared vocabulary (shell → bash, glob → find); none for identity none", () => {
    expect(object.builtinTools("write")).toEqual(["read", "bash", "edit", "write", "find", "grep", "skill"]);
    expect(object.builtinTools("read")).toEqual(["read", "bash", "find", "grep", "skill"]);
    expect(object.builtinTools("none")).toEqual([]);
    // The record's words, so a tool call lands under the same name the roster names.
    expect(object.builtinTools("write")).not.toContain("shell");
    expect(object.builtinTools("write")).not.toContain("glob");
  });

  it("leaves the effort tier to OpenCode's default in stage A (no reasoning variants declared)", () => {
    expect(object.effort("high")).toBeUndefined();
    expect(object.effort(undefined)).toBeUndefined();
  });

  it("find answers another-harness for another harness's facts, with no container command", async () => {
    const container = new FakeHarnessContainer();
    const piFacts: PiHarnessFacts = { harness: "pi", pid: 7, logOffset: 0, relaunches: 0 };
    expect(await object.find(piFacts, container)).toBe("another-harness");
    // No probe was made — a foreign row is judged, and ended, by no OpenCode command.
    expect(container.requests).toHaveLength(0);
  });

  it("find answers another-container for a row naming another container, probing no pid there", async () => {
    const container = new FakeHarnessContainer();
    container.vm = "vm-here";
    expect(await object.find(facts({ container: "vm-old" }), container)).toBe("another-container");
    expect(container.requests).toHaveLength(0);
  });

  it("find answers alive-here when the recorded port answers (any status), dead when no server answers", async () => {
    const alive = new FakeHarnessContainer();
    alive.vm = "vm-here";
    // The password-guarded health answers 401 without the bearer find does not hold: an answer means the server is up.
    alive.onRequest = () => ({ status: 401, headers: {}, body: "" });
    expect(await object.find(facts({ container: "vm-here" }), alive)).toBe("alive-here");

    const dead = new FakeHarnessContainer();
    dead.vm = "vm-here";
    // No onRequest: a request reaches no server (connection refused).
    expect(await object.find(facts({ container: "vm-here" }), dead)).toBe("dead");
  });

  it("find rethrows a container gone under the probe, never reads it as dead", async () => {
    const container = new FakeHarnessContainer();
    container.failNext = { operation: "request", error: new HarnessContainerError("request", "runtime-replaced") };
    // A plain HarnessContainerError (not the typed gone error) is `dead`; the typed gone rethrows — covered by container.test.
    expect(await object.find(facts(), container)).toBe("dead");
  });

  it("end kills the server and its tailer at the pids the facts name and removes the root; another harness's facts are left alone", async () => {
    const container = new FakeHarnessContainer();
    await object.end(facts({ pid: 10, tailerPid: 11 }), container);
    expect(container.killed).toContain(10);
    expect(container.killed).toContain(11);
    expect(container.removed).toHaveLength(1);

    const other = new FakeHarnessContainer();
    await object.end({ harness: "pi", pid: 9, logOffset: 0, relaunches: 0 } as PiHarnessFacts, other);
    expect(other.killed).toHaveLength(0);
    expect(other.removed).toHaveLength(0);
  });
});

// Feature: docs/reference/specs/harness.md item 6 (the survival clause's
// ceiling on OpenCode) — the relaunch re-open branch of `open`: a resume the
// loop hands after the container was replaced (`resume.relaunch` set) takes the
// run's registration over with its relayed calls kept, probes and ends nothing
// at the row's pid or port, starts a fresh server on the record with the
// relaunch count carried, and says relaunched in one resumed note; and the
// other resume naming this container, whose server no longer answers.
describe("OpenCodeHarness — the relaunch in the replacement container, and a resume whose server is gone", () => {
  const request: ChatMessage = { role: "user", content: [{ type: "text", text: "fix the failing test" }] };
  const notes = (r: DrivenRun) =>
    r.events
      .filter((e): e is Extract<RunEvent, { type: "run_note" }> => e.type === "run_note")
      .map((e) => ({ kind: e.kind, summary: e.summary }));
  /** The port the driver's rows record for a previous generation's server. */
  const recordedPortOf = (facts: ReturnType<ReturnType<typeof openCodeDriver>["facts"]>): number =>
    facts.harness === "opencode" ? facts.port : -1;
  /** A relayed tool that answers when the test releases it, counting its runs. */
  function gated(name: string) {
    let release!: (text: string) => void;
    const answered = new Promise<string>((r) => (release = r));
    let runs = 0;
    const tool: RunnableTool = {
      name,
      description: "waits",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        runs++;
        return answered;
      },
    };
    return { tool, release, runs: () => runs };
  }

  it("a relaunch takes the run's registration over with its relayed calls kept — the same calls object, the still-running call in flight and never re-run — probes and ends nothing at the row's pid, port or root, starts one fresh server on the record with the relaunch count carried and the container it runs in recorded, imports the in-flight call's settlement, and says relaunched in one resumed note", async () => {
    const registry = new HarnessRegistry();
    const slow = gated("slow");
    // A relayed tool that looks at the relay from inside the relaunched run: the bot's view mid-run.
    let seen: { same: boolean; inFlight: string[] } | undefined;
    const probe: RunnableTool = {
      name: "probe",
      description: "reads the relay",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        seen = { same: registry.calls("run-c") === calls, inFlight: calls.inFlight() };
        return "probed";
      },
    };
    const tools = [slow.tool, probe, updateStatusTool];
    // The registration the OpenCode that died with its container left standing, its slow call still running in the bot.
    const before: LiveHarness = {
      runId: "run-c",
      tools,
      toolContext: { executor: { exec: async () => "", readFile: async () => "", writeFile: async () => "" } },
      rules: { identity: "write", checkout: "/workspace/threads/t/main", protectedBranches: ["main"] },
      emit: () => {},
      toolSpan: () => undefined,
      gateSaw: () => {},
      toolsBlocked: () => undefined,
    };
    registry.register(before);
    const calls = registry.calls("run-c")!;
    void relayToolCall(before, calls, { toolCallId: "c-s", tool: "slow", input: {} }, { windowMs: 1 });
    await new Promise((r) => setImmediate(r));
    expect(calls.inFlight()).toEqual(["c-s"]);

    const driver = openCodeDriver({ registry });
    const slowUse = { type: "tool_use" as const, id: "c-s", name: "slow", input: {} };
    const recordedRoot = "/tmp/switchboard-oc-run-c-before";
    const rowFacts = {
      ...driver.facts({ pid: 999, container: "vm-fake", root: recordedRoot }),
      tailerPid: 888,
      logOffset: 120,
      relaunches: 1,
    };
    const r = await driver.run({
      turns: [
        { content: [{ type: "tool_use", id: "c2", name: "probe", input: {} }], stopReason: "tool_use" },
        { content: [{ type: "text", text: "continued after the relaunch" }], stopReason: "end_turn" },
      ],
      relayed: tools,
      containerWord: "vm-new",
      resume: {
        messages: [request, { role: "assistant", content: [slowUse] }],
        settlements: [{ toolUse: slowUse, action: "synthetic", text: openCodeReplacedCallNote("slow") }],
        remainingMs: 20 * 60_000,
        turn: 1,
        inboxConsumedSeq: 0,
        facts: rowFacts,
        relaunch: { from: "vm-fake", to: "vm-new" },
      },
    });
    expect(r.outcome).toEqual({ kind: "answered", answer: "continued after the relaunch" });
    // The calls object was handed over, not re-made: the relaunched run's relay is the one the dead OpenCode's calls ran on, the slow call still in flight there and never re-run.
    expect(seen).toEqual({ same: true, inFlight: ["c-s"] });
    expect(slow.runs()).toBe(1);
    // Nothing of the row's is probed, ended or removed here: its pid and its tailer's are strangers' in this container, its root was on the old disk, its port is nobody's.
    expect(r.killed).not.toContain(999);
    expect(r.killed).not.toContain(888);
    expect(r.removed).not.toContain(recordedRoot);
    expect(r.requests.some((q) => q.port === recordedPortOf(rowFacts))).toBe(false);
    expect(r.starts).toHaveLength(1);
    // The row: the fresh server's pid, the container it runs in, the relaunch count carried unchanged, the bearer's hash.
    expect(r.facts[0]).toMatchObject({
      harness: "opencode",
      pid: 4242,
      container: "vm-new",
      relaunches: 1,
      bearerHash: expect.any(String),
    });
    // One resumed note, the relaunch's words.
    expect(notes(r).filter((n) => n.kind === "resumed")).toEqual([
      {
        kind: "resumed",
        summary:
          "relaunched after the container was replaced (vm-fake → vm-new); a fresh server was started on the record with 20 min of budget left",
      },
    ]);
    // The rebuild imported the record with the in-flight call settled by the replaced note.
    const imported = r.requests.find((q) => q.path === "/api/session/import");
    expect(imported).toBeDefined();
    const body = JSON.parse(imported!.body ?? "{}") as { messages: Array<{ type: string; content?: unknown[] }> };
    const settledContent = body.messages
      .filter((m) => m.type === "assistant")
      .flatMap(
        (m) =>
          (m.content ?? []) as Array<{
            type: string;
            id?: string;
            state?: { status: string; error?: { message: string } };
          }>,
      )
      .find((c) => c.type === "tool" && c.id === "c-s");
    expect(settledContent?.state).toMatchObject({
      status: "error",
      error: { message: openCodeReplacedCallNote("slow") },
    });
    // The run's end ends the calls with it, the straggler included.
    expect(registry.get("run-c")).toBeUndefined();
    expect(calls.signal.aborted).toBe(true);
    slow.release("too late");
  });

  it("a resume naming this container whose server no longer answers on the recorded port probes it once, ends nothing of the row's, removes its recorded root, starts one fresh server on the record, and says the row's OpenCode did not answer", async () => {
    const driver = openCodeDriver();
    const recordedRoot = "/tmp/switchboard-oc-run-c-before";
    const rowFacts = {
      ...driver.facts({ pid: 999, container: driver.containerWord, root: recordedRoot }),
      tailerPid: 888,
    };
    const r = await driver.run({
      turns: [{ content: [{ type: "text", text: "fresh" }], stopReason: "end_turn" }],
      processAliveOnResume: false,
      resume: {
        messages: [request],
        settlements: [],
        remainingMs: 300_000,
        turn: 0,
        inboxConsumedSeq: 0,
        facts: rowFacts,
      },
    });
    expect(r.outcome).toEqual({ kind: "answered", answer: "fresh" });
    // The recorded port was probed — and refused the connection — before the fresh start.
    const probes = r.requests.filter((q) => q.port === recordedPortOf(rowFacts));
    expect(probes.map((q) => q.path)).toEqual(["/api/health"]);
    // A pid that does not answer is nobody's here; the dead server's root on this disk goes.
    expect(r.killed).not.toContain(999);
    expect(r.killed).not.toContain(888);
    expect(r.removed[0]).toBe(recordedRoot);
    expect(r.starts).toHaveLength(1);
    expect(
      notes(r)
        .filter((n) => n.kind === "resumed")
        .map((n) => n.summary),
    ).toEqual([
      "resumed after a restart: the row's OpenCode did not answer in this container; a fresh server was started on the record with 5 min of budget left",
    ]);
  });
});

// Feature: docs/reference/specs/harness.md item 13 — the re-attach onto a server
// that still answers in this container: a resume whose row names this container
// and carries the bearer's hash continues the session the dead generation drove
// — no second server, the tailer kept or restarted over the same feed, the feed
// read from the row's offset, the pending asks decided through the gate, the
// in-flight call's result reaching the record — and falls back to ending the
// server before a fresh start only when the re-attach itself cannot be done.
describe("OpenCodeHarness — the re-attach onto a still-answering server", () => {
  const request: ChatMessage = { role: "user", content: [{ type: "text", text: "fix the failing test" }] };
  const notes = (r: DrivenRun) =>
    r.events
      .filter((e): e is Extract<RunEvent, { type: "run_note" }> => e.type === "run_note")
      .map((e) => ({ kind: e.kind, summary: e.summary }));
  const toolResults = (r: DrivenRun) =>
    r.events.filter((e): e is Extract<RunEvent, { type: "tool_result" }> => e.type === "tool_result");
  const toolCalls = (r: DrivenRun) =>
    r.events.filter((e): e is Extract<RunEvent, { type: "tool_call" }> => e.type === "tool_call");
  const recordedPortOf = (facts: ReturnType<ReturnType<typeof openCodeDriver>["facts"]>): number =>
    facts.harness === "opencode" ? facts.port : -1;
  /** The row a dead generation left for its server in this container, with what a re-attach needs. */
  const rowFor = (
    driver: ReturnType<typeof openCodeDriver>,
    over: Partial<OpenCodeHarnessFacts> = {},
  ): OpenCodeHarnessFacts => {
    const base = driver.facts({ pid: 999, container: driver.containerWord, bearerHash: bearerHashOf(driver.bearer) });
    if (base.harness !== "opencode") throw new Error("the OpenCode driver wrote another harness's facts");
    return { ...base, tailerPid: 888, ...over };
  };
  const resume = (facts: OpenCodeHarnessFacts, messages: ChatMessage[], settlements: HarnessResume["settlements"]) => ({
    messages,
    settlements,
    remainingMs: 20 * 60_000,
    turn: 1,
    inboxConsumedSeq: 0,
    facts,
  });

  it("re-attaches onto the server with the row's password: no second server, the tailer kept, the store read back and the session steered on — the relayed call in flight is answered from the record when the plugin asks again, its result reaches the record as the next step's user turn, the row carries the tailer, the container and the offset with the relaunch count unchanged, the offset follows the refills, and one resumed note says the process still runs", async () => {
    const driver = openCodeDriver();
    const inFlight = { type: "tool_use" as const, id: "c-s", name: "update_status", input: { checklist: "step 1" } };
    const rowFacts = rowFor(driver, { logOffset: feedByteLength(TAILER_READY_NOTES) });
    const r = await driver.run({
      turns: [{ content: [{ type: "text", text: "picked up mid-call" }], stopReason: "end_turn" }],
      processAliveOnResume: true,
      resume: resume(
        rowFacts,
        [request, { role: "assistant", content: [inFlight] }],
        [{ toolUse: inFlight, action: "rerun" }],
      ),
    });
    expect(r.outcome).toEqual({ kind: "answered", answer: "picked up mid-call" });
    // No second server; the live server and its tailer end once, at the session's end, never before.
    expect(r.starts).toHaveLength(0);
    expect(r.killed).toEqual([999, 888]);
    // The row's server, on its recorded port, with the row's password as the Basic auth on every request: the health, the store, the pending asks, then the continue steered into the execution under way.
    const recorded = r.requests.filter((q) => q.port === recordedPortOf(rowFacts));
    expect(recorded.map((q) => `${q.method} ${q.path}`).slice(0, 4)).toEqual([
      "GET /api/health",
      "GET /api/session/ses_run-c/message?order=asc&limit=200",
      "GET /api/session/ses_run-c/permission",
      "POST /api/session/ses_run-c/prompt",
    ]);
    for (const q of recorded) expect(q.secretHeaders).toEqual({ Authorization: expect.stringMatching(/^Basic /) });
    expect(JSON.parse(recorded[3].body ?? "{}")).toMatchObject({ delivery: "steer" });
    expect(r.requests.some((q) => q.path === "/api/session/import")).toBe(false);
    // The relayed call the plugin re-asked for was answered from the record — the tool never ran in the bot — and its settlement is on the record as the call's result.
    expect(r.statusReports).toEqual([]);
    expect(toolResults(r).map((e) => [e.callId, e.ok])).toEqual([["c-s", false]]);
    expect(toolResults(r)[0].tool).toBe("update_status");
    // The ledger: the step after the transcript carries the settlement as its user turn (with the continue's echo), then the answer; nothing of the transcript is written twice.
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].firstIdx).toBe(2);
    const [settled, answer] = r.steps[0].turns;
    expect(settled.role).toBe("user");
    expect(settled.content[0]).toMatchObject({ type: "tool_result", toolUseId: "c-s", isError: true });
    expect(answer).toEqual({ role: "assistant", content: [{ type: "text", text: "picked up mid-call" }] });
    // The model's view: the transcript, the call's result, then the continue it was told.
    const view = r.modelCalls[0].messages;
    expect(view.slice(0, 2)).toEqual([request, { role: "assistant", content: [inFlight] }]);
    expect(view[2].content[0]).toMatchObject({ type: "tool_result", toolUseId: "c-s" });
    // The row: the same pid, port and hash, the tailer kept, the container it was found in, the count carried, the offset at the feed's edge and then following the refills.
    expect(r.facts[0]).toEqual({
      ...rowFacts,
      tailerPid: 888,
      container: driver.containerWord,
      logOffset: expect.any(Number),
    });
    expect(r.facts[0].logOffset).toBeGreaterThan(rowFacts.logOffset);
    expect(r.facts.at(-1)!.logOffset).toBeGreaterThan(r.facts[0].logOffset);
    expect(r.facts.every((f) => f.relaunches === 0 && f.pid === 999)).toBe(true);
    // One resumed note, the re-attach's words; no harness_error.
    expect(notes(r).filter((n) => n.kind === "resumed")).toEqual([
      {
        kind: "resumed",
        summary:
          "resumed after a restart: OpenCode still runs in the container (pid 999, port 41001); continuing its session with 20 min of budget left — 1 call(s) were in flight, each answered with a restart note if OpenCode asks the relay for it again",
      },
    ]);
    expect(notes(r).filter((n) => n.kind === "harness_error")).toEqual([]);
  });

  it("a tailer that died with the bot is restarted over the same feed with keepLog and the password, the feed is read from the row's offset — nothing before it is said again, everything after it is — and the note and the row carry the new tailer", async () => {
    let container: { starts: HarnessStart[] } | undefined;
    // What the dead generation's tailer wrote before the row's offset: an earlier call, settled and on the record already.
    const earlier = { sessionID: "ses_run-c", assistantMessageID: "msg_a0", id: "c0" };
    const feedBefore = [
      {
        feed: "event",
        at: 1,
        event: { id: "e1", type: "session.tool.input.started", data: { ...earlier, name: "shell" } },
      },
      {
        feed: "event",
        at: 1,
        event: { id: "e2", type: "session.tool.called", data: { ...earlier, input: {}, executed: false } },
      },
      {
        feed: "event",
        at: 1,
        event: { id: "e3", type: "session.tool.success", data: { ...earlier, content: [], executed: true } },
      },
    ];
    const options: FakeServeOptions = {
      reattach: { tailerDead: true, feedBefore },
      inspectContainer: (c) => (container = c),
    };
    const driver = openCodeDriver(options);
    const inFlight = { type: "tool_use" as const, id: "c-s", name: "update_status", input: { checklist: "step 1" } };
    const rowFacts = rowFor(driver, { logOffset: feedByteLength([...TAILER_READY_NOTES, ...feedBefore]) });
    const r = await driver.run({
      turns: [{ content: [{ type: "text", text: "on we go" }], stopReason: "end_turn" }],
      processAliveOnResume: true,
      resume: resume(
        rowFacts,
        [request, { role: "assistant", content: [inFlight] }],
        [{ toolUse: inFlight, action: "rerun" }],
      ),
    });
    expect(r.outcome).toEqual({ kind: "answered", answer: "on we go" });
    expect(r.starts).toHaveLength(0);
    // The tailer's restart: node on the row's root's script, over the feed with keepLog, the row's password and server pid, the recorded port.
    const tailers = container!.starts.filter((s) => s.command === TAILER_BIN);
    expect(tailers).toHaveLength(1);
    expect(tailers[0]).toMatchObject({
      keepLog: true,
      port: 41001,
      args: [`${rowFacts.root}/tailer.js`],
      env: { [OPENCODE_PASSWORD_ENV]: bearerHashOf(driver.bearer), [OPENCODE_SERVE_PID_ENV]: "999" },
    });
    expect(tailers[0].paths.log).toBe(`${rowFacts.root}/feed.jsonl`);
    // Nothing before the offset is said again; the in-flight call's records after it are read (its call narrated once, its result once).
    expect(toolCalls(r).map((e) => e.callId)).toEqual(["c-s"]);
    expect(toolResults(r).map((e) => e.callId)).toEqual(["c-s"]);
    // The note names the restart; the row carries the new tailer's pid and the dead one is never ended.
    const resumed = notes(r).filter((n) => n.kind === "resumed");
    expect(resumed).toHaveLength(1);
    expect(resumed[0].summary).toMatch(
      /^resumed after a restart: OpenCode still runs in the container \(pid 999, port 41001\)/,
    );
    expect(resumed[0].summary).toMatch(/; its tailer had died and was restarted on the same feed \(pid 4242\)$/);
    expect(r.facts[0]).toMatchObject({ tailerPid: 4242, pid: 999 });
    expect(r.killed).not.toContain(888);
  });

  it.each([
    {
      shape: "allowed",
      command: "echo hi",
      reply: "once",
      ok: true,
      text: "ran: echo hi",
    },
    {
      shape: "refused",
      command: "git push origin main",
      reply: "reject",
      ok: false,
      text: /main/,
    },
  ])(
    "an ask pending on the server at the re-attach is decided through the gate — $shape — exactly once, the tool runs or fails on that reply, and its result reaches the record",
    async ({ command, reply, ok, text }) => {
      const driver = openCodeDriver();
      const inFlight = { type: "tool_use" as const, id: "c0", name: "bash", input: { command } };
      const rowFacts = rowFor(driver);
      const r = await driver.run({
        turns: [{ content: [{ type: "text", text: "after the ask" }], stopReason: "end_turn" }],
        processAliveOnResume: true,
        resume: resume(
          rowFacts,
          [request, { role: "assistant", content: [inFlight] }],
          [{ toolUse: inFlight, action: "rerun" }],
        ),
      });
      expect(r.outcome).toEqual({ kind: "answered", answer: "after the ask" });
      expect(r.starts).toHaveLength(0);
      // One reply, the gate's, posted to the recorded server — the feed's own copy of the ask is not replied to again.
      const replies = r.requests.filter((q) => /\/permission\/per_c0\/reply$/.test(q.path));
      expect(replies).toHaveLength(1);
      expect(replies[0].port).toBe(recordedPortOf(rowFacts));
      expect(JSON.parse(replies[0].body ?? "{}")).toMatchObject({ reply });
      // The call's result on the record, and on the ledger as the next step's user turn.
      const result = toolResults(r).find((e) => e.callId === "c0");
      expect(result).toMatchObject({ tool: "bash", ok });
      expect(result?.summary ?? "").toMatch(text);
      expect(r.steps[0].turns[0].content[0]).toMatchObject({ type: "tool_result", toolUseId: "c0" });
      if (!ok) expect(notes(r).some((n) => n.kind === "tool_refused" && /main/.test(n.summary))).toBe(true);
      expect(notes(r).filter((n) => n.kind === "harness_error")).toEqual([]);
      expect(
        notes(r)
          .filter((n) => n.kind === "resumed")
          .map((n) => n.summary),
      ).toEqual([
        "resumed after a restart: OpenCode still runs in the container (pid 999, port 41001); continuing its session with 20 min of budget left — 1 call(s) were in flight, 1 of them pending asks the gate decides, the rest answered with a restart note if OpenCode asks the relay for them again",
      ]);
    },
  );

  /** One feed record as the dead generation's tailer wrote it. */
  const feedEvent = (type: string, data: Record<string, unknown>) => ({
    feed: "event",
    at: 1,
    event: { id: `e_${type}_${JSON.stringify(data).length}`, type, created: 1, data },
  });

  it("an ask pending at the bot's death that was answered while the bot was away — its call in flight on the record, the ask no longer pending, its echo and the tool's run in the catch-up window — fails the run closed as the gate bypassed: nobody alive can be named for the reply, no reply is posted, no second server starts, the server and its tailer are ended", async () => {
    const driver = openCodeDriver({ reattach: { answeredWhileAway: true } });
    const inFlight = { type: "tool_use" as const, id: "c0", name: "bash", input: { command: "rm -rf build" } };
    const rowFacts = rowFor(driver);
    const r = await driver.run({
      turns: [{ content: [{ type: "text", text: "never" }], stopReason: "end_turn" }],
      processAliveOnResume: true,
      resume: resume(
        rowFacts,
        [request, { role: "assistant", content: [inFlight] }],
        [{ toolUse: inFlight, action: "rerun" }],
      ),
    });
    expect(r.outcome.kind).toBe("failed");
    const error = r.outcome.kind === "failed" ? r.outcome.error : undefined;
    expect(error?.name).toBe("OpenCodeGateBypassedError");
    expect(error?.message).toMatch(
      /bash \(call c0\): an ask pending at the bot's death was answered while the bot was away; the run cannot tell by whom/,
    );
    // Nothing was replied by this generation, nothing started beside the live server, and the server and its tailer are ended: fail closed.
    expect(r.requests.some((q) => /\/permission\/per_c0\/reply$/.test(q.path))).toBe(false);
    expect(r.starts).toHaveLength(0);
    expect(r.killed).toEqual([999, 888]);
    expect(notes(r).some((n) => n.kind === "harness_error" && /bypassed.*bash \(call c0\)/.test(n.summary))).toBe(true);
  });

  it("an exchange the ledger already holds, read again because the row's offset lagged the write — the ask, the dead generation's echo and the result of a call whose result is on the record — is adopted as that generation's word: nothing is replied, nothing is written twice, and the run answers", async () => {
    const c0 = { type: "tool_use" as const, id: "c0", name: "bash", input: { command: "echo hi" } };
    const at = { sessionID: "ses_run-c", assistantMessageID: "msg_ses_run-c_a1", id: "c0" };
    const feedAfter = [
      feedEvent("session.tool.input.started", { ...at, name: "shell" }),
      feedEvent("session.tool.called", { ...at, input: { command: "echo hi" }, executed: false }),
      feedEvent("permission.asked", {
        id: "per_c0",
        sessionID: "ses_run-c",
        action: "shell",
        resources: ["echo hi"],
        source: { type: "tool", messageID: at.assistantMessageID, id: "c0" },
      }),
      feedEvent("permission.replied", { sessionID: "ses_run-c", requestID: "per_c0", reply: "once" }),
      feedEvent("session.tool.success", { ...at, content: [{ type: "text", text: "hi" }], executed: true }),
    ];
    const driver = openCodeDriver({ reattach: { feedAfter } });
    const rowFacts = rowFor(driver, { logOffset: feedByteLength(TAILER_READY_NOTES) });
    const r = await driver.run({
      turns: [{ content: [{ type: "text", text: "carried on" }], stopReason: "end_turn" }],
      processAliveOnResume: true,
      resume: resume(
        rowFacts,
        [
          request,
          { role: "assistant", content: [c0] },
          { role: "user", content: [{ type: "tool_result", toolUseId: "c0", content: "hi" }] },
        ],
        [],
      ),
    });
    expect(r.outcome).toEqual({ kind: "answered", answer: "carried on" });
    expect(r.requests.some((q) => /\/permission\/per_c0\/reply$/.test(q.path))).toBe(false);
    expect(notes(r).filter((n) => n.kind === "harness_error")).toEqual([]);
    // The exchange is narrated once more and the ledger's rows are not written again: the one step is the answer, past the transcript.
    expect(toolCalls(r).map((e) => e.callId)).toEqual(["c0"]);
    expect(toolResults(r).map((e) => [e.callId, e.ok])).toEqual([["c0", true]]);
    expect(r.steps.map((s) => [s.firstIdx, s.turns.map((t) => t.role)])).toEqual([[3, ["assistant"]]]);
  });

  it("the row's bearer joins this generation's proxy only once every check has passed: after a refused re-attach the dead generation's bearer is still refused at the proxy, after one that went through it verifies there", async () => {
    const clock = () => 1_700_000_000_000;
    const grant = (): RunBearerGrant => ({
      runId: "run-c",
      modelRef: "anthropic/claude-fable-5",
      providerName: "anthropic",
      providerType: "anthropic",
      model: "claude-fable-5",
      maxTokens: 4096,
      maxTurns: 50,
      expiresAt: clock() + 60 * 60_000,
      span: createTracer({ clock }).start("request", { sinks: [] }),
      publish: () => {},
    });
    const inFlight = { type: "tool_use" as const, id: "c-s", name: "update_status", input: { checklist: "step 1" } };
    const run = async (options: FakeServeOptions) => {
      const driver = openCodeDriver(options);
      const r = await driver.run({
        turns: [{ content: [{ type: "text", text: "went through" }], stopReason: "end_turn" }],
        processAliveOnResume: true,
        resume: resume(
          rowFor(driver),
          [request, { role: "assistant", content: [inFlight] }],
          [{ toolUse: inFlight, action: "rerun" }],
        ),
      });
      return { driver, r };
    };
    // Refused after the health passed (the session refused): the row's bearer never joins this generation's proxy, and the fresh start runs on this generation's own.
    const refused = new RunBearerStore({ clock });
    refused.mint(grant());
    const a = await run({ bearers: refused, reattach: { refuseSession: true } });
    expect(a.r.outcome).toEqual({ kind: "answered", answer: "went through" });
    expect(a.r.starts).toHaveLength(1);
    expect(refused.verify(a.driver.bearer)).toMatchObject({ ok: false, reason: "unknown_bearer" });
    // Went through: the bearer the server keeps presenting verifies on this generation's proxy beside its own.
    const adopted = new RunBearerStore({ clock });
    adopted.mint(grant());
    const b = await run({ bearers: adopted });
    expect(b.r.outcome).toEqual({ kind: "answered", answer: "went through" });
    expect(b.r.starts).toHaveLength(0);
    expect(adopted.verify(b.driver.bearer)).toMatchObject({ ok: true });
  });

  it("a transcript with a compaction row aligns too: the store's compaction message projects to nothing and the ledger counts the row, so the first step after the re-attach lands past the transcript and the compaction", async () => {
    const driver = openCodeDriver();
    const inFlight = { type: "tool_use" as const, id: "c-s", name: "update_status", input: { checklist: "step 1" } };
    const rowFacts = rowFor(driver);
    const r = await driver.run({
      turns: [{ content: [{ type: "text", text: "after the summary" }], stopReason: "end_turn" }],
      processAliveOnResume: true,
      resume: {
        ...resume(
          rowFacts,
          [request, { role: "assistant", content: [inFlight] }],
          [{ toolUse: inFlight, action: "rerun" }],
        ),
        compactions: [{ before: 1, entry: { summary: "the request, summarised" } }],
      },
    });
    expect(r.outcome).toEqual({ kind: "answered", answer: "after the summary" });
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].firstIdx).toBe(3);
    expect(r.steps[0].turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(r.steps[0].turns[0].content[0]).toMatchObject({ type: "tool_result", toolUseId: "c-s" });
  });

  it.each([
    {
      fault: "refuses the session",
      options: { reattach: { refuseSession: true } },
      why: /the server refused the session \(404\)/,
    },
    {
      fault: "never ends its store",
      options: { reattach: { endlessStore: true } },
      why: /the session's store did not end within 10000 pages; the run does not continue on a partial store/,
    },
    {
      fault: "refuses the password",
      options: { reattach: { refusePassword: true } },
      why: /the server refused the run's password/,
    },
    {
      fault: "runs another version",
      options: { reattach: { otherVersion: "1.0.0" } },
      why: /the server is opencode 1\.0\.0; this build drives/,
    },
    {
      fault: "has an unreadable feed",
      options: { reattach: { feedUnreadable: true } },
      why: /the feed could not be read from byte 0/,
    },
    {
      fault: "is named by a row with no bearer hash",
      options: {},
      why: /the row carries no bearer hash/,
      noHash: true,
    },
  ])(
    "a server that answers but $fault cannot be re-attached: it and its tailer are ended and its root removed before one fresh start on the record, and the one resumed note says why",
    async ({ options, why, noHash }) => {
      const driver = openCodeDriver(options as FakeServeOptions);
      const rowFacts = rowFor(driver);
      if (noHash) delete (rowFacts as { bearerHash?: string }).bearerHash;
      const r = await driver.run({
        turns: [{ content: [{ type: "text", text: "fresh" }], stopReason: "end_turn" }],
        processAliveOnResume: true,
        resume: resume(rowFacts, [request], []),
      });
      expect(r.outcome).toEqual({ kind: "answered", answer: "fresh" });
      // Ended before the fresh start: the row's pids first, then the fresh server's and its tailer's at the session's end.
      expect(r.killed.slice(0, 2)).toEqual([999, 888]);
      expect(r.removed[0]).toBe(rowFacts.root);
      expect(r.starts).toHaveLength(1);
      const resumed = notes(r).filter((n) => n.kind === "resumed");
      expect(resumed).toHaveLength(1);
      expect(resumed[0].summary).toMatch(
        /^resumed after a restart: the row's OpenCode \(pid 999\) still answers in this container but could not be re-attached \(/,
      );
      expect(resumed[0].summary).toMatch(why);
      expect(resumed[0].summary).toMatch(
        /\); ended it and its tailer before a fresh start on the record with 20 min of budget left$/,
      );
    },
  );
});

// Feature: docs/reference/specs/harness.md item 13 — every model reference the
// harness sends names the configuration's one provider. The run's model rides
// the bot's provider NAME (`anthropic` on a live deployment), but the
// configuration the launch writes defines exactly one provider, `switchboard`
// (the proxy), with the model under it; a ref naming any other provider is one
// OpenCode cannot resolve (`Model unavailable: anthropic/<id>`), which two live
// runs met on their first turn. The fake serve resolves every ref against the
// written configuration as the real server does, so the table catches it.
describe("the model reference on every request that carries one names the configuration's provider", () => {
  const request: ChatMessage = { role: "user", content: [{ type: "text", text: "do the thing" }] };
  const modelRefsOf = (r: DrivenRun) =>
    r.requests
      .filter((q) => q.method === "POST" && (q.path === "/api/session" || q.path === "/api/session/import"))
      .map((q) => {
        const body = JSON.parse(q.body ?? "{}") as { model?: unknown; info?: { model?: unknown } };
        return { path: q.path, model: q.path === "/api/session" ? body.model : body.info?.model };
      });

  it("a fresh run of one turn creates its session with switchboard/<id>; a run with a seed imports it under the same ref; a rebuild's import too — never the bot's provider name", async () => {
    const driver = openCodeDriver();
    const oneTurn = await driver.run({ turns: [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }] });
    expect(oneTurn.outcome).toEqual({ kind: "answered", answer: "ok" });
    expect(modelRefsOf(oneTurn)).toEqual([
      { path: "/api/session", model: { providerID: PROXY_PROVIDER, id: "claude-fable-5" } },
    ]);

    const seeded = await driver.run({
      seed: [
        { role: "user", content: [{ type: "text", text: "earlier" }] },
        { role: "assistant", content: [{ type: "text", text: "answered" }] },
      ],
      turns: [{ content: [{ type: "text", text: "continuing" }], stopReason: "end_turn" }],
    });
    expect(seeded.outcome).toEqual({ kind: "answered", answer: "continuing" });
    expect(modelRefsOf(seeded)).toEqual([
      { path: "/api/session/import", model: { providerID: PROXY_PROVIDER, id: "claude-fable-5" } },
    ]);

    const rebuilt = await driver.run({
      turns: [{ content: [{ type: "text", text: "resumed" }], stopReason: "end_turn" }],
      resume: {
        messages: [request, { role: "assistant", content: [{ type: "text", text: "half way" }] }],
        settlements: [],
        remainingMs: 300_000,
        turn: 1,
        inboxConsumedSeq: 0,
        facts: driver.facts({ pid: 999, container: "vm-old" }),
      },
    });
    expect(rebuilt.outcome).toEqual({ kind: "answered", answer: "resumed" });
    expect(modelRefsOf(rebuilt)).toEqual([
      { path: "/api/session/import", model: { providerID: PROXY_PROVIDER, id: "claude-fable-5" } },
    ]);
    // The bot's provider name reaches no request at all.
    for (const r of [oneTurn, seeded, rebuilt])
      expect(r.requests.some((q) => (q.body ?? "").includes('"providerID":"anthropic"'))).toBe(false);
  });

  it("the fake serve resolves the session's reference as the real server does — the create admitted, the prompt admitted, the execution failing at once in the server's words with no idle after it — the guard that turns the table red (a hang on the old loop, a failure by name on this one) when the harness names the wrong provider", async () => {
    let container: FakeHarnessContainer | undefined;
    const driver = openCodeDriver({ inspectContainer: (c) => void (container = c) });
    await driver.run({ turns: [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }] });
    const post = (path: string, body: unknown) =>
      container!.request(openCodeRunPaths("run-c"), {
        method: "POST",
        port: container!.freePort,
        path,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const feedFrom = async (offset: number) =>
      Buffer.from(await container!.readLog(openCodeRunPaths("run-c").feed, offset, 1024 * 1024))
        .toString("utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map(
          (l) => JSON.parse(l) as { feed: string; event?: { type: string; data?: { error?: { message?: string } } } },
        );
    const before = Buffer.byteLength(
      Buffer.from(await container!.readLog(openCodeRunPaths("run-c").feed, 0, 1024 * 1024)).toString("utf8"),
    );
    // The bot's provider name where the configuration's key belongs: admitted at the create…
    expect((await post("/api/session", { model: { providerID: "anthropic", id: "claude-fable-5" } })).status).toBe(200);
    // …admitted at the prompt…
    expect((await post("/api/session/ses_run-c/prompt", { text: "go", delivery: "queue" })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    // …and the execution fails at once, in the server's words, with the refills (the pending asks, then the store — the tailer's order) and no idle event after it.
    const kinds = (await feedFrom(before)).map((r) => (r.feed === "event" ? r.event!.type : r.feed));
    expect(kinds).toEqual(["session.execution.started", "session.execution.failed", "permissions", "messages"]);
    const failed = (await feedFrom(before)).find((r) => r.event?.type === "session.execution.failed");
    expect(failed?.event?.data?.error?.message).toBe("Model unavailable: anthropic/claude-fable-5");
    // A model the configuration does not list under the right provider fails the same way.
    const mid = before + Buffer.byteLength((await feedFrom(before)).map((r) => JSON.stringify(r) + "\n").join(""));
    expect((await post("/api/session", { model: { providerID: PROXY_PROVIDER, id: "gpt-x" } })).status).toBe(200);
    expect((await post("/api/session/ses_run-c/prompt", { text: "go", delivery: "queue" })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    const second = (await feedFrom(mid)).find((r) => r.event?.type === "session.execution.failed");
    expect(second?.event?.data?.error?.message).toBe(`Model unavailable: ${PROXY_PROVIDER}/gpt-x`);
  });
});

// Feature: docs/reference/specs/harness.md items 5 and 13 — a post-turn is one
// more prompt on the run's session through the same loop, so its refusal and
// its silence fail by the same names, the phase saying which prompt it was; and
// the loop before it may have ended a hung turn at the finale, whose late
// settle the post-turn must never read as its own.
describe("the post-turn on the run's session — refused, answered by silence, or after a hung turn", () => {
  const NOW = 1_700_000_000_000;
  const executor = { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
  const notes = (events: RunEvent[]) =>
    events.filter((e): e is Extract<RunEvent, { type: "run_note" }> => e.type === "run_note");
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

  /** A run opened through the seam over the scripted serve's bare-container
   *  door, its spans recorded, the session held open for a post-turn; the
   *  serve has the run's clock and its lease for a script that moves them. */
  function openRun(options: FakeServeOptions, script: RunScript = oneTurn, alsoTo?: (e: RunEvent) => void) {
    const container = new FakeHarnessContainer();
    const registry = new HarnessRegistry();
    const clock = { now: NOW };
    const agent = {
      name: "post",
      description: "",
      system: "You are the post-turn run.",
      toolset: "full",
      machine: "repo-resident",
      identity: "write",
      maxTurns: 50,
      maxTokens: 4096,
      maxMinutes: 10,
    } as const;
    const lease = loopClock(NOW, agent.maxMinutes * MINUTE_MS, agent.name);
    scriptOpenCodeServe(container, {
      script,
      registry,
      options,
      advanceClock: (ms) => void (clock.now += ms),
      spendBudget: () => void (clock.now = lease.loopEnd + 1),
      finaleMs: lease.finaleMs,
    });
    const sink = recordingSink();
    const root = createTracer({ clock: () => clock.now }).start("request", { sinks: [sink] });
    const events: RunEvent[] = [];
    const progress: string[] = [];
    const run: HarnessRun = {
      runId: "run-p",
      agent,
      model: { id: "claude-fable-5", provider: "anthropic", providerType: "anthropic" },
      system: agent.system,
      messages: [{ role: "user", content: [{ type: "text", text: "do the thing" }] }],
      tools: [updateStatusTool],
      toolContext: { executor },
      rules: { checkout: "/workspace/threads/t/main", protectedBranches: ["main"] },
      span: root,
      onEvent: (e) => {
        events.push(e);
        alsoTo?.(e);
      },
      onProgress: (n) => void progress.push(n),
      onStep: async () => {},
    };
    const deps: HarnessDeps = {
      container,
      bearer: "sbr_run-p.post-turn-secret",
      harnessUrl: "https://bot.example.com",
      registry,
      clock: () => clock.now,
      // Every wait is two real milliseconds, but the executor's own bound on a
      // command stays a bound: the join in `end()` must be seen to wait.
      sleep: (ms) => new Promise((r) => setTimeout(r, ms === OP_TIMEOUT_MS ? 200 : Math.min(ms, 2))),
      pollMs: 1,
      tickMs: 5,
    };
    return { opened: openThroughSeam(new OpenCodeHarness(), deps, run), events, progress, container, sink, lease };
  }
  const postTurn = { text: "describe the change", maxTurns: 5, maxMinutes: 5, toolContext: { executor } };

  it("refused: the turn throws OpenCodeRequestRefusedError naming the follow-up turn's prompt and the answer, the note is on the record, and the session still ends", async () => {
    const o = openRun({ promptPostFails: 2 });
    const session = await o.opened;
    expect(session.answer).toBe("done");
    await expect(session.followUp(postTurn)).rejects.toMatchObject({
      name: "OpenCodeRequestRefusedError",
      message: 'OpenCode refused the follow-up turn\'s prompt (500): {"error":"the store hiccuped"}',
    });
    expect(
      notes(o.events).some(
        (n) => n.kind === "harness_error" && /refused the follow-up turn's prompt \(500\)/.test(n.summary),
      ),
    ).toBe(true);
    await session.end();
    expect(o.container.killed.length).toBeGreaterThan(0);
  });

  it("answered by silence: the turn throws OpenCodeSilentError naming the follow-up turn's prompt, with the diagnostics", async () => {
    const o = openRun({ silentAfterPrompt: 2 });
    const session = await o.opened;
    expect(session.answer).toBe("done");
    await expect(session.followUp(postTurn)).rejects.toMatchObject({
      name: "OpenCodeSilentError",
      phase: "the follow-up turn's prompt",
    });
    const silent = notes(o.events).find((n) => n.kind === "harness_error" && /no event for session/.test(n.summary));
    expect(silent?.summary).toMatch(/ of the follow-up turn's prompt — /);
    expect(silent?.summary).toMatch(/serve\.err: provider: connect ETIMEDOUT/);
    await session.end();
  });

  it("after a hung turn: the loop ended at the finale and the aborted execution's tail lands only once the post-turn's prompt is posted — the step failing aborted, the usage, then the settle and its refills, as the pinned binary ends an interrupted execution — and the post-turn decides nothing of it: no reply posted, no bypass, no tool event on its record, the settle set aside; it waits for its own execution's start and answers the turn's own text; no second harness_error", async () => {
    const o = openRun({ interruptSettlesLate: "interrupted" }, hung);
    const session = await o.opened;
    const reason = finaleAbortReason(o.lease.finaleMs);
    expect(session.answer).toBe(timeBudgetAnswer("", 10, reason));
    expect(o.progress).toContain(finaleTimedOutNote());
    const replyPosts = () => o.container.requests.filter((q) => /\/permission\/[^/]+\/reply$/.test(q.path)).length;
    const repliesBefore = replyPosts();
    expect(await session.followUp(postTurn)).toBe("never");
    expect(
      notes(o.events)
        .filter((n) => n.kind === "harness_error")
        .map((n) => n.summary),
    ).toEqual([windDownFailureNote(reason)]);
    // Nothing of the earlier execution's tail was decided or recorded as this turn's: the one reply posted is the post-turn's own call's, and the record's tool events are the two loops' own calls.
    expect(replyPosts()).toBe(repliesBefore + 1);
    expect(
      o.events.filter((e) => e.type === "tool_call" || e.type === "tool_result").map((e) => `${e.type}:${e.callId}`),
    ).toEqual(["tool_call:c1", "tool_result:c1", "tool_call:c1", "tool_result:c1"]);
    // The loop's span ended ok: the finale is the wind-down's ending, as on pi.
    expect(o.sink.ended("run.agent")?.status).toBe("ok");
    await session.end();
  });

  it("a tool call cut at the loop's end: the budget note names it, the interrupt ends the hung step and the write-up is a queued prompt whose execution the loop owns — the cut tool's own late outcome lands in it marked cut, the run answers the write-up under the budget's label with no finale and no harness_error — and a post-turn after it has no earlier tail to set aside", async () => {
    const hungTool: RunScript = {
      turns: [
        {
          content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "sleep 30" } }],
          stopReason: "tool_use",
        },
        { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
      ],
    };
    const o = openRun({ interruptSettlesLate: "interrupted", hangToolCall: 1 }, hungTool);
    const session = await o.opened;
    // The write-up's execution answered inside the lease: no finale, no wind-down failure.
    expect(session.answer).toBe(timeBudgetAnswer("never", 10));
    expect(o.progress).not.toContain(finaleTimedOutNote());
    expect(
      notes(o.events)
        .filter((n) => n.kind === "tool_cut")
        .map((n) => n.summary),
    ).toEqual([toolCutNote("running bash")]);
    expect(notes(o.events).filter((n) => n.kind === "harness_error")).toEqual([]);
    const toolEvents = () =>
      o.events
        .filter((e) => e.type === "tool_call" || e.type === "tool_result")
        .map((e) => `${e.type}:${e.callId}${e.type === "tool_result" ? `:${e.ok}:${e.cut === true}` : ""}`);
    // The loop's own record: the call, then its late outcome — the fake's late success, landing after the
    // write-up's execution started — marked `cut` by the interrupt that ended its step (harness.md item 13).
    expect(toolEvents()).toEqual(["tool_call:c1", "tool_result:c1:true:true"]);
    // The post-turn replays the script under the same call id, under a step of its own: judged as its own, and
    // no earlier tail is left to set aside — the loop read it.
    expect(await session.followUp(postTurn)).toBe("never");
    expect(notes(o.events).filter((n) => n.kind === "settle_set_aside")).toEqual([]);
    expect(toolEvents()).toEqual([
      "tool_call:c1",
      "tool_result:c1:true:true",
      "tool_call:c1",
      "tool_result:c1:true:false",
    ]);
    // What the workspace's release reads off this record: the cut call stays cut — the post-turn's result for
    // the same call id is no settle — so the run's tree is torn down, not paired behind the command.
    expect(callsInFlight(o.events, "completed").map((c) => c.callId)).toEqual(["c1"]);
    await session.end();
  });

  it("a tool that completes on its own while the loop-end interrupt is in flight: the interrupt answers `interrupted: false`, so nothing was cut — no tool_cut note, no write-up prompt posted; the tool's own success is read as the loop's own and lands unmarked — nothing in flight — and the run closes on the model's own answer, unlabelled, a wrap_up note saying the instruction was never posted", async () => {
    const hungTool: RunScript = {
      turns: [
        {
          content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "sleep 30" } }],
          stopReason: "tool_use",
        },
        { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
      ],
    };
    const o = openRun(
      { interruptSettlesLate: "interrupted", hangToolCall: 1, hungToolSettlesDuringInterrupt: true },
      hungTool,
    );
    const session = await o.opened;
    // Nothing was interrupted: the execution ran on to its own end, and its last text is the answer — the
    // budget's write-up instruction was never posted, so the answer wears no label and the record says why.
    expect(session.answer).toBe("never");
    expect(
      notes(o.events)
        .filter((n) => n.kind === "wrap_up")
        .map((n) => n.summary),
    ).toContain(wrapUpNeverPostedNote("time"));
    // The budget note names the tool in flight; the cut note is written only once an interrupt has landed on a live
    // execution, and this one landed on an idle session.
    expect(notes(o.events).filter((n) => n.kind === "time_budget_exhausted")).toHaveLength(1);
    expect(notes(o.events).filter((n) => n.kind === "tool_cut")).toEqual([]);
    // The tool settled before the interrupt landed: its own success, unmarked — nothing was cut, nothing is in flight.
    expect(
      o.events
        .filter((e) => e.type === "tool_call" || e.type === "tool_result")
        .map((e) => `${e.type}:${e.callId}${e.type === "tool_result" ? `:${e.ok}:${e.cut === true}` : ""}`),
    ).toEqual(["tool_call:c1", "tool_result:c1:true:false"]);
    expect(callsInFlight(o.events, "completed")).toEqual([]);
    // One prompt on the session: the request's. The write-up was never posted — the loop had left on the answer.
    expect(o.container.requests.filter((q) => q.method === "POST" && /\/prompt$/.test(q.path))).toHaveLength(1);
    expect(o.container.requests.filter((q) => q.method === "POST" && /\/interrupt$/.test(q.path))).toHaveLength(1);
    await session.end();
  });

  it("an operator's hard stop landing while the loop-end interrupt is in flight: the run ends as the stop, the write-up prompt is never posted after the loop leaves — no billed execution nobody reads", async () => {
    const r = await openCodeDriver({
      interruptSettlesLate: "interrupted",
      hangToolCall: 1,
      hardStopOnCutInterrupt: true,
    }).run({
      turns: [
        {
          content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "sleep 30" } }],
          stopReason: "tool_use",
        },
        { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
      ],
    });
    expect(r.outcome).toEqual({ kind: "answered", answer: HARD_STOP_MESSAGE });
    expect(r.stopRequested).toBe("hard");
    expect(notes(r.events).filter((n) => n.kind === "stopped")).toHaveLength(1);
    // The write-up's queued prompt is never posted: the loop had ended on the stop when the interrupt landed. One
    // prompt (the request's); two interrupts (the loop-end cut's and the hard stop's own).
    expect(r.requests.filter((q) => q.method === "POST" && /\/prompt$/.test(q.path))).toHaveLength(1);
    expect(r.requests.filter((q) => q.method === "POST" && /\/interrupt$/.test(q.path))).toHaveLength(2);
  });

  it("a tool call cut at the loop's end whose write-up prompt the server refuses: the run fails by name at once — OpenCodeRequestRefusedError naming the write-up prompt and the answer, the post's harness_error on the record — never a finale run out for an execution the server never started", async () => {
    const hungTool: RunScript = {
      turns: [
        {
          content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "sleep 30" } }],
          stopReason: "tool_use",
        },
        { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
      ],
    };
    // The write-up's queued prompt is the session's second queue prompt.
    const o = openRun({ interruptSettlesLate: "interrupted", hangToolCall: 1, promptPostFails: 2 }, hungTool);
    await expect(o.opened).rejects.toMatchObject({
      name: "OpenCodeRequestRefusedError",
      message: 'OpenCode refused the write-up prompt (500): {"error":"the store hiccuped"}',
    });
    expect(o.progress).not.toContain(finaleTimedOutNote());
    expect(
      notes(o.events)
        .filter((n) => n.kind === "harness_error")
        .map((n) => n.summary),
    ).toEqual(['the write-up prompt did not reach the server: it answered 500 ({"error":"the store hiccuped"})']);
  });

  it("a tool call cut at the loop's end whose late outcome lands only during the first post-turn: the loop closed the call marked cut when it left, the post-turn sets the late settle aside (a step no loop of its own saw start), and both post-turns answer their own text", async () => {
    const hungTool: RunScript = {
      turns: [
        {
          content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "sleep 30" } }],
          stopReason: "tool_use",
        },
        { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
      ],
    };
    const o = openRun({ interruptSettlesLate: "interrupted", hungToolSettlesOnPlay: 3, hangToolCall: 1 }, hungTool);
    const session = await o.opened;
    expect(session.answer).toBe(timeBudgetAnswer("never", 10));
    const toolEvents = () =>
      o.events
        .filter((e) => e.type === "tool_call" || e.type === "tool_result")
        .map((e) => `${e.type}:${e.callId}${e.type === "tool_result" ? `:${e.ok}:${e.cut === true}` : ""}`);
    // The late outcome had not landed when the write-up's execution settled: the loop left on its interrupt with
    // the call open and closed it marked `cut`.
    expect(toolEvents()).toEqual(["tool_call:c1", "tool_result:c1:false:true"]);
    expect(await session.followUp(postTurn)).toBe("never");
    expect(await session.followUp(postTurn)).toBe("never");
    expect(notes(o.events).filter((n) => n.kind === "harness_error")).toEqual([]);
    // The first post-turn read the late outcome: a step no loop of its own saw start, set aside.
    expect(
      notes(o.events)
        .filter((n) => n.kind === "settle_set_aside")
        .map((n) => n.summary),
    ).toEqual([
      "OpenCode settled tool (call c1) of a step this loop never saw start (msg_a0); set aside — an earlier execution's late settle, or a step lost with the stream",
    ]);
    // The loop's own cut result, then each post-turn's replayed call settling as its own.
    expect(toolEvents()).toEqual([
      "tool_call:c1",
      "tool_result:c1:false:true",
      "tool_call:c1",
      "tool_result:c1:true:false",
      "tool_call:c1",
      "tool_result:c1:true:false",
    ]);
    expect(callsInFlight(o.events, "completed").map((c) => c.callId)).toEqual(["c1"]);
    await session.end();
  });

  /** The record's tool events as one line each: `tool_call:<id>` and `tool_result:<id>:<ok>:<cut>`. */
  const toolEventsOf = (events: RunEvent[]) =>
    events
      .filter((e) => e.type === "tool_call" || e.type === "tool_result")
      .map((e) => `${e.type}:${e.callId}${e.type === "tool_result" ? `:${e.ok}:${e.cut === true}` : ""}`);
  const sleepThenNever: RunScript = {
    turns: [
      {
        content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "sleep 30" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
    ],
  };
  const sleepThenLsThenNever: RunScript = {
    turns: [
      {
        content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "sleep 30" } }],
        stopReason: "tool_use",
      },
      {
        content: [{ type: "tool_use", id: "c2", name: "bash", input: { command: "echo hi" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
    ],
  };

  it("a tool call cut at the loop's end whose interrupt the server refuses: nothing was interrupted, so the run fails by name at once — OpenCodeRequestRefusedError naming the interrupt and the answer, the post's harness_error on the record, no tool_cut note, the open call closed marked cut for the release — never a steer that waits the command out, never a finale run out", async () => {
    const o = openRun({ hangToolCall: 1, interruptPostFails: true }, sleepThenNever);
    await expect(o.opened).rejects.toMatchObject({
      name: "OpenCodeRequestRefusedError",
      message: 'OpenCode refused the interrupt (500): {"error":"interrupt refused"}',
    });
    expect(o.progress).not.toContain(finaleTimedOutNote());
    // No write-up was posted or steered: one prompt on the session (the request's); the cut's interrupt, then the
    // failure's own ending interrupt — refused too, its note landing whenever its answer does.
    expect(o.container.requests.filter((q) => q.method === "POST" && /\/prompt$/.test(q.path))).toHaveLength(1);
    expect(o.container.requests.filter((q) => q.method === "POST" && /\/interrupt$/.test(q.path))).toHaveLength(2);
    expect(notes(o.events).filter((n) => n.kind === "tool_cut")).toEqual([]);
    const errors = notes(o.events)
      .filter((n) => n.kind === "harness_error")
      .map((n) => n.summary);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(new Set(errors)).toEqual(
      new Set(['the interrupt did not reach the server: it answered 500 ({"error":"interrupt refused"})']),
    );
    // The call the loop left open is closed marked cut and worded for the path it left on; the release reads a
    // command that may run on.
    expect(o.events.find((e) => e.type === "tool_result" && e.callId === "c1")).toMatchObject({
      ok: false,
      cut: true,
      summary:
        "bash was still running when the loop left on its interrupt (a failure by name); its outcome never reached the record",
    });
    expect(callsInFlight(o.events, "failed").map((c) => c.callId)).toEqual(["c1"]);
  });

  it("a tool call cut at the loop's end whose interrupted execution's end the server serializes only after the write-up's execution has started: that end is the one the cut owed — set aside under a settle_set_aside note whatever the mode, its aborted step no failure — and the write-up's own end settles the run: the write-up answered, no finale, no harness_error", async () => {
    const o = openRun({ hangToolCall: 1, lateTailAfterNextStart: true }, sleepThenNever);
    const session = await o.opened;
    expect(session.answer).toBe(timeBudgetAnswer("never", 10));
    expect(o.progress).not.toContain(finaleTimedOutNote());
    expect(notes(o.events).filter((n) => n.kind === "harness_error")).toEqual([]);
    expect(
      notes(o.events)
        .filter((n) => n.kind === "settle_set_aside")
        .map((n) => n.summary),
    ).toEqual([
      "the interrupted execution ended (session.execution.interrupted) while the loop read in its own mode — before the interrupt's answer, or after the write-up's own start; set aside — the end the loop-end cut owed, not the write-up's settle",
    ]);
    expect(toolEventsOf(o.events)).toEqual(["tool_call:c1", "tool_result:c1:true:true"]);
    expect(callsInFlight(o.events, "completed").map((c) => c.callId)).toEqual(["c1"]);
    await session.end();
  });

  it("a tool call cut at the loop's end whose interrupted execution's end the server serializes before it answers the interrupt: the end lands in the loop's own mode with the answer still in flight and is the cut's — the debt provisional from the interrupt's posting, paid by that `interrupted` end, set aside — never the settle; the write-up answers, its own end settling the run", async () => {
    const o = openRun({ hangToolCall: 1, interruptAnswersAfterTail: true }, sleepThenNever);
    const session = await o.opened;
    expect(session.answer).toBe(timeBudgetAnswer("never", 10));
    expect(o.progress).not.toContain(finaleTimedOutNote());
    expect(notes(o.events).filter((n) => n.kind === "harness_error")).toEqual([]);
    expect(
      notes(o.events)
        .filter((n) => n.kind === "tool_cut")
        .map((n) => n.summary),
    ).toEqual([toolCutNote("running bash")]);
    expect(
      notes(o.events)
        .filter((n) => n.kind === "settle_set_aside")
        .map((n) => n.summary),
    ).toEqual([
      "the interrupted execution ended (session.execution.interrupted) while the loop read in its own mode — before the interrupt's answer, or after the write-up's own start; set aside — the end the loop-end cut owed, not the write-up's settle",
    ]);
    expect(toolEventsOf(o.events)).toEqual(["tool_call:c1", "tool_result:c1:true:true"]);
    expect(callsInFlight(o.events, "completed").map((c) => c.callId)).toEqual(["c1"]);
    await session.end();
  });

  it("a tool call cut at the loop's end while its ask was still pending: the interrupt drops the ask and the tool fails `aborted` before it ran — the interrupt's own doing, landing as the call's result marked cut, no harness_error for a call with no ask the bot answered, no reply ever posted — and the write-up answers", async () => {
    const o = openRun({ hangAtAsk: 1 }, sleepThenNever);
    const session = await o.opened;
    expect(session.answer).toBe(timeBudgetAnswer("never", 10));
    expect(o.progress).not.toContain(finaleTimedOutNote());
    expect(notes(o.events).filter((n) => n.kind === "harness_error" || n.kind === "tool_refused")).toEqual([]);
    expect(
      notes(o.events)
        .filter((n) => n.kind === "tool_cut")
        .map((n) => n.summary),
    ).toEqual([toolCutNote("running bash")]);
    expect(o.container.requests.filter((q) => /\/permission\/[^/]+\/reply$/.test(q.path))).toHaveLength(0);
    expect(toolEventsOf(o.events)).toEqual(["tool_call:c1", "tool_result:c1:false:true"]);
    expect(callsInFlight(o.events, "completed").map((c) => c.callId)).toEqual(["c1"]);
    await session.end();
  });

  it("the interrupted execution's end never serialized and the write-up's own execution failing on the provider: the failure is the write-up's — the wind-down's note names it and the run closes by the wind-down's answer at once — never set aside as the end the cut owed, never a finale run out", async () => {
    const o = openRun(
      { hangToolCall: 1, owedEndNeverSerialized: true },
      {
        turns: [
          {
            content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "sleep 30" } }],
            stopReason: "tool_use",
          },
          { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
        ],
        failModelCall: 2,
      },
    );
    const session = await o.opened;
    expect(session.answer).toBe(timeBudgetAnswer("", 10, FAILED_MODEL_CALL_ERROR));
    expect(o.progress).not.toContain(finaleTimedOutNote());
    expect(
      notes(o.events)
        .filter((n) => n.kind === "harness_error")
        .map((n) => n.summary),
    ).toEqual([windDownFailureNote(FAILED_MODEL_CALL_ERROR)]);
    expect(notes(o.events).filter((n) => n.kind === "settle_set_aside")).toEqual([]);
    await session.end();
  });

  it("an operator's hard stop requested while the loop-end interrupt is in flight and still unread when the interrupt answers: the write-up prompt is not posted — the stop is read at the answer, not a tick later — and the run ends as the stop", async () => {
    const r = await openCodeDriver({ hangToolCall: 1, hardStopBeforeCutAnswer: true }).run({
      turns: [
        {
          content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "sleep 30" } }],
          stopReason: "tool_use",
        },
        { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
      ],
    });
    expect(r.outcome).toEqual({ kind: "answered", answer: HARD_STOP_MESSAGE });
    expect(r.stopRequested).toBe("hard");
    // One prompt (the request's), no write-up posted; two interrupts (the cut's and the stop's own ending).
    expect(r.requests.filter((q) => q.method === "POST" && /\/prompt$/.test(q.path))).toHaveLength(1);
    expect(r.requests.filter((q) => q.method === "POST" && /\/interrupt$/.test(q.path))).toHaveLength(2);
  });

  it("a tool call cut at the loop's end whose write-up prompt fails on its transport: the server took nothing and no execution was started, so the run fails by name at once — the post's harness_error on the record — never a finale run out for a prompt that never reached the server", async () => {
    // The write-up's queued prompt is the session's second queue prompt.
    const o = openRun({ hangToolCall: 1, promptPostThrows: 2 }, sleepThenNever);
    await expect(o.opened).rejects.toMatchObject({
      message: "the write-up prompt did not reach the server, so no write-up execution was started",
    });
    expect(o.progress).not.toContain(finaleTimedOutNote());
    expect(
      notes(o.events)
        .filter((n) => n.kind === "harness_error")
        .map((n) => n.summary),
    ).toContain(
      "the write-up prompt did not reach the server: harness container: request failed — curl: (56) Recv failure: Connection reset by peer",
    );
  });

  it("a tool that completes on its own while the loop-end interrupt is in flight, whose execution then ends on the proxy's turn-budget refusal: the wind-down had decided and posted nothing, so the refusal starts the write-up as a steer into the idle session — the write-up answers under the budget's label, never a finale run out with nothing executing", async () => {
    const o = openRun(
      {
        hangToolCall: 1,
        hungToolSettlesDuringInterrupt: true,
        budgetRefusalAtModelCall: 2,
        steerOnIdleStartsExecution: true,
      },
      {
        turns: [
          {
            content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "sleep 30" } }],
            stopReason: "tool_use",
          },
          { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
          { content: [{ type: "text", text: "findings so far" }], stopReason: "end_turn" },
        ],
      },
    );
    const session = await o.opened;
    expect(session.answer).toBe(timeBudgetAnswer("findings so far", 10));
    expect(o.progress).not.toContain(finaleTimedOutNote());
    // The request's prompt, then the write-up's steer into the idle session; one interrupt, answered idle.
    expect(
      o.container.requests
        .filter((q) => q.method === "POST" && /\/prompt$/.test(q.path))
        .map((q) => (JSON.parse(String(q.body)) as { delivery?: string }).delivery),
    ).toEqual(["queue", "steer"]);
    expect(o.container.requests.filter((q) => q.method === "POST" && /\/interrupt$/.test(q.path))).toHaveLength(1);
    expect(notes(o.events).filter((n) => n.kind === "tool_cut")).toEqual([]);
    expect(toolEventsOf(o.events)).toEqual(["tool_call:c1", "tool_result:c1:true:false"]);
    await session.end();
  });

  it("the hung tool completes during the interrupt's round-trip and the execution moves on to its next step, which the interrupt cuts, its tail before the answer: that step began after the interrupt was posted and is the cut's — its aborted failure no harness_error — the tool's own success lands unmarked, the tool_cut note names the model call, and the write-up answers", async () => {
    const o = openRun(
      { hangToolCall: 1, cutLandsOnNextStep: true, interruptAnswersAfterTail: true },
      {
        turns: [
          {
            content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "sleep 30" } }],
            stopReason: "tool_use",
          },
          { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
          { content: [{ type: "text", text: "findings so far" }], stopReason: "end_turn" },
        ],
      },
    );
    const session = await o.opened;
    expect(session.answer).toBe(timeBudgetAnswer("findings so far", 10));
    expect(o.progress).not.toContain(finaleTimedOutNote());
    expect(notes(o.events).filter((n) => n.kind === "harness_error")).toEqual([]);
    expect(
      notes(o.events)
        .filter((n) => n.kind === "tool_cut")
        .map((n) => n.summary),
    ).toEqual([toolCutNote(MODEL_CALL_IN_FLIGHT)]);
    // The tool completed before the interrupt landed: its own success, unmarked; the model call was what the cut met.
    expect(toolEventsOf(o.events)).toEqual(["tool_call:c1", "tool_result:c1:true:false"]);
    expect(callsInFlight(o.events, "completed")).toEqual([]);
    await session.end();
  });

  it("a tool that completes on its own while the loop-end interrupt is in flight, whose execution then fails on the provider before the answer lands: the failure is the wind-down's note, the write-up was never posted, and the unlabelled answer still carries the failure — the wrap_up note saying the execution failed, not finished", async () => {
    const o = openRun(
      { hangToolCall: 1, hungToolSettlesDuringInterrupt: true },
      {
        turns: [
          {
            content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "sleep 30" } }],
            stopReason: "tool_use",
          },
          { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
        ],
        failModelCall: 2,
      },
    );
    const session = await o.opened;
    expect(session.answer).toBe(unlabelledAnswer("", FAILED_MODEL_CALL_ERROR));
    expect(o.progress).not.toContain(finaleTimedOutNote());
    expect(
      notes(o.events)
        .filter((n) => n.kind === "harness_error")
        .map((n) => n.summary),
    ).toEqual([windDownFailureNote(FAILED_MODEL_CALL_ERROR)]);
    expect(
      notes(o.events)
        .filter((n) => n.kind === "wrap_up")
        .map((n) => n.summary),
    ).toContain(wrapUpNeverPostedNote("time", "run", "failed"));
    expect(o.container.requests.filter((q) => q.method === "POST" && /\/prompt$/.test(q.path))).toHaveLength(1);
    await session.end();
  });

  it("the write-up's own step failing `aborted` after the cut landed is the harness's to say: an `an OpenCode step failed` note, never swallowed as the cut's — the cut steps close at the landing — and the write-up's execution failing on the provider closes the run by the wind-down's labelled answer", async () => {
    const o = openRun({ hangToolCall: 1, writeUpStepAborts: true }, sleepThenNever);
    const session = await o.opened;
    expect(session.answer).toBe(timeBudgetAnswer("", 10, FAILED_MODEL_CALL_ERROR));
    expect(
      notes(o.events)
        .filter((n) => n.kind === "harness_error")
        .map((n) => n.summary),
    ).toEqual(["an OpenCode step failed: Step interrupted", windDownFailureNote(FAILED_MODEL_CALL_ERROR)]);
    expect(notes(o.events).filter((n) => n.kind === "wrap_up")).toEqual([]);
    expect(toolEventsOf(o.events)).toEqual(["tool_call:c1", "tool_result:c1:true:true"]);
    await session.end();
  });

  it("a tool call cut at the loop's end whose interrupt is never answered: the finale bound ends the wait, the write-up was never posted, and the record says that — the wrap_up note names the finale, not an idle session or a provider failure, and the unlabelled answer names the finale bound; the cut call is closed marked cut for the release", async () => {
    // The interrupt answers only once the server is killed (`interruptAnswersAfterKill`), so the loop-end cut's
    // interrupt is in flight for the rest of the loop, and the fake moves the clock past the finale bound on that
    // interrupt's request (`finaleDuringCutInterrupt`) — after the write-up's clock was stamped, before any answer.
    const o = openRun(
      { hangToolCall: 1, interruptAnswersAfterKill: "refused", finaleDuringCutInterrupt: true },
      sleepThenNever,
    );
    const session = await o.opened;
    const reason = finaleAbortReason(o.lease.finaleMs);
    expect(o.progress).toContain(finaleTimedOutNote());
    expect(session.answer).toBe(unlabelledAnswer("", reason, "finale"));
    expect(
      notes(o.events)
        .filter((n) => n.kind === "wrap_up")
        .map((n) => n.summary),
    ).toContain(wrapUpNeverPostedNote("time", "run", "finale"));
    // The record's own note says what the finale ended: a wait on the cut tool with its interrupt unanswered — no
    // model call was in flight, so none is said to have failed.
    const errors = notes(o.events)
      .filter((n) => n.kind === "harness_error")
      .map((n) => n.summary);
    expect(errors).toContain(finaleWaitNote(reason, "running bash", true));
    expect(errors).not.toContain(windDownFailureNote(reason));
    // One prompt (the request's): the write-up was never posted; the cut's interrupt, then the finale's own.
    expect(o.container.requests.filter((q) => q.method === "POST" && /\/prompt$/.test(q.path))).toHaveLength(1);
    expect(o.container.requests.filter((q) => q.method === "POST" && /\/interrupt$/.test(q.path))).toHaveLength(2);
    // The loop left on the finale's interrupt with the call open: closed marked cut, a command that may run on.
    expect(toolEventsOf(o.events)).toEqual(["tool_call:c1", "tool_result:c1:false:true"]);
    expect(callsInFlight(o.events, "completed").map((c) => c.callId)).toEqual(["c1"]);
    await session.end();
  });

  it("a gate bypass in the write-up's execution after a loop-end cut, the cut call still open: the loop leaves on the bypass's interrupt, and the cut call's exit result names that path — the cut, then the bypass — never a write-up that settled", async () => {
    const o = openRun({ hangToolCall: 1, hungToolSettlesOnPlay: 3, bypassGateAtTurn: 2 }, sleepThenLsThenNever);
    await expect(o.opened).rejects.toMatchObject({ name: "OpenCodeGateBypassedError" });
    expect(
      notes(o.events)
        .filter((n) => n.kind === "tool_cut")
        .map((n) => n.summary),
    ).toEqual([toolCutNote("running bash")]);
    expect(o.events.find((e) => e.type === "tool_result" && e.callId === "c1")).toMatchObject({
      ok: false,
      cut: true,
      summary:
        "bash was cut at the loop's end; the loop then left on its interrupt (a gate bypass) before the call's outcome reached the record",
    });
  });

  it("a tool call cut at the loop's end whose own outcome rides the interrupted execution's tail — before the write-up's execution starts, in the bridge's earlier mode: the settle is the loop's own by construction (the call was opened in its own mode) and lands as the call's real result marked cut, not dropped and replaced by a synthetic failure at the exit", async () => {
    const o = openRun({ hangToolCall: 1, hungToolSettlesInTail: true }, sleepThenNever);
    const session = await o.opened;
    expect(session.answer).toBe(timeBudgetAnswer("never", 10));
    expect(o.events.find((e) => e.type === "tool_result" && e.callId === "c1")).toMatchObject({
      ok: true,
      cut: true,
      output: "slept",
    });
    expect(toolEventsOf(o.events)).toEqual(["tool_call:c1", "tool_result:c1:true:true"]);
    expect(notes(o.events).filter((n) => n.kind === "settle_set_aside")).toEqual([]);
    expect(notes(o.events).filter((n) => n.kind === "harness_error")).toEqual([]);
    expect(callsInFlight(o.events, "completed").map((c) => c.callId)).toEqual(["c1"]);
    await session.end();
  });

  it("a loop-end interrupt that cut nothing (`interrupted: false`, the tool completed during the round-trip) leaves a straggler at the clean settle unmarked: a later call whose settle the stream dropped is no command in flight, and the release pairs the workspace for it", async () => {
    const o = openRun(
      { hangToolCall: 1, hungToolSettlesDuringInterrupt: true, dropStreamAtSettle: 2 },
      sleepThenLsThenNever,
    );
    const session = await o.opened;
    expect(o.progress).toContain("opencode feed: stream closed");
    expect(notes(o.events).filter((n) => n.kind === "tool_cut")).toEqual([]);
    // The cut tool's own success, unmarked; the straggler's call with no result — never closed `cut`.
    expect(toolEventsOf(o.events)).toEqual(["tool_call:c1", "tool_result:c1:true:false", "tool_call:c2"]);
    expect(callsInFlight(o.events, "completed")).toEqual([]);
    await session.end();
  });

  it("the stream drops as a step begins and the ask reaches the bot through the permissions refill alone: the reply lands, the tool runs, and its settle — naming a step no event announced — is judged and recorded as the loop's own, the run answering its own text", async () => {
    const o = openRun(
      { dropStreamAtStep: 1 },
      {
        turns: [
          {
            content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo hi" } }],
            stopReason: "tool_use",
          },
          { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
        ],
      },
    );
    const session = await o.opened;
    expect(session.answer).toBe("done");
    expect(o.progress).toContain("opencode feed: stream closed");
    expect(o.container.requests.filter((q) => /\/permission\/per_c1\/reply$/.test(q.path))).toHaveLength(1);
    // The call the stream never announced is opened from the refilled ask — named, its command summarised, its span ended — and its result lands on it.
    expect(
      o.events
        .filter((e) => e.type === "tool_call" || e.type === "tool_result")
        .map((e) => `${e.type}:${e.callId}:${e.tool}${e.type === "tool_call" ? `:${e.command ?? ""}` : `:${e.ok}`}`),
    ).toEqual(["tool_call:c1:bash:echo hi", "tool_result:c1:bash:true"]);
    expect(o.sink.ended("tool.bash")?.status).toBe("ok");
    expect(notes(o.events).filter((n) => n.kind === "harness_error")).toEqual([]);
    await session.end();
  });

  it("a refused interrupt whose answer lands only as the process is ended is still the record's: end() returns once every request the loop posted has settled, the run finishes after end(), and the registry keeps the note — where a publish after the finish is dropped, so the order is what the claim rests on", async () => {
    const registry = new RunRegistry();
    const handle = registry.create("post-turn run");
    const o = openRun({ interruptAnswersAfterKill: "refused" }, hung, (e) => registry.publish(handle.id, e));
    const session = await o.opened;
    const reason = finaleAbortReason(o.lease.finaleMs);
    expect(session.answer).toBe(timeBudgetAnswer("", 10, reason));
    const refusal = /the interrupt did not reach the server: it answered 500/;
    // Not yet answered when the loop left; nothing on the card, ever.
    expect(notes(o.events).some((n) => refusal.test(n.summary))).toBe(false);
    await session.end();
    // The answer came several ticks after the kill, and end() had waited for it: on the record before the run finishes.
    expect(notes(o.events).some((n) => refusal.test(n.summary))).toBe(true);
    registry.finish(handle.id, "completed");
    const recorded = registry.snapshotById(handle.id)?.events ?? [];
    expect(recorded.filter((e) => e.type === "run_note" && refusal.test(e.summary))).toHaveLength(1);
    expect(o.progress.some((p) => refusal.test(p))).toBe(false);
    registry.publish(handle.id, {
      type: "run_note",
      kind: "harness_error",
      summary: "a note after the finish",
      at: NOW,
    });
    expect(
      (registry.snapshotById(handle.id)?.events ?? []).some(
        (e) => e.type === "run_note" && e.summary === "a note after the finish",
      ),
    ).toBe(false);
  });

  it("after a hung turn whose aborted execution then fails on the proxy: the earlier execution's failure is noted as such and set aside, and the post-turn answers its own text", async () => {
    const o = openRun({ interruptSettlesLate: "failed" }, hung);
    const session = await o.opened;
    const reason = finaleAbortReason(o.lease.finaleMs);
    expect(await session.followUp(postTurn)).toBe("never");
    expect(
      notes(o.events)
        .filter((n) => n.kind === "harness_error")
        .map((n) => n.summary),
    ).toEqual([
      windDownFailureNote(reason),
      `a model call of an earlier execution failed (${LATE_FAILURE_ERROR}); continuing`,
    ]);
    await session.end();
  });

  it("after a hung turn whose aborted execution ends on the proxy's turn-budget refusal: the refusal is named for what it is — an earlier execution reaching its budget — never a failed model call, and the post-turn answers its own text", async () => {
    const o = openRun({ interruptSettlesLate: "budget" }, hung);
    const session = await o.opened;
    const reason = finaleAbortReason(o.lease.finaleMs);
    expect(await session.followUp(postTurn)).toBe("never");
    expect(
      notes(o.events)
        .filter((n) => n.kind === "harness_error")
        .map((n) => n.summary),
    ).toEqual([
      windDownFailureNote(reason),
      `an earlier execution reached the proxy's turn budget (${LATE_BUDGET_REFUSAL}); continuing`,
    ]);
    await session.end();
  });

  it("after a hung turn whose tail carries a dropped stream's note, an event kind no table names and a compaction: all three are surfaced before the post-turn's execution starts — the note on the card, the kind as a harness_error, the compaction as its note — and the post-turn still answers its own text", async () => {
    const o = openRun({ interruptSettlesLate: "interrupted", lateTailNoise: true }, hung);
    const session = await o.opened;
    const reason = finaleAbortReason(o.lease.finaleMs);
    expect(await session.followUp(postTurn)).toBe("never");
    expect(o.progress).toContain("opencode feed: stream closed");
    expect(
      notes(o.events)
        .filter((n) => n.kind === "harness_error")
        .map((n) => n.summary),
    ).toEqual([
      windDownFailureNote(reason),
      "OpenCode emitted an event kind this build does not know: made_up_late_kind",
    ]);
    // The earlier execution's compaction is record state, landed in every mode.
    expect(notes(o.events).some((n) => n.kind === "compacted")).toBe(true);
    await session.end();
  });

  it("the run's span ends error on a failed model call, as the outcome says", async () => {
    const o = openRun({}, { ...oneTurn, failModelCall: 1 });
    await expect(o.opened).rejects.toThrow(/^the model call failed: /);
    expect(o.sink.ended("run.agent")?.status).toBe("error");
  });
});

// Feature: docs/reference/specs/harness-pi.md item 16 — a control reset over
// the bridge's read-only feed re-attaches in place; a reset that keeps repeating
// with no record read between the re-attaches is a stuck control plane the bound
// closes by name, exactly as pi does (finding: never a silent throw past the
// bound). A control reset under one of the loop's writes is the describe after
// this one: resolved from the server's own state, never re-sent blind.
describe("OpenCodeHarness — the resident's control plane keeps resetting the feed", () => {
  const notes = (r: DrivenRun) =>
    r.events
      .filter((e): e is Extract<RunEvent, { type: "run_note" }> => e.type === "run_note")
      .map((e) => ({ kind: e.kind, summary: e.summary }));

  it("a control reset that repeats with no progress fails the run by name after the runaway bound — a harness_error note, never a silent throw and never the replaced verdict", async () => {
    const driver = openCodeDriver();
    const r = await driver.run({
      turns: [{ content: [{ type: "text", text: "never reached" }], stopReason: "end_turn" }],
      controlResetBoundOnFeed: 1,
    });
    expect(r.outcome.kind).toBe("failed");
    const err = r.outcome.kind === "failed" ? r.outcome.error : undefined;
    expect(err?.message).toMatch(/reset under the run \d+ times with no progress; the run cannot continue safely/);
    // Named at the bound, as pi does — never a silent throw.
    expect(
      notes(r).some((n) => n.kind === "harness_error" && /reset under the run .* with no progress/.test(n.summary)),
    ).toBe(true);
    // A control reset is never the replaced verdict.
    expect(notes(r).filter((n) => n.kind === "sandbox_restarted")).toHaveLength(0);
  });
});

// Feature: docs/reference/specs/harness.md item 13 — a control reset under an
// OpenCode write (the prompt POST, a gate reply) is resolved from the server's
// own state, never re-sent blind: the store lists a queued prompt's message the
// moment it is admitted (measured against the pinned binary), the pending-asks
// listing says whether a reply landed; the feed is re-attached in place; a
// state that cannot be read, or a re-issue that meets the reset again, fails
// the run by name with a harness_error naming the request.
describe("OpenCodeHarness — the resident's control plane resets under a write", () => {
  const notes = (r: DrivenRun) =>
    r.events.filter((e): e is Extract<RunEvent, { type: "run_note" }> => e.type === "run_note");
  const posts = (r: DrivenRun, suffix: string) =>
    r.requests.filter((q) => q.method === "POST" && q.path.endsWith(suffix));
  const gets = (r: DrivenRun, suffix: string) =>
    r.requests.filter((q) => q.method === "GET" && q.path.endsWith(suffix));
  const replies = (r: DrivenRun) => r.requests.filter((q) => /\/permission\/per_c1\/reply$/.test(q.path));
  const answered = (r: DrivenRun) =>
    r.outcome.kind === "answered" ? r.outcome.answer : `failed: ${r.outcome.error.message}`;
  const oneTurn: RunScript = { turns: [{ content: [{ type: "text", text: "done" }], stopReason: "end_turn" }] };
  const toolTurn: RunScript = {
    turns: [
      {
        content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo hi" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ],
  };
  /** Whether any model call of the run carried `text` in a user turn. */
  const modelSaw = (r: DrivenRun, text: string) =>
    r.modelCalls.some((c) =>
      c.messages.some((m) => m.role === "user" && m.content.some((p) => p.type === "text" && p.text.includes(text))),
    );
  /** The store's listings: the resolution reads newest first (`order=desc&limit=200`), down to the newest row it already knew — one page in practice, never one unqueried page and never the whole store. */
  const storeReads = (r: DrivenRun) => r.requests.filter((q) => q.method === "GET" && q.path.includes("/message?"));
  /** A seed longer than one page of the store (`STORE_PAGE_LIMIT`, 200 rows): 125 exchanges, 250 messages. */
  const longSeed: ChatMessage[] = [];
  for (let i = 0; i < 125; i++) {
    longSeed.push({ role: "user", content: [{ type: "text", text: `question ${i}` }] });
    longSeed.push({ role: "assistant", content: [{ type: "text", text: `answer ${i}` }] });
  }

  it("a prompt the reset cut after the server took it is not re-issued: the store lists its message, the feed is re-attached in place under one resumed note, and the run answers on the one execution", async () => {
    const r = await openCodeDriver({ controlResetOnPrompt: "landed" }).run(oneTurn);
    expect(answered(r)).toBe("done");
    expect(posts(r, "/prompt")).toHaveLength(1);
    expect(storeReads(r)).toHaveLength(1);
    expect(
      notes(r)
        .filter((n) => n.kind === "resumed")
        .map((n) => n.summary),
    ).toEqual([CONTROL_RESET_RESUMED_NOTE]);
    expect(notes(r).filter((n) => n.kind === "harness_error")).toEqual([]);
  });

  it("a prompt the reset cut before the server took it is re-issued once: the store lists no message of it, the second POST is admitted, and the run answers", async () => {
    const r = await openCodeDriver({ controlResetOnPrompt: "lost" }).run(oneTurn);
    expect(answered(r)).toBe("done");
    expect(posts(r, "/prompt")).toHaveLength(2);
    expect(storeReads(r)).toHaveLength(1);
    expect(notes(r).filter((n) => n.kind === "resumed")).toHaveLength(1);
    expect(notes(r).filter((n) => n.kind === "harness_error")).toEqual([]);
  });

  it("on a store longer than one page, a prompt that landed is the newest user row: found on the first page read newest first, the read stopping at the newest row the loop already knew, and not re-issued", async () => {
    const r = await openCodeDriver({ controlResetOnPrompt: "landed" }).run({ ...oneTurn, seed: longSeed });
    expect(answered(r)).toBe("done");
    expect(posts(r, "/prompt")).toHaveLength(1);
    expect(storeReads(r).map((q) => q.path.split("?")[1])).toEqual(["order=desc&limit=200"]);
    expect(notes(r).filter((n) => n.kind === "harness_error")).toEqual([]);
  });

  it("on a store longer than one page, a prompt that was lost is told lost by the one page down to the newest known row — never the whole store — and re-issued once", async () => {
    const r = await openCodeDriver({ controlResetOnPrompt: "lost" }).run({ ...oneTurn, seed: longSeed });
    expect(answered(r)).toBe("done");
    expect(posts(r, "/prompt")).toHaveLength(2);
    expect(storeReads(r).map((q) => q.path.split("?")[1])).toEqual(["order=desc&limit=200"]);
    expect(notes(r).filter((n) => n.kind === "harness_error")).toEqual([]);
  });

  it("a follow-up's steer whose answer the reset cut after the row landed is learned from the store — folded in, its row's id known — so a later lost prompt of the same text is still re-issued", async () => {
    const NOW = 1_700_000_000_000;
    const sameWords = followUpPrompt([{ text: "same words", userId: "user:conformance", at: NOW }]);
    const r = await openCodeDriver({ controlResetOnSteer: "landed", controlResetOnPrompt: "lost" }).run({
      ...oneTurn,
      request: sameWords,
      followUp: "same words",
    });
    expect(answered(r)).toBe("done");
    expect(posts(r, "/prompt").map((q) => (JSON.parse(q.body ?? "{}") as { delivery?: string }).delivery)).toEqual([
      "steer",
      "queue",
      "queue",
    ]);
    const followUps = notes(r)
      .filter((n) => n.kind === "follow_up")
      .map((n) => n.summary);
    expect(followUps.some((s) => /follow-up folded in/.test(s))).toBe(true);
    expect(followUps.some((s) => /not delivered/.test(s))).toBe(false);
    expect(notes(r).filter((n) => n.kind === "harness_error")).toEqual([]);
  });

  it("a steer that lands after the cut prompt — its row newer than the prompt's, known by its answer — does not hide a landed prompt: the read stops at what was known when the prompt was posted, so the prompt is not re-issued", async () => {
    const r = await openCodeDriver({ controlResetOnPrompt: "landed", steerLandsAfterNextPrompt: true }).run({
      ...oneTurn,
      followUp: "also check the docs",
    });
    expect(answered(r)).toBe("done");
    expect(posts(r, "/prompt").map((q) => (JSON.parse(q.body ?? "{}") as { delivery?: string }).delivery)).toEqual([
      "steer",
      "queue",
    ]);
    expect(notes(r).filter((n) => n.kind === "harness_error")).toEqual([]);
  });

  it("a follow-up's steer whose answer the reset cut and whose row the store cannot be asked about fails the run by name — OpenCodeWriteUnresolvedError naming the follow-up's steer, a harness_error, the loop stopped — one rule for the loop's writes and the drainer's", async () => {
    const r = await openCodeDriver({ controlResetOnSteer: "landed", storeListingResets: true }).run({
      ...oneTurn,
      followUp: "also check the docs",
    });
    expect(r.outcome.kind).toBe("failed");
    const err = r.outcome.kind === "failed" ? r.outcome.error : undefined;
    expect(err?.name).toBe("OpenCodeWriteUnresolvedError");
    expect(err?.message).toMatch(
      /^the follow-up's steer was in flight when the resident's control plane reset under the run and its outcome could not be resolved from the server \(the store could not be listed/,
    );
    expect(
      notes(r).some((n) => n.kind === "harness_error" && /^the follow-up's steer was in flight/.test(n.summary)),
    ).toBe(true);
    expect(notes(r).some((n) => n.kind === "follow_up" && /not delivered/.test(n.summary))).toBe(false);
    expect(posts(r, "/interrupt")).toHaveLength(1);
  });

  it("a follow-up's steer into a RUNNING execution whose answer the reset cut — the ordinary steer timing — is resolved at the next step boundary the feed delivers, where its row has landed: folded in, the model reads it on its next call, and the run continues", async () => {
    const r = await openCodeDriver({ controlResetOnSteer: "landed", followUpAtFirstAsk: "also check the docs" }).run(
      toolTurn,
    );
    expect(answered(r)).toBe("done");
    const followUps = notes(r)
      .filter((n) => n.kind === "follow_up")
      .map((n) => n.summary);
    expect(followUps.some((s) => /folded in/.test(s))).toBe(true);
    expect(followUps.some((s) => /not delivered/.test(s))).toBe(false);
    expect(notes(r).filter((n) => n.kind === "harness_error")).toEqual([]);
    expect(
      r.modelCalls.some((c) =>
        c.messages.some(
          (m) =>
            m.role === "user" && m.content.some((p) => p.type === "text" && p.text.includes("also check the docs")),
        ),
      ),
    ).toBe(true);
  });

  /** A run whose only model call hangs: a follow-up's steer posted into the running execution at the prompt sits
   *  in it, and the step boundary it would land at never comes — the finale interrupts the hung call and the loop
   *  leaves. (A hung tool no longer makes this shape: it is cut at the loop's end and the write-up's own execution
   *  brings the boundary.) */
  const hungCall: RunScript = {
    turns: [{ content: [{ type: "text", text: "never" }], stopReason: "end_turn" }],
    hangModelCall: 1,
  };

  it("a follow-up's steer into a hung tool's execution the reset cut, then the loop-end cut: the write-up's queued prompt is the loop's own write (`ownPrompts`, so its row is set aside by the steer's resolution as the opening prompt's is) — the steer is unresolvable from the store and fails the run by name, handed back to the inbox and never folded in, not read as a landed row of the write-up", async () => {
    const r = await openCodeDriver({
      controlResetOnSteer: "lost",
      followUpAtFirstAsk: "also check the docs",
      interruptSettlesLate: "interrupted",
      hangToolCall: 1,
    }).run({
      turns: [
        {
          content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "sleep 30" } }],
          stopReason: "tool_use",
        },
        { content: [{ type: "text", text: "never" }], stopReason: "end_turn" },
      ],
    });
    // The steer is never mistaken for a landed row of the write-up's own prompt: it is handed back to the inbox
    // and never folded in, whether the store leaves it unresolvable (the run failing by name) or lost.
    expect(r.outcome.kind).toBe("failed");
    const err = r.outcome.kind === "failed" ? r.outcome.error : undefined;
    expect(err?.name).toBe("OpenCodeWriteUnresolvedError");
    expect(r.inboxLeft.map((i) => i.text)).toEqual(["also check the docs"]);
    expect(notes(r).some((n) => n.kind === "follow_up" && /folded in/.test(n.summary))).toBe(false);
  });

  it("a follow-up's steer into a RUNNING execution whose answer the reset cut, when the execution never reaches a step boundary before the loop leaves (a hung model call the finale interrupts): unresolved — no row, the store still showing the execution under way — and the run fails by name rather than hand a steer the server may have taken back for a second delivery", async () => {
    const r = await openCodeDriver({
      controlResetOnSteer: "landed",
      followUpAtPrompt: "also check the docs",
      interruptSettlesLate: "interrupted",
    }).run(hungCall);
    expect(r.outcome.kind).toBe("failed");
    const err = r.outcome.kind === "failed" ? r.outcome.error : undefined;
    expect(err?.name).toBe("OpenCodeWriteUnresolvedError");
    expect(err?.message).toMatch(/no row of the steer and the store still showing its execution under way/);
    expect(notes(r).some((n) => n.kind === "follow_up" && /not delivered/.test(n.summary))).toBe(false);
    expect(notes(r).some((n) => n.kind === "follow_up" && /folded in/.test(n.summary))).toBe(false);
  });

  it("a steer the server answered without a message id into a RUNNING execution that never reaches a step boundary before the loop leaves: unresolved by the same name — never noted as not delivered, never folded in; handed back for the fresh turn with the run's failure, since the session it may have reached is over", async () => {
    const r = await openCodeDriver({
      steerAnswersNoId: "landed",
      followUpAtPrompt: "also check the docs",
      interruptSettlesLate: "interrupted",
    }).run(hungCall);
    expect(r.outcome.kind).toBe("failed");
    const err = r.outcome.kind === "failed" ? r.outcome.error : undefined;
    expect(err?.name).toBe("OpenCodeWriteUnresolvedError");
    expect(err?.message).toMatch(/no row of the steer and the store still showing its execution under way/);
    expect(
      notes(r)
        .filter((n) => n.kind === "harness_error")
        .map((n) => n.summary)
        .some((s) => /the follow-up's steer/.test(s)),
    ).toBe(true);
    expect(notes(r).some((n) => n.kind === "follow_up" && /not delivered/.test(n.summary))).toBe(false);
    expect(notes(r).some((n) => n.kind === "follow_up" && /folded in/.test(n.summary))).toBe(false);
    expect(r.inboxLeft.map((i) => i.text)).toEqual(["also check the docs"]);
  });

  it("a follow-up's steer into a RUNNING execution the reset cut before the server took it: no row when its execution ends — the idle marker newest since the steer, the store's word — is the steer lost: handed back to the inbox, the run continuing, the model never shown it", async () => {
    const r = await openCodeDriver({ controlResetOnSteer: "lost", followUpAtFirstAsk: "also check the docs" }).run(
      toolTurn,
    );
    expect(answered(r)).toBe("done");
    const followUps = notes(r)
      .filter((n) => n.kind === "follow_up")
      .map((n) => n.summary);
    expect(followUps.some((s) => /not delivered — the steer did not reach the session/.test(s))).toBe(true);
    expect(followUps.some((s) => /folded in/.test(s))).toBe(false);
    expect(notes(r).filter((n) => n.kind === "harness_error")).toEqual([]);
    expect(r.inboxLeft.map((i) => i.text)).toEqual(["also check the docs"]);
    expect(
      r.modelCalls.some((c) =>
        c.messages.some(
          (m) =>
            m.role === "user" && m.content.some((p) => p.type === "text" && p.text.includes("also check the docs")),
        ),
      ),
    ).toBe(false);
  });

  it("a steer the server answered without a message id: its row in the store is the steer landed — folded in, the id learned so a later lost prompt of the same text is still re-issued", async () => {
    const NOW = 1_700_000_000_000;
    const sameWords = followUpPrompt([{ text: "same words", userId: "user:conformance", at: NOW }]);
    const r = await openCodeDriver({ steerAnswersNoId: "landed", controlResetOnPrompt: "lost" }).run({
      ...oneTurn,
      request: sameWords,
      followUp: "same words",
    });
    expect(answered(r)).toBe("done");
    expect(posts(r, "/prompt").map((q) => (JSON.parse(q.body ?? "{}") as { delivery?: string }).delivery)).toEqual([
      "steer",
      "queue",
      "queue",
    ]);
    const followUps = notes(r)
      .filter((n) => n.kind === "follow_up")
      .map((n) => n.summary);
    expect(followUps.some((s) => /folded in/.test(s))).toBe(true);
    expect(followUps.some((s) => /not delivered/.test(s))).toBe(false);
  });

  it("a steer the server answered without a message id and recorded nothing: no row in the idle store is the steer lost — handed back for a fresh turn once the loop has left and never steered again by this loop: one steer POST, one store read, the follow-up in the inbox after the run and never shown to the model", async () => {
    const r = await openCodeDriver({ steerAnswersNoId: "dropped" }).run({
      ...toolTurn,
      followUp: "also check the docs",
    });
    expect(answered(r)).toBe("done");
    const followUps = notes(r)
      .filter((n) => n.kind === "follow_up")
      .map((n) => n.summary);
    expect(
      followUps.some((s) =>
        /not delivered — the steer did not reach the session \(the server answered with no message id.*handed back to the inbox for a fresh turn/.test(
          s,
        ),
      ),
    ).toBe(true);
    expect(followUps.some((s) => /folded in/.test(s))).toBe(false);
    expect(
      posts(r, "/prompt").filter((q) => (JSON.parse(q.body ?? "{}") as { delivery?: string }).delivery === "steer"),
    ).toHaveLength(1);
    expect(storeReads(r)).toHaveLength(1);
    expect(r.inboxLeft.map((i) => i.text)).toEqual(["also check the docs"]);
    expect(modelSaw(r, "also check the docs")).toBe(false);
  });

  it("a batch of two follow-ups whose first steer the store told lost: the second is held with it — the batch handed back in order for the fresh turn once the loop has left, one steer POST, neither shown to the model", async () => {
    const r = await openCodeDriver({ steerAnswersNoId: "dropped" }).run({
      ...toolTurn,
      followUp: "first words",
      followUpToo: "second words",
    });
    expect(answered(r)).toBe("done");
    expect(
      posts(r, "/prompt").filter((q) => (JSON.parse(q.body ?? "{}") as { delivery?: string }).delivery === "steer"),
    ).toHaveLength(1);
    expect(r.inboxLeft.map((i) => i.text)).toEqual(["first words", "second words"]);
    expect(modelSaw(r, "first words")).toBe(false);
    expect(modelSaw(r, "second words")).toBe(false);
  });

  it("a parent run's steer arriving after a person's lost follow-up is another sender's: it is not held behind the person's — steered and folded in — while the person's alone waits for the fresh turn", async () => {
    const r = await openCodeDriver({
      steerAnswersNoId: "dropped",
      followUpAtFirstAsk: "the coordinator's steer",
      followUpAtFirstAskFrom: "run-parent",
    }).run({ ...toolTurn, followUp: "first words" });
    expect(answered(r)).toBe("done");
    const followUps = notes(r)
      .filter((n) => n.kind === "follow_up")
      .map((n) => n.summary);
    expect(followUps.filter((s) => /folded in/.test(s))).toEqual(["follow-up folded in: the coordinator's steer"]);
    expect(followUps.filter((s) => /not delivered/.test(s))).toHaveLength(1);
    expect(r.inboxLeft.map((i) => i.text)).toEqual(["first words"]);
    expect(modelSaw(r, "the coordinator's steer")).toBe(true);
    expect(modelSaw(r, "first words")).toBe(false);
  });

  it("a parent run's later steer is never held behind its earlier one the store told lost: a program's steer gets no fresh turn (the settlement sets it aside), so the second is steered and folded in while the first is handed back and noted as today", async () => {
    const r = await openCodeDriver({
      steerAnswersNoId: "dropped",
      followUpAtFirstAsk: "parent's second",
      followUpAtFirstAskFrom: "run-parent",
    }).run({ ...toolTurn, followUp: "parent's first", followUpFrom: "run-parent" });
    expect(answered(r)).toBe("done");
    const followUps = notes(r)
      .filter((n) => n.kind === "follow_up")
      .map((n) => n.summary);
    expect(followUps.filter((s) => /folded in/.test(s))).toEqual(["follow-up folded in: parent's second"]);
    expect(followUps.filter((s) => /not delivered/.test(s))).toHaveLength(1);
    expect(followUps.filter((s) => /held for a fresh turn/.test(s))).toEqual([]);
    expect(
      posts(r, "/prompt").filter((q) => (JSON.parse(q.body ?? "{}") as { delivery?: string }).delivery === "steer"),
    ).toHaveLength(2);
    expect(r.inboxLeft.map((i) => i.text)).toEqual(["parent's first"]);
    expect(modelSaw(r, "parent's second")).toBe(true);
  });

  it("a person's follow-up arriving after a lost one — a later drain of the inbox, the same sender — is held behind it, never steered by this loop: the fresh turn carries both in order, so the model never reads the later one before the earlier", async () => {
    const r = await openCodeDriver({ steerAnswersNoId: "dropped", followUpAtFirstAsk: "second words" }).run({
      ...toolTurn,
      followUp: "first words",
    });
    expect(answered(r)).toBe("done");
    const followUps = notes(r)
      .filter((n) => n.kind === "follow_up")
      .map((n) => n.summary);
    expect(followUps.filter((s) => /folded in/.test(s))).toEqual([]);
    expect(followUps.filter((s) => /not delivered/.test(s))).toHaveLength(1);
    // The held follow-up leaves its trace: the record says it waits for the fresh turn behind the earlier one.
    expect(followUps.filter((s) => /held for a fresh turn/.test(s))).toEqual([
      "follow-up held for a fresh turn behind an earlier one from the same sender the server did not take: second words",
    ]);
    expect(
      posts(r, "/prompt").filter((q) => (JSON.parse(q.body ?? "{}") as { delivery?: string }).delivery === "steer"),
    ).toHaveLength(1);
    expect(r.inboxLeft.map((i) => i.text)).toEqual(["first words", "second words"]);
    expect(modelSaw(r, "second words")).toBe(false);
    expect(modelSaw(r, "first words")).toBe(false);
  });

  it("two writes around one reset — the loop's queue prompt and a follow-up's steer into the execution it started, both answers cut — do not wait on each other: the prompt's resolution waits for the steer's POST and first store read, never for the step boundary only the loop's own feed reading delivers, so the loop reads on, the boundary comes, and the steer is folded in (a circular wait would hang the run)", async () => {
    const r = await openCodeDriver({
      controlResetOnPrompt: "landed",
      controlResetOnSteer: "landed",
      followUpAtPrompt: "also check the docs",
    }).run(toolTurn);
    expect(answered(r)).toBe("done");
    expect(posts(r, "/prompt").map((q) => (JSON.parse(q.body ?? "{}") as { delivery?: string }).delivery)).toEqual([
      "queue",
      "steer",
    ]);
    const followUps = notes(r)
      .filter((n) => n.kind === "follow_up")
      .map((n) => n.summary);
    expect(followUps.some((s) => /folded in/.test(s))).toBe(true);
    expect(followUps.some((s) => /not delivered/.test(s))).toBe(false);
    expect(notes(r).filter((n) => n.kind === "harness_error")).toEqual([]);
  });

  it("a batch of two follow-ups whose first steer ends unresolved: both are handed back to the inbox with the run's failure, in order — the unresolved one too, since the run it may have reached is over — and no stop is asked of the run's control (the loop ends by the failure's name, no stopped note), so the dispatcher's settlement hands them on for the fresh turn rather than drop them as an operator's stop would; never a follow-up dropped", async () => {
    const r = await openCodeDriver({ controlResetOnSteer: "landed", storeListingResets: true }).run({
      ...oneTurn,
      followUp: "also check the docs",
      followUpToo: "and the tests",
    });
    expect(r.outcome.kind).toBe("failed");
    // No stop is asked of the control: the run fails by name through the loop, so the dispatcher's settlement sees no stop and hands the follow-ups on.
    expect(r.stopRequested).toBeUndefined();
    expect(notes(r).filter((n) => n.kind === "stopped")).toEqual([]);
    expect(r.inboxLeft.map((i) => i.text)).toEqual(["also check the docs", "and the tests"]);
    expect(notes(r).some((n) => n.kind === "harness_error" && /the follow-up's steer/.test(n.summary))).toBe(true);
  });

  it("a harness failure by name and an operator's hard stop landing in one tick — both while the loop waits on its prompt's answer, so its next check reads them together: the stop wins — the run ends as the stop, its `stopped` note written and the hard stop's answer given, the failure a `harness_error` on the record and not the run's end, the interrupt posted once", async () => {
    // The prompt's answer is held until the follow-up's steer has been posted (`followUpAtPrompt`); the steer's
    // resolution meets the store's reset, which fails it by name and requests the stop in one go, before the loop
    // reads anything again.
    const r = await openCodeDriver({
      controlResetOnSteer: "landed",
      storeListingResets: true,
      hardStopOnStoreReset: true,
      followUpAtPrompt: "also check the docs",
    }).run(toolTurn);
    expect(r.outcome).toEqual({ kind: "answered", answer: HARD_STOP_MESSAGE });
    expect(r.stopRequested).toBe("hard");
    expect(notes(r).filter((n) => n.kind === "stopped")).toHaveLength(1);
    expect(notes(r).some((n) => n.kind === "harness_error" && /the follow-up's steer/.test(n.summary))).toBe(true);
    expect(posts(r, "/interrupt")).toHaveLength(1);
  });

  it("a follow-up's steer the reset cut before the server took it is handed back to the inbox, as any steer the server never took", async () => {
    const r = await openCodeDriver({ controlResetOnSteer: "lost" }).run({
      ...oneTurn,
      followUp: "also check the docs",
    });
    expect(answered(r)).toBe("done");
    const followUps = notes(r)
      .filter((n) => n.kind === "follow_up")
      .map((n) => n.summary);
    expect(followUps.some((s) => /not delivered — the steer did not reach the session/.test(s))).toBe(true);
    expect(followUps.some((s) => /folded in/.test(s))).toBe(false);
  });

  it("a steer this generation posted whose row carries the prompt's exact text is not the prompt landed: the steer's message id is known from its answer, so a lost prompt is still re-issued", async () => {
    const NOW = 1_700_000_000_000;
    const sameWords = followUpPrompt([{ text: "same words", userId: "user:conformance", at: NOW }]);
    const r = await openCodeDriver({ controlResetOnPrompt: "lost" }).run({
      ...oneTurn,
      request: sameWords,
      followUp: "same words",
    });
    expect(answered(r)).toBe("done");
    // The drainer's steer, then the lost prompt and its re-issue.
    expect(posts(r, "/prompt").map((q) => (JSON.parse(q.body ?? "{}") as { delivery?: string }).delivery)).toEqual([
      "steer",
      "queue",
      "queue",
    ]);
    expect(notes(r).filter((n) => n.kind === "harness_error")).toEqual([]);
  });

  it("a re-issued prompt that meets the reset again fails the run by name — OpenCodeWriteUnresolvedError, a harness_error naming the prompt — never a third send", async () => {
    const r = await openCodeDriver({ controlResetOnPrompt: "again" }).run(oneTurn);
    expect(r.outcome.kind).toBe("failed");
    const err = r.outcome.kind === "failed" ? r.outcome.error : undefined;
    expect(err?.name).toBe("OpenCodeWriteUnresolvedError");
    expect(err?.message).toMatch(/^the prompt was in flight when the resident's control plane reset under the run/);
    expect(posts(r, "/prompt")).toHaveLength(2);
    expect(notes(r).some((n) => n.kind === "harness_error" && /^the prompt was in flight/.test(n.summary))).toBe(true);
  });

  it("a gate reply the reset cut after the server took it is not re-issued: the ask is no longer pending, the tool's result is on the record, and the run answers", async () => {
    const r = await openCodeDriver({ controlResetOnReply: "landed" }).run(toolTurn);
    expect(answered(r)).toBe("done");
    expect(replies(r)).toHaveLength(1);
    expect(gets(r, "/permission")).toHaveLength(1);
    expect(r.events.some((e) => e.type === "tool_result" && e.callId === "c1" && e.ok)).toBe(true);
    expect(
      notes(r)
        .filter((n) => n.kind === "resumed")
        .map((n) => n.summary),
    ).toEqual([CONTROL_RESET_RESUMED_NOTE]);
    expect(notes(r).filter((n) => n.kind === "harness_error")).toEqual([]);
  });

  it("a gate reply the reset cut before the server took it is re-issued once: the ask is still pending, the second POST is taken, and the run answers", async () => {
    const r = await openCodeDriver({ controlResetOnReply: "lost" }).run(toolTurn);
    expect(answered(r)).toBe("done");
    expect(replies(r)).toHaveLength(2);
    expect(gets(r, "/permission")).toHaveLength(1);
    expect(notes(r).filter((n) => n.kind === "harness_error")).toEqual([]);
  });

  it("a gate reply whose outcome the server cannot be asked about fails the run closed by name: OpenCodeReplyFailedError carrying the unresolved write, a harness_error naming the request, the interrupt posted", async () => {
    const r = await openCodeDriver({ controlResetOnReply: "unlistable" }).run(toolTurn);
    expect(r.outcome.kind).toBe("failed");
    const err = r.outcome.kind === "failed" ? r.outcome.error : undefined;
    expect(err?.name).toBe("OpenCodeReplyFailedError");
    expect(err?.message).toMatch(
      /the gate's reply for request per_c1 was in flight when the resident's control plane reset under the run/,
    );
    expect(replies(r)).toHaveLength(1);
    expect(
      notes(r).some((n) => n.kind === "harness_error" && /the gate's reply for request per_c1/.test(n.summary)),
    ).toBe(true);
    expect(posts(r, "/interrupt")).toHaveLength(1);
  });
});

describe("resumeOpenCodeFacts", () => {
  it("narrows a resume's facts to OpenCode's, and nothing for another harness's or no resume", () => {
    expect(resumeOpenCodeFacts(undefined)).toBeUndefined();
    const oc = facts();
    expect(
      resumeOpenCodeFacts({ messages: [], settlements: [], remainingMs: 0, turn: 0, inboxConsumedSeq: 0, facts: oc }),
    ).toBe(oc);
    expect(
      resumeOpenCodeFacts({
        messages: [],
        settlements: [],
        remainingMs: 0,
        turn: 0,
        inboxConsumedSeq: 0,
        facts: { harness: "pi", pid: 1, logOffset: 0, relaunches: 0 },
      }),
    ).toBeUndefined();
  });
});
