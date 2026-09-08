// The bot's base config as a DOCUMENT on the state Worker (features/routing-and-
// config.md item 14): `deploy config` (and `deploy all`, before the bot step)
// pushes the operator's config.yaml into the ConfigDO under the `base` key,
// and the bot reads it at startup when SWITCHBOARD_CONFIG is `state://base`
// instead of a file path. The image therefore carries no config: one artifact
// for every installation, and a config change is a push plus a container
// restart, never an image build. The overrides document (`config set …`) lives
// on the same object under its own key; this one is the file it layers over.
//
// Pure: the location grammar and the document shape. The client is a thin
// bearer-authenticated JSON POST, the same route contract the overrides
// backing uses (`/config/get`, `/config/put` with optimistic versions).

import { createHash } from "node:crypto";

/** The ConfigDO key the base config lives under; the overrides key is `overrides`. */
export const BASE_CONFIG_DOCUMENT_KEY = "base";
/** `SWITCHBOARD_CONFIG` value that means "read the document from the state Worker". */
export const STATE_CONFIG_LOCATION = `state://${BASE_CONFIG_DOCUMENT_KEY}`;
/** Where the bot finds the state Worker and its bearer when the location is `state://…`. */
export const STATE_WORKER_URL_ENV = "STATE_WORKER_URL";
export const STATE_WORKER_TOKEN_ENV = "MEMORY_TOKEN";

export type ConfigLocation = { kind: "file"; path: string } | { kind: "state"; key: string };

/** Pure: `SWITCHBOARD_CONFIG` is a file path, or `state://<key>` (`state://` alone means `base`). */
export function parseConfigLocation(value: string): ConfigLocation {
  if (value.startsWith("state://")) {
    const key = value.slice("state://".length);
    return { kind: "state", key: key === "" ? BASE_CONFIG_DOCUMENT_KEY : key };
  }
  return { kind: "file", path: value };
}

/** What `deploy config` stores: the YAML as written (comments survive), its
 *  digest, where it came from, and when. The bot parses `yaml`; the rest is
 *  what an operator reads back to know what is deployed. */
export interface BaseConfigDocument {
  yaml: string;
  sha256: string;
  source: string;
  pushedAt: string;
}

export function isBaseConfigDocument(value: unknown): value is BaseConfigDocument {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.yaml === "string" &&
    typeof v.sha256 === "string" &&
    typeof v.source === "string" &&
    typeof v.pushedAt === "string"
  );
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Pure: the document for a config text read from `source` at `now`. */
export function baseConfigDocument(yaml: string, source: string, now: Date): BaseConfigDocument {
  return { yaml, sha256: sha256Hex(yaml), source, pushedAt: now.toISOString() };
}

export interface ConfigDocumentClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type ReadBaseOutcome =
  { ok: true; document: BaseConfigDocument | null; version: number } | { ok: false; problem: string };

export type PushBaseOutcome = { ok: true; version: number } | { ok: false; problem: string };

/**
 * The ConfigDO client for the base document. Route contract (bearer = the state
 * Worker's MEMORY_TOKEN):
 *   POST /config/get {key}                            → {document: object | null, version}
 *   POST /config/put {key, document, expectedVersion} → {ok, version} | 409 {error, version}
 * Every failure is a problem sentence naming the Worker, never a throw.
 */
export class ConfigDocumentClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ConfigDocumentClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
  }

  async readBase(key = BASE_CONFIG_DOCUMENT_KEY): Promise<ReadBaseOutcome> {
    const r = await this.post("/config/get", { key });
    if (!r.ok) return r;
    const version = typeof r.body.version === "number" ? r.body.version : 0;
    const doc = r.body.document;
    if (doc === null || doc === undefined) return { ok: true, document: null, version };
    if (!isBaseConfigDocument(doc))
      return { ok: false, problem: `${this.describe()}: the "${key}" document is not a base config document` };
    return { ok: true, document: doc, version };
  }

  /** Read the current version, then put over it — a concurrent push is a 409 said as such, never a clobber. */
  async pushBase(document: BaseConfigDocument, key = BASE_CONFIG_DOCUMENT_KEY): Promise<PushBaseOutcome> {
    const current = await this.post("/config/get", { key });
    if (!current.ok) return current;
    const expectedVersion = typeof current.body.version === "number" ? current.body.version : 0;
    const put = await this.post("/config/put", { key, document, expectedVersion });
    if (!put.ok) return put;
    return { ok: true, version: typeof put.body.version === "number" ? put.body.version : expectedVersion + 1 };
  }

  describe(): string {
    return `state Worker ${this.baseUrl}`;
  }

  private async post(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; problem: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return {
        ok: false,
        problem: `${this.describe()}: ${path} failed — ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      if (res.ok) return { ok: false, problem: `${this.describe()}: ${path} answered non-JSON` };
    }
    if (res.status === 409)
      return {
        ok: false,
        problem: `${this.describe()}: ${path} → 409 version conflict (another push landed first; retry)`,
      };
    if (!res.ok)
      return {
        ok: false,
        problem: `${this.describe()}: ${path} → HTTP ${res.status}${typeof body.error === "string" ? ` (${body.error})` : ""}${res.status === 401 || res.status === 403 ? ` — is ${STATE_WORKER_TOKEN_ENV} the Worker's bearer?` : ""}`,
      };
    return { ok: true, body };
  }
}

/** The state Worker the bot (or the CLI) reads the base document from, per the
 *  environment: `STATE_WORKER_URL` + `MEMORY_TOKEN`. A problem names the variable. */
export function stateWorkerFromEnv(
  env: Record<string, string | undefined>,
): { ok: true; baseUrl: string; token: string } | { ok: false; problem: string } {
  const baseUrl = env[STATE_WORKER_URL_ENV];
  const token = env[STATE_WORKER_TOKEN_ENV];
  if (!baseUrl)
    return {
      ok: false,
      problem: `${STATE_WORKER_URL_ENV} is not set — SWITCHBOARD_CONFIG=state://… reads the config from the state Worker`,
    };
  if (!token) return { ok: false, problem: `${STATE_WORKER_TOKEN_ENV} is not set — the state Worker's bearer` };
  return { ok: true, baseUrl, token };
}
