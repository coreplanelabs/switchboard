import { describe, expect, it, vi } from "vitest";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { contextThreadSessionKey } from "../runLedger/sessionLog.js";
import {
  coordinatorReportAdmission,
  freezeAdmittedCoordinatorReport,
  freezeCoordinatorReport,
} from "./reportContext.js";

const owner = {
  instanceId: "plan-original",
  unit: "U11",
  attempt: 0,
  requester: "cli:user",
  channelId: "cli:main",
  threadKey: "cli:main:1",
  deliveryId: "U11/0/end",
};

describe("coordinator report snapshots", () => {
  it("requires the exact admitted proposal before creating immutable report bytes", async () => {
    const ledger = new InMemoryRunLedger();
    const proposal = { text: "accepted detail", threadText: "accepted summary" };
    const admission = await coordinatorReportAdmission(owner, proposal);
    await expect(
      freezeAdmittedCoordinatorReport(ledger, admission, owner, { ...proposal, threadText: "changed" }),
    ).rejects.toThrow("not admitted");
    expect((await ledger.readSessionTail(contextThreadSessionKey(owner.threadKey), 100_000)).transcript.turns).toBe(0);
    expect(await freezeAdmittedCoordinatorReport(ledger, admission, owner, proposal)).toEqual(proposal);
  });
  it("keeps the first report and its unknown provenance across replay, later turns and changed verbosity", async () => {
    const ledger = new InMemoryRunLedger();
    const first = { text: "original detail", threadText: "short reply" };
    expect(await freezeCoordinatorReport(ledger, owner, first)).toEqual(first);
    expect(
      await freezeCoordinatorReport(ledger, owner, { text: "regenerated detail", threadText: "different verbosity" }),
    ).toEqual(first);
    const stored = await ledger.readSessionTail(contextThreadSessionKey(owner.threadKey), 100_000);
    expect(stored.transcript.turns).toBe(1);
    expect(stored.transcript.contexts?.[0]?.status).toBe("unknown");
    expect(
      await freezeCoordinatorReport(
        ledger,
        { ...owner, deliveryId: "U11/1/end" },
        { text: "next segment", threadText: "next" },
      ),
    ).toEqual({ text: "next segment", threadText: "next" });
  });

  it("cannot publish an unacknowledged report or replace an unreadable original", async () => {
    const ledger = new InMemoryRunLedger();
    vi.spyOn(ledger, "appendSession").mockResolvedValue({ ok: false, appended: false });
    await expect(
      freezeCoordinatorReport(ledger, owner, { text: "error details", threadText: "failed" }),
    ).rejects.toThrow();
  });
});
