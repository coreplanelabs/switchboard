// Every credential the bot process reads from its environment is a `Secret`
// (docs/reference/specs/routing-and-config.md item 19; docs/explanation/security-model.md).
// The value goes in at construction and comes out through `reveal()` — nowhere
// else: string conversion, JSON, `util.inspect` (so `console.log`), template
// literals and error messages all render `[secret:<NAME>]`. That is what makes
// "a key never reaches stdout, a log, a JSON body or a command line by
// accident" a property of the type rather than of a redaction regex: the
// redaction net (src/core/redact.ts) still covers strings that came from
// elsewhere (tool output, pasted text); a wrapped value never needs it.
//
// This module is the ONE place `process.env` is read for a credential. The
// ESLint rule in src/secretEnv.mjs refuses a raw `process.env.<SECRET>`, a
// computed `process.env[x]` and a bare `process.env` value in every other
// production file under src/, so a new leak fails `npm run lint` (and so CI).
// Which names are secrets is deploy/secrets.manifest.json — the same list the
// deploy tooling provisions from — plus the two dev-laptop fallbacks below.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_PATH, parseManifest } from "./deploy/secrets.js";
import { PACKAGE_ROOT } from "./packageRoot.js";

/** A read-only view of an environment: `process.env`, or a record a test builds. */
export type EnvRecord = Readonly<Record<string, string | undefined>>;

/** Credentials the code reads by name that the manifest does not provision: the
 *  static GitHub token a laptop uses instead of the App, and the E2B key of the
 *  `e2b` execution backend. The lint (src/secretEnv.mjs) carries the same two
 *  names; src/secrets.test.ts pins them equal. */
export const CREDENTIAL_FALLBACKS: readonly string[] = ["GH_TOKEN", "E2B_API_KEY"];

function manifestNames(): string[] {
  const raw = JSON.parse(readFileSync(join(PACKAGE_ROOT, MANIFEST_PATH), "utf8")) as unknown;
  const parsed = parseManifest(raw);
  if (!parsed.ok) throw new Error(`${MANIFEST_PATH} is invalid — ${parsed.problems.join("; ")}`);
  return parsed.manifest.secrets.map((s) => s.name);
}

/** Every environment variable that holds a credential: the manifest's names plus `CREDENTIAL_FALLBACKS`. */
export const SECRET_NAMES: ReadonlySet<string> = new Set([...manifestNames(), ...CREDENTIAL_FALLBACKS]);

export function isSecretName(name: string): boolean {
  return SECRET_NAMES.has(name);
}

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * A credential and the name it was read under. The value is a private field —
 * not an own property — so `Object.keys`, spread, `structuredClone` and
 * `JSON.stringify` see the name alone; every string conversion is the
 * placeholder. `reveal()` is the one way out: call it where the value crosses
 * a boundary (an SDK constructor, an `Authorization` header, a child
 * process's env) and nowhere before.
 */
export class Secret {
  readonly #value: string;
  readonly name: string;

  constructor(value: string, name: string) {
    this.#value = value;
    this.name = name;
    Object.freeze(this);
  }

  /** The value. The only accessor; grep for `.reveal()` to audit every boundary. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return `[secret:${this.name}]`;
  }
  toJSON(): string {
    return this.toString();
  }
  valueOf(): string {
    return this.toString();
  }
  [Symbol.toPrimitive](): string {
    return this.toString();
  }
  [INSPECT](): string {
    return this.toString();
  }
}

/** The credentials of one environment, each read at call time and wrapped. */
export interface Secrets {
  /** A secret the manifest (or `CREDENTIAL_FALLBACKS`) names, trimmed; undefined when unset or blank.
   *  Any other name is a programming error and throws — a new secret is added to the manifest first. */
  get(name: string): Secret | undefined;
  /** `get`, failing by name when the secret is unset — for the credentials the process cannot start without. */
  require(name: string): Secret;
  /** A credential whose variable the operator's config names (`apiKeyEnv`, `tokenEnv`,
   *  `credentialKeyEnv`, `dashboard.token.env`): any variable, trimmed, undefined when unset or blank. */
  named(envVar: string): Secret | undefined;
}

/** The secrets of `env`, read live: a value set after this call is seen by the next
 *  read. Values are trimmed — a `.env` line or a pasted secret often carries a
 *  trailing newline, and a bearer with one fails authentication with no useful
 *  message — so a value that is only whitespace is absent. */
export function secretsFrom(env: EnvRecord): Secrets {
  const named = (envVar: string): Secret | undefined => {
    const value = env[envVar]?.trim();
    if (value === undefined || value === "") return undefined;
    return new Secret(value, envVar);
  };
  const get = (name: string): Secret | undefined => {
    if (!isSecretName(name)) throw new Error(`${name} is not a secret ${MANIFEST_PATH} names — add it there first`);
    return named(name);
  };
  return {
    get,
    named,
    require(name) {
      const secret = get(name);
      if (!secret) throw new Error(`${name} is not set`);
      return secret;
    },
  };
}

/** The process's credentials, bound to `process.env` (loaded from `.env` first by
 *  src/loadEnv.ts, which every entry point imports before anything else). */
export const processSecrets: Secrets = secretsFrom(process.env);

/** `env` without its secrets: what code that wants an environment record may be
 *  handed. A frozen copy, so a later mutation of `process.env` is not visible
 *  through it and nothing can be written back. */
export function publicEnv(env: EnvRecord = process.env): EnvRecord {
  return Object.freeze(Object.fromEntries(Object.entries(env).filter(([name]) => !isSecretName(name))));
}
