import { privateWorkerThreadKey } from "../../channels/privateWorker.js";
import { authorize, selfIdsOf } from "../authz/authorize.js";
import type { Actor } from "../authz/types.js";
import type { PrivateWorkerLog } from "../privateWorkerLog.js";
import {
  isCoordinatorInstance,
  isCoordinatorUnit,
  isMainTaskKey,
  mainTaskClaimMatches,
  type CoordinatorInstance,
} from "./contract.js";
import type { CoordinatorInstanceStore } from "./instanceStore.js";
import { shipSettlementOf, type ShipSettlement } from "./shipOutcome.js";
import type { RecoveryReceipt } from "./recoveryHistory.js";

const PAGE_SIZE = 8;
const TITLE_LIMIT = 160;
const REPORT_LIMIT = 2_000;

export interface MainWorkerProgress {
  seq: number;
  phase: "start" | "update" | "done";
  title: string;
  at: number;
}

export type MainWorkerRelayResult =
  | { kind: "not_found" | "forbidden" | "invalid" | "unavailable" }
  | {
      kind: "found";
      /** The private log's durable sequence, safe to pass as `afterSeq` on the next read. */
      cursor: number;
      more: boolean;
      progress: MainWorkerProgress[];
      history?: {
        cursor: number;
        more: boolean;
        /** Recording began with an observed predecessor; earlier attempts are unknown. */
        priorHistory: "not_recorded";
        receipts: Array<
          Pick<RecoveryReceipt, "id" | "seq" | "provenance" | "predecessorId" | "actionId" | "workflowId"> & {
            settlement: ShipSettlement;
            kind: string;
            report: string;
            reportTruncated?: true;
            at: number;
          }
        >;
      };
      final?: {
        settlement: ShipSettlement;
        kind: string;
        report: string;
        reportTruncated?: true;
        at: number;
        pr?: { number: number; url: string };
      };
    };

function resource(instance: CoordinatorInstance) {
  return {
    type: "run" as const,
    id: instance.runId ?? instance.id,
    channelId: instance.channelId,
    userId: instance.userId,
    repo: instance.repo,
    channelVisibility: "unknown" as const,
  };
}

/** A private worker's progress is data for its main agent, never a child-channel post.
 * The indexed act is only an address; the requester, thread and durable unit
 * are rechecked on every read. No input or freeform worker reply crosses. */
export function createMainWorkerRelay(deps: {
  instances: Pick<CoordinatorInstanceStore, "getMainTask" | "get" | "listUnits" | "listRecoveryHistory">;
  privateWorkerLog: Pick<PrivateWorkerLog, "listAfter">;
}) {
  return {
    async read(
      actor: Actor,
      input: { actId: string; afterSeq?: number; afterHistory?: number },
    ): Promise<MainWorkerRelayResult> {
      const afterSeq = input.afterSeq ?? 0;
      const afterHistory = input.afterHistory ?? 0;
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(afterHistory) || afterHistory < 0)
        return { kind: "invalid" };
      const origin = actor.origin;
      if (!origin || !isMainTaskKey({ mainThreadKey: origin.threadKey, actId: input.actId }))
        return { kind: "not_found" };
      try {
        const key = { mainThreadKey: origin.threadKey, actId: input.actId };
        const link = await deps.instances.getMainTask(key);
        if (!link) return { kind: "not_found" };
        const [instance, units] = await Promise.all([
          deps.instances.get(link.instanceId),
          deps.instances.listUnits(link.instanceId),
        ]);
        const unit = units.find((row) => row.unit === link.unit);
        if (
          !isCoordinatorInstance(instance) ||
          !isCoordinatorUnit(unit) ||
          instance.channelId !== origin.channelId ||
          !selfIdsOf(actor).includes(instance.userId) ||
          !mainTaskClaimMatches(key, instance, unit)
        )
          return { kind: "not_found" };
        if (!authorize(actor, "runs:read", resource(instance)).allow) return { kind: "forbidden" };
        const historyPage = unit.history ? await deps.instances.listRecoveryHistory(unit, afterHistory) : undefined;
        const history = historyPage
          ? {
              cursor: historyPage.cursor,
              more: historyPage.more,
              priorHistory: "not_recorded" as const,
              receipts: historyPage.receipts.map(
                ({ id, seq, provenance, predecessorId, actionId, workflowId, ending }) => ({
                  id,
                  seq,
                  provenance,
                  ...(predecessorId ? { predecessorId } : {}),
                  ...(actionId ? { actionId } : {}),
                  ...(workflowId ? { workflowId } : {}),
                  settlement: shipSettlementOf(ending),
                  kind: ending.kind,
                  report: ending.report.slice(0, REPORT_LIMIT),
                  ...(ending.report.length > REPORT_LIMIT ? { reportTruncated: true as const } : {}),
                  at: ending.at,
                }),
              ),
            }
          : undefined;
        const page = await deps.privateWorkerLog.listAfter(
          privateWorkerThreadKey({ instanceId: instance.id, unit: unit.unit }),
          afterSeq,
          PAGE_SIZE,
        );
        if (
          page.events.length > PAGE_SIZE ||
          page.events.some((event, index) => event.seq <= (index === 0 ? afterSeq : page.events[index - 1]!.seq))
        )
          return { kind: "unavailable" };
        const cursor = page.events.at(-1)?.seq ?? afterSeq;
        const progress = page.events.flatMap((event): MainWorkerProgress[] => {
          if (event.kind !== "status") return [];
          const title =
            event.frame.title
              .split(/[\r\n]/, 1)[0]!
              .trim()
              .slice(0, TITLE_LIMIT) || "Working";
          return [{ seq: event.seq, phase: event.phase, title, at: event.at }];
        });
        const final = unit.ending
          ? {
              kind: unit.ending.kind,
              settlement: shipSettlementOf(unit.ending),
              report: unit.ending.report.slice(0, REPORT_LIMIT),
              ...(unit.ending.report.length > REPORT_LIMIT ? { reportTruncated: true as const } : {}),
              at: unit.ending.at,
              ...(unit.pr ? { pr: { number: unit.pr.number, url: unit.pr.url } } : {}),
            }
          : undefined;
        return {
          kind: "found",
          cursor,
          more: page.more,
          progress,
          ...(final ? { final } : {}),
          ...(history ? { history } : {}),
        };
      } catch {
        return { kind: "unavailable" };
      }
    },
  };
}
