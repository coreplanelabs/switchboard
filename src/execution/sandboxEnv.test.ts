import { describe, expect, it } from "vitest";
import { ENV_NAME_PATTERN, envFromRequest } from "./sandboxEnv.js";

// Feature: features/execution.md item 5 — the env map the bot forwards into a
// per-thread sandbox rides in the request BODY, never in request headers.
// 2026-09-07 (#447 receipt): Workers Logs record every invocation's request
// headers and redact by a NAME heuristic — `x-env-gh_token` showed as
// REDACTED, but the probe's `x-env-PROBE_VAR: hello-from-env-option` was
// logged in clear. Bodies are not recorded. The header path stays readable
// for one release so a bot deployed after the Worker still works.

const headers = (h: Record<string, string>): Iterable<[string, string]> => Object.entries(h);

describe("envFromRequest", () => {
  it("reads `env` from the body — an object of string values — and returns it as the env map", () => {
    expect(envFromRequest({ body: { command: "ls", env: { GH_TOKEN: "ghs_x" } }, headers: headers({}) })).toEqual({
      GH_TOKEN: "ghs_x",
    });
  });

  it("falls back to x-env-* headers (case-insensitive prefix, name upper-cased) when the body carries no env", () => {
    expect(
      envFromRequest({
        body: { command: "ls" },
        headers: headers({ "content-type": "application/json", "X-Env-gh_token": "ghs_h", "x-thread-key": "t" }),
      }),
    ).toEqual({ GH_TOKEN: "ghs_h" });
  });

  it("body wins when both are present — per key, with header-only keys still folded in", () => {
    expect(
      envFromRequest({
        body: { env: { GH_TOKEN: "ghs_body" } },
        headers: headers({ "x-env-GH_TOKEN": "ghs_header", "x-env-OTHER": "from-header" }),
      }),
    ).toEqual({ GH_TOKEN: "ghs_body", OTHER: "from-header" });
  });

  it("upper-cases body keys too, so `gh_token` and `GH_TOKEN` are one variable", () => {
    expect(envFromRequest({ body: { env: { gh_token: "ghs_x" } }, headers: headers({}) })).toEqual({
      GH_TOKEN: "ghs_x",
    });
  });

  it("drops names that are not shell identifiers after upper-casing, from the body and from headers alike", () => {
    expect(
      envFromRequest({
        body: { env: { "BAD-NAME": "x", "1LEADING": "y", "WITH SPACE": "z", "": "e", GOOD_1: "ok" } },
        headers: headers({ "x-env-also-bad": "h", "x-env-": "empty", "x-env-FINE": "h2" }),
      }),
    ).toEqual({ GOOD_1: "ok", FINE: "h2" });
    expect(ENV_NAME_PATTERN.test("GH_TOKEN")).toBe(true);
    expect(ENV_NAME_PATTERN.test("_X9")).toBe(true);
    expect(ENV_NAME_PATTERN.test("9X")).toBe(false);
    expect(ENV_NAME_PATTERN.test("A-B")).toBe(false);
  });

  it("drops non-string values — numbers, booleans, null, objects, arrays — and keeps the string ones", () => {
    expect(
      envFromRequest({
        body: { env: { N: 1, B: true, NIL: null, O: { a: 1 }, A: ["x"], U: undefined, S: "kept", EMPTY: "" } },
        headers: headers({}),
      }),
    ).toEqual({ S: "kept", EMPTY: "" });
  });

  it("an `env` that is not a plain object (array, string, null, number) is ignored and the header fallback still applies", () => {
    for (const env of [["GH_TOKEN=x"], "GH_TOKEN=x", null, 7, true]) {
      expect(envFromRequest({ body: { env }, headers: headers({ "x-env-GH_TOKEN": "ghs_h" }) })).toEqual({
        GH_TOKEN: "ghs_h",
      });
    }
  });

  it("a body that is not an object, and no headers, yields an empty map — never a throw", () => {
    expect(envFromRequest({ body: undefined, headers: headers({}) })).toEqual({});
    expect(envFromRequest({ body: null, headers: headers({}) })).toEqual({});
    expect(envFromRequest({ body: "text", headers: headers({}) })).toEqual({});
    expect(envFromRequest({ body: [], headers: headers({}) })).toEqual({});
  });

  it("does not read the body's other fields or non-x-env headers as env", () => {
    expect(
      envFromRequest({
        body: { command: "echo", timeoutMs: 1000, path: "/x", GH_TOKEN: "not-here" },
        headers: headers({ authorization: "Bearer t", "x-thread-key": "k", "xenv-GH_TOKEN": "no" }),
      }),
    ).toEqual({});
  });
});
