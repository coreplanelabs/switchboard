/** Span attributes: one flat key union with a value domain per key, and the
 *  keys each span name may carry (features/tracing.md). Literal unions,
 *  numbers and booleans only; the string-valued keys (`host`, `route`,
 *  `command`, `agent`, `model`) come from closed tables at the emitter — a
 *  model is the parsed `<provider>/<model>` ref the registry resolved, never
 *  the typed directive — and are validated as sanitized identifiers here.
 *  `traceId` and free text are not attrs — an error's message has its own
 *  field. */

export type Backend = "local" | "resident" | "sandbox" | "e2b";
export type Channel = "slack" | "http" | "mcp" | "cli";

/** Every attribute key any span may carry, with its value domain. */
export interface AttrDomain {
  // request
  channel: Channel;
  status: "completed" | "failed" | "refused" | "stopped";
  queuedBeforeMs: number;
  queuedBehindMs: number;
  runId: string;
  // slack.receive
  caughtUp: boolean;
  files: number;
  dedupe: "fresh" | "duplicate";
  // dispatch.* / run.* / post.*
  outcome: string;
  count: number;
  backend: Backend;
  // run.command
  command: string;
  // model.turn
  /** The `<provider>/<model>` that took the turn — a ship run's children answer
   *  on different models, and the run page badges the switch per step. */
  model: string;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "other";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  ttftMs: number;
  thinkingMs: number;
  textMs: number;
  blocks: number;
  finale: boolean;
  // model.block.<kind>
  index: number;
  // tool.*
  callId: string;
  ok: boolean;
  exitCode: number;
  infra: boolean;
  execMs: number;
  serverMs: number;
  attempts: number;
  timeoutMs: number;
  budget: "full" | "clipped";
  token: "fresh" | "expiring" | "expired";
  // exec.*
  tokenExpiresInMin: number;
  attempt: number;
  delayMs: number;
  // github.*, http.client, <worker>.fetch
  scope: "read" | "write";
  cached: boolean;
  expiresInMs: number;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  route: string;
  host: string;
  httpStatus: number;
  // mcp.*
  bytes: number;
  // ship.round
  agent: string;
  // resident grafts
  waitedMs: number;
  clockSkewMs: number;
  timedOut: boolean;
  abandoned: boolean;
  // the bot's own roots (item 20): slack.catch_up, drain, deploy.step.<worker>
  signal: "SIGTERM" | "SIGINT" | "other";
  channels: number;
  missed: number;
  orphans: number;
  skipped: number;
  runs: number;
  handed: number;
  sealed: number;
  abandonedRuns: number;
}

export type SpanAttrKey = keyof AttrDomain;

export type SpanAttrs = { readonly [K in SpanAttrKey]?: AttrDomain[K] };

/** The string-valued keys, and the shape their values must have: an identifier
 *  from a closed table, never free text (no whitespace, no `?`/`&`, at most 64
 *  chars). */
const IDENTIFIER_KEYS: ReadonlySet<SpanAttrKey> = new Set<SpanAttrKey>([
  "runId",
  "outcome",
  "command",
  "route",
  "host",
  "callId",
  "agent",
  "model",
]);
const IDENTIFIER_RE = /^[A-Za-z0-9_./:@+-]{1,64}$/;

/** Validate one attrs bag: known keys, value in domain, identifiers sanitized.
 *  Returns the offending keys (empty when valid); emitters and tests use it,
 *  the tracer itself never throws over an attr. */
export function invalidAttrKeys(attrs: SpanAttrs): string[] {
  const bad: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (!(key in ATTR_TYPE)) {
      bad.push(key);
      continue;
    }
    const expected = ATTR_TYPE[key as SpanAttrKey];
    if (expected === "string") {
      if (typeof value !== "string") bad.push(key);
      else if (IDENTIFIER_KEYS.has(key as SpanAttrKey) && !IDENTIFIER_RE.test(value)) bad.push(key);
    } else if (typeof value !== expected) {
      bad.push(key);
    } else if (typeof value === "number" && !Number.isFinite(value)) {
      bad.push(key);
    }
  }
  return bad;
}

/** The runtime type of each key — the one place the domain is spelled twice
 *  (type and value), kept adjacent so they cannot drift. */
const ATTR_TYPE: Record<SpanAttrKey, "string" | "number" | "boolean"> = {
  channel: "string",
  status: "string",
  queuedBeforeMs: "number",
  queuedBehindMs: "number",
  runId: "string",
  caughtUp: "boolean",
  files: "number",
  dedupe: "string",
  outcome: "string",
  count: "number",
  backend: "string",
  command: "string",
  model: "string",
  stopReason: "string",
  inputTokens: "number",
  outputTokens: "number",
  cacheReadTokens: "number",
  cacheWriteTokens: "number",
  ttftMs: "number",
  thinkingMs: "number",
  textMs: "number",
  blocks: "number",
  finale: "boolean",
  index: "number",
  callId: "string",
  ok: "boolean",
  exitCode: "number",
  infra: "boolean",
  execMs: "number",
  serverMs: "number",
  attempts: "number",
  timeoutMs: "number",
  budget: "string",
  token: "string",
  tokenExpiresInMin: "number",
  attempt: "number",
  delayMs: "number",
  scope: "string",
  cached: "boolean",
  expiresInMs: "number",
  method: "string",
  route: "string",
  host: "string",
  httpStatus: "number",
  bytes: "number",
  agent: "string",
  waitedMs: "number",
  clockSkewMs: "number",
  timedOut: "boolean",
  abandoned: "boolean",
  signal: "string",
  channels: "number",
  missed: "number",
  orphans: "number",
  skipped: "number",
  runs: "number",
  handed: "number",
  sealed: "number",
  abandonedRuns: "number",
};

export const ATTR_KEYS: readonly SpanAttrKey[] = Object.keys(ATTR_TYPE) as SpanAttrKey[];
