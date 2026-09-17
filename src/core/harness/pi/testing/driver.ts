// pi's driver for the conformance table (docs/reference/specs/harness.md item
// 11): a run over the fake container with pi scripted from the row's model
// turns (`scriptPiFromProvider`), opened through `PiHarness` — the object the
// run loop holds — with the sinks recorded, so a row reads exactly what the
// record would hold. Nothing here is the row's business: the row reads the
// `DrivenRun` and the driver is what changes for another harness.

import { loopClock, MINUTE_MS } from "../../../budgets.js";
import type { AgentDef, Identity } from "../../../../agents/registry.js";
import type { Executor } from "../../../../execution/executor.js";
import { updateStatusTool } from "../../../../tools/status.js";
import type { CompletionRequest, CompletionResult, Provider } from "../../../provider.js";
import type { RunEvent } from "../../../runEvents.js";
import type { StepReport } from "../../../runLedger/stepReport.js";
import { RunControl } from "../../../runRegistry/runControl.js";
import { FollowUpInbox } from "../../../threadAdmission.js";
import { openThroughSeam, type HarnessDeps, type HarnessFacts, type HarnessRun } from "../../contract.js";
import { HarnessContainerRuntimeReplacedError } from "../../container.js";
import { FakeHarnessContainer } from "../../testing/fakeContainer.js";
import {
  CONFORMANCE_MAX_MINUTES,
  FAILED_MODEL_CALL_ERROR,
  type DrivenRun,
  type HarnessDriver,
  type RunScript,
} from "../../testing/scenarios.js";
import { PiHarness } from "../piHarness.js";
import { piRunPaths } from "../process.js";
import { HarnessRegistry } from "../relay.js";
import { scriptPiFromProvider, type ProviderPi } from "./providerPi.js";

const RUN_ID = "run-c";
/** The bearer every conformance run is started with: the proxy's shape, a secret a row can look for. */
const BEARER = "sbr_run-c.conformance-secret-no-row-may-carry";
const CONTAINER_WORD = "vm-conformance";
/** The word the container answers after it is replaced under the run, so the
 *  replaced verdict's `was`/`now` are two distinct words. */
const REPLACED_WORD = "vm-conformance-2";
/** The bot's own provider-key variables, planted with a sentinel for the run's
 *  duration: a harness that forwards the bot's key to its process forwards the
 *  sentinel, and the credential row finds it in the process's environment. */
const PROVIDER_KEY_ENVS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"] as const;
const PROVIDER_KEY_SENTINEL = "provider-key-sentinel-no-harness-may-forward";

/** Plants the sentinel; the answer restores what was there. */
function plantProviderKeys(): () => void {
  const saved = PROVIDER_KEY_ENVS.map((k) => [k, process.env[k]] as const);
  for (const k of PROVIDER_KEY_ENVS) process.env[k] = PROVIDER_KEY_SENTINEL;
  return () => {
    for (const [k, v] of saved)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  };
}
const NOW = 1_700_000_000_000;

const agentFor = (identity: Identity): AgentDef => ({
  name: "conformance",
  description: "",
  system: "You are the conformance run.",
  toolset: "full",
  machine: identity === "none" ? "none" : "repo-resident",
  identity,
  maxTurns: 50,
  maxTokens: 4096,
  maxMinutes: CONFORMANCE_MAX_MINUTES,
});

/** The run's executor, as pi's own tools run over it in the scripted double: every command answers, every file is empty. */
const executor: Executor = {
  exec: async (command) => `ran: ${command}`,
  readFile: async () => "",
  writeFile: async () => "",
};

/** The model, replaying the row's turns in order and recording every request;
 *  the call numbered `failAt` (1-based) fails with the provider's words instead,
 *  which the scripted pi settles the turn on as pi does a failed call. */
function replaying(
  turns: RunScript["turns"],
  failAt: number | undefined,
): { provider: Provider; requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  let calls = 0;
  const provider: Provider = {
    name: "conformance",
    async complete(req) {
      requests.push(req);
      calls++;
      if (calls === failAt) throw new Error(FAILED_MODEL_CALL_ERROR);
      const turn = turns[Math.min(calls - 1, turns.length - 1)];
      const result: CompletionResult = { content: turn.content, stopReason: turn.stopReason ?? "end_turn" };
      return result;
    },
  };
  return { provider, requests };
}

export function piDriver(): HarnessDriver {
  const object = new PiHarness();
  return {
    harness: "pi",
    object,
    bearer: BEARER,
    containerWord: CONTAINER_WORD,
    providerKeySentinel: PROVIDER_KEY_SENTINEL,
    facts: (partial) => ({
      harness: "pi",
      pid: partial.pid,
      logOffset: 0,
      root: partial.root ?? piRunPaths(RUN_ID).dir,
      relaunches: 0,
      ...(partial.container !== undefined ? { container: partial.container } : {}),
      ...(partial.bearerHash !== undefined ? { bearerHash: partial.bearerHash } : {}),
    }),
    async find(facts, containerWord) {
      const container = new FakeHarnessContainer();
      container.vm = containerWord === null ? undefined : (containerWord ?? CONTAINER_WORD);
      return object.find(facts, container);
    },
    async run(script) {
      const identity = script.identity ?? "write";
      const agent = agentFor(identity);
      /** The run's clock: fixed, until a script spends the budget under a model call. */
      const clock = { now: NOW };
      const container = new FakeHarnessContainer();
      container.vm = script.containerWord === null ? undefined : (script.containerWord ?? CONTAINER_WORD);
      // The row's pi is still alive in this container on the resume (the
      // survival clause's alive-here): its pid answers `alive` before anything
      // is started, so `open` finds it and reconciles with it.
      if (script.processAliveOnResume && script.resume?.facts) container.alivePids.add(script.resume.facts.pid);
      const registry = new HarnessRegistry();
      const control = new RunControl();
      const inbox = new FollowUpInbox();
      if (script.followUp !== undefined) inbox.push({ text: script.followUp, userId: "user:conformance", at: NOW });
      const events: RunEvent[] = [];
      const steps: StepReport[] = [];
      const facts: HarnessFacts[] = [];
      const progress: string[] = [];
      const statusReports: string[] = [];
      const model = replaying(script.turns, script.failModelCall);
      let modelCalls = 0;
      const pi: ProviderPi = scriptPiFromProvider(container, {
        provider: model.provider,
        registry,
        // A real pi's model call takes time, during which the harness ticks:
        // drains the inbox, checks the stops. A few real milliseconds stand in.
        beforeModelCall: async () => {
          modelCalls++;
          if (script.hardStopBeforeModelCall === modelCalls) control.requestStop("hard");
          if (script.budgetBeforeModelCall === modelCalls) {
            // The wall clock runs out with this call under way: pi has opened
            // the turn (read off the log first, so the budget note finds the
            // call in flight and not the tool before it), then the harness's
            // tick notes the budget and steers the write-up before the call
            // answers — waited for, as the hard stop waits for its abort.
            await new Promise((r) => setTimeout(r, 15));
            // The clock lands past the LOOP's end, inside the lease: the
            // write-up that follows runs within the lease, as the row asserts.
            clock.now = loopClock(NOW, agent.maxMinutes * MINUTE_MS, agent.name).loopEnd + 1;
            const steersBefore = pi.steers.length;
            for (let i = 0; i < 200 && pi.steers.length === steersBefore; i++)
              await new Promise((r) => setTimeout(r, 5));
          }
          await new Promise((r) => setTimeout(r, 15));
        },
        // The container is replaced under the run with this call in flight (the
        // survival clause's ceiling), as the fake serve replaces it under
        // OpenCode's: the call stays open — the gate decided it, the tool
        // started, its result never comes — the container renames itself, and
        // the next read of the drained log fails with the executor's word, so
        // the harness reads the verdict with the words to corroborate it and
        // settles the open call with the replaced note. The 1-based model call
        // that would carry this call's result is `containerReplacedBeforeModelCall`,
        // so the call is the turn before it.
        holdCallOpen: ({ turn }) => {
          if (script.containerReplacedBeforeModelCall === turn + 1) {
            container.vm = REPLACED_WORD;
            container.failOnceDrained = new HarnessContainerRuntimeReplacedError(
              "read",
              "runtime-replaced: the sandbox was replaced under the run",
            );
            return true;
          }
          // The platform's rollout (`deadWithoutWordBeforeModelCall`): pi is
          // killed first while exec still answers, so the alive probe finds it
          // gone with this call open and no read has failed with the word; what
          // the harness's one more command finds is the script's.
          if (script.deadWithoutWordBeforeModelCall === turn + 1) {
            container.dieWithoutWord(script.deadWithoutWordThen ?? "word", REPLACED_WORD);
            return true;
          }
          return false;
        },
        ...(script.bypassGate ? { bypassGate: true } : {}),
        ...(script.unknownEventKind !== undefined ? { emitUnknownKind: script.unknownEventKind } : {}),
      });
      const run: HarnessRun = {
        runId: RUN_ID,
        agent,
        model: { id: "claude-fable-5", provider: "anthropic", providerType: "anthropic" },
        system: "You are the conformance run.",
        messages: [
          ...(script.seed ?? []),
          { role: "user", content: [{ type: "text", text: script.request ?? "do the thing" }] },
        ],
        tools: script.relayed ?? [updateStatusTool],
        toolContext: { executor, reportProgress: (list) => void statusReports.push(list) },
        rules: { checkout: "/workspace/threads/t/main", protectedBranches: ["main"] },
        control,
        inbox,
        onEvent: (e) => void events.push(e),
        onProgress: (n) => void progress.push(n),
        onStep: async (r) => void steps.push(r),
        saveFacts: (f) => void facts.push(f),
        ...(script.resume ? { resume: script.resume } : {}),
      };
      const deps: HarnessDeps = {
        container,
        bearer: BEARER,
        harnessUrl: "https://bot.example.com",
        registry,
        clock: () => clock.now,
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
        pollMs: 1,
        tickMs: 5,
      };
      let outcome: DrivenRun["outcome"];
      const restore = plantProviderKeys();
      try {
        // The seam's door, as the run loop opens every run: the refusal of a
        // foreign row is the seam's, not the object's.
        const session = await openThroughSeam(object, deps, run);
        outcome = { kind: "answered", answer: session.answer };
        await session.end();
      } catch (err) {
        outcome = { kind: "failed", error: err instanceof Error ? err : new Error(String(err)) };
      } finally {
        restore();
      }
      return {
        harness: "pi",
        outcome,
        events,
        steps,
        facts,
        progress,
        starts: container.starts,
        killed: container.killed,
        removed: container.removed,
        requests: container.requests,
        modelCalls: model.requests,
        statusReports,
      };
    },
  };
}
