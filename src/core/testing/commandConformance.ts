import { z } from "zod";
import { AGENTS } from "../../agents/registry.js";
import { authorize } from "../authz/authorize.js";
import { grantsFor, type GrantsSource } from "../authz/grants.js";
import { POLICY, ruleTarget } from "../authz/policy.js";
import { targetOfResource } from "../authz/resource.js";
import type { Actor } from "../authz/types.js";
import { acceptsUndefined, resourceOf, type Caller, type CommandDef, type SurfaceName } from "../commandRegistry.js";
import { camelToKebab, cliFlag, isBooleanSchema, jsonSchemaFor, namedToInput } from "../commandSurface.js";
import { coreCommandGroups } from "../commands/all.js";
import { callerWith } from "./callers.js";

// Pure helpers for the registry-driven conformance suite
// (src/core/commandConformance.test.ts, features/command-registry.md item 25).
// Nothing here knows a command by name: every case is derived from a
// definition's declared `args`/`options` zod schemas, so a command added to the
// catalogue is exercised the moment it is registered. No vitest import — this
// module is plain TypeScript the test drives.

/** One declared input of a command — a positional argument or a named option. */
export interface Field {
  name: string;
  kind: "arg" | "option";
  schema: z.ZodType;
  required: boolean;
  rest: boolean;
}

export function fieldsOf(cmd: Pick<CommandDef<unknown>, "args" | "options">): Field[] {
  const args: Field[] = (cmd.args ?? []).map((a) => ({ name: a.name, kind: "arg", schema: a.schema, required: !acceptsUndefined(a.schema), rest: a.rest === true }));
  const options: Field[] = (Object.entries(cmd.options?.shape ?? {}) as [string, z.ZodType][]).map(([name, schema]) => ({
    name,
    kind: "option",
    schema,
    required: !acceptsUndefined(schema),
    rest: false,
  }));
  return [...args, ...options];
}

// ---- zod introspection --------------------------------------------------------------

interface ZodDef {
  type: string;
  innerType?: z.ZodType;
  options?: z.ZodType[];
  in?: z.ZodType;
  entries?: Record<string, string | number>;
  shape?: Record<string, z.ZodType>;
  values?: unknown[];
}

function defOf(schema: z.ZodType): ZodDef {
  return (schema as unknown as { _zod: { def: ZodDef } })._zod.def;
}

/** Strip optional/nullable/default wrappers. */
export function unwrapSchema(schema: z.ZodType): z.ZodType {
  let s = schema;
  for (;;) {
    const def = defOf(s);
    if ((def.type === "optional" || def.type === "nullable" || def.type === "default" || def.type === "nonoptional" || def.type === "readonly") && def.innerType) s = def.innerType;
    else return s;
  }
}

/** The values of an enum (or literal) schema; empty when the field is not one. A
 *  boolean-shaped union (`flag`) is a boolean, not an enum. */
export function enumValuesOf(schema: z.ZodType): unknown[] {
  if (isBooleanSchema(schema)) return [];
  const def = defOf(unwrapSchema(schema));
  if (def.type === "enum" && def.entries) return Object.values(def.entries);
  if (def.type === "literal" && def.values) return def.values;
  return [];
}

/** The nested option object's shape, when the field is one (`--models.coding x`). */
export function objectShapeOf(schema: z.ZodType): Record<string, z.ZodType> | undefined {
  const def = defOf(unwrapSchema(schema));
  return def.type === "object" ? def.shape : undefined;
}

/** `"string" | "integer" | "number" | "boolean" | "enum" | "object" | "array" | …` — the
 *  JSON-Schema-level kind of the value, for the snapshot and the type-mismatch case. */
export function kindOf(schema: z.ZodType): string {
  if (isBooleanSchema(schema)) return "boolean";
  if (enumValuesOf(schema).length > 0) return "enum";
  const js = z.toJSONSchema(unwrapSchema(schema), { io: "input" }) as { type?: string | string[] };
  if (typeof js.type === "string") return js.type;
  if (Array.isArray(js.type)) return js.type.join("|");
  return defOf(unwrapSchema(schema)).type;
}

// ---- samples -----------------------------------------------------------------------------

/** Per-field-name hints: what a real fixture has to offer (a run id that
 *  exists, a repo slug the tracker accepts). Keyed by field NAME, so the hint
 *  serves every command that declares a field of that name. */
export type SampleHints = Record<string, unknown>;

const STRING_CANDIDATES = ["sample", "acme/api", "slack:C1", "a"];
const NUMBER_CANDIDATES = [1, 2, 0, 10, 100, -1, 0.5];

/**
 * A value the schema accepts, or `undefined` when none of the candidates does —
 * the caller fails loudly then, naming the field (a constrained string such as
 * a regex or a `.refine` needs a hint). Hints win; a hint the schema rejects is
 * a loud failure too, never silently replaced.
 */
export function sampleFor(schema: z.ZodType, hint?: unknown): unknown {
  if (hint !== undefined) return schema.safeParse(hint).success ? hint : undefined;
  if (isBooleanSchema(schema)) return true;
  const values = enumValuesOf(schema);
  if (values.length > 0) return values[0];
  const shape = objectShapeOf(schema);
  if (shape) {
    const out: Record<string, unknown> = {};
    for (const [k, s] of Object.entries(shape)) {
      const v = sampleFor(s);
      if (v !== undefined) out[k] = v;
    }
    return schema.safeParse(out).success ? out : undefined;
  }
  const kind = kindOf(schema);
  const candidates: unknown[] = kind === "integer" || kind === "number" ? NUMBER_CANDIDATES : kind === "array" ? [[]] : [...STRING_CANDIDATES, ...NUMBER_CANDIDATES];
  return candidates.find((c) => schema.safeParse(c).success);
}

/** A marker that must never appear in any output: the value the type-mismatch
 *  cases submit. Distinctive so an echo is unmistakable. */
export const MISMATCH_MARKER = "MISMATCH VALUE 9f3c1e!";
const MISMATCH_NUMBER = 4242424242;

/**
 * A value the schema REJECTS, for the type-mismatch case. The text marker has
 * spaces and punctuation so an id regex, a slug refine, a number, an enum, and
 * the boolean `flag` all refuse it; a plain `z.string()` accepts anything.
 * `text: true` limits
 * the candidates to what a text surface (argv, chat, a query string) can carry
 * — strings — so a plain `z.string()` has no text mismatch (undefined: the case
 * is skipped there) but a JSON surface still gets a number for it.
 */
export function mismatchFor(schema: z.ZodType, opts: { text: boolean }): unknown {
  const candidates: unknown[] = [MISMATCH_MARKER, ...(opts.text ? [] : [MISMATCH_NUMBER, { nested: MISMATCH_MARKER }])];
  return candidates.find((c) => !schema.safeParse(c).success);
}

// ---- variants ------------------------------------------------------------------------------

/** A by-name input as every surface addresses it: declared argument names and
 *  camelCase option keys → typed values (numbers as numbers, booleans as
 *  booleans, nested objects for dotted options). Surface drivers spell it. */
export type Named = Record<string, unknown>;

export interface Variant {
  name: string;
  named: Named;
  /** What `invoke` must answer: success, or a parse failure naming `field`. */
  expect: { ok: true } | { ok: false; error: "invalid_input"; field: string };
  /** Present only on the type-mismatch cases: the submitted bad value, which no output may echo. */
  planted?: unknown;
  /** True for the cases a text surface (argv/chat/query) cannot spell — a
   *  non-string mismatch for a plain string field. Skipped on those surfaces. */
  jsonOnly?: boolean;
}

/** The canonical unknown option every command must refuse. */
export const UNKNOWN_OPTION = "bogusOption";

/** A free-text value with both quote characters inside it: the chat spelling
 *  must escape it (`toChatText`) so the tokenizer hands back the exact string. */
export const QUOTED_SAMPLE = `quoted "double" and 'single' words`;

/**
 * Every case the suite runs for one command, derived from its fields:
 *  - required-only, all-set (every optional field too);
 *  - one case per enum value of every enum field;
 *  - `true` and `false` for every boolean field (the grammar's `--x` / `--no-x`);
 *  - one type-mismatch per field (text and, where different, JSON-only);
 *  - embedded `"` and `'` in the first free-text field — one the schema alone
 *    constrains (no hint, not a baseline) and accepts the sample — so the chat
 *    tokenizer's quoting must round-trip the value exactly;
 *  - an unknown option;
 *  - a missing required argument (when the command declares one).
 * A field with no acceptable sample is reported in `missingSamples` rather than
 * silently dropped — the test fails listing them.
 */
export function exhaustiveVariants(
  cmd: Pick<CommandDef<unknown>, "args" | "options">,
  hints: SampleHints = {},
  /** Option values present in EVERY variant (a per-command fixture's must-haves). */
  baseline: Named = {},
): { variants: Variant[]; missingSamples: string[] } {
  const fields = fieldsOf(cmd);
  const samples = new Map<string, unknown>();
  const missingSamples: string[] = [];
  for (const f of fields) {
    const v = sampleFor(f.schema, hints[f.name]);
    if (v === undefined) missingSamples.push(f.name);
    else samples.set(f.name, v);
  }
  const requiredOnly: Named = { ...baseline, ...Object.fromEntries(fields.filter((f) => f.required).map((f) => [f.name, samples.get(f.name)])) };
  const allSet: Named = { ...baseline, ...Object.fromEntries(fields.map((f) => [f.name, samples.get(f.name)])) };
  const variants: Variant[] = [
    { name: "required-only", named: requiredOnly, expect: { ok: true } },
    { name: "all-options-set", named: allSet, expect: { ok: true } },
  ];
  for (const f of fields) {
    for (const value of enumValuesOf(f.schema)) variants.push({ name: `${f.name}=${String(value)}`, named: { ...requiredOnly, [f.name]: value }, expect: { ok: true } });
    if (isBooleanSchema(f.schema)) {
      variants.push({ name: `${f.name}=true`, named: { ...requiredOnly, [f.name]: true }, expect: { ok: true } });
      variants.push({ name: `${f.name}=false`, named: { ...requiredOnly, [f.name]: false }, expect: { ok: true } });
    }
    const textBad = mismatchFor(f.schema, { text: true });
    if (textBad !== undefined) variants.push({ name: `${f.name} type-mismatch`, named: { ...requiredOnly, [f.name]: textBad }, expect: { ok: false, error: "invalid_input", field: f.name }, planted: textBad });
    const jsonBad = mismatchFor(f.schema, { text: false });
    if (jsonBad !== undefined && jsonBad !== textBad) {
      variants.push({ name: `${f.name} type-mismatch (json)`, named: { ...requiredOnly, [f.name]: jsonBad }, expect: { ok: false, error: "invalid_input", field: f.name }, planted: jsonBad, jsonOnly: true });
    }
  }
  // Free text = a field the schema alone constrains: a hinted or baseline field
  // is one the FIXTURE constrains (an agent name, a repo slug the tracker
  // accepts), so the quoted sample would be refused for the wrong reason.
  const freeText = fields.find((f) => hints[f.name] === undefined && !(f.name in baseline) && f.schema.safeParse(QUOTED_SAMPLE).success);
  if (freeText) variants.push({ name: `${freeText.name} with embedded quotes`, named: { ...requiredOnly, [freeText.name]: QUOTED_SAMPLE }, expect: { ok: true } });
  variants.push({ name: "unknown option", named: { ...requiredOnly, [UNKNOWN_OPTION]: MISMATCH_MARKER }, expect: { ok: false, error: "invalid_input", field: UNKNOWN_OPTION }, planted: MISMATCH_MARKER });
  const firstRequiredArg = fields.find((f) => f.kind === "arg" && f.required);
  if (firstRequiredArg) {
    const { [firstRequiredArg.name]: _omitted, ...rest } = requiredOnly;
    variants.push({ name: `missing argument ${firstRequiredArg.name}`, named: rest, expect: { ok: false, error: "invalid_input", field: firstRequiredArg.name } });
  }
  return { variants, missingSamples };
}

// ---- spelling a by-name input the way each surface does ---------------------------------------

/** Flatten nested option objects to dotted keys (`models.coding`). */
function flatten(named: Named, prefix = ""): [string, unknown][] {
  return Object.entries(named).flatMap(([k, v]) => {
    const key = `${prefix}${k}`;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return flatten(v as Named, `${key}.`);
    return [[key, v] as [string, unknown]];
  });
}

/** A text surface carries strings only. */
function asText(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** HTTP GET: kebab-case query keys, dotted for nested, scalars as text. */
export function toKebabQuery(named: Named): URLSearchParams {
  return new URLSearchParams(flatten(named).map(([k, v]) => [k.split(".").map(camelToKebab).join("."), asText(v)]));
}

/**
 * CLI argv / chat tokens: positionals in declared order (a `rest` argument is
 * split back into words so the grammar re-joins it), then `--kebab value`,
 * `--flag` for true, `--no-flag` for false, `--a.b value` for nested keys.
 */
export function toArgv(cmd: Pick<CommandDef<unknown>, "args" | "options">, named: Named): string[] {
  const args = cmd.args ?? [];
  const argNames = new Set(args.map((a) => a.name));
  const positional = args.flatMap((a) => {
    const v = named[a.name];
    if (v === undefined) return [];
    return a.rest ? asText(v).split(" ") : [asText(v)];
  });
  const shape = (cmd.options?.shape ?? {}) as Record<string, z.ZodType>;
  const flags = flatten(Object.fromEntries(Object.entries(named).filter(([k]) => !argNames.has(k)))).flatMap(([k, v]) => {
    const flag = `--${k.split(".").map(camelToKebab).join(".")}`;
    const top = shape[k.split(".")[0]];
    if (top && !k.includes(".") && isBooleanSchema(top)) {
      // A boolean flag never consumes the next token, so a non-boolean value
      // (the type-mismatch case) rides inline: `--dry-run=<value>`.
      if (typeof v === "boolean") return v ? [flag] : [`--no-${k.split(".").map(camelToKebab).join(".")}`];
      return [`${flag}=${asText(v)}`];
    }
    return [flag, asText(v)];
  });
  return [...positional, ...flags];
}

/**
 * One argv token as chat text, so that `tokenize` hands back exactly `t`. The
 * tokenizer has no backslash escape: a `"…"` or `'…'` span ends at its own
 * quote character, and adjacent spans concatenate into one token
 * (`--repo="acme/api"`). So a token needs quoting when it is empty or holds
 * whitespace or a quote character; a token with no `"` is one `"…"` span, one
 * with `"` but no `'` is one `'…'` span, and one with both alternates spans:
 * `a"b'c` → `"a"'"'"b'c"`.
 */
export function quoteChatToken(t: string): string {
  if (t !== "" && !/[\s"']/.test(t)) return t;
  if (!t.includes('"')) return `"${t}"`;
  if (!t.includes("'")) return `'${t}'`;
  return t
    .split('"')
    .map((piece) => (piece === "" ? "" : `"${piece}"`))
    .join(`'"'`);
}

/** Chat text: `<group> <verb>` + the argv tokens, each quoted as the tokenizer needs (`quoteChatToken`). */
export function toChatText(chatWords: readonly string[], argv: readonly string[]): string {
  return [...chatWords, ...argv.map(quoteChatToken)].join(" ");
}

// ---- the regression fence -----------------------------------------------------------------------

export interface CommandSnapshot {
  id: string;
  args: { name: string; type: string; required: boolean; rest?: true }[];
  options: { name: string; type: string; required: boolean; values?: unknown[] }[];
  surfaces: string[];
  action: string;
  /** The policy target `authorize` decides on: `command`, or the resolver's (`agent`). */
  resource: string;
  effect: string;
}

/** The policy target a command's `resource` resolver names for the given input
 *  (`command` when it has none). */
export function resourceTargetOf(cmd: Pick<CommandDef<unknown>, "id" | "resource">, named: Named, caller: Caller): string {
  const input = namedToInput(cmd as CommandDef<unknown>, named, "camel");
  return targetOfResource(resourceOf(cmd, "error" in input ? {} : input, caller));
}

/** A stable, sorted description of the catalogue: ids, argument and option
 *  names + kinds, exposed surfaces, action, policy target, effect. Checked in
 *  as a snapshot — a new or changed command must update it deliberately. */
export function catalogueSnapshot(cmds: readonly CommandDef<unknown>[]): CommandSnapshot[] {
  const probe = callerWith("cli", "cli:snapshot");
  return [...cmds]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((cmd) => ({
      id: cmd.id,
      args: (cmd.args ?? []).map((a) => ({ name: a.name, type: kindOf(a.schema), required: !acceptsUndefined(a.schema), ...(a.rest ? { rest: true as const } : {}) })),
      options: (Object.entries(cmd.options?.shape ?? {}) as [string, z.ZodType][]).map(([name, s]) => {
        const values = enumValuesOf(s);
        return { name, type: kindOf(s), required: !acceptsUndefined(s), ...(values.length > 0 ? { values } : {}) };
      }),
      surfaces: (["chat", "cli", "http", "mcp"] as const).filter((s) => cmd.surfaces?.[s] !== false),
      action: cmd.action,
      resource: resourceTargetOf(cmd, {}, probe),
      effect: cmd.effect,
    }));
}

/** The `jsonSchemaFor` property names, for the "no missing, no extras" check. */
export function schemaPropertyNames(cmd: Pick<CommandDef<unknown>, "id" | "args" | "options" | "describe">): string[] {
  const schema = jsonSchemaFor(cmd) as { properties: Record<string, unknown> };
  return Object.keys(schema.properties).sort();
}

/** The CLI flag spellings every option must appear under in help text. */
export function expectedFlags(cmd: Pick<CommandDef<unknown>, "options">): string[] {
  return Object.keys(cmd.options?.shape ?? {}).map(cliFlag);
}

// ---- docs -----------------------------------------------------------------------------------------

/**
 * The command ids listed in the catalogue table of features/command-registry.md:
 * the first markdown table after the `## Catalogue` heading, first column,
 * backticked `<group>.<verb>` ids. Empty when the section or table is missing.
 */
export function parseCatalogueTable(markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^##\s+Catalogue\b/.test(l));
  if (start < 0) return [];
  const ids: string[] = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const isRow = line.trim().startsWith("|");
    if (!isRow) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const first = line.trim().slice(1).split("|")[0].trim();
    const m = /^`([a-z][a-z0-9]*\.[a-z][a-z0-9]*)`$/.exec(first);
    if (m) ids.push(m[1]);
  }
  return ids.sort();
}

// ---- the suite's per-command knowledge ---------------------------------------------------------
// Shared with scripts/command-conformance-matrix.ts so the matrix the PR shows
// is the matrix the suite runs. Everything below is data + pure derivation.

/**
 * A caller-relative value: the suite's callers differ by surface (`access:power`
 * over HTTP, `mcp:power` over MCP, `cli:local` on the CLI, `slack:U…` in chat),
 * and a caller-scoped command (memory's own-scope records, invariant 4) takes
 * an input that names the caller. The token is substituted per surface
 * (`forCaller`) and folded back for cross-surface comparison (`withCallerToken`).
 */
export const CALLER_ID = "{caller.id}";

function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as unknown as T;
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) as unknown as T;
  return value;
}

/** Every `CALLER_ID` token in `value` → this caller's id. */
export function forCaller<T>(value: T, callerId: string): T {
  return mapStrings(value, (s) => s.split(CALLER_ID).join(callerId));
}

/** Every occurrence of this caller's id in `value` → the `CALLER_ID` token. */
export function withCallerToken<T>(value: T, callerId: string): T {
  return mapStrings(value, (s) => s.split(callerId).join(CALLER_ID));
}

/** The ids the generic fixture plants — deterministic, so the matrix can spell them. */
export const FIXTURE = {
  liveRun: "live-1",
  persistedRun: "fin-1",
  repo: "acme/api",
  channel: "slack:C1",
  /** The caller's own memory record; the only user scope a caller can reach is its own. */
  ownMemoryRecord: `mem:user:${CALLER_ID}:1`,
  /** The seeded MCP server (auth none) present in every tier the suite asks for. */
  mcpServer: "linear",
} as const;

/** Hints by FIELD NAME: a value the fixture honors (an id that exists, a slug
 *  the tracker accepts, a Worker name the deploy plan knows). A field with no
 *  hint gets a generic sample its schema accepts; a field that needs more than
 *  that fails the "every command has a happy path" fence, naming it. */
export const FIELD_HINTS: SampleHints = {
  id: FIXTURE.liveRun,
  beforeId: FIXTURE.persistedRun,
  repo: FIXTURE.repo,
  channel: FIXTURE.channel,
  agent: "coding",
  // deploy.*: `--only` and `--skip` must not cancel each other out (an empty plan is refused).
  only: "memory",
  skip: "sandbox",
  // config.set: per-agent maps keyed by a real agent name.
  models: { general: "anthropic/general-model" },
  efforts: { general: "low" },
  // mcp.*: the seeded server and a URL the SSRF guard admits.
  name: FIXTURE.mcpServer,
  url: "https://mcp.example.com/mcp",
  agents: "general,research",
};

/** Commands the generic fixture cannot drive on its own: `hints` override a
 *  field-name hint for this command; `baseline` options are present in EVERY
 *  variant. Each entry says why the generic sample is not enough. */
export const COMMAND_FIXTURES: Readonly<Record<string, { hints?: SampleHints; baseline?: Named; why: string }>> = {
  "config.show": { baseline: { channel: FIXTURE.channel }, why: "a machine caller has no origin channel — `--channel` is required there" },
  "config.set": { baseline: { channel: FIXTURE.channel, agent: "general" }, why: "as config.show, plus at least one setting (a bare `config set` is `nothing to set`)" },
  "config.clear": { baseline: { channel: FIXTURE.channel }, why: "as config.show" },
  "config.instructions": { baseline: { channel: FIXTURE.channel }, why: "as config.show" },
  "repo.reconfigure": { baseline: { ref: "main" }, why: "at least one change is required (a bare `repo reconfigure <slug>` is `nothing to reconfigure`)" },
  "memory.forget": { hints: { id: FIXTURE.ownMemoryRecord }, why: "the record must exist in the CALLER's own scope — the generic `id` hint is a run id" },
  "deploy.restart": { hints: { only: "bot" }, why: "`--only` is an enum of the one restartable Worker (`bot`) — the generic `only` hint (`memory`) is a deploy target" },
  "mcp.add": { hints: { name: "notion" }, baseline: { channel: FIXTURE.channel }, why: "the generic `name` hint is the seeded server (a duplicate); `--scope channel` needs a channel on machine surfaces" },
  "mcp.connect": { baseline: { channel: FIXTURE.channel }, why: "`--scope channel` needs a channel on machine surfaces" },
  "mcp.show": { baseline: { channel: FIXTURE.channel }, why: "as mcp.connect" },
  "mcp.remove": { baseline: { channel: FIXTURE.channel }, why: "as mcp.connect" },
  "mcp.list": { baseline: { channel: FIXTURE.channel }, why: "a machine caller has no origin channel" },
};

/** The suite's variants for one command: `exhaustiveVariants` over the shared
 *  hints, minus any case no exposed surface can carry (a JSON-only mismatch
 *  for a CLI-only command) — a variant that runs nowhere asserts nothing. */
export function variantsOf(cmd: Pick<CommandDef<unknown>, "id" | "args" | "options" | "surfaces" | "effect">): { variants: Variant[]; missingSamples: string[] } {
  const entry = COMMAND_FIXTURES[cmd.id];
  const { variants, missingSamples } = exhaustiveVariants(cmd, { ...FIELD_HINTS, ...entry?.hints }, entry?.baseline);
  return { variants: variants.filter((v) => SURFACE_METAS.some((s) => exposedOn(cmd, s, v))), missingSamples };
}

// ---- the surfaces, as data ---------------------------------------------------------------------------

export type SurfaceKey = "httpGet" | "httpPost" | "mcp" | "cli" | "chat";

export interface SurfaceMeta {
  key: SurfaceKey;
  /** Column header in the matrix. */
  column: string;
  exposure: SurfaceName;
  /** Carries typed JSON (numbers, booleans, objects) rather than text. */
  json: boolean;
  /** Returns the invoke JSON object (chat returns `renderText`). */
  machine: boolean;
}

export const SURFACE_METAS: readonly SurfaceMeta[] = [
  { key: "httpGet", column: "HTTP GET", exposure: "http", json: false, machine: true },
  { key: "httpPost", column: "HTTP POST", exposure: "http", json: true, machine: true },
  { key: "mcp", column: "MCP", exposure: "mcp", json: true, machine: true },
  { key: "cli", column: "CLI", exposure: "cli", json: false, machine: true },
  { key: "chat", column: "chat", exposure: "chat", json: false, machine: false },
];

/** Whether a variant of this command runs on this surface: the command exposes
 *  the surface, a write never rides GET, a JSON-only mismatch has no text spelling. */
export function exposedOn(cmd: Pick<CommandDef<unknown>, "surfaces" | "effect">, surface: SurfaceMeta, variant?: Variant): boolean {
  if (cmd.surfaces?.[surface.exposure] === false) return false;
  if (surface.key === "httpGet" && cmd.effect === "write") return false;
  if (variant?.jsonOnly && !surface.json) return false;
  return true;
}

/** The one code a rejected variant carries: the registry's `invalid_input`. */
export type RejectionCode = Extract<Variant["expect"], { ok: false }>["error"];

/** What a rejected variant must come back as on EVERY surface it is exposed
 *  on — one error vocabulary: a grammar surface (CLI argv, chat text) that
 *  refuses an unknown option or a missing argument before invoke reports the
 *  same `invalid_input` the registry's `parseInput` reports for that fault
 *  from a query string or a JSON body; only the usage hint differs. */
export function expectedRejection(variant: Variant): RejectionCode | undefined {
  return variant.expect.ok ? undefined : variant.expect.error;
}

// ---- the matrix -------------------------------------------------------------------------------------

export type MatrixCell = { kind: "ok" } | { kind: "rejected" } | { kind: "not-exposed" };

export interface MatrixRow {
  variant: string;
  /** The input as the CLI spells it (a JSON-only case: the POST body). */
  input: string;
  /** The code EVERY exposed cell of a rejected row carries (one vocabulary); absent on an accepted row. */
  rejection?: RejectionCode;
  cells: Record<SurfaceKey, MatrixCell>;
}

export interface MatrixCommand {
  id: string;
  describe: string;
  rows: MatrixRow[];
}

export interface ConformanceMatrix {
  commands: MatrixCommand[];
  authorization: AuthorizationMatrix;
  summary: { commands: number; surfaces: number; variants: number; cells: number };
}

// ---- authorization (R13): the fixed actor set × every command, decided by the table --------------
// Every gate is a policy row (features/authorization.md). The suite derives
// the expected admission of each command for each actor here — `authorize` over
// the resource the command names for its happy-path input — and drives the real
// adapters as those identities to check they agree. The roles are a legacy
// `permissions.*` + ingress-token deployment (`AUTHZ_SOURCE`), translated by the
// same `grantsFor` config uses; the suite's AUTHZ config.yaml mirrors it.

export interface AuthzRole {
  /** Platform-namespaced actor id; its prefix says which surface carries it (`carriedBy`). */
  id: string;
  /** Column header in the matrix. */
  column: string;
}

/** Every `<group>:read` / `<group>:write` of the catalogue — what the read-only and write-only tokens hold. */
export const AUTHZ_READS: readonly string[] = coreCommandGroups().map((g) => `${g}:read`);
export const AUTHZ_WRITES: readonly string[] = coreCommandGroups().map((g) => `${g}:write`);

export const AUTHZ_ROLES: readonly AuthzRole[] = [
  { id: "slack:UADMIN", column: "Slack admin" },
  { id: "slack:UPLAIN", column: "Slack user" },
  { id: "slack:UREPO", column: "Slack repoManagement" },
  { id: "slack:UCHAN", column: "Slack channelConfig" },
  { id: "mcp:dispatch", column: "token: dispatch only" },
  { id: "mcp:reader", column: "token: every read" },
  { id: "mcp:writer", column: "token: every write" },
  { id: "access:svc:reader", column: "service token: every read" },
  { id: "access:visitor", column: "browser: unlisted" },
  { id: "access:operator", column: "browser: operator" },
  { id: "cli:local", column: "cli" },
];

/** The legacy keys that name the roles — `permissions` as the suite's AUTHZ config.yaml spells them. */
export const AUTHZ_PERMISSIONS: NonNullable<GrantsSource["permissions"]> = {
  admins: ["slack:UADMIN"],
  repoManagement: ["slack:UREPO"],
  channelConfig: ["slack:UCHAN"],
  operators: ["access:operator"],
  serviceTokens: { reader: [...AUTHZ_READS] },
};

/** `SWITCHBOARD_INGRESS_TOKENS` for the token roles (the bearer is the role's subject). */
export const AUTHZ_INGRESS_TOKENS: NonNullable<GrantsSource["ingressTokens"]> = {
  dispatch: { subject: "dispatch", scopes: ["dispatch"] },
  reader: { subject: "reader", scopes: [...AUTHZ_READS] },
  writer: { subject: "writer", scopes: [...AUTHZ_WRITES] },
};

export const AUTHZ_SOURCE: GrantsSource = {
  permissions: AUTHZ_PERMISSIONS,
  ingressTokens: AUTHZ_INGRESS_TOKENS,
  agentNames: Object.keys(AGENTS),
  commandGroups: coreCommandGroups(),
};

/** The surface an actor id is carried by: `slack:` chat, `mcp:` MCP, `access:` HTTP (browser or service token), `cli:` the CLI. */
export function carriedBy(id: string): Caller["kind"] {
  if (id.startsWith("slack:")) return "chat";
  if (id.startsWith("mcp:")) return "mcp";
  if (id.startsWith("access:")) return "access";
  return "cli";
}

/** The `Actor` a role resolves to under `AUTHZ_SOURCE` — the CLI's one caller holds everything. */
export function roleActor(role: AuthzRole): Actor {
  return callerWith(carriedBy(role.id), role.id, role.id === "cli:local" ? "all" : grantsFor(role.id, AUTHZ_SOURCE)).actor;
}

/** The `Caller` a role drives a command as: its actor, plus a chat origin for Slack roles. */
export function roleCaller(role: AuthzRole, origin: { channelId: string; threadKey: string }): Caller {
  const actor = roleActor(role);
  const kind = carriedBy(role.id);
  return { kind, id: role.id, actor: kind === "chat" ? { ...actor, origin } : actor, ...(kind === "chat" ? { origin } : {}) };
}

export interface AuthorizationRow {
  id: string;
  action: string;
  /** The policy target decided on for the happy-path input. */
  resource: string;
  /** Role id → admitted by the table. */
  cells: Record<string, boolean>;
}

export interface AuthorizationMatrix {
  roles: readonly AuthzRole[];
  rows: AuthorizationRow[];
}

const MATRIX_ORIGIN = { channelId: "slack:CX", threadKey: "slack:CX:t1" };

/** The table's decision for one command × role on the happy-path input. */
export function admits(cmd: CommandDef<unknown>, role: AuthzRole): boolean {
  const caller = roleCaller(role, MATRIX_ORIGIN);
  const happy = variantsOf(cmd).variants.find((v) => v.name === "required-only")!;
  const input = namedToInput(cmd, forCaller(happy.named, role.id), "camel");
  return authorize(caller.actor, cmd.action, resourceOf(cmd, "error" in input ? {} : input, caller)).allow;
}

export function buildAuthorizationMatrix(catalogue: readonly CommandDef<unknown>[]): AuthorizationMatrix {
  const rows = [...catalogue]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map<AuthorizationRow>((cmd) => {
      const happy = variantsOf(cmd).variants.find((v) => v.name === "required-only")!;
      return { id: cmd.id, action: cmd.action, resource: resourceTargetOf(cmd, happy.named, roleCaller(AUTHZ_ROLES[0]!, MATRIX_ORIGIN)), cells: Object.fromEntries(AUTHZ_ROLES.map((role) => [role.id, admits(cmd, role)])) };
    });
  return { roles: AUTHZ_ROLES, rows };
}

/** One line per command whose action has NO policy row on the resource it
 *  authorizes — the loud failure a new command hits until the table names it. */
export function policyGaps(catalogue: readonly CommandDef<unknown>[]): string[] {
  const probe = callerWith("cli", "cli:probe");
  return catalogue
    .filter((cmd) => {
      const target = resourceTargetOf(cmd, variantsOf(cmd).variants.find((v) => v.name === "required-only")?.named ?? {}, probe);
      return !POLICY.some((rule) => rule.action === cmd.action && ruleTarget(rule) === target);
    })
    .map((cmd) => `${cmd.id}: no policy row for ${cmd.action} on ${resourceTargetOf(cmd, {}, probe)} — add one to src/core/authz/policy.ts (with its allow + deny cases in policy.test.ts)`);
}

export function renderAuthorizationMatrix(matrix: AuthorizationMatrix): string[] {
  const out = [
    "### Authorization (every surface asks the same table)",
    "",
    `Admission = \`authorize(actor, action, resource)\` over \`src/core/authz/policy.ts\` for the happy-path input, one column per actor of the fixed set (a legacy \`permissions.*\` + token deployment translated by \`grantsFor\`). ✅ admitted, ⛔ refused as \`unauthorized\` before parse. Refusals the DATA decides (the \`channel\` scope of \`config set\`, an MCP tier, a shared memory record) are the handler's and are asserted in the command tests, not here.`,
    "",
    `| Command | Action | Resource | ${matrix.roles.map((r) => r.column).join(" | ")} |`,
    `|---|---|---|${matrix.roles.map(() => ":-:").join("|")}|`,
  ];
  for (const row of matrix.rows) out.push(`| \`${row.id}\` | \`${row.action}\` | \`${row.resource}\` | ${matrix.roles.map((r) => (row.cells[r.id] ? "✅" : "⛔")).join(" | ")} |`);
  out.push("");
  return out;
}

export function buildConformanceMatrix(catalogue: readonly CommandDef<unknown>[]): ConformanceMatrix {
  const commands = [...catalogue]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map<MatrixCommand>((cmd) => {
      const { variants, missingSamples } = variantsOf(cmd);
      if (missingSamples.length > 0) throw new Error(`${cmd.id}: no sample for ${missingSamples.join(", ")}`);
      const rows = variants.map<MatrixRow>((variant) => {
        const input = variant.jsonOnly ? `POST ${JSON.stringify(variant.named)}` : toChatText(cmd.id.split("."), toArgv(cmd, variant.named));
        const rejection = expectedRejection(variant);
        const cells = Object.fromEntries(
          SURFACE_METAS.map((s): [SurfaceKey, MatrixCell] => {
            if (!exposedOn(cmd, s, variant)) return [s.key, { kind: "not-exposed" }];
            return [s.key, rejection === undefined ? { kind: "ok" } : { kind: "rejected" }];
          }),
        ) as Record<SurfaceKey, MatrixCell>;
        return { variant: variant.name, input, ...(rejection === undefined ? {} : { rejection }), cells };
      });
      return { id: cmd.id, describe: cmd.describe, rows };
    });
  const variants = commands.reduce((n, c) => n + c.rows.length, 0);
  const cells = commands.reduce((n, c) => n + c.rows.reduce((m, r) => m + Object.values(r.cells).filter((x) => x.kind !== "not-exposed").length, 0), 0);
  return { commands, authorization: buildAuthorizationMatrix(catalogue), summary: { commands: commands.length, surfaces: SURFACE_METAS.length, variants, cells } };
}

/** The assertions applied to every exercised cell, for the matrix's closing table. */
export const CROSS_CUTTING_ASSERTIONS: ReadonlyArray<{ name: string; assertion: string }> = [
  { name: "Name mapping", assertion: "`/api/<group>.<verb>`, the MCP tool `group_verb`, the CLI words `group verb`, and the chat form all resolve to this one command; an opted-out surface does not expose it (404 / no tool / usage / not a chat command)." },
  { name: "Schema exactness", assertion: "The MCP `inputSchema` is exactly `jsonSchemaFor(cmd)`: properties = the declared arguments + options, `required` = the non-optional ones, `additionalProperties: false`, enum values and defaults intact." },
  { name: "Help completeness", assertion: "CLI `--help` and chat `--help` name every `<argument>`, every `--option` flag, and the description." },
  { name: "Auth before parse", assertion: "Admission on every surface equals `authorize(caller.actor, cmd.action, resource)` over the policy table (the Authorization table below): a refused caller gets `unauthorized` (HTTP 403) even for a malformed input — the value is never parsed; a credential with no grants is refused on every command (fail-closed)." },
  { name: "Caller is what the adapter resolved", assertion: "The `Caller` the registry saw has the surface's kind and id (`access:<sub>`, `mcp:<subject>`, `cli:local`, the Slack user) and, in chat, the message's channel as its origin." },
  { name: "POST-only writes", assertion: "A write command over HTTP GET is 405 and never invoked; a read leaves the fixture fingerprint (runs, memory, config overrides, tracker, executors) byte-identical." },
  { name: "Same parsed input", assertion: "Every surface binds to the identical parsed `{ args, options }` (modulo the caller's own id)." },
  { name: "Identical invoke JSON", assertion: "HTTP GET, HTTP POST, MCP, and CLI `--json` return the same JSON as a direct `invoke` with that caller, identical across surfaces modulo the caller's own id; chat returns `renderText` of it." },
  { name: "Field named, value never echoed", assertion: "A refusal names the offending field (camelCase, `--kebab`, or `<name>`) and never repeats the submitted value; nothing ran." },
  { name: "No token, no secret", assertion: "No output carries a run capability token, the planted env secret, or a planted mismatch value." },
  { name: "Untrusted wrapping", assertion: "Stored free text reaches a machine surface only inside `wrapUntrusted` (preamble + fences)." },
  { name: "No real executor", assertion: "Every executing dependency (resident admin, deterministic ops, deploy runner, env bootstrap, run-stream source) is a recording stub; `fetch` and `node:child_process` are disarmed for the whole suite." },
];

const CELL_TEXT: Record<MatrixCell["kind"], string> = { ok: "✅", rejected: "⛔", "not-exposed": "—" };

const mdCell = (s: string) => s.replace(/\|/g, "\\|");

/** The Variant column: the name, plus — once per rejected row — the one code every ⛔ cell carries. */
export function renderVariantCell(row: Pick<MatrixRow, "variant" | "rejection">): string {
  return row.rejection === undefined ? mdCell(row.variant) : `${mdCell(row.variant)} → \`${row.rejection}\``;
}

export function renderConformanceMatrix(matrix: ConformanceMatrix): string {
  const { summary } = matrix;
  const out: string[] = [
    `**${summary.commands} commands × ${summary.surfaces} surfaces × ${summary.variants} variants = ${summary.cells} scenario cells** (a cell is one command × variant × exposed surface; ✅ = expected to succeed with identical output, ⛔ = expected refusal with the ONE code the row names — identical on every exposed surface, — = surface not exposed for this case).`,
    "",
  ];
  for (const cmd of matrix.commands) {
    out.push(`### \`${cmd.id}\``, "", cmd.describe, "", `| Variant | Input (as the CLI spells it) | ${SURFACE_METAS.map((s) => s.column).join(" | ")} |`, `|---|---|${SURFACE_METAS.map(() => ":-:").join("|")}|`);
    for (const row of cmd.rows) out.push(`| ${renderVariantCell(row)} | \`${mdCell(row.input)}\` | ${SURFACE_METAS.map((s) => CELL_TEXT[row.cells[s.key].kind]).join(" | ")} |`);
    out.push("");
  }
  out.push(...renderAuthorizationMatrix(matrix.authorization));
  out.push("### Cross-cutting assertions (every exercised cell)", "", "| Assertion | What is checked |", "|---|---|");
  for (const a of CROSS_CUTTING_ASSERTIONS) out.push(`| ${a.name} | ${mdCell(a.assertion)} |`);
  out.push("");
  return out.join("\n");
}
