import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  EXEC_INFRA_REASONS,
  EXEC_INFRA_WAITABLE,
  ExecInfraError,
  infraMayClear,
  infraReasonOfRequestFailure,
  requestFailedMessage,
  requestFailedSentence,
  type ExecInfraReason,
} from "./executor.js";
import { sandboxEmptyFailureMessage, sandboxNoAnswerMessage } from "./cloudflareSandbox.js";
import {
  residentAnswerReason,
  residentWakeBudgetStrike,
  residentWakeStrike,
  wakeStrikeReason,
  type ResidentStatusProbe,
} from "./resident.js";
import { isWakeable } from "./residentWake.js";

// Feature: docs/reference/specs/execution.md item 9 and harness.md item 6 — an
// executor's infra failure carries a typed reason, so the harness's one more
// command waits on the TYPE (a transport lost, a deadline passed, an empty
// failure shape, an unavailable Worker) and never on the prose, and a refusal
// no wait clears is typed as such. The scan below parses the two remote
// executors with the TypeScript compiler: every `new ExecInfraError(...)` names
// its reason with a literal from the list or one of the reason-of helpers, so a
// new failure wording cannot slip past the wait unclassified (the compiler
// refuses a missing reason; the scan pins WHICH reasons each executor uses, and
// reads the argument as syntax — a string with a parenthesis in it or a nested
// call cannot fool it).

const here = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const EXECUTORS = ["./resident.ts", "./cloudflareSandbox.ts"].map((name) => [name, here(name)] as const);

/** The helpers an executor may hand the reason argument to: each decides the reason from a fact, never from prose. */
const REASON_HELPERS = new Set(["infraReasonOfStatus", "infraReasonOfRequestFailure", "residentAnswerReason"]);

/** Every `new ExecInfraError(...)` in `source`, as syntax. */
function constructions(name: string, source: string): ts.NewExpression[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: ts.NewExpression[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "ExecInfraError")
      found.push(node);
    ts.forEachChild(node, walk);
  };
  walk(file);
  return found;
}

/** Whether an expression is a call to one of the reason-of helpers. */
function isReasonHelperCall(node: ts.Node | undefined): boolean {
  return (
    node !== undefined &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    REASON_HELPERS.has(node.expression.text)
  );
}

/** Whether the reason argument is a literal from the closed list, a call to one
 *  of the reason-of helpers, a `const` the enclosing block bound to such a call
 *  (the one decision reused for the tracker's kind), or a parameter of the
 *  enclosing function declared `ExecInfraReason` (the type carries it: the
 *  caller had to name one). */
function namesAReason(arg: ts.Expression | undefined): boolean {
  if (arg === undefined) return false;
  if (ts.isStringLiteral(arg)) return (EXEC_INFRA_REASONS as readonly string[]).includes(arg.text);
  if (isReasonHelperCall(arg)) return true;
  if (!ts.isIdentifier(arg)) return false;
  for (let scope: ts.Node | undefined = arg.parent; scope !== undefined; scope = scope.parent) {
    if (ts.isBlock(scope)) {
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name) && declaration.name.text === arg.text)
            return isReasonHelperCall(declaration.initializer);
      }
    }
    if (ts.isFunctionLike(scope)) {
      const param = scope.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === arg.text);
      if (param !== undefined)
        return (
          param.type !== undefined &&
          ts.isTypeReferenceNode(param.type) &&
          ts.isIdentifier(param.type.typeName) &&
          param.type.typeName.text === "ExecInfraReason"
        );
    }
  }
  return false;
}

describe("ExecInfraError carries a typed reason, and the two remote executors name one at every construction", () => {
  it("the reasons are the closed list, and the waitable ones are exactly the shapes a wait can clear: the transport lost, the deadline passed, the empty failure shape, the Worker unavailable — never a refusal, never a failure the Worker answered by name, never the run's own stop", () => {
    expect([...EXEC_INFRA_REASONS].sort()).toEqual(
      [
        "aborted",
        "answered",
        "deadline-passed",
        "empty-failure",
        "refused",
        "transport-lost",
        "worker-unavailable",
      ].sort(),
    );
    expect([...EXEC_INFRA_WAITABLE].sort()).toEqual(
      ["deadline-passed", "empty-failure", "transport-lost", "worker-unavailable"].sort(),
    );
    for (const reason of EXEC_INFRA_REASONS)
      expect(infraMayClear(new ExecInfraError("x", reason)), reason).toBe(EXEC_INFRA_WAITABLE.has(reason));
  });

  it.each(EXECUTORS)(
    "%s names a reason at every `new ExecInfraError(` — a literal from the list, or a reason-of helper — read as syntax, so a parenthesis inside a message or a nested call cannot cut the scan short",
    (name, source) => {
      const calls = constructions(name, source);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const args = call.arguments ?? [];
        const text = call.getText().replace(/\s+/g, " ");
        expect(args.length, `two arguments on: ${text.slice(0, 160)}`).toBe(2);
        expect(namesAReason(args[1]), `no typed reason on: ${text.slice(0, 160)}`).toBe(true);
      }
    },
  );

  it("the scan reads syntax, not parentheses: a message with an unbalanced parenthesis, a nested call in the reason, and a const bound to a helper call all resolve; a bare construction, a const bound to anything else, and an unbound name do not", () => {
    const source =
      "function f() {\n" +
      "  throw new ExecInfraError(`x (${y}`, infraReasonOfStatus(Number(status)));\n" +
      "}\n" +
      'const e = new ExecInfraError(")", "refused");\n' +
      "function g() {\n" +
      "  const reason = infraReasonOfRequestFailure(err, signal);\n" +
      '  throw new ExecInfraError("a", reason);\n' +
      "}\n" +
      'const h = new ExecInfraError("bare");\n' +
      "function k() {\n" +
      '  const reason = "refused" as const;\n' +
      '  const other = new ExecInfraError("b", reason);\n' +
      '  const loose = new ExecInfraError("c", unbound);\n' +
      "}\n" +
      'function m(reason: ExecInfraReason) { return new ExecInfraError("d", reason); }\n' +
      'function n(reason: string) { return new ExecInfraError("e", reason); }\n';
    const calls = constructions("probe.ts", source);
    expect(calls).toHaveLength(8);
    expect(calls.map((call) => namesAReason(call.arguments?.[1]))).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      true,
      false,
    ]);
  });

  it("the executors' REAL failure wordings — built by the same helpers the executors throw with, never retyped — carry the waitable reasons: the one request-failed sentence for both Workers (a deadline abort, a network failure) and the sandbox executor's no-answer and empty-failure shapes", () => {
    const deadline = new DOMException("the 90s call deadline passed", "TimeoutError");
    const network = new TypeError("fetch failed");
    const cases: Array<[string, ExecInfraReason]> = [
      [requestFailedMessage("resident", "/exec", deadline), infraReasonOfRequestFailure(deadline)],
      [requestFailedMessage("resident", "/exec", network), infraReasonOfRequestFailure(network)],
      [requestFailedMessage("sandbox", "/exec", network), infraReasonOfRequestFailure(network)],
      [sandboxNoAnswerMessage("/exec", 60_000), "deadline-passed"],
      [sandboxEmptyFailureMessage("/exec"), "empty-failure"],
    ];
    for (const [message, reason] of cases) {
      const err = new ExecInfraError(message, reason);
      expect(infraMayClear(err), message).toBe(true);
    }
    expect(infraReasonOfRequestFailure(deadline)).toBe("deadline-passed");
    expect(infraReasonOfRequestFailure(network)).toBe("transport-lost");
    // The wordings as the executors write them, so a reword lands here first:
    // one sentence for both Workers, the Worker's name the only difference.
    expect(requestFailedMessage("resident", "/exec", deadline)).toBe(
      "resident worker /exec request failed (the 90s call deadline passed). " +
        "The operation may still have run, or still be running, in the resident; re-check its effects before re-running it.",
    );
    expect(requestFailedMessage("sandbox", "/exec", network)).toBe(
      "sandbox worker /exec request failed (fetch failed). " +
        "The operation may still have run, or still be running, in the sandbox; re-check its effects before re-running it.",
    );
    expect(sandboxNoAnswerMessage("/exec", 60_000)).toMatch(
      /^sandbox worker \/exec gave no answer within \d+s \(command budget 60s/,
    );
    expect(sandboxEmptyFailureMessage("/exec")).toBe(
      "sandbox worker /exec: failure with an empty message (the Worker's failure shape with its text missing)",
    );
  });

  it("a request the run's own stop aborted is `aborted`, never the transport lost: the stop's signal decides before the error's name, and no wait clears it", () => {
    const stopped = new AbortController();
    stopped.abort();
    const abortError = new DOMException("This operation was aborted", "AbortError");
    expect(infraReasonOfRequestFailure(abortError, stopped.signal)).toBe("aborted");
    expect(infraReasonOfRequestFailure(new TypeError("fetch failed"), stopped.signal)).toBe("aborted");
    // Without the stop, the same AbortError is a transport failure (the platform's own abort), and a live signal changes nothing.
    expect(infraReasonOfRequestFailure(abortError)).toBe("transport-lost");
    expect(infraReasonOfRequestFailure(new TypeError("fetch failed"), new AbortController().signal)).toBe(
      "transport-lost",
    );
    expect(infraMayClear(new ExecInfraError("x", "aborted"))).toBe(false);
  });

  /** The resident Worker's own answer shapes, as its source writes them — the fixtures below mirror these. */
  const WORKER_SOURCE = here("../../deploy/cloudflare-resident/worker.ts");
  /** Every 503 object literal in the Worker that carries the lifecycle `state`, as the text of its keys. */
  function worker503sWithState(): string[] {
    // A `${…}` inside a template literal is allowed within the object literal.
    const literals = WORKER_SOURCE.match(/\{(?:[^{}]|\$\{[^{}]*\})*status: 503(?:[^{}]|\$\{[^{}]*\})*\}/g) ?? [];
    return literals.filter((literal) => /\bstate: /.test(literal));
  }

  it("the Worker's 503 answer shapes: every one that carries the lifecycle `state` carries the lifecycle `stateReason` beside it, and keeps `reason` for the answer's own word (mirror-busy, disk-pressure, image-stale, the not-serviceable detail) — so the client can read the lifecycle pair and never mistake the answer's word for a repo failure", () => {
    const withState = worker503sWithState();
    expect(withState.length).toBeGreaterThanOrEqual(9);
    for (const literal of withState) {
      expect(literal, literal).toMatch(/\bstateReason: /);
      expect(literal, literal).toMatch(/\breason: /);
    }
    const ownWords = new Set(
      withState.map((literal) => /\breason: ("[a-z-]+"|DISK_PRESSURE_REASON|s\.reason)/.exec(literal)?.[1]),
    );
    expect(ownWords).toEqual(new Set(['"mirror-busy"', "DISK_PRESSURE_REASON", '"image-stale"', "s.reason"]));
    // The /exec stream forwards the pair, the answer's status and the catch-all's transient beside state and reason.
    for (const forwarded of [
      "stateReason: result.stateReason",
      "status: result.status",
      "transient: result.transient",
      "state: result.state",
      "reason: result.reason",
    ])
      expect(WORKER_SOURCE, forwarded).toContain(forwarded);
    // The fetch handler's catch-all types its throw: transient or not, as a field.
    expect(WORKER_SOURCE.match(/catchAllErr\(err\)/g)).toHaveLength(3);
    expect(WORKER_SOURCE).toMatch(
      /return \{ error: errMsg\(err\), status: 500, transient: isTransientPlatformThrow\(err\) \};/,
    );
  });

  it("a resident answer is typed by the fields the resident puts on it: a 5xx carrying the lifecycle pair (`state`, `stateReason`) is unavailable when that pair says the resident is coming back (restoring, serviceable, a degraded reason the engine retries — the wake path's own decision) and refused when it does not (down, onboarding, a repo failure); the answer's own `reason` (mirror-busy, disk-pressure, image-stale) never decides, so a busy mirror on a degraded-but-serviceable resident waits; `unregistered` refuses; a stateless 5xx with a body is deterministic and answered unless the catch-all typed it transient; a bare 5xx is unavailable; a body on any other status is the words; a bare 4xx is refused", () => {
    // The Worker's shapes: the lifecycle pair beside the answer's own word.
    const notServiceable = (state: string, stateReason: string, detail: string) => ({
      error: `not-serviceable: ${detail}`,
      status: 503,
      state,
      stateReason,
      reason: stateReason,
    });
    const mirrorBusy = (state: string, stateReason: string) => ({
      error: "mirror-busy: mutex not acquired within 30000ms",
      status: 503,
      state,
      stateReason,
      reason: "mirror-busy",
    });
    const diskPressure = (state: string, stateReason: string) => ({
      error: "disk-pressure: 1.2 GiB projected against 0.9 GiB free",
      status: 503,
      state,
      stateReason,
      reason: "disk-pressure",
    });
    const imageStale = {
      error: "image-stale: the container predates the current pool and is restarting; retry shortly",
      status: 503,
      state: "restoring",
      stateReason: "",
      reason: "image-stale",
    };
    // Waits: the restore window, a busy mirror or a full disk on a resident that is serving.
    expect(residentAnswerReason(503, notServiceable("restoring", "rehydrating", "restore in progress"))).toBe(
      "worker-unavailable",
    );
    expect(residentAnswerReason(503, notServiceable("refreshing", "", "refreshing"))).toBe("worker-unavailable");
    expect(
      residentAnswerReason(
        503,
        notServiceable("degraded", "restore-interrupted: the runtime was replaced under the restore", "degraded"),
      ),
    ).toBe("worker-unavailable");
    expect(residentAnswerReason(503, mirrorBusy("warm", ""))).toBe("worker-unavailable");
    // The regression the review found: a degraded-but-serviceable resident with a refresh holding the mirror.
    expect(residentAnswerReason(503, mirrorBusy("degraded", "github-unreachable: fetch failed"))).toBe(
      "worker-unavailable",
    );
    expect(residentAnswerReason(503, diskPressure("degraded", "github-unreachable: fetch failed"))).toBe(
      "worker-unavailable",
    );
    expect(residentAnswerReason(503, imageStale)).toBe("worker-unavailable");
    expect(residentAnswerReason(502, {})).toBe("worker-unavailable");
    // The same decision as the wake path's, on the lifecycle pair: one fact, one verdict.
    for (const [state, stateReason] of [
      ["restoring", "rehydrating"],
      ["warm", ""],
      ["degraded", "github-unreachable: fetch failed"],
      ["down", "no-snapshot"],
      ["onboarding", ""],
      ["degraded", "install-failed: exit 1"],
    ] as const) {
      const want = isWakeable(state, stateReason) ? "worker-unavailable" : "refused";
      expect(residentAnswerReason(503, mirrorBusy(state, stateReason)), `mirror-busy on ${state}`).toBe(want);
      expect(residentAnswerReason(503, notServiceable(state, stateReason, "x")), `not-serviceable on ${state}`).toBe(
        want,
      );
    }
    // A Worker predating `stateReason` put the lifecycle reason in `reason` on
    // its not-serviceable answers: read as such, unless it is one of the
    // answer's own words, which say nothing about the lifecycle.
    expect(
      residentAnswerReason(503, {
        error: "not-serviceable: degraded",
        status: 503,
        state: "degraded",
        reason: "github-unreachable: fetch failed",
      }),
    ).toBe("worker-unavailable");
    expect(
      residentAnswerReason(503, { error: "x", status: 503, state: "degraded", reason: "install-failed: exit 1" }),
    ).toBe("refused");
    expect(residentAnswerReason(503, { error: "x", status: 503, state: "warm", reason: "mirror-busy" })).toBe(
      "worker-unavailable",
    );
    expect(residentAnswerReason(503, { error: "x", status: 503, state: "restoring", reason: "image-stale" })).toBe(
      "worker-unavailable",
    );
    // That Worker's mirror-busy on a degraded resident carries no lifecycle reason at all: unreadable, refused.
    expect(residentAnswerReason(503, { error: "x", status: 503, state: "degraded", reason: "mirror-busy" })).toBe(
      "refused",
    );
    expect(residentAnswerReason(503, { error: "x", status: 503, state: "down", reason: "no-snapshot" })).toBe(
      "refused",
    );
    // The /exec stream's document, as `streamThreadExec` writes it over HTTP 200: the answer's own status in the body decides.
    const streamed = {
      error: "mirror-busy: mutex not acquired within 30000ms",
      state: "degraded",
      stateReason: "github-unreachable: fetch failed",
      reason: "mirror-busy",
      status: 503,
      stdout: "",
      stderr: "mirror-busy: mutex not acquired within 30000ms",
      exitCode: 127,
    };
    expect(residentAnswerReason(streamed.status, streamed)).toBe("worker-unavailable");
    // Judged at once: nothing a wait changes.
    expect(
      residentAnswerReason(503, notServiceable("down", "no-snapshot", "no-snapshot: nothing to rehydrate from")),
    ).toBe("refused");
    // The rebuild after a down transition: longer than any wait, and the wake path strikes on it too.
    expect(residentAnswerReason(503, notServiceable("onboarding", "", "onboarding"))).toBe("refused");
    expect(residentAnswerReason(503, mirrorBusy("degraded", "install-failed: exit 1"))).toBe("refused");
    expect(
      residentAnswerReason(503, {
        error: "not-serviceable: registry record or repo facts missing",
        status: 503,
        reason: "unregistered",
      }),
    ).toBe("refused");
    expect(residentAnswerReason(404, {})).toBe("refused");
    expect(residentAnswerReason(400, { error: "bad request" })).toBe("answered");
    // Deterministic 500s — the resident answered, every time: the words decide at the seam, the failure stands at once.
    expect(residentAnswerReason(500, { error: "op-failed at fetch: exit 128" })).toBe("answered");
    expect(residentAnswerReason(500, { error: "attach-failed at clone: exit 128" })).toBe("answered");
    expect(residentAnswerReason(500, { error: 'read-failed: stat answered ""' })).toBe("answered");
    // The fetch handler's catch-all, typed by the Worker: the platform's transient re-probes, a route's own throw stands.
    expect(residentAnswerReason(500, { error: "Network connection lost.", status: 500, transient: true })).toBe(
      "worker-unavailable",
    );
    expect(
      residentAnswerReason(500, {
        error: "TypeError: Cannot read properties of undefined",
        status: 500,
        transient: false,
      }),
    ).toBe("answered");
    // The words: the SDK's text the resident forwards (a 409 with no word for a known replacement), read at the seam.
    expect(residentAnswerReason(409, { error: "The container is not running, consider calling start()" })).toBe(
      "answered",
    );
    expect(residentAnswerReason(200, { error: "Command execution failed" })).toBe("answered");
  });

  it("the resident client's strike after its own wake wait carries what the last engine view said, through the one decision the budget strike and a failed re-attach share (`wakeStrikeReason`): a resident still coming back is unavailable — the harness's one more command keeps waiting on it, its bound being the longer clock — while a definite view (down, onboarding, no answer) is refused; the words are the container's either way", () => {
    const restoring: ResidentStatusProbe = { kind: "status", state: "restoring", reason: "rehydrating" };
    const down: ResidentStatusProbe = {
      kind: "status",
      state: "down",
      reason: "no-snapshot: nothing to rehydrate from",
    };
    const unreachable: ResidentStatusProbe = { kind: "unreachable", error: "fetch failed", transport: true };
    expect(wakeStrikeReason(restoring)).toBe("worker-unavailable");
    expect(wakeStrikeReason({ kind: "status", state: "warm", reason: "" })).toBe("worker-unavailable");
    expect(wakeStrikeReason({ kind: "status", state: "degraded", reason: "github-unreachable: fetch failed" })).toBe(
      "worker-unavailable",
    );
    expect(wakeStrikeReason(down)).toBe("refused");
    expect(wakeStrikeReason({ kind: "status", state: "onboarding", reason: "" })).toBe("refused");
    expect(wakeStrikeReason(unreachable)).toBe("refused");
    const strike = residentWakeBudgetStrike("/exec", "not-serviceable: The container just exited", 60_000, restoring);
    expect(strike).toBeInstanceOf(ExecInfraError);
    expect(strike.reason).toBe("worker-unavailable");
    expect(infraMayClear(strike)).toBe(true);
    expect(strike.message).toBe(
      "resident /exec: not-serviceable: The container just exited; waited 60s for the resident to wake (last seen restoring (rehydrating)) and gave up",
    );
    const gaveUpDown = residentWakeBudgetStrike("/exec", "not-serviceable: The container just exited", 60_000, down);
    expect(gaveUpDown.reason).toBe("refused");
    expect(infraMayClear(gaveUpDown)).toBe(false);
    const definite = residentWakeStrike(
      "/exec",
      "not-serviceable: The container just exited",
      "the resident is down (no-snapshot: nothing to rehydrate from), which no wake recovers from; not waiting",
      "refused",
    );
    expect(definite.reason).toBe("refused");
  });

  it("the request-failed sentence is one builder for every client: the executors' wrapper names the Worker as subject and host, and the admin client passes its own nouns and re-check — no string is special-cased", () => {
    const err = new Error("fetch failed");
    expect(requestFailedSentence("resident admin", "resident", "/residents", err, "check `repo list`")).toBe(
      "resident admin /residents request failed (fetch failed). " +
        "The operation may still have run, or still be running, in the resident; check `repo list` before re-running it.",
    );
    expect(requestFailedMessage("sandbox", "/exec", err)).toBe(
      requestFailedSentence("sandbox worker", "sandbox", "/exec", err, "re-check its effects"),
    );
  });
});
