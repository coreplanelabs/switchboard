import { ORCHESTRATOR_DECISION_BYTES_MAX, ORCHESTRATOR_DECISIONS_MAX } from "../budgets.js";

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
  | { tool: "work_steer" | "work_stop"; target: { actId: string } };
export interface OrchestratorWorkDecision extends DecisionSource {
  tool: OrchestratorWorkAction["tool"];
  targetHash: string;
}
export type OrchestratorDecision = OrchestratorCommandDecision | OrchestratorWorkDecision;

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
  const entry = value as Partial<OrchestratorCommandDecision & OrchestratorWorkDecision>;
  const command = "command" in value;
  const actionKeys = command ? ["command", "line"] : ["tool", "targetHash"];
  const validAction = command
    ? boundedText(entry.command) && typeof entry.line === "string" && entry.line.length <= 1_024
    : ["work_start", "work_steer", "work_stop", "spawn_run"].includes(entry.tool ?? "") &&
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

export function orchestratorDecisionsOf(value: unknown, owner: OrchestratorOwner): OrchestratorDecision[] | undefined {
  return Array.isArray(value) &&
    value.length <= ORCHESTRATOR_DECISIONS_MAX &&
    value.every((entry) => isOrchestratorDecision(entry, owner)) &&
    new Set(value.map((entry) => entry.id)).size === value.length &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= ORCHESTRATOR_DECISION_BYTES_MAX
    ? structuredClone(value)
    : undefined;
}

/** Use the run's owner-fenced state writer. Never replace an unreadable history.
 * A failed acknowledgement closes this writer before an action can execute. */
export function createOrchestratorDecisions(input: {
  owner: OrchestratorOwner;
  previous?: unknown;
  save: (entries: readonly OrchestratorDecision[]) => Promise<boolean>;
}) {
  const owner = structuredClone(input.owner);
  const previous = input.previous === undefined ? [] : input.previous;
  const restored = orchestratorDecisionsOf(previous, owner);
  let held = restored === undefined;
  let entries = restored ?? [];
  let tail: Promise<unknown> = Promise.resolve();
  return {
    snapshot: () => {
      if (restored === undefined) throw new Error("The retained orchestrator decisions could not be verified.");
      return structuredClone(entries);
    },
    record(decision: OrchestratorDecision): Promise<boolean> {
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
          if (!(await input.save(structuredClone(saved)))) {
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
    },
  };
}
