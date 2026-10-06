import {
  normalizedSeedDoorOrigin,
  parsePreservationOwner,
  sameOwner,
  type CheckpointRecord,
  type PreservationOwner,
} from "./sandboxCheckpoint.js";
import type { WarmUpOutcome } from "./sandboxStart.js";

export const OPERATION_WINDOW_SIZE = 16;
export interface OperationOwner {
  runId: string;
  ownerGen: string;
  allocationKey: string;
  actorId: string;
}
export type OperationKind = "warm-up" | "sdk" | "process" | "stream";
export type UnknownCause = "sdk-rejected" | "caller-timeout" | "caller-abort" | "reset-lost" | "unsupported-classifier";
export interface OperationSlot {
  ordinal: number;
  operation: OperationKind;
  parentOrdinal?: number;
  state: "admitted" | "settled" | "unknown";
  cause?: UnknownCause;
}
export interface OperationWindow {
  issuedThrough: number;
  settledThrough: number;
  slots: (OperationSlot | null)[];
}
export interface LifecycleRecord extends Partial<CheckpointRecord> {
  version: 2;
  lifecycle: {
    allocation: OperationOwner;
    binding: "pending" | "bound" | "unknown";
    admission: "open" | "closing" | "closed";
    operationWindow: OperationWindow;
  };
}
export type DecodedLifecycle =
  | { kind: "legacy"; record: CheckpointRecord; authority: "unverified" }
  | { kind: "versioned"; record: LifecycleRecord; authority: "unverified" }
  | { kind: "unknown" };
export interface OperationSelector extends OperationOwner {
  ordinal: number;
}
export type CallbackOutcome =
  { kind: "warm-up"; outcome: WarmUpOutcome } | { kind: "unknown"; cause: UnknownCause } | { kind: "unsupported" };
export type WindowTransition =
  | { kind: "reserved"; record: LifecycleRecord; selector: OperationSelector; authority: "unverified" }
  | { kind: "recorded" | "unchanged"; record: LifecycleRecord; authority: "unverified" }
  | { kind: "held"; reason: string };

const OWNER_FIELDS = ["runId", "ownerGen", "allocationKey", "actorId"] as const;
const OPERATIONS: readonly OperationKind[] = ["warm-up", "sdk", "process", "stream"];
const CAUSES: readonly UnknownCause[] = [
  "sdk-rejected",
  "caller-timeout",
  "caller-abort",
  "reset-lost",
  "unsupported-classifier",
];
const unknown = (): DecodedLifecycle => ({ kind: "unknown" });
const held = (reason: string): WindowTransition => ({ kind: "held", reason });
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  [...value].every((character) => character.codePointAt(0)! >= 32);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function validOwner(value: unknown): value is OperationOwner {
  return (
    object(value) &&
    keys(value, OWNER_FIELDS) &&
    text(value.runId) &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.runId) &&
    text(value.ownerGen) &&
    text(value.allocationKey) &&
    typeof value.actorId === "string" &&
    /^[0-9a-f]{64}$/.test(value.actorId)
  );
}
function matches(owner: OperationOwner, expected: OperationOwner): boolean {
  return OWNER_FIELDS.every((key) => owner[key] === expected[key]);
}
function validSelector(value: unknown): value is OperationSelector {
  if (!object(value) || !keys(value, [...OWNER_FIELDS, "ordinal"])) return false;
  const { ordinal, ...identity } = value;
  return validOwner(identity) && integer(ordinal) && ordinal > 0;
}
function slotIndex(ordinal: number): number {
  return (ordinal - 1) % OPERATION_WINDOW_SIZE;
}
function validWindow(input: unknown): input is OperationWindow {
  if (
    !object(input) ||
    !keys(input, ["issuedThrough", "settledThrough", "slots"]) ||
    !integer(input.issuedThrough) ||
    !integer(input.settledThrough) ||
    input.settledThrough > input.issuedThrough ||
    input.issuedThrough - input.settledThrough > OPERATION_WINDOW_SIZE ||
    !Array.isArray(input.slots) ||
    input.slots.length !== OPERATION_WINDOW_SIZE
  )
    return false;
  for (let index = 0; index < OPERATION_WINDOW_SIZE; index++) {
    const slot = input.slots[index];
    if (slot === null) continue;
    if (
      !object(slot) ||
      !keys(slot, ["ordinal", "operation", "state"], ["parentOrdinal", "cause"]) ||
      !integer(slot.ordinal) ||
      slot.ordinal <= input.settledThrough ||
      slot.ordinal > input.issuedThrough ||
      slotIndex(slot.ordinal) !== index ||
      typeof slot.operation !== "string" ||
      !OPERATIONS.includes(slot.operation as OperationKind) ||
      typeof slot.state !== "string" ||
      !["admitted", "settled", "unknown"].includes(slot.state)
    )
      return false;
    if (
      slot.parentOrdinal !== undefined &&
      (!integer(slot.parentOrdinal) || slot.parentOrdinal === 0 || slot.parentOrdinal >= slot.ordinal)
    )
      return false;
    if (slot.state === "unknown" ? !CAUSES.includes(slot.cause as UnknownCause) : slot.cause !== undefined)
      return false;
  }
  for (let offset = 1; offset <= input.issuedThrough - input.settledThrough; offset++) {
    const ordinal = input.settledThrough + offset;
    if (input.slots[slotIndex(ordinal)]?.ordinal !== ordinal) return false;
  }
  return true;
}
function validCheckpoint(value: Record<string, unknown>, requireOwner: boolean): boolean {
  if ((requireOwner || value.owner !== undefined) && !parsePreservationOwner(value.owner)) return false;
  if (value.doorOrigin !== undefined && normalizedSeedDoorOrigin(value.doorOrigin) === null) return false;
  return value.backupId === undefined || text(value.backupId);
}

/** This codec preserves data, never verifies a canonical allocation, binding
 * or closing acknowledgment. Pending records cannot look like absent legacy
 * checkpoints to a reader that understands this representation. */
export function decodeLifecycle(input: unknown): DecodedLifecycle {
  if (!object(input)) return unknown();
  if (input.version === undefined) {
    if (!keys(input, ["owner"], ["doorOrigin", "backupId"]) || !validCheckpoint(input, true)) return unknown();
    return { kind: "legacy", record: input as unknown as CheckpointRecord, authority: "unverified" };
  }
  if (
    input.version !== 2 ||
    !keys(input, ["version", "lifecycle"], ["owner", "doorOrigin", "backupId"]) ||
    !object(input.lifecycle)
  )
    return unknown();
  const lifecycle = input.lifecycle;
  if (
    !keys(lifecycle, ["allocation", "binding", "admission", "operationWindow"]) ||
    !validOwner(lifecycle.allocation) ||
    typeof lifecycle.binding !== "string" ||
    !["pending", "bound", "unknown"].includes(lifecycle.binding) ||
    typeof lifecycle.admission !== "string" ||
    !["open", "closing", "closed"].includes(lifecycle.admission) ||
    !validWindow(lifecycle.operationWindow) ||
    !validCheckpoint(input, lifecycle.binding === "bound")
  )
    return unknown();
  if (input.owner !== undefined && (input.owner as PreservationOwner).run !== lifecycle.allocation.runId)
    return unknown();
  return { kind: "versioned", record: input as unknown as LifecycleRecord, authority: "unverified" };
}
function copy(record: LifecycleRecord): LifecycleRecord {
  return {
    ...record,
    ...(record.owner ? { owner: { ...record.owner } } : {}),
    lifecycle: {
      ...record.lifecycle,
      allocation: { ...record.lifecycle.allocation },
      operationWindow: {
        ...record.lifecycle.operationWindow,
        slots: record.lifecycle.operationWindow.slots.map((slot) => (slot ? { ...slot } : null)),
      },
    },
  };
}
function selected(input: unknown, owner: OperationOwner): LifecycleRecord | null {
  const decoded = decodeLifecycle(input);
  return decoded.kind === "versioned" && validOwner(owner) && matches(decoded.record.lifecycle.allocation, owner)
    ? decoded.record
    : null;
}
function selectOperation(input: unknown, selector: OperationSelector): LifecycleRecord | null {
  if (!validSelector(selector)) return null;
  const { ordinal: _ordinal, ...owner } = selector;
  const record = selected(input, owner);
  return record && selector.ordinal <= record.lifecycle.operationWindow.issuedThrough ? record : null;
}

/** A pure prototype reservation is not an effect permit. The caller still
 * needs the original canonical admission/binding acknowledgment. A full
 * window refuses synchronously, including a child of an admitted parent. */
export function reserveOperation(
  input: unknown,
  owner: OperationOwner,
  operation: OperationKind,
  parentOrdinal?: number,
): WindowTransition {
  const record = selected(input, owner);
  if (!record || !OPERATIONS.includes(operation)) return held("identity-or-record-mismatch");
  const lifecycle = record.lifecycle;
  const window = lifecycle.operationWindow;
  if (lifecycle.binding === "unknown" || (lifecycle.binding === "pending" && operation !== "warm-up"))
    return held("binding-unverified");
  if (lifecycle.admission === "closed" || (lifecycle.admission === "closing" && parentOrdinal === undefined))
    return held("admission-closed");
  if (parentOrdinal !== undefined) {
    if (
      !integer(parentOrdinal) ||
      parentOrdinal <= window.settledThrough ||
      parentOrdinal > window.issuedThrough ||
      window.slots[slotIndex(parentOrdinal)]?.ordinal !== parentOrdinal ||
      window.slots[slotIndex(parentOrdinal)]?.state !== "admitted"
    )
      return held("parent-unsettled-or-missing");
  }
  if (window.issuedThrough === Number.MAX_SAFE_INTEGER) return held("ordinal-exhausted");
  if (window.issuedThrough - window.settledThrough === OPERATION_WINDOW_SIZE) return held("window-full");
  const next = copy(record);
  const ordinal = window.issuedThrough + 1;
  next.lifecycle.operationWindow.issuedThrough = ordinal;
  next.lifecycle.operationWindow.slots[slotIndex(ordinal)] = {
    ordinal,
    operation,
    state: "admitted",
    ...(parentOrdinal !== undefined ? { parentOrdinal } : {}),
  };
  return { kind: "reserved", record: next, selector: { ...owner, ordinal }, authority: "unverified" };
}
function classification(
  operation: OperationKind,
  outcome: CallbackOutcome,
): { state: "settled" } | { state: "unknown"; cause: UnknownCause } {
  if (!object(outcome)) return { state: "unknown", cause: "unsupported-classifier" };
  if (outcome.kind === "unknown" && keys(outcome, ["kind", "cause"]) && CAUSES.includes(outcome.cause))
    return { state: "unknown", cause: outcome.cause };
  if (
    operation === "warm-up" &&
    outcome.kind === "warm-up" &&
    keys(outcome, ["kind", "outcome"]) &&
    object(outcome.outcome)
  ) {
    if (outcome.outcome.kind === "succeeded" && keys(outcome.outcome, ["kind"])) return { state: "settled" };
    if (outcome.outcome.kind === "failed" && keys(outcome.outcome, ["kind", "error"]))
      return { state: "unknown", cause: "sdk-rejected" };
    if (outcome.outcome.kind === "unobserved" && keys(outcome.outcome, ["kind"]))
      return { state: "unknown", cause: "reset-lost" };
  }
  return { state: "unknown", cause: "unsupported-classifier" };
}
function advancePrefix(window: OperationWindow): void {
  while (window.settledThrough < window.issuedThrough) {
    const ordinal = window.settledThrough + 1;
    const slot = window.slots[slotIndex(ordinal)];
    if (slot?.ordinal !== ordinal || slot.state !== "settled") return;
    window.slots[slotIndex(ordinal)] = null;
    window.settledThrough = ordinal;
  }
}

/** Scoped warm-up completion is distinct from physical retirement. Other
 * scopes need their own actual stream/process classifiers; generic Promise
 * fulfillment is insufficient. Unknown debt cannot be cleared by a late
 * success or by reconstructing an empty in-memory operation set. */
export function recordOperationOutcome(
  input: unknown,
  selector: OperationSelector,
  outcome: CallbackOutcome,
): WindowTransition {
  const record = selectOperation(input, selector);
  if (!record) return held("identity-or-ordinal-mismatch");
  const window = record.lifecycle.operationWindow;
  if (selector.ordinal <= window.settledThrough) return { kind: "unchanged", record, authority: "unverified" };
  const slot = window.slots[slotIndex(selector.ordinal)]!;
  if (slot.state === "settled") return { kind: "unchanged", record, authority: "unverified" };
  const result = classification(slot.operation, outcome);
  if (slot.state === "unknown")
    return result.state === "unknown" && result.cause === slot.cause
      ? { kind: "unchanged", record, authority: "unverified" }
      : held("unknown-debt-retained");
  const next = copy(record);
  next.lifecycle.operationWindow.slots[slotIndex(selector.ordinal)] = { ...slot, ...result };
  advancePrefix(next.lifecycle.operationWindow);
  return { kind: "recorded", record: next, authority: "unverified" };
}
/** Read-only acknowledgment reconciliation; no effect or callback is replayed. */
export function readOperation(
  input: unknown,
  selector: OperationSelector,
): "admitted" | "unknown" | "settled" | "held" {
  const record = selectOperation(input, selector);
  if (!record) return "held";
  const window = record.lifecycle.operationWindow;
  return selector.ordinal <= window.settledThrough ? "settled" : window.slots[slotIndex(selector.ordinal)]!.state;
}
export function holdResetOperations(input: unknown, owner: OperationOwner): WindowTransition {
  const record = selected(input, owner);
  if (!record) return held("identity-or-record-mismatch");
  const next = copy(record);
  let changed = false;
  for (const slot of next.lifecycle.operationWindow.slots)
    if (slot?.state === "admitted") {
      slot.state = "unknown";
      slot.cause = "reset-lost";
      changed = true;
    }
  return { kind: changed ? "recorded" : "unchanged", record: changed ? next : record, authority: "unverified" };
}
export function updateCheckpoint(input: unknown, checkpoint: CheckpointRecord): DecodedLifecycle {
  const decoded = decodeLifecycle(input);
  const candidate = decodeLifecycle(checkpoint);
  if (
    decoded.kind === "unknown" ||
    candidate.kind !== "legacy" ||
    !decoded.record.owner ||
    !sameOwner(decoded.record.owner, checkpoint.owner) ||
    (checkpoint.doorOrigin !== undefined && checkpoint.doorOrigin !== decoded.record.doorOrigin)
  )
    return unknown();
  const record =
    decoded.kind === "versioned" ? copy(decoded.record) : { ...decoded.record, owner: { ...decoded.record.owner } };
  if (checkpoint.backupId !== undefined) record.backupId = checkpoint.backupId;
  return decoded.kind === "versioned"
    ? { kind: "versioned", record: record as LifecycleRecord, authority: "unverified" }
    : { kind: "legacy", record: record as CheckpointRecord, authority: "unverified" };
}

/** Binding, closure and retirement receipts are not implemented by this
 * structural codec. Preserve an observed closed state; never manufacture
 * the authoritative transition from caller data or operation counts. */
export function requestAuthorityTransition(
  input: unknown,
  target: "bound" | "closing" | "closed" | "open" | "retired",
): WindowTransition {
  const decoded = decodeLifecycle(input);
  if (decoded.kind === "versioned" && target === "open" && decoded.record.lifecycle.admission !== "open")
    return held("reopen-forbidden");
  return held("canonical-receipt-unavailable");
}
