import { sourceEventReceiptOf, sourceSnapshot, type SourceEventReceipt } from "../runLedger/sourceEvents.js";
import type { ContextOrigin } from "./contextDependencies.js";

/** Saved input identity, never current access or native acknowledgment.
 * Hashes cover the complete typed input and adapter source-access identity.
 * The original root and fold decision stay fixed when a process is reclaimed. */
export interface SourceInputReference {
  version: 1;
  receipt: SourceEventReceipt;
  root: Pick<ContextOrigin, "runId" | "requester" | "channelId" | "threadKey">;
  routing: { kind: "notice" } | { kind: "fold"; decision: { id: string; hash: string } };
  inputHash: string;
  accessHash: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const closed = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Reject unknown fields and unsafe JSON before reading supplied properties. */
export function sourceInputReferenceOf(value: unknown): SourceInputReference | undefined {
  try {
    const v = sourceSnapshot(value);
    if (
      !object(v) ||
      !closed(v, ["version", "receipt", "root", "routing", "inputHash", "accessHash"]) ||
      v.version !== 1 ||
      !hash(v.inputHash) ||
      !hash(v.accessHash)
    )
      return;
    const receipt = sourceEventReceiptOf(v.receipt),
      root = v.root,
      routing = v.routing;
    if (
      !receipt ||
      !object(root) ||
      !closed(root, ["runId", "requester", "channelId", "threadKey"]) ||
      !text(root.runId) ||
      !text(root.requester) ||
      !text(root.channelId) ||
      !text(root.threadKey) ||
      !object(routing)
    )
      return;
    let checked: SourceInputReference["routing"];
    if (routing.kind === "notice" && closed(routing, ["kind"])) checked = { kind: "notice" };
    else if (
      routing.kind === "fold" &&
      closed(routing, ["kind", "decision"]) &&
      object(routing.decision) &&
      closed(routing.decision, ["id", "hash"]) &&
      typeof routing.decision.id === "string" &&
      routing.decision.id.length <= 512 &&
      hash(routing.decision.hash)
    ) {
      const id: unknown = JSON.parse(routing.decision.id);
      if (!Array.isArray(id) || id.length !== 2 || id[0] !== root.runId || !text(id[1])) return;
      checked = { kind: "fold", decision: { id: routing.decision.id, hash: routing.decision.hash } };
    } else return;
    return {
      version: 1,
      receipt,
      root: { runId: root.runId, requester: root.requester, channelId: root.channelId, threadKey: root.threadKey },
      routing: checked,
      inputHash: v.inputHash,
      accessHash: v.accessHash,
    };
  } catch {
    return;
  }
}
export const isSourceInputReference = (value: unknown): value is SourceInputReference =>
  sourceInputReferenceOf(value) !== undefined;
/** Same original input cannot acquire new source, owner or decision proof. */
export function sourceInputIdentity(ref: SourceInputReference): string {
  return JSON.stringify([
    ref.root.runId,
    ref.receipt.key,
    ref.routing.kind,
    ref.routing.kind === "fold" ? ref.routing.decision.id : null,
  ]);
}
