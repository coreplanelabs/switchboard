// Agent env bootstrap (GitHub #72) — populate the agent's EXECUTION ENVIRONMENT
// (the shell where its `bash` tool runs) with a DOWNSTREAM service's UAT
// environment variables, resolved from 1Password via a READ-ONLY service
// account scoped to a UAT vault. When the agent then runs a downstream
// service's real toolchain (tests, a deploy to that service's UAT), it holds
// that service's UAT creds — never its prod.
//
// This is NOT switchboard's own Worker-secret provisioning (that was the closed
// PR #77). Here the WRITE side materializes env vars into the execution env:
//   - apply writes a chmod-600 dotenv file the toolchain sources (`export …`),
//     and returns the same NAME->value map for the in-process integration hook
//     (buildAgentEnv) to merge into a sandbox's `envs`.
//
// The safety posture is the whole point:
//   - env-name ALLOWLIST: only "uat" is ever selectable (assertAllowedEnv).
//     Anything else — prod, an alias, a typo — is REFUSED before any resolve
//     or write, so a prod section in the manifest can never be materialized.
//     The REAL guard is operational: the service account MUST be read-only and
//     scoped to the UAT vault, so even a bug can only ever reach UAT creds.
//   - Dry-run (the default) reads NOTHING from 1Password and writes NOTHING.
//     It prints the plan: env-var NAMES + their op:// references
//     (vault/item/field — pointers, never resolved values).
//   - Apply requires OP_SERVICE_ACCOUNT_TOKEN in the environment; missing it
//     fails closed before a single ref is read. Resolved values only ever
//     travel op-read -> the 600 file contents / the returned map; they are
//     never logged and never put in argv.
//
// The module is dep-injected (OpReader + EnvSink + log) so the whole flow is
// unit-testable with mocks and no real `op` ever runs. The thin CLI wrapper
// (src/agentEnv/host.ts, behind the registry's `env bootstrap`) wires the real implementations.

import { shellQuote } from "../execution/shellQuote.js";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/** The only environment this tool will ever materialize. Adding to this list
 *  is a deliberate, reviewable act — it is the code-level half of the guard
 *  (the operational half is the read-only, UAT-scoped service account). */
export const ALLOWED_ENVS = ["uat"] as const;
export type AllowedEnv = (typeof ALLOWED_ENVS)[number];

/** Parsed manifest: environment -> downstream service -> ENV_VAR_NAME -> op://
 *  ref. Keyed env-first then service-first so it reads as "the UAT creds for
 *  <service>"; each service section is the set of env vars that service's
 *  toolchain needs. */
export interface AgentEnvManifest {
  [env: string]: {
    [service: string]: { [varName: string]: string };
  };
}

/** A single planned action: set env var `name` from `ref`. */
export interface PlanEntry {
  env: string;
  service: string;
  name: string;
  ref: string;
  vault: string;
  item: string;
  field: string;
}

export interface BootstrapOptions {
  env: string;
  service: string;
  /** false (the default) = dry-run: plan only, no op-read, no write. */
  apply: boolean;
  /** where the chmod-600 env file is written on apply. */
  outFile: string;
}

/** Resolves an op:// reference to its secret value. Real impl shells out to
 *  `op read` with the service-account token; tests inject a mock. */
export interface OpReader {
  read(ref: string): Promise<string>;
}

/** Writes the materialized env file. Real impl writes to disk with mode 600;
 *  tests inject a mock so no fs is touched. Values reach the sink only via
 *  `contents` — never logged. */
export interface EnvSink {
  writeEnvFile(input: { path: string; contents: string; mode: number }): Promise<void>;
}

export interface BootstrapDeps {
  manifest: AgentEnvManifest;
  /** Slice of process.env — only OP_SERVICE_ACCOUNT_TOKEN is read. */
  env: { OP_SERVICE_ACCOUNT_TOKEN?: string };
  opReader: OpReader;
  sink: EnvSink;
  log: (line: string) => void;
}

export interface BootstrapResult {
  applied: boolean;
  entries: PlanEntry[];
  /** present only on apply — the resolved NAME->value env map, i.e. the same
   *  payload the integration hook (buildAgentEnv) returns. */
  envMap?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// JSONC parsing
// ---------------------------------------------------------------------------

/** Strip `//` line comments, block comments, and trailing commas from JSONC —
 *  WITHOUT touching string contents. This string-awareness is load-bearing:
 *  every op:// reference contains `//`, so a naive comment stripper would
 *  corrupt the manifest it is meant to read. */
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

/** Valid POSIX-ish shell env var name. The value is shell-quoted on render,
 *  but the NAME is written verbatim into `export <name>=...`; validate it so a
 *  manifest typo or a future manifest-generation bug can't inject shell into a
 *  file whose whole purpose is to be sourced with authority. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse + validate the manifest text into an AgentEnvManifest. Throws with a
 *  clear message on malformed JSON or the wrong shape. */
export function parseManifest(text: string): AgentEnvManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonc(text));
  } catch (e) {
    throw new Error(`agent-env manifest is not valid JSONC: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error('agent-env manifest must be a JSON object of { <env>: { <service>: { <NAME>: "op://…" } } }');
  }
  for (const [env, services] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof services !== "object" || services === null || Array.isArray(services)) {
      throw new Error(`agent-env manifest: environment "${env}" must be an object of services`);
    }
    for (const [service, vars] of Object.entries(services as Record<string, unknown>)) {
      if (typeof vars !== "object" || vars === null || Array.isArray(vars)) {
        throw new Error(`agent-env manifest: ${env}.${service} must be an object of NAME -> op:// ref`);
      }
      for (const [name, ref] of Object.entries(vars as Record<string, unknown>)) {
        if (!ENV_NAME_RE.test(name)) {
          throw new Error(`agent-env manifest: ${env}.${service}.${name} is not a valid env var name (must match ${ENV_NAME_RE})`);
        }
        if (typeof ref !== "string") {
          throw new Error(`agent-env manifest: ${env}.${service}.${name} must be a string op:// ref`);
        }
      }
    }
  }
  return raw as AgentEnvManifest;
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
// env-name allowlist + planning
// ---------------------------------------------------------------------------

/** Enforce the UAT-only allowlist. Throws (fail closed) for anything not in
 *  ALLOWED_ENVS so a prod section — or an alias/typo — can never be selected.
 *  Called before any resolve or write. */
export function assertAllowedEnv(env: string): void {
  if (!(ALLOWED_ENVS as readonly string[]).includes(env)) {
    throw new Error(
      `REFUSING env "${env}". This tool only ever materializes downstream UAT creds; ` +
        `allowed: ${ALLOWED_ENVS.join(", ")}. The real guard is a READ-ONLY, ` +
        `UAT-vault-scoped 1Password service account — this allowlist is defense in depth.`,
    );
  }
}

/** Build the ordered list of planned actions for the selected env + service.
 *  Pure: no op-read, no write; safe for dry-run and apply alike. The allowlist
 *  is enforced here so it blocks even a dry-run of a non-uat env. Only refs
 *  under `manifest[env][service]` are ever read. */
export function buildPlan(manifest: AgentEnvManifest, sel: { env: string; service: string }): PlanEntry[] {
  assertAllowedEnv(sel.env);
  const envSection = manifest[sel.env];
  if (!envSection) {
    throw new Error(`manifest has no "${sel.env}" section`);
  }
  const vars = envSection[sel.service];
  if (!vars || Object.keys(vars).length === 0) {
    const available = Object.keys(envSection).join(", ") || "(none)";
    throw new Error(`manifest has no vars for ${sel.env}.${sel.service}. Configured services: ${available}`);
  }
  const entries: PlanEntry[] = [];
  for (const [name, ref] of Object.entries(vars)) {
    const { vault, item, field } = parseOpRef(ref);
    entries.push({ env: sel.env, service: sel.service, name, ref, vault, item, field });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/** Render the human-readable plan. Shows env-var NAMES and their op:// refs
 *  (vault/item/field — pointers), never resolved values. */
export function renderPlan(entries: PlanEntry[], opts: BootstrapOptions): string[] {
  const lines: string[] = [];
  const mode = opts.apply ? "APPLY" : "DRY RUN";
  lines.push(`=== agent-env-bootstrap plan (${mode}) ===`);
  lines.push(
    `env=${opts.env}  service=${opts.service}  vars=${entries.length}` +
      (opts.apply ? `  ->  ${opts.outFile} (mode 600)` : ""),
  );
  for (const e of entries) {
    lines.push(`  ${e.name}  <-  op://${e.vault}/${e.item}/${e.field}`);
  }
  if (!opts.apply) {
    lines.push("DRY RUN — nothing read from 1Password, nothing written. Re-run with --apply to materialize these.");
  }
  return lines;
}

/** Render the resolved env map as a sourceable, chmod-600 dotenv file. Each
 *  var is an `export NAME='value'` line (shell-quoted) so `source <file>`
 *  exports it whether or not the caller set `-a`. */
export function renderEnvFile(map: Record<string, string>, meta: { env: string; service: string }): string {
  const lines = [
    `# agent-env-bootstrap — downstream ${meta.env} env for service "${meta.service}".`,
    `# Resolved from 1Password (read-only, ${meta.env}-scoped service account). chmod 600.`,
    `# DO NOT COMMIT. Source it before running the toolchain:  set -a; . <this file>; set +a`,
  ];
  for (const [name, value] of Object.entries(map)) {
    lines.push(`export ${name}=${shellQuote(value)}`);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// resolving (fail-closed) — shared by runBootstrap and buildAgentEnv
// ---------------------------------------------------------------------------

/** Resolve a plan to a NAME->value env map. Fails closed if the service-account
 *  token is absent (before any read). Reads each ref exactly once; resolved
 *  values live only in the returned map — never logged. */
async function resolveEnvMap(
  entries: PlanEntry[],
  deps: { env: { OP_SERVICE_ACCOUNT_TOKEN?: string }; opReader: OpReader },
): Promise<Record<string, string>> {
  if (!deps.env.OP_SERVICE_ACCOUNT_TOKEN) {
    throw new Error(
      "OP_SERVICE_ACCOUNT_TOKEN is not set. Export a READ-ONLY, UAT-vault-scoped 1Password " +
        "service-account token before --apply. Refusing to resolve anything.",
    );
  }
  const map: Record<string, string> = {};
  for (const e of entries) {
    map[e.name] = await deps.opReader.read(e.ref); // stays local; never logged
  }
  return map;
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

/** Run the bootstrap. Dry-run (apply=false) prints the plan and returns without
 *  any op-read or write. Apply enforces the allowlist + token (both fail
 *  closed), resolves each ref, and writes ONE chmod-600 env file — logging only
 *  names/counts/path, never a value. */
export async function runBootstrap(opts: BootstrapOptions, deps: BootstrapDeps): Promise<BootstrapResult> {
  const entries = buildPlan(deps.manifest, { env: opts.env, service: opts.service });
  for (const line of renderPlan(entries, opts)) deps.log(line);

  if (!opts.apply) {
    return { applied: false, entries };
  }

  const envMap = await resolveEnvMap(entries, { env: deps.env, opReader: deps.opReader });
  const contents = renderEnvFile(envMap, { env: opts.env, service: opts.service });
  await deps.sink.writeEnvFile({ path: opts.outFile, contents, mode: 0o600 });

  deps.log(
    `APPLIED — materialized ${entries.length} var(s) [${entries.map((e) => e.name).join(", ")}] ` +
      `to ${opts.outFile} (mode 600). Values not shown.`,
  );
  return { applied: true, entries, envMap };
}

/** Integration hook: resolve a downstream service's UAT env map for injection
 *  into the agent's execution environment (merge into a sandbox's `envs`, the
 *  way src/execution/factory.ts's githubEnvs() supplies GH_TOKEN). Returns
 *  NAME->value; writes no file and logs no value. Enforces the UAT-only
 *  allowlist and the fail-closed token check. This is the clean seam the
 *  executor factory would call — see features/agent-env-bootstrap.md. */
export async function buildAgentEnv(input: {
  manifest: AgentEnvManifest;
  env: string;
  service: string;
  opReader: OpReader;
  processEnv?: { OP_SERVICE_ACCOUNT_TOKEN?: string };
}): Promise<Record<string, string>> {
  const entries = buildPlan(input.manifest, { env: input.env, service: input.service });
  const env = input.processEnv ?? { OP_SERVICE_ACCOUNT_TOKEN: process.env.OP_SERVICE_ACCOUNT_TOKEN };
  return resolveEnvMap(entries, { env, opReader: input.opReader });
}

/** Where the manifest lives unless `env bootstrap --manifest` names another file. */
export const DEFAULT_MANIFEST_PATH = "deploy/agent-env.jsonc";

