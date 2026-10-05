import { describe, expect, it } from "vitest";
import { FAILURE_OUTCOME, REFUSED_OUTCOME, refusalOutcome, rootStatusForOutcome } from "./rootOutcome";

// Feature: docs/reference/specs/tracing.md item 22 — a resident streamed root carries
// one outcome word, and only a throw no route named (a 500) is the failure word that
// ends the span `error`. A designed refusal (400/409/503) is a handled outcome the
// caller acts on, so it must never wear the failure word nor read as a span error.
describe("refusalOutcome", () => {
  it("carries what the refusal needed, ahead of its own word and the fallback", () => {
    expect(refusalOutcome({ error: "x", status: 409, needs: "ref" })).toBe("needs_ref");
    expect(refusalOutcome({ error: "x", status: 409, needs: "attach", reason: "ignored" })).toBe("needs_attach");
    expect(refusalOutcome({ error: "x", status: 400, needs: "recreate" })).toBe("needs_recreate");
  });

  it("carries the refusal's own word when it named one", () => {
    expect(refusalOutcome({ error: "x", status: 503, reason: "image-stale" })).toBe("image-stale");
    expect(refusalOutcome({ error: "x", status: 503, reason: "recreate-in-progress" })).toBe("recreate-in-progress");
  });

  it("carries `refused` for a designed refusal that named neither a need nor a word", () => {
    expect(refusalOutcome({ error: "x", status: 503 })).toBe(REFUSED_OUTCOME);
    expect(refusalOutcome({ error: "x", status: 400 })).toBe(REFUSED_OUTCOME);
    expect(refusalOutcome({ error: "x", status: 409 })).toBe(REFUSED_OUTCOME);
  });

  it("carries the failure word for a throw no route named, whatever else it holds", () => {
    expect(refusalOutcome({ error: "attach-failed: oom", status: 500 })).toBe(FAILURE_OUTCOME);
    expect(refusalOutcome({ error: "x", status: 500, transient: true })).toBe(FAILURE_OUTCOME);
    expect(refusalOutcome({ error: "x", status: 500, reason: "runtime-unreachable" })).toBe(FAILURE_OUTCOME);
  });
});

describe("rootStatusForOutcome", () => {
  it("ends the span an error for the failure word alone", () => {
    expect(rootStatusForOutcome(FAILURE_OUTCOME)).toBe("error");
  });

  it("ends the span ok for an answer and every refusal word — a refusal is never a span error", () => {
    for (const word of ["ok", "needs_ref", "needs_attach", "image-stale", REFUSED_OUTCOME]) {
      expect(rootStatusForOutcome(word)).toBe("ok");
    }
  });
});
