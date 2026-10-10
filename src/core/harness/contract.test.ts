import { openCodeDriver } from "./opencode/testing/driver.js";
import { OpenCodeHarness } from "./opencode/harness.js";
import { describe, expect, it } from "vitest";
import type { AgentDef } from "../../agents/registry.js";
import type { Executor } from "../../execution/executor.js";
import type { RunnableTool } from "../../tools/runnableTool.js";
import { bearerHashOf } from "../modelProxy/runBearers.js";
import type { Provider } from "../provider.js";
import type { RunEvent } from "../runEvents.js";
import type { StepReport } from "../runLedger/stepReport.js";
import { RunControl } from "../runRegistry/runControl.js";
import { FollowUpInbox } from "../threadAdmission.js";
import {
  factsBelongTo,
  HarnessContainerReplacedError,
  HarnessInterruptedError,
  HarnessMismatchError,
  harnessFactsOf,
  isPiFacts,
  openThroughSeam,
  nextHarnessLaunch,
  type HarnessDeps,
  type Harness,
  type HarnessFacts,
  type HarnessRecord,
  type HarnessRun,
  type OpenCodeHarnessFacts,
  type PiHarnessFacts,
} from "./contract.js";
import { PI_EVENT_DISPOSITION } from "./pi/bridge.js";
import { runPiHarnessOpen } from "./pi/harness.js";
import { PiHarness } from "./pi/piHarness.js";
import { piBuiltinToolsFor, piRunPaths, piSettingsJson, piThinkingLevel } from "./pi/process.js";
import { HarnessRegistry } from "./pi/relay.js";
import { HarnessEndingUnconfirmedError } from "./container.js";
import { piDriver } from "./pi/testing/driver.js";
import { FakeHarnessContainer } from "./testing/fakeContainer.js";
import { scriptPiFromProvider } from "./pi/testing/providerPi.js";

// Feature: docs/reference/specs/harness.md — the seam between the run loop and
// a harness: the facts a row carries, read by the harness that wrote them; pi
// as the contract's object, whose `open` is the loop that exists; `find`'s
// four answers before any pid is probed; `end` for a leftover; and the refusal
// of another harness's row.

const NOW = 1_700_000_000_000;
const paths = piRunPaths("run-7");
/** One bearer for every run here, so two runs' facts carry one hash and compare equal. */
const BEARER = "sbr_run-7.a-fixed-secret-for-the-comparison";

const agent: AgentDef = {
  name: "coding",
  description: "",
  system: "You are the coding agent.",
  toolset: "full",
  machine: "repo-resident",
  identity: "write",
  tiers: ["strong"],
  maxTurns: 270,
  maxTokens: 64000,
  maxMinutes: 45,
};

const updateStatus: RunnableTool = {
  name: "update_status",
  description: "the card",
  inputSchema: { type: "object", properties: { checklist: { type: "string" } } },
  run: async (input, ctx) => {
    ctx.reportProgress?.(String(input.checklist));
    return "status updated";
  },
};

/** The run's executor, as pi's own bash tool runs over it in the scripted double. */
const executor: Executor = {
  exec: async (command) => `ran: ${command}`,
  readFile: async () => "",
  writeFile: async () => "",
};

/** A model that runs one shell command, then answers. */
function twoTurnProvider(): Provider {
  let turns = 0;
  return {
    name: "scripted",
    async complete() {
      turns++;
      if (turns === 1)
        return {
          content: [{ type: "tool_use", id: "call_0", name: "bash", input: { command: "npm test" } }],
          stopReason: "tool_use",
        };
      return { content: [{ type: "text", text: "All green." }], stopReason: "end_turn" };
    },
  };
}

const OPENCODE_FACTS: OpenCodeHarnessFacts = {
  harness: "opencode",
  pid: 9,
  port: 41000,
  tailerPid: 10,
  logOffset: 512,
  sessionID: "ses_1",
  root: "/tmp/switchboard-oc-run-7",
  bearerHash: "h",
  container: "vm-1",
  relaunches: 1,
};

/** A model that answers at once, no tool call. */
const textOnlyProvider = (): Provider => ({
  name: "scripted",
  async complete() {
    return { content: [{ type: "text", text: "picked up where I left off" }], stopReason: "end_turn" };
  },
});

/** One run over the fake container, pi scripted from the model given (the
 *  two-turn one by default); the sinks record what the harness writes, the
 *  clock never moves, the sleep is the event loop's own turn. */
function world(opts: { resume?: HarnessRun["resume"]; provider?: Provider } = {}) {
  const container = new FakeHarnessContainer();
  const registry = new HarnessRegistry();
  const events: RunEvent[] = [];
  const steps: StepReport[] = [];
  const facts: HarnessFacts[] = [];
  const notes: string[] = [];
  scriptPiFromProvider(container, { provider: opts.provider ?? twoTurnProvider(), registry });
  const run: HarnessRun = {
    runId: "run-7",
    agent,
    effort: "high",
    model: { id: "claude-fable-5", provider: "anthropic", providerType: "anthropic" },
    system: "You are the coding agent.",
    messages: [{ role: "user", content: [{ type: "text", text: "fix the failing test" }] }],
    tools: [updateStatus],
    toolContext: { executor },
    rules: { checkout: "/workspace/threads/t/main", protectedBranches: ["main"] },
    control: new RunControl(),
    inbox: new FollowUpInbox(),
    onEvent: (e) => void events.push(e),
    onProgress: (n) => void notes.push(n),
    onStep: async (r) => void steps.push(r),
    saveFacts: (f) => void facts.push(f),
    ...(opts.resume ? { resume: opts.resume } : {}),
  };
  const deps: HarnessDeps = {
    container,
    bearer: BEARER,
    harnessUrl: "https://bot.example.com",
    registry,
    clock: () => NOW,
    sleep: () => new Promise((r) => setImmediate(r)),
    pollMs: 1,
    tickMs: 1,
  };
  return { container, registry, events, steps, facts, notes, run, deps };
}

/** The fake, recording which of `identity` and `alive` the harness asked. */
class WatchedContainer extends FakeHarnessContainer {
  readonly asked: string[] = [];
  override async identity(): Promise<string | undefined> {
    this.asked.push("identity");
    return super.identity();
  }
  override async alive(pid: number): Promise<boolean> {
    this.asked.push(`alive ${pid}`);
    return super.alive(pid);
  }
}

const piFactsIn = (container?: string): PiHarnessFacts => ({
  harness: "pi",
  pid: 4242,
  logOffset: 0,
  root: paths.dir,
  relaunches: 0,
  ...(container ? { container } : {}),
});

describe("durable launch intent", () => {
  it.each(["pi", "opencode"] as const)("binds the next %s intent to the vouched original producer", (harness) => {
    const driver = harness === "pi" ? piDriver() : openCodeDriver();
    const policy = { version: 1, commandRoute: "hosted-review", identity: "read" } as const;
    const intent = { version: 1, harness, phase: "begun", ordinal: 0, sessionPolicy: policy };
    const facts = { ...driver.facts({ pid: 999, container: "vm-original" }), sessionPolicy: policy, launchOrdinal: 0 };
    const replaced = new HarnessContainerReplacedError("replaced", "runtime-replaced", "vm-original", "vm-next", {
      messages: [],
      compactions: [],
      settlements: [],
      turn: 1,
      inboxConsumedSeq: 0,
      deadline: NOW + 300000,
    });
    expect(nextHarnessLaunch("run-c", intent, facts, replaced)).toEqual({
      version: 1,
      harness,
      phase: "prepared",
      ordinal: 1,
      sessionPolicy: { version: 1, commandRoute: "hosted-review", identity: "read" },
    });
    for (const unknown of [undefined, { ...facts, launchOrdinal: 1 }, { ...facts, container: "foreign" }]) {
      expect(() => nextHarnessLaunch("run-c", intent, unknown, replaced)).toThrow(HarnessEndingUnconfirmedError);
    }
    expect(intent.phase).toBe("begun");
    expect(facts.launchOrdinal).toBe(0);
  });
  it.each(["pi", "opencode"] as const)(
    "admits no %s process after a stop during launch acknowledgement",
    async (harness) => {
      const driver = harness === "pi" ? piDriver() : openCodeDriver();
      const control = new RunControl();
      const result = await driver.run({
        control,
        identity: "read",
        commandPolicy: "hosted-review",
        launchIntent: {
          version: 1,
          harness,
          phase: "prepared",
          ordinal: 0,
          sessionPolicy: { version: 1, commandRoute: "hosted-review", identity: "read" },
        },
        onLaunchIntent: async () => {
          control.requestStop("hard");
          return true;
        },
        turns: [{ content: [{ type: "text", text: "must not enter model" }], stopReason: "end_turn" }],
      });
      expect(result.outcome).toMatchObject({
        kind: "failed",
        error: { name: "HarnessOperationEndedError", reason: "cancelled" },
      });
      expect(result.starts).toEqual([]);
      expect(result.modelCalls).toEqual([]);
    },
  );
  it.each(["pi", "opencode"] as const)(
    "retains a lost %s start response and refuses to launch it again",
    async (name) => {
      const w = world({ provider: textOnlyProvider() });
      const start = w.container.start.bind(w.container);
      w.container.start = async (spec) => {
        await start(spec);
        throw new Error("start reply lost");
      };
      const prepared = {
        version: 1,
        harness: name,
        phase: "prepared",
        ordinal: 0,
        sessionPolicy: { version: 1, commandRoute: "hosted-review", identity: "read" },
      };
      let saved: unknown = prepared;
      Object.assign(w.run, {
        agent: { ...agent, name: "review", identity: "read", toolset: "readonly" },
        commandPolicy: "hosted-review",
        launchIntent: prepared,
        saveLaunchIntent: async (intent: unknown) => {
          saved = structuredClone(intent);
          return true;
        },
      });
      const harness = name === "pi" ? new PiHarness() : new OpenCodeHarness();
      await expect(harness.open(w.deps, w.run)).rejects.toMatchObject({ name: "HarnessEndingUnconfirmedError" });
      expect(saved).toEqual({
        version: 1,
        harness: name,
        phase: "begun",
        ordinal: 0,
        sessionPolicy: { version: 1, commandRoute: "hosted-review", identity: "read" },
      });
      expect(w.container.starts).toHaveLength(1);
      expect(w.container.removed).toEqual([]);
      expect(w.container.killed).toEqual([]);
      const resumed = world({
        resume: { messages: [], settlements: [], remainingMs: 300000, turn: 0, inboxConsumedSeq: 0 },
      });
      Object.assign(resumed.run, { agent: w.run.agent, commandPolicy: "hosted-review", launchIntent: saved });
      await expect(harness.open(resumed.deps, resumed.run)).rejects.toMatchObject({
        openingError: { operation: "resume" },
      });
      expect(resumed.container.starts).toEqual([]);
      expect(resumed.facts).toEqual([]);
    },
  );
  it.each(["pi", "opencode"] as const)(
    "continues an acknowledged never-begun %s launch after restart",
    async (harness) => {
      const driver = harness === "pi" ? piDriver() : openCodeDriver();
      const launchIntent = {
        version: 1,
        harness,
        phase: "prepared",
        ordinal: 0,
        sessionPolicy: { version: 1, commandRoute: "hosted-review", identity: "read" },
      };
      const checkpoints: unknown[] = [];
      const result = await driver.run({
        identity: "read",
        commandPolicy: "hosted-review",
        launchIntent,
        onLaunchIntent: async (intent) => {
          checkpoints.push(structuredClone(intent));
          return true;
        },
        onFacts: async (facts) => {
          checkpoints.push({ producer: facts.harness, sessionPolicy: facts.sessionPolicy });
          return true;
        },
        resume: { messages: [], settlements: [], remainingMs: 300000, turn: 0, inboxConsumedSeq: 0 },
        turns: [{ content: [{ type: "text", text: "original review completed" }], stopReason: "end_turn" }],
      });
      expect(result.outcome).toEqual({ kind: "answered", answer: "original review completed" });
      expect(checkpoints.slice(0, 2)).toEqual([
        {
          version: 1,
          harness,
          phase: "begun",
          ordinal: 0,
          sessionPolicy: { version: 1, commandRoute: "hosted-review", identity: "read" },
        },
        { producer: harness, sessionPolicy: { version: 1, commandRoute: "hosted-review", identity: "read" } },
      ]);
      expect(result.modelCalls).toHaveLength(1);
      expect(launchIntent.phase).toBe("prepared");
    },
  );
  it.each(["pi", "opencode"] as const)(
    "holds a begun %s launch without its producer receipt after restart",
    async (harness) => {
      const driver = harness === "pi" ? piDriver() : openCodeDriver();
      const result = await driver.run({
        identity: "read",
        commandPolicy: "hosted-review",
        launchIntent: {
          version: 1,
          harness,
          phase: "begun",
          ordinal: 0,
          sessionPolicy: { version: 1, commandRoute: "hosted-review", identity: "read" },
        },
        resume: { messages: [], settlements: [], remainingMs: 60000, turn: 0, inboxConsumedSeq: 0 },
        turns: [{ content: [{ type: "text", text: "must not start" }], stopReason: "end_turn" }],
      });
      expect(result.outcome).toMatchObject({
        kind: "failed",
        error: {
          name: "HarnessEndingUnconfirmedError",
          openingError: {
            operation: "resume",
            message:
              "harness container: resume failed — The original launch intent or process start cannot be verified for this continuation.",
          },
        },
      });
      expect(result.starts).toEqual([]);
      expect(result.modelCalls).toEqual([]);
      expect(result.facts).toEqual([]);
    },
  );
  it.each(["pi", "opencode"] as const)(
    "holds an unknown later %s start even when an older producer receipt exists",
    async (harness) => {
      const driver = harness === "pi" ? piDriver() : openCodeDriver();
      const policy = { version: 1, commandRoute: "hosted-review", identity: "read" } as const;
      const original = {
        ...driver.facts({ pid: 999, container: driver.containerWord }),
        sessionPolicy: policy,
        launchOrdinal: 0,
      };
      const result = await driver.run({
        identity: "read",
        commandPolicy: "hosted-review",
        launchIntent: { version: 1, harness, phase: "begun", ordinal: 1, sessionPolicy: policy },
        resume: { facts: original, messages: [], settlements: [], remainingMs: 300000, turn: 1, inboxConsumedSeq: 0 },
        turns: [{ content: [{ type: "text", text: "must not enter model" }], stopReason: "end_turn" }],
      });
      expect(result.outcome).toMatchObject({
        kind: "failed",
        error: { name: "HarnessEndingUnconfirmedError", openingError: { operation: "resume" } },
      });
      expect(result.starts).toEqual([]);
      expect(result.modelCalls).toEqual([]);
      expect(result.facts).toEqual([]);
    },
  );
  it.each(["pi", "opencode"] as const)(
    "holds %s before process start when the launch checkpoint is unknown",
    async (name) => {
      const w = world({ provider: textOnlyProvider() });
      w.container.request = async () => {
        throw new Error("process started before launch checkpoint");
      };
      let at = NOW;
      w.deps.clock = () => at;
      w.deps.sleep = async () => {
        at += 1000;
      };
      const intent = {
        version: 1,
        harness: name,
        phase: "prepared",
        ordinal: 0,
        sessionPolicy: { version: 1, commandRoute: "hosted-review", identity: "read" },
      };
      Object.assign(w.run, {
        agent: { ...agent, name: "review", identity: "read", toolset: "readonly" },
        commandPolicy: "hosted-review",
        launchIntent: intent,
        saveLaunchIntent: async () => false,
      });
      const harness = name === "pi" ? new PiHarness() : new OpenCodeHarness();
      await expect(harness.open(w.deps, w.run)).rejects.toMatchObject({
        openingError: {
          message: "harness container: checkpoint failed — The original launch checkpoint was not acknowledged.",
        },
      });
      expect(w.container.starts).toEqual([]);
      expect(w.facts).toEqual([]);
      expect(intent.phase).toBe("prepared");
    },
  );
});

// Feature: docs/reference/specs/harness.md item 6 — the replaced verdict's
// condition is a tag, and the executor's words are present exactly when the
// tag says the word decided.
describe("HarnessContainerReplacedError — the condition's tag and the words it carries", () => {
  const record: HarnessRecord = {
    messages: [],
    compactions: [],
    settlements: [],
    turn: 0,
    inboxConsumedSeq: 0,
    deadline: 0,
  };

  it("a verdict by the executor's word carries them and is tagged `word` — the default, so the seam's existing constructions stand; a verdict by the changed identity carries none and is tagged `identity`", () => {
    const byWord = new HarnessContainerReplacedError("replaced", "runtime-replaced", "vm-a", "vm-b", record);
    expect(byWord).toMatchObject({
      said: "runtime-replaced",
      condition: "word",
      reason: "container replaced under the run",
    });
    const byIdentity = new HarnessContainerReplacedError("replaced", undefined, "vm-a", "vm-b", record, "identity");
    expect(byIdentity).toMatchObject({ said: undefined, condition: "identity", was: "vm-a", now: "vm-b" });
    expect(byIdentity).toBeInstanceOf(HarnessInterruptedError);
  });

  it("a verdict by the standing transport failure on a resident-backed run carries the failing command's words and is tagged `transport` — the same interruption the run loop relaunches on", () => {
    const byTransport = new HarnessContainerReplacedError(
      "stopped answering",
      "resident /exec: Peer closed WebSocket: 1006",
      "vm-a",
      undefined,
      record,
      "transport",
    );
    expect(byTransport).toMatchObject({
      said: "resident /exec: Peer closed WebSocket: 1006",
      condition: "transport",
      was: "vm-a",
      now: undefined,
      reason: "container replaced under the run",
    });
    expect(byTransport).toBeInstanceOf(HarnessInterruptedError);
  });

  it("the invariant is refused at construction: a verdict tagged `word` or `transport` with no words, or tagged `identity` with words no command returned, is a harness bug named as such", () => {
    expect(() => new HarnessContainerReplacedError("replaced", undefined, "vm-a", "vm-b", record, "word")).toThrow(
      "a replaced verdict by the executor's word or the transport carries no words",
    );
    expect(
      () => new HarnessContainerReplacedError("replaced", undefined, "vm-a", undefined, record, "transport"),
    ).toThrow("a replaced verdict by the executor's word or the transport carries no words");
    expect(() => new HarnessContainerReplacedError("replaced", "said", "vm-a", "vm-b", record, "identity")).toThrow(
      "a replaced verdict by the changed identity carries words no command returned",
    );
  });
});

describe("harnessFactsOf — a row's facts, read by the harness that wrote them", () => {
  it("preserves the OpenCode tailer's launch identity separately and drops malformed evidence", () => {
    const tailerProcessBirth = "11111111-1111-1111-1111-111111111111:456";
    expect(harnessFactsOf({ ...OPENCODE_FACTS, tailerProcessBirth })).toMatchObject({ tailerProcessBirth });
    expect(harnessFactsOf(OPENCODE_FACTS)).not.toHaveProperty("tailerProcessBirth");
    expect(harnessFactsOf({ ...OPENCODE_FACTS, tailerProcessBirth: 456 })).not.toHaveProperty("tailerProcessBirth");
  });
  it("preserves launch identity for both harnesses and leaves legacy rows unattested", () => {
    const birth = "11111111-1111-1111-1111-111111111111:123";
    for (const facts of [piFactsIn(), OPENCODE_FACTS]) {
      expect(harnessFactsOf({ ...facts, processBirth: birth })).toMatchObject({ processBirth: birth });
      expect(harnessFactsOf(facts)).not.toHaveProperty("processBirth");
      expect(harnessFactsOf({ ...facts, processBirth: 123 })).not.toHaveProperty("processBirth");
    }
  });
  it("a row naming pi, and a row from before the discriminator, are pi's: the known fields read by type, relaunches 0 when absent or malformed, a field of the wrong type dropped, an unknown key kept", () => {
    const full = {
      harness: "pi",
      pid: 7,
      logOffset: 120,
      sessionFile: "s.jsonl",
      root: "/tmp/switchboard-pi-run-7",
      bearerHash: "h",
      wire: "openai-responses",
      container: "vm-1",
      relaunches: 2,
    };
    expect(harnessFactsOf(full)).toEqual(full);
    expect(harnessFactsOf({ pid: 7, logOffset: 120, root: "/tmp/r", container: "vm-1" })).toEqual({
      harness: "pi",
      pid: 7,
      logOffset: 120,
      root: "/tmp/r",
      container: "vm-1",
      relaunches: 0,
    });
    expect(harnessFactsOf({ pid: 7, logOffset: 120, container: 9, root: 42, relaunches: -1 })).toEqual({
      harness: "pi",
      pid: 7,
      logOffset: 120,
      relaunches: 0,
    });
    expect(harnessFactsOf({ pid: 7, logOffset: 120, relaunches: 1.5 })).toMatchObject({ relaunches: 0 });
    expect(harnessFactsOf({ pid: 7, logOffset: 120, wire: "not-a-wire" })).not.toHaveProperty("wire");
    // A key a later build writes rides through this build's rewrite of the row.
    expect(harnessFactsOf({ pid: 7, logOffset: 120, futureField: { kept: true } })).toEqual({
      harness: "pi",
      pid: 7,
      logOffset: 120,
      relaunches: 0,
      futureField: { kept: true },
    });
    expect(harnessFactsOf({ pid: "7", logOffset: 120 })).toBeUndefined();
    expect(harnessFactsOf({ harness: "pi", logOffset: 120 })).toBeUndefined();
    expect(harnessFactsOf(undefined)).toBeUndefined();
    expect(harnessFactsOf(null)).toBeUndefined();
    expect(harnessFactsOf("pi")).toBeUndefined();
  });

  it("a row naming opencode is the second harness's shape: its fields read, relaunches and an unknown key kept, the bearer hash and the container optional as on pi's row (a bot-host row has no container word), and a row missing pid, port, logOffset, sessionID or root is no facts", () => {
    expect(harnessFactsOf(OPENCODE_FACTS)).toEqual(OPENCODE_FACTS);
    expect(harnessFactsOf({ ...OPENCODE_FACTS, relaunches: undefined, extra: 1 })).toEqual({
      ...OPENCODE_FACTS,
      relaunches: 0,
      extra: 1,
    });
    const { bearerHash: _h, container: _c, ...bare } = OPENCODE_FACTS;
    expect(harnessFactsOf(bare)).toEqual(bare);
    expect(harnessFactsOf({ ...OPENCODE_FACTS, container: 1, bearerHash: 2 })).toEqual(bare);
    const { tailerPid: _t, ...noTailer } = OPENCODE_FACTS;
    expect(harnessFactsOf(noTailer)).toEqual(noTailer);
    expect(harnessFactsOf({ ...OPENCODE_FACTS, tailerPid: "10" })).toEqual(noTailer);
    expect(harnessFactsOf({ ...OPENCODE_FACTS, port: "41000" })).toBeUndefined();
    expect(harnessFactsOf({ ...OPENCODE_FACTS, logOffset: undefined })).toBeUndefined();
    expect(harnessFactsOf({ ...OPENCODE_FACTS, sessionID: undefined })).toBeUndefined();
    expect(harnessFactsOf({ ...OPENCODE_FACTS, root: 7 })).toBeUndefined();
  });

  it("a row naming a harness this build does not know is no facts: nothing of it can be judged or ended here", () => {
    expect(harnessFactsOf({ harness: "codex", pid: 1, logOffset: 0 })).toBeUndefined();
    expect(harnessFactsOf({ harness: 7, pid: 1, logOffset: 0 })).toBeUndefined();
  });

  it("isPiFacts narrows the union to pi's shape; factsBelongTo is the seam's one comparison of a row's harness with the object's name", () => {
    expect(isPiFacts(piFactsIn())).toBe(true);
    expect(isPiFacts(OPENCODE_FACTS)).toBe(false);
    expect(factsBelongTo(new PiHarness(), piFactsIn())).toBe(true);
    expect(factsBelongTo(new PiHarness(), OPENCODE_FACTS)).toBe(false);
    expect(factsBelongTo({ name: "opencode" }, OPENCODE_FACTS)).toBe(true);
  });
});

describe("PiHarness — pi as the contract's object", () => {
  it("declares pi's name, history, disposition table, effort map and built-in tools: the tables the loop and the bridge already read", () => {
    const pi = new PiHarness();
    expect(pi.name).toBe("pi");
    expect(pi.history).toBe("authored-session");
    expect(pi.dispositions).toBe(PI_EVENT_DISPOSITION);
    for (const tier of ["low", "medium", "high", "xhigh", "max"] as const)
      expect(pi.effort(tier)).toBe(piThinkingLevel(tier));
    expect(pi.effort(undefined)).toBeUndefined();
    for (const identity of ["write", "read", "none"] as const)
      expect(pi.builtinTools(identity)).toEqual(piBuiltinToolsFor(identity));
  });

  it("open is runPiHarnessOpen: a scripted run through either door writes the same run events, ledger steps, row facts and container files, and answers the same", async () => {
    const direct = world();
    const viaObject = world();
    const a = await runPiHarnessOpen(direct.deps, direct.run);
    await a.end();
    const b = await new PiHarness().open(viaObject.deps, viaObject.run);
    await b.end();
    expect(b.answer).toBe("All green.");
    expect(a.answer).toBe(b.answer);
    expect(viaObject.events).toEqual(direct.events);
    expect(viaObject.steps).toEqual(direct.steps);
    expect(viaObject.facts).toEqual(direct.facts);
    expect(viaObject.notes).toEqual(direct.notes);
    expect([...viaObject.container.files.entries()]).toEqual([...direct.container.files.entries()]);
    // The stream compared has substance: pi's shell call and its result, the mirrored steps, the facts with the count.
    expect(direct.events.map((e) => e.type)).toEqual(expect.arrayContaining(["tool_call", "tool_result"]));
    expect(direct.steps.length).toBeGreaterThan(0);
    expect(direct.facts[0]).toMatchObject({
      harness: "pi",
      pid: 4242,
      relaunches: 0,
      bearerHash: bearerHashOf(BEARER),
    });
  });

  it("open carries the deployment's compaction thresholds into pi's settings; without them the settings file is what the loop writes on its own", async () => {
    const thresholds = { reserveTokens: 1000, keepRecentTokens: 200 };
    const modelStreamTimeoutMs = agent.maxMinutes * 60_000;
    const w = world();
    const s = await new PiHarness({ compaction: thresholds }).open(w.deps, w.run);
    await s.end();
    expect(w.container.files.get(`${paths.agentDir}/settings.json`)).toBe(
      piSettingsJson(thresholds, modelStreamTimeoutMs),
    );
    const plain = world();
    const t = await new PiHarness().open(plain.deps, plain.run);
    await t.end();
    expect(plain.container.files.get(`${paths.agentDir}/settings.json`)).toBe(
      piSettingsJson(undefined, modelStreamTimeoutMs),
    );
  });

  it("find holds foreign or sampled-absent original custody and preserves alive-here observations", async () => {
    const pi = new PiHarness();
    const c = new WatchedContainer();
    await expect(pi.find(piFactsIn("vm-old"), c)).rejects.toThrow(/original pi producer/);
    expect(c.asked).toEqual(["identity"]);
    await c.start({ paths, command: "pi", args: [], env: {} });
    expect(await pi.find(piFactsIn("vm-fake"), c)).toBe("alive-here");
    expect(await pi.find(piFactsIn(), c)).toBe("alive-here");
    c.die();
    await expect(pi.find(piFactsIn("vm-fake"), c)).rejects.toThrow(/original pi producer/);
    c.vm = undefined;
    await expect(pi.find(piFactsIn("vm-old"), c)).rejects.toThrow(/original pi producer/);
    expect(c.asked.filter((a) => a.startsWith("alive"))).toEqual(["alive 4242", "alive 4242", "alive 4242"]);
  });

  it("find: another harness's facts are another-harness with no container command at all, and end leaves them alone too", async () => {
    const pi = new PiHarness();
    const c = new WatchedContainer();
    expect(await pi.find(OPENCODE_FACTS, c)).toBe("another-harness");
    await pi.end(OPENCODE_FACTS, c);
    expect(c.asked).toEqual([]);
    expect(c.killed).toEqual([]);
    expect(c.removed).toEqual([]);
  });

  it("end kills the pid and removes the root the facts name; a row without a root ends the pid alone; an unconfirmed remove propagates to the original owner", async () => {
    const pi = new PiHarness();
    const c = new FakeHarnessContainer();
    await pi.end({ harness: "pi", pid: 777, logOffset: 10, root: "/tmp/switchboard-pi-old", relaunches: 0 }, c);
    expect(c.killed).toEqual([777]);
    expect(c.removed).toEqual(["/tmp/switchboard-pi-old"]);
    const d = new FakeHarnessContainer();
    await pi.end({ harness: "pi", pid: 778, logOffset: 10, relaunches: 0 }, d);
    expect(d.killed).toEqual([778]);
    expect(d.removed).toEqual([]);
    const e = new FakeHarnessContainer();
    e.failNext = { operation: "remove", error: new Error("rm: refused") };
    await expect(pi.end({ harness: "pi", pid: 1, logOffset: 0, root: "/tmp/x", relaunches: 0 }, e)).rejects.toThrow(
      "rm: refused",
    );
    expect(e.killed).toEqual([1]);
  });

  it("open refuses another harness's facts before anything is filed, started or registered: a harness_error note says so, HarnessMismatchError names both harnesses, and the container saw no command", async () => {
    const w = world({
      resume: {
        messages: [],
        settlements: [],
        remainingMs: 20 * 60_000,
        turn: 0,
        inboxConsumedSeq: 0,
        facts: OPENCODE_FACTS,
      },
    });
    const err = await new PiHarness().open(w.deps, w.run).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessMismatchError);
    // pi's own defence behind the loop's refusal, and an interruption in the seam's vocabulary.
    expect(err).toBeInstanceOf(HarnessInterruptedError);
    expect(err).toMatchObject({
      expected: "pi",
      found: "opencode",
      reason: "the row's harness facts are opencode's, not pi's; restarting from the request",
      refusal: "harness_mismatch",
    });
    const message =
      "the run's row carries opencode harness facts and this run is driven by pi: nothing of that process is judged or ended here; the run restarts from its request";
    expect((err as Error).message).toBe(message);
    expect(w.events).toEqual([{ type: "run_note", kind: "harness_error", summary: message, at: NOW }]);
    expect(w.notes).toEqual([message]);
    expect(w.container.starts).toEqual([]);
    expect(w.container.files.size).toBe(0);
    expect(w.container.killed).toEqual([]);
    expect(w.registry.get("run-7")).toBeUndefined();
    expect(w.facts).toEqual([]);
  });

  it("relaunches and a key this build does not know survive a parse-and-rewrite round trip: a re-attached pi's every save carries the row's count and the key, and an unconfirmed restart retains the original facts", async () => {
    // The re-attach: pi alive at the recorded root under the row's bearer.
    const row = harnessFactsOf({
      pid: 4242,
      logOffset: 0,
      root: paths.dir,
      bearerHash: bearerHashOf(BEARER),
      wire: "anthropic-messages",
      container: "vm-fake",
      relaunches: 2,
      futureField: "kept",
    })!;
    const reattach = world({
      resume: { messages: [], settlements: [], remainingMs: 20 * 60_000, turn: 0, inboxConsumedSeq: 0, facts: row },
      provider: textOnlyProvider(),
    });
    // The previous generation's pi, still alive: started as the harness starts one, so the scripted double reads its run and model off the start.
    await reattach.container.start({
      paths,
      command: "pi",
      args: ["--tools", "read,bash,edit,write,grep,find,ls,update_status", "--model", "claude-fable-5:high"],
      env: { SWITCHBOARD_RUN_ID: "run-7" },
    });
    const s = await new PiHarness().open(reattach.deps, reattach.run);
    expect(s.answer).toBe("picked up where I left off");
    await s.end();
    expect(reattach.container.starts).toHaveLength(1); // no second pi
    expect(reattach.facts.length).toBeGreaterThan(0);
    for (const f of reattach.facts) expect(f).toMatchObject({ harness: "pi", relaunches: 2, futureField: "kept" });
    // Sampled absence does not authorize replacing the original record.
    const restart = world({
      resume: {
        messages: [],
        settlements: [],
        remainingMs: 20 * 60_000,
        turn: 0,
        inboxConsumedSeq: 0,
        facts: harnessFactsOf({ pid: 4242, logOffset: 0, root: paths.dir, relaunches: 1 })!,
      },
    });
    await expect(new PiHarness().open(restart.deps, restart.run)).rejects.toBeInstanceOf(HarnessEndingUnconfirmedError);
    expect(restart.container.starts).toEqual([]);
    expect(restart.container.removed).toEqual([]);
    expect(restart.facts).toEqual([]);
  });
});

describe("openThroughSeam — the seam's door", () => {
  /** A harness of nothing but a recording `open`: the door's own behaviour is what is under test. */
  function stubHarness(open: Harness["open"]): Harness {
    return {
      name: "pi",
      history: "authored-session",
      dispositions: {},
      effort: () => undefined,
      builtinTools: () => [],
      open,
      find: async () => "dead",
      end: async () => {},
    };
  }

  it("refuses a resume whose facts another harness wrote before the harness is asked anything: a harness_error note and a progress line say so, HarnessMismatchError names both harnesses, and open is never called", async () => {
    const opened: HarnessRun[] = [];
    const harness = stubHarness(async (_deps, run) => {
      opened.push(run);
      throw new Error("unreachable: the door must refuse first");
    });
    const w = world({
      resume: {
        messages: [],
        settlements: [],
        remainingMs: 20 * 60_000,
        turn: 0,
        inboxConsumedSeq: 0,
        facts: OPENCODE_FACTS,
      },
    });
    const err = await openThroughSeam(harness, w.deps, w.run).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessMismatchError);
    expect(err).toMatchObject({ expected: "pi", found: "opencode" });
    expect(opened).toEqual([]);
    const message = (err as Error).message;
    expect(w.events).toEqual([{ type: "run_note", kind: "harness_error", summary: message }]);
    expect(w.notes).toEqual([message]);
    expect(w.container.starts).toEqual([]);
  });

  it("opens the run on the harness otherwise, handing deps and run through untouched, a resume of the harness's own facts included", async () => {
    const seen: [HarnessDeps, HarnessRun][] = [];
    const session = { answer: "opened", followUp: async () => "", remainingMs: () => 20 * 60_000, end: async () => {} };
    const harness = stubHarness(async (deps, run) => {
      seen.push([deps, run]);
      return session;
    });
    const fresh = world();
    expect(await openThroughSeam(harness, fresh.deps, fresh.run)).toBe(session);
    const own = world({
      resume: {
        messages: [],
        settlements: [],
        remainingMs: 20 * 60_000,
        turn: 0,
        inboxConsumedSeq: 0,
        facts: piFactsIn(),
      },
    });
    expect(await openThroughSeam(harness, own.deps, own.run)).toBe(session);
    expect(seen).toEqual([
      [fresh.deps, fresh.run],
      [own.deps, own.run],
    ]);
    expect(fresh.events).toEqual([]);
    expect(own.events).toEqual([]);
  });
});

// Feature: harness.md — an original recorded producer needs continuation or typed custody.
describe("original pi producer custody", () => {
  it("open holds a known original container before probing an alive peer when current identity is unavailable", async () => {
    const w = world({ provider: textOnlyProvider() });
    await w.container.start({ paths, command: "pi", args: [], env: { SWITCHBOARD_RUN_ID: "run-7" } });
    w.container.vm = undefined;
    let probes = 0;
    const alive = w.container.alive.bind(w.container);
    w.container.alive = async (pid) => {
      probes++;
      return alive(pid);
    };
    w.run.resume = {
      messages: [],
      settlements: [],
      remainingMs: 300000,
      turn: 0,
      inboxConsumedSeq: 0,
      facts: {
        harness: "pi",
        pid: 4242,
        root: paths.dir,
        logOffset: 0,
        relaunches: 0,
        container: "vm-recorded",
        bearerHash: bearerHashOf(BEARER),
      },
    };
    await expect(new PiHarness().open(w.deps, w.run)).rejects.toBeInstanceOf(HarnessEndingUnconfirmedError);
    expect(probes).toBe(0);
    expect(w.container.starts).toHaveLength(1);
    expect(w.container.killed).toEqual([]);
    expect(w.container.removed).toEqual([]);
    expect(w.facts).toEqual([]);
    expect(w.steps).toEqual([]);
  });

  it("find holds a known original container before probing an alive peer when current identity is unavailable", async () => {
    const container = new FakeHarnessContainer();
    container.vm = undefined;
    let probes = 0;
    container.alive = async () => {
      probes++;
      return true;
    };
    await expect(
      new PiHarness().find(
        { harness: "pi", pid: 777, root: paths.dir, logOffset: 0, relaunches: 0, container: "vm-recorded" },
        container,
      ),
    ).rejects.toThrow(/original pi producer/);
    expect(probes).toBe(0);
    expect(container.killed).toEqual([]);
    expect(container.removed).toEqual([]);
  });

  it.each(["absent", "foreign", "missing-root", "wire", "bearer"] as const)(
    "holds an original recorded pi on %s instead of replacing it",
    async (condition) => {
      const driver = piDriver();
      const facts = driver.facts({
        pid: 999,
        container: condition === "foreign" ? "vm-old" : driver.containerWord,
        root: "/tmp/original-recorded-pi",
        bearerHash: bearerHashOf(driver.bearer),
      });
      if (facts.harness !== "pi") throw new Error("expected pi facts");
      if (condition === "missing-root") delete facts.root;
      if (condition === "bearer") delete facts.bearerHash;
      if (condition === "wire") facts.wire = "openai-responses";
      const before = structuredClone(facts);
      const result = await driver.run({
        turns: [{ content: [{ type: "text", text: "must not replace" }], stopReason: "end_turn" }],
        processAliveOnResume: condition !== "absent",
        resume: {
          messages: [{ role: "user", content: [{ type: "text", text: "carry on" }] }],
          settlements: [],
          remainingMs: 300000,
          turn: 0,
          inboxConsumedSeq: 0,
          facts,
        },
      });
      expect(result.outcome.kind).toBe("failed");
      if (result.outcome.kind !== "failed") throw new Error("expected original custody held");
      expect(result.outcome.error).toBeInstanceOf(HarnessEndingUnconfirmedError);
      expect(result.starts).toEqual([]);
      expect(result.killed).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.facts).toEqual([]);
      expect(result.modelCalls).toEqual([]);
      expect(facts).toEqual(before);
    },
  );
});

describe("hosted Review retained session policy", () => {
  it.each(["pi", "opencode"] as const)("holds cached %s policy before any producer effect", async (name) => {
    const original = name === "pi" ? piFactsIn("vm-1") : OPENCODE_FACTS;
    const w = world({
      resume: { messages: [], settlements: [], remainingMs: 60000, turn: 1, inboxConsumedSeq: 0, facts: original },
    });
    w.run.agent = { ...agent, name: "review", identity: "read", toolset: "readonly" };
    w.run.commandPolicy = "hosted-review";
    const before = structuredClone(original);
    const harness = name === "pi" ? new PiHarness() : new OpenCodeHarness();
    await expect(harness.open(w.deps, w.run)).rejects.toBeInstanceOf(HarnessEndingUnconfirmedError);
    expect(w.container.starts).toEqual([]);
    expect(w.container.killed).toEqual([]);
    expect(w.container.removed).toEqual([]);
    expect(w.container.requests).toEqual([]);
    expect(w.facts).toEqual([]);
    expect(original).toEqual(before);
    expect(w.registry.get(w.run.runId)).toBeUndefined();
  });
});

// Causal fixtures for the proposed original logical launch-policy contract.
// These scripted originals do not attest a retained production SDK table.
describe("original hosted policy compatible continuation", () => {
  it.each(["pi", "opencode"] as const)(
    "continues the same %s original with its compatible recorded policy",
    async (name) => {
      const driver = name === "pi" ? piDriver() : openCodeDriver();
      const original = {
        ...driver.facts({ pid: 999, container: driver.containerWord, bearerHash: bearerHashOf(driver.bearer) }),
        sessionPolicy: { version: 1, commandRoute: "hosted-review", identity: "read" } as const,
      };
      const before = structuredClone(original);
      const result = await driver.run({
        identity: "read",
        commandPolicy: "hosted-review",
        processAliveOnResume: true,
        onFacts: async () => true,
        turns: [{ content: [{ type: "text", text: "continued original review" }], stopReason: "end_turn" }],
        resume: {
          messages: [{ role: "user", content: [{ type: "text", text: "continue the original review" }] }],
          settlements: [],
          remainingMs: 300_000,
          turn: 1,
          inboxConsumedSeq: 0,
          facts: original,
        },
      });
      expect(result.outcome).toEqual({ kind: "answered", answer: "continued original review" });
      expect(result.starts).toEqual([]);
      expect(result.facts[0]).toMatchObject({
        pid: original.pid,
        root: original.root,
        bearerHash: original.bearerHash,
        sessionPolicy: original.sessionPolicy,
      });
      expect(original).toEqual(before);
    },
  );
});

describe("original hosted policy uncertainty remains held", () => {
  it.each(["pi", "opencode"] as const)(
    "retains %s originals on missing, malformed or incompatible policy without current-label upgrade",
    async (name) => {
      for (const sessionPolicy of [
        undefined,
        { version: 0, commandRoute: "hosted-review", identity: "read" },
        { version: 1, commandRoute: "unknown", identity: "read" },
        { version: 1, commandRoute: "native", identity: "read" },
        { version: 1, commandRoute: "hosted-review", identity: "write" },
        { version: 1, commandRoute: "hosted-review", identity: "read", upgrade: true },
      ]) {
        const facts = {
          ...(name === "pi" ? piFactsIn("vm-1") : OPENCODE_FACTS),
          ...(sessionPolicy === undefined ? {} : { sessionPolicy }),
        };
        const before = structuredClone(facts);
        const w = world({
          resume: {
            messages: [],
            settlements: [],
            remainingMs: 60_000,
            turn: 1,
            inboxConsumedSeq: 0,
            facts: facts as unknown as HarnessFacts,
          },
        });
        w.run.agent = { ...agent, name: "review", identity: "read", toolset: "readonly" };
        w.run.commandPolicy = "hosted-review";
        const harness = name === "pi" ? new PiHarness() : new OpenCodeHarness();
        await expect(harness.open(w.deps, w.run)).rejects.toBeInstanceOf(HarnessEndingUnconfirmedError);
        expect(w.container.starts).toEqual([]);
        expect(w.container.killed).toEqual([]);
        expect(w.container.removed).toEqual([]);
        expect(w.container.requests).toEqual([]);
        expect(w.facts).toEqual([]);
        expect(facts).toEqual(before);
      }
    },
  );
});

describe("original session policy canonical first-fact ACK", () => {
  it.each(["pi", "opencode"] as const)(
    "holds the newly started %s producer on an unknown ACK before any model turn",
    async (name) => {
      const driver = name === "pi" ? piDriver() : openCodeDriver();
      const result = await driver.run({
        identity: "read",
        commandPolicy: "hosted-review",
        onFacts: async () => false,
        turns: [{ content: [{ type: "text", text: "must not enter model" }], stopReason: "end_turn" }],
      });
      expect(result.outcome.kind).toBe("failed");
      if (result.outcome.kind !== "failed") throw new Error("expected unknown original policy held");
      expect(result.outcome.error).toBeInstanceOf(HarnessEndingUnconfirmedError);
      // Dispatch records openingError after one custody-wrapper unwrap.
      expect((result.outcome.error as HarnessEndingUnconfirmedError).openingError).toMatchObject({
        name: "HarnessContainerError",
        operation: "checkpoint",
        message: "harness container: checkpoint failed — The original session policy checkpoint was not acknowledged.",
      });
      expect(result.modelCalls).toEqual([]);
      expect(result.starts).toHaveLength(1);
      expect(result.killed).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.facts[0]).toMatchObject({
        sessionPolicy: { version: 1, commandRoute: "hosted-review", identity: "read" },
      });
    },
  );
  it.each(["pi", "opencode"] as const)(
    "a foreign %s custody error cannot replace the current run's identity",
    async (name) => {
      const driver = name === "pi" ? piDriver() : openCodeDriver();
      const opening = new Error("foreign opening");
      const ending = new Error("foreign ending");
      const foreign = new HarnessEndingUnconfirmedError("foreign-run", opening, ending);
      const result = await driver.run({
        identity: "read",
        commandPolicy: "hosted-review",
        onFacts: async () => {
          throw foreign;
        },
        turns: [{ content: [{ type: "text", text: "must not enter model" }], stopReason: "end_turn" }],
      });
      if (result.outcome.kind !== "failed") throw new Error("expected held error");
      expect(result.outcome.error).toBeInstanceOf(HarnessEndingUnconfirmedError);
      const error = result.outcome.error as HarnessEndingUnconfirmedError;
      expect(error).not.toBe(foreign);
      expect(error.runId).not.toBe("foreign-run");
      expect(error.openingError).toBe(foreign);
      expect(error.endingError).toBe(foreign);
      expect(foreign.openingError).toBe(opening);
      expect(foreign.endingError).toBe(ending);
      expect(result.modelCalls).toEqual([]);
      expect(result.killed).toEqual([]);
      expect(result.removed).toEqual([]);
    },
  );
  it.each(["pi", "opencode"] as const)(
    "holds the actual started %s producer when the original facts save throws",
    async (name) => {
      const driver = name === "pi" ? piDriver() : openCodeDriver();
      const original = new Error("actual facts transport error");
      const result = await driver.run({
        identity: "read",
        commandPolicy: "hosted-review",
        onFacts: async () => {
          throw original;
        },
        turns: [{ content: [{ type: "text", text: "must not enter model" }], stopReason: "end_turn" }],
      });
      expect(result.outcome.kind).toBe("failed");
      if (result.outcome.kind !== "failed") throw new Error("expected original save error held");
      expect(result.outcome.error).toBeInstanceOf(HarnessEndingUnconfirmedError);
      expect(result.outcome.error.cause).toBe(original);
      expect(result.modelCalls).toEqual([]);
      expect(result.killed).toEqual([]);
      expect(result.removed).toEqual([]);
    },
  );
  it.each(["pi", "opencode"] as const)(
    "records the actual %s launch policy with a known ACK before model entry",
    async (name) => {
      const driver = name === "pi" ? piDriver() : openCodeDriver();
      const committed: HarnessFacts[] = [];
      const result = await driver.run({
        identity: "read",
        commandPolicy: "hosted-review",
        onFacts: async (facts, control) => {
          if (control?.requireAcknowledgement) committed.push(structuredClone(facts));
          return true;
        },
        turns: [{ content: [{ type: "text", text: "fresh original review" }], stopReason: "end_turn" }],
      });
      expect(result.outcome).toEqual({ kind: "answered", answer: "fresh original review" });
      expect(committed).toHaveLength(1);
      expect(committed[0]).toMatchObject({
        sessionPolicy: { version: 1, commandRoute: "hosted-review", identity: "read" },
      });
      expect(result.modelCalls).toHaveLength(1);
    },
  );
});

describe("original facts ACK cancellation admission", () => {
  it.each(["pi", "opencode"] as const)(
    "does not admit a %s model after hard stop during the first facts ACK",
    async (name) => {
      const driver = name === "pi" ? piDriver() : openCodeDriver();
      const control = new RunControl();
      let confirmed = 0;
      const result = await driver.run({
        identity: "read",
        commandPolicy: "hosted-review",
        control,
        onFacts: async (_facts, save) => {
          if (save?.requireAcknowledgement) {
            confirmed++;
            control.requestStop("hard");
          }
          return true;
        },
        turns: [{ content: [{ type: "text", text: "must not enter model" }], stopReason: "end_turn" }],
      });
      expect(confirmed).toBe(1);
      expect(result.modelCalls).toEqual([]);
    },
  );
});
