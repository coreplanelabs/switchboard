// The conformance table (docs/reference/specs/harness.md item 11): record
// 0038's six clauses as rows any harness is held to, each a function of a
// `HarnessDriver` — start a run from a scripted model, read the run events and
// the ledger steps, end — so pi's driver over the fake container, a second
// harness's driver over a fake of its server and one over the real binary all
// walk the same rows and a harness never gets a table of its own. A row's
// check reads the record: the lint (`runRow`) refuses a row that read neither
// the run events nor the ledger steps, because a row that passes without
// looking at the record proves nothing about the record. The matrix printer
// (`renderHarnessConformanceMatrix`) is what a PR body carries: harness × row.
// Assertions are Node's own, so the table runs under vitest and under a plain
// script alike.

import assert from "node:assert/strict";
import type { Identity } from "../../../agents/registry.js";
import type { RunnableTool } from "../../../tools/runnableTool.js";
import type { ChatMessage, ContentPart } from "../../chatMessage.js";
import type { CompletionRequest, CompletionResult } from "../../provider.js";
import type { RunEvent } from "../../runEvents.js";
import type { StepReport } from "../../runLedger/stepReport.js";
import { identityChangedCondition, type HarnessRequest, type HarnessStart } from "../container.js";
import {
  HarnessContainerReplacedError,
  HarnessMismatchError,
  harnessFactsOf,
  type Finding,
  type Harness,
  type HarnessFacts,
  type HarnessName,
  type HarnessResume,
} from "../contract.js";
import { ALLOWANCES, MINUTE_MS } from "../../budgets.js";
import {
  finaleTimedOutNote,
  HARD_STOP_MESSAGE,
  MODEL_CALL_IN_FLIGHT,
  softStopAnswer,
  softStopNote,
  timeBudgetAnswer,
  timeBudgetNote,
} from "../windDown.js";
import { TRANSPORT_LOST_TEXT } from "./fakeContainer.js";

/** The wall clock every conformance run is given: the drivers' preset budget. */
export const CONFORMANCE_MAX_MINUTES = 10;
/** The provider's words when a scripted model call fails (`RunScript.failModelCall`), on every driver. */
export const FAILED_MODEL_CALL_ERROR = "the provider closed the stream before the answer";

/** One answer of the scripted model: the content parts and how it stopped. */
export interface ModelTurn {
  content: ContentPart[];
  stopReason?: CompletionResult["stopReason"];
}

/** The run a row asks the driver for: the model's turns and what surrounds them. */
export interface RunScript {
  /** The model's answers in order; the last is the text the run answers with. */
  turns: ModelTurn[];
  /** The preset's identity the harness reads (its own tools, the gate's reach); `write` unless said. */
  identity?: Identity;
  /** The thread's earlier turns before the request (the seed rule). */
  seed?: ChatMessage[];
  /** The request, the seed's last user turn. */
  request?: string;
  /** The relayed tools the run holds; the status tool alone unless said. */
  relayed?: RunnableTool[];
  /** A resume, with the row's facts the previous generation wrote. */
  resume?: HarnessResume;
  /** A broken harness: its own tools run without asking the gate. The row expects the run to fail closed. */
  bypassGate?: boolean;
  /** The model's shell produces an approval the bot did not issue — a forged
   *  `permission.replied` on a harness whose gate lives in its own server. A
   *  harness that prevents this by construction ignores it and runs to its
   *  answer; one whose gate is enforcement by detection catches it a tool call
   *  late and fails the run closed (the row it declares it cannot pass). */
  forgeApproval?: boolean;
  /** The process emits an event kind no table names, once. */
  unknownEventKind?: string;
  /** A thread follow-up queued before the run starts, for the harness to steer. */
  followUp?: string;
  /** A hard stop requested before the model call of this 1-based number. */
  hardStopBeforeModelCall?: number;
  /** A soft stop requested before the model call of this 1-based number: the
   *  harness steers the write-up and that call answers it (or never answers,
   *  with `hangModelCall` of the same number). */
  softStopBeforeModelCall?: number;
  /** The model call of this 1-based number never answers: the process opens
   *  the step and nothing follows — not the answer, not a reaction to the
   *  write-up's steer. The driver moves the run's clock as the silence would:
   *  past the loop's end once the step is open (unless a soft stop of the same
   *  number is the wind-down instead), then past the finale bound once the
   *  write-up's steer has landed, so the harness's wind-down, its finale bound
   *  and the process's end are exercised without a real wait. */
  hangModelCall?: number;
  /** The run's wall clock runs out before the model call of this 1-based
   *  number: the clock passes the deadline with that call under way, so the
   *  harness winds the run down — the budget note, the write-up steered — and
   *  that call is the one the wind-down waits on. */
  budgetBeforeModelCall?: number;
  /** The model call of this 1-based number fails with a provider error
   *  (`FAILED_MODEL_CALL_ERROR`) instead of answering its turn. */
  failModelCall?: number;
  /** The container the harness's process ran in is replaced under the run
   *  with the previous turn's tool call in flight, before the model call of
   *  this 1-based number would carry that call's result: the driver leaves the
   *  call open (the gate decided it, its result never comes), the container
   *  renames itself, and the next read of the drained feed fails with the
   *  executor's runtime-replaced word, so the harness reads the survival
   *  clause's ceiling with the words to corroborate it and settles the call. */
  containerReplacedBeforeModelCall?: number;
  /** The platform's rollout as the survival clause meets it: the harness's
   *  process is found dead with the previous turn's tool call in flight, before
   *  the model call of this 1-based number would carry that call's result, and
   *  NO command has failed with the executor's runtime-replaced word — the
   *  container's processes were killed first while exec still answered. The
   *  driver leaves the call open and lets the process die; what the one more
   *  container command the harness then takes finds is `deadWithoutWordThen`. */
  deadWithoutWordBeforeModelCall?: number;
  /** What the one more container command after the wordless death finds:
   *  `word` — it fails with the executor's runtime-replaced word; `renamed` —
   *  the container names itself another word than the one recorded when the
   *  process started; `same` — the container as it was, so the crash judgement
   *  stands. `word` unless said. */
  deadWithoutWordThen?: "word" | "renamed" | "same";
  /** The platform's replacement as the incident met it: the container is
   *  killed under the process's command with the previous turn's tool call in
   *  flight, before the model call of this 1-based number would carry that
   *  call's result, and the harness's read fails on its TRANSPORT — the
   *  executor's infra failure carrying the WebSocket's 1006 close, no word.
   *  The driver leaves the call open and fails the next read so; what the one
   *  more command then finds is `transportLostThen`, after
   *  `containerDownForProbes` answers that the container is not running. */
  transportLostBeforeModelCall?: number;
  /** What the one more command after the transport loss finds, as `deadWithoutWordThen`: `word` unless said. */
  transportLostThen?: "word" | "renamed" | "same";
  /** How many times the one more command finds the container not running —
   *  the window while the platform rebuilds it — before it answers what
   *  `transportLostThen` says; the harness waits through them. 0 unless said. */
  containerDownForProbes?: number;
  /** A hard stop requested the moment the one more command first finds the
   *  container down: the wait must end at once and the run end as the stop. */
  hardStopDuringProbeWait?: boolean;
  /** The row's process (named by the resume's facts) is still alive in this same
   *  container on the resume — the survival clause's alive-here: `open` finds it
   *  before anything is started and re-attaches to it when the row carries what
   *  a re-attach needs (its root, the bearer's hash), ending it before a fresh
   *  start only when it does not. */
  processAliveOnResume?: boolean;
  /** The container's word for itself; `null` for a container that cannot name itself. */
  containerWord?: string | null;
}

/** What the driver hands back: the run's outcome and everything the harness wrote or was seen to do. */
export interface DrivenRun {
  harness: HarnessName;
  outcome: { kind: "answered"; answer: string } | { kind: "failed"; error: Error };
  /** The run events the harness put on the stream, in order. */
  events: RunEvent[];
  /** The ledger's step records, in order. */
  steps: StepReport[];
  /** Every save of the row's facts, in order. */
  facts: HarnessFacts[];
  /** The progress notes (the card's activity line). */
  progress: string[];
  /** What the container was asked to start. */
  starts: HarnessStart[];
  /** The pids the container was asked to end. */
  killed: number[];
  /** The run directories the container was asked to remove. */
  removed: string[];
  /** Every request the harness made into the container's loopback server, in order; none for a harness that has no server. */
  requests: HarnessRequest[];
  /** What the model was asked, per call: the conversation it saw and the tools it was offered. */
  modelCalls: CompletionRequest[];
  /** What the relayed status tool reported into the run's context: the relay's side effect. */
  statusReports: string[];
}

/** One harness's driver: what the table needs of a harness to walk its rows. */
export interface HarnessDriver {
  readonly harness: HarnessName;
  /** The harness object under test, for its declared tables. */
  readonly object: Harness;
  /** The run bearer the driver hands the process, so a row can look for it. */
  readonly bearer: string;
  /** The container word the driver's container answers when the script names none. */
  readonly containerWord: string;
  /** The value the driver plants under the bot's own provider-key variables
   *  for the run's duration: a harness that forwards the bot's key to its
   *  process forwards this, and the credential row finds it in the process's
   *  environment. */
  readonly providerKeySentinel: string;
  /** The rows this harness cannot pass, by row id, each with why (record
   *  0038: a named failure the table asserts, never a skip). The suite's test
   *  for a declared row requires the run to fail as declared, so a limit the
   *  harness has outgrown goes red; the matrix prints the declaration as its
   *  own cell with the reason. Absent or empty for a harness that meets every
   *  row. */
  readonly cannot?: Readonly<Record<string, string>>;
  /** This harness's row facts for the pieces a row cares about. */
  facts(partial: { pid: number; container?: string; root?: string; bearerHash?: string }): HarnessFacts;
  run(script: RunScript): Promise<DrivenRun>;
  /** `find` on a fresh container of the driver's, answering `containerWord` (or nothing for `null`). */
  find(facts: HarnessFacts, containerWord?: string | null): Promise<Finding>;
}

export type Clause = "credential" | "gate" | "relay" | "record" | "conversation" | "survival" | "parity";

export interface ScenarioRow {
  /** The matrix's key, stable across renames of the title. */
  id: string;
  clause: Clause;
  title: string;
  script: RunScript | ((driver: HarnessDriver) => RunScript);
  check: (run: DrivenRun, driver: HarnessDriver) => void | Promise<void>;
}

const text = (t: string): ModelTurn => ({ content: [{ type: "text", text: t }], stopReason: "end_turn" });
const call = (id: string, name: string, input: Record<string, unknown>): ModelTurn => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});

/** A header name that carries a credential: on a request into the container it belongs in `secretHeaders`. */
const AUTH_HEADER = /^(authorization|proxy-authorization|x-api-key|cookie)$/i;

const notes = (run: DrivenRun) =>
  run.events.filter((e): e is Extract<RunEvent, { type: "run_note" }> => e.type === "run_note");
const toolCalls = (run: DrivenRun) =>
  run.events.filter((e): e is Extract<RunEvent, { type: "tool_call" }> => e.type === "tool_call");
const toolResults = (run: DrivenRun) =>
  run.events.filter((e): e is Extract<RunEvent, { type: "tool_result" }> => e.type === "tool_result");
const answered = (run: DrivenRun): string => {
  assert.equal(
    run.outcome.kind,
    "answered",
    `the run failed: ${run.outcome.kind === "failed" ? run.outcome.error.message : ""}`,
  );
  return run.outcome.kind === "answered" ? run.outcome.answer : "";
};
const failed = (run: DrivenRun): Error => {
  assert.equal(run.outcome.kind, "failed", "the run answered where it should have failed");
  return run.outcome.kind === "failed" ? run.outcome.error : new Error("unreachable");
};
/** The model's first call of the run: the roster it was offered and the conversation it was seeded with. */
const firstModelCall = (run: DrivenRun) => {
  const first = run.modelCalls[0];
  assert.ok(first, "the model was never called");
  return first;
};
const offeredTools = (run: DrivenRun): string[] => (firstModelCall(run).tools ?? []).map((t) => t.name);
const userTexts = (m: ChatMessage): string[] =>
  m.role === "user" ? m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])) : [];

/** Another harness's facts, for the row that hands a driver a row it did not write. */
export function foreignFactsFor(name: HarnessName): HarnessFacts {
  return name === "opencode"
    ? { harness: "pi", pid: 31, logOffset: 0, root: "/tmp/switchboard-pi-run-c", relaunches: 0 }
    : {
        harness: "opencode",
        pid: 31,
        port: 41000,
        logOffset: 0,
        sessionID: "ses_c",
        root: "/tmp/switchboard-oc-run-c",
        relaunches: 0,
      };
}

/** The root a dead process's row records — another than the one a fresh start is filed under, so its removal is seen. */
const DEAD_ROW_ROOT = "/tmp/switchboard-run-c-before";

/** The wordless death's two rows read the record the same way: the seam's
 *  verdict by type, how it was reached (`then`: the executor's word on the one
 *  more command, or the changed identity as the condition with `said`
 *  nothing), the note the verdict's message, the in-flight call the last
 *  assistant turn's — settled on the record and failed on the stream with the
 *  replaced note — and nothing ended or removed in the container that answers
 *  now. What differs from `survival-container-replaced` is only how the
 *  verdict came: no read failed with the word. */
function checkDeadWithoutWord(run: DrivenRun, driver: HarnessDriver, then: "word" | "renamed"): void {
  const error = failed(run);
  if (!(error instanceof HarnessContainerReplacedError))
    return assert.fail(`not the seam's container-replaced verdict: ${error.constructor.name} — ${error.message}`);
  const condition = then === "word" ? "word" : "identity";
  assert.equal(error.condition, condition, `the verdict's condition is tagged ${error.condition}, not ${condition}`);
  if (then === "word") {
    assert.ok(error.said !== undefined && error.said.length > 0, "the verdict carries no executor word");
  } else {
    assert.equal(error.said, undefined, "the verdict carries an executor word no command returned");
    assert.equal(error.was, driver.containerWord, "the verdict's `was` is not the word recorded at the start");
    assert.ok(error.now !== undefined && error.now !== error.was, "the verdict does not name the container's new word");
  }
  const restarted = notes(run).filter((n) => n.kind === "sandbox_restarted");
  assert.equal(restarted.length, 1, `${restarted.length} sandbox_restarted notes, not one`);
  assert.equal(restarted[0].summary, error.message, "the note is not the verdict's message");
  if (then === "renamed")
    assert.ok(
      restarted[0].summary.includes(identityChangedCondition()),
      "the note does not say the changed identity was the condition",
    );
  const rec = error.record;
  const lastAssistant = [...rec.messages].reverse().find((m) => m.role === "assistant");
  assert.ok(lastAssistant, "the record's last turn is not an assistant turn");
  const inFlight = lastAssistant.content
    .filter((p): p is Extract<ContentPart, { type: "tool_use" }> => p.type === "tool_use")
    .map((p) => p.id);
  assert.deepEqual(inFlight, ["c1"], "the in-flight call is not the last assistant turn's call");
  assert.deepEqual(
    rec.settlements.map((s) => s.toolUse.id),
    inFlight,
    "the settlements do not name exactly the last assistant turn's calls",
  );
  const settlement = rec.settlements[0];
  assert.ok(settlement.action === "synthetic", "the settlement is not the synthetic replaced note");
  assert.match(settlement.text, /replaced|in flight|lost/, "the settlement does not carry the replaced note");
  const results = toolResults(run).filter((r) => r.callId === "c1");
  assert.equal(results.length, 1, `the in-flight call has ${results.length} results on the stream, not one`);
  assert.equal(results[0].ok, false, "the in-flight call's result on the stream is not a failure");
  assert.match(results[0].summary, /replaced|in flight|lost/, "the result does not carry the replaced note");
  assert.deepEqual(run.killed, [], "a pid was ended in the replacement");
  assert.deepEqual(run.removed, [], "a root was removed in the replacement");
}

/** The wordless death's negative half: the one more command found the container
 *  as it was, so the crash judgement stands — the run fails, and not with the
 *  seam's verdict; no `sandbox_restarted` note; the process ended and its root
 *  removed, as a process that died where it ran always is. The fix is not "every
 *  wordless death is a replacement". */
function checkDeadWithoutWordSame(run: DrivenRun): void {
  const error = failed(run);
  assert.ok(
    !(error instanceof HarnessContainerReplacedError),
    `the same container's dead process was judged replaced: ${error.message}`,
  );
  assert.equal(
    notes(run).filter((n) => n.kind === "sandbox_restarted").length,
    0,
    "a sandbox_restarted note was written for a process that died where it ran",
  );
  assert.ok(run.killed.length > 0, "the dead process was not ended");
  assert.ok(run.removed.length > 0, "the dead process's root was not removed");
}

/** The transport loss's negative half: the one more command found the container
 *  as recorded (after `waited` answers that it was down, when the row says so),
 *  so the failure stands, NAMED — the run fails with the transport error it met,
 *  not the seam's verdict and not a crash judgement of the harness's own; no
 *  `sandbox_restarted` note; a `harness_error` note says the one more command
 *  named no replacement and, for a wait, that the container was down and how long
 *  it took to answer; the process ended and its root removed, as any failed run's. */
function checkTransportLostStands(run: DrivenRun, waited: boolean): void {
  const error = failed(run);
  assert.ok(
    !(error instanceof HarnessContainerReplacedError),
    `a transport loss in the same container was judged replaced: ${error.message}`,
  );
  assert.equal(error.message, TRANSPORT_LOST_TEXT, "the failure is not named as the transport error it was");
  assert.equal(
    notes(run).filter((n) => n.kind === "sandbox_restarted").length,
    0,
    "a sandbox_restarted note was written for a container that answered as recorded",
  );
  const errors = notes(run)
    .filter((n) => n.kind === "harness_error")
    .map((n) => n.summary);
  assert.ok(
    errors.some(
      (s) => /failed on its transport/.test(s) && /named no replacement/.test(s) && /the failure stands/.test(s),
    ),
    `no harness_error note says the one more command named no replacement: ${JSON.stringify(errors)}`,
  );
  if (waited) {
    assert.ok(
      errors.some((s) => /finds the container down/.test(s) && /waiting for it to answer/.test(s)),
      `no harness_error note says the container was down under the one more command: ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((s) => /^the container answered after \d+s of waiting$/.test(s)),
      `no harness_error note says how long the container took to answer: ${JSON.stringify(errors)}`,
    );
  } else {
    assert.ok(
      !errors.some((s) => /waiting for it to answer/.test(s)),
      "a wait was noted where the container answered at once",
    );
  }
  assert.ok(run.killed.length > 0, "the process was not ended after the failure");
  assert.ok(run.removed.length > 0, "the process's root was not removed after the failure");
}

/** The two hung-turn rows read the record the same way: the wind-down's note
 *  (the budget's, or the stop's) exactly once, the finale's card line, the
 *  answer the wind-down's reason-alone line — a harness whose abort surfaces
 *  the call's failure appends the `writeUpFailed` clause to it, one whose abort
 *  is silent does not, so the two halves the clause sits between are held —
 *  every `harness_error` the wind-down's own, nothing killed as a replacement
 *  (no `sandbox_restarted`), the process ended. */
function checkHungTurn(run: DrivenRun, reasonAlone: string, windDownNote: string): void {
  const answer = answered(run);
  const [head, tail] = reasonAlone.split(/(?<=finishing|written)\./);
  assert.ok(head && tail, `the reason-alone line has no clause seam: ${reasonAlone}`);
  assert.ok(answer.startsWith(head), `the answer does not open with the wind-down's words: ${answer}`);
  assert.ok(answer.endsWith(tail), `the answer does not close with the wind-down's words: ${answer}`);
  const windDown = notes(run).filter((n) => n.summary === windDownNote);
  assert.equal(windDown.length, 1, `the wind-down's note is on the record ${windDown.length} times, not once`);
  for (const n of notes(run).filter((n) => n.kind === "harness_error"))
    assert.match(n.summary, /during the wind-down/, `a harness_error that is not the wind-down's: ${n.summary}`);
  assert.ok(!notes(run).some((n) => n.kind === "sandbox_restarted"), "a hung turn was judged a replaced container");
  assert.ok(run.progress.includes(finaleTimedOutNote()), "the finale's line is not on the card");
  assert.ok(run.killed.length > 0, "the process was not ended");
}

const resumeOf = (facts: HarnessFacts): HarnessResume => ({
  messages: [{ role: "user", content: [{ type: "text", text: "carry on" }] }],
  settlements: [],
  remainingMs: 5 * 60_000,
  turn: 0,
  inboxConsumedSeq: 0,
  facts,
});

/** The record's clauses as rows, in the record's order, then the parity rows. */
export const SCENARIOS: readonly ScenarioRow[] = [
  {
    id: "credential-bearer-only",
    clause: "credential",
    title:
      "the process is started with the run bearer in its environment and no provider key, neither the run events nor the ledger steps carry the bearer, and a request into the process's server carries its auth in secretHeaders, never in plain headers",
    script: { turns: [call("c1", "bash", { command: "echo hi" }), text("done")] },
    check: (run, driver) => {
      assert.equal(run.starts.length, 1);
      const env = run.starts[0].env;
      assert.ok(Object.values(env).includes(driver.bearer), "the bearer is not in the process's environment");
      // The driver plants a sentinel under the bot's provider-key variables for the run: a harness that forwards one forwards the sentinel.
      const leaked = Object.entries(env)
        .filter(([, v]) => v.includes(driver.providerKeySentinel))
        .map(([k]) => k);
      assert.deepEqual(leaked, [], `a provider key reached the process's environment under: ${leaked.join(", ")}`);
      const secret = driver.bearer.slice(driver.bearer.indexOf(".") + 1);
      assert.ok(!JSON.stringify(run.events).includes(secret), "a run event carries the bearer");
      assert.ok(!JSON.stringify(run.steps).includes(secret), "a ledger step carries the bearer");
      // The exec classes log a request's command text: a secret in `headers` would be in the logs, one in `secretHeaders` rides the env channel.
      for (const req of run.requests) {
        const plain = Object.keys(req.headers ?? {}).filter((h) => AUTH_HEADER.test(h));
        assert.deepEqual(
          plain,
          [],
          `a request carries its auth in plain headers: ${plain.join(", ")} ${req.method} ${req.path}`,
        );
        assert.ok(
          !JSON.stringify(req.headers ?? {}).includes(secret),
          `a request's plain headers carry the bearer: ${req.path}`,
        );
      }
      assert.equal(answered(run), "done");
    },
  },
  {
    id: "gate-decides-every-call",
    clause: "gate",
    title:
      "every tool call the harness runs is decided by the bot: an allowed command runs and its result is on the record, a push to a protected branch is refused with a tool_refused note and the model reads the reason",
    script: {
      turns: [
        call("c1", "bash", { command: "echo hi" }),
        call("c2", "bash", { command: "git push origin main" }),
        text("stopped pushing"),
      ],
    },
    check: (run) => {
      assert.equal(answered(run), "stopped pushing");
      const results = toolResults(run);
      assert.deepEqual(
        results.map((r) => [r.callId, r.ok]),
        [
          ["c1", true],
          ["c2", false],
        ],
      );
      const refused = notes(run).filter((n) => n.kind === "tool_refused");
      assert.equal(refused.length, 1, "one tool_refused note for the push");
      assert.match(refused[0].summary, /main/);
    },
  },
  {
    id: "gate-bypass-fails-closed",
    clause: "gate",
    title:
      "a command the harness ran without asking fails the run closed: a harness_error note names the call, the process is ended, and the run's outcome is the bypass by name",
    script: { turns: [call("c1", "bash", { command: "ls" }), text("never")], bypassGate: true },
    check: (run) => {
      const error = failed(run);
      assert.match(error.message, /bypassed/);
      const bypass = notes(run).find((n) => n.kind === "harness_error" && /bypassed/.test(n.summary));
      assert.ok(bypass, "no harness_error note names the bypass");
      assert.match(bypass.summary, /c1/);
      assert.ok(run.killed.length > 0, "the process was not ended");
    },
  },
  {
    id: "gate-approval-unforgeable",
    clause: "gate",
    title:
      "the bot's decision is final by construction: a reject cannot be overridden by an approval the bot did not issue, so the refused call never runs and the run answers — a harness whose approval lives in its own server declares it cannot, its run failing closed on the forged once",
    script: {
      turns: [call("c1", "bash", { command: "git push origin main" }), text("nothing forged")],
      forgeApproval: true,
    },
    check: (run) => {
      // Prevention: the bot's reject landed as the call's result and nothing
      // overrode it — no forged approval ran the push, and the run answered.
      assert.equal(answered(run), "nothing forged");
      assert.deepEqual(
        toolResults(run).map((r) => [r.callId, r.ok]),
        [["c1", false]],
      );
      assert.ok(
        notes(run).some((n) => n.kind === "tool_refused" && /main/.test(n.summary)),
        "the bot's refusal is not on the record",
      );
      assert.ok(!notes(run).some((n) => n.kind === "harness_error"), "an effect the bot did not decide happened");
    },
  },
  {
    id: "relay-runs-in-bot",
    clause: "relay",
    title:
      "a relayed tool is served to the model under its own name and runs in the bot under the run's context: its side effect lands in the run's context and its call and result are on the record",
    script: { turns: [call("c1", "update_status", { checklist: "○ first step" }), text("noted")] },
    check: (run) => {
      assert.equal(answered(run), "noted");
      assert.deepEqual(run.statusReports, ["○ first step"]);
      assert.ok(offeredTools(run).includes("update_status"), "the relayed tool was not offered");
      assert.deepEqual(
        toolCalls(run).map((c) => c.tool),
        ["update_status"],
      );
      assert.deepEqual(
        toolResults(run).map((r) => [r.tool, r.ok]),
        [["update_status", true]],
      );
    },
  },
  {
    id: "record-vocabulary-and-steps",
    clause: "record",
    title:
      "the run's events are the record's vocabulary — tool_call, tool_result, run_note, and the lease the harness started — and every assistant turn is one ledger step with its calls in flight, the results as the next step's user turn",
    script: { turns: [call("c1", "bash", { command: "echo hi" }), text("all done")] },
    check: (run) => {
      assert.equal(answered(run), "all done");
      const kinds = new Set(run.events.map((e) => e.type));
      for (const k of kinds)
        assert.ok(
          ["tool_call", "tool_result", "run_note", "assistant", "input", "lease"].includes(k),
          `an event kind outside the record's vocabulary: ${k}`,
        );
      assert.ok(kinds.has("tool_call") && kinds.has("tool_result"));
      assert.ok(kinds.has("lease"), "the harness published no lease event");
      assert.equal(run.steps.length, 2, "one step per assistant turn");
      assert.deepEqual(run.steps[0].inFlight, [{ callId: "c1", tool: "bash" }]);
      assert.deepEqual(run.steps[1].inFlight, []);
      const resultTurn = run.steps[1].turns.find(
        (t) => t.role === "user" && t.content.some((p) => p.type === "tool_result"),
      );
      assert.ok(resultTurn, "the tool's result is not the next step's user turn");
    },
  },
  {
    id: "record-unknown-kind-noted",
    clause: "record",
    title:
      "an event kind the harness's table does not name lands as a harness_error note naming it, and the run goes on to its answer",
    script: { turns: [text("fine")], unknownEventKind: "made_up_kind" },
    check: (run) => {
      assert.equal(answered(run), "fine");
      const note = notes(run).find((n) => n.kind === "harness_error" && n.summary.includes("made_up_kind"));
      assert.ok(note, "no harness_error note names the unknown kind");
    },
  },
  {
    id: "conversation-seed-then-prompt",
    clause: "conversation",
    title:
      "the thread's earlier turns seed the process and the request is the prompt: the model's first call sees the seed then the request, and the first ledger step counts from the seed's end",
    script: {
      seed: [
        { role: "user", content: [{ type: "text", text: "earlier question" }] },
        { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
      ],
      request: "and now this",
      turns: [text("continuing")],
    },
    check: (run) => {
      assert.equal(answered(run), "continuing");
      const seen = firstModelCall(run).messages;
      assert.deepEqual(
        seen.map((m) => m.role),
        ["user", "assistant", "user"],
      );
      assert.deepEqual(userTexts(seen[0]), ["earlier question"]);
      assert.deepEqual(userTexts(seen[2]), ["and now this"]);
      assert.equal(run.steps[0].firstIdx, 3, "the first step counts from the seed's end");
    },
  },
  {
    id: "conversation-steer",
    clause: "conversation",
    title:
      "a thread follow-up is steered into the running process as the next user turn: an input event and a follow_up note on the record, the text in the model's next call",
    script: {
      turns: [call("c1", "bash", { command: "echo hi" }), text("also did that")],
      followUp: "also check the docs",
    },
    check: (run) => {
      assert.equal(answered(run), "also did that");
      const input = run.events.find((e) => e.type === "input" && e.text === "also check the docs");
      assert.ok(input, "no input event for the follow-up");
      assert.ok(
        notes(run).some((n) => n.kind === "follow_up"),
        "no follow_up note",
      );
      assert.ok(
        run.modelCalls.some((c) => c.messages.some((m) => userTexts(m).some((t) => t.includes("also check the docs")))),
        "the model never read the follow-up",
      );
    },
  },
  {
    id: "conversation-hard-stop",
    clause: "conversation",
    title: "a hard stop ends the process: a stopped note in mode hard, the process ended, the abort line as the answer",
    script: { turns: [call("c1", "bash", { command: "echo hi" }), text("never")], hardStopBeforeModelCall: 2 },
    check: (run) => {
      assert.equal(answered(run), HARD_STOP_MESSAGE);
      const stopped = notes(run).find((n) => n.kind === "stopped");
      assert.ok(stopped, "no stopped note");
      assert.equal(stopped.mode, "hard");
      assert.ok(run.killed.length > 0, "the process was not ended");
    },
  },
  {
    id: "conversation-soft-stop",
    clause: "conversation",
    title:
      "an operator's soft stop steers the write-up: a stopped note in mode soft, the model's next answer under the ⏹ label, the process ended",
    script: {
      turns: [call("c1", "bash", { command: "echo hi" }), text("findings so far")],
      softStopBeforeModelCall: 2,
    },
    check: (run) => {
      assert.equal(answered(run), softStopAnswer("findings so far"));
      const stopped = notes(run).filter((n) => n.kind === "stopped");
      assert.equal(stopped.length, 1, "not exactly one stopped note");
      assert.equal(stopped[0].mode, "soft");
      assert.equal(stopped[0].summary, softStopNote());
      assert.ok(!notes(run).some((n) => n.kind === "harness_error"), "a harness_error on a clean soft stop");
      assert.ok(run.killed.length > 0, "the process was not ended");
    },
  },
  {
    id: "conversation-hung-turn-budget",
    clause: "conversation",
    title:
      "a model call that never answers ends by the wind-down within the finale bound: the budget note says a model call was in flight, the write-up is steered and never comes, the finale times out, the process is ended, and the run answers under the budget's label — never a failed run, never a replaced verdict",
    script: { turns: [call("c1", "bash", { command: "echo hi" }), text("never")], hangModelCall: 2 },
    check: (run) =>
      checkHungTurn(run, timeBudgetAnswer("", CONFORMANCE_MAX_MINUTES), timeBudgetNote(MODEL_CALL_IN_FLIGHT)),
  },
  {
    id: "conversation-hung-turn-soft-stop",
    clause: "conversation",
    title:
      "a soft stop on a model call that never answers ends the same way: the stopped note in mode soft, the write-up steered and never answered, the finale times out, the process is ended, and the run answers under the ⏹ label",
    script: {
      turns: [call("c1", "bash", { command: "echo hi" }), text("never")],
      softStopBeforeModelCall: 2,
      hangModelCall: 2,
    },
    check: (run) => checkHungTurn(run, softStopAnswer(""), softStopNote()),
  },
  {
    id: "conversation-write-up-call-fails",
    clause: "conversation",
    title: "a write-up whose last model call fails ends with the write-up's answer and a harness_error note",
    script: {
      turns: [call("c1", "bash", { command: "echo hi" }), text("never written")],
      budgetBeforeModelCall: 2,
      failModelCall: 2,
    },
    check: (run) => {
      // The wind-down owns the ending: the budget note says the run was on a
      // model call when the clock ran out, the call's failure is a note, and
      // the run answered under the budget's label — naming the failed call
      // where the write-up would have been — never as a failed model call.
      assert.equal(answered(run), timeBudgetAnswer("", CONFORMANCE_MAX_MINUTES, FAILED_MODEL_CALL_ERROR));
      const budget = notes(run).filter((n) => n.kind === "time_budget_exhausted");
      assert.deepEqual(
        budget.map((n) => n.summary),
        [timeBudgetNote(MODEL_CALL_IN_FLIGHT)],
        "the budget note does not say the run was on a model call",
      );
      const failed = notes(run).filter((n) => n.kind === "harness_error");
      assert.equal(failed.length, 1, "the failed call is not exactly one harness_error note");
      assert.match(failed[0].summary, /during the wind-down/);
      assert.ok(failed[0].summary.includes(FAILED_MODEL_CALL_ERROR), "the note does not carry the provider's words");
    },
  },
  {
    id: "budget-loop-ends-inside-the-lease",
    clause: "conversation",
    title:
      "the loop ends inside the lease: the lease event names the start, the end and the loop's cut; the write-up is steered at the cut, tools refused meanwhile; the run finishes before the lease ends",
    script: {
      turns: [call("c1", "bash", { command: "echo hi" }), text("findings so far: hi")],
      budgetBeforeModelCall: 2,
    },
    check: (run) => {
      const lease = run.events.find((e) => e.type === "lease");
      assert.ok(lease && lease.type === "lease", "no lease event");
      assert.equal(
        lease.endsAt - lease.startedAt,
        CONFORMANCE_MAX_MINUTES * MINUTE_MS,
        "the lease is not the run's minutes",
      );
      // The conformance preset runs no post-step: the loop's cut holds back the write-up alone.
      assert.equal(
        lease.endsAt - lease.loopEndsAt,
        ALLOWANCES.writeUp * MINUTE_MS,
        "the loop's cut is not the write-up allowance",
      );
      assert.equal(answered(run), timeBudgetAnswer("findings so far: hi", CONFORMANCE_MAX_MINUTES));
      assert.deepEqual(
        notes(run)
          .filter((n) => n.kind === "time_budget_exhausted")
          .map((n) => n.summary),
        [timeBudgetNote(MODEL_CALL_IN_FLIGHT)],
      );
      // Every event of the run — the write-up's answer included — lands before the lease ends.
      const last = Math.max(...run.events.map((e) => e.at ?? 0));
      assert.ok(last <= lease.endsAt, `the run outlived its lease: ${last} > ${lease.endsAt}`);
      assert.ok(last > lease.loopEndsAt, "the clock never passed the loop's cut");
    },
  },
  {
    id: "survival-facts-on-row",
    clause: "survival",
    title:
      "the row's facts name the harness, the pid, the container and a relaunch count of zero, and survive a parse round trip",
    script: { turns: [text("ok")] },
    check: (run, driver) => {
      assert.equal(answered(run), "ok");
      assert.ok(run.facts.length > 0, "no facts were saved");
      const first = run.facts[0];
      assert.equal(first.harness, driver.harness);
      assert.equal(typeof first.pid, "number");
      assert.equal(first.relaunches, 0);
      assert.equal(first.container, driver.containerWord);
      const last = run.facts[run.facts.length - 1];
      assert.deepEqual(harnessFactsOf(JSON.parse(JSON.stringify(last))), last);
      assert.ok(!notes(run).some((n) => n.kind === "harness_error"), "a harness_error note on a clean run");
    },
  },
  {
    id: "survival-another-container",
    clause: "survival",
    title:
      "a resume whose facts name another container neither probes nor ends the pid there: a fresh process starts on the record and a resumed note names the orphan by pid and container",
    script: (driver) => ({
      turns: [text("resumed")],
      resume: resumeOf(driver.facts({ pid: 999, container: "vm-old" })),
    }),
    check: (run) => {
      assert.equal(answered(run), "resumed");
      assert.ok(!run.killed.includes(999), "the orphan's pid was ended here");
      assert.equal(run.starts.length, 1, "no fresh process was started");
      const note = notes(run).find(
        (n) => n.kind === "resumed" && n.summary.includes("999") && n.summary.includes("vm-old"),
      );
      assert.ok(note, "no resumed note names the orphan by pid and container");
    },
  },
  {
    id: "survival-rebuild-records-settlement",
    clause: "survival",
    title:
      "a process rebuilt from the record with a call in flight writes the settlement turn onto the ledger: the next step's rows are the settlement results with the continue's echo as one user turn from the seed index, then the assistant turn — and the model's view of the conversation is those same rows, so the record rebuilds a transcript with a result for every call at the next death",
    script: (driver) => ({
      turns: [text("carried on")],
      resume: {
        messages: [
          { role: "user", content: [{ type: "text", text: "carry on" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "c-flight", name: "bash", input: { command: "make" } }],
          },
        ],
        settlements: [
          {
            toolUse: { type: "tool_use", id: "c-flight", name: "bash", input: { command: "make" } },
            action: "synthetic",
            text: "The container was replaced while this bash call was in flight; its result was lost.",
          },
        ],
        remainingMs: 5 * 60_000,
        turn: 1,
        inboxConsumedSeq: 0,
        facts: driver.facts({ pid: 999, container: "vm-old" }),
      },
    }),
    check: (run) => {
      assert.equal(answered(run), "carried on");
      assert.ok(run.steps.length > 0, "no step was written after the rebuild");
      const step = run.steps[0];
      assert.equal(step.firstIdx, 2, "the settlement turn does not land at the seed index");
      assert.equal(step.turns.length, 2, "the step does not carry the user turn and the assistant turn");
      const [settled, answer] = step.turns;
      assert.equal(settled.role, "user");
      assert.deepEqual(settled.content[0], {
        type: "tool_result",
        toolUseId: "c-flight",
        content: "The container was replaced while this bash call was in flight; its result was lost.",
        isError: true,
      });
      assert.ok(
        settled.content.slice(1).every((p) => p.type === "text"),
        "the continue's echo is not the rest of the settlement turn",
      );
      assert.equal(answer.role, "assistant");
      // The model saw exactly the ledger's rows: the transcript it was handed, then the settlement turn.
      assert.ok(run.modelCalls.length > 0, "the model was never asked");
      const view = run.modelCalls[0].messages;
      assert.deepEqual(view.slice(0, 2), [
        { role: "user", content: [{ type: "text", text: "carry on" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "c-flight", name: "bash", input: { command: "make" } }],
        },
      ]);
      assert.deepEqual(view[2], settled, "the model's view of the settlement turn is not the ledger's row");
      assert.equal(view.length, 3);
    },
  },
  {
    id: "survival-alive-here",
    clause: "survival",
    title:
      "a resume whose facts name this same container reconciles with the process still alive here before a fresh one is placed: the run answers, and the one resumed note says which honest path was taken — re-attached to the live process (no second process, the live one ended only at the session's end, its session continued) or ended it for a fresh start (one fresh process, the live one ended first)",
    script: (driver) => ({
      turns: [text("resumed here")],
      processAliveOnResume: true,
      resume: resumeOf(driver.facts({ pid: 999, container: driver.containerWord })),
    }),
    check: (run) => {
      assert.equal(answered(run), "resumed here");
      const resumed = notes(run).filter((n) => n.kind === "resumed");
      assert.equal(resumed.length, 1, "not exactly one resumed note");
      // Two honest reconciliations. The row here carries no bearer hash, so a
      // harness whose re-attach needs one ends the process instead; a row that
      // carries it is the harness's own re-attach test. Demanding the re-attach
      // of every driver needs a double that plays an already-running pi — the
      // follow-up.
      const reAttached = run.starts.length === 0;
      if (reAttached) {
        assert.deepEqual(
          run.killed.filter((pid) => pid === 999),
          [999],
          "the live process is ended once, at the session's end, never for a fresh start",
        );
        assert.match(resumed[0].summary, /still runs in the container \(pid 999/);
        assert.match(resumed[0].summary, /continuing its session/);
      } else {
        assert.equal(run.starts.length, 1, "one fresh process was started on the record");
        assert.equal(run.killed[0], 999, "the live process was not ended before the fresh start");
        assert.match(resumed[0].summary, /ended/);
      }
      assert.ok(!notes(run).some((n) => n.kind === "harness_error"), "a harness_error on a clean resume");
    },
  },
  {
    id: "survival-dead-here",
    clause: "survival",
    title:
      "a resume whose facts name this same container but whose process no longer answers here takes the dead-process path exactly: the dead pid is not ended, its recorded root — another than the fresh start's — is removed from this container's disk, one fresh process starts on the record, the run answers, and the one resumed note is the fresh start's, never the alive path's",
    script: (driver) => ({
      turns: [text("resumed fresh")],
      processAliveOnResume: false,
      resume: resumeOf(driver.facts({ pid: 999, container: driver.containerWord, root: DEAD_ROW_ROOT })),
    }),
    check: (run) => {
      assert.equal(answered(run), "resumed fresh");
      assert.equal(run.starts.length, 1, "one fresh process was started on the record");
      // A pid that does not answer is nobody's here: never ended. Its root on
      // this container's disk is dead files: removed before the fresh start.
      assert.ok(!run.killed.includes(999), "the dead pid was ended");
      assert.ok(run.removed.includes(DEAD_ROW_ROOT), "the dead process's recorded root was not removed");
      const resumed = notes(run).filter((n) => n.kind === "resumed");
      assert.equal(resumed.length, 1, "not exactly one resumed note");
      assert.doesNotMatch(resumed[0].summary, /still (runs|answers)|ended it/, "the note took the alive path");
      assert.ok(!notes(run).some((n) => n.kind === "harness_error"), "a harness_error on a clean resume");
    },
  },
  {
    id: "survival-container-replaced",
    clause: "survival",
    title:
      "the container is replaced with a tool call in flight: the run fails with the seam's container-replaced verdict carrying the record the loop's relaunch rebuilds from — the mirrored transcript with the in-flight call settled by the replaced note — a sandbox_restarted note names both containers' words, the in-flight call is on the record as a failed tool_result carrying the note, and nothing is killed or removed in the container that answers now",
    script: {
      turns: [call("c1", "bash", { command: "echo one" }), text("never")],
      containerReplacedBeforeModelCall: 2,
    },
    check: (run) => {
      const error = failed(run);
      if (!(error instanceof HarnessContainerReplacedError))
        return assert.fail(`not the seam's container-replaced verdict: ${error.constructor.name} — ${error.message}`);
      // The verdict's words: the executor's condition, the two distinct container words.
      assert.ok(error.said !== undefined && error.said.length > 0, "the verdict carries no executor word");
      assert.ok(error.was !== undefined && error.now !== undefined, "the verdict names neither container");
      assert.notEqual(error.was, error.now, "the container did not rename itself");
      const restarted = notes(run).find((n) => n.kind === "sandbox_restarted");
      assert.ok(restarted, "no sandbox_restarted note");
      assert.ok(
        restarted.summary.includes(error.was) && restarted.summary.includes(error.now),
        "the note does not name both containers' words",
      );
      // The record the relaunch rebuilds from is the mirrored transcript: the
      // base plus the rows the run wrote (the ledger's steps), ending on the
      // assistant turn whose call is in flight; the settlements name exactly
      // that turn's calls.
      const rec = error.record;
      const stepTurns = run.steps.flatMap((s) => s.turns);
      assert.ok(stepTurns.length > 0, "the run wrote no steps");
      assert.deepEqual(
        rec.messages.slice(rec.messages.length - stepTurns.length),
        stepTurns,
        "the record's rows are not the mirrored steps",
      );
      const lastAssistant = [...rec.messages].reverse().find((m) => m.role === "assistant");
      assert.ok(lastAssistant, "the record's last turn is not an assistant turn");
      const inFlight = lastAssistant.content
        .filter((p): p is Extract<ContentPart, { type: "tool_use" }> => p.type === "tool_use")
        .map((p) => p.id);
      assert.deepEqual(inFlight, ["c1"], "the in-flight call is not the last assistant turn's call");
      assert.deepEqual(
        rec.settlements.map((s) => s.toolUse.id),
        inFlight,
        "the settlements do not name exactly the last assistant turn's calls",
      );
      // The in-flight call's settlement carries the replaced note — the result
      // the rebuilt transcript reads in its place, so the next model call sees a
      // result for every call at the death. Every driver runs the strong case:
      // each holds the call open at the replacement (the fake serve plays the
      // ask and the bot's reply, then stops before the result; pi's scripted
      // double is told to leave the call in flight), so the RECORD — the last
      // assistant turn's calls, the note in the result's place, what
      // `prepareRelaunch` rebuilds the transcript from — is asserted here and
      // the run's own event of the settlement below it.
      const settlement = rec.settlements[0];
      assert.ok(settlement.action === "synthetic", "the settlement is not the synthetic replaced note");
      assert.match(settlement.text, /replaced|in flight|lost/, "the settlement does not carry the replaced note");
      // The same settlement on the run's stream: the bridge ends the open call's
      // span and puts one failed tool_result carrying the note where the result
      // would have gone — the one result the call ever gets, since the tool died
      // with the old container's disk. A driver that completed the call before
      // the replacement would show the tool's own result here instead.
      const results = toolResults(run).filter((r) => r.callId === "c1");
      assert.equal(results.length, 1, `the in-flight call has ${results.length} results on the stream, not one`);
      assert.equal(results[0].ok, false, "the in-flight call's result on the stream is not a failure");
      assert.match(
        results[0].summary,
        /replaced|in flight|lost/,
        "the in-flight call's result on the stream does not carry the replaced note",
      );
      // Nothing of the old process is in the container that answers now.
      assert.deepEqual(run.killed, [], "a pid was ended in the replacement");
      assert.deepEqual(run.removed, [], "a root was removed in the replacement");
    },
  },
  {
    id: "survival-dead-without-word-then-word",
    clause: "survival",
    title:
      "the process is found dead with a tool call in flight and no command has returned the executor's word (the platform's rollout kills the container's processes first, while exec still answers): the harness takes one more container command before judging, and that command failing with the word is the executor's word — the seam's container-replaced verdict carrying the record with the in-flight call settled by the replaced note, one sandbox_restarted note, the call's failed tool_result on the stream, nothing killed or removed — never a crash",
    script: {
      turns: [call("c1", "bash", { command: "echo one" }), text("never")],
      deadWithoutWordBeforeModelCall: 2,
    },
    check: (run, driver) => checkDeadWithoutWord(run, driver, "word"),
  },
  {
    id: "survival-dead-without-word-then-renamed",
    clause: "survival",
    title:
      "the process is found dead with a tool call in flight, no command has returned the executor's word, and the one more container command answers another identity than the one recorded when the process started: replaced by the changed identity — the verdict's condition says so and the sandbox_restarted note carries it in the executor's words' place, with the record and the settlement as with the word, nothing killed or removed",
    script: {
      turns: [call("c1", "bash", { command: "echo one" }), text("never")],
      deadWithoutWordBeforeModelCall: 2,
      deadWithoutWordThen: "renamed",
    },
    check: (run, driver) => checkDeadWithoutWord(run, driver, "renamed"),
  },
  {
    id: "survival-dead-without-word-then-same",
    clause: "survival",
    title:
      "the process is found dead with a tool call in flight, no command has returned the executor's word, and the one more container command answers the identity recorded when the process started: the crash judgement stands — the run fails without the container-replaced verdict, no sandbox_restarted note, the process ended and its root removed",
    script: {
      turns: [call("c1", "bash", { command: "echo one" }), text("never")],
      deadWithoutWordBeforeModelCall: 2,
      deadWithoutWordThen: "same",
    },
    check: checkDeadWithoutWordSame,
  },
  {
    id: "survival-transport-lost-then-word",
    clause: "survival",
    title:
      "the in-flight container command fails on its transport with no word (the platform kills the container under it and the WebSocket closes with 1006 before any word) and the one more command fails with the word: the executor's word after all — the seam's container-replaced verdict carrying the record with the in-flight call settled by the replaced note, one sandbox_restarted note, the call's failed tool_result on the stream, nothing killed or removed — never a plain failure",
    script: {
      turns: [call("c1", "bash", { command: "echo one" }), text("never")],
      transportLostBeforeModelCall: 2,
    },
    check: (run, driver) => checkDeadWithoutWord(run, driver, "word"),
  },
  {
    id: "survival-transport-lost-then-renamed",
    clause: "survival",
    title:
      "the in-flight container command fails on its transport with no word and the one more command answers another identity than the one recorded when the process started: replaced by the changed identity — the verdict's condition says so and the sandbox_restarted note carries it in the executor's words' place, with the record and the settlement as with the word, nothing killed or removed",
    script: {
      turns: [call("c1", "bash", { command: "echo one" }), text("never")],
      transportLostBeforeModelCall: 2,
      transportLostThen: "renamed",
    },
    check: (run, driver) => checkDeadWithoutWord(run, driver, "renamed"),
  },
  {
    id: "survival-transport-lost-then-same",
    clause: "survival",
    title:
      "the in-flight container command fails on its transport with no word and the one more command answers the identity recorded when the process started: the failure stands, named as the transport error it was — no container-replaced verdict, no sandbox_restarted note, a harness_error note saying the one more command named no replacement, the process ended and its root removed",
    script: {
      turns: [call("c1", "bash", { command: "echo one" }), text("never")],
      transportLostBeforeModelCall: 2,
      transportLostThen: "same",
    },
    check: (run) => checkTransportLostStands(run, false),
  },
  {
    id: "survival-transport-lost-down-then-same",
    clause: "survival",
    title:
      "the in-flight container command fails on its transport with no word and the one more command finds the container not running, twice, before it answers the identity recorded: the container down is a wait, never the judgement — the probe is re-sent after the executor's backoff, the notes say the wait began and how long the container took to answer — and the same identity then leaves the failure standing, named",
    script: {
      turns: [call("c1", "bash", { command: "echo one" }), text("never")],
      transportLostBeforeModelCall: 2,
      transportLostThen: "same",
      containerDownForProbes: 2,
    },
    check: (run) => checkTransportLostStands(run, true),
  },
  {
    id: "survival-transport-lost-wait-stopped",
    clause: "survival",
    title:
      "the in-flight container command fails on its transport with no word, the one more command finds the container not running, and a hard stop is requested while it is down: the wait ends at once — no pause waited out, no further probe — and the run ends as the hard stop it was, the abort line as the answer, one stopped note in mode hard, the wait's note saying why it ended, no verdict, the process ended",
    script: {
      turns: [call("c1", "bash", { command: "echo one" }), text("never")],
      transportLostBeforeModelCall: 2,
      transportLostThen: "same",
      containerDownForProbes: 50,
      hardStopDuringProbeWait: true,
    },
    check: (run) => {
      assert.equal(answered(run), HARD_STOP_MESSAGE);
      const stopped = notes(run).filter((n) => n.kind === "stopped");
      assert.equal(stopped.length, 1, `${stopped.length} stopped notes, not one`);
      assert.equal(stopped[0].mode, "hard");
      assert.equal(
        notes(run).filter((n) => n.kind === "sandbox_restarted").length,
        0,
        "a verdict was reached under a stop",
      );
      const errors = notes(run)
        .filter((n) => n.kind === "harness_error")
        .map((n) => n.summary);
      assert.ok(
        errors.some((s) => /^the wait ended after 0s: a hard stop was requested$/.test(s)),
        `no note says the wait ended on the stop at once: ${JSON.stringify(errors)}`,
      );
      assert.ok(run.killed.length > 0, "the process was not ended");
    },
  },
  {
    id: "survival-foreign-row-refused",
    clause: "survival",
    title:
      "a resume whose facts another harness wrote is refused before anything is started: a harness_error note names both harnesses, the outcome is the mismatch, and find answers another-harness",
    script: (driver) => ({ turns: [text("never")], resume: resumeOf(foreignFactsFor(driver.harness)) }),
    check: async (run, driver) => {
      const error = failed(run);
      assert.ok(error instanceof HarnessMismatchError, `not a HarnessMismatchError: ${error.message}`);
      assert.equal(run.starts.length, 0, "a process was started for a foreign row");
      const foreign = foreignFactsFor(driver.harness);
      const note = notes(run).find((n) => n.kind === "harness_error" && n.summary.includes(foreign.harness));
      assert.ok(note, "no harness_error note names the foreign harness");
      assert.ok(note.summary.includes(driver.harness));
      assert.equal(await driver.find(foreign), "another-harness");
    },
  },
  {
    id: "parity-roster",
    clause: "parity",
    title:
      "the tools the model is offered are exactly the harness's own tools for the identity plus the relayed ones, and every call it makes names one of them",
    script: { turns: [call("c1", "bash", { command: "echo hi" }), text("ok")] },
    check: (run, driver) => {
      assert.equal(answered(run), "ok");
      const offered = new Set(offeredTools(run));
      const expected = new Set([...driver.object.builtinTools("write"), "update_status"]);
      assert.deepEqual(offered, expected);
      for (const c of toolCalls(run)) assert.ok(offered.has(c.tool), `a call to a tool never offered: ${c.tool}`);
    },
  },
  {
    id: "parity-identity-none",
    clause: "parity",
    title:
      "under identity none the model is offered the relayed tools alone, and a shell call it makes anyway is refused by name with a tool_refused note",
    script: { identity: "none", turns: [call("c1", "bash", { command: "ls" }), text("no shell here")] },
    check: (run, driver) => {
      assert.equal(answered(run), "no shell here");
      assert.deepEqual(driver.object.builtinTools("none"), []);
      const offered = offeredTools(run);
      assert.deepEqual(offered, ["update_status"]);
      const refused = notes(run).find((n) => n.kind === "tool_refused" && /bash/.test(n.summary));
      assert.ok(refused, "the shell call was not refused by name");
      assert.deepEqual(
        toolResults(run).map((r) => r.ok),
        [false],
      );
    },
  },
  {
    id: "parity-identity-read",
    clause: "parity",
    title:
      "under identity read the model holds no edit or write tool, an edit it asks for anyway is refused as outside its reach, and a read runs",
    script: {
      identity: "read",
      turns: [
        call("c1", "edit", { path: "README.md", oldText: "a", newText: "b" }),
        call("c2", "read", { path: "README.md" }),
        text("read only"),
      ],
    },
    check: (run, driver) => {
      assert.equal(answered(run), "read only");
      const offered = new Set(offeredTools(run));
      assert.ok(!offered.has("edit") && !offered.has("write"));
      assert.ok(offered.has("read"));
      assert.deepEqual(new Set(driver.object.builtinTools("read")).has("edit"), false);
      assert.deepEqual(
        toolResults(run).map((r) => [r.callId, r.ok]),
        [
          ["c1", false],
          ["c2", true],
        ],
      );
      assert.ok(notes(run).some((n) => n.kind === "tool_refused" && /edit/.test(n.summary)));
    },
  },
];

/** The record's keys a row must read: a row that reads neither proves nothing about the record. */
export const RECORD_KEYS: readonly (keyof DrivenRun)[] = ["events", "steps"];

/** One row against one driver, under the lint: the run as the driver returns
 *  it, wrapped so every property the check reads is recorded; a check that
 *  passed without reading the run events or the ledger steps fails here. */
export async function runRow(driver: HarnessDriver, row: ScenarioRow): Promise<{ reads: Set<string> }> {
  const script = typeof row.script === "function" ? row.script(driver) : row.script;
  const run = await driver.run(script);
  const reads = new Set<string>();
  const watched = new Proxy(run, {
    get(target, key, receiver) {
      if (typeof key === "string") reads.add(key);
      return Reflect.get(target, key, receiver);
    },
  });
  await row.check(watched, driver);
  assertReadsRecord(row, reads);
  return { reads };
}

/** The lint itself, on what a check read. */
export function assertReadsRecord(row: Pick<ScenarioRow, "id">, reads: ReadonlySet<string>): void {
  assert.ok(
    RECORD_KEYS.some((k) => reads.has(k)),
    `row ${row.id} asserts nothing on the record: its check read neither ${RECORD_KEYS.join(" nor ")}`,
  );
}

/** A row's verdict for one harness: `pass`; `cannot` — the driver declares the
 *  row and the run failed as declared (record 0038: a named failure the table
 *  asserts, never a skip); `fail` — the check failed undeclared, or a declared
 *  row passed after all (a stale declaration); `absent` — no driver. */
export type RowOutcome = "pass" | "fail" | "cannot" | "absent";

/** One row against one driver as the suite and the matrix judge it, with the
 *  failure behind a `fail` or `cannot`. */
export async function rowVerdict(
  driver: HarnessDriver,
  row: ScenarioRow,
): Promise<{ outcome: RowOutcome; error?: Error }> {
  const declared = driver.cannot?.[row.id];
  try {
    await runRow(driver, row);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { outcome: declared === undefined ? "fail" : "cannot", error };
  }
  if (declared === undefined) return { outcome: "pass" };
  return {
    outcome: "fail",
    error: new Error(`row ${row.id} passes for ${driver.harness}, but the driver declares it cannot: ${declared}`),
  };
}

export interface MatrixColumn {
  harness: HarnessName;
  rows: Record<string, RowOutcome>;
  /** The driver's declared limits, for the reasons beneath the table. */
  cannot?: Readonly<Record<string, string>>;
}

/** Every row against every driver, each verdict caught, for the printer. */
export async function buildHarnessConformanceMatrix(drivers: readonly HarnessDriver[]): Promise<MatrixColumn[]> {
  const columns: MatrixColumn[] = [];
  for (const driver of drivers) {
    const rows: Record<string, RowOutcome> = {};
    for (const row of SCENARIOS) rows[row.id] = (await rowVerdict(driver, row)).outcome;
    columns.push({ harness: driver.harness, rows, ...(driver.cannot ? { cannot: driver.cannot } : {}) });
  }
  return columns;
}

const CELL: Record<RowOutcome, string> = { pass: "✅", fail: "❌", cannot: "✖", absent: "—" };

/** The matrix as Markdown: one row per scenario, one column per harness, a
 *  harness with no driver shown absent, a declared limit its own mark with
 *  the reason beneath the table. */
export function renderHarnessConformanceMatrix(
  columns: readonly MatrixColumn[],
  harnesses?: readonly HarnessName[],
  rows: readonly ScenarioRow[] = SCENARIOS,
): string {
  const names = harnesses ?? columns.map((c) => c.harness);
  const out: string[] = [
    `**${rows.length} rows × ${names.length} harness(es)** — record 0038's six clauses and the parity rows, one table for every harness; ✅ passes, ❌ fails, ✖ cannot (declared, asserted), — no driver.`,
    "",
    `| Clause | Row | ${names.join(" | ")} |`,
    `|---|---|${names.map(() => ":-:").join("|")}|`,
  ];
  for (const row of rows) {
    const cells = names.map((n) => CELL[columns.find((c) => c.harness === n)?.rows[row.id] ?? "absent"]);
    out.push(`| ${row.clause} | \`${row.id}\` — ${row.title} | ${cells.join(" | ")} |`);
  }
  const declared = columns.flatMap((c) =>
    Object.entries(c.cannot ?? {})
      .filter(([id]) => c.rows[id] === "cannot")
      .map(([id, why]) => `✖ ${c.harness} cannot \`${id}\`: ${why}`),
  );
  if (declared.length > 0) out.push("", ...declared);
  out.push("");
  return out.join("\n");
}
