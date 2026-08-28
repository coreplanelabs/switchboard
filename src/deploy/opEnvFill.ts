// 1Password service-account env-fill (GitHub #72, "Area 6").
//
// Populates a deploy environment's Worker secrets from 1Password via a
// READ-ONLY service account. The safety posture is the whole point:
//
//   - UAT is the only environment that runs by default. Targeting `prod`
//     is REFUSED unless the operator ALSO passes the loud override flag
//     (`--i-understand-prod`) — see `buildPlan`. This holds for dry-run
//     AND apply: even *looking at* the prod plan is "targeting prod".
//   - The config file (deploy/op-env.jsonc) keeps every environment in its
//     own top-level section, so a UAT run can only ever read the refs under
//     `uat` — it never touches the `prod` section.
//   - Dry-run (the default) reads NOTHING from 1Password and calls wrangler
//     ZERO times. It prints the plan: secret NAMES + their op:// references
//     (vault/item/field — pointers, never resolved values).
//   - Apply requires OP_SERVICE_ACCOUNT_TOKEN in the environment; missing it
//     fails closed before a single secret is touched. Resolved values only
//     ever travel op-read -> wrangler stdin; they are never logged or put in
//     argv.
//
// The module is dep-injected (OpReader + WranglerRunner + log) so the whole
// flow is unit-testable with mocks and no real `op`/`wrangler` ever runs.
// The thin CLI wrapper (opEnvFillCli.ts) wires the real implementations.

import { join } from "node:path";

export type TargetName = "bot" | "resident";

/** All valid targets, in a stable order for `--target both` and plan output. */
export const TARGETS: readonly TargetName[] = ["bot", "resident"];

/** Worker directory per target, relative to the repo root. `wrangler secret
 *  put` runs with cwd set here so it picks up that Worker's wrangler.jsonc
 *  (and its Worker `name`) — no name needs to be passed. */
export const TARGET_DIRS: Record<TargetName, string> = {
  bot: "deploy/cloudflare",
  resident: "deploy/cloudflare-resident",
};

export function targetDir(target: TargetName, repoRoot: string): string {
  return join(repoRoot, TARGET_DIRS[target]);
}

/** Parsed config file: environment -> target -> secretName -> op:// ref. The
 *  top-level split by environment is the isolation boundary. */
export interface OpEnvConfig {
  [env: string]: {
    [target: string]: { [secretName: string]: string };
  };
}

/** A single planned action: set `secretName` on `target`'s Worker from `ref`. */
export interface PlanEntry {
  env: string;
  target: TargetName;
  secretName: string;
  ref: string;
  vault: string;
  item: string;
  field: string;
}

export interface FillOptions {
  env: string;
  targets: TargetName[];
  /** false (the default) = dry-run: plan only, no op-read, no wrangler. */
  apply: boolean;
  /** the loud opt-in that lets `--env prod` through. Default false. */
  allowProd: boolean;
}

/** Resolves an op:// reference to its secret value. Real impl shells out to
 *  `op read` with the service-account token; tests inject a mock. */
export interface OpReader {
  read(ref: string): Promise<string>;
}

/** Sets one secret on a Worker, value piped on stdin (never argv). Real impl
 *  runs `wrangler secret put <name>` in `cwd`; tests inject a mock. */
export interface WranglerRunner {
  putSecret(input: { name: string; value: string; cwd: string }): Promise<void>;
}

export interface FillDeps {
  config: OpEnvConfig;
  /** Slice of process.env — only OP_SERVICE_ACCOUNT_TOKEN is read. */
  env: { OP_SERVICE_ACCOUNT_TOKEN?: string };
  repoRoot: string;
  opReader: OpReader;
  wrangler: WranglerRunner;
  log: (line: string) => void;
}

export interface FillResult {
  applied: boolean;
  entries: PlanEntry[];
}

// ---------------------------------------------------------------------------
// JSONC parsing
// ---------------------------------------------------------------------------

/** Strip `//` line comments, block comments, and trailing commas from JSONC —
 *  WITHOUT touching string contents. This string-awareness is load-bearing:
 *  every op:// reference contains `//`, so a naive comment stripper would
 *  corrupt the config it is meant to read. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  let inString = false;
  let inLine = false;
  let inBlock = false;

  while (i < n) {
    const c = text[i];
    const next = i + 1 < n ? text[i + 1] : "";

    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < n) {
        // escape sequence: copy the escaped char verbatim, never interpret it
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }

    // outside string/comment
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (c === ",") {
      // drop a trailing comma: next non-whitespace char closes an object/array
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j++;
      if (j < n && (text[j] === "}" || text[j] === "]")) {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Parse + validate the config file text into an OpEnvConfig. Throws with a
 *  clear message on malformed JSON or the wrong shape. */
export function parseConfig(text: string): OpEnvConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonc(text));
  } catch (e) {
    throw new Error(`op-env config is not valid JSONC: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error('op-env config must be a JSON object of { <env>: { <target>: { <SECRET>: "op://…" } } }');
  }
  for (const [env, targets] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof targets !== "object" || targets === null || Array.isArray(targets)) {
      throw new Error(`op-env config: environment "${env}" must be an object of targets`);
    }
    for (const [target, secrets] of Object.entries(targets as Record<string, unknown>)) {
      if (typeof secrets !== "object" || secrets === null || Array.isArray(secrets)) {
        throw new Error(`op-env config: ${env}.${target} must be an object of SECRET_NAME -> op:// ref`);
      }
      for (const [name, ref] of Object.entries(secrets as Record<string, unknown>)) {
        if (typeof ref !== "string") {
          throw new Error(`op-env config: ${env}.${target}.${name} must be a string op:// ref`);
        }
      }
    }
  }
  return raw as OpEnvConfig;
}

// ---------------------------------------------------------------------------
// op:// reference parsing
// ---------------------------------------------------------------------------

/** Parse and validate a 1Password secret reference `op://<vault>/<item>/<field>`
 *  (a trailing section/field path is folded into `field`). Throws if malformed
 *  so a bad ref fails the plan loudly instead of silently resolving nothing. */
export function parseOpRef(ref: string): { vault: string; item: string; field: string } {
  if (!ref.startsWith("op://")) {
    throw new Error(`not a 1Password reference (must start with op://): "${ref}"`);
  }
  const parts = ref.slice("op://".length).split("/");
  if (parts.length < 3 || parts.some((p) => p.length === 0)) {
    throw new Error(`malformed op:// reference, expected op://<vault>/<item>/<field>: "${ref}"`);
  }
  return { vault: parts[0], item: parts[1], field: parts.slice(2).join("/") };
}

// ---------------------------------------------------------------------------
// planning (env selection + prod hard-guard)
// ---------------------------------------------------------------------------

export const PROD_ENV = "prod";

/** Build the ordered list of planned actions for the selected env + targets.
 *  This is where the prod hard-guard and env isolation live:
 *   - `env === "prod"` without `allowProd` is REFUSED (loud throw).
 *   - only refs under `config[env][target]` are ever read — the other
 *     environments' sections are untouched.
 *  Pure: no op-read, no wrangler; safe to call for dry-run and apply alike. */
export function buildPlan(config: OpEnvConfig, opts: FillOptions): PlanEntry[] {
  if (opts.env === PROD_ENV && !opts.allowProd) {
    throw new Error(
      "REFUSING to target prod. Prod is hard-guarded: pass --i-understand-prod to override " +
        "(this reads prod refs and writes prod Worker secrets). Default runs only touch UAT.",
    );
  }
  const envSection = config[opts.env];
  if (!envSection) {
    const available = Object.keys(config).join(", ") || "(none)";
    throw new Error(`unknown environment "${opts.env}". Configured environments: ${available}`);
  }
  if (opts.targets.length === 0) {
    throw new Error("no target selected. Pass --target bot, --target resident, or --target both.");
  }

  const entries: PlanEntry[] = [];
  for (const target of opts.targets) {
    const secrets = envSection[target];
    if (!secrets || Object.keys(secrets).length === 0) {
      throw new Error(`op-env config has no secrets for ${opts.env}.${target}`);
    }
    for (const [secretName, ref] of Object.entries(secrets)) {
      const { vault, item, field } = parseOpRef(ref);
      entries.push({ env: opts.env, target, secretName, ref, vault, item, field });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// plan rendering
// ---------------------------------------------------------------------------

/** Render the human-readable plan. Shows secret NAMES and their op:// refs
 *  (vault/item/field — pointers), never resolved values. */
export function renderPlan(entries: PlanEntry[], apply: boolean): string[] {
  const lines: string[] = [];
  const mode = apply ? "APPLY" : "DRY RUN";
  lines.push(`=== op-env-fill plan (${mode}) ===`);
  const byTarget = new Map<TargetName, PlanEntry[]>();
  for (const e of entries) {
    const list = byTarget.get(e.target) ?? [];
    list.push(e);
    byTarget.set(e.target, list);
  }
  for (const [target, list] of byTarget) {
    lines.push(`env=${list[0].env}  target=${target}  worker=${TARGET_DIRS[target]}  (${list.length} secrets)`);
    for (const e of list) {
      lines.push(`  ${e.secretName}  <-  op://${e.vault}/${e.item}/${e.field}`);
    }
  }
  if (!apply) {
    lines.push("DRY RUN — nothing read from 1Password, nothing written. Re-run with --apply to set these.");
  }
  return lines;
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

/** Run the fill. Dry-run (apply=false) prints the plan and returns without any
 *  op-read or wrangler call. Apply requires OP_SERVICE_ACCOUNT_TOKEN (fail
 *  closed) and, per secret, resolves the ref then pipes the value to wrangler. */
export async function runFill(opts: FillOptions, deps: FillDeps): Promise<FillResult> {
  const entries = buildPlan(deps.config, opts);
  for (const line of renderPlan(entries, opts.apply)) deps.log(line);

  if (!opts.apply) {
    return { applied: false, entries };
  }

  // apply path — fail closed if the service account is not present
  if (!deps.env.OP_SERVICE_ACCOUNT_TOKEN) {
    throw new Error(
      "OP_SERVICE_ACCOUNT_TOKEN is not set. Export a READ-ONLY, UAT-scoped 1Password " +
        "service-account token before --apply. Refusing to proceed.",
    );
  }

  for (const e of entries) {
    const value = await deps.opReader.read(e.ref); // resolved value stays local; never logged
    await deps.wrangler.putSecret({ name: e.secretName, value, cwd: targetDir(e.target, deps.repoRoot) });
    deps.log(`set ${e.secretName} on ${e.target} (from op://${e.vault}/${e.item}/${e.field})`);
  }
  deps.log(`APPLIED — set ${entries.length} secret(s).`);
  return { applied: true, entries };
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  env: string;
  targets: TargetName[];
  apply: boolean;
  allowProd: boolean;
  configPath: string;
}

export const DEFAULT_CONFIG_PATH = "deploy/op-env.jsonc";

/** Parse argv (without node/script prefix) into ParsedArgs. Pure + total:
 *  returns { error } instead of throwing so the CLI controls exit + usage. */
export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  let env: string | undefined;
  const targets: TargetName[] = [];
  let apply = false;
  let allowProd = false;
  let configPath = DEFAULT_CONFIG_PATH;

  const addTarget = (t: string): string | undefined => {
    if (t === "both") {
      for (const x of TARGETS) if (!targets.includes(x)) targets.push(x);
      return undefined;
    }
    if (t === "bot" || t === "resident") {
      if (!targets.includes(t)) targets.push(t);
      return undefined;
    }
    return `unknown --target "${t}" (expected bot, resident, or both)`;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inlineVal = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const takeVal = (): string | undefined => (inlineVal !== undefined ? inlineVal : argv[++i]);

    switch (flag) {
      case "--env": {
        const v = takeVal();
        if (!v) return { error: "--env requires a value (e.g. --env uat)" };
        env = v;
        break;
      }
      case "--target": {
        const v = takeVal();
        if (!v) return { error: "--target requires a value (bot, resident, or both)" };
        const err = addTarget(v);
        if (err) return { error: err };
        break;
      }
      case "--config": {
        const v = takeVal();
        if (!v) return { error: "--config requires a path" };
        configPath = v;
        break;
      }
      case "--apply":
        apply = true;
        break;
      case "--dry-run":
        apply = false;
        break;
      case "--i-understand-prod":
        allowProd = true;
        break;
      default:
        return { error: `unknown argument "${arg}"` };
    }
  }

  if (!env) return { error: "--env is required (e.g. --env uat)" };
  if (targets.length === 0) return { error: "--target is required (bot, resident, or both)" };
  return { env, targets, apply, allowProd, configPath };
}

export const USAGE = `op-env-fill — populate a deploy env's Worker secrets from 1Password (read-only service account)

Usage:
  op-env-fill --env <name> --target <bot|resident|both> [--apply] [--config <path>]

Flags:
  --env <name>          REQUIRED. Environment section to read (e.g. uat). prod is hard-guarded.
  --target <t>          REQUIRED. bot, resident, or both. Repeatable.
  --apply               Actually set secrets. Default (omitted) is a dry-run plan only.
  --dry-run             Explicit dry-run (the default): print the plan, touch nothing.
  --i-understand-prod   Loud override REQUIRED to target --env prod. Off by default.
  --config <path>       Config file (default: ${DEFAULT_CONFIG_PATH}).

Apply reads OP_SERVICE_ACCOUNT_TOKEN from the environment (a READ-ONLY, UAT-scoped
1Password service-account token). Values flow op-read -> wrangler stdin only; never logged.`;
