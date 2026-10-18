import type { RunLedger } from "../runLedger/ledger.js";
import { sourceSnapshot } from "../runLedger/sourceEvents.js";
import { sourceEvidenceMessageFromRecord, type CommonSourceEvidenceMessage } from "../runLedger/sourceEvidence.js";
import { orchestratorDecisionsOf, sourceRunTask } from "../dispatch/orchestratorDecisions.js";
import { orchestratorOwnerForHandoff } from "../dispatch/handoff.js";
import { sourceHash } from "./receipts.js";
import { sourceInputReferenceOf, type SourceInputReference } from "./sourceInputReference.js";

type ProofHold =
  | "reference-unproved"
  | "source-unproved"
  | "root-unproved"
  | "decision-unproved"
  | "input-unproved"
  | "source-changed"
  | "root-changed"
  | "unavailable";
export type SourceInputProof =
  | {
      kind: "consistent";
      message: CommonSourceEvidenceMessage;
      task: ReturnType<typeof sourceRunTask>;
    }
  | { kind: "held"; reason: ProofHold };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const held = (reason: ProofHold): SourceInputProof => ({ kind: "held", reason });
const json = (value: unknown) => JSON.stringify(sourceSnapshot(value));
const body = (value: unknown) => (object(value) ? json({ event: value.event, receipt: value.receipt }) : undefined);

function rootProof(value: unknown, reference: SourceInputReference) {
  if (!object(value)) return;
  const meta = value.meta;
  const runId = value.runId;
  if (
    !object(meta) ||
    runId !== reference.root.runId ||
    meta.userId !== reference.root.requester ||
    meta.channelId !== reference.root.channelId ||
    meta.threadKey !== reference.root.threadKey ||
    meta.childHandoff !== undefined ||
    typeof meta.agent !== "string" ||
    (meta.parentRunId !== undefined && typeof meta.parentRunId !== "string") ||
    (meta.parentInstanceId !== undefined && typeof meta.parentInstanceId !== "string")
  )
    return;
  const owner = orchestratorOwnerForHandoff({
    ...reference.root,
    agent: meta.agent,
    parentRunId: meta.parentRunId,
    parentInstanceId: meta.parentInstanceId,
  });
  if (!owner) return;
  const decisions = object(value.state) ? value.state.orchestratorDecisions : undefined;
  const routing = reference.routing;
  const selected =
    routing.kind === "fold"
      ? orchestratorDecisionsOf(decisions, owner)?.find((entry) => entry.id === routing.decision.id)
      : undefined;
  return {
    owner,
    task: sourceRunTask(meta),
    decision: selected?.version === 2 ? selected : null,
  };
}

/** Compare a saved reference with canonical data through the existing stores.
 * Only live roots retain this complete task projection. Archives stay held
 * until an exact source-task snapshot is retained; finished workspace output
 * cannot stand in for an original task. Source events
 * are immutable; job progress is not part of their identity. Recheck their
 * body and the root's selected task/decision after asynchronous hashing.
 * This does not check accessHash, current permission, destination audience,
 * native admission or retention. It cannot authorize model use or inbox ACK. */
export async function readSourceInputProof(
  value: unknown,
  deps: {
    ledger: Pick<RunLedger, "readSourceEvent" | "listLive">;
  },
): Promise<SourceInputProof> {
  const reference = sourceInputReferenceOf(value);
  if (!reference) return held("reference-unproved");
  try {
    const readSource = deps.ledger.readSourceEvent?.bind(deps.ledger);
    const readLive = deps.ledger.listLive.bind(deps.ledger);
    if (!readSource) return held("source-unproved");
    const readRoot = async () => {
      const rows = await readLive();
      if (!Array.isArray(rows)) return;
      // Only the selected root is a source dependency. Read the index IDs
      // without decoding other bodies or invoking ID accessors.
      const matching: unknown[] = [];
      for (const row of rows) {
        const id = object(row) ? Object.getOwnPropertyDescriptor(row, "runId") : undefined;
        if (!id || !Object.hasOwn(id, "value") || typeof id.value !== "string") return;
        if (id.value === reference.root.runId) matching.push(row);
      }
      if (matching.length !== 1) return;
      return rootProof(sourceSnapshot(matching[0]), reference);
    };
    const stored = await readSource(reference.receipt.key);
    if (!stored) return held("source-unproved");
    const source = sourceSnapshot(stored);
    const root = await readRoot();
    if (!root) return held("root-unproved");
    const routing =
      reference.routing.kind === "notice"
        ? { kind: "notice" as const, owner: root.owner }
        : {
            kind: "fold" as const,
            owner: root.owner,
            decision: { runId: root.owner.runId, id: reference.routing.decision.id },
          };
    const message = await sourceEvidenceMessageFromRecord(source, routing);
    if (!message || json(message.receipt) !== json(reference.receipt)) return held("source-unproved");
    if (reference.routing.kind === "fold") {
      const decision = root.decision;
      if (
        !decision ||
        json(decision.source.receipt) !== json(reference.receipt) ||
        decision.source.kind !== message.source.kind ||
        decision.inputHash !== reference.inputHash ||
        (await sourceHash(sourceSnapshot(decision))) !== reference.routing.decision.hash
      )
        return held("decision-unproved");
    }
    if ((await sourceHash(sourceSnapshot(message))) !== reference.inputHash) return held("input-unproved");
    const currentSource = await readSource(reference.receipt.key);
    if (!currentSource || body(sourceSnapshot(currentSource)) !== body(source)) return held("source-changed");
    const currentRoot = await readRoot();
    if (!currentRoot || json(currentRoot) !== json(root)) return held("root-changed");
    return { kind: "consistent", message, task: root.task };
  } catch {
    // Unavailable or unsafe canonical data keeps this reader closed. Return
    // no source bytes, store errors or success-shaped fallback to its caller.
    console.warn(JSON.stringify({ event: "source.input.proof.unavailable" }));
    return held("unavailable");
  }
}
