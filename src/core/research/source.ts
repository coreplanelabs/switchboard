import type { CoordinatorUnit } from "../coordinator/contract.js";
import { researchBriefFromSubmission, type ResearchBrief } from "./brief.js";
import type { RunRecordView } from "../runsService.js";

/** This checks canonical run identity, not the model's source claims. */
export function researchFromRun(
  run: RunRecordView,
  target: {
    instanceId: string;
    unit: string;
    requester: string;
    channelId: string;
    threadKey: string;
    repo: string;
    branch: string;
    headSha?: string;
    unitRecord?: CoordinatorUnit;
  },
): ResearchBrief | undefined {
  const brief = researchBriefFromSubmission(
    run.researchBrief,
    run.events ?? [],
    run.truncated === false && run.eventCount === run.storedEventCount && run.events?.length === run.storedEventCount,
  );
  const tags = run.events?.filter((event) => event.type === "coordinator_tag") ?? [];
  const tag = tags[0];
  if (
    !run.finished ||
    run.status !== "completed" ||
    run.provisional ||
    run.persisted !== true ||
    run.agent !== "research" ||
    run.userId !== target.requester ||
    run.channelId !== target.channelId ||
    run.threadKey !== target.threadKey ||
    run.parentInstanceId !== target.instanceId ||
    run.coordinatorUnit !== target.unit ||
    run.idempotencyKey !== `${target.instanceId}:${target.unit}/0/research` ||
    tags.length !== 1 ||
    tag?.parentInstanceId !== target.instanceId ||
    tag.unit !== target.unit ||
    tag.branch !== target.branch ||
    typeof tag.researchTarget?.repo !== "string" ||
    tag.researchTarget.repo.toLowerCase() !== target.repo.toLowerCase() ||
    typeof tag.researchTarget.headSha !== "string" ||
    !/^[a-f0-9]{40}$/i.test(tag.researchTarget.headSha) ||
    brief === undefined ||
    (brief.decision !== "ready" &&
      (target.unitRecord?.instanceId !== target.instanceId ||
        target.unitRecord.unit !== target.unit ||
        target.unitRecord.branch !== target.branch ||
        researchInputAnswers(target.unitRecord, run.id, brief.blockedReason).length === 0)) ||
    brief.headSha.toLowerCase() !== tag.researchTarget.headSha.toLowerCase() ||
    (target.headSha !== undefined && brief.headSha.toLowerCase() !== target.headSha.toLowerCase())
  )
    return undefined;
  return brief;
}

/** Only the canonical unit's durable wake receipt can answer its original source. */
export function researchInputAnswers(unit: CoordinatorUnit | undefined, runId: string, question?: string): string[] {
  if (!unit || unit.researchRunId !== runId) return [];
  return Object.values(unit.wakes ?? {}).flatMap((wake) =>
    wake.kind === "segment" &&
    wake.researchGate?.runId === runId &&
    (question === undefined || wake.researchGate.question === question)
      ? wake.texts
      : [],
  );
}
