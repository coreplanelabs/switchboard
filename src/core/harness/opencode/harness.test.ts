import { describe, expect, it } from "vitest";
import type { RunnableTool } from "../../../tools/runnableTool.js";
import { updateStatusTool } from "../../../tools/status.js";
import type { ChatMessage } from "../../chatMessage.js";
import type { RunEvent } from "../../runEvents.js";
import { HarnessContainerError } from "../container.js";
import {
  openThroughSeam,
  type HarnessDeps,
  type HarnessResume,
  type HarnessRun,
  type OpenCodeHarnessFacts,
  type PiHarnessFacts,
} from "../contract.js";
import { HarnessRegistry, relayToolCall, type LiveHarness } from "../pi/relay.js";
import { PROXY_PROVIDER } from "../pi/process.js";
import { FakeHarnessContainer } from "../testing/fakeContainer.js";
import type { DrivenRun, RunScript } from "../testing/scenarios.js";
import { loopClock, MINUTE_MS } from "../../budgets.js";
import { recordingSink } from "../../testing/recordingSink.js";
import { finaleAbortReason, finaleTimedOutNote, timeBudgetAnswer, windDownFailureNote } from "../windDown.js";
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
    // …and the execution fails at once, in the server's words, with the refills and no idle event after it.
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
  function openRun(options: FakeServeOptions, script: RunScript = oneTurn) {
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
      onEvent: (e) => void events.push(e),
      onProgress: (n) => void progress.push(n),
      onStep: async () => {},
    };
    const deps: HarnessDeps = {
      container,
      bearer: "sbr_run-p.post-turn-secret",
      harnessUrl: "https://bot.example.com",
      registry,
      clock: () => clock.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
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

  it("after a hung turn: the loop ended at the finale and the aborted execution's tail lands only once the post-turn's prompt is posted — an ask pending at the interrupt failing aborted, the step failing, then the settle, as the pinned binary writes them — and the post-turn decides nothing of it: no reply posted, no bypass, no tool event on its record, the settle set aside; it waits for its own execution's start and answers the turn's own text; no second harness_error", async () => {
    const o = openRun({ interruptSettlesLate: "interrupted" }, hung);
    const session = await o.opened;
    const reason = finaleAbortReason(o.lease.finaleMs);
    expect(session.answer).toBe(timeBudgetAnswer("", 10, reason));
    expect(o.progress).toContain(finaleTimedOutNote());
    expect(await session.followUp(postTurn)).toBe("never");
    expect(
      notes(o.events)
        .filter((n) => n.kind === "harness_error")
        .map((n) => n.summary),
    ).toEqual([windDownFailureNote(reason)]);
    // Nothing of the earlier execution's tail was decided or recorded as this turn's.
    expect(o.container.requests.some((q) => q.path.includes("per_c-ask"))).toBe(false);
    expect(
      o.events.some((e) => (e.type === "tool_call" || e.type === "tool_result") && /c-(slow|ask)/.test(e.callId ?? "")),
    ).toBe(false);
    // The loop's span ended ok: the finale is the wind-down's ending, as on pi.
    expect(o.sink.ended("run.agent")?.status).toBe("ok");
    await session.end();
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

  it("after a hung turn whose tail carries a dropped stream's note and an event kind no table names: both are surfaced before the post-turn's execution starts — the note on the card, the kind as a harness_error — and the post-turn still answers its own text", async () => {
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
// bound). The POST-side resolution (a control reset on the prompt POST) is owned
// by the OpenCode request-path rework, out of this PR's scope.
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
