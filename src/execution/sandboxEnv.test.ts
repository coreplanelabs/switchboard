import { describe, expect, it } from "vitest";
import { ENV_NAME_PATTERN, envFromRequest } from "./sandboxEnv.js";

// Feature: features/execution.md item 5 — the env map the bot forwards into a
// per-thread sandbox rides ONLY in the request BODY; request headers are never
// a credential channel: Workers Logs record every invocation's request headers
// and redact by a NAME heuristic — `x-env-gh_token` shows as REDACTED, but
// `x-env-PROBE_VAR: hello` is logged in clear. Bodies are not recorded. So
// `envFromRequest` reads the body alone and takes no headers.

describe("envFromRequest", () => {
  it("reads `env` from the body — an object of string values — and returns it as the env map", () => {
    expect(envFromRequest({ body: { command: "ls", env: { GH_TOKEN: "ghs_x" } } })).toEqual({
      GH_TOKEN: "ghs_x",
    });
  });

  it("upper-cases body keys, so `gh_token` and `GH_TOKEN` are one variable", () => {
    expect(envFromRequest({ body: { env: { gh_token: "ghs_x" } } })).toEqual({
      GH_TOKEN: "ghs_x",
    });
  });

  it("drops names that are not shell identifiers after upper-casing", () => {
    expect(
      envFromRequest({
        body: { env: { "BAD-NAME": "x", "1LEADING": "y", "WITH SPACE": "z", "": "e", GOOD_1: "ok" } },
      }),
    ).toEqual({ GOOD_1: "ok" });
    expect(ENV_NAME_PATTERN.test("GH_TOKEN")).toBe(true);
    expect(ENV_NAME_PATTERN.test("_X9")).toBe(true);
    expect(ENV_NAME_PATTERN.test("9X")).toBe(false);
    expect(ENV_NAME_PATTERN.test("A-B")).toBe(false);
  });

  it("drops non-string values — numbers, booleans, null, objects, arrays — and keeps the string ones", () => {
    expect(
      envFromRequest({
        body: { env: { N: 1, B: true, NIL: null, O: { a: 1 }, A: ["x"], U: undefined, S: "kept", EMPTY: "" } },
      }),
    ).toEqual({ S: "kept", EMPTY: "" });
  });

  it("an `env` that is not a plain object (array, string, null, number, boolean) yields an empty map", () => {
    for (const env of [["GH_TOKEN=x"], "GH_TOKEN=x", null, 7, true]) {
      expect(envFromRequest({ body: { env } })).toEqual({});
    }
  });

  it("a body that is not an object yields an empty map — never a throw", () => {
    expect(envFromRequest({ body: undefined })).toEqual({});
    expect(envFromRequest({ body: null })).toEqual({});
    expect(envFromRequest({ body: "text" })).toEqual({});
    expect(envFromRequest({ body: [] })).toEqual({});
  });

  it("reads only `env` — the body's other fields are never env, and there is no header channel", () => {
    expect(
      envFromRequest({
        body: { command: "echo", timeoutMs: 1000, path: "/x", GH_TOKEN: "not-here" },
      }),
    ).toEqual({});
  });
});
