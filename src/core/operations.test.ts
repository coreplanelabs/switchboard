import { describe, expect, it } from "vitest";
import { recognizeOperation } from "./operations.js";

// Feature: features/resident-repos.md, features/routing-and-config.md —
// deterministic-ops recognition: natural language only, for the
// conservative explicit forms ("run the tests on <ref> [in <owner/name>]",
// "build <ref> [in <owner/name>]") with the repo resolved from the message or
// thread history; the explicit `repo test/build` command is the registry's
// (src/core/commands/repo.ts), never recognized here. Anything ambiguous or
// non-matching returns null — the dispatcher falls through to the agent path
// (never guess). Recognition is pure and sync: no network, no shell, and
// request text NEVER becomes a command string.

const NO_HISTORY: Array<{ role: string; text: string }> = [];
const NATURAL = { allowNatural: true };

describe("recognizeOperation — the explicit command form is not its business", () => {
  it("`repo test <owner/name> <ref>` is null here (the registry's `repo.test` binds it in stage A)", () => {
    expect(recognizeOperation("repo test acme/api main", NO_HISTORY, NATURAL)).toBeNull();
    expect(recognizeOperation("repo build acme/api", NO_HISTORY, { allowNatural: false })).toBeNull();
  });
});

describe("recognizeOperation — natural language (conservative explicit forms only)", () => {
  it('"run the tests on <ref> in <owner/name>" → test op (F3 phrasing)', () => {
    expect(recognizeOperation("run the tests on master in jshttp/vary", NO_HISTORY, NATURAL)).toEqual({
      op: "test",
      repo: "jshttp/vary",
      ref: "master",
    });
  });

  it('"build <ref> in <owner/name>" → build op', () => {
    expect(recognizeOperation("build main in acme/api", NO_HISTORY, NATURAL)).toEqual({
      op: "build",
      repo: "acme/api",
      ref: "main",
    });
  });

  it("the repo is inherited from thread history when the message names none", () => {
    const history = [
      { role: "user", text: "agent:coding fix the login bug in jshttp/vary" },
      { role: "assistant", text: "done" },
    ];
    expect(recognizeOperation("Run tests on master.", history, NATURAL)).toEqual({
      op: "test",
      repo: "jshttp/vary",
      ref: "master",
    });
  });

  it("assistant turns never establish the repo", () => {
    const history = [{ role: "assistant", text: "you could try jshttp/vary" }];
    expect(recognizeOperation("run the tests on master", history, NATURAL)).toBeNull();
  });

  it("no repo anywhere → null (falls through to the agent)", () => {
    expect(recognizeOperation("run the tests on main", NO_HISTORY, NATURAL)).toBeNull();
  });

  it("ambiguous phrasing falls through: question forms, trailing clauses", () => {
    expect(recognizeOperation("can you check the tests seem fine?", NO_HISTORY, NATURAL)).toBeNull();
    expect(recognizeOperation("run the tests on main and then deploy", NO_HISTORY, NATURAL)).toBeNull();
    expect(recognizeOperation("please make sure the build on main is green", NO_HISTORY, NATURAL)).toBeNull();
  });

  it("a ref with shell metacharacters is silently non-matching (never reaches any backend)", () => {
    expect(recognizeOperation("run the tests on main;rm in jshttp/vary", NO_HISTORY, NATURAL)).toBeNull();
    expect(recognizeOperation("run the tests on `rm -rf` in jshttp/vary", NO_HISTORY, NATURAL)).toBeNull();
    expect(recognizeOperation("build $(id) in jshttp/vary", NO_HISTORY, NATURAL)).toBeNull();
  });

  it('an owner/name-shaped "on" token is ambiguous (slug or slashy branch) without an explicit repo → null', () => {
    const history = [{ role: "user", text: "look at jshttp/vary" }];
    expect(recognizeOperation("run the tests on acme/api", history, NATURAL)).toBeNull();
  });

  it('a slashy ref IS accepted when the repo is explicit ("in <owner/name>")', () => {
    expect(recognizeOperation("run the tests on fix/login in acme/api", NO_HISTORY, NATURAL)).toMatchObject({
      op: "test",
      repo: "acme/api",
      ref: "fix/login",
    });
  });

  it("natural forms are disabled when the message carries explicit directives", () => {
    expect(
      recognizeOperation("run the tests on master in jshttp/vary", NO_HISTORY, { allowNatural: false }),
    ).toBeNull();
  });
});
