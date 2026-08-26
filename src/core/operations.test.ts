import { describe, expect, it } from "vitest";
import { recognizeOperation } from "./operations.js";

// Feature: features/resident-repos.md, features/routing-and-config.md — U6
// deterministic-ops recognition (KTD8): explicit `repo test/build` commands
// always recognized; natural language only for conservative explicit forms
// ("run the tests on <ref> [in <owner/name>]", "build <ref> [in <owner/name>]")
// with the repo resolved from the message or thread history. Anything
// ambiguous or non-matching returns null — the dispatcher falls through to
// the agent path (KD3: never guess). Recognition is pure and sync: no
// network, no shell, and request text NEVER becomes a command string.

const NO_HISTORY: Array<{ role: string; text: string }> = [];
const NATURAL = { allowNatural: true };

describe("recognizeOperation — explicit `repo test/build` commands", () => {
  it("parses `repo test <owner/name> <ref>`", () => {
    expect(recognizeOperation("repo test acme/api main", NO_HISTORY, NATURAL)).toEqual({
      op: "test",
      repo: "acme/api",
      ref: "main",
      explicit: true,
    });
  });

  it("parses `repo build <owner/name>` with no ref (resident default applies)", () => {
    expect(recognizeOperation("repo build acme/api", NO_HISTORY, NATURAL)).toEqual({
      op: "build",
      repo: "acme/api",
      explicit: true,
    });
  });

  it("lowercases the slug like every other repo surface", () => {
    expect(recognizeOperation("repo test JSHttp/Vary master", NO_HISTORY, NATURAL)).toMatchObject({
      repo: "jshttp/vary",
    });
  });

  it("a hostile ref is NOT recognized here — the repo-command error path owns the named refusal", () => {
    expect(recognizeOperation("repo test acme/api main;rm", NO_HISTORY, NATURAL)).toBeNull();
    expect(recognizeOperation("repo test acme/api `whoami`", NO_HISTORY, NATURAL)).toBeNull();
    expect(recognizeOperation("repo test acme/api $(id)", NO_HISTORY, NATURAL)).toBeNull();
  });

  it("explicit commands are recognized even when natural language is disabled", () => {
    expect(recognizeOperation("repo test acme/api main", NO_HISTORY, { allowNatural: false })).toMatchObject({
      op: "test",
      explicit: true,
    });
  });
});

describe("recognizeOperation — natural language (conservative explicit forms only)", () => {
  it('"run the tests on <ref> in <owner/name>" → test op (F3 phrasing)', () => {
    expect(recognizeOperation("run the tests on master in jshttp/vary", NO_HISTORY, NATURAL)).toEqual({
      op: "test",
      repo: "jshttp/vary",
      ref: "master",
      explicit: false,
    });
  });

  it('"build <ref> in <owner/name>" → build op', () => {
    expect(recognizeOperation("build main in acme/api", NO_HISTORY, NATURAL)).toEqual({
      op: "build",
      repo: "acme/api",
      ref: "main",
      explicit: false,
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
      explicit: false,
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
    expect(recognizeOperation("run the tests on master in jshttp/vary", NO_HISTORY, { allowNatural: false })).toBeNull();
  });
});
