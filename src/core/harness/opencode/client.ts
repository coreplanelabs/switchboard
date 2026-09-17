// OpenCode's server API as this harness speaks it (docs/reference/specs/harness.md,
// the OpenCode process item): the routes and the request and response shapes
// of the calls the process unit makes and the units after it will, each
// hand-derived from the pinned `@opencode/protocol@2.0.3` and `@opencode/schema@2.0.3`
// sources and named with its file and line there, never from the docs (the
// API reference pages do not exist at this pin). The runtime imports nothing
// from those packages: they are devDependencies the test (`client.test.ts`)
// builds the pinned groups from, so a route or a field that drifts from the
// pin fails the test and not a run. Thin on purpose: a field a unit does not
// read is not here.

/** The version this build drives; the image pin and the readiness probe both name it. */
export const OPENCODE_VERSION = "2.0.3";

/** What `opencode --version` prints at the pin, exactly (measured; the image's grep names it). */
export const OPENCODE_VERSION_TEXT = `opencode v${OPENCODE_VERSION}`;

/** Basic auth is the one scheme `serve` reads (`packages/server/src/middleware/authorization.ts:34`:
 *  `/^Basic\s+(.+)$/i`, or `?auth_token=`); the username is fixed
 *  (`packages/server/src/auth.ts:16-17`). A Bearer header is refused with 401. */
export const OPENCODE_AUTH_USER = "opencode";

/** The `Authorization` header for the run's server password. */
export function openCodeAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`${OPENCODE_AUTH_USER}:${password}`).toString("base64")}`;
}

export interface OpenCodeRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
}

/** Every route this harness calls, keyed as the protocol package keys its
 *  endpoints (`<group>.<endpoint>`), with the source of each. A route with a
 *  session id is a function of it. */
export const OPENCODE_ROUTES = {
  /** `packages/protocol/src/groups/health.ts:16` — answers `Health`; behind the password like every route (`packages/server/src/process.ts:189-192`). */
  "health.get": { method: "GET", path: "/api/health" },
  /** `packages/protocol/src/groups/config.ts:9` — the loaded configuration entries, the readiness proof that the run's file took. */
  "config.get": { method: "GET", path: "/api/config" },
  /** `packages/protocol/src/groups/plugin.ts:24` — settles plugin activation (the relay plugin) before the first session; 204. */
  "plugin.awaitActivation": { method: "POST", path: "/api/plugin/await-activation" },
  /** `packages/protocol/src/groups/event.ts:43` — the SSE stream the tailer subscribes to; volatile by contract. */
  "event.subscribe": { method: "GET", path: "/api/event" },
  /** `packages/protocol/src/groups/session.ts:172`. */
  "session.create": { method: "POST", path: "/api/session" },
  /** `packages/protocol/src/groups/session.ts:192` — the authored session (the survival word). */
  "session.import": { method: "POST", path: "/api/session/import" },
} as const satisfies Record<string, OpenCodeRoute>;

/** The routes under one session, by its id. */
export const openCodeSessionRoutes = (sessionID: string) =>
  ({
    /** `packages/protocol/src/groups/session.ts:339` — admits one input; async: the answer is the inbox item, not the turn. */
    "session.prompt": { method: "POST", path: `/api/session/${sessionID}/prompt` },
    /** `packages/protocol/src/groups/session.ts:464` — BLOCKS until the agent loop is idle, then 204 (measured: a 239 s wait held open). */
    "session.wait": { method: "POST", path: `/api/session/${sessionID}/wait` },
    /** `packages/protocol/src/groups/session.ts:692` — `?continue=true|false`; answers `{ interrupted }`. */
    "session.interrupt": { method: "POST", path: `/api/session/${sessionID}/interrupt` },
    /** `packages/protocol/src/groups/message.ts:43` — `?order=asc|desc&limit=1..200&cursor=&type=`; the store, the record's truth. */
    "session.messages": { method: "GET", path: `/api/session/${sessionID}/message` },
    /** `packages/protocol/src/groups/permission.ts:85` — the pending asks the session owns. */
    "session.permission.list": { method: "GET", path: `/api/session/${sessionID}/permission` },
  }) as const satisfies Record<string, OpenCodeRoute>;

/** `packages/protocol/src/groups/permission.ts:113` — the reply to one ask; 204. */
export const openCodePermissionReplyRoute = (sessionID: string, requestID: string): OpenCodeRoute => ({
  method: "POST",
  path: `/api/session/${sessionID}/permission/${requestID}/reply`,
});

/** `GET /api/health` (`packages/protocol/src/groups/health.ts:5-9`): `healthy` is
 *  the literal `true`, `pid` is 0 on a runtime without a process identity. The
 *  status is 200 ready, 503 starting or stopping (`retry-after: 1`), 500 failed
 *  (`packages/server/src/process.ts:214-224`). */
export interface OpenCodeHealth {
  healthy: true;
  version: string;
  pid: number;
}

/** One entry of `GET /api/config` (`packages/schema/src/config.ts`: `Directory`,
 *  `Document`, `Entry`): a directory the loader scans, or a document it parsed
 *  with the configuration it read from it — normalized, a mistyped value
 *  dropped by key with a logged diagnostic and the rest kept
 *  (`packages/core/src/config.ts:118-147`), so presence in `info` is the proof
 *  a key took. */
export type OpenCodeConfigEntry =
  { type: "directory"; path: string } | { type: "document"; path: string; info: Record<string, unknown> };

/** `permissions` entries (`packages/schema/src/permission.ts:63-70`): evaluated
 *  by `findLast` over `[...agent.permissions, ...session.permissions]`
 *  (`packages/core/src/permission.ts:87-95, 168-177`), an unmatched action
 *  `ask`; a `deny` as the last matching rule on resource `*` hides the tool
 *  from the model (`packages/core/src/tool.ts:278-281`). */
export interface OpenCodePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

/** `POST /api/session` payload (`packages/protocol/src/groups/session.ts:173-181`). */
export interface OpenCodeSessionCreate {
  id?: string;
  title?: string;
  agent?: string;
  model?: { providerID: string; id: string; variant?: string };
  /** `packages/schema/src/location.ts:9-12`: an absolute directory; the project is resolved from it. */
  location?: { directory: string; workspaceID?: string };
  metadata?: Record<string, unknown>;
  /** "Evaluated after the agent's rules; the last matching rule wins" (`packages/schema/src/session.ts:58-59`). */
  permissions?: OpenCodePermissionRule[];
}

/** `Session.Info` (`packages/schema/src/session.ts:33-61`), the fields the harness reads. */
export interface OpenCodeSessionInfo {
  id: string;
  projectID: string;
  agent?: string;
  model?: { providerID: string; id: string; variant?: string };
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  /** Recorded at `time.idle`; absent until a run reaches a terminal transition. */
  outcome?: "succeeded" | "failed" | "interrupted";
  time: { created: number; updated: number; idle?: number };
  title?: string;
  location: { directory: string; workspaceID?: string };
  permissions?: OpenCodePermissionRule[];
}

/** `POST …/prompt` payload (`packages/protocol/src/groups/session.ts:341-348`;
 *  `packages/schema/src/prompt-input.ts:29-34`): there is no per-prompt system
 *  or tool set — both are the agent's. `steer` delivers at the next step
 *  boundary of a running execution, `queue` waits until idle
 *  (`packages/schema/src/session-inbox.ts:11`). */
export interface OpenCodePrompt {
  id?: string;
  text: string;
  metadata?: Record<string, unknown>;
  delivery?: "steer" | "queue";
  resume?: boolean;
}

/** The answer to a prompt: the admitted inbox item (`packages/schema/src/session-inbox.ts:59`), never the turn. */
export interface OpenCodeInboxUser {
  id: string;
  sessionID: string;
  timeCreated: number;
  type: "user";
  payload: { text: string };
  delivery: "steer" | "queue";
}

/** `Permission.Request` (`packages/schema/src/permission.ts:25-42`): `source`
 *  names the tool call (`messageID`, and `id` the call id) the ask is for —
 *  the join the gate uses; `resources` are the command, the path, the URL. */
export interface OpenCodePermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: { type: "tool"; messageID: string; id: string };
  message?: string;
}

/** `POST …/permission/:id/reply` payload (`packages/protocol/src/groups/permission.ts:115-118`).
 *  `always` persists a project rule (`packages/core/src/permission/saved.ts`) and is never sent. */
export interface OpenCodePermissionReply {
  reply: "once" | "reject";
  message?: string;
}

/** `Session.Message.Info` (`packages/schema/src/session-message.ts:295-320`), the
 *  three kinds the record reads and the fields it reads of them; every other
 *  kind (`agent-switched`, `model-switched`, `location-switched`, `synthetic`,
 *  `system`, `skill`, `shell`, `compaction`) keeps `id`, `type` and `time`. */
export interface OpenCodeMessageBase {
  id: string;
  type: string;
  time: { created: number; streamed?: number; completed?: number };
  metadata?: Record<string, unknown>;
}
/** `packages/schema/src/session-message.ts:74-81`: the prompt's text and attachments. */
export interface OpenCodeUserMessage extends OpenCodeMessageBase {
  type: "user";
  text: string;
  files?: unknown[];
  agents?: unknown[];
  skills?: unknown[];
}
/** `packages/schema/src/session-message.ts:211-235`: `content` is text, reasoning and tool parts. */
export interface OpenCodeAssistantMessage extends OpenCodeMessageBase {
  type: "assistant";
  agent: string;
  model: { providerID: string; id: string; variant?: string };
  content: Array<{ type: "text" | "reasoning" | "tool"; [key: string]: unknown }>;
  finish?: string;
  cost?: number;
}
/** `packages/schema/src/session-message.ts:288-293`: the marker after a turn
 *  settled, with the turn's outcome; every step since the previous marker is
 *  one turn. */
export interface OpenCodeIdleMessage extends OpenCodeMessageBase {
  type: "idle";
  outcome: "succeeded" | "failed" | "interrupted";
}
export type OpenCodeMessage =
  OpenCodeUserMessage | OpenCodeAssistantMessage | OpenCodeIdleMessage | OpenCodeMessageBase;

/** `GET …/message` answer (`packages/protocol/src/groups/message.ts:46-52`): a page and its cursors. */
export interface OpenCodeMessagesResponse {
  data: OpenCodeMessage[];
  cursor: { previous?: string; next?: string };
}

/** One event on `GET /api/event` (`packages/schema/src/event.ts:59-70`; the
 *  stream is `data: <json>\n\n` blocks with `: heartbeat` comments between,
 *  `server.connected` first). `durable` is present on the persisted kinds. */
export interface OpenCodeEvent {
  id: string;
  type: string;
  created?: number;
  location?: { directory: string; workspaceID?: string };
  metadata?: Record<string, unknown>;
  data: Record<string, unknown>;
  durable?: { aggregateID: string; seq: number; version: number };
}

/** `session.step.ended` (`packages/schema/src/session-event.ts:347-362`): the
 *  boundary the tailer refills the store at; `assistantMessageID` names the
 *  turn's message. */
export interface OpenCodeStepEnded {
  sessionID: string;
  assistantMessageID: string;
  finish: string;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
}

/** `session.tool.called` / `.success` / `.failed` (`packages/schema/src/session-event.ts:499-559`):
 *  `id` is the call id `permission.asked`'s `source.id` names, `tool` the tool. */
export interface OpenCodeToolEvent {
  sessionID: string;
  messageID: string;
  id: string;
  tool: string;
  executed: boolean;
}

/** The event kinds whose arrival means the store changed and the feed refills
 *  from it: a step's end, a step's failure, and the three ends of an execution
 *  (`packages/schema/src/session-event.ts:233-249, 347-379`). */
export const OPENCODE_REFILL_EVENTS: readonly string[] = [
  "session.step.ended",
  "session.step.failed",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
];

/** One line of the run's feed (`feed.jsonl`), as the tailer writes it and the
 *  harness reads it through the log transport: an event as the server sent
 *  it; the pending asks of one session; the messages of one session that
 *  changed since the tailer's previous refill of it (diffed by message id
 *  against the list it keeps); or a note of the tailer's own (started,
 *  connected, reconnected, stream closed, a refill that failed). `at` is the
 *  tailer's clock in the container; `reason` names the event type that
 *  caused a refill, or `reconnect`. */
export type OpenCodeFeedRecord =
  | { feed: "event"; at: number; event: OpenCodeEvent }
  | { feed: "permissions"; at: number; sessionID: string; reason: string; data: OpenCodePermissionRequest[] }
  | { feed: "messages"; at: number; sessionID: string; reason: string; data: OpenCodeMessage[] }
  | { feed: "tailer"; at: number; note: string; [detail: string]: unknown };

/** A feed line parsed, or nothing for a line that is not one. */
export function parseFeedRecord(line: string): OpenCodeFeedRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || !("feed" in value)) return undefined;
  const feed = (value as { feed: unknown }).feed;
  return feed === "event" || feed === "permissions" || feed === "messages" || feed === "tailer"
    ? (value as OpenCodeFeedRecord)
    : undefined;
}

/** The health answer parsed, or nothing for a body of another shape. */
export function parseHealth(body: string): OpenCodeHealth | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v.healthy !== true || typeof v.version !== "string") return undefined;
  return { healthy: true, version: v.version, pid: typeof v.pid === "number" ? v.pid : 0 };
}

/** One page of `GET …/message` parsed — the messages and the cursor of the
 *  next page, when there is one — or nothing for a body of another shape. A
 *  message is anything with a string `id` and `type`; the fields read later
 *  are read by type where they are used. */
export function parseMessagesPage(body: string): { data: OpenCodeMessage[]; next?: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { data?: unknown; cursor?: unknown };
  if (!Array.isArray(v.data)) return undefined;
  const data: OpenCodeMessage[] = [];
  for (const item of v.data) {
    if (typeof item !== "object" || item === null) return undefined;
    const m = item as Record<string, unknown>;
    if (typeof m.id !== "string" || typeof m.type !== "string") return undefined;
    data.push(m as unknown as OpenCodeMessage);
  }
  const next =
    typeof v.cursor === "object" && v.cursor !== null && typeof (v.cursor as { next?: unknown }).next === "string"
      ? (v.cursor as { next: string }).next
      : undefined;
  return next === undefined ? { data } : { data, next };
}

/** One page of the store at a time, never the route's defaults. Measured
 *  against the pinned binary: `GET …/message` answers newest first unless
 *  `order=asc`, 50 rows unless `limit` — at most 200; a limit above it is a 400
 *  (`InvalidRequestError`) — and a `cursor.next` to the following page. */
export const STORE_PAGE_LIMIT = 200;
/** How many pages a store may run to before the read gives up: a store that
 *  does not end within them is refused, never continued on in part. */
export const STORE_PAGES = 10_000;

/** What a store read answers: the rows taken, newest or oldest first as asked,
 *  and `stopped`, the row `take` ended the read at, when one did — under
 *  `desc`, the newest row known before. (An `idle` marker newest means no
 *  execution runs; anything else, one is under way — the re-attach's rule.) */
export type StoreRead =
  { ok: true; messages: OpenCodeMessage[]; stopped?: OpenCodeMessage } | { ok: false; why: string };

/** The store paged as the binary pages it: the order on every page (never the
 *  route's default), `limit=STORE_PAGE_LIMIT`, `cursor.next` followed, each
 *  row handed to `take` — it keeps the row and goes on, or ends the read
 *  there. Refused by name, never partial: a page the server refuses, a page
 *  of another shape, a store that does not end within `STORE_PAGES`. `get` is
 *  the seam's GET (idempotent: the seam re-sends it once itself on a control
 *  reset). Measured against the pinned binary: the listing's order is the
 *  server's insertion order — an import stamped an hour AHEAD of the server's
 *  clock still listed before the prompt posted after it under `order=asc`, and
 *  after it under `order=desc`, and its client-minted ids (`msg_<session>_u0`)
 *  sort nowhere near the server's — so neither the rows' ids nor their
 *  `time.created` order the listing; a row known before a write was inserted
 *  before it and is always the older in the listing. */
async function readStorePages(
  get: (path: string) => Promise<{ status: number; body: string }>,
  sessionID: string,
  order: "asc" | "desc",
  take: (m: OpenCodeMessage) => boolean,
): Promise<StoreRead> {
  const route = openCodeSessionRoutes(sessionID)["session.messages"].path;
  const messages: OpenCodeMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page === STORE_PAGES)
      return {
        ok: false,
        why: `the session's store did not end within ${STORE_PAGES} pages; the run does not continue on a partial store`,
      };
    const query = `${cursor !== undefined ? `cursor=${encodeURIComponent(cursor)}&` : ""}order=${order}&limit=${STORE_PAGE_LIMIT}`;
    const res = await get(`${route}?${query}`);
    if (res.status < 200 || res.status >= 300)
      return { ok: false, why: `the server refused the session (${res.status})` };
    const listed = parseMessagesPage(res.body);
    if (listed === undefined)
      return { ok: false, why: "the session's messages answered something that is not the page shape" };
    for (const m of listed.data) {
      if (!take(m)) return { ok: true, messages, stopped: m };
      messages.push(m);
    }
    cursor = listed.next;
    if (cursor === undefined) return { ok: true, messages };
  }
}

/** The session's store read whole, oldest first (`order=asc`) — what a
 *  re-attach aligns the mirror on. */
export function readSessionStore(
  get: (path: string) => Promise<{ status: number; body: string }>,
  sessionID: string,
): Promise<StoreRead> {
  return readStorePages(get, sessionID, "asc", () => true);
}

/** The store's rows newer than any in `before`, newest first (`order=desc`),
 *  the read ending at the first row in `before` — inserted before the write in
 *  question, so everything older was there before — or at the store's end:
 *  one page in practice, since what a loop looks for here (a prompt or a
 *  steer it just posted) is among this generation's few rows; never the whole
 *  store. `before` is what the store held before the write, not everything
 *  known now: a row learned since (a steer posted after the write, known by
 *  its answer) is newer than the write's and is read past. */
export function readStoreSince(
  get: (path: string) => Promise<{ status: number; body: string }>,
  sessionID: string,
  before: ReadonlySet<string>,
): Promise<StoreRead> {
  return readStorePages(get, sessionID, "desc", (m) => !before.has(m.id));
}

/** The id of the object a POST answered with (`data.id`): the session a create
 *  made, the user message a prompt or a steer became (measured against the
 *  pinned binary for a `queue` prompt and a `steer` alike), or nothing for a
 *  body of another shape. */
export function parseAnswerId(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as { data?: { id?: unknown } } | null;
    return typeof value?.data?.id === "string" ? value.data.id : undefined;
  } catch {
    return undefined;
  }
}

/** `GET …/permission` parsed — the session's pending asks — or nothing for a
 *  body of another shape; each ask carries a string `id` and `action`. */
export function parsePermissionList(body: string): OpenCodePermissionRequest[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  const asks: OpenCodePermissionRequest[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) return undefined;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.action !== "string") return undefined;
    asks.push(r as unknown as OpenCodePermissionRequest);
  }
  return asks;
}

/** The configuration entries parsed, or nothing for a body that is not the list. */
export function parseConfigEntries(body: string): OpenCodeConfigEntry[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const entries: OpenCodeConfigEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return undefined;
    const e = item as Record<string, unknown>;
    if (typeof e.path !== "string") return undefined;
    if (e.type === "directory") entries.push({ type: "directory", path: e.path });
    else if (e.type === "document" && typeof e.info === "object" && e.info !== null)
      entries.push({ type: "document", path: e.path, info: e.info as Record<string, unknown> });
    else return undefined;
  }
  return entries;
}
