import type { RunStatus } from "../core/runRecord.js";
import type { RunView } from "../core/runsService.js";
import type { UnitFacts, UnitRun, UnitRunsView } from "../core/unitRuns.js";
import type { CostReport } from "../core/costs.js";
import type { UserCostReport } from "../core/costsByUser.js";
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

/** Where the run's files are served from (live-view.md item 26), present only
 *  when an artifact store is configured: the page builds each row's URL as
 *  `urlBase` + the event's key (percent-encoded per segment) — never a URL
 *  from the record — and appends `?t=<token>` on a live page, where the token
 *  is the capability exactly as it is for the stream. `retentionDays` is what
 *  an expired row says. */
export interface ArtifactsSeed {
  urlBase: string;
  retentionDays: number;
  token?: string;
}

/** The live run page: the client follows the token-scoped SSE stream; the two
 *  URLs carry the capability token exactly like the old inline script did. */
export interface RunLiveSeed {
  page: "run";
  mode: "live";
  id: string;
  eventsUrl: string;
  stopUrl: string;
  artifacts?: ArtifactsSeed;
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
  /** The runs this run spawned that the registry holds (agent-conductor item
   *  11) — the live path reads no store — oldest started first, each live child
   *  with its own token. Present only when there are any. */
  children?: UnitRunRowSeed[];
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
  /** Tokenless: a finished run's files are served under the same Access decision as the page. */
  artifacts?: ArtifactsSeed;
  /** The runs this run spawned (agent-conductor item 11: `runs children`),
   *  oldest started first, under the viewer's predicate — a live child with
   *  its token, as an index row carries it. Present only when there are any. */
  children?: UnitRunRowSeed[];
  /** The units of the plan runner instance whose story this record is
   *  (agent-ship item 17; the record's `run_meta.instanceId`), in the plan's
   *  order. Present only on the pipeline's own record, and only when the
   *  viewer may see the instance. */
  units?: UnitFacts[];
}

export interface RunNotFoundSeed {
  page: "runNotFound";
  retentionDays: number | null;
}

/** One run in a unit's or a conductor's listing: the view `runs unit` and
 *  `runs children` answer plus, for a LIVE row only, its capability token —
 *  the same rule as an index row (`RunIndexRowSeed`). A conductor's child
 *  carries no round or thread. */
export type UnitRunRowSeed = RunView & Partial<Pick<UnitRun, "round" | "thread">> & { token?: string };

/** The unit page (agent-ship item 17, "the unit is the reading unit"): what
 *  `runs unit <key>` answers, its live rows carrying their tokens, and the
 *  clock the relative times paint from. A unit the viewer may not see, or one
 *  that does not exist, is served the run 404 (`RunNotFoundSeed`) instead. */
export interface UnitSeed {
  page: "unit";
  view: Omit<UnitRunsView, "runs"> & { runs: UnitRunRowSeed[] };
  now: number;
  retentionDays: number | null;
}

/** The admin /residents listing, passed through as received (the view renders
 *  whatever the resident reports, defensively — never a contract the bot
 *  enforces). Values are JSON-safe by construction: they arrived as JSON.
 *  `runs` are the registry's live rows that name a repo — the runs that can be
 *  on a resident — under the viewer's `runs:read` predicate, each with its
 *  token as an index row carries it (resident-repos item 42); `now` is the
 *  server clock their stopwatches open from. The page keeps both current from
 *  the `/residents?stream=1` feed (`ResidentsFeedFrame`). */
export interface ResidentsIndexSeed {
  page: "residents";
  cap?: unknown;
  count?: unknown;
  residents: unknown[];
  now: number;
  runs: RunIndexRowSeed[];
}

/** One frame on the residents feed (`GET /residents?stream=1`): the registry's
 *  index event for a repo run the viewer may read — the same `upsert` /
 *  `removed` the runs index gets — or a fresh admin listing, pushed when a
 *  worktree binding can have changed (a run's `dispatch.workspace.attach` span
 *  ended, or its stream sealed after the release at run end). */
export type ResidentsFeedFrame =
  | { type: "upsert"; run: RunIndexRowSeed }
  | { type: "removed"; id: string }
  | { type: "residents"; cap?: unknown; count?: unknown; residents: unknown[] };

export interface ResidentDetailSeed {
  page: "resident";
  slug: string;
  record: unknown;
}

export interface CostsSeed {
  page: "costs";
  report: CostReport;
  groups: string[];
  /** Which tab the page opens on: the daily table, or cost by user (`?view=users`). */
  view: "daily" | "users";
  /** Present when `view` is `users`: the by-user report for the same group and range. */
  users?: UserCostReport;
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
  | UnitSeed
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
