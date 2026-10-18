import { sourceHash } from "../references/receipts.js";
import {
  isOrchestratorOwner,
  orchestratorDecisionsOf,
  sameOrchestratorOwner,
  sourceFoldRunTarget,
  sourceFoldRunContext,
  type OrchestratorOwner,
  type OrchestratorSourceFoldDecision,
} from "../dispatch/orchestratorDecisions.js";
import { isChildHandoff, orchestratorOwnerForHandoff } from "../dispatch/handoff.js";
import type { LiveRunRow } from "./types.js";
import { DURABLE_INBOX_MAX_BYTES, inboxCustodyOf, type InboxTarget } from "./inboxMessage.js";
import {
  sourceContentOf,
  sourceEventRecordOf,
  sourceEventReceiptOf,
  sourceEventJobOf,
  sourceSnapshot,
  type SourceEvent,
  type SourceEventContent,
  type SourceEventReceipt,
} from "./sourceEvents.js";

interface SourceEvidenceFields {
  kind: "source-evidence";
  source: Pick<SourceEvent, "sourceId" | "deliveryId" | "objectId" | "changeId" | "occurredAt"> & {
    authorId: string | null;
  };
  receipt: SourceEventReceipt;
}
interface LegacySourceEvidenceMessage extends SourceEvidenceFields {
  version: 1;
  decision: { runId: string; id: string };
  text: string;
}
export type SourceInputRouting =
  | { kind: "notice"; owner: OrchestratorOwner }
  | { kind: "fold"; owner: OrchestratorOwner; decision: { runId: string; id: string } };
export interface CommonSourceEvidenceMessage extends SourceEvidenceFields {
  version: 2;
  source: SourceEvidenceFields["source"] & { kind: "source-evidence" | "source-fact" };
  routing: SourceInputRouting;
  content: SourceEventContent;
}
export type SourceEvidenceMessage = LegacySourceEvidenceMessage | CommonSourceEvidenceMessage;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const closed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

function decisionReferenceOf(value: unknown): { runId: string; id: string } | undefined {
  if (!object(value) || !closed(value, ["runId", "id"]) || !identity(value.runId) || !identity(value.id)) return;
  const invocation: unknown = JSON.parse(value.id);
  if (Array.isArray(invocation) && invocation.length === 2 && invocation[0] === value.runId && identity(invocation[1]))
    return { runId: value.runId, id: value.id };
}

function sourceRoutingOf(value: unknown): SourceInputRouting | undefined {
  if (!object(value) || !isOrchestratorOwner(value.owner)) return;
  if (value.kind === "notice" && closed(value, ["kind", "owner"])) return { kind: "notice", owner: value.owner };
  if (value.kind === "fold" && closed(value, ["kind", "owner", "decision"])) {
    const decision = decisionReferenceOf(value.decision);
    if (decision?.runId === value.owner.runId) return { kind: "fold", owner: value.owner, decision };
  }
}

export interface PreparedSourceEvidenceAppend {
  message: Record<string, unknown>;
  key: string;
  recordJson: string;
  fold?: { targetJson: string; targetHash: string; inputHash: string; contextJson: string; contextHash: string };
}

/** Capture the stored event before hashing can yield, then verify its receipt
 * and common content. Recheck the snapshot in the append transaction. */
export async function prepareSourceEvidenceAppend(
  value: Record<string, unknown>,
  loadRecord: (key: string) => unknown,
  loadDestination?: () => LiveRunRow | undefined,
  loadRoot?: (runId: string) => LiveRunRow | undefined,
): Promise<PreparedSourceEvidenceAppend | undefined> {
  try {
    const captured = sourceSnapshot(value);
    if (!object(captured) || captured.kind !== "source-evidence" || captured.version !== 2) return;
    const receipt = sourceEventReceiptOf(captured.receipt);
    if (!receipt) return;
    const record = sourceSnapshot(loadRecord(receipt.key));
    const destination = object(captured.routing) && captured.routing.kind === "fold" ? loadDestination?.() : undefined;
    const target = destination && sourceSnapshot(sourceFoldRunTarget(destination));
    const routing = sourceRoutingOf(captured.routing);
    const root = routing?.kind === "fold" ? loadRoot?.(routing.owner.runId) : undefined;
    const context = root && destination ? sourceFoldRunContext(root, destination) : undefined;
    const message = await prepareSourceEvidenceMessage(captured);
    if (message?.version !== 2 || !object(record)) return;
    const expected = await sourceEvidenceMessageFromRecord(record, message.routing);
    if (!expected || JSON.stringify(sourceSnapshot(expected)) !== JSON.stringify(captured)) return;
    let fold: PreparedSourceEvidenceAppend["fold"];
    if (message.routing.kind === "fold") {
      if (target === undefined || context === undefined) return;
      const snapshot = sourceSnapshot(context);
      const [targetHash, inputHash, contextHash] = await Promise.all([
        sourceHash(target),
        sourceHash(captured),
        sourceHash(snapshot),
      ]);
      fold = {
        targetJson: JSON.stringify(target),
        targetHash,
        inputHash,
        contextJson: JSON.stringify(snapshot),
        contextHash,
      };
    }
    return {
      message: { ...message },
      key: receipt.key,
      recordJson: JSON.stringify(sourceSnapshot({ event: record.event, receipt: record.receipt })),
      ...(fold ? { fold } : {}),
    };
  } catch {
    return;
  }
}

export type SourceEvidenceRefusal =
  | "source-proof"
  | "source-owner"
  | "source-record"
  | "fold-destination"
  | "fold-decision"
  | "fold-target"
  | "fold-input"
  | "fold-context"
  | "fold-context-unavailable";

/** Return a fixed refusal code, never private source or error data. Call in
 * the existing append transaction with no await before writing the row.
 * These are necessary checks; context/access, retention and native ACK are
 * separate gates. Ordinary and legacy messages retain their existing path. */
export function sourceEvidenceAppendRefusal(
  value: Record<string, unknown>,
  destination: LiveRunRow,
  loadRoot: (runId: string) => LiveRunRow | undefined,
  loadRecord: (key: string) => unknown,
  prepared?: PreparedSourceEvidenceAppend,
): SourceEvidenceRefusal | undefined {
  if (value.kind !== "source-evidence" || value.version !== 2) return;
  try {
    const captured = sourceSnapshot(value);
    if (!object(captured)) return "source-proof";
    const routing = sourceRoutingOf(captured.routing);
    if (!routing) return "source-proof";
    const root = loadRoot(routing.owner.runId);
    if (!root || root.phase === "finishing" || root.meta.childHandoff !== undefined) return "source-owner";
    const owner = orchestratorOwnerForHandoff({
      runId: root.runId,
      requester: root.meta.userId,
      channelId: root.meta.channelId,
      threadKey: root.meta.threadKey,
      agent: root.meta.agent,
      parentRunId: root.meta.parentRunId,
      parentInstanceId: root.meta.parentInstanceId,
    });
    if (!owner || !sameOrchestratorOwner(owner, routing.owner)) return "source-owner";
    if (routing.kind === "notice" && destination.runId !== owner.runId) return "source-owner";
    let decision: OrchestratorSourceFoldDecision | undefined;
    if (routing.kind === "fold") {
      const handoff = destination.meta.childHandoff;
      if (
        destination.runId === owner.runId ||
        destination.phase === "finishing" ||
        destination.meta.parentRunId !== owner.runId ||
        destination.meta.parentInstanceId !== undefined ||
        destination.meta.userId !== owner.requesterId ||
        !isChildHandoff(handoff) ||
        handoff.source.runId !== owner.runId ||
        handoff.source.requester !== owner.requesterId ||
        handoff.source.channelId !== owner.channelId ||
        handoff.source.threadKey !== owner.threadKey ||
        !sameOrchestratorOwner(handoff.orchestratorOwner, owner) ||
        handoff.consumer?.runId !== destination.runId ||
        handoff.consumer.requester !== destination.meta.userId ||
        handoff.consumer.channelId !== destination.meta.channelId ||
        handoff.consumer.threadKey !== destination.meta.threadKey
      )
        return "fold-destination";
      const saved = orchestratorDecisionsOf(root.state.orchestratorDecisions, owner)?.find(
        (entry) => entry.id === routing.decision.id,
      );
      const receipt = sourceEventReceiptOf(captured.receipt);
      if (
        saved?.version !== 2 ||
        saved.target.kind !== "run" ||
        !receipt ||
        !object(captured.source) ||
        saved.source.kind !== captured.source.kind ||
        JSON.stringify(sourceEventReceiptOf(saved.source.receipt)) !== JSON.stringify(receipt)
      )
        return "fold-decision";
      decision = saved;
    }
    if (!prepared) return "source-proof";
    const current = sourceSnapshot(loadRecord(prepared.key));
    if (
      !object(current) ||
      sourceEventJobOf(current.job)?.eventKey !== prepared.key ||
      JSON.stringify(sourceSnapshot({ event: current.event, receipt: current.receipt })) !== prepared.recordJson
    )
      return "source-record";
    if (routing.kind === "notice") return;
    if (!decision) return "fold-decision";
    if (!prepared.fold) return "fold-input";
    if (
      JSON.stringify(sourceSnapshot(sourceFoldRunTarget(destination))) !== prepared.fold.targetJson ||
      decision.target.hash !== prepared.fold.targetHash
    )
      return "fold-target";
    if (decision.inputHash !== prepared.fold.inputHash) return "fold-input";
    const context = sourceFoldRunContext(root, destination);
    if (context === undefined) return "fold-context-unavailable";
    if (
      JSON.stringify(sourceSnapshot(context)) !== prepared.fold.contextJson ||
      decision.contextHash !== prepared.fold.contextHash
    )
      return "fold-context";
    return;
  } catch {
    return "source-proof";
  }
}

/** Decode data, not authority. A consumer must separately verify the canonical
 * source and saved decision. Current runtimes still hold this message kind. */
export async function prepareSourceEvidenceMessage(
  value: unknown,
  target?: InboxTarget & { requester: string },
): Promise<SourceEvidenceMessage | undefined> {
  try {
    const snapshot = sourceSnapshot(value);
    if (
      !object(snapshot) ||
      (snapshot.version !== 1 && snapshot.version !== 2) ||
      !closed(snapshot, [
        "version",
        "kind",
        "source",
        "receipt",
        "target",
        ...(snapshot.version === 1 ? ["decision", "text"] : ["routing", "content"]),
      ]) ||
      snapshot.kind !== "source-evidence" ||
      !object(snapshot.source)
    )
      return;
    const source = snapshot.source;
    if (
      !closed(source, [
        "sourceId",
        "deliveryId",
        "objectId",
        "changeId",
        "authorId",
        "occurredAt",
        ...(snapshot.version === 2 ? ["kind"] : []),
      ]) ||
      !identity(source.sourceId) ||
      !/^[a-z][a-z0-9-]*:/.test(source.sourceId) ||
      !identity(source.deliveryId) ||
      !identity(source.objectId) ||
      !identity(source.changeId) ||
      (source.authorId !== null && !identity(source.authorId)) ||
      (source.occurredAt !== undefined && (!Number.isSafeInteger(source.occurredAt) || Number(source.occurredAt) < 0))
    )
      return;
    const receipt = sourceEventReceiptOf(snapshot.receipt);
    if (!receipt) return;
    if (target) {
      const custody = inboxCustodyOf(snapshot.target);
      if (
        !custody ||
        !object(snapshot.target) ||
        !closed(snapshot.target, ["version", "runId", "channelId", "threadKey", "requester", "producerGen"]) ||
        custody.runId !== target.runId ||
        custody.channelId !== target.channelId ||
        custody.threadKey !== target.threadKey ||
        custody.requester !== target.requester
      )
        return;
    } else if (snapshot.target !== undefined) return;
    const fields: SourceEvidenceFields = {
      kind: "source-evidence",
      source: {
        sourceId: source.sourceId,
        deliveryId: source.deliveryId,
        objectId: source.objectId,
        changeId: source.changeId,
        authorId: source.authorId,
        ...(source.occurredAt !== undefined ? { occurredAt: Number(source.occurredAt) } : {}),
      },
      receipt,
    };
    let message: SourceEvidenceMessage;
    if (snapshot.version === 1) {
      const decision = decisionReferenceOf(snapshot.decision);
      if (!decision || typeof snapshot.text !== "string") return;
      message = { version: 1, ...fields, decision, text: snapshot.text };
    } else {
      if (source.kind !== "source-evidence" && source.kind !== "source-fact") return;
      const routing = sourceRoutingOf(snapshot.routing),
        content = sourceContentOf(snapshot.content, source.kind);
      if (!routing || !content) return;
      if (
        routing.kind === "notice" &&
        target &&
        (routing.owner.runId !== target.runId ||
          routing.owner.requesterId !== target.requester ||
          routing.owner.channelId !== target.channelId ||
          routing.owner.threadKey !== target.threadKey)
      )
        return;
      message = { version: 2, ...fields, source: { ...fields.source, kind: source.kind }, routing, content };
    }
    if (new TextEncoder().encode(JSON.stringify(message)).byteLength > DURABLE_INBOX_MAX_BYTES) return;
    if (receipt.key !== `source:${await sourceHash([source.sourceId, source.deliveryId])}`) return;
    return message;
  } catch {
    return;
  }
}

/** Project common content from a receipt-consistent stored record. The caller
 * must load the canonical record and verify routing and current access. */
export async function sourceEvidenceMessageFromRecord(
  value: unknown,
  routing: SourceInputRouting,
): Promise<CommonSourceEvidenceMessage | undefined> {
  try {
    const snapshot = sourceSnapshot({ record: value, routing });
    if (!object(snapshot)) return;
    const record = await sourceEventRecordOf(snapshot.record);
    if (!record || record.event.version !== 2 || record.event.kind === "request") return;
    const { sourceId, deliveryId, objectId, changeId, authorId, occurredAt, kind, content } = record.event;
    const message = await prepareSourceEvidenceMessage({
      version: 2,
      kind: "source-evidence",
      receipt: record.receipt,
      routing: snapshot.routing,
      content,
      source: {
        sourceId,
        deliveryId,
        objectId,
        changeId,
        kind,
        authorId: authorId ?? null,
        ...(occurredAt !== undefined ? { occurredAt } : {}),
      },
    });
    return message?.version === 2 ? message : undefined;
  } catch {
    return;
  }
}
