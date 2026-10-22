import { describe, expect, it } from "vitest";
import { reclaimRuns } from "./boot.js";
import { createOrganizationResumeHold } from "./organizationResumeHold.js";
import { InMemoryRunLedger } from "./runLedger/inMemory.js";
import { LEASE_MS } from "./runLedger/types.js";
import { rememberStorageFailure } from "./storageFailureDiagnostic.js";

describe("organization resume hold", () => {
  it("does not carry consumed inbox messages into a held resume", async () => {
    let now = 1_000;
    const ledger = new InMemoryRunLedger(() => now);
    await ledger.claim({
      runId: "original-run",
      threadKey: "web:thread",
      gen: "old-bot",
      leaseMs: LEASE_MS,
      startedAt: now,
      meta: {
        channelId: "web:channel",
        userId: "access:user",
        threadKey: "web:thread",
        agent: "review",
        organizationIngressRunId: "original-run",
      },
      card: null,
      system: "system",
      tools: [],
    });
    await ledger.seed("original-run", "old-bot", [
      { idx: 0, message: { role: "user", content: [{ type: "text", text: "review this" }] } },
    ]);
    for (let i = 1; i <= 5; i++) await ledger.pushInbox("original-run", { text: `already read ${i}` });
    await ledger.step(
      "original-run",
      "old-bot",
      {
        step: 0,
        seq: 0,
        turnIndex: 1,
        inFlight: [],
        inboxConsumedSeq: 5,
        remainingMs: 600_000,
        turn: 0,
        iteration: 0,
      },
      [],
    );
    now += LEASE_MS;
    const reclaimed = await reclaimRuns({ ledger, gen: "new-bot", now: () => now });
    expect(reclaimed.resumable.map((run) => run.row.runId)).toEqual(["original-run"]);
    expect(reclaimed.resumable[0]?.kind).not.toBe("restart");
    expect(
      reclaimed.resumable[0]?.kind === "restart" || reclaimed.resumable[0]?.kind === "rehost"
        ? []
        : reclaimed.resumable[0]?.inbox,
    ).toEqual([]);

    let available = false;
    const hold = createOrganizationResumeHold({
      ledger,
      gen: "new-bot",
      now: () => now,
      binding: async () => (available ? { runId: "original-run" } : undefined),
      eligible: (run, source) => run.row.runId === source.runId,
      refusalReason: () => "source_ineligible",
      warn: () => {},
    });
    expect((await hold.select(reclaimed.resumable)).runnable).toEqual([]);
    await ledger.pushInbox("original-run", { text: "new while held" });
    available = true;
    now += LEASE_MS;
    const retried = await hold.retry();
    const resumed = retried.runnable[0];
    expect(
      resumed && resumed.kind !== "restart" && resumed.kind !== "rehost"
        ? resumed.inbox.map((item) => item.message.text)
        : [],
    ).toEqual(["new while held"]);
  });

  it("keeps an unverified restart visible and resumes its original id after the source returns", async () => {
    let now = 1_000;
    const ledger = new InMemoryRunLedger(() => now);
    await ledger.claim({
      runId: "original-run",
      threadKey: "web:thread",
      gen: "old-bot",
      leaseMs: LEASE_MS,
      startedAt: now,
      meta: {
        channelId: "web:channel",
        userId: "access:user",
        threadKey: "web:thread",
        agent: "review",
        organizationIngressRunId: "original-run",
        request: { text: "review the pull request" },
      },
      card: null,
      system: "",
      tools: [],
      phase: "attaching",
    });
    now += LEASE_MS;
    const reclaimed = await reclaimRuns({ ledger, gen: "new-bot", now: () => now });
    expect(reclaimed.resumable.map((run) => run.row.runId)).toEqual(["original-run"]);

    let source: "missing" | "error" | "ready" = "missing";
    const warnings: string[] = [];
    const hold = createOrganizationResumeHold({
      ledger,
      gen: "new-bot",
      now: () => now,
      binding: async () => {
        if (source === "error") throw new Error("private source failed");
        return source === "ready" ? { runId: "original-run", originalStatus: "dispatching" } : undefined;
      },
      eligible: (run, source) => run.row.runId === source.runId,
      refusalReason: () => "source_ineligible",
      warn: (line) => warnings.push(line),
    });
    expect((await hold.select(reclaimed.resumable)).runnable).toEqual([]);
    expect((await ledger.listLive())[0]?.state.organizationResumeHold).toMatchObject({
      reason: "source_not_verified",
      attempts: 1,
    });
    expect(hold.pendingRows().map((run) => run.row.runId)).toEqual(["original-run"]);
    expect((await reclaimRuns({ ledger, gen: "new-bot", now: () => now + LEASE_MS })).resumable).toEqual([]);

    await ledger.pushInbox("original-run", { text: "also check the tests" });
    expect((await hold.retry()).runnable).toEqual([]);
    now += LEASE_MS;
    source = "error";
    expect((await hold.retry()).runnable).toEqual([]);
    expect((await ledger.listLive())[0]?.state.organizationResumeHold).toMatchObject({
      reason: "source_check_failed",
      attempts: 2,
    });
    expect(warnings.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual({
      event: "run.resume_source_check_failed",
      runId: "original-run",
      errorKind: "exception",
      errorName: "Error",
    });
    expect(warnings.join("\n")).not.toContain("private source failed");
    source = "ready";
    now += LEASE_MS * 2;
    const retried = await hold.retry();
    expect(retried.runnable.map((run) => run.row.runId)).toEqual(["original-run"]);
    expect(
      retried.runnable[0]?.kind === "restart" ? retried.runnable[0].inbox.map((item) => item.message.text) : [],
    ).toEqual(["also check the tests"]);
    expect((await ledger.listLive())[0]?.state.organizationResumeHold).toMatchObject({ status: "released" });
    expect((await hold.retry()).runnable).toEqual([]);
  });

  it("reports failed hold writes and releases without exposing exception text or launching", async () => {
    let now = 1_000;
    const ledger = new InMemoryRunLedger(() => now);
    await ledger.claim({
      runId: "original-run",
      threadKey: "web:thread",
      gen: "old-bot",
      leaseMs: LEASE_MS,
      startedAt: now,
      meta: {
        channelId: "web:channel",
        userId: "access:user",
        threadKey: "web:thread",
        agent: "review",
        organizationIngressRunId: "original-run",
        request: { text: "review the pull request" },
      },
      card: null,
      system: "",
      tools: [],
      phase: "attaching",
    });
    now += LEASE_MS;
    const reclaimed = await reclaimRuns({ ledger, gen: "new-bot", now: () => now });
    let fail: "held" | "released" | undefined = "held";
    let available = false;
    const warnings: string[] = [];
    const hold = createOrganizationResumeHold({
      ledger: {
        listLive: () => ledger.listLive(),
        readInbox: (runId, afterSeq) => ledger.readInbox(runId, afterSeq),
        setState: (runId, gen, state) => {
          if ((state.organizationResumeHold as { status?: string } | undefined)?.status === fail) {
            const error = new Error("private input must not be logged");
            if (fail === "held")
              rememberStorageFailure(error, {
                version: 1,
                operation: "/runs/state",
                requestDigest: "a".repeat(64),
                requestId: "11111111-1111-4111-8111-111111111111",
                kind: "write",
                phase: "transport",
              });
            throw error;
          }
          return ledger.setState(runId, gen, state);
        },
      },
      gen: "new-bot",
      now: () => now,
      binding: async () => (available ? { runId: "original-run" } : undefined),
      eligible: (run, source) => run.row.runId === source.runId,
      refusalReason: () => "source_ineligible",
      warn: (line) => warnings.push(line),
    });
    expect((await hold.select(reclaimed.resumable)).runnable).toEqual([]);
    expect(hold.pendingRows().map((run) => run.row.runId)).toEqual(["original-run"]);
    expect(warnings.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual({
      event: "run.resume_source_hold_write_unconfirmed",
      runId: "original-run",
      reason: "source_not_verified",
      errorKind: "storage",
      operation: "/runs/state",
      phase: "transport",
      requestId: "11111111-1111-4111-8111-111111111111",
    });

    fail = undefined;
    now += LEASE_MS;
    expect((await hold.retry()).runnable).toEqual([]);
    available = true;
    fail = "released";
    now += LEASE_MS * 2;
    expect((await hold.retry()).runnable).toEqual([]);
    expect((await ledger.listLive())[0]?.state.organizationResumeHold).toMatchObject({ status: "held" });
    expect(warnings.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual({
      event: "run.resume_source_hold_release_unconfirmed",
      runId: "original-run",
      errorKind: "exception",
      errorName: "Error",
    });
    expect(warnings.join("\n")).not.toContain("private input must not be logged");
    fail = undefined;
    expect((await hold.retry()).runnable.map((run) => run.row.runId)).toEqual(["original-run"]);
  });

  it("does not retry a policy refusal or launch after the run changes owners", async () => {
    let now = 1_000;
    const ledger = new InMemoryRunLedger(() => now);
    await ledger.claim({
      runId: "original-run",
      threadKey: "web:thread",
      gen: "old-bot",
      leaseMs: LEASE_MS,
      startedAt: now,
      meta: {
        channelId: "web:channel",
        userId: "access:user",
        threadKey: "web:thread",
        agent: "review",
        organizationIngressRunId: "original-run",
        request: { text: "review the pull request" },
      },
      card: null,
      system: "",
      tools: [],
      phase: "attaching",
    });
    now += LEASE_MS;
    const reclaimed = await reclaimRuns({ ledger, gen: "new-bot", now: () => now });
    let checks = 0;
    const hold = createOrganizationResumeHold({
      ledger,
      gen: "new-bot",
      now: () => now,
      binding: async () => {
        checks++;
        return { runId: "original-run", originalStatus: "completed" };
      },
      eligible: (_run, source) => source.originalStatus !== "completed",
      refusalReason: () => "intake_completed",
      warn: () => {},
    });
    expect((await hold.select(reclaimed.resumable)).runnable).toEqual([]);
    expect((await ledger.listLive())[0]?.state.organizationResumeHold).toMatchObject({ reason: "intake_completed" });
    expect((await hold.retry()).runnable).toEqual([]);
    expect(checks).toBe(1);

    now += LEASE_MS;
    await ledger.reclaim("third-bot", now, LEASE_MS);
    expect((await hold.retry()).runnable).toEqual([]);
    expect(hold.pendingRows()).toEqual([]);
    expect((await ledger.listLive())[0]?.ownerGen).toBe("third-bot");
  });

  it("holds a stop that arrives while original source proof is in flight", async () => {
    let now = 1_000;
    const ledger = new InMemoryRunLedger(() => now);
    await ledger.claim({
      runId: "original-run",
      threadKey: "web:thread",
      gen: "old-bot",
      leaseMs: LEASE_MS,
      startedAt: now,
      meta: {
        channelId: "web:channel",
        userId: "access:user",
        threadKey: "web:thread",
        agent: "review",
        organizationIngressRunId: "original-run",
        request: { text: "review the pull request" },
      },
      card: null,
      system: "",
      tools: [],
      phase: "attaching",
    });
    now += LEASE_MS;
    const reclaimed = await reclaimRuns({ ledger, gen: "new-bot", now: () => now });
    let finishCheck!: (source: { runId: string }) => void;
    const sourceCheck = new Promise<{ runId: string }>((resolve) => (finishCheck = resolve));
    const hold = createOrganizationResumeHold({
      ledger,
      gen: "new-bot",
      now: () => now,
      binding: () => sourceCheck,
      eligible: (run, source) => run.row.runId === source.runId,
      refusalReason: () => "source_ineligible",
      warn: () => {},
    });
    const selection = hold.select(reclaimed.resumable);
    await ledger.requestStop("original-run", "hard");
    finishCheck({ runId: "original-run" });
    expect((await selection).runnable).toEqual([]);
    expect((await ledger.listLive())[0]).toMatchObject({
      stop: "hard",
      state: { organizationResumeHold: { reason: "stop_pending", status: "held" } },
    });
  });
});
