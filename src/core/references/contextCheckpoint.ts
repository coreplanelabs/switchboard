import type { ChannelVisibility } from "../authz/types.js";
import type { LiveRunMeta } from "../runLedger/types.js";
import { directAudienceStampOf } from "../runLedger/inboxMessage.js";
import { sourceHash } from "./receipts.js";
import {
  contextDependenciesContain,
  contextDependenciesHash,
  isContextDependencies,
  type ContextDependencies,
  type ContextOrigin,
} from "./contextDependencies.js";

/** Recent ordinary rows may reuse a sealed checkpoint's authority. Older
 * identities age out; frozen handoffs and external source obligations do not. */
export const ORDINARY_CONTEXT_HISTORY_RUNS = 128;

export interface CheckpointAuthority {
  requester: string;
  channelId: string;
  threadKey: string;
  channelVisibility: ChannelVisibility;
  repo?: string;
  authenticatedAs?: string;
  postedBy?: string;
  directAudience?: LiveRunMeta["directAudience"];
}
export interface ContextCheckpointInputs {
  transcriptHash: string;
  systemHash: string;
  notepadHash: string;
}
export interface ContextCheckpointSession {
  key: string;
  seedFrom: number;
  request: number;
  from: number;
  through: number;
}
export interface ContextCheckpointReceipt {
  version: 1;
  hash: string;
  runId: string;
  ownerGen: string;
  authority: CheckpointAuthority;
  session: ContextCheckpointSession;
  inputs: ContextCheckpointInputs;
  beforeHash: string;
  beforeRevision: number;
  /** Seals the newest-first ordinary aliases in the existing index. Aliases do not pin archives. */
  membershipHash: string;
  membershipCount: number;
  /** Only the immediately covered origins. The alias window retains bounded older membership. */
  coveredOrigins: readonly ContextOrigin[];
  normalized: ContextDependencies;
  normalizedHash: string;
}
export interface ContextCheckpointRequest {
  key: string;
  runId: string;
  gen: string;
  expected: { beforeHash: string; revision: number; inputs: ContextCheckpointInputs };
}
export type ContextCheckpointResult =
  | { ok: true; receipt: ContextCheckpointReceipt }
  | { ok: false; reason: "fenced" | "unknown-run" | "checkpoint-unavailable" };

/** Facts read from the canonical run and its retained session, never a caller's manifest. */
export interface CanonicalCheckpointSource {
  runId: string;
  meta: Pick<
    LiveRunMeta,
    | "userId"
    | "channelId"
    | "threadKey"
    | "channelVisibility"
    | "repo"
    | "authenticatedAs"
    | "postedBy"
    | "directAudience"
    | "parentInstanceId"
    | "parentRunId"
    | "childHandoff"
    | "hosted"
    | "session"
  >;
  context: ContextDependencies;
  /** Hash of the receipt's exact retained seed rows, including actors and compactions. */
  transcriptHash?: string;
  /** Only committed receipts belong here. A prepared cross-store write grants nothing. */
  receipt?: ContextCheckpointReceipt;
  /** Canonical ordinary-member edges read with the committed receipt; never an envelope field. */
  members?: readonly string[];
  /** Exact original marker for each alias; an empty self marker avoids a hash cycle. */
  memberCheckpoints?: Readonly<Record<string, string>>;
}

const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;

export function checkpointAuthorityOf(meta: CanonicalCheckpointSource["meta"]): CheckpointAuthority | undefined {
  if (
    !meta.userId ||
    !meta.channelId ||
    !meta.threadKey ||
    !meta.channelVisibility ||
    meta.channelVisibility === "unknown" ||
    meta.threadKey.startsWith("worker:") ||
    meta.parentInstanceId !== undefined ||
    meta.parentRunId !== undefined ||
    meta.childHandoff !== undefined ||
    meta.hosted === true
  )
    return undefined;
  if (meta.directAudience !== undefined && directAudienceStampOf(meta) === undefined) return undefined;
  return {
    requester: meta.userId,
    channelId: meta.channelId,
    threadKey: meta.threadKey,
    channelVisibility: meta.channelVisibility,
    ...(meta.repo !== undefined ? { repo: meta.repo.toLowerCase() } : {}),
    ...(meta.authenticatedAs !== undefined ? { authenticatedAs: meta.authenticatedAs } : {}),
    ...(meta.postedBy !== undefined ? { postedBy: meta.postedBy } : {}),
    ...(meta.directAudience !== undefined ? { directAudience: structuredClone(meta.directAudience) } : {}),
  };
}

export function isContextCheckpointReceipt(value: unknown): value is ContextCheckpointReceipt {
  if (!value || typeof value !== "object") return false;
  const r = value as ContextCheckpointReceipt;
  try {
    return (
      r.version === 1 &&
      text(r.runId) &&
      text(r.ownerGen) &&
      hash(r.hash) &&
      hash(r.beforeHash) &&
      hash(r.normalizedHash) &&
      hash(r.membershipHash) &&
      Number.isSafeInteger(r.membershipCount) &&
      r.membershipCount > 0 &&
      r.membershipCount <= ORDINARY_CONTEXT_HISTORY_RUNS &&
      Number.isSafeInteger(r.beforeRevision) &&
      r.beforeRevision >= 0 &&
      !!r.authority &&
      [r.authority.requester, r.authority.channelId, r.authority.threadKey].every(text) &&
      ["public", "private", "dm", "machine"].includes(r.authority.channelVisibility) &&
      [r.authority.repo, r.authority.authenticatedAs, r.authority.postedBy].every((v) => v === undefined || text(v)) &&
      (r.authority.directAudience === undefined ||
        directAudienceStampOf({ ...r.authority, userId: r.authority.requester }) !== undefined) &&
      !!r.inputs &&
      [r.inputs.transcriptHash, r.inputs.systemHash, r.inputs.notepadHash].every(hash) &&
      !!r.session &&
      text(r.session.key) &&
      [r.session.seedFrom, r.session.request, r.session.from].every((n) => Number.isSafeInteger(n) && n >= 0) &&
      Number.isSafeInteger(r.session.through) &&
      r.session.through >= r.session.from - 1 &&
      r.session.seedFrom <= r.session.from &&
      r.session.request >= r.session.seedFrom &&
      r.session.request <= r.session.through &&
      Array.isArray(r.coveredOrigins) &&
      r.coveredOrigins.length <= 32 &&
      r.coveredOrigins.every(
        (o) =>
          o &&
          [o.runId, o.requester, o.channelId, o.threadKey].every(text) &&
          (o.checkpoint === undefined || hash(o.checkpoint)),
      ) &&
      new Set(r.coveredOrigins.map((o) => o.runId)).size === r.coveredOrigins.length &&
      isContextDependencies(r.normalized) &&
      r.normalized.status === "known" &&
      new TextEncoder().encode(JSON.stringify(r)).byteLength <= 32 * 1024
    );
  } catch {
    return false;
  }
}

function baseContext(receipt: Pick<ContextCheckpointReceipt, "runId" | "normalized">): ContextDependencies {
  return {
    ...receipt.normalized,
    origins: receipt.normalized.origins.map((origin) => {
      if (origin.runId !== receipt.runId) return origin;
      const { checkpoint: _checkpoint, ...plain } = origin as ContextOrigin & { checkpoint?: string };
      return plain;
    }),
  };
}
async function receiptHash(receipt: Omit<ContextCheckpointReceipt, "hash" | "normalizedHash">): Promise<string> {
  const { hash: _hash, normalizedHash: _normalizedHash, normalized, ...proof } = receipt as ContextCheckpointReceipt;
  return sourceHash({
    ...proof,
    normalizedBaseHash: await contextDependenciesHash(baseContext({ runId: receipt.runId, normalized })),
  });
}
const sourceOrigin = (source: CanonicalCheckpointSource): ContextOrigin => ({
  runId: source.runId,
  requester: source.meta.userId,
  channelId: source.meta.channelId,
  threadKey: source.meta.threadKey,
});
const sameOrigin = (a: ContextOrigin, b: ContextOrigin) =>
  a.runId === b.runId && a.requester === b.requester && a.channelId === b.channelId && a.threadKey === b.threadKey;

/** Direct validation reads this checkpoint's seed, not a chain of predecessor archives. */
export async function validateContextCheckpoint(receipt: unknown, source: CanonicalCheckpointSource): Promise<boolean> {
  if (!isContextCheckpointReceipt(receipt) || source.receipt?.hash !== receipt.hash) return false;
  const authority = checkpointAuthorityOf(source.meta);
  const session = source.meta.session;
  const memberHashes = source.memberCheckpoints ?? (source.members?.length === 1 ? { [source.runId]: "" } : {});
  if (
    !authority ||
    !session ||
    receipt.runId !== source.runId ||
    receipt.session.key !== session.key ||
    receipt.session.seedFrom !== session.seedFrom ||
    receipt.session.request !== session.request ||
    !checkpointRangeMatchesRun(receipt, session) ||
    source.transcriptHash !== receipt.inputs.transcriptHash ||
    !source.members ||
    source.members.length !== receipt.membershipCount ||
    new Set(source.members).size !== receipt.membershipCount ||
    Object.keys(memberHashes).length !== receipt.membershipCount ||
    source.members.some((id) => (id === source.runId ? memberHashes[id] !== "" : !hash(memberHashes[id]))) ||
    (await checkpointMembershipHash(source.members, memberHashes)) !== receipt.membershipHash ||
    !source.members.includes(source.runId) ||
    (await sourceHash(authority)) !== (await sourceHash(receipt.authority)) ||
    (await contextDependenciesHash(receipt.normalized)) !== receipt.normalizedHash ||
    (await receiptHash(receipt)) !== receipt.hash
  )
    return false;
  const own = receipt.normalized.origins.find((o) => o.runId === source.runId) as
    (ContextOrigin & { checkpoint?: string }) | undefined;
  return !!own && sameOrigin(own, sourceOrigin(source)) && own.checkpoint === receipt.hash;
}

/** The storage boundary supplies exact owner/seed/source revision facts and
 * commits this plan with its retention index. A tuple is never membership proof. */
export async function planContextCheckpoint(input: {
  run: CanonicalCheckpointSource;
  ownerGen: string;
  through: number;
  inputs: ContextCheckpointInputs;
  expected: ContextCheckpointRequest["expected"];
  sources: readonly CanonicalCheckpointSource[];
}): Promise<ContextCheckpointReceipt | undefined> {
  const { run, expected, inputs } = input;
  const authority = checkpointAuthorityOf(run.meta);
  const session = run.meta.session;
  // The seed is sealed once. Later tool calls extend its dependency closure,
  // and must never produce a conflicting checkpoint for the same run.
  if (run.receipt !== undefined || run.context.origins.some((o) => o.runId === run.runId && o.checkpoint !== undefined))
    return undefined;
  if (
    !authority ||
    !session ||
    session.range === "broken" ||
    !isContextDependencies(run.context) ||
    run.context.status !== "known" ||
    run.context.revision !== expected.revision ||
    (await contextDependenciesHash(run.context)) !== expected.beforeHash ||
    (await sourceHash(inputs)) !== (await sourceHash(expected.inputs)) ||
    input.through < session.request ||
    run.context.revision >= Number.MAX_SAFE_INTEGER
  )
    return undefined;
  const coveredOrigins: ContextOrigin[] = [];
  for (const origin of run.context.origins) {
    if (origin.runId === run.runId) {
      if (!sameOrigin(origin, sourceOrigin(run))) return undefined;
      continue;
    }
    const source = input.sources.find((s) => s.runId === origin.runId);
    if (!source || !sameOrigin(origin, sourceOrigin(source))) return undefined;
    const sourceAuthority = checkpointAuthorityOf(source.meta);
    if (!sourceAuthority || (await sourceHash(sourceAuthority)) !== (await sourceHash(authority))) continue;
    // Legacy origins remain explicit. Only a canonical committed predecessor
    // checkpoint attests the complete note/summary closure beyond visible rows.
    if (!source.receipt) continue;
    if (
      !(await validateContextCheckpoint(source.receipt, source)) ||
      (origin.checkpoint !== undefined && origin.checkpoint !== source.receipt.hash) ||
      !contextDependenciesContain(run.context, baseContext(source.receipt))
    )
      return undefined;
    coveredOrigins.push(origin);
  }
  const own = sourceOrigin(run);
  const members = checkpointMembersOf(run.runId, coveredOrigins, input.sources);
  const base: ContextDependencies = {
    ...run.context,
    revision: run.context.revision + 1,
    origins: [
      ...run.context.origins.filter((o) => o.runId !== run.runId && !coveredOrigins.some((c) => c.runId === o.runId)),
      own,
    ],
  };
  const proof = {
    version: 1 as const,
    runId: run.runId,
    ownerGen: input.ownerGen,
    authority,
    session: {
      key: session.key,
      seedFrom: session.seedFrom,
      request: session.request,
      from: session.range.from,
      through: input.through,
    },
    inputs: structuredClone(inputs),
    beforeHash: expected.beforeHash,
    beforeRevision: expected.revision,
    membershipHash: await checkpointMembershipHash(
      members,
      checkpointMemberHashesOf(run.runId, coveredOrigins, input.sources),
    ),
    membershipCount: members.length,
    coveredOrigins: structuredClone(coveredOrigins),
    normalized: base,
  };
  const digest = await receiptHash(proof);
  const normalized: ContextDependencies = {
    ...base,
    origins: base.origins.map((o) => (o.runId === run.runId ? { ...o, checkpoint: digest } : o)),
  };
  const receipt = { ...proof, hash: digest, normalized, normalizedHash: await contextDependenciesHash(normalized) };
  return isContextCheckpointReceipt(receipt) ? receipt : undefined;
}

export function checkpointMembersOf(
  runId: string,
  covered: readonly ContextOrigin[],
  sources: readonly CanonicalCheckpointSource[],
): string[] {
  return [
    ...new Set([
      runId,
      ...covered.flatMap((origin) => [origin.runId, ...(sources.find((s) => s.runId === origin.runId)?.members ?? [])]),
    ]),
  ].slice(0, ORDINARY_CONTEXT_HISTORY_RUNS);
}
export function checkpointMemberHashesOf(
  runId: string,
  covered: readonly ContextOrigin[],
  sources: readonly CanonicalCheckpointSource[],
): Record<string, string> {
  const values: Record<string, string> = { [runId]: "" };
  for (const origin of covered) {
    const source = sources.find((candidate) => candidate.runId === origin.runId);
    if (!source?.receipt) continue;
    for (const member of [source.runId, ...(source.members ?? [])])
      if (!(member in values))
        values[member] = member === source.runId ? source.receipt.hash : (source.memberCheckpoints?.[member] ?? "");
  }
  return Object.fromEntries(checkpointMembersOf(runId, covered, sources).map((id) => [id, values[id] ?? ""]));
}
export function checkpointMembershipHash(
  members: readonly string[],
  hashes: Readonly<Record<string, string>>,
): Promise<string> {
  return sourceHash([...new Set(members)].map((id) => [id, hashes[id]]));
}

/** Both inputs must be canonically validated first. Session offsets order one
 * ordinary lane; a different lane or authority remains an independent source. */
export function checkpointOutsideOrdinaryWindow(
  source: CanonicalCheckpointSource,
  latest: CanonicalCheckpointSource,
): boolean {
  const older = source.receipt,
    current = latest.receipt;
  return (
    !!older &&
    !!current &&
    current.membershipCount === ORDINARY_CONTEXT_HISTORY_RUNS &&
    older.session.key === current.session.key &&
    older.session.through < current.session.through &&
    JSON.stringify(older.authority) === JSON.stringify(current.authority) &&
    latest.members !== undefined &&
    !latest.members.includes(source.runId)
  );
}

/** Applied only with a canonically committed receipt by the storage path. */
export function applyContextCheckpoint(
  context: ContextDependencies,
  receipt: ContextCheckpointReceipt,
): ContextDependencies {
  if (context.status !== "known") return context;
  const current = receipt.normalized.origins.find((o) => o.runId === receipt.runId);
  if (
    !current ||
    !context.origins.some((o) => sameOrigin(o, current) || receipt.coveredOrigins.some((c) => sameOrigin(c, o)))
  )
    return context;
  return {
    ...context,
    origins: [
      ...context.origins.filter(
        (o) => !sameOrigin(o, current) && !receipt.coveredOrigins.some((c) => sameOrigin(c, o)),
      ),
      current,
    ],
  };
}

/** Structural archive binding. A full reader must also verify the committed
 * receipt's hashes, retained seed and canonical membership index. */
export function contextCheckpointMatchesRun(
  receipt: ContextCheckpointReceipt,
  source: Pick<CanonicalCheckpointSource, "runId" | "meta" | "context">,
): boolean {
  const authority = checkpointAuthorityOf(source.meta);
  const session = source.meta.session;
  if (!authority || !session) return false;
  return (
    receipt.runId === source.runId &&
    JSON.stringify(authority) === JSON.stringify(receipt.authority) &&
    receipt.session.key === session.key &&
    receipt.session.seedFrom === session.seedFrom &&
    receipt.session.request === session.request &&
    checkpointRangeMatchesRun(receipt, session) &&
    source.context.origins.some(
      (origin) =>
        origin.runId === source.runId && origin.checkpoint === receipt.hash && sameOrigin(origin, sourceOrigin(source)),
    )
  );
}

/** A later failed write breaks the open tail, not a prefix already sealed by
 * the canonical checkpoint. Full reads still verify that prefix's hash. */
function checkpointRangeMatchesRun(
  receipt: ContextCheckpointReceipt,
  session: NonNullable<CanonicalCheckpointSource["meta"]["session"]>,
): boolean {
  if (session.range === "broken")
    return receipt.session.from >= session.seedFrom && receipt.session.from <= receipt.session.request;
  return (
    receipt.session.from === session.range.from &&
    (session.range.to === undefined || receipt.session.through <= session.range.to)
  );
}

/** Normalize frozen row identities through committed canonical membership.
 * Callers check each checkpoint's current audience first, then validate the
 * resulting row's complete dependency closure before exposing its bytes.
 * This changes the aggregate read only; historical row metadata stays immutable. */
export async function normalizeCheckpointContexts(
  contexts: readonly ContextDependencies[],
  sources: readonly CanonicalCheckpointSource[],
): Promise<ContextDependencies[]> {
  const proved: CanonicalCheckpointSource[] = [];
  for (const source of sources)
    if (source.receipt && (await validateContextCheckpoint(source.receipt, source))) proved.push(source);
  proved.sort((a, b) => b.receipt!.membershipCount - a.receipt!.membershipCount);
  return contexts.map((context) => {
    let normalized = context;
    for (const source of proved) normalized = applyContextCheckpointAliases(normalized, source);
    return normalized;
  });
}

/** The storage boundary validates this source's canonical receipt first. Apply
 * its sealed alias window before a union can overflow; external leaves stay exact. */
export function applyContextCheckpointAliases(
  context: ContextDependencies,
  source: CanonicalCheckpointSource,
): ContextDependencies {
  const receipt = source.receipt;
  if (context.status !== "known" || !receipt) return context;
  const members = new Set(source.members);
  const covered = (origin: ContextOrigin) =>
    members.has(origin.runId) &&
    origin.requester === receipt.authority.requester &&
    origin.channelId === receipt.authority.channelId &&
    origin.threadKey === receipt.authority.threadKey &&
    (origin.checkpoint === undefined ||
      origin.checkpoint === (origin.runId === source.runId ? receipt.hash : source.memberCheckpoints?.[origin.runId]));
  if (!context.origins.some(covered)) return context;
  const current = receipt.normalized.origins.find((origin) => origin.runId === receipt.runId);
  if (!current) return context;
  return { ...context, origins: [...context.origins.filter((origin) => !covered(origin)), current] };
}
