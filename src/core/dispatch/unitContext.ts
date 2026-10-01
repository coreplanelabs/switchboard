import { boundChildHandoff, isChildHandoff, type ChildHandoff } from "./handoff.js";

/** Immutable evidence saved with the original unit, outside model-authored instructions. */
export interface UnitContext {
  version: 1;
  handoff: ChildHandoff;
}

export interface UnitContextBinding {
  instanceId: string;
  unit: string;
  instanceAttempt: number;
  idempotencyKey: string;
}

/** Returned only after reading the canonical unit and its actual execution destination. */
export interface UnitContextAdmission {
  binding: UnitContextBinding;
  context: UnitContext;
  requester: string;
  channelId: string;
  threadKey: string;
}

// The source envelope and notepad have independent 16 KiB and 8 KiB bounds.
// Leave room for both and compact artifact references inside the unit budget.
export const UNIT_CONTEXT_MAX_BYTES = 32 * 1024;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function isUnitContext(value: unknown): value is UnitContext {
  if (!value || typeof value !== "object") return false;
  const candidate = value as UnitContext;
  try {
    return (
      candidate.version === 1 &&
      Object.keys(candidate).every((k) => k === "version" || k === "handoff") &&
      isChildHandoff(candidate.handoff) &&
      candidate.handoff.consumer === undefined &&
      candidate.handoff.snapshotRunId === undefined &&
      bytes(candidate) <= UNIT_CONTEXT_MAX_BYTES
    );
  } catch {
    return false;
  }
}

/** Compacts references only. A note without an earlier durable snapshot cannot be discarded. */
export function contextCapsuleOf(handoff: ChildHandoff): UnitContext {
  const context: UnitContext = {
    version: 1,
    handoff: boundChildHandoff(handoff, UNIT_CONTEXT_MAX_BYTES - bytes({ version: 1, handoff: {} }) + 2),
  };
  if (!isUnitContext(context))
    throw new Error("the context snapshot exceeds the work storage budget or is already bound");
  return context;
}

export function isUnitContextBinding(value: unknown): value is UnitContextBinding {
  if (!value || typeof value !== "object") return false;
  const b = value as UnitContextBinding;
  return (
    [b.instanceId, b.unit, b.idempotencyKey].every((s) => typeof s === "string" && s.length > 0 && s.length <= 512) &&
    Number.isSafeInteger(b.instanceAttempt) &&
    b.instanceAttempt >= 0
  );
}

export function sameUnitContextBinding(a: UnitContextBinding, b: UnitContextBinding): boolean {
  return (
    a.instanceId === b.instanceId &&
    a.unit === b.unit &&
    a.instanceAttempt === b.instanceAttempt &&
    a.idempotencyKey === b.idempotencyKey
  );
}
