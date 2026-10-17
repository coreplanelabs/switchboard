import { ORCHESTRATOR_DECISION_BYTES_MAX, ORCHESTRATOR_DECISIONS_MAX } from "../budgets.js";
import { sourceEventReceiptOf, type SourceEventReceipt } from "../runLedger/sourceEvents.js";
import { sourceHash } from "../references/receipts.js";
import type { IncomingMessage } from "../types.js";

export interface OrchestratorOwner {
  runId: string;
  requesterId: string;
  channelId: string;
  threadKey: string;
}

/** A saved selection is not an action result or permission grant. */
interface DecisionSource {
  version: 1;
  id: string;
  owner: OrchestratorOwner;
  source: { kind: "request"; messageId: string; textHash: string };
  inputHash: string;
  contextHash: string;
}

export interface OrchestratorCommandDecision extends DecisionSource {
  command: string;
  line: string;
}

export type OrchestratorWorkAction =
  | { tool: "work_start"; target: { repo: string } }
  | { tool: "spawn_run"; target: { preset: string; repo?: string; prNumber?: number } }
  | { tool: "send_to_run"; target: { runId: string } }
  | { tool: "work_steer" | "work_stop"; target: { actId: string } };
export interface OrchestratorWorkDecision extends DecisionSource {
  tool: OrchestratorWorkAction["tool"];
  targetHash: string;
}
export interface OrchestratorWorkProposal {
  source: Pick<IncomingMessage, "messageId" | "userId" | "channelId" | "threadKey" | "text">;
  callId: string;
  action: OrchestratorWorkAction;
  input: unknown;
  context: unknown;
}
/** A source reference is evidence, never an imported requester or grant. */
export interface OrchestratorSourceFoldDecision {
  version: 2;
  kind: "source-fold";
  id: string;
  owner: OrchestratorOwner;
  source: { kind: "source-evidence" | "source-fact"; receipt: SourceEventReceipt };
  target: { kind: "run" | "unit"; hash: string };
  inputHash: string;
  contextHash: string;
}
export type OrchestratorDecision =
  OrchestratorCommandDecision | OrchestratorWorkDecision | OrchestratorSourceFoldDecision;

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

export function isOrchestratorOwner(value: unknown): value is OrchestratorOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return (
    Object.keys(owner).length === 4 &&
    ["runId", "requesterId", "channelId", "threadKey"].every((key) => boundedText(owner[key]))
  );
}

export function sameOrchestratorOwner(a: OrchestratorOwner | undefined, b: OrchestratorOwner | undefined): boolean {
  return a === undefined || b === undefined
    ? a === b
    : a.runId === b.runId &&
        a.requesterId === b.requesterId &&
        a.channelId === b.channelId &&
        a.threadKey === b.threadKey;
}

export function isOrchestratorCommandDecision(
  value: unknown,
  owner: OrchestratorOwner,
): value is OrchestratorCommandDecision {
  return isOrchestratorDecision(value, owner) && "command" in value;
}

export function isOrchestratorDecision(value: unknown, owner: OrchestratorOwner): value is OrchestratorDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if ((value as { version?: unknown }).version === 2) return isSourceFoldDecision(value, owner);
  const entry = value as Partial<OrchestratorCommandDecision & OrchestratorWorkDecision>;
  const command = "command" in value;
  const actionKeys = command ? ["command", "line"] : ["tool", "targetHash"];
  const validAction = command
    ? boundedText(entry.command) && typeof entry.line === "string" && entry.line.length <= 1_024
    : ["work_start", "work_steer", "work_stop", "spawn_run", "send_to_run"].includes(entry.tool ?? "") &&
      typeof entry.targetHash === "string" &&
      /^[a-f0-9]{64}$/.test(entry.targetHash);
  let identity: unknown;
  try {
    identity = typeof entry.id === "string" ? JSON.parse(entry.id) : undefined;
  } catch {
    return false;
  }
  return (
    Object.keys(value).every((key) =>
      ["version", "id", "owner", "source", "inputHash", "contextHash", ...actionKeys].includes(key),
    ) &&
    entry.version === 1 &&
    boundedText(entry.id) &&
    Array.isArray(identity) &&
    identity.length === 2 &&
    identity[0] === owner.runId &&
    boundedText(identity[1]) &&
    isOrchestratorOwner(entry.owner) &&
    sameOrchestratorOwner(entry.owner, owner) &&
    entry.source !== null &&
    typeof entry.source === "object" &&
    !Array.isArray(entry.source) &&
    entry.source.kind === "request" &&
    Object.keys(entry.source).length === 3 &&
    boundedText(entry.source.messageId) &&
    typeof entry.source.textHash === "string" &&
    /^[a-f0-9]{64}$/.test(entry.source.textHash) &&
    validAction &&
    typeof entry.inputHash === "string" &&
    /^[a-f0-9]{64}$/.test(entry.inputHash) &&
    typeof entry.contextHash === "string" &&
    /^[a-f0-9]{64}$/.test(entry.contextHash)
  );
}

function isSourceFoldDecision(value: object, owner: OrchestratorOwner): value is OrchestratorSourceFoldDecision {
  const entry = value as Partial<OrchestratorSourceFoldDecision>;
  let identity: unknown;
  try {
    identity = typeof entry.id === "string" ? JSON.parse(entry.id) : undefined;
  } catch {
    return false;
  }
  return (
    Object.keys(value).every((key) =>
      ["version", "kind", "id", "owner", "source", "target", "inputHash", "contextHash"].includes(key),
    ) &&
    entry.version === 2 &&
    entry.kind === "source-fold" &&
    boundedText(entry.id) &&
    Array.isArray(identity) &&
    identity.length === 2 &&
    identity[0] === owner.runId &&
    boundedText(identity[1]) &&
    isOrchestratorOwner(entry.owner) &&
    sameOrchestratorOwner(entry.owner, owner) &&
    entry.source !== null &&
    typeof entry.source === "object" &&
    !Array.isArray(entry.source) &&
    Object.keys(entry.source).length === 2 &&
    (entry.source.kind === "source-evidence" || entry.source.kind === "source-fact") &&
    sourceEventReceiptOf(entry.source.receipt) !== undefined &&
    entry.target !== null &&
    typeof entry.target === "object" &&
    !Array.isArray(entry.target) &&
    Object.keys(entry.target).length === 2 &&
    (entry.target.kind === "run" || entry.target.kind === "unit") &&
    [entry.target.hash, entry.inputHash, entry.contextHash].every(
      (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
    )
  );
}

export function orchestratorDecisionsOf(value: unknown, owner: OrchestratorOwner): OrchestratorDecision[] | undefined {
  return Array.isArray(value) &&
    value.length <= ORCHESTRATOR_DECISIONS_MAX &&
    value.every((entry) => isOrchestratorDecision(entry, owner)) &&
    new Set(value.map((entry) => entry.id)).size === value.length &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= ORCHESTRATOR_DECISION_BYTES_MAX
    ? structuredClone(value)
    : undefined;
}

/** The caller retains its objects while validation and hashing await. */
function captureProposal<T>(value: T): T | undefined {
  try {
    return structuredClone(value);
  } catch {
    try {
      console.warn(JSON.stringify({ event: "orchestrator.decision.refused", cause: "uncloneable-proposal" }));
    } catch {
      // Diagnostic failure must not change admission or block the queue.
    }
    return undefined;
  }
}

/** Use the run's owner-fenced state writer. Never replace an unreadable history.
 * A failed acknowledgement closes this writer before an action can execute. */
export function createOrchestratorDecisions(input: {
  owner: OrchestratorOwner;
  previous?: unknown;
  save: (entries: readonly OrchestratorDecision[]) => Promise<boolean>;
}) {
  const owner = structuredClone(input.owner);
  const save = input.save.bind(input);
  const previous = input.previous === undefined ? [] : input.previous;
  const restored = orchestratorDecisionsOf(previous, owner);
  let held = restored === undefined;
  let entries = restored ?? [];
  let tail: Promise<unknown> = Promise.resolve();
  const record = (decision: OrchestratorDecision): Promise<boolean> => {
    const captured = captureProposal(decision);
    if (captured === undefined) return Promise.resolve(false);
    decision = captured;
    const next = tail.then(async () => {
      if (held || !isOrchestratorDecision(decision, owner)) return false;
      const existing = entries.find((entry) => entry.id === decision.id);
      if (existing) return JSON.stringify(existing) === JSON.stringify(decision);
      const saved = [...entries, structuredClone(decision)];
      if (
        saved.length > ORCHESTRATOR_DECISIONS_MAX ||
        new TextEncoder().encode(JSON.stringify(saved)).byteLength > ORCHESTRATOR_DECISION_BYTES_MAX
      )
        return false;
      try {
        if (!(await save(structuredClone(saved)))) {
          held = true;
          return false;
        }
      } catch {
        held = true;
        return false;
      }
      entries = saved;
      return true;
    });
    tail = next;
    return next;
  };
  return {
    snapshot: () => {
      if (restored === undefined) throw new Error("The retained orchestrator decisions could not be verified.");
      return structuredClone(entries);
    },
    record,
    async recordWork(proposal: OrchestratorWorkProposal, check: () => Promise<boolean>): Promise<boolean> {
      const captured = captureProposal(proposal);
      if (captured === undefined) return false;
      proposal = captured;
      if (!proposal.source.messageId || !(await check())) return false;
      const saved = await record({
        version: 1,
        id: JSON.stringify([owner.runId, proposal.callId]),
        owner: {
          runId: owner.runId,
          requesterId: proposal.source.userId,
          channelId: proposal.source.channelId,
          threadKey: proposal.source.threadKey,
        },
        source: {
          kind: "request",
          messageId: proposal.source.messageId,
          textHash: await sourceHash(proposal.source.text),
        },
        tool: proposal.action.tool,
        targetHash: await sourceHash(proposal.action.target),
        inputHash: await sourceHash(proposal.input),
        contextHash: await sourceHash(proposal.context),
      });
      return saved && (await check());
    },
  };
}
