import type { RunStatus } from "../core/runRecord.js";
import type { RunView } from "../core/runsService.js";
import type { CostReport } from "../core/costs.js";
import type { DeliveryReport } from "../core/delivery.js";
import type { ScheduledRow } from "./scheduledPanel.js";
import type { LiveFrame } from "./liveView/sse.js";
import type { Capabilities } from "../core/capabilities.js";

// The seed contract between the server and the web app (web/): every HTML
// route renders the same shell (webShell.ts) with one WebSeed embedded as a
// JSON island — the data that page paints from. The web app reads it back with
// `readSeed` semantics on its side; this module is the one place the shape is
// defined, imported by both (type-only from the web bundle's point of view,
// except the element id).
//
// Runtime-dependency-free by design: the web bundle imports this module.

/** One runs-index row: a `RunView` plus, for a LIVE row only, its capability
 *  token (the client builds the token href from it — a finished row never
 *  carries one; see docs/decisions/0013-capability-tokens-for-live-run-pages.md). */
export interface RunIndexRowSeed extends RunView {
  token?: string;
}

export interface RunsIndexSeed {
  page: "runs";
  /** `?all=1`: finished + persisted rows included; the feed keeps finished rows. */
  all: boolean;
  /** Configured run-history retention; null when history is off. */
  retentionDays: number | null;
  /** The server clock the initial relative times/stopwatches paint from. */
  now: number;
  rows: RunIndexRowSeed[];
  /** `?all=1` only: the service degraded to live rows → the banner text to
   *  show (the one message every surface uses, STORE_UNAVAILABLE_BANNER —
   *  passed as text so the web bundle never imports the command registry). */
  storeUnavailable?: string;
  /** `?all=1` only: next page's href when this page was full. */
  olderHref?: string;
  /** `?all=1` only: reached via cursor — the page holds runs finished before this stamp. */
  olderThan?: number;
}

export interface ScheduledSeed {
  page: "scheduled";
  now: number;
  /** null → no schedule registry configured. */
  rows: ScheduledRow[] | null;
  /** The reason firing history is unavailable (store missing or failing); absent when it loaded. */
  firingsUnavailable?: string;
}

/** The live run page: the client follows the token-scoped SSE stream; the two
 *  URLs carry the capability token exactly like the old inline script did. */
export interface RunLiveSeed {
  page: "run";
  mode: "live";
  id: string;
  eventsUrl: string;
  stopUrl: string;
  /** The server clock when the seed was built: the page projects it forward
   *  arrival-relative (`serverNow` + time since the seed arrived), so a live
   *  stopwatch never subtracts a server stamp from the browser's clock. */
  serverNow: number;
  /** The run's stamps (docs/reference/specs/tracing.md): the header's one duration opens at
   *  `receivedAt` (falling back to `startedAt`) and freezes at `finishedAt`. */
  startedAt: number;
  receivedAt?: number;
  finishedAt?: number;
  sealedAt?: number;
  replyOk?: boolean;
}

/** The history run page: the stored events (with AE11 omission markers already
 *  in place) are the whole stream — no EventSource, no stop controls. */
export interface RunHistorySeed {
  page: "run";
  mode: "history";
  id: string;
  events: LiveFrame[];
  status?: RunStatus;
  eventCount: number;
  /** The record's stamps (docs/reference/specs/tracing.md). */
  startedAt: number;
  receivedAt?: number;
  finishedAt?: number;
  sealedAt?: number;
  replyOk?: boolean;
  /** `runDurationMs(record)` — the one duration every surface prints. */
  durationMs?: number;
  /** The record was cut to its budget: the timeline's `not recorded` reads `(too large)`. */
  truncated?: boolean;
  /** The record predates span schema (docs/reference/specs/tracing.md): `events` carries
   *  no span set and the timeline states `no timing data` instead of a shape. */
  untimed?: true;
}

export interface RunNotFoundSeed {
  page: "runNotFound";
  retentionDays: number | null;
}

/** The admin /residents listing, passed through as received (the view renders
 *  whatever the resident reports, defensively — never a contract the bot
 *  enforces). Values are JSON-safe by construction: they arrived as JSON. */
export interface ResidentsIndexSeed {
  page: "residents";
  cap?: unknown;
  count?: unknown;
  residents: unknown[];
}

export interface ResidentDetailSeed {
  page: "resident";
  slug: string;
  record: unknown;
}

export interface CostsSeed {
  page: "costs";
  report: CostReport;
  groups: string[];
}

export interface DeliverySeed {
  page: "delivery";
  report: DeliveryReport;
  /** The configured repositories, for the switcher; the report's is one of them. */
  repos: string[];
}

/** One page's data, as its view builds it. */
export type PageSeed =
  | RunsIndexSeed
  | ScheduledSeed
  | RunLiveSeed
  | RunHistorySeed
  | RunNotFoundSeed
  | ResidentsIndexSeed
  | ResidentDetailSeed
  | CostsSeed
  | DeliverySeed;

/** What the island holds: the page's seed plus what is on in this process
 *  (src/core/capabilities.ts) — stamped by the shell renderer (webShell.ts),
 *  never by a view — so the nav, the tabs and the meta lines paint only the
 *  surfaces that exist in this installation. */
export type WebSeed = PageSeed & { capabilities: Capabilities };

/** The id of the `<script type="application/json">` seed island. */
export const SEED_ELEMENT_ID = "sb-seed";

/**
 * The seed as a JSON literal safe inside the island: every `<`, `>` and `&` is
 * `\uXXXX`-escaped (so no `</script>` — or any tag — can appear, whatever the
 * seeded text holds), as are U+2028/U+2029 (line terminators JSON allows but
 * JavaScript string literals do not — the island is data, but keeping the
 * output JS-safe costs nothing). Escapes are inside JSON strings only, so
 * `JSON.parse` returns the original value byte-for-byte.
 */
export function serializeSeed(seed: WebSeed): string {
  return JSON.stringify(seed).replace(
    /[<>&\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** The retention sentence shared by the index toggle tooltip and the 404 page —
 *  truthful in both configurations: with history off the registry TTL is all
 *  there is. (Moved from runsIndex.ts; the client renders it from
 *  `retentionDays`.) */
export function retentionSentence(retentionDays: number | null): string {
  if (retentionDays === null) return "Run history is off; finished runs are kept about a minute.";
  return `Finished runs are kept for ${retentionDays} day${retentionDays === 1 ? "" : "s"}, then deleted`;
}
