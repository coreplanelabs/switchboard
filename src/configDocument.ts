// The bot's base config as a DOCUMENT on the state Worker (docs/reference/specs/routing-and-
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
import { isConfigPublicationSnapshotKey, type ConfigSourcePrecondition } from "./configPublicationProtocol.js";
export { isConfigPublicationSnapshotKey, type ConfigSourcePrecondition } from "./configPublicationProtocol.js";
import type { EnvRecord, Secret, Secrets } from "./secrets.js";

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

/** Identity of the base bytes installed by one successful config load. File
 * mode deliberately omits the local path from public process diagnostics. */
export interface LoadedBaseConfigReceipt {
  readonly schema: 1;
  readonly source: Readonly<{ kind: "state"; key: string; version: number } | { kind: "file" }>;
  readonly sha256: string;
}

export interface ProcessLoadedBaseConfigReceipt extends LoadedBaseConfigReceipt {
  readonly process: Readonly<{ commit: string; builtAt?: string; startedAt: string; generation?: string }>;
}

export function loadedBaseConfigReceipt(
  source: LoadedBaseConfigReceipt["source"],
  yaml: string,
): LoadedBaseConfigReceipt {
  return Object.freeze({ schema: 1, source: Object.freeze({ ...source }), sha256: sha256Hex(yaml) });
}

/** Bind one installed base to the process that serves it, once at boot. */
export function bindLoadedBaseConfigReceipt(
  loaded: LoadedBaseConfigReceipt,
  process: { commit: string; builtAt?: string; startedAt: number; generation?: string },
): ProcessLoadedBaseConfigReceipt {
  return Object.freeze({
    ...loaded,
    process: Object.freeze({
      commit: process.commit,
      ...(process.builtAt !== undefined ? { builtAt: process.builtAt } : {}),
      startedAt: new Date(process.startedAt).toISOString(),
      ...(process.generation !== undefined ? { generation: process.generation } : {}),
    }),
  });
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

export type PushBaseOutcome =
  { ok: true; version: number } | { ok: false; write: "not-written" | "unknown"; problem: string };

export interface ConfigSourceObservation {
  readonly key: string;
  readonly version: number;
  readonly sha256: string;
  readonly observedProcessCommit?: string;
  readonly application: Readonly<{ version: number; image: string }>;
}

/** Immutable private input evidence. This is data, never permission to restore. */
export interface ConfigPublicationSnapshot {
  readonly schema: 1;
  readonly kind: "base-config-publication";
  readonly publicationId: string;
  readonly stateWorkerUrl: string;
  readonly baseKey: string;
  readonly priorVersion: number;
  readonly priorDocument: Readonly<BaseConfigDocument> | null;
  readonly expectedCandidateVersion: number;
  readonly candidate: Readonly<BaseConfigDocument>;
  readonly inputSource?: Readonly<{ key: string; version: number; document: Readonly<BaseConfigDocument> | null }>;
}

export const CONFIG_PUBLICATION_SNAPSHOT_MAX_BYTES = 256 * 1024;

function validDocumentBytes(value: unknown): value is BaseConfigDocument {
  return isBaseConfigDocument(value) && sha256Hex(value.yaml) === value.sha256;
}

export function isConfigPublicationSnapshot(value: unknown): value is ConfigPublicationSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.schema === 1 &&
    v.kind === "base-config-publication" &&
    typeof v.publicationId === "string" &&
    isConfigPublicationSnapshotKey(`deploy-base-${v.publicationId}`) &&
    typeof v.stateWorkerUrl === "string" &&
    typeof v.baseKey === "string" &&
    typeof v.priorVersion === "number" &&
    Number.isSafeInteger(v.priorVersion) &&
    v.priorVersion >= 0 &&
    v.priorVersion < Number.MAX_SAFE_INTEGER &&
    v.expectedCandidateVersion === v.priorVersion + 1 &&
    (v.priorVersion === 0 ? v.priorDocument === null : validDocumentBytes(v.priorDocument)) &&
    validDocumentBytes(v.candidate) &&
    (v.inputSource === undefined || validConfigInputSource(v.inputSource))
  );
}

function validConfigInputSource(value: unknown): value is NonNullable<ConfigPublicationSnapshot["inputSource"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === "string" &&
    /^[a-z][a-z0-9-]{0,63}$/.test(v.key) &&
    typeof v.version === "number" &&
    Number.isSafeInteger(v.version) &&
    v.version >= 0 &&
    (v.version === 0 ? v.document === null : validDocumentBytes(v.document))
  );
}

function sameDocument(a: Readonly<BaseConfigDocument> | null, b: Readonly<BaseConfigDocument> | null): boolean {
  return a === null || b === null
    ? a === b
    : a.yaml === b.yaml && a.sha256 === b.sha256 && a.source === b.source && a.pushedAt === b.pushedAt;
}

export function sameConfigPublicationSnapshot(a: ConfigPublicationSnapshot, b: ConfigPublicationSnapshot): boolean {
  return (
    a.schema === b.schema &&
    a.kind === b.kind &&
    a.publicationId === b.publicationId &&
    a.stateWorkerUrl === b.stateWorkerUrl &&
    a.baseKey === b.baseKey &&
    a.priorVersion === b.priorVersion &&
    a.expectedCandidateVersion === b.expectedCandidateVersion &&
    sameDocument(a.priorDocument, b.priorDocument) &&
    sameDocument(a.candidate, b.candidate) &&
    (a.inputSource === undefined || b.inputSource === undefined
      ? a.inputSource === b.inputSource
      : a.inputSource.key === b.inputSource.key &&
        a.inputSource.version === b.inputSource.version &&
        sameDocument(a.inputSource.document, b.inputSource.document))
  );
}

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
    const doc = r.body.document;
    const version = r.body.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < (doc === null ? 0 : 1))
      return { ok: false, problem: `${this.describe()}: the "${key}" document has an invalid version` };
    if (doc === null && version === 0) return { ok: true, document: null, version };
    if (!isBaseConfigDocument(doc))
      return { ok: false, problem: `${this.describe()}: the "${key}" document is not a base config document` };
    if (sha256Hex(doc.yaml) !== doc.sha256)
      return { ok: false, problem: `${this.describe()}: the "${key}" document has a digest mismatch` };
    return { ok: true, document: doc, version };
  }

  /** A deployment supplies its pre-upload version. Direct config writes read once
   *  before sending; neither path refreshes a conflict or retries an unknown write. */
  async pushBase(
    document: BaseConfigDocument,
    key = BASE_CONFIG_DOCUMENT_KEY,
    expectedVersion?: number,
    source?: ConfigSourcePrecondition,
  ): Promise<PushBaseOutcome> {
    if (expectedVersion === undefined) {
      const current = await this.readBase(key);
      if (!current.ok) return { ...current, write: "not-written" };
      expectedVersion = current.version;
    }
    return this.putDocument(document, key, expectedVersion, source);
  }

  /** Create one unique input snapshot. A lost answer is unknown, never retried. */
  async recordPublicationSnapshot(key: string, snapshot: ConfigPublicationSnapshot): Promise<PushBaseOutcome> {
    if (!isConfigPublicationSnapshot(snapshot) || key !== `deploy-base-${snapshot.publicationId}`)
      return { ok: false, write: "not-written", problem: `${this.describe()}: invalid config input snapshot` };
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > CONFIG_PUBLICATION_SNAPSHOT_MAX_BYTES)
      return {
        ok: false,
        write: "not-written",
        problem: `${this.describe()}: config input snapshot exceeds the document size limit`,
      };
    return this.putDocument(snapshot, key, 0);
  }

  /** A fresh client can recover the exact private inputs after the CLI exits. */
  async readPublicationSnapshot(
    key: string,
  ): Promise<{ ok: true; snapshot: ConfigPublicationSnapshot } | { ok: false; problem: string }> {
    const read = await this.post("/config/get", { key });
    if (!read.ok) return read;
    if (
      read.body.version !== 1 ||
      !isConfigPublicationSnapshot(read.body.document) ||
      key !== `deploy-base-${read.body.document.publicationId}`
    )
      return { ok: false, problem: `${this.describe()}: config input snapshot is missing, changed or malformed` };
    return { ok: true, snapshot: read.body.document };
  }

  private async putDocument(
    document: BaseConfigDocument | ConfigPublicationSnapshot,
    key: string,
    expectedVersion: number,
    source?: ConfigSourcePrecondition,
  ): Promise<PushBaseOutcome> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER)
      return { ok: false, write: "not-written", problem: `${this.describe()}: invalid expected config version` };
    const put = await this.post("/config/put", {
      key,
      document,
      expectedVersion,
      ...(source ? { sourcePrecondition: source } : {}),
    });
    if (!put.ok) {
      const write =
        put.status !== undefined && [400, 401, 403, 404, 409, 413].includes(put.status) ? "not-written" : "unknown";
      return {
        ok: false,
        write,
        problem: write === "unknown" ? `${put.problem}; config write outcome unknown` : put.problem,
      };
    }
    if (source) {
      const applied = put.body.sourcePrecondition;
      if (
        typeof applied !== "object" ||
        applied === null ||
        Array.isArray(applied) ||
        (applied as Record<string, unknown>).key !== source.key ||
        (applied as Record<string, unknown>).version !== source.version
      )
        return {
          ok: false,
          write: "unknown",
          problem: `${this.describe()}: source precondition acknowledgement is missing or mismatched; config write outcome unknown`,
        };
    }
    const version = put.body.version;
    if (put.body.ok !== true || typeof version !== "number" || version !== expectedVersion + 1)
      return {
        ok: false,
        write: "unknown",
        problem: `${this.describe()}: /config/put acknowledgement is invalid; config write outcome unknown`,
      };
    return { ok: true, version };
  }

  describe(): string {
    return `state Worker ${this.baseUrl}`;
  }

  private async post(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; problem: string; status?: number }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const cause = configTransportCause(error);
      return { ok: false, problem: `${this.describe()}: ${path} request failed${cause ? ` — ${cause}` : ""}` };
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      return { ok: false, problem: `${this.describe()}: ${path} response body was not received` };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = text ? JSON.parse(text) : {};
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        if (res.ok) return { ok: false, problem: `${this.describe()}: ${path} answered a non-object` };
      } else body = parsed as Record<string, unknown>;
    } catch {
      if (res.ok) return { ok: false, problem: `${this.describe()}: ${path} answered non-JSON` };
    }
    if (res.status === 409)
      return {
        ok: false,
        status: res.status,
        problem: `${this.describe()}: ${path} → 409 version conflict (another push landed first)`,
      };
    if (!res.ok)
      return {
        ok: false,
        status: res.status,
        problem: `${this.describe()}: ${path} → HTTP ${res.status}${res.status === 401 || res.status === 403 ? ` — is ${STATE_WORKER_TOKEN_ENV} the Worker's bearer?` : ""}`,
      };
    return { ok: true, body };
  }
}

/** Transport messages can contain private request bytes; expose only known error names and codes. */
function configTransportCause(error: unknown): string {
  if (!(error instanceof Error)) return "";
  if (error.name === "TimeoutError") return "timeout";
  if (error.name === "AbortError") return "request aborted";
  const nested = error.cause;
  const code =
    (error as Error & { code?: unknown }).code ??
    (typeof nested === "object" && nested !== null ? (nested as { code?: unknown }).code : undefined);
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `DNS lookup failed (${code})`;
    case "ECONNREFUSED":
      return "connection refused (ECONNREFUSED)";
    case "ECONNRESET":
      return "connection reset (ECONNRESET)";
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return `timeout (${code})`;
    default:
      return "";
  }
}

/** The state Worker the bot (or the CLI) reads the base document from, per the
 *  environment: `STATE_WORKER_URL` (public) + the `MEMORY_TOKEN` secret. A problem names the variable. */
export function stateWorkerFrom(
  env: EnvRecord,
  secrets: Secrets,
): { ok: true; baseUrl: string; token: Secret } | { ok: false; problem: string } {
  const baseUrl = env[STATE_WORKER_URL_ENV];
  const token = secrets.get(STATE_WORKER_TOKEN_ENV);
  if (!baseUrl)
    return {
      ok: false,
      problem: `${STATE_WORKER_URL_ENV} is not set — SWITCHBOARD_CONFIG=state://… reads the config from the state Worker`,
    };
  if (!token) return { ok: false, problem: `${STATE_WORKER_TOKEN_ENV} is not set — the state Worker's bearer` };
  return { ok: true, baseUrl, token };
}
