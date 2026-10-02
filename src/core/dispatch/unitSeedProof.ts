import type { ChatMessage } from "../chatMessage.js";
import { contractFor } from "../coordinator/briefs.js";
import {
  isWorkBrief,
  unitOfIdempotencyKey,
  type CoordinatorInstance,
  type CoordinatorUnit,
} from "../coordinator/contract.js";
import type { CoordinatorInstanceStore } from "../coordinator/instanceStore.js";
import { isUnitSeedReceipt, type UnitSeedReceipt, type UnitSeedEvidence } from "../coordinator/unitSeedReceipt.js";
import { privateWorkerThreadKey } from "../privateWorkerLog.js";
import { sourceHash } from "../references/receipts.js";
import type { LiveRunRow } from "../runLedger/types.js";
import type { AssembledTranscript } from "../runLedger/transcript.js";
import type { LedgerRun, LedgerWriteThrough } from "../runLedger/writeThrough.js";
import type { RunRecord } from "../runRecord.js";
import type { RunStore } from "../runStore.js";
import { renderContract, DEFAULT_CONTRACT_MAX_CHARS, type ChildContract } from "../ship/contract.js";
import { isChildHandoff, type ChildHandoff } from "./handoff.js";
import { isUnitContext, sameUnitContextBinding, type UnitContextBinding } from "./unitContext.js";

export interface UnitSeedProofDeps {
  runLedger: Pick<LedgerWriteThrough, "gen" | "readLiveRuns" | "readSession">;
  runStore: Pick<RunStore, "get" | "list">;
  instances: Pick<CoordinatorInstanceStore, "get" | "listUnits">;
}
export type UnitSeedProof = UnitSeedEvidence;
type StoredChild = LiveRunRow | RunRecord;
const factsOf = (row: StoredChild) => ("meta" in row ? { ...row.meta, id: row.runId } : row);
const receiptOf = (row: StoredChild): unknown => ("meta" in row ? row.state.unitSeedReceipt : row.unitSeedReceipt);
const emptyReaders = { readRepoFile: async () => undefined, readRunFacts: async () => undefined };
const unavailable = { kind: "unavailable" } as const;

async function canonicalUnit(deps: UnitSeedProofDeps, instanceId: string, unitId: string) {
  const instance = await deps.instances.get(instanceId);
  if (!instance || instance.id !== instanceId) return undefined;
  const units = (await deps.instances.listUnits(instanceId)).filter(
    (unit) => unit.instanceId === instanceId && unit.unit === unitId,
  );
  return units.length === 1 ? { instance, unit: units[0]! } : undefined;
}

function seedBody(transcript: Pick<AssembledTranscript, "messages" | "actors" | "compactions">) {
  return {
    messages: transcript.messages,
    actors: transcript.messages.map((_, i) => transcript.actors?.[i] ?? null),
    compactions: transcript.compactions,
  };
}

async function canonicalChild(
  row: StoredChild,
  instance: CoordinatorInstance,
  unit: CoordinatorUnit,
): Promise<Omit<UnitSeedEvidence, "receipt"> | undefined> {
  const facts = factsOf(row);
  const handoff = facts.childHandoff;
  if (
    !unit.workBrief ||
    !isUnitContext(unit.context) ||
    !isChildHandoff(handoff) ||
    !handoff.consumer ||
    facts.parentInstanceId !== instance.id ||
    facts.coordinatorUnit !== unit.unit ||
    (facts.coordinatorAttempt ?? 0) !== (instance.attempt ?? 0) ||
    !facts.idempotencyKey?.startsWith(`${instance.id}:`) ||
    unitOfIdempotencyKey(facts.idempotencyKey) !== unit.unit ||
    facts.userId !== instance.userId ||
    facts.channelId !== instance.channelId ||
    facts.threadKey !== privateWorkerThreadKey({ instanceId: instance.id, unit: unit.unit }) ||
    handoff.consumer.runId !== facts.id ||
    handoff.consumer.requester !== facts.userId ||
    handoff.consumer.channelId !== facts.channelId ||
    handoff.consumer.threadKey !== facts.threadKey ||
    handoff.consumer.attempt !== facts.idempotencyKey ||
    handoff.snapshotRunId !== facts.id ||
    (facts.agent !== "coding" && facts.agent !== "review")
  )
    return undefined;
  const { consumer: _consumer, snapshotRunId: _snapshot, ...unbound } = handoff;
  if ((await sourceHash({ version: 1, handoff: unbound })) !== (await sourceHash(unit.context))) return undefined;
  const contract = await contractFor(instance, unit, emptyReaders, facts.agent);
  return {
    role: facts.agent,
    child: { runId: facts.id, requester: facts.userId, channelId: facts.channelId, threadKey: facts.threadKey },
    binding: {
      instanceId: instance.id,
      unit: unit.unit,
      instanceAttempt: instance.attempt ?? 0,
      idempotencyKey: facts.idempotencyKey,
    },
    contractHash: await sourceHash(contract.unit),
  };
}

async function readChildProof(
  deps: UnitSeedProofDeps,
  row: StoredChild,
  instance: CoordinatorInstance,
  unit: CoordinatorUnit,
): Promise<UnitSeedProof | undefined> {
  const receipt = receiptOf(row);
  if (!isUnitSeedReceipt(receipt) || (!("meta" in row) && row.provisional)) return undefined;
  const facts = factsOf(row);
  const canonical = await canonicalChild(row, instance, unit);
  const session = facts.session;
  if (
    !canonical ||
    !session ||
    session.range === "broken" ||
    !sameUnitContextBinding(receipt.binding, canonical.binding) ||
    (await sourceHash(receipt.child)) !== (await sourceHash(canonical.child)) ||
    receipt.workBriefHash !== (await sourceHash(unit.workBrief)) ||
    receipt.capsuleHash !== (await sourceHash(unit.context)) ||
    receipt.contractHash !== canonical.contractHash ||
    receipt.seed.key !== session.key ||
    receipt.seed.from !== session.seedFrom
  )
    return undefined;
  if ("meta" in row) {
    const checkpoint = row.state.contextCheckpoint as { key?: unknown; through?: unknown } | undefined;
    if (
      checkpoint?.key !== session.key ||
      typeof checkpoint.through !== "number" ||
      checkpoint.through < receipt.seed.through ||
      receipt.seed.systemHash !== (await sourceHash(row.system))
    )
      return undefined;
  } else if (session.range.to === undefined || receipt.seed.through > session.range.to) return undefined;
  const saved = await deps.runLedger.readSession(receipt.seed.key, receipt.seed.from, receipt.seed.through);
  if (
    !saved.complete ||
    saved.turns !== receipt.seed.through - receipt.seed.from + 1 ||
    (await sourceHash(saved)) !== receipt.seed.messagesHash
  )
    return undefined;
  return { receipt: structuredClone(receipt), ...canonical };
}

/** Privileged status callback: callers already authorized the canonical unit.
 * The proof reads child metadata and retained seed bytes independently of the receipt. */
export async function readUnitSeedProof(
  deps: UnitSeedProofDeps,
  input: { instance: CoordinatorInstance; unit: CoordinatorUnit },
): Promise<UnitSeedProof | undefined> {
  try {
    const current = await canonicalUnit(deps, input.instance.id, input.unit.unit);
    if (
      !current ||
      (current.instance.attempt ?? 0) !== (input.instance.attempt ?? 0) ||
      (await sourceHash(current.unit.workBrief)) !== (await sourceHash(input.unit.workBrief)) ||
      (await sourceHash(current.unit.context)) !== (await sourceHash(input.unit.context))
    )
      return undefined;
    const threadKey = privateWorkerThreadKey({ instanceId: current.instance.id, unit: current.unit.unit });
    const live = (await deps.runLedger.readLiveRuns()).filter((row) => row.meta.threadKey === threadKey);
    for (const row of live) {
      const proof = await readChildProof(deps, row, current.instance, current.unit);
      if (proof) return proof;
    }
    for (const summary of await deps.runStore.list({ threadKey })) {
      if (live.some((row) => row.runId === summary.id)) continue;
      const row = await deps.runStore.get(summary.id);
      if (!row) continue;
      const proof = await readChildProof(deps, row, current.instance, current.unit);
      if (proof) return proof;
    }
  } catch {
    /* An unavailable seed is not an acknowledgment. */
  }
  return undefined;
}

export async function acknowledgeUnitSeed(
  deps: UnitSeedProofDeps,
  input: {
    run: LedgerRun;
    binding: UnitContextBinding;
    handoff: ChildHandoff;
    contract?: ChildContract;
    contractBlock?: string;
    messages: readonly ChatMessage[];
    actors?: readonly (string | undefined)[];
    system: string;
    checkpoint: { key: string; through: number };
    acknowledgedAt: number;
  },
): Promise<{ kind: "acknowledged"; receipt: UnitSeedReceipt } | { kind: "not-applicable" } | { kind: "unavailable" }> {
  try {
    const current = await canonicalUnit(deps, input.binding.instanceId, input.binding.unit);
    if (!current) return unavailable;
    if (current.unit.workBrief === undefined) return { kind: "not-applicable" };
    if (!isWorkBrief(current.unit.workBrief)) return unavailable;
    if (!input.run.tracked()) return unavailable;
    const row = (await deps.runLedger.readLiveRuns()).find((row) => row.runId === input.run.runId);
    if (!row || row.ownerGen !== deps.runLedger.gen) return unavailable;
    const canonical = await canonicalChild(row, current.instance, current.unit);
    if (
      !canonical ||
      !sameUnitContextBinding(input.binding, canonical.binding) ||
      (await sourceHash(row.meta.childHandoff)) !== (await sourceHash(input.handoff))
    )
      return unavailable;
    if (row.state.unitSeedReceipt !== undefined) {
      const existing = await readChildProof(deps, row, current.instance, current.unit);
      return existing ? { kind: "acknowledged", receipt: existing.receipt } : unavailable;
    }
    const session = row.meta.session;
    const checkpoint = row.state.contextCheckpoint;
    if (
      !input.contract ||
      !input.contractBlock ||
      !session ||
      session.range === "broken" ||
      row.system !== input.system ||
      (await sourceHash(checkpoint)) !== (await sourceHash(input.checkpoint)) ||
      input.checkpoint.key !== session.key ||
      input.checkpoint.through < session.seedFrom ||
      (await sourceHash(input.contract.unit)) !== canonical.contractHash ||
      renderContract(input.contract, { maxChars: DEFAULT_CONTRACT_MAX_CHARS }).text !== input.contractBlock
    )
      return unavailable;
    const saved = await deps.runLedger.readSession(session.key, session.seedFrom, input.checkpoint.through);
    if (
      !saved.complete ||
      saved.turns !== input.messages.length ||
      saved.turns !== input.checkpoint.through - session.seedFrom + 1 ||
      (await sourceHash(seedBody(saved))) !==
        (await sourceHash(
          seedBody({
            messages: [...input.messages],
            actors: input.actors ? [...input.actors] : undefined,
            compactions: [],
          }),
        ))
    )
      return unavailable;
    const blockPresent =
      row.meta.agent === "review"
        ? row.system.includes(input.contractBlock)
        : saved.messages
            .find((message) => message.role === "user")
            ?.content.some((part) => part.type === "text" && part.text === input.contractBlock);
    if (!blockPresent) return unavailable;
    const receipt: UnitSeedReceipt = {
      version: 1,
      child: canonical.child,
      binding: canonical.binding,
      contractHash: canonical.contractHash,
      ownerGen: row.ownerGen,
      workBriefHash: await sourceHash(current.unit.workBrief),
      capsuleHash: await sourceHash(current.unit.context),
      seed: {
        key: session.key,
        from: session.seedFrom,
        through: input.checkpoint.through,
        messagesHash: await sourceHash(saved),
        systemHash: await sourceHash(row.system),
      },
      acknowledgedAt: input.acknowledgedAt,
    };
    if (!(await input.run.setStateAndFlush({ unitSeedReceipt: receipt }))) return unavailable;
    const stored = (await deps.runLedger.readLiveRuns()).find((value) => value.runId === row.runId);
    if (
      !stored ||
      stored.ownerGen !== row.ownerGen ||
      (await sourceHash(stored.state.unitSeedReceipt)) !== (await sourceHash(receipt))
    )
      return unavailable;
    return { kind: "acknowledged", receipt };
  } catch {
    return unavailable;
  }
}
