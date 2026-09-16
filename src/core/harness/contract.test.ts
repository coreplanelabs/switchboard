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
  HarnessInterruptedError,
  HarnessMismatchError,
  harnessFactsOf,
  isPiFacts,
  openThroughSeam,
  type HarnessDeps,
  type Harness,
  type HarnessFacts,
  type HarnessRun,
  type OpenCodeHarnessFacts,
  type PiHarnessFacts,
} from "./contract.js";
import { PI_EVENT_DISPOSITION } from "./pi/bridge.js";
import { runPiHarnessOpen } from "./pi/harness.js";
import { PiHarness } from "./pi/piHarness.js";
import { piBuiltinToolsFor, piRunPaths, piSettingsJson, piThinkingLevel } from "./pi/process.js";
import { HarnessRegistry } from "./pi/relay.js";
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
    finaleTimeoutMs: 60_000,
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

describe("harnessFactsOf — a row's facts, read by the harness that wrote them", () => {
  it("a row naming pi, and a row from before the discriminator, are pi's: the known fields read by type, relaunches 0 when absent or malformed, a field of the wrong type dropped, an unknown key kept", () => {
    const full = {
      harness: "pi",
      pid: 7,
      logOffset: 120,
      sessionFile: "s.jsonl",
      root: "/tmp/switchboard-pi-run-7",
      bearerHash: "h",
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
    const w = world();
    const s = await new PiHarness({ compaction: thresholds }).open(w.deps, w.run);
    await s.end();
    expect(w.container.files.get(`${paths.agentDir}/settings.json`)).toBe(piSettingsJson(thresholds));
    const plain = world();
    const t = await new PiHarness().open(plain.deps, plain.run);
    await t.end();
    expect(plain.container.files.get(`${paths.agentDir}/settings.json`)).toBe(piSettingsJson());
  });

  it("find: a row naming another container is another-container with no pid probed; this container's word, or none, or a container that cannot name itself, probes the pid — alive-here while pi runs, dead once it exited", async () => {
    const pi = new PiHarness();
    const c = new WatchedContainer();
    expect(await pi.find(piFactsIn("vm-old"), c)).toBe("another-container");
    expect(c.asked).toEqual(["identity"]);
    await c.start({ paths, command: "pi", args: [], env: {} });
    expect(await pi.find(piFactsIn("vm-fake"), c)).toBe("alive-here");
    expect(await pi.find(piFactsIn(), c)).toBe("alive-here");
    c.die();
    expect(await pi.find(piFactsIn("vm-fake"), c)).toBe("dead");
    c.vm = undefined;
    expect(await pi.find(piFactsIn("vm-old"), c)).toBe("dead");
    expect(c.asked.filter((a) => a.startsWith("alive"))).toEqual([
      "alive 4242",
      "alive 4242",
      "alive 4242",
      "alive 4242",
    ]);
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

  it("end kills the pid and removes the root the facts name; a row without a root ends the pid alone; a remove that fails is swallowed, like the session's own end", async () => {
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
    await expect(
      pi.end({ harness: "pi", pid: 1, logOffset: 0, root: "/tmp/x", relaunches: 0 }, e),
    ).resolves.toBeUndefined();
    expect(e.killed).toEqual([1]);
  });

  it("open refuses another harness's facts before anything is filed, started or registered: a harness_error note says so, HarnessMismatchError names both harnesses, and the container saw no command", async () => {
    const w = world({
      resume: {
        messages: [],
        settlements: [],
        remainingMs: 60_000,
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

  it("relaunches and a key this build does not know survive a parse-and-rewrite round trip: a re-attached pi's every save carries the row's count and the key, and a pi restarted on the transcript keeps the count", async () => {
    // The re-attach: pi alive at the recorded root under the row's bearer.
    const row = harnessFactsOf({
      pid: 4242,
      logOffset: 0,
      root: paths.dir,
      bearerHash: bearerHashOf(BEARER),
      container: "vm-fake",
      relaunches: 2,
      futureField: "kept",
    })!;
    const reattach = world({
      resume: { messages: [], settlements: [], remainingMs: 60_000, turn: 0, inboxConsumedSeq: 0, facts: row },
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
    // The restart on the transcript: pi dead, a fresh pi under this build's root, the count carried.
    const restart = world({
      resume: {
        messages: [],
        settlements: [],
        remainingMs: 60_000,
        turn: 0,
        inboxConsumedSeq: 0,
        facts: harnessFactsOf({ pid: 4242, logOffset: 0, root: paths.dir, relaunches: 1 })!,
      },
    });
    const t = await new PiHarness().open(restart.deps, restart.run);
    await t.end();
    expect(restart.container.starts).toHaveLength(1);
    expect(restart.facts[0]).toMatchObject({ harness: "pi", pid: 4242, logOffset: 0, relaunches: 1 });
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
        remainingMs: 60_000,
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
    const session = { answer: "opened", followUp: async () => "", end: async () => {} };
    const harness = stubHarness(async (deps, run) => {
      seen.push([deps, run]);
      return session;
    });
    const fresh = world();
    expect(await openThroughSeam(harness, fresh.deps, fresh.run)).toBe(session);
    const own = world({
      resume: { messages: [], settlements: [], remainingMs: 60_000, turn: 0, inboxConsumedSeq: 0, facts: piFactsIn() },
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
