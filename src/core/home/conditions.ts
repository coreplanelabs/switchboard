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
      const gate = row.idle?.humanGate ?? (row.recoveryHold?.cause === "human" ? row.recoveryHold.gate : undefined);
      if (!gate) return [];
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
