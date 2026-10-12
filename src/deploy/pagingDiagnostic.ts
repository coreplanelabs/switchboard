import { createHmac, randomBytes } from "node:crypto";
import { closeSync, ftruncateSync, openSync, writeSync } from "node:fs";

const MAX_BYTES = 16_384;
const MAX_FRAMES = 8;
const FINAL_LOG_BYTES = 8_192;
const CONSUMER_READ_LOG_BYTES = 2_048;
const MAX_VERSIONS = 16;
const KEYS = ["per_page", "page_token", "next_page_token"] as const;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const kind = (v: unknown) => (v === undefined ? "absent" : v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export interface PagingObservation {
  phase: "before" | "after" | "failure";
  app: string;
  pageIndex: number;
  perPage?: unknown;
  requestedCursor: string | null;
  cumulativeCount: number;
  producerVersion?: string;
  producer?: "cloudflare-public-v2";
  page?: unknown;
  commandExit?: number;
  producerLog?: string;
  reason?:
    | "repeated-cursor"
    | "malformed-page"
    | "command-error"
    | "interrupted"
    | "scope-unavailable"
    | "credentials-unavailable"
    | "native-request-error"
    | "denied"
    | "native-http-error"
    | "native-api-error"
    | "unknown-state";
  publicMetadata?: { account: string; wireCursor: string | null; httpStatus?: number };
  cycle?: {
    cursor: string;
    firstSeen: Pick<PagingObservation, "pageIndex" | "requestedCursor" | "cumulativeCount">;
  };
}
export type PagingObserver = (event: PagingObservation) => void;

/** Only request/status lines from this owned command's producer log are read.
 * The URL itself and all headers/body lines stay out of the diagnostic. */
function httpFacts(text: string | undefined, app: string, digest: (s: string) => string, stage = "instances") {
  if (!text) return { available: false };
  let request: Record<string, unknown> | undefined;
  let status: number | undefined;
  let requestId: string | undefined;
  let inResponse = false;
  for (const line of text.split("\n")) {
    const start = line.match(/-- START CF API REQUEST: (\S+)/);
    if (start) {
      request = undefined;
      status = undefined;
      requestId = undefined;
      inResponse = false;
      try {
        const url = new URL(start[1]);
        const path = url.pathname;
        if (stage === "application-list") {
          if (!/^\/client\/v4\/accounts\/[^/]+\/containers\/dash\/applications$/.test(path)) continue;
        } else if (stage === "application-info") {
          if (!/^\/client\/v4\/accounts\/[^/]+\/containers\/(?:dash\/)?applications\/[^/]+$/.test(path)) continue;
          if (decodeURIComponent(path.split("/").at(-1)!) !== app) continue;
        } else {
          if (!/^\/client\/v4\/accounts\/[^/]+\/containers\/dash\/applications\/[^/]+\/instances$/.test(path)) continue;
          if (decodeURIComponent(path.split("/").at(-2)!) !== app) continue;
        }
        request = {
          path:
            stage === "application-list"
              ? "/accounts/<account>/containers/dash/applications"
              : stage === "application-info"
                ? "/accounts/<account>/containers/applications/<app>"
                : "/accounts/<account>/containers/dash/applications/<app>/instances",
          originHash: digest(url.origin),
          cursorHash: url.searchParams.has("page_token") ? digest(url.searchParams.get("page_token")!) : null,
          perPage: /^\d{1,4}$/.test(url.searchParams.get("per_page") ?? "")
            ? Number(url.searchParams.get("per_page"))
            : null,
        };
      } catch {
        /* Unknown or malformed URLs are unavailable, never copied. */
      }
    }
    if (!request) continue;
    const response = line.match(/-- START CF API RESPONSE: .*\b([1-5]\d{2})\s*$/);
    if (response) {
      status = Number(response[1]);
      inResponse = true;
    }
    if (line.includes("-- END CF API RESPONSE")) inResponse = false;
    const ray = line.match(/^\s*cf-ray\s*[:=]\s*([a-f0-9]{16,32}(?:-[a-z]{3})?)\s*$/i);
    if (ray && inResponse) requestId = ray[1];
  }
  return request
    ? { available: true, request, ...(status === undefined ? {} : { status }), ...(requestId ? { requestId } : {}) }
    : { available: false };
}

const READ_STAGES = ["application-list", "application-info", "instances"] as const;
const READ_REASONS = [
  "command-error",
  "interrupted",
  "invalid-json",
  "application-not-found",
  "application-list-shape",
  "application-shape",
  "malformed-page",
  "repeated-cursor",
  "native-http-error",
  "native-api-error",
  "denied",
] as const;
const ERROR_CLASSES = ["api-error", "producer-internal"] as const;
const RESPONSE_FORMATS = ["json", "html", "text", "absent"] as const;
const member = <T extends string>(values: readonly T[], value: unknown): T | "unknown" =>
  values.includes(value as T) ? (value as T) : "unknown";
const numberOrNull = (value: unknown, low: number, high: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= low && value <= high ? value : null;

/** Closed facts only: never copy a producer message, body, URL or header. */
export function closedReadEvidence(value: unknown) {
  const evidence = record(value) ? value : {};
  return {
    stage: member(READ_STAGES, evidence.stage),
    reason: member(READ_REASONS, evidence.reason),
    commandExit: numberOrNull(evidence.commandExit, 0, 255),
    httpStatus: numberOrNull(evidence.httpStatus, 100, 599),
    errorClass: member(ERROR_CLASSES, evidence.errorClass),
    responseFormat: member(RESPONSE_FORMATS, evidence.responseFormat),
    providerCodes: Array.isArray(evidence.providerCodes)
      ? [...new Set(evidence.providerCodes.filter((code) => numberOrNull(code, 0, 2_147_483_647) !== null))].slice(0, 8)
      : [],
  };
}
export type NativeReadEvidence = ReturnType<typeof closedReadEvidence>;

/** Decode the pinned CLI's error envelope without treating its free text as telemetry. */
export function nativeReadEvidence(input: {
  args: readonly string[];
  reason: NativeReadEvidence["reason"];
  commandExit?: number;
  output?: string;
  producerLog?: string;
}): NativeReadEvidence {
  const stage =
    input.args[0] !== "containers"
      ? "unknown"
      : input.args[1] === "list"
        ? "application-list"
        : input.args[1] === "info"
          ? "application-info"
          : input.args[1] === "instances"
            ? "instances"
            : "unknown";
  const http = stage === "unknown" ? undefined : httpFacts(input.producerLog, input.args[2] ?? "", () => "", stage);
  let errorClass = "unknown",
    responseFormat = "unknown";
  let providerCodes: unknown[] = [];
  const output = input.output ?? "";
  if (Buffer.byteLength(output) <= 65_536) {
    try {
      const envelope: unknown = JSON.parse(output.slice(output.indexOf("{")));
      const message = record(envelope) && typeof envelope.error === "string" ? envelope.error : "";
      const api = /^There has been an unknown error (?:listing containers|fetching instances)\.\n([\s\S]*)$/.exec(
        message,
      );
      if (api) {
        errorClass = "api-error";
        if (api[1] === "undefined") responseFormat = "absent";
        else {
          const body: unknown = JSON.parse(api[1]);
          responseFormat =
            typeof body === "string" ? (/^\s*(?:<!doctype html\b|<html\b)/i.test(body) ? "html" : "text") : "json";
          if (record(body) && Array.isArray(body.errors))
            providerCodes = body.errors.map((error) => (record(error) ? error.code : undefined));
        }
      } else if (/^There has been an internal error (?:listing containers|fetching instances)\.\n/.test(message)) {
        errorClass = "producer-internal";
      }
    } catch {
      /* Unrecognised output stays unknown. */
    }
  }
  return closedReadEvidence({
    stage,
    reason: input.reason,
    commandExit: input.commandExit,
    httpStatus: http && "status" in http ? http.status : null,
    errorClass,
    responseFormat,
    providerCodes,
  });
}

/** One bounded first-failure snapshot in the existing operator log/artifact.
 * Hashes correlate only within this capture; the ephemeral key is not stored. */
export function createPagingObserver(options: {
  log: (line: string) => void;
  source: string;
  expectedCommit: string;
  env: Record<string, string | undefined>;
  artifactFile?: string;
}): {
  observe: PagingObserver;
  close: () => void;
  setSource: (value: string) => void;
  recordConsumerReads: (reads: { health: unknown; application: unknown; instances: unknown }) => void;
} {
  const key = randomBytes(32);
  const digest = (s: string) => createHmac("sha256", key).update(s).digest("hex");
  const numeric = (s: string | undefined) => (/^\d{1,24}$/.test(s ?? "") ? s : null);
  const source = (s: string) => (/^[a-f0-9]{40}(?:-dirty)?$/.test(s) ? s : "unknown");
  const state: Record<string, unknown> = {
    schema: 1,
    source: source(options.source),
    expectedCommit: source(options.expectedCommit),
    run: numeric(options.env.GITHUB_RUN_ID),
    attempt: numeric(options.env.GITHUB_RUN_ATTEMPT),
    producer: "unknown",
    producerVersion: "unknown",
    job: /^[a-zA-Z0-9_-]{1,80}$/.test(options.env.GITHUB_JOB ?? "") ? options.env.GITHUB_JOB : null,
    cursorEncoding: "unavailable; request not started",
    originalError: null,
    truncated: false,
    frames: [] as Record<string, unknown>[],
  };
  const frames = state.frames as Record<string, unknown>[];
  let failed = false;
  let fd: number | undefined;
  let logBytes = 0;
  let fileUnavailable = false;
  let consumerReadsRecorded = false;
  const persist = () => {
    try {
      let text = JSON.stringify(state);
      while (Buffer.byteLength(text) > MAX_BYTES && frames.length > 1) {
        frames.splice(0, 1);
        state.truncated = true;
        text = JSON.stringify(state);
      }
      if (Buffer.byteLength(text) > MAX_BYTES) return;
      if (options.artifactFile && !fileUnavailable) {
        fd ??= openSync(options.artifactFile, "wx", 0o600);
        ftruncateSync(fd, 0);
        writeSync(fd, text, 0, "utf8");
      }
    } catch {
      fileUnavailable = true;
      state.diagnosticWriteProblem = "artifact-write-unavailable";
    }
  };
  const log = (data: Record<string, unknown>, final = false) => {
    const line = `[paging-diagnostic] ${JSON.stringify(data)}`;
    if (logBytes + Buffer.byteLength(line) + 1 > (final ? MAX_BYTES : MAX_BYTES - FINAL_LOG_BYTES)) return;
    logBytes += Buffer.byteLength(line) + 1;
    try {
      options.log(line);
    } catch {
      /* Observation never changes readiness. */
    }
  };
  const observe: PagingObserver = (event) => {
    if (failed || !["before", "after", "failure"].includes(event.phase)) return;
    if (event.producerVersion && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]{1,48})?$/.test(event.producerVersion))
      state.producerVersion = event.producerVersion;
    const isPublic = event.producer === "cloudflare-public-v2" || !!event.publicMetadata;
    state.producer = isPublic ? "cloudflare-public-v2" : "wrangler";
    const cursorEncoding = isPublic
      ? event.publicMetadata
        ? "direct GET query; URLSearchParams"
        : "unavailable; request not started"
      : "opaque argv string; pinned producer uses encodeURIComponent";
    state.cursorEncoding = cursorEncoding;
    const nextCursorProvenance = isPublic
      ? "public response result_info.next_page_token"
      : "CLI result_info; pinned producer forwards provider next-page field";
    const frame: Record<string, unknown> = {
      phase: event.phase,
      ...(isPublic
        ? {
            request: event.publicMetadata
              ? {
                  started: true,
                  method: "GET",
                  queryEncoding: "URLSearchParams",
                  perPage: numberOrNull(event.perPage, 1, Number.MAX_SAFE_INTEGER),
                  cursorParameter: event.requestedCursor === null ? "absent" : "page_token",
                }
              : { started: false },
          }
        : {
            argv: {
              shell: false,
              perPage: numberOrNull(event.perPage, 1, Number.MAX_SAFE_INTEGER),
              cursorFlag: event.requestedCursor === null ? "absent" : "--page-token",
            },
          }),
      appHash: digest(event.app),
      pageIndex: event.pageIndex,
      requestedCursorHash: event.requestedCursor === null ? null : digest(event.requestedCursor),
      cumulativeCount: event.cumulativeCount,
    };
    if (event.phase === "after") {
      const page = record(event.page) ? event.page : undefined;
      const meta = page && record(page.result_info) ? page.result_info : undefined;
      const rows = page && Array.isArray(page.instances) ? page.instances : [];
      const ids = rows.map((r) => (record(r) && typeof r.id === "string" ? r.id : null));
      const idsAvailable = !!page && Array.isArray(page.instances) && ids.every((id): id is string => id !== null);
      const versions = new Map<string, number>();
      for (const row of rows) {
        const version = record(row) && Number.isSafeInteger(row.version) ? String(row.version) : "unknown";
        const bucket = versions.has(version) || versions.size < MAX_VERSIONS - 1 ? version : "other";
        versions.set(bucket, (versions.get(bucket) ?? 0) + 1);
      }
      Object.assign(frame, {
        pageCount: page && Array.isArray(page.instances) ? rows.length : null,
        instancesType: kind(page?.instances),
        metadataType: kind(page?.result_info),
        metadata: Object.fromEntries(KEYS.map((k) => [k, kind(meta?.[k])])),
        unknownMetadataKeys: meta
          ? Object.keys(meta).filter((k) => !(KEYS as readonly string[]).includes(k)).length
          : 0,
        nextCursorHash: typeof meta?.next_page_token === "string" ? digest(meta.next_page_token) : null,
        reportedCursorHash: typeof meta?.page_token === "string" ? digest(meta.page_token) : null,
        nextCursorProvenance: isPublic && !page ? "unavailable" : nextCursorProvenance,
        reportedCursorProvenance: isPublic ? "unavailable" : "CLI field; producer may fall back to requested argv",
        rowIdsAvailable: idsAvailable,
        rowIdSetHash: idsAvailable ? digest([...new Set(ids)].sort().join("\0")) : null,
        versionHistogram: Object.fromEntries(versions),
        end:
          meta?.next_page_token === undefined
            ? "absent"
            : meta.next_page_token === null
              ? "null"
              : meta.next_page_token === ""
                ? "empty"
                : typeof meta.next_page_token === "string"
                  ? "continue"
                  : "malformed",
        http: httpFacts(event.producerLog, event.app, digest),
        ...(event.commandExit === undefined ? {} : { commandExit: event.commandExit }),
      });
    }
    if (event.publicMetadata) {
      const rows = record(event.page) && Array.isArray(event.page.instances) ? event.page.instances : [];
      const knownStates = new Set([
        "provisioning",
        "running",
        "failed",
        "stopping",
        "stopped",
        "unhealthy",
        "inactive",
        "unknown",
      ]);
      const states: Record<string, number> = {};
      for (const row of rows) {
        const state =
          record(row) && typeof row.state === "string" && knownStates.has(row.state) ? row.state : "unknown";
        states[state] = (states[state] ?? 0) + 1;
      }
      frame.http =
        event.publicMetadata.httpStatus !== undefined
          ? {
              available: true,
              request: {
                path: "/accounts/<account>/containers/applications/<app>/instances-v2",
                cursorHash: event.publicMetadata.wireCursor === null ? null : digest(event.publicMetadata.wireCursor),
                perPage: numberOrNull(event.perPage, 1, Number.MAX_SAFE_INTEGER),
              },
              ...(event.publicMetadata.httpStatus === undefined
                ? {}
                : { status: numberOrNull(event.publicMetadata.httpStatus, 100, 599) }),
            }
          : { available: false };
      frame.publicMetadata = {
        accountHash: digest(event.publicMetadata.account),
        applicationVersionAvailable: false,
        states,
        missingNames: rows.filter((r) => !record(r) || typeof r.name !== "string" || !r.name).length,
        emptyImages: rows.filter((r) => !record(r) || typeof r.image !== "string" || !r.image).length,
        actorRowsHash: digest(
          rows
            .map((r) => (record(r) && typeof r.id === "string" ? r.id : ""))
            .sort()
            .join("\0"),
        ),
        nameRowsHash: digest(
          rows
            .map((r) => (record(r) && typeof r.name === "string" ? r.name : ""))
            .sort()
            .join("\0"),
        ),
        imageRowsHash: digest(
          rows
            .map((r) => (record(r) && typeof r.image === "string" ? r.image : ""))
            .sort()
            .join("\0"),
        ),
      };
    }
    if (event.phase === "failure") {
      failed = true;
      const reason = [
        "repeated-cursor",
        "malformed-page",
        "command-error",
        "interrupted",
        "scope-unavailable",
        "credentials-unavailable",
        "native-request-error",
        "denied",
        "native-http-error",
        "native-api-error",
        "unknown-state",
      ].includes(event.reason ?? "")
        ? event.reason
        : "unknown";
      frame.reason = reason;
      if (reason === "repeated-cursor" && typeof event.cycle?.cursor === "string") {
        const nextCursorHash = digest(event.cycle.cursor);
        const first = event.cycle.firstSeen;
        frame.cycleWitness = {
          firstSeen: {
            pageIndex: numberOrNull(first.pageIndex, 1, Number.MAX_SAFE_INTEGER),
            requestedCursorHash: typeof first.requestedCursor === "string" ? digest(first.requestedCursor) : null,
            nextCursorHash,
            cumulativeCount: numberOrNull(first.cumulativeCount, 0, Number.MAX_SAFE_INTEGER),
          },
          repeated: {
            pageIndex: event.pageIndex,
            requestedCursorHash: frame.requestedCursorHash,
            nextCursorHash,
            cumulativeCount: event.cumulativeCount,
          },
          nextCursorProvenance,
          cursorEncoding,
        };
      }
      state.originalError = reason;
    }
    frames.push(frame);
    if (frames.length > MAX_FRAMES) {
      frames.splice(0, 1);
      state.truncated = true;
    }
    persist();
    log(frame);
    if (failed) {
      const capture: Record<string, unknown> & { frames: Record<string, unknown>[] } = {
        ...state,
        phase: "capture",
        artifactAvailable: fd !== undefined && !fileUnavailable,
        frames: [...frames],
      };
      while (
        Buffer.byteLength(JSON.stringify(capture)) + 24 > FINAL_LOG_BYTES - CONSUMER_READ_LOG_BYTES &&
        capture.frames.length > 3
      ) {
        capture.frames.shift();
        capture.truncated = true;
      }
      log(capture, true);
    }
  };
  return {
    observe,
    recordConsumerReads: (reads) => {
      if (consumerReadsRecorded) return;
      consumerReadsRecorded = true;
      const health = record(reads.health) ? reads.health : undefined;
      const status =
        health &&
        typeof health.status === "number" &&
        Number.isInteger(health.status) &&
        health.status >= 100 &&
        health.status <= 599
          ? health.status
          : null;
      const readKind = (read: unknown, inventory = false) => {
        if (!record(read)) return "unknown";
        if ("error" in read) return "read-error";
        if (inventory && Array.isArray(read.value)) return "complete";
        if (
          !inventory &&
          record(read.value) &&
          typeof read.value.version === "number" &&
          Number.isFinite(read.value.version)
        )
          return "available";
        return "unknown";
      };
      const predicates = {
        health:
          health && "error" in health
            ? "read-error"
            : status === null
              ? "unknown"
              : status === 200
                ? "available"
                : "non-200",
        healthStatus: health && "error" in health ? null : status,
        application: readKind(reads.application),
        instances: readKind(reads.instances, true),
      };
      const failures = Object.fromEntries(
        ["application", "instances"].flatMap((name) => {
          const read = reads[name as "application" | "instances"];
          return record(read) && "error" in read ? [[name, closedReadEvidence(read.diagnostic)]] : [];
        }),
      );
      state.consumerReads = predicates;
      if (Object.keys(failures).length) state.consumerFailures = failures;
      persist();
      log(
        {
          phase: "consumer-read",
          source: state.source,
          expectedCommit: state.expectedCommit,
          predicates,
          ...(Object.keys(failures).length ? { failures } : {}),
        },
        true,
      );
    },
    setSource: (value) => {
      if (!failed) {
        state.source = source(value);
        state.expectedCommit = source(value);
      }
    },
    close: () => {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* own handle only */
        }
        fd = undefined;
      }
    },
  };
}
