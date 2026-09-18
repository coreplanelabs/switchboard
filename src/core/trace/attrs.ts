/** Span attributes: one flat key union with a value domain per key, and the
 *  keys each span name may carry (docs/reference/specs/tracing.md). Literal unions,
 *  numbers and booleans only; the string-valued keys (`host`, `route`,
 *  `command`, `agent`, `model`) come from closed tables at the emitter — a
 *  model is the parsed `<provider>/<model>` ref the registry resolved, never
 *  the typed directive — and are validated as sanitized identifiers here.
 *  `traceId` and free text are not attrs — an error's message has its own
 *  field. */

export type Backend = "local" | "resident" | "sandbox" | "e2b";
export type Channel = "slack" | "http" | "mcp" | "cli" | "web";

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
  /** How the requester was found (slack-channel.md item 13): the sender, the configured relay app's footer, or the app itself. */
  requester: "message" | "relay-footer" | "bot";
  // dispatch.* / run.* / post.*
  outcome: string;
  /** The refusal's code (src/core/refusal.ts) — on the `dispatch.refuse` span
   *  and the request's root, so refusals are countable from the trace alone. */
  refusal: string;
  /** The refusal's cause, from the one code→cause table in src/core/refusal.ts. */
  cause: "request" | "policy" | "system";
  count: number;
  backend: Backend;
  // run.command
  command: string;
  // model.turn
  /** The `<provider>/<model>` that took the turn — a ship run's children answer
   *  on different models, and the run page badges the switch per step. */
  model: string;
  /** The tools a proxied call offered the model (model-proxy.md item 6): how
   *  many, their names sorted and comma-joined, and the request's `tool_choice`
   *  by its word — `auto` when tools came and nothing was said, `none` when no
   *  tools came or the request said so, `any` for OpenAI's `required`, `tool`
   *  for a named tool. */
  tools: number;
  toolNames: string;
  toolChoice: "auto" | "none" | "any" | "tool";
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
  // the Workers' own roots (item 25): resident.watchdog, state.alarm
  residents: number;
  swept: number;
  /** resident.refresh as a Workflow instance: the engine's instance id, an
   *  identifier by the platform's own rule (never a repository name). */
  instanceId: string;
}

export type SpanAttrKey = keyof AttrDomain;

export type SpanAttrs = { readonly [K in SpanAttrKey]?: AttrDomain[K] };

/** The string-valued keys, and the shape their values must have: an identifier
 *  from a closed table, never free text (no whitespace, no `?`/`&`, at most 64
 *  chars). */
const IDENTIFIER_KEYS: ReadonlySet<SpanAttrKey> = new Set<SpanAttrKey>([
  "runId",
  "outcome",
  "refusal",
  "cause",
  "command",
  "route",
  "host",
  "callId",
  "agent",
  "model",
]);
const IDENTIFIER_RE = /^[A-Za-z0-9_./:@+-]{1,64}$/;
/** A Workflow instance id: the platform's rule (`^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`, at most 100). */
const INSTANCE_ID_RE = /^[a-zA-Z0-9_][a-zA-Z0-9-_]{0,99}$/;

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
      else if (key === "instanceId" && !INSTANCE_ID_RE.test(value)) bad.push(key);
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
  requester: "string",
  outcome: "string",
  refusal: "string",
  cause: "string",
  count: "number",
  backend: "string",
  command: "string",
  model: "string",
  tools: "number",
  toolNames: "string",
  toolChoice: "string",
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
  residents: "number",
  swept: "number",
  instanceId: "string",
};

export const ATTR_KEYS: readonly SpanAttrKey[] = Object.keys(ATTR_TYPE) as SpanAttrKey[];
