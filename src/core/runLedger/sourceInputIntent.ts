import { isHarnessName, type HARNESS_NAMES } from "../harness/names.js";
import { harnessLaunchIntentOf } from "../harness/sessionPolicy.js";
import {
  sourceInputIdentity,
  sourceInputReferenceOf,
  type SourceInputReference,
} from "../references/sourceInputReference.js";
import { sourceSnapshot } from "./sourceEvents.js";
import { DURABLE_INBOX_MAX_BYTES } from "./inboxMessage.js";
import type { InboxRowWitness, LiveRunRow, RunState } from "./types.js";

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

function nativeMatches(prior: RunState, entry: SourceInputIntent): boolean {
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
      !nativeMatches(prior, next)
    )
      return refuse("owner-or-session");
    if (!old && (next.phase !== "prepared" || next.owner.gen !== owner.ownerGen)) return refuse("new-intent");
  }
  return { ...incoming, sourceInputIntents: after };
}
