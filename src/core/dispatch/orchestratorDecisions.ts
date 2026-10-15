import { ORCHESTRATOR_DECISION_BYTES_MAX, ORCHESTRATOR_DECISIONS_MAX } from "../budgets.js";

export interface OrchestratorOwner {
  runId: string;
  requesterId: string;
  channelId: string;
  threadKey: string;
}

/** A saved selection is not a command result or permission grant. */
export interface OrchestratorCommandDecision {
  version: 1;
  id: string;
  owner: OrchestratorOwner;
  source: { kind: "request"; messageId: string; textHash: string };
  command: string;
  line: string;
  inputHash: string;
  contextHash: string;
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

export function isOrchestratorCommandDecision(
  value: unknown,
  owner: OrchestratorOwner,
): value is OrchestratorCommandDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<OrchestratorCommandDecision>;
  let identity: unknown;
  try {
    identity = typeof entry.id === "string" ? JSON.parse(entry.id) : undefined;
  } catch {
    return false;
  }
  return (
    Object.keys(value).every((key) =>
      ["version", "id", "owner", "source", "command", "line", "inputHash", "contextHash"].includes(key),
    ) &&
    entry.version === 1 &&
    boundedText(entry.id) &&
    Array.isArray(identity) &&
    identity.length === 2 &&
    identity[0] === owner.runId &&
    boundedText(identity[1]) &&
    entry.owner !== null &&
    typeof entry.owner === "object" &&
    !Array.isArray(entry.owner) &&
    Object.keys(entry.owner).length === 4 &&
    Object.values(entry.owner).every(boundedText) &&
    Object.entries(owner).every(([key, expected]) => entry.owner?.[key as keyof OrchestratorOwner] === expected) &&
    entry.source !== null &&
    typeof entry.source === "object" &&
    !Array.isArray(entry.source) &&
    entry.source.kind === "request" &&
    Object.keys(entry.source).length === 3 &&
    boundedText(entry.source.messageId) &&
    typeof entry.source.textHash === "string" &&
    /^[a-f0-9]{64}$/.test(entry.source.textHash) &&
    boundedText(entry.command) &&
    typeof entry.line === "string" &&
    entry.line.length <= 1_024 &&
    typeof entry.inputHash === "string" &&
    /^[a-f0-9]{64}$/.test(entry.inputHash) &&
    typeof entry.contextHash === "string" &&
    /^[a-f0-9]{64}$/.test(entry.contextHash)
  );
}

/** Use the run's owner-fenced state writer. Never replace an unreadable history.
 * A failed acknowledgement closes this writer before any command can execute. */
export function createOrchestratorDecisions(input: {
  owner: OrchestratorOwner;
  previous?: unknown;
  save: (entries: readonly OrchestratorCommandDecision[]) => Promise<boolean>;
}) {
  const owner = structuredClone(input.owner);
  const previous = input.previous === undefined ? [] : input.previous;
  const valid =
    Array.isArray(previous) &&
    previous.length <= ORCHESTRATOR_DECISIONS_MAX &&
    previous.every((entry): entry is OrchestratorCommandDecision => isOrchestratorCommandDecision(entry, owner));
  let held = !valid;
  let entries: OrchestratorCommandDecision[] = valid ? structuredClone(previous) : [];
  if (!held && new TextEncoder().encode(JSON.stringify(entries)).byteLength > ORCHESTRATOR_DECISION_BYTES_MAX)
    held = true;
  if (!held && new Set(entries.map((entry) => entry.id)).size !== entries.length) held = true;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    record(decision: OrchestratorCommandDecision): Promise<boolean> {
      const next = tail.then(async () => {
        if (held || !isOrchestratorCommandDecision(decision, owner)) return false;
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
