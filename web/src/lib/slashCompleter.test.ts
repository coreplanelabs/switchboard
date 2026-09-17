import { describe, expect, it } from "vitest";
import type { HomeCommandSeed } from "@core/channels/webSeed.js";
import { acceptRow, slashGhost, slashIndex, slashState, stripSlash } from "./slashCompleter";

// Feature: docs/reference/specs/web-chat.md rule 8 — the `/` completer: each
// settled word narrows the next level, the best match is the ghost, Tab or →
// accepts it, and words that settle on nothing close the palette.

const CMDS: HomeCommandSeed[] = [
  { chat: "help", describe: "What Switchboard can do, and how to ask", args: ["[topic]"] },
  { chat: "help commands", describe: "Every command, with its arguments" },
  {
    chat: "config show",
    describe: "The agent and model a run here gets",
    options: [{ form: "--channel <id>", describe: "Another channel's scope" }],
  },
  {
    chat: "config set",
    describe: "Set a scope's agent, model, effort or boundary",
    args: ["<scope>"],
    options: [
      { form: "--agent <name>", describe: "The preset" },
      { form: "--effort <level>", describe: "low, medium, high" },
      { form: "--models.general <ref>", describe: "The general preset's model" },
    ],
  },
  {
    chat: "mcp add",
    describe: "Add an MCP server to a tier",
    args: ["<name>"],
    options: [{ form: "--url <url>", describe: "Its URL" }],
  },
];

const rows = (text: string) => slashState(text, CMDS)?.rows.map((r) => r.label);
const ghost = (text: string, selected = 0) => {
  const s = slashState(text, CMDS);
  return s ? slashGhost(s, selected) : null;
};

describe("slashIndex — one map per seed", () => {
  it("groups the chat forms by their first word, keeping a one-word command as the group's own", () => {
    expect(slashIndex(CMDS).map((g) => [g.name, g.bare?.chat, g.verbs.map((v) => v.verb)])).toEqual([
      ["help", "help", ["commands"]],
      ["config", undefined, ["show", "set"]],
      ["mcp", undefined, ["add"]],
    ]);
  });
});

describe("slashState — a level per settled word", () => {
  it("`/` lists the groups; a word narrows them by prefix first, then fuzzily by name or description", () => {
    expect(rows("/")).toEqual(["/help", "/config", "/mcp"]);
    expect(rows("/co")).toEqual(["/config"]);
    expect(rows("/server")).toEqual(["/mcp"]); // by a command's description
    expect(slashState("/", CMDS)?.rows[0]).toMatchObject({
      kind: "group",
      describe: "What Switchboard can do, and how to ask · also commands",
    });
    expect(slashState("/", CMDS)?.rows[1].describe).toBe("show · set");
  });

  it("a settled group lists its verbs; a settled verb shows the command's usage; a one-word command's word after it is an argument", () => {
    expect(rows("/config ")).toEqual(["/config show", "/config set"]);
    expect(rows("/config s")).toEqual(["/config show", "/config set"]);
    expect(rows("/config se")).toEqual(["/config set"]);
    const set = slashState("/config set ", CMDS)!;
    expect(set.level).toBe("tail");
    expect(set.command?.chat).toBe("config set");
    expect(set.rows).toEqual([
      {
        insert: "",
        label: "/config set",
        describe:
          "<scope> [--agent <name>] [--effort <level>] [--models.general <ref>] — Set a scope's agent, model, effort or boundary",
        kind: "usage",
        acceptable: false,
      },
    ]);
    // help: the bare command's usage leads its verbs; a word that is no verb is help's argument.
    expect(rows("/help ")).toEqual(["/help", "/help commands"]);
    expect(rows("/help com")).toEqual(["/help commands"]);
    expect(slashState("/help routing", CMDS)).toMatchObject({ level: "tail", command: { chat: "help" } });
  });

  it("at the tail a word starting with - completes the command's options, minus the ones already used; a used positional drops out of the usage", () => {
    expect(rows("/config set me --")).toEqual(["--agent <name>", "--effort <level>", "--models.general <ref>"]);
    expect(rows("/config set me --e")).toEqual(["--effort <level>"]);
    expect(rows("/config set me --effort low --")).toEqual(["--agent <name>", "--models.general <ref>"]);
    expect(slashState("/config set me ", CMDS)?.rows[0].describe).toBe(
      "[--agent <name>] [--effort <level>] [--models.general <ref>] — Set a scope's agent, model, effort or boundary",
    );
    expect(slashState("/config set me --effort low ", CMDS)?.rows[0].describe).toBe(
      "[--agent <name>] [--models.general <ref>] — Set a scope's agent, model, effort or boundary",
    );
  });

  it("words that settle on nothing close the palette, as does anything that is not a command being typed", () => {
    for (const t of ["/zzz x", "/config zzz ", "review /x", "/con\nfig", "hello", ""])
      expect(slashState(t, CMDS), t).toBeNull();
    // A word with no match at its own level keeps the palette open, empty, so the page can say so.
    expect(slashState("/zzz", CMDS)?.rows).toEqual([]);
    expect(slashState("/config zzz", CMDS)?.rows).toEqual([]);
    expect(slashState("/", [])).toBeNull();
  });
});

describe("slashGhost / acceptRow / stripSlash", () => {
  it("the ghost is the rest of the selected match; the arrows change it; a usage row's ghost is the usage, never acceptable", () => {
    expect(ghost("/co")).toEqual({ text: "nfig", acceptable: true });
    expect(ghost("/", 2)).toEqual({ text: "mcp", acceptable: true });
    expect(ghost("/config s")).toEqual({ text: "how", acceptable: true });
    expect(ghost("/config s", 1)).toEqual({ text: "et", acceptable: true });
    expect(ghost("/config set ")).toEqual({
      text: "<scope> [--agent <name>] [--effort <level>] [--models.general <ref>]",
      acceptable: false,
    });
    expect(ghost("/config set me --e")).toEqual({ text: "ffort", acceptable: true });
    // A bare command's usage is its ghost at the verb level too; a command with no usage has none.
    expect(ghost("/help ")).toEqual({ text: "[topic]", acceptable: false });
    expect(ghost("/help commands ")).toBeNull();
    // A fuzzy match that is not a prefix has nothing to ghost.
    expect(ghost("/server")).toBeNull();
    // Nothing left to complete: no ghost.
    expect(ghost("/config")).toBeNull();
  });

  it("accepting a row replaces the word with the row's and opens the next level with a space", () => {
    const s = slashState("/co", CMDS)!;
    expect(acceptRow(s, s.rows[0])).toBe("/config ");
    const v = slashState("/config s", CMDS)!;
    expect(acceptRow(v, v.rows[1])).toBe("/config set ");
    const o = slashState("/config set me --e", CMDS)!;
    expect(acceptRow(o, o.rows[0])).toBe("/config set me --effort ");
  });

  it("stripSlash drops the slash from a message that names a command and leaves anything else as typed", () => {
    expect(stripSlash("/config set me --effort low", CMDS)).toBe("config set me --effort low");
    expect(stripSlash("/help", CMDS)).toBe("help");
    expect(stripSlash("/help routing", CMDS)).toBe("help routing");
    expect(stripSlash("/nothing here", CMDS)).toBe("/nothing here");
    expect(stripSlash("review the PR", CMDS)).toBe("review the PR");
  });
});
