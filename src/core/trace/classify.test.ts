// Feature: docs/reference/specs/tracing.md — error classification survives wrapping.
import { describe, expect, it } from "vitest";
import { CAUSE_DEPTH, classificationOf, classifyError, httpStatusCode } from "./classify.js";

describe("classifyError / classificationOf", () => {
  it("marks an error and reads it back through `cause` links to the depth bound", () => {
    let err: Error = classifyError(new Error("root"), { kind: "timeout" });
    for (let i = 0; i < CAUSE_DEPTH; i++) err = new Error(`wrap ${i}`, { cause: err });
    expect(classificationOf(err)).toEqual({ kind: "timeout" });
    const tooDeep = new Error("one more", { cause: err });
    expect(classificationOf(tooDeep)).toBeUndefined();
  });

  it("keeps a short identifier code, drops prose, and ignores non-objects", () => {
    expect(classificationOf(classifyError(new Error("x"), { kind: "http", code: "503" }))).toEqual({
      kind: "http",
      code: "503",
    });
    expect(classificationOf(classifyError(new Error("x"), { kind: "refused", code: "needs ref: master" }))).toEqual({
      kind: "refused",
    });
    expect(classifyError("a string", { kind: "other" })).toBe("a string");
    expect(classificationOf("a string")).toBeUndefined();
    expect(classificationOf(undefined)).toBeUndefined();
  });

  it("httpStatusCode admits an integer in 100..599 only", () => {
    expect(httpStatusCode(404)).toBe("404");
    expect(httpStatusCode(99)).toBeUndefined();
    expect(httpStatusCode(600)).toBeUndefined();
    expect(httpStatusCode(200.5)).toBeUndefined();
    expect(httpStatusCode("404")).toBeUndefined();
  });
});
