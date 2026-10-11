import { createHmac, randomBytes } from "node:crypto";
import { closeSync, ftruncateSync, openSync, writeSync } from "node:fs";

const MAX_BYTES = 16_384;
const MAX_FRAMES = 8;
const FINAL_LOG_BYTES = 8_192;
const MAX_VERSIONS = 16;
const KEYS = ["per_page", "page_token", "next_page_token"] as const;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const kind = (v: unknown) => (v === undefined ? "absent" : v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export interface PagingObservation {
  phase: "before" | "after" | "failure";
  app: string;
  pageIndex: number;
  requestedCursor: string | null;
  cumulativeCount: number;
  producerVersion?: string;
  page?: unknown;
  commandExit?: number;
  producerLog?: string;
  reason?: "repeated-cursor" | "malformed-page" | "command-error" | "interrupted";
}
export type PagingObserver = (event: PagingObservation) => void;

/** Only request/status lines from this owned command's producer log are read.
 * The URL itself and all headers/body lines stay out of the diagnostic. */
function httpFacts(text: string | undefined, app: string, digest: (s: string) => string) {
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
        if (!/^\/client\/v4\/accounts\/[^/]+\/containers\/dash\/applications\/[^/]+\/instances$/.test(url.pathname))
          continue;
        if (decodeURIComponent(url.pathname.split("/").at(-2)!) !== app) continue;
        request = {
          path: "/accounts/<account>/containers/dash/applications/<app>/instances",
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

/** One bounded first-failure snapshot in the existing operator log/artifact.
 * Hashes correlate only within this capture; the ephemeral key is not stored. */
export function createPagingObserver(options: {
  log: (line: string) => void;
  source: string;
  expectedCommit: string;
  env: Record<string, string | undefined>;
  artifactFile?: string;
}): { observe: PagingObserver; close: () => void; setSource: (value: string) => void } {
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
    producer: "wrangler",
    producerVersion: "unknown",
    job: /^[a-zA-Z0-9_-]{1,80}$/.test(options.env.GITHUB_JOB ?? "") ? options.env.GITHUB_JOB : null,
    cursorEncoding: "opaque argv string; pinned producer uses encodeURIComponent",
    originalError: null,
    truncated: false,
    frames: [] as Record<string, unknown>[],
  };
  const frames = state.frames as Record<string, unknown>[];
  let failed = false;
  let fd: number | undefined;
  let logBytes = 0;
  let fileUnavailable = false;
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
    const frame: Record<string, unknown> = {
      phase: event.phase,
      argv: { shell: false, perPage: 100, cursorFlag: event.requestedCursor === null ? "absent" : "--page-token" },
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
        nextCursorProvenance: "CLI result_info; pinned producer forwards provider next-page field",
        reportedCursorProvenance: "CLI field; producer may fall back to requested argv",
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
    if (event.phase === "failure") {
      failed = true;
      const reason = ["repeated-cursor", "malformed-page", "command-error", "interrupted"].includes(event.reason ?? "")
        ? event.reason
        : "unknown";
      frame.reason = reason;
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
      while (Buffer.byteLength(JSON.stringify(capture)) + 24 > FINAL_LOG_BYTES && capture.frames.length > 3) {
        capture.frames.shift();
        capture.truncated = true;
      }
      log(capture, true);
    }
  };
  return {
    observe,
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
