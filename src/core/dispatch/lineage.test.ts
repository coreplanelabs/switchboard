import { describe, expect, it, vi } from "vitest";
import { tellParent, type ThreadLineage } from "./lineage.js";
import { ThreadAdmission } from "../threadAdmission.js";
import type { DispatchFollowUp } from "./admission.js";
import { NO_GRANTS } from "../authz/types.js";

describe("child replies retain requester isolation", () => {
  it.each(["linear:org:bob", undefined])(
    "does not steer a parent owned by %s from another person's child reply",
    async (owner) => {
      const pushInbox = vi.fn(async () => 1);
      const deps = {
        runs: {
          getRun: async () => ({
            ok: true as const,
            value: {
              id: "parent",
              finished: false,
              startedAt: 1,
              eventCount: 0,
              threadKey: "linear:org:parent",
              agent: "general",
              ...(owner ? { userId: owner } : {}),
            },
          }),
        },
        config: { canRunAgent: () => true, grantsFor: () => NO_GRANTS },
        runLedger: { pushInbox },
        admission: new ThreadAdmission<DispatchFollowUp>(),
        isolateFollowUps: true,
      };
      const lineage: ThreadLineage = { parentRunId: "parent", child: { runId: "child", live: false } };
      const msg = {
        userId: "linear:org:alice",
        channelId: "linear:org:team",
        threadKey: "linear:org:child",
        text: "Change the task",
      };
      expect(await tellParent(deps, lineage, msg, { kind: "started", runId: "continuation" })).toBe("refused");
      expect(pushInbox).not.toHaveBeenCalled();
      deps.runs.getRun = async () => ({
        ok: true,
        value: {
          id: "parent",
          finished: false,
          startedAt: 1,
          eventCount: 0,
          threadKey: "linear:org:parent",
          agent: "general",
          userId: msg.userId,
        },
      });
      expect(await tellParent(deps, lineage, msg, { kind: "started", runId: "continuation" })).toBe("steered");
      expect(pushInbox).toHaveBeenCalledOnce();
    },
  );
});
