import { sourceHash } from "../references/receipts.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import type { MainTaskLink } from "./mainTaskLink.js";

/** A current read, distinct from an immutable historical status delivery. */
export interface WorkStateObservation {
  version: 1;
  actId: string;
  instanceId: string;
  unit: string;
  attempt: number;
  requesterId: string;
  channelId: string;
  mainThreadKey: string;
  snapshotHash: string;
  observedAt: number;
}

export interface MainWorkReadInput {
  actId: string;
  afterSeq?: number;
  afterHistory?: number;
}

export type MainWorkReadRefresh =
  | { kind: "unchanged" }
  | { kind: "unavailable" }
  | { kind: "changed"; observation: WorkStateObservation; resultHash: string; content: string };

export interface MainWorkRead {
  tool: "work_status" | "work_progress";
  callId: string;
  input: MainWorkReadInput;
  observation: WorkStateObservation;
  resultHash: string;
  content: string;
  /** Reread under the current audience. A changed result becomes the next comparison baseline. */
  refresh(): Promise<MainWorkReadRefresh>;
}
export type MainWorkReadObserver = (read: MainWorkRead) => void | Promise<void>;
export type MainWorkReadReceipt = Omit<MainWorkRead, "refresh" | "content">;

export function isMainWorkReadReceipt(value: unknown): value is MainWorkReadReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as MainWorkReadReceipt;
  const o = r.observation;
  const id = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 512;
  const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  return (
    Object.keys(r).every((key) => ["tool", "callId", "input", "observation", "resultHash"].includes(key)) &&
    ["work_status", "work_progress"].includes(r.tool) &&
    id(r.callId) &&
    hash(r.resultHash) &&
    !!r.input &&
    typeof r.input === "object" &&
    Object.keys(r.input).every((key) => ["actId", "afterSeq", "afterHistory"].includes(key)) &&
    typeof r.input.actId === "string" &&
    /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(r.input.actId) &&
    [r.input.afterSeq, r.input.afterHistory].every(
      (cursor) => cursor === undefined || (Number.isSafeInteger(cursor) && cursor >= 0),
    ) &&
    (r.tool !== "work_status" || (r.input.afterSeq === undefined && r.input.afterHistory === undefined)) &&
    !!o &&
    typeof o === "object" &&
    Object.keys(o).every((key) =>
      [
        "version",
        "actId",
        "instanceId",
        "unit",
        "attempt",
        "requesterId",
        "channelId",
        "mainThreadKey",
        "snapshotHash",
        "observedAt",
      ].includes(key),
    ) &&
    o.version === 1 &&
    o.actId === r.input.actId &&
    [o.instanceId, o.unit, o.requesterId, o.channelId, o.mainThreadKey].every(id) &&
    Number.isSafeInteger(o.attempt) &&
    o.attempt >= 0 &&
    Number.isFinite(o.observedAt) &&
    o.observedAt >= 0 &&
    hash(o.snapshotHash)
  );
}

export function restoreMainWorkRead(
  receipt: MainWorkReadReceipt,
  read: () => Promise<{ observation: WorkStateObservation; content: string } | undefined>,
): () => Promise<MainWorkReadRefresh> {
  const original = structuredClone(receipt.observation);
  let baseline = original.snapshotHash;
  return async () => {
    try {
      const current = await read();
      if (!current) return { kind: "unavailable" };
      const next = current.observation;
      if (
        next.actId !== original.actId ||
        next.instanceId !== original.instanceId ||
        next.unit !== original.unit ||
        next.requesterId !== original.requesterId ||
        next.channelId !== original.channelId ||
        next.mainThreadKey !== original.mainThreadKey ||
        next.attempt < original.attempt
      )
        return { kind: "unavailable" };
      if (next.snapshotHash === baseline) return { kind: "unchanged" };
      baseline = next.snapshotHash;
      return { kind: "changed", ...current, resultHash: await sourceHash(current.content) };
    } catch {
      return { kind: "unavailable" };
    }
  };
}

/** Object-key ordering is not a work transition. Arrays retain their meaning and order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}

export const workStateHash = (value: unknown): Promise<string> => sourceHash(canonical(value));

export async function observeWorkState(
  actId: string,
  snapshot: { link: MainTaskLink; instance: CoordinatorInstance; unit: CoordinatorUnit; brief?: unknown },
  observedAt: number,
  read?: unknown,
): Promise<WorkStateObservation> {
  return {
    version: 1,
    actId,
    instanceId: snapshot.instance.id,
    unit: snapshot.unit.unit,
    attempt: snapshot.instance.attempt ?? 0,
    requesterId: snapshot.instance.userId,
    channelId: snapshot.instance.channelId,
    mainThreadKey: snapshot.instance.threadKey,
    snapshotHash: await workStateHash({ snapshot, read }),
    observedAt,
  };
}

/** Hash the final serialized bytes after the tool's escaping, before model exposure. */
export async function recordMainWorkRead(
  observer: MainWorkReadObserver,
  input: Omit<MainWorkRead, "resultHash" | "refresh">,
  read: () => Promise<{ observation: WorkStateObservation; content: string } | undefined>,
): Promise<void> {
  const frozen = structuredClone(input);
  const receipt = {
    tool: frozen.tool,
    callId: frozen.callId,
    input: frozen.input,
    observation: frozen.observation,
    resultHash: await sourceHash(frozen.content),
  };
  await observer({
    ...frozen,
    resultHash: receipt.resultHash,
    refresh: restoreMainWorkRead(receipt, read),
  });
}
