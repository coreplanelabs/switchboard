import { currentUnitProgress } from "../coordinator/unitProgress.js";
import { questionDigestOf } from "../coordinator/questionAnswer.js";
import type { ThreadEvent } from "../coordinator/contract.js";
import type { UnitEventKey } from "../coordinator/instanceStore.js";
import { parseUnitKey, unitKeyOf, type CoordinatorUnit } from "../coordinator/contract.js";
import type { HomeCondition } from "./service.js";

/** Only a question's durable producer can assign a person. Old rows remain
 * unknown; the pipeline requester is not a substitute for that assignment. */
export function createHomeConditionReader(instances: {
  listUnits(instanceId: string): Promise<CoordinatorUnit[]>;
  listEvents?(key: UnitEventKey): Promise<ThreadEvent[]>;
}) {
  return {
    async list(unitKey: string, canonicalUnit?: CoordinatorUnit, privateRead = false): Promise<HomeCondition[]> {
      const key = parseUnitKey(unitKey);
      if (!key) throw new Error("The work key is invalid.");
      // A Home read already has this canonical row. Use that same snapshot so
      // conditions and unit facts agree without fetching the whole pipeline again.
      // Standalone callers still read fresh rows; no state is cached across reads.
      const rows = canonicalUnit
        ? unitKeyOf(canonicalUnit) === unitKey
          ? [canonicalUnit]
          : []
        : (await instances.listUnits(key.instanceId)).filter((row) => unitKeyOf(row) === unitKey);
      if (rows.length !== 1) throw new Error("The work question is unavailable.");
      const row = rows[0]!;
      if (row.workBrief !== undefined && !privateRead) return [];
      const merge = row.ending?.kind === "merge_ready" ? row.mergeAttention : undefined;
      if (
        merge &&
        !merge.resolved &&
        row.pr?.number === merge.pr.number &&
        row.pr.url === merge.pr.url &&
        row.lastPush === merge.headSha
      )
        return [
          {
            id: `${unitKey}:merge`,
            unitKey,
            revision: Math.max(1, merge.at),
            state: "open",
            owner: { kind: "person", id: merge.assignedTo },
            summary: "Review completed for this recorded head.",
            nextAction: "Inspect current checks and merge the reviewed pull request when allowed.",
          },
        ];
      const gate = row.idle?.humanGate ?? (row.recoveryHold?.cause === "human" ? row.recoveryHold.gate : undefined);
      if (!gate) {
        const progress = currentUnitProgress(row);
        if (!progress?.waiting) {
          const ending = row.ending;
          const failure =
            (ending?.kind === "failed" && ending.cause === "step_threw") ||
            (ending?.outcome?.kind === ending?.kind &&
              (ending?.kind === "transient" || ending?.kind === "interrupted"));
          if (!ending || !failure) return [];
          return [
            {
              id: `${unitKey}:failure`,
              unitKey,
              revision: Math.max(1, ending.at),
              state: "open",
              owner: { kind: "unknown" },
              summary: "The original work stopped because a recorded operation failed.",
              ...(row.threadKey ? { nextAction: "Inspect the recorded failure in its existing work thread." } : {}),
            },
          ];
        }
        const wait = progress.waiting;
        return [
          {
            id: `${unitKey}:progress`,
            unitKey,
            revision: progress.revision,
            state: "open",
            owner:
              wait.kind === "checks"
                ? { kind: "external", label: "GitHub checks" }
                : { kind: "automation", class: wait.kind === "child" ? "Original worker" : "Retry delay" },
            summary:
              wait.kind === "checks"
                ? `Waiting for GitHub checks at ${wait.headSha.slice(0, 7)}.`
                : wait.kind === "child"
                  ? "Waiting for the original worker result."
                  : "The original runner is waiting before its next attempt.",
            nextAction:
              wait.kind === "checks"
                ? "Wait for checks at the recorded head, then verify the result."
                : wait.kind === "child"
                  ? "Wait for the original worker, then verify its recorded result."
                  : "Wait for the recorded retry delay before the original runner continues.",
          },
        ];
      }
      if (
        instances.listEvents &&
        (await instances.listEvents(key)).some((event) => event.questionDigest === questionDigestOf(gate))
      )
        return [];
      return [
        {
          id: `${unitKey}:question`,
          unitKey,
          revision: Math.max(1, gate.askedAt ?? row.idle?.at ?? row.ending?.at ?? 1),
          state: "open",
          owner: gate.assignedTo ? { kind: "person", id: gate.assignedTo } : { kind: "unknown" },
          summary:
            gate.findings
              .map((finding) => `${finding.id}: ${finding.title}`)
              .join("; ")
              .slice(0, 1000) || "A recorded question needs an answer.",
          nextAction: "Answer the recorded question.",
        },
      ];
    },
  };
}
