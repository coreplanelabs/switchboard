import { describe, expect, it } from "vitest";
import { z } from "zod";
import { commandDefiner, flag } from "./commandRegistry.js";
import {
  camelToKebab,
  catalogueText,
  cliFlag,
  helpText,
  httpPath,
  isBooleanSchema,
  jsonSchemaFor,
  kebabToCamel,
  mcpToolName,
  namedToInput,
  normalizeQuotes,
  parseInvocation,
  setDotted,
  toSurfaceNames,
  tokenize,
  usageLine,
} from "./commandSurface.js";

// Feature: features/command-registry.md — everything a surface shows is DERIVED
// from the typed definition (KTD20/KTD21): naming, the one grammar CLI and chat
// share, the merged JSON Schema, and help. No adapter owns any of this.

const define = commandDefiner<undefined>();

const stop = define({
  id: "runs.stop",
  args: [{ name: "id", schema: z.string().regex(/^[a-z0-9-]+$/), describe: "run id" }],
  options: z.object({ mode: z.enum(["soft", "hard"]).describe("soft = finish the step; hard = abort") }),
  action: "runs:write",
  effect: "write",
  describe: "Stop a live run.",
  handler: async () => ({}),
});

const propose = define({
  id: "friction.propose",
  options: z.object({
    dryRun: flag.optional().describe("file nothing"),
    top: z.coerce.number().int().positive().optional().describe("proposals per pass"),
    minRuns: z.coerce.number().int().positive().optional(),
    repo: z.string().optional(),
    models: z.object({ coding: z.string().optional(), review: z.string().optional() }).optional(),
  }),
  action: "friction:write",
  effect: "write",
  describe: "File proposals.",
  handler: async () => ({}),
});

const instructions = define({
  id: "config.instructions",
  args: [
    { name: "scope", schema: z.enum(["me", "channel"]), describe: "whose instructions" },
    { name: "text", schema: z.string().optional(), describe: "the instructions (omit to show)", rest: true },
  ],
  action: "config:write",
  effect: "write",
  describe: "Set custom instructions.",
  handler: async () => ({}),
});

describe("naming", () => {
  it("camelCase ↔ kebab-case; the id maps to /api path, snake MCP tool, CLI words, chat form", () => {
    expect(camelToKebab("sinceMs")).toBe("since-ms");
    expect(camelToKebab("beforeId")).toBe("before-id");
    expect(kebabToCamel("since-ms")).toBe("sinceMs");
    expect(kebabToCamel("after-seq")).toBe("afterSeq");
    expect(kebabToCamel("plain")).toBe("plain");
    expect(cliFlag("dryRun")).toBe("--dry-run");
    expect(mcpToolName("friction.report")).toBe("friction_report");
    expect(httpPath("runs.list")).toBe("/api/runs.list");
    expect(toSurfaceNames("friction.report")).toEqual({ http: "/api/friction.report", mcp: "friction_report", cli: ["friction", "report"], chat: "friction report" });
  });
});

describe("tokenize", () => {
  it("splits on whitespace, honors double/single quotes (also inside a token), normalizes smart quotes", () => {
    expect(tokenize('runs stop abc --mode soft')).toEqual({ ok: true, tokens: ["runs", "stop", "abc", "--mode", "soft"] });
    expect(tokenize(`a "b c" 'd e' --repo="x/y" f`)).toEqual({ ok: true, tokens: ["a", "b c", "d e", "--repo=x/y", "f"] });
    expect(tokenize("config instructions me “be terse, always”")).toEqual({ ok: true, tokens: ["config", "instructions", "me", "be terse, always"] });
    expect(normalizeQuotes("‘a’ “b”")).toBe(`'a' "b"`);
    expect(tokenize('a "" b')).toEqual({ ok: true, tokens: ["a", "", "b"] });
  });

  it("an unterminated quote is an error", () => {
    expect(tokenize('runs stop "abc')).toEqual({ ok: false, error: "unterminated quote" });
  });
});

describe("parseInvocation — the one grammar", () => {
  it("binds positionals to args in order and --kebab flags (value, =value) to camelCase options", () => {
    expect(parseInvocation(stop, ["abc", "--mode", "soft"])).toEqual({ kind: "invoke", input: { args: ["abc"], options: { mode: "soft" } } });
    expect(parseInvocation(stop, ["--mode=hard", "abc"])).toEqual({ kind: "invoke", input: { args: ["abc"], options: { mode: "hard" } } });
    expect(parseInvocation(propose, ["--min-runs", "3", "--top=2", "--repo", "acme/api"])).toEqual({
      kind: "invoke",
      input: { args: [], options: { minRuns: "3", top: "2", repo: "acme/api" } },
    });
  });

  it("boolean options: --flag → true, --no-flag → false, --flag=false → the string the schema coerces", () => {
    expect(parseInvocation(propose, ["--dry-run"])).toMatchObject({ kind: "invoke", input: { options: { dryRun: true } } });
    expect(parseInvocation(propose, ["--no-dry-run"])).toMatchObject({ kind: "invoke", input: { options: { dryRun: false } } });
    expect(parseInvocation(propose, ["--dry-run=false"])).toMatchObject({ kind: "invoke", input: { options: { dryRun: "false" } } });
    // a boolean flag never swallows the next token
    expect(parseInvocation(propose, ["--dry-run", "--top", "2"])).toMatchObject({ kind: "invoke", input: { options: { dryRun: true, top: "2" } } });
    expect(parseInvocation(propose, ["--no-dry-run=x"])).toMatchObject({ kind: "invalid", code: "invalid_input", error: expect.stringContaining("takes no value") });
  });

  it("dotted keys nest: --models.coding x --models.review y → { models: { coding, review } }", () => {
    expect(parseInvocation(propose, ["--models.coding", "x", "--models.review=y"])).toEqual({
      kind: "invoke",
      input: { args: [], options: { models: { coding: "x", review: "y" } } },
    });
    expect(parseInvocation(propose, ["--models", "x", "--models.coding", "y"])).toMatchObject({ kind: "invalid", code: "invalid_input", error: expect.stringContaining("given twice") });
  });

  it("a trailing rest argument takes every remaining positional joined with single spaces", () => {
    expect(parseInvocation(instructions, ["me", "be", "terse,", "always"])).toEqual({ kind: "invoke", input: { args: ["me", "be terse, always"], options: {} } });
    expect(parseInvocation(instructions, ["me", "be terse", "please"])).toEqual({ kind: "invoke", input: { args: ["me", "be terse please"], options: {} } });
    expect(parseInvocation(instructions, ["channel"])).toEqual({ kind: "invoke", input: { args: ["channel"], options: {} } });
    // `--` ends options: a leading dash inside the free text is fine after it
    expect(parseInvocation(instructions, ["me", "--", "--not-a-flag", "x"])).toEqual({ kind: "invoke", input: { args: ["me", "--not-a-flag x"], options: {} } });
  });

  it("a rejected tail is the registry's own `invalid_input` (one error vocabulary); the message names the flag or the argument, never a value, and ends with the usage line", () => {
    const unknown = parseInvocation(stop, ["abc", "--bogus", "s3cret"]);
    expect(unknown).toEqual({ kind: "invalid", code: "invalid_input", error: "unknown option --bogus\nusage: runs stop <id> --mode <soft|hard>" });
    expect(JSON.stringify(unknown)).not.toContain("s3cret");
    expect(parseInvocation(stop, ["--mode", "soft"])).toMatchObject({ kind: "invalid", code: "invalid_input", error: expect.stringMatching(/^missing argument <id>/) });
    expect(parseInvocation(stop, ["abc", "--mode"])).toMatchObject({ kind: "invalid", code: "invalid_input", error: expect.stringMatching(/^option --mode needs a value/) });
    expect(parseInvocation(stop, ["abc", "extra-secret", "--mode", "soft"])).toMatchObject({ kind: "invalid", code: "invalid_input", error: expect.stringMatching(/^unexpected argument: runs stop takes at most 1/) });
    expect(parseInvocation(propose, ["please"])).toMatchObject({ kind: "invalid", code: "invalid_input", error: expect.stringMatching(/^friction propose takes no arguments/) });
    expect(parseInvocation(stop, ["abc", "--mode", "soft", "--mode", "hard"])).toMatchObject({ kind: "invalid", code: "invalid_input", error: expect.stringContaining("given twice") });
    expect(parseInvocation(stop, ["abc", "-m", "soft"])).toMatchObject({ kind: "invalid", code: "invalid_input", error: expect.stringContaining("unknown option -m") });
    expect(parseInvocation(stop, ["abc", "--Mode", "soft"])).toMatchObject({ kind: "invalid", code: "invalid_input", error: expect.stringContaining("unknown option --Mode") });
  });

  it("--help / -h anywhere asks for help; a negative number is a positional, not a flag", () => {
    expect(parseInvocation(stop, ["--help"])).toEqual({ kind: "help" });
    expect(parseInvocation(stop, ["abc", "-h"])).toEqual({ kind: "help" });
    expect(parseInvocation(instructions, ["me", "-5", "degrees"])).toMatchObject({ kind: "invoke", input: { args: ["me", "-5 degrees"] } });
  });
});

describe("namedToInput — the JSON surfaces address arguments and options by name", () => {
  it("splits a flat object into positional args (declared order) and options; kebab query keys map to camelCase; dotted keys nest", () => {
    expect(namedToInput(stop, { id: "abc", mode: "soft" }, "camel")).toEqual({ args: ["abc"], options: { mode: "soft" } });
    expect(namedToInput(propose, { "min-runs": "2", "dry-run": "true", "models.coding": "m" }, "kebab")).toEqual({ args: [], options: { minRuns: "2", dryRun: "true", models: { coding: "m" } } });
    expect(namedToInput(propose, { minRuns: 2, models: { coding: "m" } }, "camel")).toEqual({ args: [], options: { minRuns: 2, models: { coding: "m" } } });
    expect(namedToInput(stop, { mode: "soft" }, "camel")).toEqual({ args: [undefined], options: { mode: "soft" } });
  });

  it("an unknown name lands in options (the registry names it as unexpected); a nesting conflict is an error", () => {
    expect(namedToInput(stop, { id: "abc", bogus: 1 }, "camel")).toEqual({ args: ["abc"], options: { bogus: 1 } });
    expect(namedToInput(propose, { models: "x", "models.coding": "y" }, "camel")).toEqual({ error: "option models.coding given twice" });
  });

  it("setDotted refuses to overwrite and to descend through a scalar", () => {
    const o: Record<string, unknown> = {};
    expect(setDotted(o, ["a", "b"], 1)).toBe(true);
    expect(setDotted(o, ["a", "b"], 2)).toBe(false);
    expect(setDotted(o, ["a", "b", "c"], 3)).toBe(false);
    expect(o).toEqual({ a: { b: 1 } });
  });
});

describe("jsonSchemaFor — arguments (by name) + options merged", () => {
  it("lists args and options as properties, required = non-optional args + required options, no extra properties", () => {
    const schema = jsonSchemaFor(stop) as { type: string; properties: Record<string, Record<string, unknown>>; required: string[]; additionalProperties: boolean };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toEqual(["id", "mode"]);
    expect(schema.properties.id).toMatchObject({ type: "string", description: "run id" });
    expect(schema.properties.mode).toMatchObject({ enum: ["soft", "hard"], description: "soft = finish the step; hard = abort" });
    expect(schema.required).toEqual(["id", "mode"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("an optional rest argument is a plain string property, not required; a boolean flag accepts boolean or 'true'/'false'; coerced ints are integers", () => {
    const s = jsonSchemaFor(instructions) as { properties: Record<string, Record<string, unknown>>; required?: string[] };
    expect(s.properties.text).toMatchObject({ type: "string", description: "the instructions (omit to show)" });
    expect(s.required).toEqual(["scope"]);
    const p = jsonSchemaFor(propose) as { properties: Record<string, { type?: string; anyOf?: unknown[] }>; required?: string[] };
    expect(p.properties.dryRun.anyOf).toEqual([{ type: "boolean" }, { type: "string", enum: ["true", "false"] }]);
    expect(p.properties.top.type).toBe("integer");
    expect(p.properties.models.type).toBe("object");
    expect(p.required).toBeUndefined();
  });

  it("isBooleanSchema recognizes z.boolean(), the flag union, and optional wrappers of either — nothing else", () => {
    expect(isBooleanSchema(z.boolean())).toBe(true);
    expect(isBooleanSchema(flag)).toBe(true);
    expect(isBooleanSchema(flag.optional())).toBe(true);
    expect(isBooleanSchema(z.boolean().default(false))).toBe(true);
    expect(isBooleanSchema(z.enum(["true", "false"]))).toBe(false);
    expect(isBooleanSchema(z.coerce.number())).toBe(false);
  });
});

describe("help", () => {
  it("usageLine: positionals as <name>/[name]/[name…], required options bare, optional in brackets, booleans without a value", () => {
    expect(usageLine(stop)).toBe("runs stop <id> --mode <soft|hard>");
    expect(usageLine(instructions)).toBe("config instructions <scope> [text…]");
    expect(usageLine(propose)).toBe("friction propose [--dry-run] [--top <integer>] [--min-runs <integer>] [--repo <string>] [--models <object>]");
  });

  it("helpText lists the description, usage, arguments and options with their zod descriptions", () => {
    const text = helpText(stop);
    expect(text.split("\n")).toEqual(["Stop a live run.", "usage: runs stop <id> --mode <soft|hard>", "arguments:", "  <id>                run id", "options:", "  --mode <soft|hard>  soft = finish the step; hard = abort (required)"]);
    expect(helpText(propose)).toContain("  --dry-run             file nothing");
    expect(helpText(instructions)).toContain("  <text>   the instructions (omit to show) (optional)");
  });

  it("catalogueText is one aligned line per command", () => {
    expect(catalogueText([stop, propose]).split("\n")).toEqual(["  runs stop         — Stop a live run.", "  friction propose  — File proposals."]);
  });
});
