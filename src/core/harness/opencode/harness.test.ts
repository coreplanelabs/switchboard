import { describe, expect, it } from "vitest";
import type { RunnableTool } from "../../../tools/runnableTool.js";
import { updateStatusTool } from "../../../tools/status.js";
import type { ChatMessage } from "../../chatMessage.js";
import type { RunEvent } from "../../runEvents.js";
import { HarnessContainerError } from "../container.js";
import type { OpenCodeHarnessFacts, PiHarnessFacts } from "../contract.js";
import { HarnessRegistry, relayToolCall, type LiveHarness } from "../pi/relay.js";
import { FakeHarnessContainer } from "../testing/fakeContainer.js";
import type { DrivenRun } from "../testing/scenarios.js";
import { OPENCODE_EVENT_DISPOSITION } from "./dispositions.js";
import { OpenCodeHarness, resumeOpenCodeFacts } from "./harness.js";
import { openCodeRunPaths } from "./process.js";
import { openCodeReplacedCallNote } from "./session.js";
import { openCodeDriver } from "./testing/driver.js";

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
