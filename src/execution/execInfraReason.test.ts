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
  type ExecInfraReason,
} from "./executor.js";
import { sandboxEmptyFailureMessage, sandboxNoAnswerMessage } from "./cloudflareSandbox.js";
import { residentAnswerReason, residentWakeStrike } from "./resident.js";
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

  it("a resident answer is typed by the fields the resident puts on it: a 5xx carrying a state is unavailable when that state says the resident is coming back (restoring, serviceable, a degraded reason the engine retries — the wake path's own decision) and refused when it does not (down, onboarding, a repo failure) or when the resource is unregistered; a 5xx with a body and no state is deterministic and answered; a bare 5xx is unavailable; a body on any other status is the words; a bare 4xx is refused", () => {
    // Waits: the restore window and a busy mirror, typed by the state the resident puts on the answer.
    expect(
      residentAnswerReason(503, {
        error: "not-serviceable: restore in progress",
        state: "restoring",
        reason: "rehydrating",
      }),
    ).toBe("worker-unavailable");
    expect(
      residentAnswerReason(503, {
        error: "mirror-busy: mutex not acquired within 30000ms",
        state: "warm",
        reason: "mirror-busy",
      }),
    ).toBe("worker-unavailable");
    expect(residentAnswerReason(503, { error: "not-serviceable: refreshing", state: "refreshing", reason: "" })).toBe(
      "worker-unavailable",
    );
    expect(
      residentAnswerReason(503, {
        error: "image-stale: the container predates the current pool and is restarting; retry shortly",
        state: "restoring",
        reason: "image-stale",
      }),
    ).toBe("worker-unavailable");
    expect(
      residentAnswerReason(503, {
        error: "not-serviceable: degraded",
        state: "degraded",
        reason: "restore-interrupted: the runtime was replaced under the restore",
      }),
    ).toBe("worker-unavailable");
    expect(residentAnswerReason(502, {})).toBe("worker-unavailable");
    // The same decision as the wake path's, on the same words: one fact, one verdict.
    for (const [state, reason] of [
      ["restoring", "rehydrating"],
      ["warm", "mirror-busy"],
      ["down", "no-snapshot"],
      ["onboarding", ""],
      ["degraded", "install-failed: exit 1"],
    ] as const) {
      expect(residentAnswerReason(503, { error: "x", state, reason }), `${state} (${reason})`).toBe(
        isWakeable(state, reason) ? "worker-unavailable" : "refused",
      );
    }
    // Judged at once: nothing a wait changes.
    expect(
      residentAnswerReason(503, {
        error: "not-serviceable: no-snapshot: nothing to rehydrate from",
        state: "down",
        reason: "no-snapshot",
      }),
    ).toBe("refused");
    // The rebuild after a down transition: longer than any wait, and the wake path strikes on it too.
    expect(residentAnswerReason(503, { error: "not-serviceable: onboarding", state: "onboarding", reason: "" })).toBe(
      "refused",
    );
    expect(
      residentAnswerReason(503, {
        error: "not-serviceable: registry record or repo facts missing",
        reason: "unregistered",
      }),
    ).toBe("refused");
    expect(residentAnswerReason(404, {})).toBe("refused");
    expect(residentAnswerReason(400, { error: "bad request" })).toBe("answered");
    // Deterministic 500s — the resident answered, every time: the words decide at the seam, the failure stands at once.
    expect(residentAnswerReason(500, { error: "op-failed at fetch: exit 128" })).toBe("answered");
    expect(residentAnswerReason(500, { error: "attach-failed at clone: exit 128" })).toBe("answered");
    expect(residentAnswerReason(500, { error: 'read-failed: stat answered ""' })).toBe("answered");
    expect(residentAnswerReason(500, { error: "TypeError: Cannot read properties of undefined" })).toBe("answered");
    // The words: the SDK's text the resident forwards (a 409 with no word for a known replacement), read at the seam.
    expect(residentAnswerReason(409, { error: "The container is not running, consider calling start()" })).toBe(
      "answered",
    );
    expect(residentAnswerReason(200, { error: "Command execution failed" })).toBe("answered");
  });

  it("the resident client's strike after its own wake wait carries what the last engine view said: a budget that ran out on a resident still coming back is unavailable — the harness's one more command keeps waiting on it, its bound being the longer clock — while a definite view (down, onboarding, no answer) is refused; the words are the container's either way", () => {
    const restoring = residentWakeStrike(
      "/exec",
      "not-serviceable: The container just exited",
      "waited 60s for the resident to wake (last seen restoring (rehydrating)) and gave up",
      "worker-unavailable",
    );
    expect(restoring).toBeInstanceOf(ExecInfraError);
    expect(restoring.reason).toBe("worker-unavailable");
    expect(infraMayClear(restoring)).toBe(true);
    expect(restoring.message).toBe(
      "resident /exec: not-serviceable: The container just exited; waited 60s for the resident to wake (last seen restoring (rehydrating)) and gave up",
    );
    const down = residentWakeStrike(
      "/exec",
      "not-serviceable: The container just exited",
      "the resident is down (no-snapshot: nothing to rehydrate from), which no wake recovers from; not waiting",
      "refused",
    );
    expect(down.reason).toBe("refused");
    expect(infraMayClear(down)).toBe(false);
  });
});
