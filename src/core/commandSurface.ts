import { z } from "zod";
import { acceptsUndefined, type ArgDef, type CommandDef, type CommandInput, type InvokeErrorCode } from "./commandRegistry.js";

// Everything a surface shows for a command, DERIVED from its definition (#157
// KTD20/KTD21). This is the only place a surface name or a grammar exists:
//   naming   — camelCase in TypeScript (`sinceMs`), `--kebab-case` on the CLI and
//              in chat, `group_verb` as the MCP tool name, `/api/group.verb` on
//              HTTP; `toSurfaceNames(id)` is the one id → names mapping.
//   grammar  — ONE tokenizer + binder for CLI argv and chat text:
//              `<group> <verb> <positional…> [--flag value | --flag=value |
//              --bool | --no-bool]…`, quoted values, kebab→camel into `options`,
//              positionals → `args`. A grammar rejection is the registry's own
//              `invalid_input` (ONE error vocabulary across surfaces: the same
//              fault — unknown option, missing argument, bad flag — carries the
//              same machine code whether a query string, a JSON body, argv or
//              chat text spelled it); the message is the human usage hint and
//              never echoes a submitted value (it may be a secret).
//   schema   — `jsonSchemaFor(cmd)` merges arguments (by name) and options into
//              the MCP `inputSchema`; the HTTP adapter addresses the same names.
//   help     — `usageLine` / `helpText` / `catalogueText` from the definition
//              (zod `.describe()` texts), so `runs get --help` and chat
//              `runs help` are never hand-written.
// Adapters call these and add transport only (features/command-registry.md).

export type CommandShape = Pick<CommandDef<unknown>, "id" | "args" | "options" | "describe">;

// ---- naming -----------------------------------------------------------------

export function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

export function kebabToCamel(s: string): string {
  return s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** `sinceMs` → `--since-ms` */
export function cliFlag(optionKey: string): string {
  return `--${camelToKebab(optionKey)}`;
}

/** `runs.list` → `runs_list` (dots are invalid in MCP tool names). */
export function mcpToolName(id: string): string {
  return id.replace(".", "_");
}

/** `runs.list` → `/api/runs.list` */
export function httpPath(id: string): string {
  return `/api/${id}`;
}

/** `runs.list` → `["runs", "list"]` — the CLI and chat words. */
export function cliWords(id: string): [string, string] {
  return id.split(".", 2) as [string, string];
}

/** `runs.list` → `"runs list"` */
export function chatForm(id: string): string {
  return cliWords(id).join(" ");
}

/** KTD2: `runs.list` → `/api/runs.list`, `runs_list`, `["runs","list"]`, `"runs list"`. */
export function toSurfaceNames(id: string): { http: string; mcp: string; cli: [string, string]; chat: string } {
  return { http: httpPath(id), mcp: mcpToolName(id), cli: cliWords(id), chat: chatForm(id) };
}

// ---- tokenizer ----------------------------------------------------------------

/** Slack (and word processors) turn `"` into `“ ”` and `'` into `‘ ’`; the
 *  grammar sees straight quotes only. */
export function normalizeQuotes(text: string): string {
  return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

/**
 * Whitespace-separated tokens with `"double"` and `'single'` quoting (a quoted
 * span may sit inside a token: `--repo="acme/api"`). An unterminated quote is
 * an error the adapters report as `invalid_input`, like any malformed tail.
 * Smart quotes are normalized first.
 */
export function tokenize(text: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
  const src = normalizeQuotes(text);
  const tokens: string[] = [];
  let cur = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (const ch of src) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) tokens.push(cur);
      cur = "";
      inToken = false;
      continue;
    }
    cur += ch;
    inToken = true;
  }
  if (quote) return { ok: false, error: "unterminated quote" };
  if (inToken) tokens.push(cur);
  return { ok: true, tokens };
}

// ---- schema introspection --------------------------------------------------------

type ZodDef = { type: string; innerType?: z.ZodType; options?: z.ZodType[]; in?: z.ZodType };

function defOf(schema: z.ZodType): ZodDef {
  return (schema as unknown as { _zod: { def: ZodDef } })._zod.def;
}

/** Strip optional/nullable/default wrappers so the JSON schema and the type
 *  hint describe the value, not the wrapper. */
function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema;
  for (;;) {
    const def = defOf(s);
    if ((def.type === "optional" || def.type === "nullable" || def.type === "default" || def.type === "nonoptional" || def.type === "readonly") && def.innerType) s = def.innerType;
    else return s;
  }
}

/** True for a boolean option (`z.boolean()`, the `flag` union, or either
 *  wrapped in optional/default) — the grammar's `--x` / `--no-x` forms. */
export function isBooleanSchema(schema: z.ZodType): boolean {
  const def = defOf(unwrap(schema));
  if (def.type === "boolean") return true;
  if (def.type === "union") return (def.options ?? []).some(isBooleanSchema);
  if (def.type === "pipe" && def.in) return isBooleanSchema(def.in);
  return false;
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(unwrap(schema), { io: "input" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

/**
 * KTD11: the MCP `inputSchema` (and any JSON-Schema consumer) — one object whose
 * properties are the arguments (by declared name, described) plus the options
 * (camelCase keys); `required` lists the non-optional arguments and options.
 * Unknown properties are refused, as the registry refuses unknown options.
 */
export function jsonSchemaFor(cmd: CommandShape): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of cmd.args ?? []) {
    properties[arg.name] = { ...jsonSchemaOf(arg.schema), description: arg.describe };
    if (!acceptsUndefined(arg.schema)) required.push(arg.name);
  }
  if (cmd.options) {
    const opts = z.toJSONSchema(cmd.options, { io: "input" }) as { properties?: Record<string, unknown>; required?: string[] };
    Object.assign(properties, opts.properties ?? {});
    required.push(...(opts.required ?? []));
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false };
}

// ---- grammar (CLI argv + chat text) ----------------------------------------------

/** A fault the registry's own `parseInput` would refuse as `invalid_input` —
 *  the grammar just sees it first — so it carries that very code; `error` is
 *  the usage hint (the fault, then the derived usage line). */
export type GrammarRejection = { kind: "invalid"; code: Extract<InvokeErrorCode, "invalid_input">; error: string };
export type GrammarResult = { kind: "invoke"; input: CommandInput } | { kind: "help" } | GrammarRejection;

const FLAG_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/i;

/** `["models","coding"]` → `obj.models.coding = value`; a scalar already at an
 *  intermediate key is an error (`--models x --models.coding y`). */
export function setDotted(target: Record<string, unknown>, path: string[], value: unknown): boolean {
  let node = target;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (next === undefined) {
      const child: Record<string, unknown> = {};
      node[key] = child;
      node = child;
    } else if (typeof next === "object" && next !== null && !Array.isArray(next)) {
      node = next as Record<string, unknown>;
    } else {
      return false;
    }
  }
  const last = path[path.length - 1];
  if (last in node) return false;
  node[last] = value;
  return true;
}

/**
 * Bind the tokens AFTER `<group> <verb>` to the command's arguments and
 * options. `--flag value`, `--flag=value`, `--bool`, `--no-bool`, `--a.b value`
 * (dotted keys nest); kebab-case flags map to the camelCase option keys; `--`
 * ends option parsing; `--help`/`-h` asks for help. Positional tokens fill the
 * declared arguments in order; a trailing `rest` argument takes every remaining
 * token joined by single spaces. A rejection is `invalid` (code
 * `invalid_input`); its message names the flag or the argument, never a value,
 * and ends with the usage line.
 */
export function parseInvocation(cmd: CommandShape, tokens: readonly string[]): GrammarResult {
  const invalid = (error: string): GrammarRejection => ({ kind: "invalid", code: "invalid_input", error: `${error}\nusage: ${usageLine(cmd)}` });
  const shape = cmd.options?.shape ?? {};
  const positional: string[] = [];
  const options: Record<string, unknown> = {};
  let optionsEnded = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (optionsEnded || !t.startsWith("-") || t === "-" || /^-\d/.test(t)) {
      positional.push(t);
      continue;
    }
    if (t === "--help" || t === "-h") return { kind: "help" };
    if (t === "--") {
      optionsEnded = true;
      continue;
    }
    if (!t.startsWith("--")) return invalid(`unknown option ${t} (options are --kebab-case)`);
    const body = t.slice(2);
    const eq = body.indexOf("=");
    const rawKey = eq < 0 ? body : body.slice(0, eq);
    const inline = eq < 0 ? undefined : body.slice(eq + 1);
    if (!FLAG_KEY.test(rawKey)) return invalid(`bad option --${rawKey}`);
    let path = rawKey.split(".").map(kebabToCamel);
    let negated = false;
    if (!(path[0] in shape) && path.length === 1 && path[0].startsWith("no") && /^no[A-Z]/.test(path[0])) {
      const plain = path[0].slice(2, 3).toLowerCase() + path[0].slice(3);
      if (plain in shape && isBooleanSchema(shape[plain] as z.ZodType)) {
        path = [plain];
        negated = true;
      }
    }
    const schema = shape[path[0]] as z.ZodType | undefined;
    if (!schema) return invalid(`unknown option --${rawKey}`);
    const boolean = path.length === 1 && isBooleanSchema(schema);
    let value: unknown;
    if (negated) {
      if (inline !== undefined) return invalid(`--${rawKey} takes no value`);
      value = false;
    } else if (boolean) {
      value = inline === undefined ? true : inline;
    } else {
      value = inline ?? tokens[++i];
      if (value === undefined) return invalid(`option --${rawKey} needs a value`);
    }
    if (!setDotted(options, path, value)) return invalid(`option --${rawKey} given twice`);
  }

  const declared = cmd.args ?? [];
  const rest = declared.length > 0 && declared[declared.length - 1].rest ? declared[declared.length - 1] : undefined;
  const fixed = rest ? declared.slice(0, -1) : declared;
  const args: unknown[] = positional.slice(0, fixed.length);
  if (rest) {
    if (positional.length > fixed.length) args.push(positional.slice(fixed.length).join(" "));
  } else if (positional.length > declared.length) {
    return invalid(declared.length === 0 ? `${chatForm(cmd.id)} takes no arguments` : `unexpected argument: ${chatForm(cmd.id)} takes at most ${declared.length}`);
  }
  const missing = declared.find((a, i) => args[i] === undefined && !acceptsUndefined(a.schema));
  if (missing) return invalid(`missing argument <${missing.name}>`);
  return { kind: "invoke", input: { args, options } };
}

/**
 * The JSON surfaces (HTTP query/body, MCP arguments) address arguments and
 * options by name in ONE flat object. Split it: declared argument names →
 * `args` (in order), everything else → `options`. `keys: "kebab"` maps query
 * string spellings (`since-ms`, `models.coding`) onto the camelCase, nested
 * option keys; `"camel"` (JSON) takes keys as they are, dotted keys still nest.
 */
export function namedToInput(cmd: CommandShape, named: Record<string, unknown>, keys: "kebab" | "camel"): CommandInput | { error: string } {
  const argNames = new Set((cmd.args ?? []).map((a) => a.name));
  const options: Record<string, unknown> = {};
  const byName: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(named)) {
    const path = rawKey.split(".").map((seg) => (keys === "kebab" ? kebabToCamel(seg) : seg));
    if (path.length === 1 && argNames.has(path[0])) {
      byName[path[0]] = value;
      continue;
    }
    if (!setDotted(options, path, value)) return { error: `option ${path.join(".")} given twice` };
  }
  return { args: (cmd.args ?? []).map((a) => byName[a.name]), options };
}

// ---- help ----------------------------------------------------------------------

/** `soft|hard`, `true|false`, `integer`, `string` — from the JSON schema.
 *  Exported so the reference-docs generator (`src/docs/reference.ts`) prints
 *  the same value vocabulary the help output does, from one implementation. */
export function typeHint(schema: z.ZodType): string {
  const js = jsonSchemaOf(schema) as { enum?: unknown[]; type?: string; anyOf?: { type?: string; enum?: unknown[] }[] };
  if (js.enum) return js.enum.map(String).join("|");
  if (js.anyOf) {
    const parts = js.anyOf.flatMap((a) => (a.enum ? a.enum.map(String) : a.type ? [a.type] : []));
    return [...new Set(parts)].join("|");
  }
  return js.type ?? "value";
}

/** `runs stop <id> --mode <soft|hard>`; optional parts in brackets, free text as `<text…>`. */
export function usageLine(cmd: CommandShape): string {
  const parts = [chatForm(cmd.id)];
  for (const arg of cmd.args ?? []) {
    const name = arg.rest ? `${arg.name}…` : arg.name;
    parts.push(acceptsUndefined(arg.schema) ? `[${name}]` : `<${name}>`);
  }
  for (const [key, schema] of Object.entries(cmd.options?.shape ?? {}) as [string, z.ZodType][]) {
    const flag = cliFlag(key);
    const form = isBooleanSchema(schema) ? flag : `${flag} <${typeHint(schema)}>`;
    parts.push(acceptsUndefined(schema) ? `[${form}]` : form);
  }
  return parts.join(" ");
}

/** One argument or option as help shows it: the form (`<id>`, `--mode <soft|hard>`,
 *  `--dry-run`) and its description with the `(optional)`/`(required)` marker. */
export interface HelpRow {
  form: string;
  describe: string;
}

/** The content of a command's help — what every surface's `…HelpText` lays out.
 *  Arguments are optional by exception (`(optional)` when the schema accepts
 *  undefined); options are optional by default (`(required)` when it does not). */
export function helpRows(cmd: CommandShape): { arguments: HelpRow[]; options: HelpRow[] } {
  const args = (cmd.args ?? []).map((a) => ({ form: `<${a.name}>`, describe: `${a.describe}${acceptsUndefined(a.schema) ? " (optional)" : ""}` }));
  const options = (Object.entries(cmd.options?.shape ?? {}) as [string, z.ZodType][]).map(([key, schema]) => ({
    form: isBooleanSchema(schema) ? cliFlag(key) : `${cliFlag(key)} <${typeHint(schema)}>`,
    describe: [schema.description, acceptsUndefined(schema) ? undefined : "(required)"].filter(Boolean).join(" "),
  }));
  return { arguments: args, options };
}

/** The whole help for one command, terminal shape: description, usage, one
 *  column-aligned line per argument and option (zod `.describe()` texts). */
export function helpText(cmd: CommandShape): string {
  const rows = helpRows(cmd);
  const width = Math.max(0, ...[...rows.arguments, ...rows.options].map((r) => r.form.length));
  const lines = [cmd.describe, `usage: ${usageLine(cmd)}`];
  for (const [header, section] of [["arguments:", rows.arguments], ["options:", rows.options]] as const) {
    if (section.length === 0) continue;
    lines.push(header);
    for (const r of section) lines.push(`  ${r.form.padEnd(width)}  ${r.describe}`.trimEnd());
  }
  return lines.join("\n");
}

/** One line per command: `  runs list  — describe`. */
export function catalogueText(cmds: readonly CommandShape[]): string {
  const width = Math.max(0, ...cmds.map((c) => chatForm(c.id).length));
  return cmds.map((c) => `  ${chatForm(c.id).padEnd(width)}  — ${c.describe}`).join("\n");
}

// Chat (Slack) renders in a proportional font, where the padded columns of
// `helpText`/`catalogueText` collapse into ragged runs of spaces (2026-08-30 for
// the bare `help`, 2026-09-04 for `<group> help` and `--help`). The chat shapes
// carry the same derived content as bullets with the form in a code span.

/** One bullet per command: `• \`runs list\` — describe`. */
export function chatCatalogueText(cmds: readonly CommandShape[]): string {
  return cmds.map((c) => `• \`${chatForm(c.id)}\` — ${c.describe}`).join("\n");
}

/** The same `helpRows` in chat shape: description, usage in a code span, a
 *  bold section header and one bullet per argument and option. */
export function chatHelpText(cmd: CommandShape): string {
  const rows = helpRows(cmd);
  const lines = [cmd.describe, `usage: \`${usageLine(cmd)}\``];
  for (const [header, section] of [["*arguments*", rows.arguments], ["*options*", rows.options]] as const) {
    if (section.length === 0) continue;
    lines.push(header);
    for (const r of section) lines.push(r.describe ? `• \`${r.form}\` — ${r.describe}` : `• \`${r.form}\``);
  }
  return lines.join("\n");
}

/** Which of `cmds` share `group` — for `<group> help`. */
export function commandsInGroup(cmds: readonly CommandShape[], group: string): CommandShape[] {
  return cmds.filter((c) => cliWords(c.id)[0] === group);
}
