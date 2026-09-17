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
 *  of the reason-of helpers, or a `const` the enclosing block bound to such a
 *  call (the one decision reused for the tracker's kind). */
function namesAReason(arg: ts.Expression | undefined): boolean {
  if (arg === undefined) return false;
  if (ts.isStringLiteral(arg)) return (EXEC_INFRA_REASONS as readonly string[]).includes(arg.text);
  if (isReasonHelperCall(arg)) return true;
  if (!ts.isIdentifier(arg)) return false;
  for (let scope: ts.Node | undefined = arg.parent; scope !== undefined; scope = scope.parent) {
    if (!ts.isBlock(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.name.text === arg.text)
          return isReasonHelperCall(declaration.initializer);
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
      "}\n";
    const calls = constructions("probe.ts", source);
    expect(calls).toHaveLength(6);
    expect(calls.map((call) => namesAReason(call.arguments?.[1]))).toEqual([true, true, true, false, false, false]);
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

  it("a resident answer is typed by its status first, then by what the body names: a 5xx is the resident unavailable — a restore under way, the mirror mutex held by a refresh, a hydration failing mid-restore, the isolate's own 500 — unless the body names a refusal no wait clears (the resident `down`, the resource not registered); a body on any other status is the words; a bare 4xx is refused", () => {
    // Waits: the answers the restore window and a busy mirror produce.
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
        state: "ready",
        reason: "mirror-busy",
      }),
    ).toBe("worker-unavailable");
    expect(residentAnswerReason(503, { error: "not-serviceable: refreshing", state: "refreshing", reason: "" })).toBe(
      "worker-unavailable",
    );
    expect(residentAnswerReason(500, { error: "op-failed at fetch: exit 128" })).toBe("worker-unavailable");
    expect(residentAnswerReason(502, {})).toBe("worker-unavailable");
    // Judged at once: nothing a wait changes.
    expect(
      residentAnswerReason(503, {
        error: "not-serviceable: no-snapshot: nothing to rehydrate from",
        state: "down",
        reason: "no-snapshot",
      }),
    ).toBe("refused");
    expect(
      residentAnswerReason(503, {
        error: "not-serviceable: registry record or repo facts missing",
        reason: "unregistered",
      }),
    ).toBe("refused");
    expect(residentAnswerReason(404, {})).toBe("refused");
    expect(residentAnswerReason(400, { error: "bad request" })).toBe("answered");
    // The words: the SDK's text the resident forwards (a 409 with no word for a known replacement), read at the seam.
    expect(residentAnswerReason(409, { error: "The container is not running, consider calling start()" })).toBe(
      "answered",
    );
    expect(residentAnswerReason(200, { error: "Command execution failed" })).toBe("answered");
  });

  it("the resident client's strike after its own wake wait is a typed refusal whose words are still the container's: the wait it names was already spent, so the one more command judges it at once by the type and never re-waits on the words", () => {
    const strike = residentWakeStrike(
      "/exec",
      "not-serviceable: The container just exited",
      "waited 30s for the resident to wake (last seen restoring) and gave up",
    );
    expect(strike).toBeInstanceOf(ExecInfraError);
    expect(strike.reason).toBe("refused");
    expect(infraMayClear(strike)).toBe(false);
    expect(strike.message).toBe(
      "resident /exec: not-serviceable: The container just exited; waited 30s for the resident to wake (last seen restoring) and gave up",
    );
  });
});
