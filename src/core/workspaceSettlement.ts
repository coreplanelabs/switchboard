import { branchPublicationOf, type BranchPublication } from "./branchPublication.js";
import { publicationSettlementForRun, type PublicationSettlement } from "./publicationSettlement.js";
import { RUN_ID_PATTERN, type RunRecord } from "./runRecord.js";
import { GEN_PATTERN, type LiveRunRow } from "./runLedger/types.js";

export interface WorkspaceOwner {
  runId: string;
  ownerGen: string;
  ownerFence: number;
}

/** A terminal obligation lives with its ledger owner until the resident has
 * retained these facts. Its acknowledgment never authorizes deleting files. */
export interface WorkspaceSettlement {
  version: 1;
  revision: number;
  owner: WorkspaceOwner;
  binding: {
    backend: "resident";
    ref: string;
    workspace: string;
    user: string;
    container: string;
    ownerFence: number;
    ownerGen: string;
    publicationBaseSha?: string;
  } | null;
  record: Pick<RunRecord, "id" | "threadKey" | "status"> & {
    repo?: string | null;
    userId: string | null;
    parentInstanceId?: string | null;
    idempotencyKey?: string | null;
    publicationSettlement?: PublicationSettlement | null;
  };
  publication: BranchPublication | null;
}

export type WorkspaceAck = { ok: true } | { ok: false; reason: "owner-live" | "stale" | "unverified" };
export const WORKSPACE_SETTLEMENTS_MAX = 20;
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024;
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;

export function isWorkspaceOwner(v: unknown): v is WorkspaceOwner {
  return (
    object(v) &&
    typeof v.runId === "string" &&
    RUN_ID_PATTERN.test(v.runId) &&
    typeof v.ownerGen === "string" &&
    GEN_PATTERN.test(v.ownerGen) &&
    positive(v.ownerFence)
  );
}

export function workspaceOwnerKey(owner: WorkspaceOwner): string {
  return JSON.stringify([owner.runId, owner.ownerGen, owner.ownerFence]);
}

/** Coordinator reservations may use a host key for exclusivity while their
 * admitted metadata retains the conversation's actual thread. */
export function terminalThreadKey(row: Pick<LiveRunRow, "meta" | "threadKey">): string {
  return text(row.meta.threadKey) ? row.meta.threadKey : row.threadKey;
}

export function terminalWorkspaceRecordMatches(row: LiveRunRow, record: RunRecord): boolean {
  if (record.provisional || record.id !== row.runId) return false;
  const b = row.state.binding;
  return (
    !object(b) ||
    b.backend !== "resident" ||
    !isWorkspaceOwner({ runId: row.runId, ownerGen: b.ownerGen, ownerFence: b.ownerFence }) ||
    record.threadKey === terminalThreadKey(row)
  );
}

export function workspaceBindingOf(
  value: unknown,
  owner: WorkspaceOwner,
): NonNullable<WorkspaceSettlement["binding"]> | undefined {
  if (
    !object(value) ||
    value.backend !== "resident" ||
    ![value.ref, value.workspace, value.user, value.container].every(text) ||
    value.ownerFence !== owner.ownerFence ||
    value.ownerGen !== owner.ownerGen ||
    !String(value.workspace).startsWith("/workspace/threads/") ||
    (value.publicationBaseSha !== undefined &&
      (typeof value.publicationBaseSha !== "string" || !/^[a-f0-9]{40}$/.test(value.publicationBaseSha)))
  )
    return;
  return structuredClone(value) as unknown as NonNullable<WorkspaceSettlement["binding"]>;
}

export function workspaceSettlementOf(value: unknown): WorkspaceSettlement | undefined {
  if (
    !object(value) ||
    value.version !== 1 ||
    !positive(value.revision) ||
    !isWorkspaceOwner(value.owner) ||
    (value.binding !== null && !object(value.binding)) ||
    !object(value.record)
  )
    return;
  const b = value.binding,
    r = value.record,
    owner = value.owner;
  if (b !== null && !workspaceBindingOf(b, owner)) return;
  if (
    r.id !== owner.runId ||
    !text(r.threadKey) ||
    (r.userId !== null && !text(r.userId)) ||
    !["completed", "stopped_soft", "stopped_hard", "failed", "interrupted"].includes(String(r.status)) ||
    [r.repo, r.parentInstanceId, r.idempotencyKey].some((v) => v !== undefined && v !== null && !text(v))
  )
    return;
  if (value.publication !== null) {
    const publication = branchPublicationOf(value.publication);
    if (!publication || publication.repo !== r.repo) return;
  }
  if (r.publicationSettlement !== undefined && r.publicationSettlement !== null) {
    const proof = publicationSettlementForRun(r.publicationSettlement, r);
    if (!proof || proof.binding.generation !== owner.ownerGen || !b || proof.binding.branch !== b.ref) return;
  }
  return structuredClone(value) as unknown as WorkspaceSettlement;
}

/** Read only the state committed by the terminal writer's exact live owner. */
export function terminalWorkspaceSettlement(row: LiveRunRow, record: RunRecord): WorkspaceSettlement | undefined {
  const b = row.state.binding;
  if (!object(b) || record.provisional || record.id !== row.runId || record.threadKey !== terminalThreadKey(row))
    return;
  const owner = { runId: row.runId, ownerGen: b.ownerGen, ownerFence: b.ownerFence };
  if (b.backend !== "resident" || !isWorkspaceOwner(owner)) return;
  const proof = publicationSettlementForRun(row.state.publicationSettlement, record);
  const repo = record.repo === undefined ? undefined : text(record.repo) ? record.repo : null;
  const publication = branchPublicationOf(row.state.branchPublication, record.repo);
  const candidate = {
    version: 1,
    revision: 1,
    owner,
    binding: {
      backend: b.backend,
      ref: b.ref,
      workspace: b.workspace,
      user: b.user,
      container: b.container,
      ownerFence: b.ownerFence,
      ownerGen: b.ownerGen,
      ...(b.publicationBaseSha === undefined ? {} : { publicationBaseSha: b.publicationBaseSha }),
    },
    record: {
      id: record.id,
      threadKey: record.threadKey,
      status: record.status,
      repo,
      userId: text(record.userId) ? record.userId : null,
      parentInstanceId:
        record.parentInstanceId === undefined
          ? undefined
          : text(record.parentInstanceId)
            ? record.parentInstanceId
            : null,
      idempotencyKey:
        record.idempotencyKey === undefined ? undefined : text(record.idempotencyKey) ? record.idempotencyKey : null,
      ...(row.state.publicationSettlement === undefined
        ? {}
        : {
            publicationSettlement:
              proof && proof.binding.generation === b.ownerGen && proof.binding.branch === b.ref ? proof : null,
          }),
    },
    publication: publication?.repo === repo ? (publication ?? null) : null,
  };
  const verified = workspaceSettlementOf(candidate);
  return (
    verified ??
    workspaceSettlementOf({
      ...candidate,
      binding: null,
      record: {
        ...candidate.record,
        ...(candidate.record.publicationSettlement === undefined ? {} : { publicationSettlement: null }),
      },
    })
  );
}

export function workspaceAcknowledgment(
  value: WorkspaceSettlement | null | undefined,
  revision: number,
  live: boolean,
  currentRevision?: number,
): WorkspaceAck {
  if (live) return { ok: false, reason: "owner-live" };
  if (value === null) return { ok: false, reason: "unverified" };
  if (
    !positive(revision) ||
    (currentRevision !== undefined && revision > currentRevision) ||
    (value && value.revision !== revision)
  )
    return { ok: false, reason: "stale" };
  if (
    value &&
    (value.publication?.complete !== true ||
      value.binding === null ||
      value.record.publicationSettlement === null ||
      [value.record.userId, value.record.repo, value.record.parentInstanceId, value.record.idempotencyKey].some(
        (v) => v === null,
      ))
  )
    return { ok: false, reason: "unverified" };
  return { ok: true };
}

export function nextWorkspaceRevision(prior?: number): number {
  if (prior !== undefined && !positive(prior)) throw new Error("workspace obligation is unverified");
  const revision = (prior ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) throw new Error("workspace obligation revision exhausted");
  return revision;
}
