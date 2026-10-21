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
import type { InboxItem, InboxRowWitness, LiveRunRow, RunState } from "./types.js";
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

export interface SourceInputIntents {
  version: 1;
  entries: SourceInputIntent[];
}

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

/** Both supported phases are unresolved. Unsupported retained data also stays
 * protected; a decoder failure is never proof that the obligation ended. */
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
      !closed(v, ["version", "entries"]) ||
      v.version !== 1 ||
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
    return { version: 1, entries };
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
