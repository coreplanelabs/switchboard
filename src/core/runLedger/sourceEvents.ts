import { sourceHash } from "../references/receipts.js";
import {
  SOURCE_EVENT_MAX_BYTES,
  SOURCE_JOB_MAX_ATTEMPTS,
  SOURCE_JOB_MAX_CLAIMS,
  SOURCE_JOB_LEASE_MS,
  SOURCE_JOB_RETRY_MS,
  SOURCE_JOB_SCAN_LIMIT,
  SOURCE_RELEVANCE_MAX_CONTEXTS,
  SOURCE_RELEVANCE_RESULT_MAX_BYTES,
} from "../budgets.js";

/** Source data has no worker destination or requester authority. */
interface SourceEventFields {
  sourceId: string;
  deliveryId: string;
  objectId: string;
  changeId: string;
  kind: "request" | "source-evidence" | "source-fact";
  authorId?: string;
  occurredAt?: number;
  /** Opaque JSON data, validated and bounded before storage. */
  payload: unknown;
}
export type SourceEventContent =
  | {
      kind: "text";
      state: "present" | "deleted" | "withdrawn";
      text: string | null;
      metadata?: Record<string, unknown>;
    }
  | { kind: "facts"; facts: Record<string, unknown> };
export type SourceEvent = SourceEventFields &
  ({ version: 1; content?: never } | { version: 2; content: SourceEventContent });
export interface SourceEventReceipt {
  version: 1;
  key: string;
  sequence: number;
  receivedAt: number;
  bodyHash: string;
}
export interface ReceivedSourceEventJob {
  version: 1;
  eventKey: string;
  stage: "received";
  attempts: 0;
  nextAttemptAt: number;
}
export interface SourceJobLease {
  owner: string;
  token: string;
  claimedAt: number;
  until: number;
}
export type SourceJobRetryReason =
  "storage-unavailable" | "source-unavailable" | "provider-unavailable" | "context-unavailable";
export type SourceJobHoldReason = "permission-refused" | "unsupported-schema" | "invalid-source";
export type SourceJobReleaseIntent =
  { disposition: "retry"; reason: SourceJobRetryReason } | { disposition: "hold"; reason: SourceJobHoldReason };
export type SourceJobReleaseRequest = SourceJobReleaseIntent & { key: string; owner: string; token: string };
export type SourceJobReleaseReceipt = SourceJobReleaseRequest & {
  attempts: number;
  at: number;
  state: "ready" | "failed";
  nextAttemptAt: number | null;
};
interface SourceJobStateBase {
  eventKey: string;
  stage: "received";
  attempts: number;
  releases: SourceJobReleaseReceipt[];
}
export interface SourceRelevanceResult {
  version: 1;
  context: { runId: string; requester: string; channelId: string; threadKey: string; hash: string };
  inputHash: string;
  verdict: "relevant" | "unrelated" | "unclassified";
  source: "model" | "error" | "timeout";
  reason: string;
}
export type SourceRelevanceRecord = SourceRelevanceResult & { at: number };
export interface SourceRelevanceRequest {
  receipt: SourceEventReceipt;
  owner: string;
  token: string;
  result: SourceRelevanceResult;
}
export type SourceRelevanceSaveResult =
  | { kind: "saved"; receipt: SourceEventReceipt; record: SourceRelevanceRecord }
  | {
      kind: "refused";
      reason:
        | "invalid-request"
        | "missing"
        | "source-mismatch"
        | "unsupported-job"
        | "fenced"
        | "result-conflict"
        | "capacity";
    };
export type ClaimedSourceEventJob = SourceJobStateBase &
  ({ version: 2; relevance?: never } | { version: 3; relevance: SourceRelevanceRecord[] }) &
  (
    | { state: "ready"; nextAttemptAt: number; lease?: never; failure?: never }
    | { state: "leased"; nextAttemptAt: number; lease: SourceJobLease; failure?: never }
    | {
        state: "failed";
        nextAttemptAt: null;
        lease?: never;
        failure: { reason: SourceJobHoldReason | "attempts-exhausted"; at: number };
      }
  );
export type SourceEventJob = ReceivedSourceEventJob | ClaimedSourceEventJob;
export interface SourceJobClaimRequest {
  owner: string;
  readerVersion: 2 | 3;
  limit: number;
}
export interface SourceJobClaim {
  receipt: SourceEventReceipt;
  lease: SourceJobLease;
  attempts: number;
}
export type SourceJobClaimResult =
  | { kind: "claimed"; claims: SourceJobClaim[]; held: number; failed: SourceEventReceipt[] }
  | { kind: "refused"; reason: "unsupported-reader" | "invalid-request" };
export type SourceJobReleaseResult =
  | { kind: "released"; receipt: SourceJobReleaseReceipt }
  | { kind: "refused"; reason: "invalid-request" | "missing" | "unsupported-job" | "fenced" | "release-conflict" };
export interface SourceEventRecord {
  event: SourceEvent;
  receipt: SourceEventReceipt;
  job: SourceEventJob;
}
export type SourceEventReceiveResult =
  | { kind: "received" | "duplicate"; receipt: SourceEventReceipt }
  | { kind: "refused"; reason: "invalid-event" | "delivery-conflict" | "capacity" };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const closed = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const identity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const isSourceEventKey = (value: unknown): value is string =>
  typeof value === "string" && /^source:[a-f0-9]{64}$/.test(value);

/** Canonical JSON preserves arrays and rejects values that JSON would silently drop. */
function sourceJson(value: unknown, ancestors = new Set<object>(), depth = 0): string {
  if (depth > 64) throw new Error("Source data is too deep");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || ancestors.has(value)) throw new Error("Invalid source data");
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error("Invalid source data");
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("Invalid source data");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.keys(descriptors).length !== value.length + 1) throw new Error("Invalid source array");
      const items = Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("Invalid source array");
        return sourceJson(descriptor.value, ancestors, depth + 1);
      });
      return `[${items.join(",")}]`;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return `{${Object.keys(descriptors)
      .sort()
      .map((key) => {
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("Invalid source data");
        return `${JSON.stringify(key)}:${sourceJson(descriptor.value, ancestors, depth + 1)}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Detached canonical JSON for source adapters. Unsafe values throw. */
export function sourceSnapshot(value: unknown): unknown {
  return JSON.parse(sourceJson(value));
}

/** Common content is source data. It cannot carry requester credentials,
 * destination claims or controls. The provider payload remains opaque. */
function sourceContentOf(value: unknown, kind: SourceEventFields["kind"]): SourceEventContent | undefined {
  if (!object(value)) return;
  if (kind === "source-fact") {
    if (value.kind === "facts" && closed(value, ["kind", "facts"]) && object(value.facts))
      return { kind: "facts", facts: value.facts };
  } else if (
    value.kind === "text" &&
    closed(value, ["kind", "state", "text", "metadata"]) &&
    (value.state === "present" || value.state === "deleted" || value.state === "withdrawn") &&
    (value.metadata === undefined || object(value.metadata)) &&
    (typeof value.text === "string" || value.text === null)
  )
    return {
      kind: "text",
      state: value.state,
      text: value.text,
      ...(value.metadata !== undefined ? { metadata: value.metadata } : {}),
    };
}

export async function prepareSourceEvent(value: unknown): Promise<
  | {
      event: SourceEvent;
      json: string;
      bytes: number;
      key: string;
      bodyHash: string;
    }
  | undefined
> {
  if (!object(value)) return;
  let json: string;
  let parsed: unknown;
  try {
    json = sourceJson(value);
    parsed = JSON.parse(json);
  } catch {
    return;
  }
  const bytes = new TextEncoder().encode(json).byteLength;
  if (
    bytes > SOURCE_EVENT_MAX_BYTES ||
    !object(parsed) ||
    (parsed.version !== 1 && parsed.version !== 2) ||
    !closed(parsed, [
      "version",
      "sourceId",
      "deliveryId",
      "objectId",
      "changeId",
      "kind",
      "authorId",
      "occurredAt",
      "payload",
      "content",
    ])
  )
    return;
  const { sourceId, deliveryId, objectId, changeId, kind, authorId, occurredAt, payload } = parsed;
  if (
    !identity(sourceId) ||
    !/^[a-z][a-z0-9-]*:/.test(sourceId) ||
    !identity(deliveryId) ||
    !identity(objectId) ||
    !identity(changeId) ||
    (kind !== "request" && kind !== "source-evidence" && kind !== "source-fact") ||
    (authorId !== undefined && !identity(authorId)) ||
    (occurredAt !== undefined && !time(occurredAt)) ||
    !Object.hasOwn(parsed, "payload")
  )
    return;
  const content = parsed.version === 2 ? sourceContentOf(parsed.content, kind) : undefined;
  if (parsed.version === 1 ? Object.hasOwn(parsed, "content") : content === undefined) return;
  const event: SourceEvent = {
    ...(parsed.version === 2 && content ? { version: 2 as const, content } : { version: 1 as const }),
    sourceId,
    deliveryId,
    objectId,
    changeId,
    kind,
    payload,
    ...(authorId !== undefined ? { authorId } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
  };
  const [keyHash, bodyHash] = await Promise.all([sourceHash([sourceId, deliveryId]), sourceHash(parsed)]);
  return { event, json, bytes, key: `source:${keyHash}`, bodyHash };
}

export function sourceEventReceiptOf(value: unknown): SourceEventReceipt | undefined {
  if (
    !object(value) ||
    !closed(value, ["version", "key", "sequence", "receivedAt", "bodyHash"]) ||
    value.version !== 1 ||
    !isSourceEventKey(value.key) ||
    !time(value.sequence) ||
    value.sequence === 0 ||
    !time(value.receivedAt) ||
    typeof value.bodyHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.bodyHash)
  )
    return;
  return {
    version: 1,
    key: value.key,
    sequence: value.sequence,
    receivedAt: value.receivedAt,
    bodyHash: value.bodyHash,
  };
}

export function receivedSourceEventJob(
  receipt: Pick<SourceEventReceipt, "key" | "receivedAt">,
): ReceivedSourceEventJob {
  return { version: 1, eventKey: receipt.key, stage: "received", attempts: 0, nextAttemptAt: receipt.receivedAt };
}

const retryReason = (v: unknown): v is SourceJobRetryReason =>
  ["storage-unavailable", "source-unavailable", "provider-unavailable", "context-unavailable"].some((r) => r === v);
const holdReason = (v: unknown): v is SourceJobHoldReason =>
  ["permission-refused", "unsupported-schema", "invalid-source"].some((r) => r === v);
export function sourceJobReleaseRequestOf(v: unknown): SourceJobReleaseRequest | undefined {
  if (
    !object(v) ||
    !closed(v, ["key", "owner", "token", "disposition", "reason"]) ||
    !isSourceEventKey(v.key) ||
    !identity(v.owner) ||
    !identity(v.token)
  )
    return;
  if (v.disposition === "retry" && retryReason(v.reason))
    return { key: v.key, owner: v.owner, token: v.token, disposition: "retry", reason: v.reason };
  if (v.disposition === "hold" && holdReason(v.reason))
    return { key: v.key, owner: v.owner, token: v.token, disposition: "hold", reason: v.reason };
  return;
}
export function sourceJobClaimRequestOf(v: unknown): SourceJobClaimRequest | undefined {
  if (
    !object(v) ||
    !closed(v, ["owner", "readerVersion", "limit"]) ||
    (v.readerVersion !== 2 && v.readerVersion !== 3) ||
    !identity(v.owner) ||
    !Number.isSafeInteger(v.limit) ||
    Number(v.limit) < 1 ||
    Number(v.limit) > SOURCE_JOB_MAX_CLAIMS
  )
    return;
  return { owner: v.owner, readerVersion: v.readerVersion, limit: Number(v.limit) };
}
export function prepareSourceJobClaim(
  v: unknown,
): { request: SourceJobClaimRequest } | { refusal: Extract<SourceJobClaimResult, { kind: "refused" }> } {
  if (!object(v) || (v.readerVersion !== 2 && v.readerVersion !== 3))
    return { refusal: { kind: "refused", reason: "unsupported-reader" } };
  const request = sourceJobClaimRequestOf(v);
  return request ? { request } : { refusal: { kind: "refused", reason: "invalid-request" } };
}
export function isSourceJobLease(v: unknown): v is SourceJobLease {
  return (
    object(v) &&
    closed(v, ["owner", "token", "claimedAt", "until"]) &&
    identity(v.owner) &&
    identity(v.token) &&
    time(v.claimedAt) &&
    time(v.until) &&
    v.until - v.claimedAt === SOURCE_JOB_LEASE_MS
  );
}
export function sourceJobReleaseReceiptOf(v: unknown): SourceJobReleaseReceipt | undefined {
  if (
    !object(v) ||
    !closed(v, ["key", "owner", "token", "disposition", "reason", "attempts", "at", "state", "nextAttemptAt"]) ||
    !time(v.attempts) ||
    v.attempts < 1 ||
    v.attempts > SOURCE_JOB_MAX_ATTEMPTS ||
    !time(v.at)
  )
    return;
  const intent = sourceJobReleaseRequestOf({
    key: v.key,
    owner: v.owner,
    token: v.token,
    disposition: v.disposition,
    reason: v.reason,
  });
  if (!intent) return;
  if (
    v.state === "ready" &&
    time(v.nextAttemptAt) &&
    v.nextAttemptAt - v.at === SOURCE_JOB_RETRY_MS[Math.min(v.attempts - 1, SOURCE_JOB_RETRY_MS.length - 1)] &&
    intent.disposition === "retry" &&
    v.attempts < SOURCE_JOB_MAX_ATTEMPTS
  )
    return { ...intent, attempts: v.attempts, at: v.at, state: "ready", nextAttemptAt: v.nextAttemptAt };
  if (
    v.state === "failed" &&
    v.nextAttemptAt === null &&
    (intent.disposition === "hold" || v.attempts === SOURCE_JOB_MAX_ATTEMPTS)
  )
    return { ...intent, attempts: v.attempts, at: v.at, state: "failed", nextAttemptAt: null };
  return;
}
export function sourceEventJobOf(v: unknown): SourceEventJob | undefined {
  if (!object(v) || !isSourceEventKey(v.eventKey) || v.stage !== "received" || !time(v.attempts)) return;
  if (
    v.version === 1 &&
    closed(v, ["version", "eventKey", "stage", "attempts", "nextAttemptAt"]) &&
    v.attempts === 0 &&
    time(v.nextAttemptAt)
  )
    return { version: 1, eventKey: v.eventKey, stage: "received", attempts: 0, nextAttemptAt: v.nextAttemptAt };
  if (
    (v.version !== 2 && v.version !== 3) ||
    !closed(v, [
      "version",
      "eventKey",
      "stage",
      "attempts",
      "nextAttemptAt",
      "state",
      "lease",
      "failure",
      "releases",
      ...(v.version === 3 ? ["relevance"] : []),
    ]) ||
    v.attempts < 1 ||
    v.attempts > SOURCE_JOB_MAX_ATTEMPTS ||
    !Array.isArray(v.releases) ||
    v.releases.length > v.attempts
  )
    return;
  const releases: SourceJobReleaseReceipt[] = [];
  const tokens = new Set<string>();
  let priorAttempt = 0;
  for (const raw of v.releases) {
    const receipt = sourceJobReleaseReceiptOf(raw);
    if (
      !receipt ||
      receipt.key !== v.eventKey ||
      receipt.attempts <= priorAttempt ||
      receipt.attempts > v.attempts ||
      tokens.has(receipt.token)
    )
      return;
    if (receipt.state === "failed" && (receipt.attempts !== v.attempts || v.state !== "failed")) return;
    releases.push(receipt);
    tokens.add(receipt.token);
    priorAttempt = receipt.attempts;
  }
  let saved: { version: 2; relevance?: never } | { version: 3; relevance: SourceRelevanceRecord[] };
  if (v.version === 3) {
    if (!Array.isArray(v.relevance) || v.relevance.length < 1 || v.relevance.length > SOURCE_RELEVANCE_MAX_CONTEXTS)
      return;
    const relevance: SourceRelevanceRecord[] = [];
    const contexts = new Set<string>();
    for (const raw of v.relevance) {
      const record = sourceRelevanceRecordOf(raw);
      if (!record) return;
      const key = JSON.stringify(record.context);
      if (contexts.has(key)) return;
      contexts.add(key);
      relevance.push(record);
    }
    saved = { version: 3, relevance };
  } else saved = { version: 2 };
  const base = {
    ...saved,
    eventKey: v.eventKey,
    stage: "received" as const,
    attempts: v.attempts,
    releases,
  };
  const last = releases.at(-1);
  if (
    v.state === "ready" &&
    time(v.nextAttemptAt) &&
    v.lease === undefined &&
    v.failure === undefined &&
    last?.state === "ready" &&
    last.attempts === v.attempts &&
    last.nextAttemptAt === v.nextAttemptAt
  )
    return { ...base, state: "ready", nextAttemptAt: v.nextAttemptAt };
  if (
    v.state === "leased" &&
    isSourceJobLease(v.lease) &&
    v.nextAttemptAt === v.lease.until &&
    v.failure === undefined &&
    !tokens.has(v.lease.token) &&
    priorAttempt < v.attempts
  )
    return { ...base, state: "leased", nextAttemptAt: v.lease.until, lease: { ...v.lease } };
  if (
    v.state === "failed" &&
    v.nextAttemptAt === null &&
    v.lease === undefined &&
    object(v.failure) &&
    closed(v.failure, ["reason", "at"]) &&
    time(v.failure.at) &&
    ((holdReason(v.failure.reason) &&
      last?.state === "failed" &&
      last.disposition === "hold" &&
      last.attempts === v.attempts &&
      last.reason === v.failure.reason &&
      last.at === v.failure.at) ||
      (v.failure.reason === "attempts-exhausted" && v.attempts === SOURCE_JOB_MAX_ATTEMPTS))
  )
    return { ...base, state: "failed", nextAttemptAt: null, failure: { reason: v.failure.reason, at: v.failure.at } };
  return;
}

export async function sourceEventRecordOf(value: unknown): Promise<SourceEventRecord | undefined> {
  if (!object(value) || !closed(value, ["event", "receipt", "job"])) return;
  const receipt = sourceEventReceiptOf(value.receipt);
  const prepared = await prepareSourceEvent(value.event);
  const job = sourceEventJobOf(value.job);
  if (
    !receipt ||
    !prepared ||
    prepared.key !== receipt.key ||
    prepared.bodyHash !== receipt.bodyHash ||
    !job ||
    job.eventKey !== receipt.key ||
    job.stage !== "received"
  )
    return;
  return {
    event: prepared.event,
    receipt,
    job,
  };
}

export function sourceEventReceiveResultOf(value: unknown): SourceEventReceiveResult | undefined {
  if (!object(value)) return;
  const reason = value.reason;
  if (
    value.kind === "refused" &&
    closed(value, ["kind", "reason"]) &&
    (reason === "invalid-event" || reason === "delivery-conflict" || reason === "capacity")
  )
    return { kind: "refused", reason };
  const receipt = sourceEventReceiptOf(value.receipt);
  if (receipt && closed(value, ["kind", "receipt"]) && (value.kind === "received" || value.kind === "duplicate"))
    return { kind: value.kind, receipt };
  return;
}

export function sourceJobClaimResultOf(value: unknown): SourceJobClaimResult | undefined {
  if (!object(value)) return;
  if (
    value.kind === "refused" &&
    closed(value, ["kind", "reason"]) &&
    (value.reason === "unsupported-reader" || value.reason === "invalid-request")
  )
    return { kind: "refused", reason: value.reason };
  if (
    value.kind !== "claimed" ||
    !closed(value, ["kind", "claims", "held", "failed"]) ||
    !Array.isArray(value.claims) ||
    value.claims.length > SOURCE_JOB_MAX_CLAIMS ||
    !Array.isArray(value.failed) ||
    !time(value.held) ||
    value.claims.length + value.failed.length + value.held > SOURCE_JOB_SCAN_LIMIT
  )
    return;
  const claims: SourceJobClaim[] = [],
    failed: SourceEventReceipt[] = [];
  const keys = new Set<string>();
  for (const raw of value.claims) {
    if (
      !object(raw) ||
      !closed(raw, ["receipt", "lease", "attempts"]) ||
      !isSourceJobLease(raw.lease) ||
      !time(raw.attempts) ||
      raw.attempts < 1 ||
      raw.attempts > SOURCE_JOB_MAX_ATTEMPTS
    )
      return;
    const receipt = sourceEventReceiptOf(raw.receipt);
    if (!receipt || keys.has(receipt.key)) return;
    keys.add(receipt.key);
    claims.push({ receipt, lease: { ...raw.lease }, attempts: raw.attempts });
  }
  for (const raw of value.failed) {
    const receipt = sourceEventReceiptOf(raw);
    if (!receipt || keys.has(receipt.key)) return;
    keys.add(receipt.key);
    failed.push(receipt);
  }
  return { kind: "claimed", claims, held: value.held, failed };
}

export function sourceJobReleaseResultOf(value: unknown): SourceJobReleaseResult | undefined {
  if (!object(value)) return;
  const reason = value.reason;
  if (
    value.kind === "refused" &&
    closed(value, ["kind", "reason"]) &&
    (reason === "invalid-request" ||
      reason === "missing" ||
      reason === "unsupported-job" ||
      reason === "fenced" ||
      reason === "release-conflict")
  )
    return { kind: "refused", reason };
  const receipt = sourceJobReleaseReceiptOf(value.receipt);
  if (value.kind === "released" && closed(value, ["kind", "receipt"]) && receipt) return { kind: "released", receipt };
  return;
}

const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
/** A saved recommendation is data, never source access or delivery authority. */
function sourceRelevanceResultOf(v: unknown): SourceRelevanceResult | undefined {
  if (
    !object(v) ||
    !closed(v, ["version", "context", "inputHash", "verdict", "source", "reason"]) ||
    v.version !== 1 ||
    !object(v.context) ||
    !closed(v.context, ["runId", "requester", "channelId", "threadKey", "hash"]) ||
    !identity(v.context.runId) ||
    !identity(v.context.requester) ||
    !identity(v.context.channelId) ||
    !identity(v.context.threadKey) ||
    !hash(v.context.hash) ||
    !hash(v.inputHash) ||
    (v.verdict !== "relevant" && v.verdict !== "unrelated" && v.verdict !== "unclassified") ||
    (v.source !== "model" && v.source !== "error" && v.source !== "timeout") ||
    (v.source !== "model" && v.verdict !== "unclassified") ||
    typeof v.reason !== "string" ||
    v.reason.trim().length === 0 ||
    new TextEncoder().encode(v.reason).byteLength > 1024 ||
    new TextEncoder().encode(JSON.stringify(v)).byteLength > SOURCE_RELEVANCE_RESULT_MAX_BYTES
  )
    return;
  return {
    version: 1,
    context: {
      runId: v.context.runId,
      requester: v.context.requester,
      channelId: v.context.channelId,
      threadKey: v.context.threadKey,
      hash: v.context.hash,
    },
    inputHash: v.inputHash,
    verdict: v.verdict,
    source: v.source,
    reason: v.reason,
  };
}
export function sourceRelevanceRecordOf(v: unknown): SourceRelevanceRecord | undefined {
  if (!object(v) || !time(v.at)) return;
  const { at, ...body } = v;
  const result = sourceRelevanceResultOf(body);
  return result ? { ...result, at } : undefined;
}
export function sourceRelevanceRequestOf(value: unknown): SourceRelevanceRequest | undefined {
  try {
    const v = sourceSnapshot(value);
    if (!object(v) || !closed(v, ["receipt", "owner", "token", "result"]) || !identity(v.owner) || !identity(v.token))
      return;
    const receipt = sourceEventReceiptOf(v.receipt),
      result = sourceRelevanceResultOf(v.result);
    return receipt && result ? { receipt, owner: v.owner, token: v.token, result } : undefined;
  } catch {
    return;
  }
}
export function sourceRelevanceSaveResultOf(v: unknown): SourceRelevanceSaveResult | undefined {
  if (!object(v)) return;
  if (
    v.kind === "refused" &&
    closed(v, ["kind", "reason"]) &&
    (v.reason === "invalid-request" ||
      v.reason === "missing" ||
      v.reason === "source-mismatch" ||
      v.reason === "unsupported-job" ||
      v.reason === "fenced" ||
      v.reason === "result-conflict" ||
      v.reason === "capacity")
  )
    return { kind: "refused", reason: v.reason };
  const record = sourceRelevanceRecordOf(v.record),
    receipt = sourceEventReceiptOf(v.receipt);
  if (v.kind === "saved" && closed(v, ["kind", "receipt", "record"]) && receipt && record)
    return { kind: "saved", receipt, record };
  return;
}
