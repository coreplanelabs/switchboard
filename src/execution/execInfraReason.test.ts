import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXEC_INFRA_REASONS,
  EXEC_INFRA_WAITABLE,
  ExecInfraError,
  infraMayClear,
  type ExecInfraReason,
} from "./executor.js";
import {
  sandboxEmptyFailureMessage,
  sandboxNoAnswerMessage,
  sandboxRequestFailedMessage,
} from "./cloudflareSandbox.js";
import { residentRequestFailedMessage } from "./resident.js";

// Feature: docs/reference/specs/execution.md item 9 and harness.md item 6 — an
// executor's infra failure carries a typed reason, so the harness's one more
// command waits on the TYPE (a transport lost, a deadline passed, an empty
// failure shape, an unavailable Worker) and never on the prose, and a refusal
// no wait clears is typed as such. The scan below reads the two remote
// executors as text: every place one constructs `ExecInfraError` names its
// reason with a literal or a reason-of helper, so a new failure wording cannot
// slip past the wait unclassified (the compiler refuses a missing reason; the
// scan pins which reasons each executor uses).

const here = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const EXECUTORS = ["./resident.ts", "./cloudflareSandbox.ts"].map((name) => [name, here(name)] as const);

/** Every `new ExecInfraError(` call in `source`, as the text of the call up to its closing parenthesis. */
function constructions(source: string): string[] {
  const calls: string[] = [];
  let at = 0;
  for (;;) {
    const start = source.indexOf("new ExecInfraError(", at);
    if (start === -1) return calls;
    let depth = 0;
    let end = start;
    for (let i = start + "new ExecInfraError".length; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    calls.push(source.slice(start, end));
    at = end;
  }
}

// The reason is the last argument: a literal from the list or one of the two
// reason-of helpers, with or without the formatter's trailing comma.
const REASON_LITERAL = new RegExp(`,\\s*"(${EXEC_INFRA_REASONS.join("|")})"\\s*,?\\s*\\)$`);
const REASON_HELPER = /,\s*(?:infraReasonOfStatus|infraReasonOfRequestFailure)\([^)]*\)\s*,?\s*\)$/;

describe("ExecInfraError carries a typed reason, and the two remote executors name one at every construction", () => {
  it("the reasons are the closed list, and the waitable ones are exactly the shapes a wait can clear: the transport lost, the deadline passed, the empty failure shape, the Worker unavailable — never a refusal, never a failure the Worker answered by name", () => {
    expect([...EXEC_INFRA_REASONS].sort()).toEqual(
      ["answered", "deadline-passed", "empty-failure", "refused", "transport-lost", "worker-unavailable"].sort(),
    );
    expect([...EXEC_INFRA_WAITABLE].sort()).toEqual(
      ["deadline-passed", "empty-failure", "transport-lost", "worker-unavailable"].sort(),
    );
    for (const reason of EXEC_INFRA_REASONS)
      expect(infraMayClear(new ExecInfraError("x", reason)), reason).toBe(EXEC_INFRA_WAITABLE.has(reason));
  });

  it.each(EXECUTORS)(
    "%s names a reason at every `new ExecInfraError(` — a literal from the list, or the status/request helper",
    (_name, source) => {
      const calls = constructions(source);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const oneLine = call.replace(/\s+/g, " ");
        expect(
          REASON_LITERAL.test(oneLine) || REASON_HELPER.test(oneLine),
          `no typed reason on: ${oneLine.slice(0, 160)}`,
        ).toBe(true);
      }
    },
  );

  it("the executors' REAL failure wordings — built by the same helpers the executors throw with, never retyped — carry the waitable reasons: the resident client's request failure (a deadline abort, a network failure) and the sandbox executor's no-answer, request-failed and empty-failure shapes", () => {
    const deadline = new DOMException("the 90s call deadline passed", "TimeoutError");
    const network = new TypeError("fetch failed");
    const cases: Array<[string, ExecInfraReason]> = [
      [residentRequestFailedMessage("/exec", deadline), "deadline-passed"],
      [residentRequestFailedMessage("/exec", network), "transport-lost"],
      [sandboxNoAnswerMessage("/exec", 60_000), "deadline-passed"],
      [sandboxRequestFailedMessage("/exec", network), "transport-lost"],
      [sandboxEmptyFailureMessage("/exec"), "empty-failure"],
    ];
    for (const [message, reason] of cases) {
      const err = new ExecInfraError(message, reason);
      expect(infraMayClear(err), message).toBe(true);
    }
    // The wordings as the executors write them, so a reword lands here first.
    expect(residentRequestFailedMessage("/exec", deadline)).toMatch(
      /^resident worker \/exec request failed \(the 90s call deadline passed\)\. The operation may still have run in the resident/,
    );
    expect(residentRequestFailedMessage("/exec", network)).toMatch(
      /^resident worker \/exec request failed \(fetch failed\)\. /,
    );
    expect(sandboxNoAnswerMessage("/exec", 60_000)).toMatch(
      /^sandbox worker \/exec gave no answer within \d+s \(command budget 60s/,
    );
    expect(sandboxEmptyFailureMessage("/exec")).toBe(
      "sandbox worker /exec: failure with an empty message (the Worker's failure shape with its text missing)",
    );
  });
});
