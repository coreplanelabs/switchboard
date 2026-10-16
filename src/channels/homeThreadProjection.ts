import { parsePrivateWorkerThreadKey } from "../core/privateWorkerLog.js";
import { confirmationActionLabel } from "../core/confirmations.js";
import { questionDigestOf } from "../core/coordinator/questionAnswer.js";
import type { CommandInvoker } from "../core/commandRegistry.js";
import type { ConfirmationStore } from "../core/confirmations.js";
import { unitKeyOf } from "../core/coordinator/contract.js";
import type { CoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import type { HumanGatePending } from "../core/ship/coordinator.js";
import type { RunView } from "../core/runsService.js";
import type { HomeRuntimeContext, HomeThreadProjection } from "./homeRuntime.js";
import type { HomeConversationEntry } from "./homeSeed.js";
import { readableRuns } from "./liveView/viewer.js";
import { workReadPredicate } from "./workViewScope.js";
import { ownLane, paletteCommands, turnsOf, type ConversationDeps } from "./web.js";

export interface HomeThreadProjectionOptions extends ConversationDeps {
  coordinator?: Pick<CoordinatorInstanceStore, "listUnits" | "listEvents">;
  confirmations?: Pick<ConfirmationStore, "pendingByThread">;
  commands: Pick<CommandInvoker, "list">;
  retention: { retentionDays: number } | null;
  /** The host asks its existing target-access policy with this current full credential. */
  /** Private worker prose requires a fresh original source/recipient proof. */
  privateThread?: (context: HomeRuntimeContext, thread: string) => Promise<HomeThreadProjection | undefined>;
  canWriteThread: (context: HomeRuntimeContext, thread: string, runs: readonly RunView[]) => Promise<boolean>;
  /** Only current two-sided directory proofs may add source identities. Never actor.self/email. */
  provedActorIds?: (context: HomeRuntimeContext) => Promise<readonly string[]>;
}
/** The original owner's complete saved question; unrelated transcript changes do not retarget it. */
export function homeQuestionRevision(question: HumanGatePending): number {
  return Number.parseInt(homeQuestionDigest(question).slice(0, 13), 16);
}
export function homeQuestionDigest(question: HumanGatePending): string {
  return questionDigestOf(question);
}

export function createHomeThreadProjection(options: HomeThreadProjectionOptions) {
  async function readThread(context: HomeRuntimeContext, thread: string): Promise<HomeThreadProjection | undefined> {
    if (!/^[a-z][a-z0-9-]*:[^\s]+$/i.test(thread)) return;
    if (parsePrivateWorkerThreadKey(thread)) return options.privateThread?.(context, thread);
    const visibleTo = workReadPredicate(context.actor, readableRuns(context.actor));
    const { runs, turns } = await turnsOf(options, thread, context.actor, { visibleTo });
    // An empty own browser lane can be opened; a foreign empty predicate cannot disclose a thread.
    if (!runs.length && !ownLane(context.actor.id.replace(/^access:/, ""), thread)) return;
    const aliases = new Set([context.actor.id, ...((await options.provedActorIds?.(context)) ?? [])]);
    const entries: HomeConversationEntry[] = [];
    for (const turn of turns) {
      if ("kind" in turn) {
        entries.push(
          turn.kind === "receipt"
            ? {
                id: `receipt:${turn.decidedAt}:${entries.length}`,
                role: "receipt",
                content: turn.reason,
                isViewer: false,
                authorLabel: "Receipt",
                at: turn.decidedAt,
              }
            : {
                id: `parent:${turn.runId}:${turn.at}:${entries.length}`,
                role: "assistant",
                content: turn.report ?? turn.lead ?? turn.state,
                isViewer: false,
                authorLabel: "Pipeline",
                at: turn.at,
              },
        );
        continue;
      }
      const author = turn.postedBy ?? turn.authenticatedAs ?? turn.userId;
      const isViewer = !context.actor.viewingAs && author !== undefined && aliases.has(author);
      if (turn.request)
        entries.push({
          id: `${turn.id}:request`,
          role: "user",
          content: turn.request,
          isViewer,
          authorLabel: isViewer
            ? "You"
            : author && turn.userId && author !== turn.userId
              ? `${author} on behalf of ${turn.userName ?? turn.userId}`
              : (turn.userName ?? author ?? "Unknown author"),
          source: (turn.channelId ?? thread).split(":")[0],
          at: turn.receivedAt ?? turn.startedAt,
        });
      if (turn.answer !== undefined)
        entries.push({
          id: `${turn.id}:answer`,
          role: "assistant",
          content: turn.answer,
          isViewer: false,
          authorLabel: "Switchboard",
          at: turn.finishedAt ?? turn.startedAt,
        });
    }
    let target: HomeThreadProjection["target"],
      questionRevision = 0;
    for (const instanceId of new Set(
      runs.flatMap((run) => (run.parentInstanceId ? [run.parentInstanceId] : run.instanceId ? [run.instanceId] : [])),
    )) {
      const lineage = await options.service.unitLineage(instanceId, thread, visibleTo);
      if (!lineage?.unit || !options.coordinator) continue;
      const row = (await options.coordinator.listUnits(instanceId)).find(
        (unit) =>
          unitKeyOf(unit) === lineage.unit!.key &&
          (unit.threadKey === thread || unit.reviewThread?.threadKey === thread),
      );
      if (!row || row.workBrief) continue;
      const gate = row.idle?.humanGate ?? (row.recoveryHold?.cause === "human" ? row.recoveryHold.gate : undefined);
      if (!gate) continue;
      const digest = questionDigestOf(gate);
      const events = await options.coordinator.listEvents({ instanceId, unit: row.unit });
      if (events.some((event) => event.questionDigest === digest)) continue;
      if (target) return; // Ambiguous owner evidence must never choose an answer target.
      questionRevision = homeQuestionRevision(gate);
      target = { key: `${unitKeyOf(row)}:question:${questionRevision}:${digest}`, revision: 1 };
      entries.push({
        id: `question:${target.key}:${target.revision}`,
        role: "receipt",
        isViewer: false,
        authorLabel: "Pending question",
        content: [
          `Review requested for ${gate.pr.url}.`,
          `Verdict: ${gate.verdict}. Round: ${gate.round}.`,
          ...(gate.headSha ? [`Recorded head: ${gate.headSha}.`] : []),
          ...gate.findings.map((finding) => `${finding.id}: ${finding.title}`),
          ...(gate.assignedTo ? [`Assigned to: ${gate.assignedTo}.`] : ["The recipient is unknown."]),
        ].join("\n"),
      });
    }
    const canWrite = !context.actor.viewingAs && (await options.canWriteThread(context, thread, runs));
    const saved = canWrite ? await options.confirmations?.pendingByThread(thread) : undefined;
    const offer =
      saved && aliases.has(saved.message.postedBy ?? saved.message.authenticatedAs ?? saved.message.userId)
        ? {
            id: saved.id,
            actionLabel: confirmationActionLabel(saved),
            line: saved.kind === "redispatch" ? saved.line : saved.receipt,
            ...(saved.kind === "run" ? { risk: saved.risk } : { question: saved.evidence }),
            expiresAt: saved.expiresAt,
          }
        : undefined;
    return {
      label: "Reply in this thread",
      revision: questionRevision,
      canWrite,
      entries,
      turns,
      history: { cursor: 0, hasMore: false, status: options.retention ? "partial" : "unavailable" },
      ...(target ? { target } : {}),
      ...(offer ? { offer } : {}),
    };
  }
  return {
    readThread,
    commands: (context: HomeRuntimeContext) => paletteCommands(options.commands.list(), context.actor),
  };
}
