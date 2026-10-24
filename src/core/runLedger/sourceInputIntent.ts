import { inboxAcknowledgedRowsOf } from "./inboxAcknowledgments.js";
import { isHarnessName, type HARNESS_NAMES } from "../harness/names.js";
import { harnessLaunchIntentOf } from "../harness/sessionPolicy.js";
import {
  sourceInputIdentity,
  sourceInputReferenceOf,
  type SourceInputReference,
} from "../references/sourceInputReference.js";
import { sourceSnapshot } from "./sourceEvents.js";
import { DURABLE_INBOX_MAX_BYTES } from "./inboxMessage.js";
import { prepareSourceEvidenceMessage } from "./sourceEvidence.js";
import { sourceHash } from "../references/receipts.js";
import type { InboxItem, InboxRowWitness, LiveRunRow, RunState, StepRecord, FenceResult } from "./types.js";
import {
  isContextDependencies,
  mergeContextDependencies,
  UNKNOWN_CONTEXT_DEPENDENCIES,
  type ContextDependencies,
} from "../references/contextDependencies.js";

/** An original submission identity, not native acceptance or permission to send.
 * The host ID is carried in typed native input data. Pi's generated entry ID
 * is separate evidence that a later native admission receipt must retain. */
export interface SourceInputIntent {
  id: string;
  phase: "prepared" | "begun";
  owner: { runId: string; gen: string; requester: string; channelId: string; threadKey: string };
  native: { harness: (typeof HARNESS_NAMES)[number]; sessionId: string; launchOrdinal: number };
  reference: SourceInputReference;
  witness: InboxRowWitness;
  renderedHash: string;
}

/** Native persistence evidence supplied by the trusted harness adapter, never
 * source text or a provider response. sessionId is the original native locator. */
export interface SourceInputAdmission {
  version: 1;
  inputId: string;
  intentHash: string;
  native: {
    harness: (typeof HARNESS_NAMES)[number];
    sessionId: string;
    sessionIdentity: string;
    entryId: string;
    entryHash: string;
  };
}

export interface SourceInputCheckpoint {
  receipt: SourceInputAdmission;
  receiptHash: string;
  taskHash: string;
  acknowledged: boolean;
}

export interface SourceInputIntents {
  version: 1 | 2;
  entries: SourceInputIntent[];
  /** Version 2 only. Older readers hold this whole private frame. */
  checkpoints?: SourceInputCheckpoint[];
}

export type SourceInputCheckpointRequest =
  | { operation: "read"; inputId: string }
  | { operation: "commit"; receipt: SourceInputAdmission }
  | { operation: "ack"; inputId: string; receiptHash: string };
export type SourceInputCheckpointResult =
  { ok: true; checkpoint: SourceInputCheckpoint | null } | Extract<FenceResult, { ok: false }>;

export interface SourceInputRowBinding {
  seq: number;
  json: string;
}

/** State custody can change while hashing waits. Passive lease and progress
 * counters do not change the owner, native session, task or state being saved. */
export function sourceInputWriteSnapshot(row: LiveRunRow | undefined): string | undefined {
  return (
    row && JSON.stringify({ runId: row.runId, gen: row.ownerGen, phase: row.phase, meta: row.meta, state: row.state })
  );
}

/** Bind only new or advancing intents. Existing unresolved metadata survives
 * row loss. This is row evidence, not source access, native admission or ACK. */
export async function prepareSourceInputRows(
  prior: RunState,
  incoming: RunState,
  readRow: (seq: number) => InboxItem | undefined,
): Promise<SourceInputRowBinding[] | undefined> {
  const before = sourceInputIntentsOf(prior.sourceInputIntents);
  const after = sourceInputIntentsOf(incoming.sourceInputIntents);
  if (!after) return;
  const bindings: SourceInputRowBinding[] = [];
  for (const entry of after.entries) {
    if (before?.entries.some((old) => old.id === entry.id && old.phase === entry.phase)) continue;
    const raw = readRow(entry.witness.seq);
    if (!raw) return;
    sourceSnapshot(raw);
    // A row witness hashes stored JSON order; source input hashes use the
    // existing canonical source form. Do not exchange those two byte domains.
    const item: unknown = JSON.parse(JSON.stringify(raw));
    if (!object(item) || item.seq !== entry.witness.seq || !object(item.message)) return;
    const message = await prepareSourceEvidenceMessage(item.message, {
      runId: entry.owner.runId,
      requester: entry.owner.requester,
      channelId: entry.owner.channelId,
      threadKey: entry.owner.threadKey,
    });
    if (message?.version !== 2) return;
    const root = entry.reference.root,
      routing = message.routing;
    if (
      (await sourceHash(item.message)) !== entry.witness.digest ||
      (await sourceHash(sourceSnapshot(message))) !== entry.reference.inputHash ||
      JSON.stringify(sourceSnapshot(message.receipt)) !== JSON.stringify(sourceSnapshot(entry.reference.receipt)) ||
      root.runId !== routing.owner.runId ||
      root.requester !== routing.owner.requesterId ||
      root.channelId !== routing.owner.channelId ||
      root.threadKey !== routing.owner.threadKey ||
      entry.reference.routing.kind !== routing.kind ||
      (entry.reference.routing.kind === "fold" &&
        routing.kind === "fold" &&
        entry.reference.routing.decision.id !== routing.decision.id)
    )
      return;
    bindings.push({ seq: entry.witness.seq, json: JSON.stringify(item) });
  }
  return bindings;
}

/** The store calls this inside its final commit boundary, without an await. */
export function sourceInputRowsUnchanged(
  bindings: SourceInputRowBinding[],
  readRow: (seq: number) => InboxItem | undefined,
): boolean {
  return bindings.every((binding) => {
    const current = readRow(binding.seq);
    if (!current) return false;
    sourceSnapshot(current);
    return JSON.stringify(current) === binding.json;
  });
}
type ArchiveOperation = "archive" | "finish" | "cancel" | "put" | "rewrite" | "abandon";
type ArchiveRefusal =
  | "unexpected-input"
  | "invalid-metadata"
  | "original-changed"
  | "invalid-context"
  | "context-capacity"
  | "record-capacity"
  | "pending-input";

/** One owning boundary reports fixed labels and its canonical run ID only. */
export function sourceInputArchiveRefusal(
  owner: { runId: string; operation: ArchiveOperation } | undefined,
  reason: ArchiveRefusal,
): undefined {
  if (owner)
    console.warn("[runs/archive] source input refused", { runId: owner.runId, operation: owner.operation, reason });
  return undefined;
}

/** A terminal lease may close only after the exact original input is archived. */
export function sourceInputArchiveMatches(canonical: unknown, archived: unknown): boolean {
  const original = sourceInputIntentsOf(canonical);
  const saved = sourceInputIntentsOf(archived);
  return !!original && !!saved && JSON.stringify(original) === JSON.stringify(saved);
}

/** Retention data only. A terminal copy cannot mint, replace or advance an
 * original input. Pending source roots join the existing context index; an
 * unrepresentable union holds the archive instead of losing a dependency. */
export function sourceInputArchiveState(
  canonical: unknown,
  incoming: unknown,
  dependencies: unknown,
  owner?: { runId: string; operation: ArchiveOperation },
):
  | {
      sourceInputIntents?: SourceInputIntents;
      contextDependencies?: ContextDependencies;
    }
  | undefined {
  const refuse = (reason: ArchiveRefusal) => sourceInputArchiveRefusal(owner, reason);
  if (canonical === undefined) return incoming === undefined ? {} : refuse("unexpected-input");
  const original = sourceInputIntentsOf(canonical);
  const supplied = incoming === undefined ? original : sourceInputIntentsOf(incoming);
  if (!original || !supplied) return refuse("invalid-metadata");
  if (JSON.stringify(original) !== JSON.stringify(supplied)) return refuse("original-changed");
  if (dependencies !== undefined && !isContextDependencies(dependencies)) return refuse("invalid-context");
  const references = original.entries.map((entry) => entry.reference);
  const required: ContextDependencies = {
    version: 4,
    status: "known",
    revision: 0,
    origins: [],
    slack: [],
    mcp: [],
    sourceInputs: references,
  };
  if (!isContextDependencies(required)) return refuse("context-capacity");
  const retains = (context: ContextDependencies) =>
    references.every((reference) =>
      context.sourceInputs?.some(
        (saved) => JSON.stringify(sourceSnapshot(saved)) === JSON.stringify(sourceSnapshot(reference)),
      ),
    );
  const context = mergeContextDependencies(dependencies ?? UNKNOWN_CONTEXT_DEPENDENCIES, required);
  if (!retains(context)) return refuse("context-capacity");
  return { sourceInputIntents: original, contextDependencies: context };
}

/** Native ACK does not settle recipient obligations or transfer source pins.
 * Unsupported retained data also stays protected; a decoder failure is never
 * proof that the obligation ended. */
export const pendingSourceInputRetentionRequired = (record: { sourceInputIntents?: unknown }): boolean =>
  record.sourceInputIntents !== undefined;

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const closed = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const text = (v: unknown, max = 512): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !/[\r\n\0]/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

/** Closed and bounded metadata. Unsupported originals stay held rather than
 * becoming an empty collection. No source text or authority enters this codec. */
export function sourceInputIntentsOf(value: unknown): SourceInputIntents | undefined {
  try {
    const v = sourceSnapshot(value);
    if (
      !object(v) ||
      !closed(v, v.version === 2 ? ["version", "entries", "checkpoints"] : ["version", "entries"]) ||
      (v.version !== 1 && v.version !== 2) ||
      !Array.isArray(v.entries) ||
      v.entries.length === 0 ||
      v.entries.length > 64 ||
      new TextEncoder().encode(JSON.stringify(v)).byteLength > DURABLE_INBOX_MAX_BYTES
    )
      return;
    const entries: SourceInputIntent[] = [];
    const ids = new Set<string>(),
      rows = new Set<string>(),
      sources = new Set<string>();
    for (const entry of v.entries) {
      if (
        !object(entry) ||
        !closed(entry, ["id", "phase", "owner", "native", "reference", "witness", "renderedHash"]) ||
        !text(entry.id) ||
        ids.has(entry.id) ||
        (entry.phase !== "prepared" && entry.phase !== "begun") ||
        !hash(entry.renderedHash)
      )
        return;
      const owner = entry.owner,
        native = entry.native,
        witness = entry.witness;
      const reference = sourceInputReferenceOf(entry.reference);
      if (
        !reference ||
        !object(owner) ||
        !closed(owner, ["runId", "gen", "requester", "channelId", "threadKey"]) ||
        !text(owner.runId) ||
        !text(owner.gen) ||
        !text(owner.requester) ||
        !text(owner.channelId) ||
        !text(owner.threadKey) ||
        !object(native) ||
        !closed(native, ["harness", "sessionId", "launchOrdinal"]) ||
        !isHarnessName(native.harness) ||
        !text(native.sessionId, 4096) ||
        !Number.isSafeInteger(native.launchOrdinal) ||
        Number(native.launchOrdinal) < 0 ||
        !object(witness) ||
        !closed(witness, ["version", "runId", "seq", "digest"]) ||
        witness.version !== 1 ||
        witness.runId !== owner.runId ||
        !Number.isSafeInteger(witness.seq) ||
        Number(witness.seq) <= 0 ||
        !hash(witness.digest)
      )
        return;
      const row = JSON.stringify([owner.runId, witness.seq]);
      const source = JSON.stringify([owner.runId, sourceInputIdentity(reference)]);
      if (rows.has(row) || sources.has(source)) return;
      if (
        reference.routing.kind === "notice" &&
        (reference.root.runId !== owner.runId ||
          reference.root.requester !== owner.requester ||
          reference.root.channelId !== owner.channelId ||
          reference.root.threadKey !== owner.threadKey)
      )
        return;
      ids.add(entry.id);
      rows.add(row);
      sources.add(source);
      entries.push({
        id: entry.id,
        phase: entry.phase,
        owner: {
          runId: owner.runId,
          gen: owner.gen,
          requester: owner.requester,
          channelId: owner.channelId,
          threadKey: owner.threadKey,
        },
        native: { harness: native.harness, sessionId: native.sessionId, launchOrdinal: Number(native.launchOrdinal) },
        reference,
        witness: { version: 1, runId: owner.runId, seq: Number(witness.seq), digest: witness.digest },
        renderedHash: entry.renderedHash,
      });
    }
    if (v.version === 1) return { version: 1, entries };
    if (!Array.isArray(v.checkpoints) || v.checkpoints.length === 0 || v.checkpoints.length > entries.length) return;
    const checkpoints: SourceInputCheckpoint[] = [];
    const seen = new Set<string>();
    const nativeRows = new Set<string>();
    for (const raw of v.checkpoints) {
      const checkpoint = sourceInputCheckpointOf(raw);
      const entry = checkpoint && entries.find((entry) => entry.id === checkpoint.receipt.inputId);
      if (
        !checkpoint ||
        !entry ||
        entry.phase !== "begun" ||
        seen.has(entry.id) ||
        checkpoint.receipt.native.harness !== entry.native.harness ||
        checkpoint.receipt.native.sessionId !== entry.native.sessionId
      )
        return;
      const nativeRow = JSON.stringify([
        checkpoint.receipt.native.harness,
        checkpoint.receipt.native.sessionId,
        checkpoint.receipt.native.sessionIdentity,
        checkpoint.receipt.native.entryId,
      ]);
      if (nativeRows.has(nativeRow)) return;
      nativeRows.add(nativeRow);
      seen.add(entry.id);
      checkpoints.push(checkpoint);
    }
    return { version: 2, entries, checkpoints };
  } catch {
    return;
  }
}

type InputOwner = Pick<LiveRunRow, "runId" | "ownerGen" | "meta">;

export function sourceInputNativeMatches(prior: RunState, entry: SourceInputIntent): boolean {
  const launch = harnessLaunchIntentOf(prior.harnessLaunch),
    facts = prior.harness;
  return (
    launch?.phase === "begun" &&
    launch.harness === entry.native.harness &&
    launch.ordinal === entry.native.launchOrdinal &&
    object(facts) &&
    facts.ended !== true &&
    facts.harness === entry.native.harness &&
    facts.launchOrdinal === entry.native.launchOrdinal &&
    (entry.native.harness === "pi" ? facts.sessionFile : facts.sessionID) === entry.native.sessionId
  );
}

/** Called by existing checkpoint preservation. Only an owner-fenced state
 * write can introduce or advance an intent. Omission preserves originals;
 * explicit replacement, rollback, aliasing or malformed state is refused.
 * This does not verify source access, the row digest, a native result or ACK. */
export function preserveSourceInputIntents(
  prior: RunState,
  incoming: RunState,
  owner?: InputOwner,
): RunState | undefined {
  const oldRaw = prior.sourceInputIntents,
    nextRaw = incoming.sourceInputIntents;
  if (oldRaw === undefined && nextRaw === undefined) return incoming;
  const refuse = (reason: "invalid-metadata" | "original-changed" | "owner-or-session" | "new-intent") => {
    console.warn("[runs/state] source input intent refused", { runId: owner?.runId ?? "unbound", reason });
    return undefined;
  };
  const before = oldRaw === undefined ? undefined : sourceInputIntentsOf(oldRaw);
  const after = nextRaw === undefined ? before : sourceInputIntentsOf(nextRaw);
  if ((oldRaw !== undefined && !before) || !after) return refuse("invalid-metadata");
  // Only the dedicated store transaction can mint or acknowledge a checkpoint.
  // Omission preserves canonical proof; an explicit stale replacement refuses.
  if (nextRaw !== undefined && JSON.stringify(after.checkpoints ?? []) !== JSON.stringify(before?.checkpoints ?? []))
    return refuse("original-changed");
  for (const old of before?.entries ?? []) {
    const next = after.entries.find((entry) => entry.id === old.id);
    if (
      !next ||
      JSON.stringify({ ...next, phase: old.phase }) !== JSON.stringify(old) ||
      (old.phase === "begun" && next.phase !== "begun")
    )
      return refuse("original-changed");
  }
  for (const next of after.entries) {
    const old = before?.entries.find((entry) => entry.id === next.id);
    if (old?.phase === next.phase) continue;
    if (
      !owner ||
      next.owner.runId !== owner.runId ||
      next.owner.requester !== owner.meta.userId ||
      next.owner.channelId !== owner.meta.channelId ||
      next.owner.threadKey !== owner.meta.threadKey ||
      !sourceInputNativeMatches(prior, next)
    )
      return refuse("owner-or-session");
    if (!old && (next.phase !== "prepared" || next.owner.gen !== owner.ownerGen)) return refuse("new-intent");
  }
  return { ...incoming, sourceInputIntents: after };
}

export function sourceInputAdmissionOf(value: unknown): SourceInputAdmission | undefined {
  try {
    const v = sourceSnapshot(value);
    if (
      !object(v) ||
      !closed(v, ["version", "inputId", "intentHash", "native"]) ||
      v.version !== 1 ||
      !text(v.inputId) ||
      !hash(v.intentHash) ||
      !object(v.native)
    )
      return;
    const n = v.native;
    if (
      !closed(n, ["harness", "sessionId", "sessionIdentity", "entryId", "entryHash"]) ||
      !isHarnessName(n.harness) ||
      !text(n.sessionId, 4096) ||
      !text(n.sessionIdentity) ||
      !text(n.entryId) ||
      !hash(n.entryHash)
    )
      return;
    return {
      version: 1,
      inputId: v.inputId,
      intentHash: v.intentHash,
      native: {
        harness: n.harness,
        sessionId: n.sessionId,
        sessionIdentity: n.sessionIdentity,
        entryId: n.entryId,
        entryHash: n.entryHash,
      },
    };
  } catch {
    return;
  }
}

export function sourceInputCheckpointOf(value: unknown): SourceInputCheckpoint | undefined {
  try {
    const v = sourceSnapshot(value);
    if (
      !object(v) ||
      !closed(v, ["receipt", "receiptHash", "taskHash", "acknowledged"]) ||
      !hash(v.receiptHash) ||
      !hash(v.taskHash) ||
      typeof v.acknowledged !== "boolean"
    )
      return;
    const receipt = sourceInputAdmissionOf(v.receipt);
    return receipt
      ? { receipt, receiptHash: v.receiptHash, taskHash: v.taskHash, acknowledged: v.acknowledged }
      : undefined;
  } catch {
    return;
  }
}

export function sourceInputCheckpointRequestOf(value: unknown): SourceInputCheckpointRequest | undefined {
  try {
    const v = sourceSnapshot(value);
    if (!object(v)) return;
    if (v.operation === "commit" && closed(v, ["operation", "receipt"])) {
      const receipt = sourceInputAdmissionOf(v.receipt);
      return receipt ? { operation: "commit", receipt } : undefined;
    }
    if (v.operation === "read" && closed(v, ["operation", "inputId"]) && text(v.inputId))
      return { operation: "read", inputId: v.inputId };
    if (
      v.operation === "ack" &&
      closed(v, ["operation", "inputId", "receiptHash"]) &&
      text(v.inputId) &&
      hash(v.receiptHash)
    )
      return { operation: "ack", inputId: v.inputId, receiptHash: v.receiptHash };
  } catch {
    return;
  }
}

/** Preserve unrelated unread rows when an exact ACK raises the cursor. Ordinary
 * step reports cannot bypass pending source rows or resurrect acknowledged ones. */
export function protectSourceInputStep(
  state: RunState,
  record: StepRecord,
  inbox: readonly InboxItem[],
  prior?: StepRecord,
  verifiedNormalRows: readonly InboxRowWitness[] = [],
): StepRecord | undefined {
  const raw = state.sourceInputIntents;
  const inputs = raw === undefined ? undefined : sourceInputIntentsOf(raw);
  if (raw !== undefined && !inputs) return;
  const normal =
    record.inboxAcknowledgedRows === undefined ? [] : inboxAcknowledgedRowsOf(record.inboxAcknowledgedRows);
  const verified = inboxAcknowledgedRowsOf([...verifiedNormalRows]);
  if (!normal || !verified || JSON.stringify(normal) !== JSON.stringify(verified)) return;
  if (
    raw === undefined &&
    record.inboxAcknowledgedRows === undefined &&
    prior?.inboxAcknowledgedRows === undefined &&
    !inbox.some((item) => item.message.kind === "source-evidence" && item.message.version === 2)
  )
    return record;
  const acknowledged = new Set(
    inputs?.entries
      .filter((entry) =>
        inputs.checkpoints?.some((checkpoint) => checkpoint.receipt.inputId === entry.id && checkpoint.acknowledged),
      )
      .map((entry) => entry.witness.seq),
  );
  const normalSeqs = new Set(normal.map((witness) => witness.seq));
  const consumed = Math.max(record.inboxConsumedSeq, prior?.inboxConsumedSeq ?? 0, ...acknowledged, ...normalSeqs);
  const deferred = new Set(record.inboxDeferredSeqs ?? []);
  if (
    inputs?.checkpoints?.length ||
    record.inboxAcknowledgedRows !== undefined ||
    prior?.inboxAcknowledgedRows !== undefined
  )
    for (const seq of prior?.inboxDeferredSeqs ?? []) deferred.add(seq);
  for (const item of inbox) {
    if (item.seq > consumed) continue;
    if (acknowledged.has(item.seq) || normalSeqs.has(item.seq)) deferred.delete(item.seq);
    else if (
      prior &&
      item.seq <= prior.inboxConsumedSeq &&
      !prior.inboxDeferredSeqs?.includes(item.seq) &&
      item.message.kind !== "source-evidence"
    )
      deferred.delete(item.seq);
    else if (
      record.inboxAcknowledgedRows !== undefined ||
      prior?.inboxAcknowledgedRows !== undefined ||
      item.seq > record.inboxConsumedSeq ||
      (item.message.kind === "source-evidence" && item.message.version === 2)
    )
      deferred.add(item.seq);
  }
  for (const entry of inputs?.entries ?? []) {
    if (entry.witness.seq <= consumed && !acknowledged.has(entry.witness.seq)) deferred.add(entry.witness.seq);
  }
  for (const seq of [...acknowledged, ...normalSeqs]) deferred.delete(seq);
  const next = {
    ...record,
    ...(record.inboxAcknowledgedRows === undefined && prior?.inboxAcknowledgedRows === undefined
      ? {}
      : { inboxAcknowledgedRows: normal }),
    inboxConsumedSeq: consumed,
    ...(deferred.size || record.inboxDeferredSeqs !== undefined
      ? { inboxDeferredSeqs: [...deferred].sort((a, b) => a - b) }
      : {}),
  };
  return new TextEncoder().encode(JSON.stringify(next.inboxDeferredSeqs ?? [])).byteLength <= DURABLE_INBOX_MAX_BYTES
    ? next
    : undefined;
}

/** Prepare a fenced store transition. The caller compares the complete row,
 * inbox and prior step again in its final synchronous transaction. No native
 * operation or retry is performed here; read is the only unknown-write recovery. */
export async function prepareSourceInputCheckpoint(
  row: LiveRunRow,
  request: SourceInputCheckpointRequest,
  inbox: readonly InboxItem[],
  lastStep: StepRecord | undefined,
): Promise<{ state: RunState; step?: StepRecord; checkpoint: SourceInputCheckpoint | null } | undefined> {
  const inputs = sourceInputIntentsOf(row.state.sourceInputIntents);
  const id = request.operation === "commit" ? request.receipt.inputId : request.inputId;
  if (!inputs) return;
  const original = inputs.entries.find((entry) => entry.id === id);
  if (!original) return;
  const saved = inputs.checkpoints?.find((entry) => entry.receipt.inputId === id);
  if (
    saved &&
    (saved.receipt.intentHash !== (await sourceHash(sourceSnapshot(original))) ||
      saved.receiptHash !== (await sourceHash(sourceSnapshot(saved.receipt))))
  )
    return;
  if (request.operation === "read") return { state: row.state, checkpoint: saved ?? null };
  if (
    row.phase !== "live" ||
    original.phase !== "begun" ||
    original.owner.runId !== row.runId ||
    original.owner.requester !== row.meta.userId ||
    original.owner.channelId !== row.meta.channelId ||
    original.owner.threadKey !== row.meta.threadKey
  )
    return;
  if (request.operation === "commit" && saved) {
    return JSON.stringify(sourceSnapshot(request.receipt)) === JSON.stringify(sourceSnapshot(saved.receipt))
      ? { state: row.state, checkpoint: saved }
      : undefined;
  }
  if (request.operation === "ack" && (!saved || saved.receiptHash !== request.receiptHash)) return;
  if (request.operation === "ack" && saved?.acknowledged) return { state: row.state, checkpoint: saved };
  if (!sourceInputNativeMatches(row.state, original)) return;
  const taskHash = await sourceHash(sourceSnapshot(row.state.sourceTask ?? null));
  if (saved && saved.taskHash !== taskHash) return;
  const item = inbox.find((item) => item.seq === original.witness.seq);
  if (
    !item ||
    (lastStep && item.seq <= lastStep.inboxConsumedSeq && !lastStep.inboxDeferredSeqs?.includes(item.seq)) ||
    (await sourceHash(item.message)) !== original.witness.digest
  )
    return;
  const context = row.state.contextDependencies;
  if (
    !isContextDependencies(context) ||
    context.status !== "known" ||
    !context.sourceInputs?.some(
      (reference) => JSON.stringify(sourceSnapshot(reference)) === JSON.stringify(sourceSnapshot(original.reference)),
    )
  )
    return;
  let checkpoint: SourceInputCheckpoint;
  if (request.operation === "commit") {
    const receipt = sourceInputAdmissionOf(request.receipt);
    if (
      !receipt ||
      receipt.intentHash !== (await sourceHash(sourceSnapshot(original))) ||
      receipt.native.harness !== original.native.harness ||
      receipt.native.sessionId !== original.native.sessionId
    )
      return;
    checkpoint = { receipt, receiptHash: await sourceHash(sourceSnapshot(receipt)), taskHash, acknowledged: false };
  } else {
    if (!saved) return;
    checkpoint = { ...saved, acknowledged: true };
  }
  const after = sourceInputIntentsOf({
    version: 2,
    entries: inputs.entries,
    checkpoints: [...(inputs.checkpoints ?? []).filter((entry) => entry.receipt.inputId !== id), checkpoint],
  });
  if (!after) return;
  const state = { ...row.state, sourceInputIntents: after };
  if (request.operation === "ack") {
    if (!lastStep) return;
    const step = protectSourceInputStep(state, lastStep, inbox, lastStep, lastStep.inboxAcknowledgedRows ?? []);
    if (!step) return;
    return { state, step, checkpoint };
  }
  return { state, checkpoint };
}
