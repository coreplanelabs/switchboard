import type {
  AdmissionStage,
  AdmissionReason,
  AdmissionRefreshFailure,
  AdmissionExceptionKind,
  RequestContextSelection,
} from "../organization/admissionTrace.js";
import type { OrganizationSource } from "../organization/contract.js";
import type { OrganizationOwnerFailure } from "../organization/contract.js";
import type { GithubAccessDiagnostic } from "../references/githubAccessDiagnostic.js";
import type { ErrorKind } from "./types.js";

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
  errorKind: ErrorKind;
  errorCode: string;
  sourceCheckStage: import("../dispatch/sourceCheckError.js").SourceCheckStage;
  sourceErrorClass: string;
  sourceErrorFile: string;
  sourceErrorLine: number;
  sourceErrorColumn: number;
  storageOperation: string;
  storagePhase: string;
  storageRequestId: string;
  sourceReadAttempts: number;
  sourceReadStop: "attempts-exhausted" | "deadline" | "permanent";
  // request
  channel: Channel;
  status: "completed" | "failed" | "refused" | "stopped";
  queuedBeforeMs: number;
  queuedBehindMs: number;
  /** The run this request restarts (a restart from its request, run-history
   *  item 54): the page names the predecessor by id instead of inventing a
   *  wait out of its lifetime. On the root at start, like the queued numbers. */
  restartOfRunId: string;
  runId: string;
  /** The explicit full commit pin for this review request. */
  reviewPinnedHead: string;
  // slack.receive
  caughtUp: boolean;
  files: number;
  /** Files found on the canonical source message after event metadata is normalized. */
  resolvedFiles: number;
  dedupe: "fresh" | "duplicate";
  /** How the requester was found (slack-channel.md item 13): the sender, the configured relay app's footer, or the app itself. */
  requester: "message" | "relay-footer" | "bot";
  /** The intake verdict on an unmentioned thread reply (routing-and-config.md
   *  item 27, record 0058); the reason is free text and lives on the receipt
   *  row and the log line, never on a span. */
  intake: "addressed" | "silent";
  /** How the verdict was reached (`IntakeSource`). */
  intakeSource: "model" | "mode" | "question" | "error" | "timeout";
  /** What became of the receipt (`IntakeReceiptOutcome`). */
  intakeReceipt: "inserted" | "existing" | "failed" | "absent";
  // dispatch.* / run.* / post.*
  outcome: string;
  githubStage: GithubAccessDiagnostic["stage"];
  githubReason: GithubAccessDiagnostic["reason"];
  githubTool: GithubAccessDiagnostic["tool"];
  githubOperation: GithubAccessDiagnostic["operation"];
  sourceCallHash: string;
  githubRequestId: string;
  /** The refusal's code (src/core/refusal.ts) — on the `dispatch.refuse` span
   *  and the request's root, so refusals are countable from the trace alone. */
  refusal: string;
  /** Request-only context gates; no requester, target or model payload. */
  requestContextGate:
    "input" | "operator_mode" | "operator_decision" | "typed_route" | "thread_owner" | "local_owner" | "remote_owner";
  requestContextReason: "invalid_input" | "routing_disabled" | "invalid_bind" | "thread_occupied";
  /** The refusal's cause, from the one code→cause table in src/core/refusal.ts. */
  cause: "request" | "policy" | "system";
  /** The operator's decision, separate from the request's final outcome. */
  operatorOutcome: "binds" | "question" | "refusal" | "non_decision";
  /** Provenance of an accepted typed repository; the slug stays on the run event. */
  operatorRepoSource: "request" | "attachment" | "thread" | "channel" | "context";
  operatorAttempts: number;
  operatorRepoCatalog: "skipped" | "available" | "truncated" | "empty" | "unavailable";
  operatorRepoCandidates: number;
  /** Final target resolution, separate from the operator's proposed repo. */
  repoResolution: "skipped" | "resolved" | "rejected" | "unverified" | "conflict" | "unresolved";
  repoTargetRelation: "not_proposed" | "matched" | "overridden" | "unresolved";
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
  /** False identifies observed partial usage after a consuming-adapter failure. */
  usageComplete: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The inclusive wire input was smaller than its reported cache buckets. */
  cacheOverReported: boolean;
  /** The meter row (model-proxy.md item 6): who bills the turn (the
   *  block), the vendor the card names, the turn's dollars with the layer
   *  that priced them, and on a BYOK turn the aggregator's fee (inside `usd`). */
  biller: string;
  vendor: string;
  usd: number;
  feeUsd: number;
  priceSource: "provider" | "operator" | "registry" | "none";
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
  outputTruncated: boolean;
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
  /** State-write failure facts; identifiers and closed vocabulary, no request bytes. */
  stateWriteStage: "promotion-preflight" | "state-read" | "state-rpc" | "acknowledgment" | "request";
  requestDigest: string;
  /** Original ingress failure metadata; no source actor or content. */
  organizationReceiptId: string;
  admissionStage: AdmissionStage;
  admissionReason: AdmissionReason;
  admissionRefreshFailure: AdmissionRefreshFailure;
  admissionExceptionKind: AdmissionExceptionKind;
  admissionSource: OrganizationSource;
  requestContextSelection: RequestContextSelection;
  epochScopeExcluded: number;
  credentialRelation: "same" | "different" | "unknown";
  receiptObserved: boolean;
  buildCommit: string;
  ownerStage: OrganizationOwnerFailure["failure"]["stage"];
  ownerBranch: OrganizationOwnerFailure["branch"];
  firstOwnerStage: OrganizationOwnerFailure["failure"]["stage"];
  firstOwnerErrorKind: ErrorKind;
  firstOwnerErrorCode: NonNullable<OrganizationOwnerFailure["failure"]["code"]>;
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
  /** Catch-up candidates a receipt (or a fresh verdict) silenced — read, never re-run (slack-channel.md item 7). */
  silenced: number;
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
  "errorKind",
  "errorCode",
  "sourceCheckStage",
  "sourceErrorClass",
  "sourceErrorFile",
  "storageOperation",
  "storagePhase",
  "storageRequestId",
  "sourceReadStop",
  "restartOfRunId",
  "runId",
  "outcome",
  "githubStage",
  "githubReason",
  "githubTool",
  "githubOperation",
  "sourceCallHash",
  "githubRequestId",
  "refusal",
  "requestContextGate",
  "requestContextReason",
  "requestContextSelection",
  "cause",
  "operatorOutcome",
  "operatorRepoSource",
  "operatorRepoCatalog",
  "repoResolution",
  "repoTargetRelation",
  "command",
  "route",
  "host",
  "callId",
  "agent",
  "model",
  "biller",
  "vendor",
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
      else if (key === "reviewPinnedHead" && !/^[a-f0-9]{40}$/i.test(value)) bad.push(key);
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
  errorKind: "string",
  errorCode: "string",
  sourceCheckStage: "string",
  sourceErrorClass: "string",
  sourceErrorFile: "string",
  sourceErrorLine: "number",
  sourceErrorColumn: "number",
  storageOperation: "string",
  storagePhase: "string",
  storageRequestId: "string",
  sourceReadAttempts: "number",
  sourceReadStop: "string",
  githubStage: "string",
  githubReason: "string",
  githubTool: "string",
  githubOperation: "string",
  sourceCallHash: "string",
  githubRequestId: "string",
  channel: "string",
  status: "string",
  queuedBeforeMs: "number",
  queuedBehindMs: "number",
  restartOfRunId: "string",
  runId: "string",
  reviewPinnedHead: "string",
  caughtUp: "boolean",
  files: "number",
  resolvedFiles: "number",
  dedupe: "string",
  requester: "string",
  intake: "string",
  intakeSource: "string",
  intakeReceipt: "string",
  outcome: "string",
  refusal: "string",
  requestContextGate: "string",
  requestContextReason: "string",
  cause: "string",
  operatorOutcome: "string",
  operatorRepoSource: "string",
  operatorAttempts: "number",
  operatorRepoCatalog: "string",
  operatorRepoCandidates: "number",
  repoResolution: "string",
  repoTargetRelation: "string",
  count: "number",
  backend: "string",
  command: "string",
  model: "string",
  tools: "number",
  toolNames: "string",
  toolChoice: "string",
  stopReason: "string",
  usageComplete: "boolean",
  inputTokens: "number",
  outputTokens: "number",
  cacheReadTokens: "number",
  cacheWriteTokens: "number",
  cacheOverReported: "boolean",
  biller: "string",
  vendor: "string",
  usd: "number",
  feeUsd: "number",
  priceSource: "string",
  ttftMs: "number",
  thinkingMs: "number",
  textMs: "number",
  blocks: "number",
  finale: "boolean",
  index: "number",
  callId: "string",
  ok: "boolean",
  exitCode: "number",
  outputTruncated: "boolean",
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
  stateWriteStage: "string",
  requestDigest: "string",
  organizationReceiptId: "string",
  admissionStage: "string",
  admissionReason: "string",
  admissionRefreshFailure: "string",
  admissionExceptionKind: "string",
  admissionSource: "string",
  requestContextSelection: "string",
  epochScopeExcluded: "number",
  credentialRelation: "string",
  receiptObserved: "boolean",
  buildCommit: "string",
  ownerStage: "string",
  ownerBranch: "string",
  firstOwnerStage: "string",
  firstOwnerErrorKind: "string",
  firstOwnerErrorCode: "string",
  bytes: "number",
  agent: "string",
  waitedMs: "number",
  clockSkewMs: "number",
  timedOut: "boolean",
  abandoned: "boolean",
  signal: "string",
  channels: "number",
  missed: "number",
  silenced: "number",
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
