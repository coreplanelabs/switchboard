import { sourceHash } from "../../src/core/references/receipts.ts";
import {
  pullOwnerQualificationSnapshot,
  qualifyPullOwnerSnapshot,
} from "../../src/core/coordinator/pullOwnerQualification.ts";
import { sessionSeed } from "../../src/core/dispatch/seed.ts";
import type { ChatMessage } from "../../src/core/chatMessage.ts";
import {
  buildExpectedSeedManifest,
  encodeExpectedSeedHeader,
  EXPECTED_SEED_HEADER,
} from "../../src/core/runLedger/seedManifest.ts";
import { MAX_RECORD_BYTES } from "../../src/core/runRecord.ts";
import { turnRows } from "../../src/core/runLedger/transcript.ts";
import { getAgent } from "../../src/agents/registry.ts";
import { originalColdAllocation, workspaceDurabilityKey } from "../../src/core/runLedger/workspaceDurability.ts";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { fetchMemoryTest } from "./testFetch.ts";
import { describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../src/core/runRecord.ts";
import { FRICTION_CATEGORIES } from "../../src/core/runFriction.ts";
import { LEASE_MS } from "../../src/core/runLedger/types.ts";
import type { CoordinatorInstance, CoordinatorUnit } from "../../src/core/coordinator/contract.ts";
import {
  checkpointKey,
  type PublicationBinding,
  type PublicationSettlement,
} from "../../src/core/publicationSettlement.ts";
import { PRIVATE_WORKER_REPLY_MAX_CHARS } from "../../src/core/privateWorkerLog.ts";
import { assertNoPendingBackgroundTasks } from "./backgroundTasks.ts";
import memoryWorker, { type RunHistoryDO, type SessionLogDO } from "./worker.ts";
import {
  coordinatorReportAdmission,
  freezeAdmittedCoordinatorReport,
} from "../../src/core/coordinator/reportContext.ts";
import {
  appendCoordinatorPublicDelivery,
  coordinatorPublicDeliveryReference,
} from "../../src/core/coordinator/reportPublicDelivery.ts";
import { appendCoordinatorStatus } from "../../src/core/coordinator/unitStatus.ts";
import type { ContextDependencies } from "../../src/core/references/contextDependencies.ts";
import type { IntakeReceipt } from "../../src/core/runLedger/types.ts";
import type { RunMetricsPoint } from "../../src/core/runMetrics.ts";
import { historicalNativeChain } from "../../src/core/coordinator/historicalNativeAudit.ts";
import { messageFromInbox } from "../../src/core/runLedger/inboxMessage.ts";
import type { WorkspaceAllocation } from "../../src/core/runLedger/workspaceDurability.ts";
import type { ClaimRequest } from "../../src/core/runLedger/types.ts";
import type { RunEvent } from "../../src/core/runEvents.ts";
import { WorkerRunLedger } from "../../src/core/runLedgerWorker.ts";
import { createCheckExecution } from "../../src/core/checkExecution.ts";
import type { LiveRunRow } from "../../src/core/runLedger/types.ts";
import type { StoredWorkspaceCustody } from "../../src/core/runLedger/workspaceDurability.ts";
import { appendRunReport } from "../../src/core/runLedger/threadSession.ts";
import { contextThreadSessionKey } from "../../src/core/runLedger/sessionLog.ts";
import { UNKNOWN_CONTEXT_DEPENDENCIES } from "../../src/core/references/contextDependencies.ts";
import { markdownOutput } from "../../src/core/llmOutput/markdown.ts";
import { createLedgerWriteThrough } from "../../src/core/runLedger/writeThrough.ts";
import { UnknownAllocationClaimError } from "../../src/core/runLedger/allocationAck.ts";
import { PROMOTION_BODY_BYTES, promotionBytes, promotionBodyOf } from "../../src/core/runLedger/promotion.ts";
import { deployRegistrationState } from "../cloudflare-resident/runRegistration.ts";
import { STATE_WRITE_DIAGNOSTIC_HEADER } from "../../src/core/runStateWriteDiagnostic.ts";
import { storeRequestWitness } from "../../src/core/storeResponse.ts";

// The check producer imports the unused LocalExecutor environment helper.
// Workerd has no host secret manifest; no local execution uses this stub.
vi.mock("../../src/secrets.ts", () => ({ publicEnv: () => ({}) }));

describe("original workspace durability in real SQLite", () => {
  const id = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  const thread = "mcp:fixture:durability";
  const allocation: WorkspaceAllocation = {
    version: 1,
    kind: "exclusive-scratch",
    runId: id,
    requester: "slack:UALICE",
    threadKey: thread,
    repo: "fixture/repo",
    ref: "codex/fixture",
    headSha: "a".repeat(40),
    allocationKey: `review:${id}`,
    custody: "session-report",
  };
  function request(
    key: string,
    contract: WorkspaceAllocation | null = allocation,
    gen = "g1",
  ): { storeKey: string; run: ClaimRequest } {
    return {
      storeKey: key,
      run: {
        runId: id,
        threadKey: thread,
        gen,
        leaseMs: LEASE_MS,
        startedAt: 1,
        phase: "attaching",
        system: "",
        tools: [],
        meta: {
          agent: "review",
          channelId: "slack:C1",
          userId: allocation.requester,
          threadKey: thread,
          repo: allocation.repo,
          ref: allocation.ref,
          headSha: allocation.headSha,
          readonly: true,
          profile: { machine: "repo-resident", identity: "read", minutes: 25 },
          ...(contract ? { workspaceAllocation: contract } : {}),
        },
      },
    };
  }
  it("prepares exact original promotion bytes in SQLite and holds actual lifecycle mutations without claiming or upgrading null", async () => {
    for (const contract of [allocation, null]) {
      const key = storeKey(),
        req = request(key, contract);
      const client = new WorkerRunLedger({
        baseUrl: BASE,
        token: "test-token",
        storeKey: key,
        fetch: (input, init) => fetchMemoryTest(String(input), init),
      });
      expect(await client.claim(req.run)).toMatchObject({ ok: true });
      const originalBody = JSON.stringify({
        ...req,
        run: {
          ...req.run,
          phase: "live",
          system: "original prepared prompt",
          state: { binding: { backend: "resident", workspace: "/private/original" } },
        },
      });
      const prepared = await client.preparePromotion(originalBody);
      expect(prepared.kind).toBe("prepared");
      if (prepared.kind !== "prepared") throw new Error("prepare refused");
      expect(
        await client.readPromotion({ runId: id, gen: "g1", bodySha256: prepared.receipt.bodySha256 }),
      ).toMatchObject({ kind: "prepared", preparation: { bodyJson: originalBody } });
      expect(await client.preparePromotion(originalBody)).toEqual(prepared);
      expect(
        await client.preparePromotion(originalBody.replace("original prepared prompt", "replacement")),
      ).toMatchObject({ kind: "held" });
      await expect(client.setState(id, "g1", {})).rejects.toMatchObject({ name: "PromotionPendingError" });
      await expect(client.claim({ ...req.run, phase: "live" })).rejects.toMatchObject({
        name: "PromotionPendingError",
      });
      await expect(client.abandon(id, "g1")).rejects.toMatchObject({ name: "PromotionPendingError" });
      await expect(client.finish(id, "g1", record(id, thread))).rejects.toMatchObject({
        name: "PromotionPendingError",
      });
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner, state) => {
        const before = JSON.stringify(await owner.listLive());
        await expect(owner.setState(id, "g1", { binding: { backend: "sandbox" } })).resolves.toEqual({
          kind: "held",
          reason: "promotion_pending",
          runId: id,
        });
        await expect(owner.finishing(id, "g1")).rejects.toMatchObject({ name: "PromotionPendingError" });
        await expect(owner.abandon(id, "g1")).rejects.toMatchObject({ name: "PromotionPendingError" });
        await expect(owner.finish(id, "g1", record(id, thread))).rejects.toMatchObject({
          name: "PromotionPendingError",
        });
        expect(await owner.handoff("g1", [id], true)).toEqual({ marked: [] });
        expect(await owner.reclaim("g2", 100_000, 30_000)).toEqual([]);
        expect(JSON.stringify(await owner.listLive())).toBe(before);
        const raw = state.storage.sql
          .exec<{ allocation_json: string }>(
            "SELECT allocation_json FROM workspace_settlements WHERE allocation_json IS NOT NULL",
          )
          .one();
        expect(JSON.parse(raw.allocation_json)).toMatchObject({
          allocation: contract,
          promotion: { bodyJson: originalBody },
        });
        const corrupt = { ...JSON.parse(raw.allocation_json), promotion: { privateBytes: "unreadable original" } };
        state.storage.sql.exec(
          "UPDATE workspace_settlements SET allocation_json = ? WHERE allocation_json IS NOT NULL",
          JSON.stringify(corrupt),
        );
        await expect(owner.setState(id, "g1", {})).resolves.toEqual({
          kind: "held",
          reason: "promotion_pending",
          runId: id,
        });
        await expect(owner.abandon(id, "g1")).rejects.toMatchObject({ name: "PromotionPendingError" });
        expect(JSON.stringify(await owner.listLive())).toBe(before);
        expect(
          state.storage.sql
            .exec<{ allocation_json: string }>(
              "SELECT allocation_json FROM workspace_settlements WHERE allocation_json IS NOT NULL",
            )
            .one().allocation_json,
        ).toBe(JSON.stringify(corrupt));
      });
      await expect(client.abandon(id, "g1")).rejects.toMatchObject({
        name: "PromotionPendingError",
        reason: "corrupt",
      });
    }
  });
  it("accepts the full original 512KiB prepare body over HTTP and refuses the next byte without mutation", async () => {
    const key = storeKey(),
      req = request(key, null);
    expect((await post("/runs/claim", req)).status).toBe(200);
    const envelope = { ...req, run: { ...req.run, phase: "live", system: "" } };
    envelope.run.system = "x".repeat(PROMOTION_BODY_BYTES - promotionBytes(JSON.stringify(envelope)));
    const body = JSON.stringify(envelope);
    expect(promotionBytes(body)).toBe(PROMOTION_BODY_BYTES);
    const client = new WorkerRunLedger({
      baseUrl: BASE,
      token: "test-token",
      storeKey: key,
      fetch: (input, init) => fetchMemoryTest(String(input), init),
    });
    expect(await client.preparePromotion(body)).toMatchObject({ kind: "prepared" });
    const tooLarge = await fetchMemoryTest(`${BASE}/runs/promotion/prepare`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: body + " ",
    });
    expect(tooLarge.status).toBe(413);
    expect(await client.readPromotion({ runId: id, gen: "g1" })).toMatchObject({
      kind: "prepared",
      preparation: { bodyJson: body },
    });
    expect(await client.claim(promotionBodyOf(body)!, body)).toMatchObject({
      ok: true,
      promotionCommit: { phase: "unconfirmed" },
    });
    expect(await client.readPromotion({ runId: id, gen: "g1" })).toMatchObject({
      kind: "committed",
      preparation: { bodyJson: body },
    });
    await expect(client.abandon(id, "g1")).rejects.toMatchObject({ name: "PromotionPendingError" });
  });
  it("reads a real committed prepare after lost HTTP acknowledgment through a new client without repeating prepare", async () => {
    const key = storeKey(),
      req = request(key, null);
    expect((await post("/runs/claim", req)).status).toBe(200);
    let calls = 0;
    const client = new WorkerRunLedger({
      baseUrl: BASE,
      token: "test-token",
      storeKey: key,
      fetch: async (input, init) => {
        const actual = await fetchMemoryTest(String(input), init);
        if (String(input).endsWith("/prepare")) {
          calls++;
          expect(actual.status).toBe(200);
          throw new Error("actual prepare ACK lost");
        }
        return actual;
      },
    });
    const originalBody = JSON.stringify({ ...req, run: { ...req.run, phase: "live" } });
    expect(await client.preparePromotion(originalBody)).toEqual({ kind: "held", reason: "unknown" });
    const restartedClient = new WorkerRunLedger({
      baseUrl: BASE,
      token: "test-token",
      storeKey: key,
      fetch: (input, init) => fetchMemoryTest(String(input), init),
    });
    expect(await restartedClient.readPromotion({ runId: id, gen: "g1" })).toMatchObject({
      kind: "prepared",
      preparation: { bodyJson: originalBody },
    });
    expect(calls).toBe(1);
  });
  it.each([false, true])(
    "commits actual SQLite prepared originals once through HTTP and reads lost replies while keeping custody held: allocated=%s",
    async (allocated) => {
      const key = storeKey(),
        req = request(key, null);
      req.run.meta.pr = 42;
      if (allocated)
        req.run.meta.workspaceAllocation = originalColdAllocation({
          runId: id,
          identity: req.run.meta,
          registered: getAgent("review"),
          target: { repo: allocation.repo!, ref: allocation.ref!, headSha: allocation.headSha!, pr: 42 },
        });
      expect((await post("/runs/claim", req)).status).toBe(200);
      const wire = JSON.stringify({
        ...req,
        run: {
          ...req.run,
          phase: "live",
          system: "original raw prepared commit",
          state: { binding: { backend: "resident", workspace: "/private/original-commit" } },
        },
      });
      let claims = 0;
      const client = new WorkerRunLedger({
        baseUrl: BASE,
        token: "test-token",
        storeKey: key,
        fetch: async (input, init) => {
          const response = await fetchMemoryTest(String(input), init);
          if (String(input).endsWith("/runs/claim")) {
            claims++;
            expect(response.status).toBe(200);
            await response.json();
            throw new Error("actual claim response lost");
          }
          return response;
        },
      });
      expect(await client.preparePromotion(wire)).toMatchObject({ kind: "prepared" });
      await expect(client.claim(promotionBodyOf(wire)!, wire)).rejects.toMatchObject({
        name: "UnknownAllocationClaimError",
      });
      const restarted = new WorkerRunLedger({
        baseUrl: BASE,
        token: "test-token",
        storeKey: key,
        fetch: (input, init) => fetchMemoryTest(String(input), init),
      });
      const saved = await restarted.readPromotion({ runId: id, gen: "g1" });
      expect(saved).toMatchObject({
        kind: "committed",
        preparation: { bodyJson: wire },
        receipt: { phase: "unconfirmed" },
        allocationAck: { allocation: req.run.meta.workspaceAllocation ?? null },
      });
      const before = await post("/runs/live", { storeKey: key });
      expect(await client.claim(promotionBodyOf(wire)!, wire)).toMatchObject({
        ok: true,
        promotionCommit: { phase: "unconfirmed" },
      });
      expect(claims).toBe(1);
      const duplicate = await fetchMemoryTest(`${BASE}/runs/claim`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: wire,
      });
      expect(duplicate.status).toBe(200);
      const duplicateBody = await duplicate.json();
      expect(duplicateBody).toMatchObject({
        ok: true,
        promotionCommit: saved.kind === "committed" ? saved.receipt : undefined,
      });
      expect(await post("/runs/live", { storeKey: key })).toEqual(before);
      await expect(restarted.setState(id, "g1", {})).rejects.toMatchObject({ name: "PromotionPendingError" });
      await expect(restarted.finish(id, "g1", record(id, thread))).rejects.toMatchObject({
        name: "PromotionPendingError",
      });
      await expect(restarted.abandon(id, "g1")).rejects.toMatchObject({ name: "PromotionPendingError" });
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner, state) => {
        expect(await owner.reclaim("g2", 100_000, 30_000)).toEqual([]);
        expect(await owner.handoff("g1", [id], true)).toEqual({ marked: [] });
        const actual = state.storage.sql
          .exec<{ allocation_json: string }>(
            "SELECT allocation_json FROM workspace_settlements WHERE owner_key = ? AND revision = 1",
            workspaceDurabilityKey(id),
          )
          .one();
        expect(JSON.parse(actual.allocation_json)).toMatchObject({
          promotion: { bodyJson: wire },
          promotionCommit: saved.kind === "committed" ? saved.receipt : undefined,
          allocation: req.run.meta.workspaceAllocation ?? null,
        });
      });
    },
  );
  it.each(["actor", "target", "body", "gen", "start", "revision", "digest", "corrupt"])(
    "holds actual SQLite prepared commit conflicts before effect: %s",
    async (mode) => {
      const key = storeKey(),
        req = request(key, null);
      expect((await post("/runs/claim", req)).status).toBe(200);
      const run = { ...req.run, phase: "live" as const, system: "immutable original" },
        wire = JSON.stringify({ ...req, run });
      const client = new WorkerRunLedger({
        baseUrl: BASE,
        token: "test-token",
        storeKey: key,
        fetch: (input, init) => fetchMemoryTest(String(input), init),
      });
      expect(await client.preparePromotion(wire)).toMatchObject({ kind: "prepared" });
      if (["revision", "digest", "corrupt"].includes(mode))
        await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner, state) => {
          const row = state.storage.sql
            .exec<{ allocation_json: string }>(
              "SELECT allocation_json FROM workspace_settlements WHERE owner_key = ?",
              workspaceDurabilityKey(id),
            )
            .one();
          const raw = JSON.parse(row.allocation_json);
          if (mode === "revision")
            state.storage.sql.exec(
              "UPDATE workspace_settlements SET revision = 2 WHERE owner_key = ?",
              workspaceDurabilityKey(id),
            );
          else {
            if (mode === "digest") raw.promotion.receipt.bodySha256 = "b".repeat(64);
            else raw.promotion.unexpected = true;
            state.storage.sql.exec(
              "UPDATE workspace_settlements SET allocation_json = ? WHERE owner_key = ?",
              JSON.stringify(raw),
              workspaceDurabilityKey(id),
            );
          }
        });
      if (mode === "actor") run.meta = { ...run.meta, userId: "slack:OTHER" };
      if (mode === "target") run.meta = { ...run.meta, ref: "codex/rival" };
      if (mode === "gen") run.gen = "g2";
      if (mode === "start") run.startedAt = 2;
      const archiveBefore = await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner, state) =>
        state.storage.sql
          .exec<{ revision: number; allocation_json: string }>(
            "SELECT revision,allocation_json FROM workspace_settlements WHERE owner_key = ?",
            workspaceDurabilityKey(id),
          )
          .toArray(),
      );
      const before = await post("/runs/live", { storeKey: key });
      const result = await fetchMemoryTest(`${BASE}/runs/claim`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: mode === "body" ? wire + " " : JSON.stringify({ ...req, run }),
      });
      expect(result.status).toBe(mode === "gen" ? 409 : 423);
      await result.json();
      expect(await post("/runs/live", { storeKey: key })).toEqual(before);
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner, state) => {
        expect(
          state.storage.sql
            .exec<{ revision: number; allocation_json: string }>(
              "SELECT revision,allocation_json FROM workspace_settlements WHERE owner_key = ?",
              workspaceDurabilityKey(id),
            )
            .toArray(),
        ).toEqual(archiveBefore);
      });
    },
  );
  it("stores expected seed with full512KiB original body and reads actual lost prepare reply without reissuing", async () => {
    const key = storeKey(),
      req = request(key, null);
    req.run.meta.session = {
      key: "task:fixture:expected",
      threadSession: "task:fixture:@thread",
      seedFrom: 4,
      request: 5,
      range: { from: 5 },
    };
    expect((await post("/runs/claim", req)).status).toBe(200);
    const envelope = { ...req, run: { ...req.run, phase: "live" as const, system: "" } };
    envelope.run.system = "x".repeat(PROMOTION_BODY_BYTES - promotionBytes(JSON.stringify(envelope)));
    const wire = JSON.stringify(envelope);
    expect(promotionBytes(wire)).toBe(PROMOTION_BODY_BYTES);
    const messages = [
        { role: "user" as const, content: [{ type: "text" as const, text: "original reused source" }] },
        { role: "user" as const, content: [{ type: "text" as const, text: "original fresh input" }] },
      ],
      prior = turnRows(4, messages[0], {}, "slack:UALICE");
    const built = await buildExpectedSeedManifest({
      bodyJson: wire,
      open: {
        runId: id,
        threadKey: thread,
        startedAt: 1,
        system: envelope.run.system,
        seed: {
          messages,
          actors: ["slack:UALICE", "slack:UALICE"],
          context: UNKNOWN_CONTEXT_DEPENDENCIES,
          notepad: "complete original notes",
          budgetMs: 1_500_000,
          log: { from: 4, turns: 1 },
        },
      },
      observation: {
        key: "task:fixture:expected",
        next: 5,
        reused: {
          key: "task:fixture:expected",
          from: 4,
          through: 4,
          next: 5,
          rows: prior.rows,
          attachments: prior.attachments,
          context: UNKNOWN_CONTEXT_DEPENDENCIES,
          notepad: "complete original notes",
          owner: { runId: id, gen: "g1" },
        },
      },
    });
    if (built.kind !== "built") throw new Error("complete seed refused");
    let prepares = 0;
    const client = new WorkerRunLedger({
      baseUrl: BASE,
      token: "test-token",
      storeKey: key,
      fetch: async (input, init) => {
        const actual = await fetchMemoryTest(String(input), init);
        if (String(input).endsWith("/prepare")) {
          prepares++;
          expect(actual.status).toBe(200);
          await actual.json();
          throw new Error("actual prepare reply lost");
        }
        return actual;
      },
    });
    expect(await client.preparePromotion(wire, built.manifest)).toEqual({ kind: "held", reason: "unknown" });
    const restarted = new WorkerRunLedger({
      baseUrl: BASE,
      token: "test-token",
      storeKey: key,
      fetch: (input, init) => fetchMemoryTest(String(input), init),
    });
    expect(await restarted.readPromotion({ runId: id, gen: "g1" })).toMatchObject({
      kind: "prepared",
      preparation: { bodyJson: wire, expectedSeed: built.manifest, receipt: { expectedSeedSha256: built.digest } },
    });
    expect(prepares).toBe(1);
    expect(await restarted.claim(promotionBodyOf(wire)!, wire)).toMatchObject({
      ok: true,
      promotionCommit: { phase: "unconfirmed", expectedSeedSha256: built.digest },
    });
    await expect(restarted.abandon(id, "g1")).rejects.toMatchObject({ name: "PromotionPendingError" });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner, state) => {
      const raw = state.storage.sql
        .exec<{ allocation_json: string }>(
          "SELECT allocation_json FROM workspace_settlements WHERE owner_key = ?",
          workspaceDurabilityKey(id),
        )
        .one().allocation_json;
      expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(MAX_RECORD_BYTES);
      expect(JSON.parse(raw)).toMatchObject({
        promotion: { bodyJson: wire, expectedSeed: built.manifest },
        promotionCommit: { expectedSeedSha256: built.digest },
      });
    });
    const over = await fetchMemoryTest(`${BASE}/runs/promotion/prepare`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
        [EXPECTED_SEED_HEADER]: encodeExpectedSeedHeader(built.manifest),
      },
      body: wire + " ",
    });
    expect(over.status).toBe(413);
    await over.json();
  });
  it.each(["malformed", "nonascii", "duplicate", "foreign"])(
    "refuses invalid expected seed header before actualSQLite mutation: %s",
    async (mode) => {
      const key = storeKey(),
        req = request(key, null);
      req.run.meta.session = {
        key: "task:fixture:expected",
        threadSession: "task:fixture:@thread",
        seedFrom: 0,
        request: 0,
        range: { from: 0 },
      };
      expect((await post("/runs/claim", req)).status).toBe(200);
      const wire = JSON.stringify({ ...req, run: { ...req.run, phase: "live", system: "actual system" } });
      const built = await buildExpectedSeedManifest({
        bodyJson: wire,
        open: {
          runId: id,
          threadKey: thread,
          startedAt: 1,
          system: "actual system",
          seed: {
            messages: [{ role: "user", content: [{ type: "text", text: "original request" }] }],
            actors: ["slack:UALICE"],
            context: UNKNOWN_CONTEXT_DEPENDENCIES,
            notepad: "",
            budgetMs: 1_500_000,
          },
        },
        observation: { key: "task:fixture:expected", next: 0 },
      });
      if (built.kind !== "built") throw new Error("fixture refused");
      const headers = new Headers({ authorization: "Bearer test-token", "content-type": "application/json" });
      let value = encodeExpectedSeedHeader(built.manifest);
      if (mode === "malformed") value = "%%";
      if (mode === "nonascii") value = "é";
      if (mode === "foreign") value = encodeExpectedSeedHeader({ ...built.manifest, requester: "slack:OTHER" });
      headers.set(EXPECTED_SEED_HEADER, value);
      if (mode === "duplicate") headers.append(EXPECTED_SEED_HEADER, value);
      const result = await fetchMemoryTest(`${BASE}/runs/promotion/prepare`, { method: "POST", headers, body: wire });
      expect(result.status).toBe(mode === "foreign" ? 200 : 400);
      const reply = await result.json();
      if (mode === "foreign") expect(reply).toMatchObject({ kind: "held", reason: "mismatch" });
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner, state) => {
        expect((await owner.listLive())[0].phase).toBe("attaching");
        const raw = state.storage.sql
          .exec<{ allocation_json: string }>(
            "SELECT allocation_json FROM workspace_settlements WHERE owner_key = ?",
            workspaceDurabilityKey(id),
          )
          .one().allocation_json;
        expect(JSON.parse(raw)).not.toHaveProperty("promotion");
      });
    },
  );
  async function originalSourceFixture() {
    const sk = storeKey(),
      req = request(sk, null),
      sessionKey = "task:source-verification:" + sk;
    req.run.meta.session = {
      key: sessionKey,
      threadSession: "task:fixture:@thread",
      seedFrom: 0,
      request: 0,
      range: { from: 0 },
    };
    const wire = JSON.stringify({ ...req, run: { ...req.run, phase: "live", system: "actual source system" } }),
      messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "original source input" }] }];
    const built = await buildExpectedSeedManifest({
      bodyJson: wire,
      open: {
        runId: id,
        threadKey: thread,
        startedAt: 1,
        system: "actual source system",
        seed: {
          messages,
          actors: ["slack:UALICE"],
          context: UNKNOWN_CONTEXT_DEPENDENCIES,
          notepad: "original source notes",
          budgetMs: 1_500_000,
        },
      },
      observation: { key: sessionKey, next: 0 },
    });
    if (built.kind !== "built") throw new Error("fixture refused");
    const client = new WorkerRunLedger({
      baseUrl: BASE,
      token: "test-token",
      storeKey: sk,
      fetch: (input, init) => fetchMemoryTest(String(input), init),
    });
    expect(await client.claim(req.run)).toMatchObject({ ok: true });
    expect(await client.preparePromotion(wire, built.manifest)).toMatchObject({ kind: "prepared" });
    expect(await client.claim(promotionBodyOf(wire)!, wire)).toMatchObject({ ok: true });
    await client.claimSession(sessionKey, id, "g1");
    expect(
      await client.writeSessionSources(sessionKey, id, "g1", {
        version: 1,
        status: "unknown",
        context: UNKNOWN_CONTEXT_DEPENDENCIES,
      }),
    ).toEqual({ ok: true });
    expect(await client.writeNotepad(sessionKey, "g1", "original source notes", id)).toEqual({ ok: true });
    expect(await client.seed(id, "g1", [{ idx: 0, message: messages[0], actor: "slack:UALICE" }], sessionKey)).toEqual({
      ok: true,
    });
    const reference = {
      storeKey: sk,
      runId: id,
      gen: "g1",
      bodySha256: built.manifest.bodySha256,
      expectedSeedSha256: built.digest,
    };
    return { client, reference, sessionKey, sk, messages, built };
  }
  it("commits actual source verification receipt and pending holder through HTTP, refusing source mutations and newer-revision removal", async () => {
    const { client, reference, sessionKey, messages } = await originalSourceFixture();
    const verified = await client.verifyExpectedSeed(sessionKey, reference);
    expect(verified).toMatchObject({
      kind: "verified",
      receipt: { phase: "pending-confirmation", key: sessionKey, runId: id, gen: "g1", count: 1 },
    });
    expect(await client.readExpectedSeed(sessionKey, reference)).toEqual(verified);
    await expect(client.claimSession(sessionKey, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", "g2")).rejects.toMatchObject({
      name: "SourceSeedPendingError",
    });
    await expect(client.writeNotepad(sessionKey, "g1", "foreign notes", id)).rejects.toMatchObject({
      name: "SourceSeedPendingError",
    });
    await expect(
      client.seed(
        id,
        "g1",
        [
          {
            idx: 0,
            message: { role: "user", content: [{ type: "text", text: "foreign source" }] },
            actor: "slack:UALICE",
          },
        ],
        sessionKey,
      ),
    ).rejects.toMatchObject({ name: "SourceSeedPendingError" });
    await expect(client.releaseSession(sessionKey, id, "g1")).rejects.toMatchObject({ name: "SourceSeedPendingError" });
    await runInDurableObject(
      env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)),
      async (owner: SessionLogDO, state) => {
        const revision = await owner.custodyPinRevision();
        expect(revision?.guarded).toBe(true);
        expect(await owner.retainRangePinsIfRevision(revision!, [])).toMatchObject({ ok: true });
        const newer = await owner.custodyPinRevision();
        expect(newer!.revision).toBeGreaterThan(revision!.revision);
        expect(await owner.retainRangePinsIfRevision(newer!, [])).toMatchObject({ ok: true });
        expect(
          JSON.parse(
            state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='range_pins'").one().value,
          )[id],
        ).toContainEqual({ from: 0, to: 0 });
        await expect(owner.drop()).rejects.toMatchObject({ name: "SourceSeedPendingError" });
      },
    );
    expect(await client.readExpectedSeed(sessionKey, reference)).toEqual(verified);
    expect(await client.seed(id, "g1", [{ idx: 0, message: messages[0], actor: "slack:UALICE" }], sessionKey)).toEqual({
      ok: true,
    });
    expect(await client.writeNotepad(sessionKey, "g1", "original source notes", id)).toEqual({ ok: true });
  });
  it.each(["body", "manifest", "store", "key", "trimmed", "context", "owner"])(
    "declines foreign or incomplete actual source before installing a receipt: %s",
    async (mode) => {
      const { client, reference, sessionKey } = await originalSourceFixture();
      let target = sessionKey;
      const ref = { ...reference };
      if (mode === "body") ref.bodySha256 = "b".repeat(64);
      if (mode === "manifest") ref.expectedSeedSha256 = "b".repeat(64);
      if (mode === "store") ref.storeKey = "runs:foreign";
      if (mode === "key") target = "task:foreign";
      if (["trimmed", "context", "owner"].includes(mode))
        await runInDurableObject(
          env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)),
          async (_owner, state) => {
            if (mode === "trimmed") state.storage.sql.exec("UPDATE turns SET trimmed=1");
            if (mode === "context")
              state.storage.sql.exec(
                "UPDATE meta SET value=? WHERE key='sources'",
                JSON.stringify({
                  version: 1,
                  status: "unknown",
                  context: { ...UNKNOWN_CONTEXT_DEPENDENCIES, revision: 1 },
                }),
              );
            if (mode === "owner") state.storage.sql.exec("UPDATE owner SET gen='foreign-generation'");
          },
        );
      expect(await client.verifyExpectedSeed(target, ref)).toMatchObject({ kind: "held" });
      await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)), async (_owner, state) => {
        expect(state.storage.sql.exec("SELECT value FROM meta WHERE key='expected_seed_pending'").toArray()).toEqual(
          [],
        );
      });
    },
  );
  it("real source changes during hashing refuse the source-own transaction and install no hold", async () => {
    const { reference, sessionKey } = await originalSourceFixture();
    const stub = env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey));
    await runInDurableObject(stub, async (owner: SessionLogDO, state) => {
      const internal = owner as unknown as { sourceSeedSnapshot: (from: number, to: number) => unknown };
      const original = internal.sourceSeedSnapshot.bind(owner);
      let reads = 0;
      internal.sourceSeedSnapshot = (...args) => {
        const value = original(...args);
        if (++reads === 1) state.storage.sql.exec("UPDATE notepad SET text='changed between hash and commit'");
        return value;
      };
      expect(await owner.verifyExpectedSeed(sessionKey, reference)).toMatchObject({ kind: "held" });
      internal.sourceSeedSnapshot = original;
      expect(state.storage.sql.exec("SELECT value FROM meta WHERE key='expected_seed_pending'").toArray()).toEqual([]);
    });
  });
  async function confirmationFixture() {
    const f = await originalSourceFixture();
    expect(
      await f.client.step(
        id,
        "g1",
        {
          step: 0,
          seq: 0,
          turnIndex: 1,
          inFlight: [],
          inboxConsumedSeq: 0,
          remainingMs: 1500000,
          turn: 0,
          iteration: 0,
        },
        [],
        f.sessionKey,
      ),
    ).toEqual({ ok: true });
    expect(await f.client.verifyExpectedSeed(f.sessionKey, f.reference)).toMatchObject({ kind: "verified" });
    return f;
  }
  it("confirms actual SQLite seed custody while the original owner heartbeat renews only liveness", async () => {
    const { client, reference, sessionKey, sk } = await confirmationFixture();
    const prepared = await client.readPromotion({ runId: id, gen: "g1" });
    const source = await client.readExpectedSeed(sessionKey, reference);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(sk)), async (owner) => {
      const before = structuredClone((await owner.listLive())[0]);
      const internal = owner as unknown as { confirmationSnapshot: (run: string) => { row: LiveRunRow } };
      const snapshot = internal.confirmationSnapshot.bind(owner);
      let heartbeat: ReturnType<RunHistoryDO["heartbeat"]> | undefined;
      let snapshots = 0;
      internal.confirmationSnapshot = (run) => {
        const value = snapshot(run);
        if (++snapshots === 1)
          heartbeat = owner.heartbeat(id, "g1", LEASE_MS, value.row.leaseUntil - LEASE_MS + 10_000);
        return value;
      };
      let confirmation;
      try {
        confirmation = await owner.confirmPromotion(reference);
      } finally {
        internal.confirmationSnapshot = snapshot;
      }
      expect(await heartbeat).toMatchObject({ ok: true });
      expect(confirmation.kind).toBe("confirmed");
      const after = (await owner.listLive())[0];
      expect(after.leaseUntil).toBe(before.leaseUntil + 10_000);
      expect({ ...after, leaseUntil: before.leaseUntil }).toEqual(before);
    });
    const confirmed = await client.readPromotion({ runId: id, gen: "g1" });
    if (prepared.kind !== "committed" || confirmed.kind !== "confirmed")
      throw new Error("original confirmation required");
    expect(confirmed.preparation).toEqual(prepared.preparation);
    expect(confirmed.commit).toEqual(prepared.receipt);
    expect(await client.readExpectedSeed(sessionKey, reference)).toEqual(source);
    await expect(client.writeNotepad(sessionKey, "g1", "changed", id)).rejects.toMatchObject({
      name: "SourceSeedPendingError",
    });
  });
  it.each(["owner", "stop", "state", "system", "seed", "step", "meta", "archive", "budget"] as const)(
    "keeps actual concurrent SQLite %s drift held during an owner heartbeat",
    async (mode) => {
      const { client, reference, sessionKey, sk } = await confirmationFixture();
      const source = await client.readExpectedSeed(sessionKey, reference);
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(sk)), async (owner, state) => {
        const internal = owner as unknown as { confirmationSnapshot: (run: string) => { row: LiveRunRow } };
        const snapshot = internal.confirmationSnapshot.bind(owner);
        let heartbeat: ReturnType<RunHistoryDO["heartbeat"]> | undefined;
        let snapshots = 0;
        internal.confirmationSnapshot = (run) => {
          const value = snapshot(run);
          if (++snapshots === 1) {
            heartbeat = owner.heartbeat(id, "g1", LEASE_MS, value.row.leaseUntil - LEASE_MS + 10_000);
            if (mode === "owner")
              state.storage.sql.exec("UPDATE live_runs SET owner_gen='foreign-owner' WHERE run_id=?", id);
            if (mode === "stop") state.storage.sql.exec("UPDATE live_runs SET stop='hard' WHERE run_id=?", id);
            if (mode === "system")
              state.storage.sql.exec("UPDATE live_runs SET system_text='foreign system' WHERE run_id=?", id);
            if (mode === "state")
              state.storage.sql.exec(
                "UPDATE live_runs SET state_json=json_set(state_json,'$.semanticChange',true) WHERE run_id=?",
                id,
              );
            if (mode === "meta")
              state.storage.sql.exec(
                "UPDATE live_runs SET meta_json=json_set(meta_json,'$.channelId','mcp:foreign') WHERE run_id=?",
                id,
              );
            if (mode === "budget")
              state.storage.sql.exec(
                "UPDATE live_runs SET meta_json=json_set(meta_json,'$.profile.minutes',24) WHERE run_id=?",
                id,
              );
            if (mode === "seed")
              state.storage.sql.exec(
                "UPDATE run_steps SET json=json_set(json,'$.turnIndex',2) WHERE run_id=? AND step=0",
                id,
              );
            if (mode === "step")
              state.storage.sql.exec(
                "INSERT INTO run_steps(run_id,step,json) SELECT run_id,1,json_set(json,'$.step',1) FROM run_steps WHERE run_id=? AND step=0",
                id,
              );
            if (mode === "archive")
              state.storage.sql.exec(
                "UPDATE workspace_settlements SET allocation_json=json_set(allocation_json,'$.startedAt',2) WHERE owner_key=?",
                workspaceDurabilityKey(id),
              );
          }
          return value;
        };
        try {
          expect(await owner.confirmPromotion(reference)).toMatchObject({ kind: "held", reason: "mismatch" });
          expect(await heartbeat).toMatchObject({ ok: true });
        } finally {
          internal.confirmationSnapshot = snapshot;
        }
        const archive = JSON.parse(
          state.storage.sql
            .exec<{ allocation_json: string }>(
              "SELECT allocation_json FROM workspace_settlements WHERE owner_key=?",
              workspaceDurabilityKey(id),
            )
            .one().allocation_json,
        );
        expect(archive).not.toHaveProperty("promotionConfirmation");
      });
      await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)), async (_owner, state) => {
        expect(state.storage.sql.exec("SELECT value FROM meta WHERE key='expected_seed_release'").toArray()).toEqual(
          [],
        );
        const pending = JSON.parse(
          state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='expected_seed_pending'").one()
            .value,
        );
        expect(pending).toEqual(source.kind === "verified" ? source.receipt : null);
      });
      await expect(client.writeNotepad(sessionKey, "g1", "changed", id)).rejects.toMatchObject({
        name: "SourceSeedPendingError",
      });
    },
  );
  it("real HTTP confirmation and release retain exact immutable receipts across lost replies and new clients", async () => {
    const { client, reference, sessionKey, sk } = await confirmationFixture();
    let confirms = 0,
      releases = 0;
    const lost = new WorkerRunLedger({
      baseUrl: BASE,
      token: "test-token",
      storeKey: sk,
      fetch: async (input, init) => {
        const response = await fetchMemoryTest(String(input), init),
          body = JSON.parse(String(init?.body));
        if (body.confirm) {
          confirms++;
          expect(response.status).toBe(200);
          throw new Error("actual confirmation committed reply lost");
        }
        if (body.release) {
          releases++;
          expect(response.status).toBe(200);
          throw new Error("actual release committed reply lost");
        }
        return response;
      },
    });
    expect(await lost.confirmPromotion(reference)).toMatchObject({ kind: "held", reason: "unknown" });
    const confirmation = await client.readPromotion({ runId: id, gen: "g1" });
    expect(confirmation).toMatchObject({ kind: "confirmed", receipt: { phase: "confirmed" } });
    await expect(client.writeNotepad(sessionKey, "g1", "late mutation", id)).rejects.toMatchObject({
      name: "SourceSeedPendingError",
    });
    expect(await lost.releaseExpectedSeed(sessionKey, reference)).toMatchObject({ kind: "held", reason: "unknown" });
    const release = await client.readExpectedSeed(sessionKey, reference);
    expect(release).toMatchObject({ kind: "verified", release: { phase: "released" } });
    expect(await client.releaseExpectedSeed(sessionKey, reference)).toEqual(release);
    expect(await client.confirmPromotion(reference)).toMatchObject(
      confirmation.kind === "confirmed" ? { kind: "confirmed", receipt: confirmation.receipt } : {},
    );
    expect(await client.writeNotepad(sessionKey, "g1", "normal post-confirmation notes", id)).toEqual({ ok: true });
    expect(await client.readExpectedSeed(sessionKey, reference)).toEqual(release);
    await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)), async (owner, state) => {
      expect(await owner.retainRangePinsIfRevision((await owner.custodyPinRevision())!, [])).toMatchObject({
        ok: true,
      });
      expect(
        JSON.parse(
          state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='range_pins'").one().value,
        )[id],
      ).toContainEqual({ from: 0, to: 0 });
      await expect(owner.drop()).rejects.toMatchObject({ name: "SourceSeedPendingError" });
    });
    expect(confirms).toBe(1);
    expect(releases).toBe(1);
  });
  it.each([
    "system",
    "budget",
    "step0",
    "later-step",
    "flight",
    "source-owner",
    "trimmed",
    "source-gap",
    "namespace",
    "owner-generation",
  ])("actual SQLite %s conflict refuses confirmation and release without changing receipts or holder", async (mode) => {
    const { client, reference, sessionKey, sk } = await confirmationFixture();
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(sk)), async (_owner, state) => {
      if (mode === "system") state.storage.sql.exec("UPDATE live_runs SET system_text='foreign'");
      if (mode === "owner-generation") state.storage.sql.exec("UPDATE live_runs SET owner_gen='foreign'");
      if (mode === "budget" || mode === "namespace") {
        const meta = JSON.parse(
          state.storage.sql.exec<{ meta_json: string }>("SELECT meta_json FROM live_runs").one().meta_json,
        );
        if (mode === "budget") meta.profile.minutes = 24;
        else meta.channelId = "mcp:foreign";
        state.storage.sql.exec("UPDATE live_runs SET meta_json=?", JSON.stringify(meta));
      }
      if (mode === "step0") state.storage.sql.exec("DELETE FROM run_steps WHERE step=0");
      if (mode === "later-step")
        state.storage.sql.exec(
          "INSERT INTO run_steps(run_id,step,json) SELECT run_id,1,json FROM run_steps WHERE step=0",
        );
      if (mode === "flight") {
        const step = JSON.parse(
          state.storage.sql.exec<{ json: string }>("SELECT json FROM run_steps WHERE step=0").one().json,
        );
        step.inFlight = [{ callId: "foreign", tool: "bash" }];
        state.storage.sql.exec("UPDATE run_steps SET json=? WHERE step=0", JSON.stringify(step));
      }
    });
    await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)), async (_owner, state) => {
      if (mode === "source-owner") state.storage.sql.exec("UPDATE owner SET gen='foreign'");
      if (mode === "trimmed") state.storage.sql.exec("UPDATE turns SET trimmed=1");
      if (mode === "source-gap") state.storage.sql.exec("DELETE FROM turns");
    });
    expect(await client.confirmPromotion(reference)).toMatchObject({ kind: "held" });
    expect(await client.releaseExpectedSeed(sessionKey, reference)).toMatchObject({ kind: "held" });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(sk)), async (_owner, state) => {
      expect(
        JSON.parse(
          state.storage.sql
            .exec<{ allocation_json: string }>(
              "SELECT allocation_json FROM workspace_settlements WHERE allocation_json IS NOT NULL",
            )
            .one().allocation_json,
        ),
      ).not.toHaveProperty("promotionConfirmation");
    });
    await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)), async (_owner, state) => {
      expect(state.storage.sql.exec("SELECT value FROM meta WHERE key='expected_seed_release'").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT value FROM meta WHERE key='expected_seed_pending'").toArray()).toHaveLength(
        1,
      );
    });
  });
  it("Runs owning SQLite transaction rereads its actual seed boundary after source acknowledgment and hashing", async () => {
    const { reference, sk } = await confirmationFixture();
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(sk)), async (owner, state) => {
      const internal = owner as unknown as { confirmationSnapshot: (run: string) => unknown };
      const original = internal.confirmationSnapshot.bind(owner);
      let reads = 0;
      internal.confirmationSnapshot = (run) => {
        const snapshot = original(run);
        if (++reads === 1) state.storage.sql.exec("UPDATE live_runs SET system_text='changed after own snapshot'");
        return snapshot;
      };
      expect(await owner.confirmPromotion(reference)).toMatchObject({ kind: "held" });
      internal.confirmationSnapshot = original;
      expect(
        JSON.parse(
          state.storage.sql
            .exec<{ allocation_json: string }>(
              "SELECT allocation_json FROM workspace_settlements WHERE allocation_json IS NOT NULL",
            )
            .one().allocation_json,
        ),
      ).not.toHaveProperty("promotionConfirmation");
    });
  });
  it("source owning release transaction rereads its owner and data after canonical Runs confirmation", async () => {
    const { reference, sessionKey, client } = await confirmationFixture();
    expect((await client.confirmPromotion(reference)).kind).toBe("confirmed");
    await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)), async (owner, state) => {
      const internal = owner as unknown as { sourceSeedSnapshot: (from: number, to: number) => unknown };
      const original = internal.sourceSeedSnapshot.bind(owner);
      let reads = 0;
      internal.sourceSeedSnapshot = (...args) => {
        const snapshot = original(...args);
        if (++reads === 1) state.storage.sql.exec("UPDATE notepad SET text='changed after release snapshot'");
        return snapshot;
      };
      expect(await owner.releaseExpectedSeed(sessionKey, reference)).toMatchObject({ kind: "held" });
      internal.sourceSeedSnapshot = original;
      expect(state.storage.sql.exec("SELECT value FROM meta WHERE key='expected_seed_release'").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT value FROM meta WHERE key='expected_seed_pending'").toArray()).toHaveLength(
        1,
      );
    });
  });
  it("actual confirmed source pending release stays outside restart and direct terminal RPC effects", async () => {
    const { client, reference, sk } = await confirmationFixture();
    expect((await client.confirmPromotion(reference)).kind).toBe("confirmed");
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(sk)), async (owner) => {
      const original = await owner.listLive();
      expect(await owner.reclaim("gen-NEXT", 1000000, 30000)).toEqual([]);
      expect(await owner.handoff("g1", [id])).toEqual({ marked: [] });
      await expect(owner.finishing(id, "g1")).rejects.toMatchObject({ name: "PromotionPendingError" });
      await expect(owner.abandon(id, "g1")).rejects.toMatchObject({ name: "PromotionPendingError" });
      expect(await owner.listLive()).toEqual(original);
    });
  });
  it.each(["same-id", "distinct-id"])(
    "actual producer same-session %s successor has separate immutable receipt and independent source/model readiness",
    async (mode) => {
      const sk = storeKey(),
        sessionKey = "task:producer-successor:" + sk;
      const client = new WorkerRunLedger({
        baseUrl: BASE,
        token: "test-token",
        storeKey: sk,
        fetch: (input, init) => fetchMemoryTest(String(input), init),
      });
      const writer = createLedgerWriteThrough({
        ledger: client,
        gen: "g1",
        now: () => 1000,
        warn: () => {},
        fallback: { put: async () => {}, abandoned: () => {} },
        setInterval: () => ({ unref() {} }),
        clearInterval: () => {},
      });
      const originals: Array<{
        runId: string;
        ref: import("../../src/core/runLedger/seedVerification.ts").SourceSeedReference;
        source: unknown;
      }> = [];
      for (let index = 0; index < 2; index++) {
        const req = request(sk, null).run;
        req.runId = index === 0 || mode === "same-id" ? id : "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";
        req.startedAt = mode === "same-id" ? 1 : 1 + index;
        if (mode === "same-id" && index > 0) req.meta.restartOf = req.runId;
        req.system = "actual original system " + index;
        req.meta.profile!.minutes = index === 0 ? 25 : 10;
        const seed = {
          key: sessionKey,
          messages: [
            { role: "user" as const, content: [{ type: "text" as const, text: "actual original input " + index }] },
          ],
          actors: [req.meta.userId],
          budgetMs: req.meta.profile!.minutes * 60000,
          context: UNKNOWN_CONTEXT_DEPENDENCIES,
          notepad: "",
        };
        const reserved = await writer.reserve(req);
        if (reserved.kind !== "tracked") throw new Error("fixture reservation refused");
        const opened = await writer.open({ ...req, seed, reservation: reserved.run });
        expect(opened.kind).toBe("tracked");
        const actual = await client.readPromotion({ runId: req.runId, gen: "g1" });
        if (actual.kind !== "confirmed") throw new Error("actual original not confirmed");
        const ref = {
          storeKey: sk,
          runId: req.runId,
          gen: "g1",
          bodySha256: actual.receipt.bodySha256,
          expectedSeedSha256: actual.receipt.expectedSeedSha256,
        };
        const source = await client.readExpectedSeed(sessionKey, ref);
        expect(source).toMatchObject({
          kind: "verified",
          release: { phase: "released" },
          receipt: { runId: req.runId, from: index },
        });
        originals.push({ runId: req.runId, ref, source });
        await client.abandon(req.runId, "g1");
        await reserved.run.close();
      }
      expect(originals[0].ref.bodySha256).not.toBe(originals[1].ref.bodySha256);
      for (const original of originals)
        expect(await client.readExpectedSeed(sessionKey, original.ref)).toEqual(original.source);
      await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)), async (owner, state) => {
        expect(await owner.retainRangePinsIfRevision((await owner.custodyPinRevision())!, [])).toMatchObject({
          ok: true,
        });
        const pins = JSON.parse(
          state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='range_pins'").one().value,
        );
        for (let i = 0; i < originals.length; i++) expect(pins[originals[i].runId]).toContainEqual({ from: i, to: i });
        expect(
          state.storage.sql.exec("SELECT key FROM meta WHERE key GLOB 'expected_seed_original:*'").toArray(),
        ).toHaveLength(2);
      });
    },
  );
  it.each(["orphan-result", "policy-refusal", "thinking", "thinking-only", "empty-tail", "over-budget", "legacy-copy"])(
    "actual HTTP producer confirms projected follow-up without rewriting original SQLite rows: %s",
    async (mode) => {
      const sk = storeKey(),
        key = "task:projection:" + sk;
      const client = new WorkerRunLedger({
        baseUrl: BASE,
        token: "test-token",
        storeKey: sk,
        fetch: (input, init) => fetchMemoryTest(String(input), init),
      });
      const req = request(sk, null).run;
      const context = { version: 1 as const, status: "known" as const, revision: 0, origins: [], slack: [], mcp: [] };
      const raw: ChatMessage[] = [
        { role: "user", content: [{ type: "text", text: "prior request" }] },
        { role: "assistant", content: [{ type: "text", text: "prior answer" }] },
      ];
      if (mode === "orphan-result")
        raw[0].content.push({ type: "tool_result", toolUseId: "before-cut", content: "private result" });
      if (mode === "thinking")
        raw[1].content.unshift({ type: "thinking", thinking: "private reasoning", signature: "fixture" });
      if (mode === "thinking-only")
        raw[1] = { role: "assistant", content: [{ type: "redacted_thinking", data: "private reasoning" }] };
      if (mode === "empty-tail")
        raw.splice(0, raw.length, { role: "assistant", content: [{ type: "text", text: "no user turn" }] });
      if (mode !== "legacy-copy") {
        for (let i = 0; i < raw.length; i++) {
          const row = turnRows(i, raw[i], {}, i === 0 ? req.meta.userId : undefined);
          expect(await client.appendSession(key, "prior-" + i, row.rows, context)).toMatchObject({ ok: true });
        }
      }
      const before = await client.observeExpectedSeed(key, 0, 100);
      const tail =
        mode === "legacy-copy"
          ? { from: 0, transcript: { messages: raw, turns: raw.length, complete: true as const, compactions: [] } }
          : await client.readSessionTail(key, mode === "over-budget" ? 1 : 1000000);
      const projected = sessionSeed({
        tail,
        previous: { broken: false },
        history: [],
        request: { text: "follow up", actor: req.meta.userId },
        refusedRequests: mode === "policy-refusal" ? [0] : [],
      })!;
      if (mode === "legacy-copy") projected.log = { from: 0, turns: 0 };
      const seed = { ...projected, key, budgetMs: req.meta.profile!.minutes * 60000, context, notepad: "" };
      const writer = createLedgerWriteThrough({
        ledger: client,
        gen: "g1",
        now: () => 1000,
        warn: () => {},
        fallback: { put: async () => {}, abandoned: () => {} },
        setInterval: () => ({ unref() {} }),
        clearInterval: () => {},
      });
      const reserved = await writer.reserve(req);
      if (reserved.kind !== "tracked") throw new Error("original reservation refused");
      expect((await writer.open({ ...req, seed, reservation: reserved.run })).kind).toBe("tracked");
      const actual = await client.readPromotion({ runId: req.runId, gen: "g1" });
      expect(actual.kind).toBe("confirmed");
      if (actual.kind !== "confirmed") throw new Error("original projection not confirmed");
      expect(actual.preparation.expectedSeed?.reused === undefined).toBe(projected.log.turns === 0);
      const after = await client.observeExpectedSeed(key, 0, 100);
      expect(after.rows.filter((r) => r.idx < before.next)).toEqual(before.rows);
      expect(after.attachments).toEqual(before.attachments);
      const ref = {
        storeKey: sk,
        runId: req.runId,
        gen: "g1",
        bodySha256: actual.receipt.bodySha256,
        expectedSeedSha256: actual.receipt.expectedSeedSha256,
      };
      expect(await client.readExpectedSeed(key, ref)).toMatchObject({
        kind: "verified",
        release: { phase: "released" },
      });
      await reserved.run.close();
    },
  );
  it("returns the original allocation ACK from the successful private claim transaction and canonical null stays null", async () => {
    for (const original of [allocation, null]) {
      const key = storeKey(),
        req = request(key, original);
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner, state) => {
        for (const phase of ["attaching", "attaching", "live", "live"] as const) {
          req.run.phase = phase;
          const result = await owner.claim(req.run, 1000);
          expect(result).toMatchObject({
            ok: true,
            allocationAck: { version: 1, runId: id, threadKey: thread, gen: "g1", startedAt: 1, allocation: original },
          });
          const stored = state.storage.sql
            .exec<{ allocation_json: string }>(
              "SELECT allocation_json FROM workspace_settlements WHERE allocation_json IS NOT NULL",
            )
            .one();
          expect(result.ok && result.allocationAck!.allocation).toEqual(JSON.parse(stored.allocation_json).allocation);
          if (result.ok && result.allocationAck?.allocation) result.allocationAck.allocation.kind = "retained";
          expect(
            JSON.parse(
              state.storage.sql
                .exec<{ allocation_json: string }>(
                  "SELECT allocation_json FROM workspace_settlements WHERE allocation_json IS NOT NULL",
                )
                .one().allocation_json,
            ).allocation,
          ).toEqual(original);
          delete req.run.meta.workspaceAllocation;
        }
      });
    }
    const key = storeKey();
    const client = new WorkerRunLedger({
      baseUrl: BASE,
      token: "test-token",
      storeKey: key,
      fetch: (input, init) => fetchMemoryTest(String(input), init),
    });
    const result = await client.claim(request(key).run);
    expect(result).toMatchObject({ ok: true, allocationAck: { allocation } });
  });
  it("preserves a committed allocation after a lost HTTP ACK and refuses reserve without a retry or handle", async () => {
    const key = storeKey();
    let claims = 0,
      heartbeats = 0;
    const client = new WorkerRunLedger({
      baseUrl: BASE,
      token: "test-token",
      storeKey: key,
      fetch: async (input, init) => {
        const response = await fetchMemoryTest(String(input), init);
        if (String(input).endsWith("/runs/claim")) {
          claims++;
          expect(response.status).toBe(200);
          throw new Error("fixture lost ACK after actual SQLite commit");
        }
        return response;
      },
    });
    const writer = createLedgerWriteThrough({
      ledger: client,
      gen: "g1",
      warn: () => {},
      now: () => 1000,
      claimAttempts: 3,
      fallback: { put: async () => {}, abandoned: () => {} },
      setInterval: () => {
        heartbeats++;
        return { unref() {} };
      },
      clearInterval: () => {},
    });
    await expect(writer.reserve(request(key).run)).rejects.toBeInstanceOf(UnknownAllocationClaimError);
    expect(claims).toBe(1);
    expect(heartbeats).toBe(0);
    expect(writer.liveRuns()).toEqual([]);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner) => {
      expect((await owner.listLive())[0].meta.workspaceAllocation).toEqual(allocation);
    });
  });
  it.each(["v2", "null"] as const)(
    "promotes actual %s originals through HTTP at their first start and preserves unknown promotion ACKs",
    async (kind) => {
      const declared: WorkspaceAllocation = {
        version: 2,
        kind: "exclusive-scratch",
        runId: id,
        requester: allocation.requester,
        threadKey: thread,
        repo: "fixture/repo",
        ref: "codex/fixture",
        headSha: "a".repeat(40),
        pr: 42,
        allocationKey: `review:${id}`,
        custody: "session-report-and-review-publication",
        policy: {
          version: 1,
          purpose: "pull-request-review",
          resident: "retained",
          cold: {
            kind: "exclusive-scratch",
            scope: "original-cold-allocation",
            custody: "session-report-and-review-publication",
          },
        },
      };
      const original = kind === "v2" ? declared : null;
      for (const mode of ["accepted", "lost", "foreign", "missing"] as const) {
        const key = storeKey();
        let calls = 0;
        const client = new WorkerRunLedger({
          baseUrl: BASE,
          token: "test-token",
          storeKey: key,
          fetch: async (input, init) => {
            if (mode !== "accepted" && calls >= 2 && String(input).endsWith("/runs/promotion/read"))
              return Response.json({ kind: "held", reason: "unknown" });
            const response = await fetchMemoryTest(String(input), init);
            if (
              !String(input).endsWith("/runs/claim") ||
              !JSON.parse(String(init?.body)).run ||
              ++calls === 1 ||
              mode === "accepted"
            )
              return response;
            expect(response.status).toBe(200);
            if (mode === "lost") throw new Error("actual promotion reply lost after SQLite commit");
            const body = (await response.json()) as { ok: true; allocationAck: { gen: string } };
            if (mode === "foreign") body.allocationAck.gen = "foreign";
            return Response.json(mode === "missing" ? { ok: true } : body);
          },
        });
        const writer = createLedgerWriteThrough({
          ledger: client,
          gen: "g1",
          now: () => 2500,
          warn: () => {},
          claimAttempts: 3,
          fallback: { put: async () => {}, abandoned: () => {} },
          setInterval: () => ({ unref() {} }),
          clearInterval: () => {},
        });
        const req = request(key, original).run;
        if (original) req.meta.pr = 42;
        const reserved = await writer.reserve(req);
        if (reserved.kind !== "tracked") throw new Error("fixture reserve refused");
        const ack = reserved.run.allocationAck;
        const promotion = writer.open({
          ...req,
          system: "original prompt",
          reservation: reserved.run,
          seed: {
            messages: [{ role: "user", content: [{ type: "text", text: "actual original input" }] }],
            actors: [req.meta.userId],
            budgetMs: 1500000,
            context: UNKNOWN_CONTEXT_DEPENDENCIES,
            notepad: "",
          },
        });
        if (mode === "accepted") {
          const result = await promotion;
          expect(result.kind).toBe("tracked");
          expect(reserved.run.allocationAck).toEqual(ack);
        } else {
          await expect(promotion).rejects.toBeInstanceOf(UnknownAllocationClaimError);
          expect(reserved.run.tracked()).toBe(true);
          expect(reserved.run.allocationAck).toEqual(ack);
        }
        expect(calls).toBe(2);
        await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner, state) => {
          expect((await owner.listLive())[0]).toMatchObject({ runId: id, startedAt: 1, phase: "live" });
          const stored = state.storage.sql
            .exec<{ allocation_json: string }>(
              "SELECT allocation_json FROM workspace_settlements WHERE allocation_json IS NOT NULL",
            )
            .one();
          expect(JSON.parse(stored.allocation_json).allocation).toEqual(original);
        });
        await reserved.run.close();
      }
    },
  );
  it("retains first contract or legacy absence through abandon and refuses replacement", async () => {
    for (const original of [allocation, null]) {
      const key = storeKey();
      expect((await post("/runs/claim", request(key, original))).status).toBe(200);
      expect((await post("/runs/abandon", { storeKey: key, runId: id, gen: "g1" })).status).toBe(200);
      const changed = { ...allocation, custody: "session-report-and-review-publication" as const };
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner) => {
        await expect(owner.claim(request(key, changed).run, 1000)).rejects.toThrow(/workspace allocation/);
        expect(await owner.workspaceDisposition(allocation)).toMatchObject({ kind: original ? "terminal" : "held" });
      });
    }
  });
  it("allocation-only envelopes preserve unrelated ownership and cannot hide malformed resident rows", async () => {
    const key = storeKey();
    await post("/runs/claim", request(key));
    await post("/runs/abandon", { storeKey: key, runId: id, gen: "g1" });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner, state) => {
      expect(await owner.findPullOwners({ repo: "fixture/repo", ref: "codex/unrelated" })).toEqual({
        ok: true,
        owners: [],
      });
      const columns = state.storage.sql.exec<{ name: string }>("PRAGMA table_info(workspace_settlements)").toArray();
      expect(columns.some((c) => c.name === "allocation_json")).toBe(true);
      const rows = state.storage.sql
        .exec<{ json: string | null; allocation_json: string | null }>(
          "SELECT json,allocation_json FROM workspace_settlements",
        )
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].json).toBeNull();
      expect(rows[0].allocation_json).toBeTruthy();
      state.storage.sql.exec(
        "INSERT INTO workspace_settlements(owner_key,revision,json) VALUES (?,1,?)",
        "malformed-original-resident",
        "{",
      );
      expect(await owner.findPullOwners({ repo: "fixture/repo", ref: "codex/unrelated" })).toMatchObject({
        ok: false,
        reason: "incomplete",
      });
      expect(
        state.storage.sql
          .exec("SELECT json FROM workspace_settlements WHERE owner_key=?", "malformed-original-resident")
          .toArray(),
      ).toEqual([{ json: "{" }]);
    });
  });
  function closureContract(over?: { parent?: boolean; maintenance?: boolean }, key?: string) {
    return {
      ...allocation,
      ...(key ? { threadKey: `${thread}:${key}` } : {}),
      ...(over?.parent || over?.maintenance
        ? {
            parentInstanceId: "original-parent",
            coordinatorUnit: "unit",
            idempotencyKey: "original-parent:unit/0/review",
          }
        : {}),
      ...(over?.maintenance ? { maintenanceActionId: `m_${"c".repeat(64)}` } : {}),
    };
  }
  async function closure(
    key: string,
    missing = false,
    over?: { raw?: string; missingReport?: boolean; parent?: boolean; maintenance?: boolean },
  ) {
    const req = request(key);
    const contract = closureContract(over, key);
    req.run.threadKey = contract.threadKey;
    req.run.meta.threadKey = contract.threadKey;
    req.run.meta.workspaceAllocation = contract;
    Object.assign(req.run.meta, {
      parentInstanceId: contract.parentInstanceId,
      coordinatorUnit: contract.coordinatorUnit,
      idempotencyKey: contract.idempotencyKey,
      maintenanceActionId: contract.maintenanceActionId,
    });
    req.run.phase = "live";
    const session = { key: `${contract.threadKey}:review`, seedFrom: 0, request: 0, range: { from: 0 } };
    Object.assign(req.run.meta, { session });
    expect((await post("/runs/claim", req)).status).toBe(200);
    expect((await post("/runs/session/owner", { key: session.key, runId: id, gen: "g1" })).status).toBe(200);
    const raw = over?.raw ?? "owned durable report";
    const parsed = markdownOutput.parse(raw);
    if (!parsed.ok) throw new Error("fixture output refused");
    const events: RunEvent[] = [
      { type: "lease", seq: 1, startedAt: 1, endsAt: 100, loopEndsAt: 90 },
      { type: "answer", seq: 2, text: parsed.value },
    ];
    expect((await post("/runs/append", { storeKey: key, runId: id, gen: "g1", events })).status).toBe(200);
    const client = new WorkerRunLedger({
      baseUrl: BASE,
      token: "test-token",
      storeKey: key,
      fetch: (input, init) => fetchMemoryTest(String(input), init),
    });
    if (!over?.missingReport)
      await appendRunReport(
        client,
        {
          runId: id,
          threadKey: contract.threadKey,
          requester: allocation.requester,
          channelId: req.run.meta.channelId,
          text: parsed.value,
          context: UNKNOWN_CONTEXT_DEPENDENCIES,
        },
        async () => null,
      );
    if (!missing) {
      const client = new WorkerRunLedger({
        baseUrl: BASE,
        token: "test-token",
        storeKey: key,
        fetch: (input, init) => fetchMemoryTest(String(input), init),
      });
      expect(
        await client.step(
          id,
          "g1",
          { step: 0, seq: 2, turnIndex: 2, inFlight: [], inboxConsumedSeq: 0, remainingMs: 0, turn: 1, iteration: 1 },
          [
            { idx: 0, message: { role: "user", content: [{ type: "text", text: "original request" }] } },
            { idx: 1, message: { role: "assistant", content: [{ type: "text", text: raw }] } },
          ],
          session.key,
        ),
      ).toEqual({ ok: true });
    }
    expect(
      (
        await post("/runs/state", {
          storeKey: key,
          runId: id,
          gen: "g1",
          state: {
            binding: {
              backend: "sandbox",
              sandboxKey: allocation.allocationKey,
              ref: allocation.ref,
              container: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
            },
            harness: {
              harness: "pi",
              pid: 12,
              logOffset: 0,
              relaunches: 0,
              container: "cccccccc-cccc-4ccc-cccc-cccccccccccc",
              processBirth: "dddddddd-dddd-4ddd-dddd-dddddddddddd:12",
              bearerHash: "b".repeat(64),
            },
          },
        })
      ).status,
    ).toBe(200);
    expect((await post("/runs/finishing", { storeKey: key, runId: id, gen: "g1" })).status).toBe(200);
    return {
      ...record(id, contract.threadKey),
      startedAt: 1,
      repo: allocation.repo,
      ...(contract.parentInstanceId
        ? {
            parentInstanceId: contract.parentInstanceId,
            coordinatorUnit: contract.coordinatorUnit,
            idempotencyKey: contract.idempotencyKey,
          }
        : {}),
      ...(contract.maintenanceActionId ? { maintenanceActionId: contract.maintenanceActionId } : {}),
      events,
      eventCount: 2,
      storedEventCount: 2,
      session: { ...session, range: { from: 0, to: 1 } },
    };
  }
  it("closes normalized reports and original parent or maintenance identities through independent custody", async () => {
    for (const over of [{ raw: "*Review complete.*" }, { parent: true }, { maintenance: true }]) {
      const key = storeKey(),
        ended = await closure(key, false, over);
      expect((await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: ended })).status).toBe(200);
      expect(
        (await post("/runs/workspace-disposition", { storeKey: key, allocation: closureContract(over, key) })).data,
      ).toMatchObject({ kind: "terminal", disposition: { kind: "scratch-custody-closed" } });
    }
  });
  it("holds missing report ACKs and rechecks changed trimmed foreign unknown report or loop rows", async () => {
    const missingKey = storeKey(),
      missing = await closure(missingKey, false, { missingReport: true });
    await post("/runs/finish", { storeKey: missingKey, runId: id, gen: "g1", record: missing });
    expect(
      (
        await post("/runs/workspace-disposition", {
          storeKey: missingKey,
          allocation: closureContract(undefined, missingKey),
        })
      ).data,
    ).toMatchObject({ kind: "terminal", disposition: { kind: "retained" } });
    for (const kind of ["changed", "trimmed", "foreign", "unknown", "loop"] as const) {
      const key = storeKey(),
        ended = await closure(key);
      await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: ended });
      const sessionKey = kind === "loop" ? `${ended.threadKey}:review` : contextThreadSessionKey(ended.threadKey);
      await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)), async (_log, state) => {
        if (kind === "trimmed") state.storage.sql.exec("UPDATE turns SET trimmed=1 WHERE idx=0");
        else if (kind === "unknown") state.storage.sql.exec("DELETE FROM turns");
        else if (kind === "foreign")
          state.storage.sql.exec("UPDATE turns SET row_id=? WHERE idx=0", "run:foreign:answer");
        else
          state.storage.sql.exec(
            "UPDATE turns SET json=? WHERE idx=0 AND part=0",
            JSON.stringify({ role: "assistant", part: { type: "text", text: "changed stored bytes" } }),
          );
      });
      expect(
        (await post("/runs/workspace-disposition", { storeKey: key, allocation: closureContract(undefined, key) }))
          .data,
        kind,
      ).toEqual({ kind: "held", reason: "custody-unavailable" });
    }
  });
  it("fences report and loop mutation during asynchronous finish custody", async () => {
    for (const kind of ["report", "loop"] as const) {
      const key = storeKey(),
        ended = await closure(key);
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner) => {
        const target = owner as unknown as { workspaceCustody(row: LiveRunRow): Promise<StoredWorkspaceCustody> };
        const original = target.workspaceCustody.bind(owner);
        let once = false;
        target.workspaceCustody = async (row) => {
          const custody = await original(row);
          if (!once) {
            once = true;
            const sessionKey =
              kind === "report" ? contextThreadSessionKey(ended.threadKey) : `${ended.threadKey}:review`;
            await runInDurableObject(
              env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)),
              async (_log, state) => {
                state.storage.sql.exec("UPDATE turns SET json=? WHERE idx=0 AND part=0", "{}");
              },
            );
          }
          return custody;
        };
        expect(await owner.finish(id, "g1", ended)).toEqual({ ok: false, reason: "fenced" });
        expect(await owner.workspaceDisposition(closureContract(undefined, key))).toEqual({
          kind: "held",
          reason: "live",
        });
      });
    }
  });
  it("holds foreign or unreadable original report rows and actual pending work before finish", async () => {
    for (const kind of ["foreign", "unreadable", "job", "inbox", "paused"] as const) {
      const key = storeKey(),
        ended = await closure(key, false, { parent: true });
      if (kind === "foreign" || kind === "unreadable") {
        await runInDurableObject(
          env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(contextThreadSessionKey(ended.threadKey))),
          async (_log, state) => {
            if (kind === "unreadable") state.storage.sql.exec("UPDATE turns SET json=? WHERE idx=0", "{");
            else
              state.storage.sql.exec(
                "UPDATE turns SET json=? WHERE idx=0",
                JSON.stringify({
                  role: "user",
                  part: { type: "text", text: "owned durable report" },
                  context: UNKNOWN_CONTEXT_DEPENDENCIES,
                }),
              );
          },
        );
      } else
        await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner, state) => {
          if (kind === "job")
            state.storage.sql.exec("INSERT INTO run_jobs(run_id,kind,json) VALUES (?,?,?)", id, "fixture", "{}");
          else if (kind === "inbox") await owner.pushInbox(id, { text: "unread" });
          else {
            const row = (await owner.listLive())[0];
            await owner.setState(id, "g1", { ...row.state, pausedForRetry: true });
          }
        });
      expect((await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: ended })).status).toBe(200);
      expect(
        (
          await post("/runs/workspace-disposition", {
            storeKey: key,
            allocation: closureContract({ parent: true }, key),
          })
        ).data,
        kind,
      ).toMatchObject({ kind: "terminal", disposition: { kind: "retained" } });
    }
  });
  it("withholds an earlier closed receipt when a new unresolved run effect appears", async () => {
    const key = storeKey(),
      ended = await closure(key);
    await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: ended });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner, state) => {
      expect(await owner.workspaceDisposition(closureContract(undefined, key))).toMatchObject({
        kind: "terminal",
        disposition: { kind: "scratch-custody-closed" },
      });
      state.storage.sql.exec(
        "INSERT INTO plane_effects(id,body_json,offered_at) VALUES (?,?,?)",
        `late:${id}`,
        JSON.stringify({ id: `late:${id}`, kind: "pr_open", runId: id, repo: allocation.repo, branch: allocation.ref }),
        1000,
      );
      expect(await owner.workspaceDisposition(closureContract(undefined, key))).toEqual({
        kind: "held",
        reason: "custody-unavailable",
      });
    });
  });
  it("holds every run-bound external effect beyond the response cap while retiring exact admission and steer intents", async () => {
    for (const kind of ["external", "admit", "steer", "malformed"] as const) {
      const key = storeKey(),
        ended = await closure(key);
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner, state) => {
        for (let index = 0; index < 100; index++)
          state.storage.sql.exec(
            "INSERT INTO plane_effects(id,body_json,offered_at) VALUES (?,?,?)",
            `probe:unrelated-${index}`,
            JSON.stringify({ id: `probe:unrelated-${index}`, kind: "probe", resident: `unrelated-${index}` }),
            index,
          );
        const effect =
          kind === "admit"
            ? { id: `admit:${id}`, kind: "admit", runId: id, threadKey: ended.threadKey, request: {} }
            : kind === "steer"
              ? { id: `steer:${id}:1`, kind: "steer", runId: id, seq: 1, message: { text: "stored steer" } }
              : { id: `external:${id}`, kind: "pr_open", runId: id, repo: allocation.repo, branch: allocation.ref };
        state.storage.sql.exec(
          "INSERT INTO plane_effects(id,body_json,offered_at) VALUES (?,?,?)",
          effect.id,
          kind === "malformed" ? "{" : JSON.stringify(effect),
          1000,
        );
        expect(await owner.finish(id, "g1", ended)).toMatchObject({ ok: true });
        expect(await owner.workspaceDisposition(closureContract(undefined, key)), kind).toMatchObject({
          kind: "terminal",
          disposition: { kind: kind === "admit" || kind === "steer" ? "scratch-custody-closed" : "retained" },
        });
      });
    }
  });
  it("retains both custody pins through actual maintenance before and after finish", async () => {
    for (const terminal of [false, true]) {
      const key = storeKey(),
        ended = await closure(key);
      const keys = [ended.session!.key, contextThreadSessionKey(ended.threadKey)];
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner) => {
        const target = owner as unknown as {
          workspaceCustody(row: LiveRunRow): Promise<StoredWorkspaceCustody>;
          syncRangePins(keys: readonly string[]): Promise<void>;
        };
        if (terminal) await owner.finish(id, "g1", ended);
        else await target.workspaceCustody((await owner.listLive())[0]);
        for (const sessionKey of keys)
          await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)), async (log) => {
            const pins = (log as unknown as { rangePins(): Record<string, unknown> }).rangePins();
            expect(pins[id]).toBeDefined();
          });
        await target.syncRangePins(keys);
        for (const sessionKey of keys)
          await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)), async (log) => {
            const pins = (log as unknown as { rangePins(): Record<string, unknown> }).rangePins();
            expect(
              pins[id],
              terminal ? "terminal custody pin was pruned" : "live pre-finish custody pin was pruned",
            ).toBeDefined();
          });
      });
    }
  });
  it("advances same-range protection and atomically declines stale or legacy pin pruning", async () => {
    const key = storeKey(),
      ended = await closure(key);
    const log = env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(ended.session!.key));
    const before = (await log.custodyPinRevision())!;
    const first = await log.protectCustodyRanges(id, [{ from: 0, to: 1 }]);
    const beforeReacquisition = (await log.custodyPinRevision())!;
    const second = await log.protectCustodyRanges(id, [{ from: 0, to: 1 }]);
    expect(first.ok && second.ok && second.revision > first.revision).toBe(true);
    expect(await log.retainRangePinsIfRevision(before, [])).toMatchObject({ ok: false, reason: "revision-changed" });
    expect(await log.retainRangePinsIfRevision(beforeReacquisition, [])).toMatchObject({
      ok: false,
      reason: "revision-changed",
    });
    expect(await log.retainRangePins([])).toMatchObject({ ok: false, reason: "custody-protected" });
    const current = (await log.custodyPinRevision())!;
    expect(await log.retainRangePinsIfRevision(current, [id])).toMatchObject({
      ok: true,
      revision: current.revision + 1,
    });
    await runInDurableObject(log, async (owner) => {
      expect((owner as unknown as { rangePins(): Record<string, unknown> }).rangePins()[id]).toEqual([
        { from: 0, to: 1 },
      ]);
    });
    const ordinary = env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(contextThreadSessionKey(ended.threadKey)));
    const unguarded = (await ordinary.custodyPinRevision())!;
    expect((await ordinary.protectRanges("ordinary-context", [{ from: 0, to: 0 }])).ok).toBe(true);
    expect(await ordinary.custodyPinRevision()).toEqual({
      version: 1,
      revision: unguarded.revision + 1,
      guarded: false,
    });
    expect(await ordinary.retainRangePins([])).toMatchObject({ ok: true });
  });
  it("refuses a delayed prune when successor allocation protection arrives after holder selection", async () => {
    const key = storeKey(),
      ended = await closure(key);
    await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: ended });
    const reportKey = contextThreadSessionKey(ended.threadKey),
      successor = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner) => {
      const target = owner as unknown as {
        env: { SESSION_LOGS: typeof env.SESSION_LOGS };
        syncRangePins(keys: readonly string[]): Promise<void>;
      };
      const original = target.env.SESSION_LOGS;
      let interleaved = false,
        refused = false;
      target.env = {
        ...target.env,
        SESSION_LOGS: new Proxy(original, {
          get(namespace, property) {
            if (property !== "get") {
              const value = Reflect.get(namespace, property);
              return typeof value === "function"
                ? (...args: unknown[]) => Reflect.apply(value, namespace, args)
                : value;
            }
            return (name: DurableObjectId) => {
              const log = original.get(name);
              return new Proxy(log, {
                get(receiver, method) {
                  if (method !== "retainRangePinsIfRevision") {
                    const value = Reflect.get(receiver, method);
                    return typeof value === "function"
                      ? (...args: unknown[]) => Reflect.apply(value, receiver, args)
                      : value;
                  }
                  return async (
                    revision: Awaited<ReturnType<SessionLogDO["custodyPinRevision"]>>,
                    holders: readonly string[],
                  ) => {
                    const contract = {
                      ...closureContract(undefined, key),
                      runId: successor,
                      allocationKey: `review:${successor}`,
                    };
                    const req = request(key, contract).run;
                    req.runId = successor;
                    req.threadKey = ended.threadKey;
                    req.meta.threadKey = ended.threadKey;
                    expect(await owner.claim(req, 1000)).toMatchObject({ ok: true });
                    expect((await log.protectCustodyRanges(successor, [{ from: 0, to: 0 }])).ok).toBe(true);
                    interleaved = true;
                    const result = await log.retainRangePinsIfRevision(revision!, holders);
                    refused = !result.ok && result.reason === "revision-changed";
                    return result;
                  };
                },
              });
            };
          },
        }),
      };
      await target.syncRangePins([reportKey]);
      target.env = { ...target.env, SESSION_LOGS: original };
      expect(interleaved && refused).toBe(true);
    });
    await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(reportKey)), async (log) => {
      expect((log as unknown as { rangePins(): Record<string, unknown> }).rangePins()[successor]).toBeDefined();
    });
  });
  it("holds unknown or old receivers without unconditional fallback and preserves guarded data after reset", async () => {
    const key = storeKey(),
      ended = await closure(key);
    await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: ended });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner) => {
      const target = owner as unknown as {
        env: { SESSION_LOGS: typeof env.SESSION_LOGS };
        syncRangePins(keys: readonly string[]): Promise<void>;
      };
      const original = target.env.SESSION_LOGS;
      let legacy = 0;
      target.env = {
        ...target.env,
        SESSION_LOGS: new Proxy(original, {
          get(namespace, property) {
            if (property !== "get") {
              const value = Reflect.get(namespace, property);
              return typeof value === "function"
                ? (...args: unknown[]) => Reflect.apply(value, namespace, args)
                : value;
            }
            return (name: DurableObjectId) =>
              new Proxy(original.get(name), {
                get(receiver, method) {
                  if (method === "custodyPinRevision")
                    return async () => {
                      throw new Error("fixture old receiver: missing RPC");
                    };
                  if (method === "retainRangePins")
                    return async () => {
                      legacy++;
                    };
                  const value = Reflect.get(receiver, method);
                  return typeof value === "function"
                    ? (...args: unknown[]) => Reflect.apply(value, receiver, args)
                    : value;
                },
              });
          },
        }),
      };
      await target.syncRangePins([ended.session!.key]);
      target.env = { ...target.env, SESSION_LOGS: original };
      expect(legacy).toBe(0);
    });
    const log = env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(ended.session!.key));
    await runInDurableObject(log, async (_receiver, state) => {
      state.storage.sql.exec("DELETE FROM meta WHERE key='range_pin_revision'");
    });
    expect(await log.custodyPinRevision()).toBeUndefined();
    expect(
      (await post("/runs/workspace-disposition", { storeKey: key, allocation: closureContract(undefined, key) })).data,
    ).toEqual({ kind: "held", reason: "custody-unavailable" });
    expect(await log.retainRangePins([])).toMatchObject({ ok: false, reason: "custody-protected" });
  });
  it("retains malformed pin metadata without inventing a protection or prune receipt", async () => {
    const key = storeKey(),
      ended = await closure(key);
    const log = env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(ended.session!.key));
    const unknown = JSON.stringify({ [id]: "unknown saved protection" });
    await runInDurableObject(log, async (_receiver, state) => {
      state.storage.sql.exec("INSERT INTO meta(key,value) VALUES ('range_pins',?)", unknown);
    });
    expect(await log.custodyPinRevision()).toBeUndefined();
    expect((await log.protectCustodyRanges(id, [{ from: 0, to: 1 }])).ok).toBe(false);
    expect((await log.retainRangePinsIfRevision({ version: 1, revision: 0, guarded: false }, [])).ok).toBe(false);
    await runInDurableObject(log, async (_receiver, state) => {
      expect(
        state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='range_pins'").one().value,
      ).toBe(unknown);
    });
  });
  it("does not retry an unknown conditional prune response and retains the acknowledged custody pins", async () => {
    const key = storeKey(),
      ended = await closure(key);
    await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: ended });
    const reportKey = contextThreadSessionKey(ended.threadKey);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner) => {
      const target = owner as unknown as {
        env: { SESSION_LOGS: typeof env.SESSION_LOGS };
        syncRangePins(keys: readonly string[]): Promise<void>;
      };
      const original = target.env.SESSION_LOGS;
      let calls = 0;
      target.env = {
        ...target.env,
        SESSION_LOGS: new Proxy(original, {
          get(namespace, property) {
            if (property !== "get") {
              const value = Reflect.get(namespace, property);
              return typeof value === "function"
                ? (...args: unknown[]) => Reflect.apply(value, namespace, args)
                : value;
            }
            return (name: DurableObjectId) => {
              const log = original.get(name);
              return new Proxy(log, {
                get(receiver, method) {
                  if (method !== "retainRangePinsIfRevision") {
                    const value = Reflect.get(receiver, method);
                    return typeof value === "function"
                      ? (...args: unknown[]) => Reflect.apply(value, receiver, args)
                      : value;
                  }
                  return async (
                    revision: NonNullable<Awaited<ReturnType<SessionLogDO["custodyPinRevision"]>>>,
                    holders: readonly string[],
                  ) => {
                    calls++;
                    expect((await log.retainRangePinsIfRevision(revision, holders)).ok).toBe(true);
                    throw new Error("fixture lost conditional prune response");
                  };
                },
              });
            };
          },
        }),
      };
      await target.syncRangePins([reportKey]);
      target.env = { ...target.env, SESSION_LOGS: original };
      expect(calls).toBe(1);
    });
    await runInDurableObject(env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(reportKey)), async (log) => {
      expect((log as unknown as { rangePins(): Record<string, unknown> }).rangePins()[id]).toBeDefined();
    });
  });
  it("derives closure from actual session and step custody and holds missing writes", async () => {
    for (const missing of [false, true]) {
      const key = storeKey();
      const ended = await closure(key, missing);
      expect(
        (await post("/runs/workspace-disposition", { storeKey: key, allocation: closureContract(undefined, key) }))
          .data,
      ).toEqual({
        kind: "held",
        reason: "live",
      });
      expect((await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: ended })).status).toBe(200);
      expect(
        (await post("/runs/workspace-disposition", { storeKey: key, allocation: closureContract(undefined, key) }))
          .data,
      ).toMatchObject({
        kind: "terminal",
        disposition: { kind: missing ? "retained" : "scratch-custody-closed" },
      });
      const client = new WorkerRunLedger({
        baseUrl: BASE,
        token: "test-token",
        storeKey: key,
        fetch: (input, init) => fetchMemoryTest(String(input), init),
      });
      expect(await client.workspaceDisposition(closureContract(undefined, key))).toMatchObject({
        kind: "terminal",
        disposition: { kind: missing ? "retained" : "scratch-custody-closed" },
      });
      expect(
        (
          await post("/runs/workspace-disposition", {
            storeKey: key,
            allocation: { ...closureContract(undefined, key), requester: "slack:foreign" },
          })
        ).data,
      ).toMatchObject({ kind: "held" });
      expect(
        (
          await post("/runs/put", {
            storeKey: key,
            record: { ...ended, workspaceDisposition: { kind: "scratch-custody-closed" } },
          })
        ).status,
      ).toBe(400);
    }
  });
  it("refuses mutation of canonical execution custody during the awaited session boundary", async () => {
    const key = storeKey(),
      ended = await closure(key);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner) => {
      const live = (await owner.listLive())[0];
      await owner.setState(id, "g1", {
        ...live.state,
        binding: { ...(live.state.binding as Record<string, unknown>), workspace: "/workspace/checkout" },
      });
      const firstControl = new AbortController(),
        secondControl = new AbortController();
      const checks = createCheckExecution({
        executor: () => ({
          execResult: async () => ({
            stdout: "/workspace/checkout\n" + "a".repeat(40) + "\n" + "b".repeat(40) + "\n",
            stderr: "",
            exitCode: 0,
            truncated: false,
          }),
        }),
        workspace: () => "/workspace/checkout",
        recordingAvailable: true,
        owner: {
          runId: id,
          requester: allocation.requester,
          threadKey: ended.threadKey,
          repo: allocation.repo!,
        },
        authorizeCommand: () => true,
        remainingMs: () => 120_000,
        signal: firstControl.signal,
        clock: () => 10,
        save: async (state) => {
          const current = (await owner.listLive())[0];
          return (await owner.setState(id, "g1", { ...current.state, checkExecutions: state })).ok;
        },
      });
      expect((await checks.run({ command: "exit 7", purpose: "verification" }, "before-await")).kind).toBe("recorded");
      firstControl.abort();
      const target = owner as unknown as { workspaceCustody: (row: LiveRunRow) => Promise<StoredWorkspaceCustody> };
      const original = target.workspaceCustody.bind(owner);
      target.workspaceCustody = async (row) => {
        const facts = await original(row);
        let sends = 0;
        const next = createCheckExecution({
          previous: (await owner.listLive())[0].state.checkExecutions,
          executor: () => ({
            execResult: async () => {
              if (++sends > 1) throw new Error("fixture unknown collection");
              return {
                stdout: "/workspace/checkout\n" + "a".repeat(40) + "\n" + "b".repeat(40) + "\n",
                stderr: "",
                exitCode: 0,
                truncated: false,
              };
            },
          }),
          workspace: () => "/workspace/checkout",
          recordingAvailable: true,
          owner: {
            runId: id,
            requester: allocation.requester,
            threadKey: ended.threadKey,
            repo: allocation.repo!,
          },
          authorizeCommand: () => true,
          remainingMs: () => 120_000,
          signal: secondControl.signal,
          clock: () => 10,
          save: async (state) => {
            const current = (await owner.listLive())[0];
            return (await owner.setState(id, "g1", { ...current.state, checkExecutions: state })).ok;
          },
        });
        expect((await next.run({ command: "exit 8", purpose: "verification" }, "during-await")).kind).toBe("recorded");
        secondControl.abort();
        return facts;
      };
      expect(await owner.finish(id, "g1", ended)).toEqual({ ok: false, reason: "fenced" });
      expect(await owner.workspaceDisposition(closureContract(undefined, key))).toEqual({
        kind: "held",
        reason: "live",
      });
    });
  });
});

// Feature: docs/reference/specs/orchestration-plane.md — exact Workflow discovery and durable report obligations.
describe("durable coordinator Workflow reconciliation", () => {
  const instance: CoordinatorInstance = {
    id: "reconcile_workflow",
    kind: "ship",
    userId: "slack:UALICE",
    channelId: "slack:C1",
    threadKey: "slack:C1:reconcile",
    repo: "acme/api",
    branch: "fix/reconcile",
    base: "main",
    createdAt: 1000,
    admission: "created",
  };
  const unit: CoordinatorUnit = {
    instanceId: instance.id,
    unit: "ROOT",
    slug: "reconcile",
    branch: instance.branch,
    dependsOn: [],
    rounds: [],
  };
  async function seed(key: string, admission: CoordinatorInstance["admission"] = "created") {
    expect((await post("/runs/coordinator/put", { storeKey: key, instance: { ...instance, admission } })).status).toBe(
      200,
    );
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [unit] })).status).toBe(200);
  }
  async function native(key: string, status: string, race = false) {
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO, state) => {
      const holder = owner as unknown as { env: Record<string, unknown> };
      holder.env = {
        ...holder.env,
        SHIP_COORDINATOR: {
          get: async () => ({
            status: async () => {
              if (race)
                state.storage.sql.exec(
                  `UPDATE coordinator_units SET json = ? WHERE instance_id = ? AND unit = ?`,
                  JSON.stringify({ ...unit, title: "changed during observation" }),
                  instance.id,
                  unit.unit,
                );
              return { status };
            },
          }),
        },
      };
    });
  }
  it("offers terminal execution before bot delivery and retains its original row through a lost acknowledgement", async () => {
    const key = storeKey();
    await seed(key);
    await native(key, "errored");
    expect(
      (await post("/runs/coordinator/reconcile/offer", { storeKey: key, instanceId: instance.id, unit: unit.unit }))
        .status,
    ).toBe(200);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO, state) => {
      expect(owner.openPlaneEffects()).toMatchObject([
        { kind: "coordinator_reconcile", instanceId: instance.id, unit: unit.unit, workflowId: instance.id },
      ]);
      expect(await owner.listUnits(instance.id)).toEqual([unit]);
      const effect = owner.openPlaneEffects()[0]!;
      await owner.planeAck(effect.id, "done", 2000);
      expect(owner.openPlaneEffects()).toHaveLength(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
  it("retains unknown status, raced rows and unattributed same-id admissions without offering settlement", async () => {
    for (const [status, admission, race] of [
      ["unfamiliar", "created", false],
      ["complete", "unreconciled", false],
      ["terminated", "created", true],
    ] as const) {
      const key = storeKey();
      await seed(key, admission);
      await native(key, status, race);
      expect(
        (await post("/runs/coordinator/reconcile/offer", { storeKey: key, instanceId: instance.id, unit: unit.unit }))
          .status,
      ).toBe(200);
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO) => {
        expect(owner.openPlaneEffects()).toEqual([]);
        expect((await owner.listUnits(instance.id))[0]?.ending).toBeUndefined();
      });
    }
  });
  it("refuses an acknowledgement for a workspace owner with no retained revision", async () => {
    const key = storeKey();
    expect(
      await post("/runs/workspace-ack", {
        storeKey: key,
        runId: "never_known",
        ownerGen: "g1",
        ownerFence: 7,
        revision: 1,
      }),
    ).toMatchObject({ status: 409, data: { ok: false, reason: "unverified" } });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      expect(state.storage.sql.exec(`SELECT * FROM workspace_settlements`).toArray()).toEqual([]);
    });
  });
  it("finishes only the original frozen report and status before acknowledging, then permits reentry", async () => {
    const key = storeKey();
    await seed(key);
    await native(key, "errored");
    await post("/runs/coordinator/reconcile/offer", { storeKey: key, instanceId: instance.id, unit: unit.unit });
    const reportOwner = {
      instanceId: instance.id,
      unit: unit.unit,
      requester: instance.userId,
      channelId: instance.channelId,
      threadKey: instance.threadKey,
      attempt: 0,
      deliveryId: "reconcile-end",
    };
    const proposal = {
      text: "Execution ended; source result remains unverified.",
      threadText: "Execution ended; source result remains unverified.",
    };
    const admission = await coordinatorReportAdmission(reportOwner, proposal);
    const ended: CoordinatorUnit = {
      ...unit,
      ending: { kind: "aborted", report: proposal.text, deliveryId: reportOwner.deliveryId, at: 2000 },
      reportDelivery: admission,
    };
    let effectId = "";
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO) => {
      effectId = owner.openPlaneEffects()[0]!.id;
      expect(await owner.compareAndReplaceUnit(unit, ended, 2000)).toEqual({ ok: true });
      expect(await owner.compareAndReplaceUnit(ended, unit, 2001)).toEqual({ ok: false, reason: "stale" });
    });
    const ledger = {
      appendSession: async (
        sessionKey: string,
        rowId: string,
        rows: Array<{ part: number; json: string }>,
        context?: ContextDependencies,
      ) => env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)).appendKeyed(rowId, rows, context),
      readSessionEntry: async (sessionKey: string, rowId: string) =>
        env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)).readEntry(rowId),
    };
    const store = {
      get: async () =>
        (await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data.instance as CoordinatorInstance,
      listUnits: async () =>
        (await post("/runs/coordinator/units/list", { storeKey: key, instanceId: instance.id })).data
          .units as CoordinatorUnit[],
      getMainTask: async () => null,
    };
    const status = await appendCoordinatorStatus(
      { ledger, instances: store },
      { owner: reportOwner, instance, unit: ended },
    );
    expect(status).toBeDefined();
    const publicDelivery = await coordinatorPublicDeliveryReference(admission, proposal.threadText);
    const ack = (reportDelivery = admission, delivery: unknown = publicDelivery) =>
      post("/plane/ack", {
        storeKey: key,
        id: effectId,
        outcome: "done",
        reconciliation: { reportDelivery, status, ...(delivery === null ? {} : { publicDelivery: delivery }) },
      });
    expect((await ack()).status).toBe(409); // Status alone is not canonical report durability.
    expect(await freezeAdmittedCoordinatorReport(ledger, admission, reportOwner, proposal)).toEqual(proposal);
    expect((await ack({ ...admission, proposalHash: "b".repeat(64) })).status).toBe(409);
    expect((await ack(admission, null)).status).toBe(409); // Frozen prose is not a channel reply ACK.
    expect((await ack()).status).toBe(409); // A reference alone is not durable proof.
    expect(await appendCoordinatorPublicDelivery(ledger, publicDelivery)).toEqual(publicDelivery);
    expect((await ack(admission, { ...publicDelivery, threadHash: "f".repeat(64) })).status).toBe(409);
    expect(
      (await ack(admission, { ...publicDelivery, owner: { ...reportOwner, requester: "slack:UOTHER" } })).status,
    ).toBe(409);
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `UPDATE coordinator_units SET json = ? WHERE instance_id = ? AND unit = ?`,
        JSON.stringify({ ...ended, ending: { ...ended.ending, deliveryId: "different/end" } }),
        instance.id,
        unit.unit,
      );
    });
    expect((await ack()).status).toBe(409);
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `UPDATE coordinator_units SET json = ? WHERE instance_id = ? AND unit = ?`,
        JSON.stringify(ended),
        instance.id,
        unit.unit,
      );
    });
    expect((await ack()).status).toBe(200);
    expect((await ack()).status).toBe(200); // Lost ACK is idempotent.
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO) => {
      expect(owner.openPlaneEffects()).toEqual([]);
      expect(await owner.offerCoordinatorReconciliation(instance.id, unit.unit, 2100)).toEqual({ offered: false });
      expect(await owner.compareAndReplaceUnit(ended, unit, 2101)).toEqual({ ok: true });
    });
  });
  it("admits only the first report owner on an unchanged saved ending while the durable offer remains pending", async () => {
    const key = storeKey();
    await seed(key);
    const ended: CoordinatorUnit = {
      ...unit,
      ending: {
        kind: "aborted",
        report: "Original report",
        threadReport: "Original summary",
        deliveryId: "original/end",
        at: 2000,
      },
    };
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO) => {
      expect(await owner.compareAndReplaceUnit(unit, ended, 2000)).toEqual({ ok: true });
    });
    await native(key, "errored");
    await post("/runs/coordinator/reconcile/offer", { storeKey: key, instanceId: instance.id, unit: unit.unit });
    const admission = await coordinatorReportAdmission(
      {
        instanceId: instance.id,
        unit: unit.unit,
        requester: instance.userId,
        channelId: instance.channelId,
        threadKey: instance.threadKey,
        attempt: 0,
        deliveryId: ended.ending!.deliveryId!,
      },
      { text: ended.ending!.report, threadText: ended.ending!.threadReport! },
    );
    const admitted = { ...ended, reportDelivery: admission };
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO) => {
      expect(owner.openPlaneEffects()).toHaveLength(1);
      expect(
        await owner.compareAndReplaceUnit(
          ended,
          { ...admitted, ending: { ...ended.ending!, report: "Changed" } },
          2001,
        ),
      ).toEqual({ ok: false, reason: "stale" });
      expect(await owner.compareAndReplaceUnit(ended, admitted, 2002)).toEqual({ ok: true });
      expect(
        await owner.compareAndReplaceUnit(
          admitted,
          { ...admitted, reportDelivery: { ...admission, proposalHash: "b".repeat(64) } },
          2003,
        ),
      ).toEqual({ ok: false, reason: "stale" });
      expect(await owner.listUnits(instance.id)).toEqual([admitted]);
      expect(owner.openPlaneEffects()).toHaveLength(1);
    });
  });
  it("bounds discovery with a persisted cursor and re-arms after an alarm failure while maintenance is paused", async () => {
    const key = storeKey();
    await seed(key);
    await native(key, "terminated");
    const rows = Array.from({ length: 20 }, (_, i) => ({
      ...unit,
      unit: `U${String(i + 1).padStart(2, "0")}`,
      slug: `u${i + 1}`,
    }));
    await post("/runs/coordinator/units/put", { storeKey: key, units: rows });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO, state) => {
      await owner.alarm();
      expect(owner.openPlaneEffects()).toHaveLength(16);
      expect(
        state.storage.sql.exec(`SELECT value FROM meta WHERE key = 'coordinator_reconcile_cursor'`).toArray(),
      ).toHaveLength(1);
      await owner.alarm();
      expect(owner.openPlaneEffects()).toHaveLength(21);
      for (let i = 0; i < 33; i++)
        state.storage.sql.exec(
          `INSERT INTO plane_effects(id, body_json, offered_at, acked_at) VALUES (?, ?, 0, NULL)`,
          `reissue:old_${i}`,
          JSON.stringify({
            id: `reissue:old_${i}`,
            kind: "reissue",
            instanceId: `old_${i}`,
            attempt: 1,
            units: ["ONE"],
          }),
        );
      const pushes: Array<{ kind: string }[]> = [];
      const holder = owner as unknown as { env: Record<string, unknown> };
      holder.env = {
        ...holder.env,
        BOT: {
          fetch: async (_url: string, init: { body: string }) => {
            pushes.push(JSON.parse(init.body).effects);
            return new Response("ok");
          },
        },
      };
      expect(owner.openPlaneEffects().every((effect) => effect.kind === "reissue")).toBe(true);
      await owner.alarm();
      await vi.waitFor(() =>
        expect(pushes.flat().filter((effect) => effect.kind === "coordinator_reconcile")).toHaveLength(21),
      );
      await vi.waitFor(() => expect(() => assertNoPendingBackgroundTasks()).not.toThrow());
      const mutable = owner as unknown as { discoverCoordinatorWorkflows(now: number): Promise<void> };
      const original = mutable.discoverCoordinatorWorkflows;
      mutable.discoverCoordinatorWorkflows = async () => {
        throw new Error("native status unavailable");
      };
      await state.storage.deleteAlarm();
      try {
        await expect(owner.alarm()).rejects.toThrow("native status unavailable");
      } finally {
        mutable.discoverCoordinatorWorkflows = original;
      }
      expect(await state.storage.getAlarm()).not.toBeNull();
      expect(
        Number(
          state.storage.sql
            .exec<{ n: number }>(
              `SELECT COUNT(*) AS n FROM plane_effects WHERE json_extract(body_json, '$.kind') = 'coordinator_reconcile' AND acked_at IS NULL`,
            )
            .one().n,
        ),
      ).toBe(21);
    });
  });
  it("refuses only the exact absent recovery without consuming its source and fences later check events", async () => {
    const key = storeKey();
    await seed(key);
    const ended: CoordinatorUnit = { ...unit, ending: { kind: "aborted", report: "Original report", at: 1100 } };
    const { ending, ...active } = ended;
    const replacement: CoordinatorUnit = {
      ...active,
      recovery: {
        kind: "review",
        round: 1,
        expectedHeadSha: "a".repeat(40),
        remainingMs: 1000,
        claimedAt: 1200,
        deadlineAt: 2200,
        step: "ROOT/recovery/1/review",
        reviewRunId: "original_review",
        reviewKey: "original_review_key",
        previousEnding: ending!,
        workflowId: "exact_recovery",
      },
    };
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    let claimed: CoordinatorUnit | undefined;
    await runInDurableObject(stub, async (owner: RunHistoryDO) => {
      expect(await owner.compareAndReplaceUnit(unit, ended, 1100)).toEqual({ ok: true });
      const result = await owner.transitionRecovery(
        {
          kind: "claim",
          expected: ended,
          replacement,
          request: { userId: instance.userId, threadKey: instance.threadKey, messageId: "slack:C1:2.0" },
        },
        1200,
      );
      expect(result.ok).toBe(true);
      if (result.ok) claimed = result.unit;
    });
    const guard = { actionId: claimed!.recovery!.actionId!, workflowId: "exact_recovery" };
    await native(key, "errored");
    await runInDurableObject(stub, async (owner: RunHistoryDO) => {
      expect(await owner.offerCoordinatorReconciliation(instance.id, unit.unit, 1250)).toEqual({ offered: false });
      expect(owner.openPlaneEffects()).toEqual([]);
    });
    const address = { instanceId: instance.id, unit: unit.unit };
    expect(
      (await post("/runs/coordinator/recovery/action", { storeKey: key, key: address, actionId: guard.actionId })).data,
    ).toMatchObject({ action: { id: guard.actionId, workflowId: guard.workflowId } });
    expect(
      (
        await post("/runs/coordinator/recovery/action", {
          storeKey: key,
          key: { ...address, unit: "OTHER" },
          actionId: guard.actionId,
        })
      ).data,
    ).toEqual({ action: null });
    expect(
      (
        await post("/runs/coordinator/recovery/action", {
          storeKey: key,
          key: address,
          actionId: guard.actionId,
          request: {},
        })
      ).status,
    ).toBe(400);
    const event = { id: "check-settled", sender: "github:checks", mode: "steer", text: "Checks settled", at: 1300 };
    const append = (exact = guard) =>
      post("/runs/coordinator/events/append", {
        storeKey: key,
        instanceId: instance.id,
        unit: unit.unit,
        requireActive: true,
        expectedRecovery: exact,
        event,
      });
    expect((await append({ ...guard, workflowId: "other_recovery" })).status).toBe(409);
    expect((await append()).status).toBe(200);
    await runInDurableObject(stub, async (owner: RunHistoryDO) => {
      const holder = owner as unknown as { env: Record<string, unknown> };
      holder.env = {
        ...holder.env,
        SHIP_COORDINATOR: {
          get: async () => {
            throw new Error("instance.not_found");
          },
        },
      };
      await owner.offerCoordinatorReconciliation(instance.id, unit.unit, 1400);
      const row = (await owner.listUnits(instance.id))[0]!;
      expect(row.ending).toEqual(ended.ending);
      expect(row.recovery).toBeUndefined();
      const action = await owner.getRecoveryAction(row, {
        userId: instance.userId,
        threadKey: instance.threadKey,
        messageId: "slack:C1:2.0",
      });
      expect(action).toMatchObject({ state: "refused", consumed: false });
      expect(owner.openPlaneEffects()).toEqual([]);
    });
    expect((await append()).status).toBe(409); // A duplicate event cannot bypass the retired action fence.
  });
  it("holds private completion until the exact durable worker reply matches the frozen report", async () => {
    const key = storeKey();
    const privateInstance: CoordinatorInstance = { ...instance, plan: { id: "private-reconcile" }, merge: "person" };
    const taskKey = { mainThreadKey: instance.threadKey, actId: "private-reconcile" };
    const taskUnit: CoordinatorUnit = {
      ...unit,
      workBrief: {
        requesterId: instance.userId,
        mainThreadKey: instance.threadKey,
        actId: taskKey.actId,
        repo: instance.repo,
        base: instance.base!,
        question: "What happened?",
        findings: [],
        requestedChange: "Resolve this work",
      },
    };
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (owner: RunHistoryDO) => {
      await owner.recordRequesterTurn({
        threadKey: instance.threadKey,
        requesterId: instance.userId,
        messageId: "2.0",
      });
      expect(
        (
          await owner.claimMainTask(
            taskKey,
            privateInstance,
            taskUnit,
            { requesterId: instance.userId, sourceMessageId: "2.0", revision: 1, repo: instance.repo },
            1000,
          )
        ).ok,
      ).toBe(true);
    });
    await native(key, "errored");
    await post("/runs/coordinator/reconcile/offer", { storeKey: key, instanceId: instance.id, unit: unit.unit });
    const reportOwner = {
      instanceId: instance.id,
      unit: unit.unit,
      attempt: 0,
      requester: instance.userId,
      channelId: instance.channelId,
      threadKey: `worker:${instance.id}:${unit.unit}`,
      deliveryId: "private-end",
    };
    const proposal = { text: "Original private report", threadText: "Original private summary" };
    const reportDelivery = await coordinatorReportAdmission(reportOwner, proposal);
    const ended = {
      ...taskUnit,
      ending: { kind: "aborted", report: proposal.text, at: 2000, deliveryId: "private-end" },
      reportDelivery,
    };
    let effectId = "";
    await runInDurableObject(stub, async (owner: RunHistoryDO) => {
      effectId = owner.openPlaneEffects()[0]!.id;
      expect(await owner.compareAndReplaceUnit(taskUnit, ended, 2000)).toEqual({ ok: true });
    });
    const ledger = {
      appendSession: async (
        sessionKey: string,
        rowId: string,
        rows: Array<{ part: number; json: string }>,
        context?: ContextDependencies,
      ) => env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)).appendKeyed(rowId, rows, context),
      readSessionEntry: async (sessionKey: string, rowId: string) =>
        env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)).readEntry(rowId),
    };
    const store = {
      get: async () =>
        (await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data.instance as CoordinatorInstance,
      listUnits: async () =>
        (await post("/runs/coordinator/units/list", { storeKey: key, instanceId: instance.id })).data
          .units as CoordinatorUnit[],
      getMainTask: async () =>
        (await post("/runs/coordinator/main-task/get", { storeKey: key, key: taskKey })).data.link as {
          instanceId: string;
          unit: string;
          authority: { requesterId: string; sourceMessageId: string; revision: number; repo: string };
        },
    };
    await freezeAdmittedCoordinatorReport(ledger, reportDelivery, reportOwner, proposal);
    const status = await appendCoordinatorStatus(
      { ledger, instances: store },
      { owner: reportOwner, instance: privateInstance, unit: ended },
    );
    expect(status).toBeDefined();
    const ack = () =>
      post("/plane/ack", {
        storeKey: key,
        id: effectId,
        outcome: "done",
        reconciliation: { reportDelivery, status, privateReplyId: "private-end" },
      });
    expect((await ack()).status).toBe(409);
    await runInDurableObject(stub, async (owner: RunHistoryDO) => {
      await owner.appendPrivateWorkerEvent(reportOwner.threadKey, {
        kind: "reply",
        id: "other-end",
        text: proposal.text,
        at: 2000,
      });
    });
    expect((await ack()).status).toBe(409);
    await runInDurableObject(stub, async (owner: RunHistoryDO) => {
      await owner.appendPrivateWorkerEvent(reportOwner.threadKey, {
        kind: "reply",
        id: "private-end",
        text: proposal.text,
        at: 2000,
      });
    });
    expect((await ack()).status).toBe(200);
  });
});

describe("run ledger — alarm retention of live events", () => {
  it("abandon syncs only range pins touched by the abandoned run", async () => {
    const key = storeKey();
    const runId = "abandon-pin-owner";
    expect(await post("/runs/claim", claimBody(key, runId, "slack:C1:abandon-pin-owner"))).toMatchObject({
      status: 200,
    });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (instance: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO sessions (key, thread_key) VALUES (?, ?)`,
        "slack:C1:unrelated:review",
        "slack:C1:unrelated",
      );
      const touched = "slack:C1:abandon-pin-owner:review";
      const source = "slack:C1:abandon-pin-source:review";
      state.storage.sql.exec(
        `INSERT INTO context_refs (holder_run_id, source_run_id, session_key) VALUES (?, ?, ?)`,
        runId,
        runId,
        touched,
      );
      state.storage.sql.exec(
        `INSERT INTO context_refs (holder_run_id, source_run_id, session_key) VALUES (?, ?, ?)`,
        "another-holder",
        runId,
        source,
      );
      const subject = instance as unknown as { syncRangePins: (keys?: readonly string[]) => Promise<void> };
      const sync = subject.syncRangePins;
      const calls: Array<readonly string[] | undefined> = [];
      subject.syncRangePins = async (keys) => {
        calls.push(keys);
      };
      try {
        expect(await instance.abandon(runId, "g1")).toEqual({ ok: true });
      } finally {
        subject.syncRangePins = sync;
      }
      expect(calls).toEqual([[touched, source]]);
    });
  });

  it("abandon without range pins does not sweep other session logs", async () => {
    const key = storeKey();
    const runId = "abandon-without-pins";
    expect(await post("/runs/claim", claimBody(key, runId, "slack:C1:abandon-without-pins"))).toMatchObject({
      status: 200,
    });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (instance: RunHistoryDO) => {
      const subject = instance as unknown as { syncRangePins: (keys?: readonly string[]) => Promise<void> };
      const sync = subject.syncRangePins;
      subject.syncRangePins = async () => {
        throw new Error("unrelated range pins swept");
      };
      try {
        expect(await instance.abandon(runId, "wrong-generation")).toEqual({ ok: false, reason: "fenced" });
        expect(await instance.abandon(runId, "g1")).toEqual({ ok: true });
      } finally {
        subject.syncRangePins = sync;
      }
    });
  });

  it("keeps scheduled cleanup paused while the alarm serves live work", async () => {
    const key = storeKey();
    const runId = "paused-alarm-live";
    expect(await post("/runs/claim", claimBody(key, runId, "slack:C1:paused-alarm"))).toMatchObject({ status: 200 });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (instance: RunHistoryDO, state) => {
      state.storage.sql.exec(`INSERT INTO run_events (run_id, seq, json) VALUES (?, 1, '{}')`, "paused-orphan");
      state.storage.sql.exec(
        `INSERT INTO context_refs (holder_run_id, source_run_id) VALUES (?, ?)`,
        "missing-holder",
        "missing-source",
      );
      state.storage.sql.exec(
        `INSERT INTO intake_receipts (key, thread_key, decided_at, prune_after, json) VALUES (?, ?, 1, 1, '{}')`,
        "expired-receipt",
        "slack:C1:paused-alarm",
      );
      state.storage.sql.exec(
        `INSERT INTO sessions (key, thread_key) VALUES (?, ?)`,
        "slack:C1:paused-alarm:coding",
        "slack:C1:paused-alarm",
      );
      const subject = instance as unknown as {
        env: { RUN_HISTORY_MAINTENANCE?: string };
        trim: () => never;
        syncRangePins: () => never;
        sweepSessions: () => never;
      };
      const prior = subject.env.RUN_HISTORY_MAINTENANCE;
      const trim = subject.trim;
      const pins = subject.syncRangePins;
      const sessions = subject.sweepSessions;
      subject.env.RUN_HISTORY_MAINTENANCE = "paused";
      subject.trim = () => {
        throw new Error("scheduled trim ran");
      };
      subject.syncRangePins = () => {
        throw new Error("scheduled pin walk ran");
      };
      subject.sweepSessions = () => {
        throw new Error("scheduled session drop ran");
      };
      try {
        await instance.alarm();
      } finally {
        subject.env.RUN_HISTORY_MAINTENANCE = prior;
        subject.trim = trim;
        subject.syncRangePins = pins;
        subject.sweepSessions = sessions;
      }
      expect(
        state.storage.sql.exec(`SELECT run_id FROM run_events WHERE run_id = 'paused-orphan'`).toArray(),
      ).toHaveLength(1);
      expect(
        state.storage.sql
          .exec(`SELECT holder_run_id FROM context_refs WHERE holder_run_id = 'missing-holder'`)
          .toArray(),
      ).toHaveLength(1);
      expect(
        state.storage.sql.exec(`SELECT key FROM intake_receipts WHERE key = 'expired-receipt'`).toArray(),
      ).toHaveLength(1);
      expect(
        state.storage.sql.exec(`SELECT key FROM sessions WHERE key = 'slack:C1:paused-alarm:coding'`).toArray(),
      ).toHaveLength(1);
    });
    expect((await post("/runs/live", { storeKey: key })).data.runs).toEqual(
      expect.arrayContaining([expect.objectContaining({ runId })]),
    );
    expect(await post("/runs/coordinator/get", { storeKey: key, id: "unknown-plan" })).toMatchObject({ status: 200 });
    expect(
      await post("/runs/session/append", {
        storeKey: key,
        key: "slack:C1:paused-alarm:coding",
        rowId: "after-alarm",
        rows: [{ part: 0, json: JSON.stringify({ role: "user", part: { type: "text", text: "still here" } }) }],
      }),
    ).toMatchObject({ status: 200, data: { ok: true, appended: true } });
  });

  it("keeps an unfinished run's events while pruning orphaned event rows", async () => {
    const key = storeKey();
    const runId = "alarm-live";
    expect(await post("/runs/claim", claimBody(key, runId, "slack:C1:alarm-live"))).toMatchObject({ status: 200 });
    expect(
      await post("/runs/append", {
        storeKey: key,
        runId,
        gen: "g1",
        events: [{ type: "tool_call", tool: "bash", summary: "unsealed work", seq: 1 }],
      }),
    ).toMatchObject({ status: 200 });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO run_events (run_id, seq, json) VALUES (?, ?, ?)`,
        "alarm-orphan",
        1,
        JSON.stringify({ type: "tool_call", tool: "bash", summary: "orphan", seq: 1 }),
      );
    });

    await runInDurableObject(stub, (instance: RunHistoryDO) => instance.alarm());

    expect((await post("/runs/live", { storeKey: key })).data.runs).toEqual([expect.objectContaining({ runId })]);
    expect((await post("/runs/live-events", { storeKey: key, runId })).data.events).toEqual([
      expect.objectContaining({ seq: 1, summary: "unsealed work" }),
    ]);
    const orphan = await runInDurableObject(stub, async (_instance: RunHistoryDO, state) =>
      state.storage.sql.exec(`SELECT seq FROM run_events WHERE run_id = ?`, "alarm-orphan").toArray(),
    );
    expect(orphan).toEqual([]);
  });
});

describe("exact owner evidence for resident preservation", () => {
  it("rolls back terminal history and owner removal when retained workspace versions reach capacity", async () => {
    const key = storeKey();
    const runId = "capacity-workspace";
    const threadKey = "slack:C1:capacity-workspace";
    const owner = { runId, ownerGen: "g1", ownerFence: 7 };
    const binding = {
      backend: "resident",
      ownerGen: "g1",
      ownerFence: 7,
      ref: "codex/r1",
      workspace: "/workspace/threads/t/r1",
      user: "worker2",
      container: "vm-1",
    };
    const publication = { version: 1, repo: "owner/name", branches: [], complete: true };
    const terminal = { ...record(runId, threadKey), repo: "owner/name" };
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      for (let revision = 1; revision <= 20; revision++)
        state.storage.sql.exec(
          `INSERT INTO workspace_settlements (owner_key, revision, json) VALUES (?, ?, ?)`,
          JSON.stringify([runId, "g1", 7]),
          revision,
          JSON.stringify({
            version: 1,
            revision,
            owner,
            binding,
            publication,
            record: { id: runId, threadKey, userId: terminal.userId, status: "interrupted", repo: "owner/name" },
          }),
        );
    });
    await post(
      "/runs/claim",
      claimBody(key, runId, threadKey, "g1", { state: { binding, branchPublication: publication } }),
    );
    await expect(
      runInDurableObject(stub, (instance: RunHistoryDO) => instance.finish(runId, "g1", terminal)),
    ).rejects.toThrow("workspace obligation capacity exhausted");
    expect((await post("/runs/preservation-owner", { storeKey: key, ...owner })).data.kind).toBe("live");
    const stored = await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => ({
      history: state.storage.sql.exec(`SELECT run_id FROM runs WHERE run_id = ?`, runId).toArray(),
      versions: state.storage.sql
        .exec(
          `SELECT revision FROM workspace_settlements WHERE allocation_json IS NULL OR json IS NOT NULL ORDER BY revision`,
        )
        .toArray(),
    }));
    expect(stored.history).toEqual([]);
    expect(stored.versions).toHaveLength(20);
  });
  it("keeps each unverified terminal version when a later segment completes and refuses a different terminal thread", async () => {
    const key = storeKey();
    const runId = "prior-unverified";
    const threadKey = "slack:C1:prior-unverified";
    const owner = { runId, ownerGen: "g1", ownerFence: 7 };
    const binding = {
      backend: "resident",
      ownerGen: "g1",
      ownerFence: 7,
      ref: "codex/r1",
      workspace: "/workspace/threads/t/r1",
      user: "worker2",
      container: "vm-1",
    };
    const publication = { version: 1, repo: "owner/name", branches: [], complete: true };
    const claim = claimBody(key, runId, threadKey, "g1", {
      state: { binding, branchPublication: publication, publicationSettlement: { version: 2 } },
    });
    await post("/runs/claim", claim);
    expect(
      (
        await post("/runs/finish", {
          storeKey: key,
          runId,
          gen: "g1",
          record: { ...record(runId, "slack:OTHER:1.0"), repo: "owner/name" },
        })
      ).status,
    ).toBe(409);
    expect((await post("/runs/preservation-owner", { storeKey: key, ...owner })).data.kind).toBe("live");
    const terminal = { ...record(runId, threadKey), repo: "owner/name", startedAt: 1000, finishedAt: 2000 };
    expect(
      (await post("/runs/finish", { storeKey: key, runId, gen: "g1", record: { ...terminal, provisional: true } }))
        .status,
    ).toBe(409);
    expect((await post("/runs/preservation-owner", { storeKey: key, ...owner })).data.kind).toBe("live");
    await post("/runs/finish", { storeKey: key, runId, gen: "g1", record: terminal });
    await post(
      "/runs/claim",
      claimBody(key, runId, threadKey, "g1", { state: { binding, branchPublication: publication } }),
    );
    await post("/runs/finish", { storeKey: key, runId, gen: "g1", record: terminal });
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toEqual({
      ok: false,
      reason: "unverified",
    });
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 2 })).data).toEqual({ ok: true });
    expect((await post("/runs/preservation-owner", { storeKey: key, ...owner })).data.settlement).toMatchObject({
      revision: 1,
      record: { publicationSettlement: null },
    });
  });
  it("never reports all versions acknowledged when a newer retained version is corrupt", async () => {
    const key = storeKey();
    const owner = { runId: "corrupt-newer", ownerGen: "g1", ownerFence: 7 };
    const ownerKey = JSON.stringify([owner.runId, owner.ownerGen, owner.ownerFence]);
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO workspace_settlements (owner_key, revision, json) VALUES (?, 1, NULL), (?, 2, ?)`,
        ownerKey,
        ownerKey,
        "corrupt",
      );
    });
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toEqual({ ok: true });
    expect((await post("/runs/preservation-owner", { storeKey: key, ...owner })).data).toEqual({ kind: "unknown" });
  });
  it("keeps corrupt retained evidence under acknowledgment and refuses invalid owner inputs", async () => {
    const key = storeKey();
    const owner = { runId: "corrupt", ownerGen: "g1", ownerFence: 7 };
    const ownerKey = JSON.stringify([owner.runId, owner.ownerGen, owner.ownerFence]);
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      state.storage.sql.exec(`INSERT INTO workspace_settlements (owner_key, json) VALUES (?, ?)`, ownerKey, "corrupt");
    });
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toEqual({
      ok: false,
      reason: "unverified",
    });
    expect(
      await runInDurableObject(stub, async (_instance: RunHistoryDO, state) =>
        state.storage.sql.exec(`SELECT json FROM workspace_settlements WHERE owner_key = ?`, ownerKey).toArray(),
      ),
    ).toEqual([{ json: "corrupt" }]);
    expect((await post("/runs/preservation-owner", { storeKey: key, runId: owner.runId, ownerGen: "g1" })).status).toBe(
      400,
    );
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 0 })).status).toBe(400);
  });
  it.each(["immediate retention", "explicit deletion"] as const)(
    "retains the exact terminal workspace obligation through %s and acknowledges only its complete version",
    async (mode) => {
      const key = storeKey();
      const runId = "retained-workspace";
      const threadKey = "slack:C1:retained-workspace";
      const owner = { runId, ownerGen: "g1", ownerFence: 7 };
      const physical = {
        backend: "resident",
        ownerGen: "g1",
        ref: "codex/retained",
        workspace: "/workspace/threads/t/retained",
        user: "worker2",
        container: "vm-1",
        ownerFence: 7,
        publicationBaseSha: "a".repeat(40),
      };
      const publication = {
        version: 1,
        repo: "owner/name",
        branches: [{ ref: "codex/retained", pr: 7 }],
        complete: true as const,
      };
      expect(
        (
          await post(
            "/runs/claim",
            claimBody(key, runId, threadKey, "g1", { state: { binding: physical, branchPublication: publication } }),
          )
        ).status,
      ).toBe(200);
      const terminal = {
        ...record(runId, threadKey),
        repo: "owner/name",
        ...(mode === "immediate retention" ? { startedAt: 1_000, finishedAt: 2_000 } : {}),
      };
      const result = await post("/runs/finish", { storeKey: key, runId, gen: "g1", record: terminal });
      expect(result).toMatchObject({ status: 200, data: { ok: true, stored: mode !== "immediate retention" } });
      if (mode === "explicit deletion")
        await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (instance: RunHistoryDO) => {
          await instance.delete(runId);
        });
      const read = () => post("/runs/preservation-owner", { storeKey: key, ...owner });
      const deployState = (observed: unknown) =>
        deployRegistrationState({
          threadKey,
          registration: { threadKey, ...owner },
          fence: owner,
          owner: observed,
        });
      const receipt = await read();
      expect(receipt.data).toMatchObject({
        kind: "terminal",
        settlement: {
          revision: 1,
          owner,
          binding: physical,
          publication,
          record: { id: runId, threadKey, status: "completed" },
        },
      });
      expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 2 })).data).toMatchObject({
        ok: false,
        reason: "stale",
      });
      expect((await read()).data.settlement).toEqual(receipt.data.settlement);
      expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toEqual({ ok: true });
      expect((await read()).data).toEqual({ kind: "acknowledged", owner, revision: 1 });
      expect(deployState((await read()).data)).toBe("retained");
      expect(
        deployState((await post("/runs/preservation-owner", { storeKey: key, ...owner, ownerFence: 8 })).data),
      ).toBe("unknown");
      expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toEqual({ ok: true });
      expect(
        (
          await post(
            "/runs/claim",
            claimBody(key, runId, threadKey, "g1", { state: { binding: physical, branchPublication: publication } }),
          )
        ).status,
      ).toBe(200);
      // The actual producer checks the new live row before old retained ACKs.
      expect((await read()).data).toMatchObject({ kind: "live", row: { runId, ownerGen: "g1" } });
      expect(deployState((await read()).data)).toBe("executing");
      expect((await post("/runs/finish", { storeKey: key, runId, gen: "g1", record: terminal })).status).toBe(200);
      expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toEqual({
        ok: true,
      });
      expect((await read()).data.settlement).toMatchObject({ revision: 2, owner });
    },
  );

  it("retains invalid binding and saved proof as unverified and checks the owner stored under an acknowledgment key", async () => {
    const key = storeKey();
    const runId = "invalid-workspace";
    const threadKey = "slack:C1:invalid-workspace";
    const owner = { runId, ownerGen: "g1", ownerFence: 7 };
    const state = {
      binding: {
        backend: "resident",
        ownerGen: "g1",
        ownerFence: 7,
        ref: "codex/r1",
        workspace: "/workspace/threads/t/r1",
        user: "worker2",
      },
      branchPublication: { version: 1, repo: "owner/name", branches: [], complete: true },
      publicationSettlement: { version: 2 },
    };
    await post("/runs/claim", claimBody(key, runId, threadKey, "g1", { state }));
    await post("/runs/finish", {
      storeKey: key,
      runId,
      gen: "g1",
      record: { ...record(runId, threadKey), repo: "owner/name", startedAt: 1000, finishedAt: 2000 },
    });
    const receipt = (await post("/runs/preservation-owner", { storeKey: key, ...owner })).data.settlement as Record<
      string,
      unknown
    >;
    expect(receipt).toMatchObject({ owner, binding: null, record: { publicationSettlement: null } });
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toEqual({
      ok: false,
      reason: "unverified",
    });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    const ownerKey = JSON.stringify([owner.runId, owner.ownerGen, owner.ownerFence]);
    await runInDurableObject(stub, async (_instance: RunHistoryDO, storage) => {
      storage.storage.sql.exec(
        `UPDATE workspace_settlements SET json = ? WHERE owner_key = ?`,
        JSON.stringify({ ...receipt, owner: { ...owner, ownerFence: 8 } }),
        ownerKey,
      );
    });
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toEqual({
      ok: false,
      reason: "unverified",
    });
    expect((await post("/runs/preservation-owner", { storeKey: key, ...owner })).data).toEqual({ kind: "unknown" });
  });

  it("retains incomplete publication and refuses workspace acknowledgment under a live or mismatched owner", async () => {
    const key = storeKey();
    const runId = "unresolved-workspace";
    const threadKey = "slack:C1:unresolved-workspace";
    const owner = { runId, ownerGen: "g1", ownerFence: 7 };
    const state = {
      binding: {
        backend: "resident",
        ownerGen: "g1",
        ref: "codex/retained",
        workspace: "/workspace/threads/t/retained",
        user: "worker2",
        container: "vm-1",
        ownerFence: 7,
        publicationBaseSha: "a".repeat(40),
      },
      branchPublication: {
        version: 1,
        repo: "owner/name",
        branches: [],
        complete: false,
        pending: { id: "unconfirmed", ref: "codex/retained", headSha: "b".repeat(40) },
      },
    };
    expect((await post("/runs/claim", claimBody(key, runId, threadKey, "g1", { state }))).status).toBe(200);
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toMatchObject({
      ok: false,
      reason: "owner-live",
    });
    expect(
      (
        await post("/runs/finish", {
          storeKey: key,
          runId,
          gen: "g1",
          record: { ...record(runId, threadKey), repo: "owner/name", finishedAt: 2_000 },
        })
      ).status,
    ).toBe(200);
    const read = () => post("/runs/preservation-owner", { storeKey: key, ...owner });
    expect((await read()).data).toMatchObject({
      kind: "terminal",
      settlement: { publication: state.branchPublication },
    });
    expect((await post("/runs/workspace-ack", { storeKey: key, ...owner, revision: 1 })).data).toMatchObject({
      ok: false,
      reason: "unverified",
    });
    expect((await post("/runs/preservation-owner", { storeKey: key, ...owner, ownerFence: 8 })).data).toEqual({
      kind: "absent",
      owner: { ...owner, ownerFence: 8 },
    });
    expect((await read()).data).toMatchObject({ settlement: { revision: 1 } });
  });

  it("returns the live owner before a stored summary, then only a non-provisional terminal row", async () => {
    const key = storeKey();
    const runId = "resident-preservation-owner";
    const threadKey = "slack:C1:resident-preservation";
    const read = () => post("/runs/preservation-owner", { storeKey: key, runId });
    expect((await read()).data).toEqual({ kind: "unknown" });
    expect((await post("/runs/claim", claimBody(key, runId, threadKey))).status).toBe(200);
    expect((await read()).data).toMatchObject({ kind: "live", row: { runId, threadKey, ownerGen: "g1" } });
    const binding: PublicationBinding = {
      runId,
      instanceId: "instance-x",
      step: "instance-x:unit-x",
      repo: "owner/name",
      branch: "codex/preserved",
      requester: "slack:UALICE",
      threadKey,
      generation: "g1",
      baseHeadSha: "a".repeat(40),
    };
    const settlement: PublicationSettlement = {
      version: 1,
      binding,
      checkpoint: { kind: "created", head: "b".repeat(40) },
      publication: { kind: "not_attempted" },
      preservation: { kind: "saved", key: checkpointKey(binding, "b".repeat(40)), size: 128, sha256: "c".repeat(64) },
      release: { kind: "pending" },
    };
    expect(
      (
        await post("/runs/put", {
          storeKey: key,
          record: {
            ...record(runId, threadKey),
            repo: binding.repo,
            parentInstanceId: binding.instanceId,
            idempotencyKey: binding.step,
            publicationSettlement: settlement,
          },
        })
      ).status,
    ).toBe(200);
    expect((await read()).data.kind).toBe("live");
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      state.storage.sql.exec(`DELETE FROM live_runs WHERE run_id = ?`, runId);
    });
    expect((await read()).data).toMatchObject({
      kind: "terminal",
      record: { id: runId, threadKey, status: "completed", publicationSettlement: settlement },
    });
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `UPDATE runs SET summary_json = json_set(summary_json, '$.provisional', json('true')) WHERE run_id = ?`,
        runId,
      );
    });
    expect((await read()).data).toEqual({ kind: "unknown" });
    expect((await post("/runs/preservation-owner", { storeKey: key, runId: "../foreign" })).status).toBe(400);
  });
});

// Feature: docs/reference/specs/run-history.md items 28–34 — the live-run ledger on the
// RunHistoryDO: claim (one live run per thread), the fence on every owner
// write, step records, the inbox, stop, handoff, finishing, finish in one
// transaction, reclaim. Runs in workerd against the real SQLite object; a
// unique store key per test.

const BASE = "https://memory.test";
const AUTH = { authorization: "Bearer test-token", "content-type": "application/json" };

let n = 0;
const storeKey = () => `runs:ledger-${Date.now()}-${n++}`;

describe("private worker log on the state Worker", () => {
  it("stores ordered private history, replays an input id once, and refuses a changed replay", async () => {
    const key = storeKey();
    const threadKey = "worker:ship_private_1:U12";
    const input = { kind: "input", id: "step-1", sender: "slack:UA", text: "Fix signup", at: 10 };
    const append = (event: unknown) => post("/runs/private-worker/append", { storeKey: key, threadKey, event });
    const first = await append(input);
    expect(first).toMatchObject({ status: 200, data: { event: { ...input, seq: 1 } } });
    expect(await append({ ...input, at: 11 })).toEqual(first);
    expect((await append({ ...input, text: "other" })).status).toBe(409);
    const reply = { kind: "reply", id: "report-1", text: "\u0000".repeat(20_000), at: 20 };
    const settled = await append(reply);
    expect(settled).toMatchObject({
      status: 200,
      data: { event: { seq: 2, id: "report-1", kind: "reply", text: reply.text } },
    });
    expect(await append({ ...reply, at: 21 })).toEqual(settled);
    expect((await append({ ...reply, text: "Changed" })).status).toBe(409);
    const boundary = { kind: "reply", id: "boundary", text: "", at: 21 };
    boundary.text = "x".repeat(PRIVATE_WORKER_REPLY_MAX_CHARS - JSON.stringify(boundary).length - 1);
    expect(JSON.stringify(boundary).length).toBe(PRIVATE_WORKER_REPLY_MAX_CHARS - 1);
    expect((await append(boundary)).status).toBe(400);
    expect(await append({ kind: "status", phase: "start", frame: { title: "testing" }, at: 21 })).toMatchObject({
      status: 200,
      data: { event: { seq: 3, statusSeq: 3, kind: "status" } },
    });
    expect(
      await append({ kind: "status", phase: "done", statusSeq: 3, frame: { title: "done" }, at: 22 }),
    ).toMatchObject({ status: 200, data: { event: { seq: 4, statusSeq: 3 } } });
    expect(await post("/runs/private-worker/list", { storeKey: key, threadKey })).toMatchObject({
      status: 200,
      data: {
        events: [
          { seq: 1, kind: "input" },
          { seq: 2, kind: "reply" },
          { seq: 3, kind: "status" },
          { seq: 4, kind: "status" },
        ],
      },
    });
    const longInput = { ...input, id: "long-input", text: "shortened", textSha256: "a".repeat(64) };
    expect((await append(longInput)).status).toBe(200);
    expect((await append({ ...longInput, textSha256: "b".repeat(64) })).status).toBe(409);
    expect((await post("/runs/private-worker/list", { storeKey: key, threadKey: "slack:C1:1.0" })).status).toBe(400);
  });

  it("pages private events after a durable cursor with a fixed bound", async () => {
    const key = storeKey();
    const threadKey = "worker:ship_private_2:task";
    for (let index = 0; index < 5; index++) {
      expect(
        await post("/runs/private-worker/append", {
          storeKey: key,
          threadKey,
          event: { kind: "reply", text: `reply ${index}`, at: index },
        }),
      ).toMatchObject({ status: 200 });
    }
    const read = (afterSeq: number, limit: number) =>
      post("/runs/private-worker/list-after", { storeKey: key, threadKey, afterSeq, limit });
    expect(await read(0, 2)).toMatchObject({
      status: 200,
      data: { events: [{ seq: 1 }, { seq: 2 }], more: true },
    });
    expect(await read(2, 2)).toMatchObject({
      status: 200,
      data: { events: [{ seq: 3 }, { seq: 4 }], more: true },
    });
    expect(await read(4, 2)).toMatchObject({ status: 200, data: { events: [{ seq: 5 }], more: false } });
    expect((await read(-1, 2)).status).toBe(400);
    expect((await read(0, 33)).status).toBe(400);
  });
});

async function post(path: string, body: unknown, headers: Record<string, string> = AUTH) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return fetchMemoryTest(
    `${BASE}${path}`,
    {
      method: "POST",
      headers: { ...headers, "content-length": String(new TextEncoder().encode(raw).byteLength) },
      body: raw,
    },
    async (res) => {
      const text = await res.text();
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(text);
      } catch {
        // non-JSON: leave {}
      }
      return { status: res.status, data };
    },
  );
}

const ZERO = { count: 0, durationMs: 0 };

describe("historical original native adoption owner CAS", () => {
  it("admits a fourth verbose history and preserves standing, posting and ordinary ownership capacity", async () => {
    const key = storeKey(),
      stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (owner: RunHistoryDO, state) => {
      const first = "a".repeat(40),
        head = "b".repeat(40);
      const claims: CoordinatorUnit[] = [];
      for (let n = 0; n < 4; n++) {
        const id = `verbose_native_${n}`,
          thread = `slack:C1:verbose-native-${n}`,
          instanceId = `verbose-unit-${n}`,
          ref = `fix/verbose-native-${n}`;
        const terminal: RunRecord = {
          ...record(id, thread),
          agent: "coding",
          repo: "acme/api",
          parentInstanceId: instanceId,
          coordinatorUnit: "U12",
          coordinatorAttempt: 0,
          idempotencyKey: `${instanceId}:U12/0/coding`,
          headSha: head,
          pushed: [{ ref, sha: head, by: "push" }],
          branchPushReceipts: [{ ref, sha: head, by: "push" }],
          branchPublication: { version: 1, repo: "acme/api", branches: [], complete: false },
          publicationSettlement: {
            version: 1,
            binding: {
              runId: id,
              instanceId,
              step: `${instanceId}:U12/0/coding`,
              repo: "acme/api",
              branch: ref,
              requester: "slack:UALICE",
              threadKey: thread,
              generation: "g1",
              baseHeadSha: first,
            },
            checkpoint: { kind: "clean", head },
            publication: { kind: "not_attempted" },
            preservation: { kind: "pending" },
            release: { kind: "pending" },
          },
        };
        terminal.events = [
          { type: "coordinator_tag", parentInstanceId: instanceId, unit: "U12", base: "main", seq: 1 },
          { type: "run_meta", agent: "coding", repo: "acme/api", ref, headSha: first, seq: 2 },
          { type: "tool_call", tool: "publish_branch", callId: "native-call", summary: "publish", seq: 3 },
          { type: "publication_push_authorized", callId: "native-call", ref, expectedHeadSha: first, seq: 4 },
          { type: "pushed_head", ref, sha: head, by: "push", seq: 5 },
          {
            type: "tool_result",
            tool: "publish_branch",
            callId: "native-call",
            ok: true,
            summary: "published",
            seq: 6,
          },
          { type: "publication_settlement", settlement: terminal.publicationSettlement!, seq: 7 },
          ...Array.from({ length: 30 }, (_, i) =>
            i % 2 === 0
              ? {
                  type: "tool_result" as const,
                  tool: "bash",
                  callId: `display-${i}`,
                  ok: true,
                  summary: "output",
                  output: "x".repeat(47000),
                  seq: 8 + i,
                }
              : { type: "answer" as const, text: "x".repeat(47000), seq: 8 + i },
          ),
        ];
        terminal.eventCount = terminal.storedEventCount = terminal.events.length;
        const instance: CoordinatorInstance = {
          id: instanceId,
          kind: "ship",
          repo: "acme/api",
          base: "main",
          branch: ref,
          userId: terminal.userId,
          channelId: terminal.channelId,
          threadKey: thread,
          createdAt: terminal.startedAt - 100,
        };
        const unit: CoordinatorUnit = {
          instanceId,
          unit: "U12",
          slug: "u12",
          branch: ref,
          dependsOn: [],
          startedAt: terminal.startedAt - 1,
          rounds: [{ index: 0, agent: "coding", outcome: "aborted", at: terminal.finishedAt }],
          ending: { kind: "aborted", report: "not published", at: terminal.finishedAt + 1 },
          currentEffect: {
            version: 1,
            id: "U12/0/coding",
            ordinal: 1,
            phase: "settled",
            execution: { workflowId: instanceId },
            target: { repo: instance.repo, ref, base: "main", headSha: first },
            calls: [{ operation: "spawn", state: "accepted", runId: id }],
          },
        };
        expect(await owner.putInstance(instance)).toEqual({ ok: true });
        state.storage.sql.exec(
          `INSERT INTO coordinator_units(instance_id,unit,json,updated_at) VALUES(?,?,?,?)`,
          instanceId,
          unit.unit,
          JSON.stringify(unit),
          terminal.finishedAt,
        );
        expect(
          await owner.claim(
            {
              runId: id,
              threadKey: thread,
              gen: "g1",
              leaseMs: LEASE_MS,
              startedAt: terminal.startedAt,
              meta: {
                agent: "coding",
                channelId: terminal.channelId,
                userId: terminal.userId,
                threadKey: thread,
                repo: terminal.repo,
                parentInstanceId: instanceId,
                coordinatorUnit: unit.unit,
                coordinatorAttempt: 0,
                idempotencyKey: terminal.idempotencyKey,
              },
              card: null,
              system: "",
              tools: [],
              state: { branchPublication: terminal.branchPublication, branchPushReceipts: terminal.branchPushReceipts },
            },
            terminal.startedAt,
          ),
        ).toMatchObject({ ok: true });
        expect(await owner.finishing(id, "g1")).toEqual({ ok: true });
        expect((await owner.finish(id, "g1", terminal)).stored).toBe(true);
        const proof = await owner.prepareAdoptionAudit(unit, id);
        expect(proof).toBeDefined();
        const claimed: CoordinatorUnit = {
          ...unit,
          adoption: {
            version: 1,
            actionId: `large-action-${n}`,
            runId: id,
            headSha: head,
            requester: instance.userId,
            threadKey: thread,
            messageId: `source-${n}`,
            claimedAt: terminal.finishedAt + 2,
            state: "claimed",
            audit: proof!,
          },
        };
        expect(await owner.compareAndReplaceUnit(unit, claimed, terminal.finishedAt + 3)).toEqual({ ok: true });
        claims.push(claimed);
      }
      expect(await owner.findPullOwners({ repo: "acme/api", ref: claims[3].branch })).toMatchObject({ ok: true });
      expect(await owner.findPullOwners({ repo: "other/repo", ref: "fix/ordinary" })).toEqual({ ok: true, owners: [] });
      const last = claims[3],
        posting: CoordinatorUnit = { ...last, adoption: { ...last.adoption!, state: "posting" } };
      expect(await owner.compareAndReplaceUnit(last, posting, Date.now())).toEqual({ ok: true });
      const pr = { number: 777, url: "https://github.com/acme/api/pull/777" };
      const bound: CoordinatorUnit = {
        ...posting,
        pr,
        lastPush: head,
        publication: {
          repo: "acme/api",
          pr: pr.number,
          headRef: posting.branch,
          baseRef: "main",
          expectedHeadSha: head,
          publicationRef: posting.branch,
          owner: { instanceId: posting.instanceId, unit: posting.unit },
        },
        adoption: { ...posting.adoption!, state: "bound", pr },
      };
      expect(await owner.compareAndReplaceUnit(posting, bound, Date.now())).toEqual({ ok: true });
      const ordinary: CoordinatorInstance = {
        id: "ordinary-next",
        kind: "ship",
        repo: "acme/api",
        base: "main",
        branch: "fix/ordinary-next",
        userId: "slack:UALICE",
        channelId: "slack:C1",
        threadKey: "slack:C1:ordinary",
        createdAt: Date.now(),
      };
      expect(await owner.putInstance(ordinary)).toEqual({ ok: true });
      const next: CoordinatorUnit = {
        instanceId: ordinary.id,
        unit: "U99",
        slug: "u99",
        branch: ordinary.branch!,
        dependsOn: [],
        rounds: [],
        pr: { number: 888, url: "https://github.com/acme/api/pull/888" },
      };
      expect(await owner.putUnits([next], Date.now())).toEqual({ ok: true });
      const rival = { ...ordinary, id: "ordinary-rival", branch: "fix/ordinary-rival" };
      expect(await owner.putInstance(rival)).toEqual({ ok: true });
      expect(await owner.putUnits([{ ...next, instanceId: rival.id, branch: rival.branch! }], Date.now())).toEqual({
        ok: false,
        reason: "owned",
      });
      const changed = JSON.parse(
        state.storage.sql
          .exec<{ json: string }>(`SELECT json FROM run_events WHERE run_id='verbose_native_0' AND seq=4`)
          .one().json,
      );
      changed.expectedHeadSha = head;
      state.storage.sql.exec(
        `UPDATE run_events SET json=? WHERE run_id='verbose_native_0' AND seq=4`,
        JSON.stringify(changed),
      );
      expect(await owner.findPullOwners({ repo: "acme/api", ref: claims[0].branch })).toEqual({
        ok: false,
        reason: "incomplete",
      });
      changed.expectedHeadSha = first;
      state.storage.sql.exec(
        `UPDATE run_events SET json=? WHERE run_id='verbose_native_0' AND seq=4`,
        JSON.stringify(changed),
      );
      const malformed = JSON.parse(
        state.storage.sql
          .exec<{ json: string }>(`SELECT json FROM run_events WHERE run_id='verbose_native_0' AND seq=6`)
          .one().json,
      );
      malformed.ok = 1;
      state.storage.sql.exec(
        `UPDATE run_events SET json=? WHERE run_id='verbose_native_0' AND seq=6`,
        JSON.stringify(malformed),
      );
      expect(await owner.findPullOwners({ repo: "acme/api", ref: claims[0].branch })).toEqual({
        ok: false,
        reason: "incomplete",
      });
    });
  });
  it("validates canonical SQLite history before claiming, keeps the audit immutable and refuses stale or forged proof", async () => {
    const key = storeKey(),
      stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (owner: RunHistoryDO, state) => {
      const first = "a".repeat(40),
        head = "b".repeat(40),
        id = "original_native_writer",
        thread = "slack:C1:native-audit";
      const terminal: RunRecord = {
        ...record(id, thread),
        agent: "coding",
        repo: "acme/api",
        parentInstanceId: "original_native_unit",
        coordinatorUnit: "U12",
        coordinatorAttempt: 0,
        idempotencyKey: "original_native_unit:U12/0/coding",
        headSha: head,
        pushed: [{ ref: "fix/original-native", sha: head, by: "push" }],
        branchPushReceipts: [{ ref: "fix/original-native", sha: head, by: "push" }],
        branchPublication: { version: 1, repo: "acme/api", branches: [], complete: false },
        publicationSettlement: {
          version: 1,
          binding: {
            runId: id,
            instanceId: "original_native_unit",
            step: "original_native_unit:U12/0/coding",
            repo: "acme/api",
            branch: "fix/original-native",
            requester: "slack:UALICE",
            threadKey: thread,
            generation: "g1",
            baseHeadSha: first,
          },
          checkpoint: { kind: "clean", head },
          publication: { kind: "not_attempted" },
          preservation: { kind: "pending" },
          release: { kind: "pending" },
        },
      };
      terminal.events = [
        { type: "coordinator_tag", parentInstanceId: "original_native_unit", unit: "U12", base: "main", seq: 1 },
        { type: "run_meta", agent: "coding", repo: "acme/api", ref: "fix/original-native", headSha: first, seq: 2 },
        { type: "tool_call", tool: "publish_branch", callId: "native-call", summary: "publish", seq: 3 },
        {
          type: "publication_push_authorized",
          callId: "native-call",
          ref: "fix/original-native",
          expectedHeadSha: first,
          seq: 4,
        },
        { type: "pushed_head", ref: "fix/original-native", sha: head, by: "push", seq: 5 },
        { type: "tool_result", tool: "publish_branch", callId: "native-call", ok: true, summary: "published", seq: 6 },
        { type: "publication_settlement", settlement: terminal.publicationSettlement!, seq: 7 },
      ];
      terminal.eventCount = terminal.storedEventCount = terminal.events.length;
      const instance: CoordinatorInstance = {
        id: "original_native_unit",
        kind: "ship",
        repo: "acme/api",
        base: "main",
        branch: "fix/original-native",
        userId: terminal.userId,
        channelId: terminal.channelId,
        threadKey: thread,
        createdAt: terminal.startedAt - 100,
      };
      const unit: CoordinatorUnit = {
        instanceId: instance.id,
        unit: "U12",
        slug: "u1",
        branch: "fix/original-native",
        dependsOn: [],
        startedAt: terminal.startedAt - 1,
        rounds: [{ index: 0, agent: "coding", outcome: "aborted", at: terminal.finishedAt }],
        ending: { kind: "aborted", report: "not published", at: terminal.finishedAt + 1 },
        currentEffect: {
          version: 1,
          id: "U12/0/coding",
          ordinal: 1,
          phase: "settled",
          execution: { workflowId: instance.id },
          target: { repo: instance.repo, ref: "fix/original-native", base: "main", headSha: first },
          calls: [{ operation: "spawn", state: "accepted", runId: id }],
        },
      };
      expect(await owner.putInstance(instance)).toEqual({ ok: true });
      state.storage.sql.exec(
        `INSERT INTO coordinator_units(instance_id,unit,json,updated_at) VALUES(?,?,?,?)`,
        instance.id,
        unit.unit,
        JSON.stringify(unit),
        terminal.finishedAt,
      );
      expect(
        await owner.claim(
          {
            runId: id,
            threadKey: thread,
            gen: "g1",
            leaseMs: LEASE_MS,
            startedAt: terminal.startedAt,
            meta: {
              agent: "coding",
              channelId: terminal.channelId,
              userId: terminal.userId,
              threadKey: thread,
              repo: terminal.repo,
              parentInstanceId: instance.id,
              coordinatorUnit: unit.unit,
              coordinatorAttempt: 0,
              idempotencyKey: terminal.idempotencyKey,
            },
            card: null,
            system: "",
            tools: [],
            state: { branchPublication: terminal.branchPublication, branchPushReceipts: terminal.branchPushReceipts },
          },
          terminal.startedAt,
        ),
      ).toMatchObject({ ok: true });
      const resident = await owner.residentClaim(id, "g1", thread);
      expect(resident.ok).toBe(true);
      if (!resident.ok) throw new Error("resident fixture claim refused");
      const workspaceOwner = { runId: id, ownerGen: "g1", ownerFence: resident.fence };
      expect(
        await owner.setState(id, "g1", {
          branchPublication: terminal.branchPublication,
          branchPushReceipts: terminal.branchPushReceipts,
          publicationSettlement: terminal.publicationSettlement,
          binding: {
            backend: "resident",
            ownerGen: "g1",
            ownerFence: resident.fence,
            ref: "fix/original-native",
            publicationBaseSha: first,
            workspace: "/workspace/threads/original/work",
            user: "worker1",
            container: "fixture-container",
          },
        }),
      ).toEqual({ ok: true });
      expect(await owner.finishing(id, "g1")).toEqual({ ok: true });
      expect((await owner.finish(id, "g1", terminal)).stored).toBe(true);
      const before = await owner.get(id);
      const custody = await owner.preservationOwner(id, workspaceOwner);
      expect(custody).toMatchObject({ kind: "terminal", settlement: { revision: 1, owner: workspaceOwner } });
      expect(before).not.toBeNull();
      expect(historicalNativeChain({ instance, unit, record: before!, events: before!.events })).toEqual({
        firstHead: first,
        head,
      });
      const audit = (await owner.prepareAdoptionAudit(unit, id))!;
      expect(audit).toMatchObject({ firstHead: first, head, eventCount: 7 });
      const claimed: CoordinatorUnit = {
        ...unit,
        adoption: {
          version: 1,
          actionId: "original-native-audit",
          runId: id,
          headSha: head,
          requester: terminal.userId,
          threadKey: thread,
          messageId: "mcp:original-request",
          claimedAt: terminal.finishedAt + 2,
          state: "claimed",
          audit,
        },
      };
      expect(
        await owner.compareAndReplaceUnit(
          unit,
          { ...claimed, adoption: { ...claimed.adoption!, audit: { ...audit, eventDigest: "f".repeat(64) } } },
          terminal.finishedAt + 3,
        ),
      ).toEqual({ ok: false, reason: "incomplete" });
      const event = terminal.events[5];
      state.storage.sql.exec(
        `UPDATE run_events SET json=? WHERE run_id=? AND seq=6`,
        JSON.stringify({ ...event, summary: "changed canonical bytes" }),
        id,
      );
      expect(await owner.compareAndReplaceUnit(unit, claimed, terminal.finishedAt + 3)).toEqual({
        ok: false,
        reason: "incomplete",
      });
      state.storage.sql.exec(`UPDATE run_events SET json=? WHERE run_id=? AND seq=6`, JSON.stringify(event), id);
      const obligation = state.storage.sql
        .exec<{ owner_key: string; revision: number; json: string }>(
          `SELECT owner_key,revision,json FROM workspace_settlements WHERE json IS NOT NULL`,
        )
        .toArray()[0];
      const corrupt = JSON.parse(obligation.json);
      corrupt.binding.ownerFence += 1;
      state.storage.sql.exec(
        `UPDATE workspace_settlements SET json=? WHERE owner_key=? AND revision=?`,
        JSON.stringify(corrupt),
        obligation.owner_key,
        obligation.revision,
      );
      expect(await owner.compareAndReplaceUnit(unit, claimed, terminal.finishedAt + 3)).toEqual({
        ok: false,
        reason: "incomplete",
      });
      state.storage.sql.exec(
        `UPDATE workspace_settlements SET json=? WHERE owner_key=? AND revision=?`,
        obligation.json,
        obligation.owner_key,
        obligation.revision,
      );
      const rivalInstance = { ...instance, id: "rival_native_unit" };
      const rivalUnit = { ...unit, instanceId: rivalInstance.id, currentEffect: undefined, ending: undefined };
      expect(await owner.putInstance(rivalInstance)).toEqual({ ok: true });
      state.storage.sql.exec(
        `INSERT INTO coordinator_units(instance_id,unit,json,updated_at) VALUES(?,?,?,?)`,
        rivalInstance.id,
        rivalUnit.unit,
        JSON.stringify(rivalUnit),
        terminal.finishedAt,
      );
      expect(await owner.compareAndReplaceUnit(unit, claimed, terminal.finishedAt + 3)).toEqual({
        ok: false,
        reason: "owned",
      });
      state.storage.sql.exec(`DELETE FROM coordinator_units WHERE instance_id=?`, rivalInstance.id);
      expect(await owner.compareAndReplaceUnit(unit, claimed, terminal.finishedAt + 3)).toEqual({ ok: true });
      expect(await owner.findPullOwners({ repo: instance.repo, ref: unit.branch })).toMatchObject({
        ok: true,
        owners: [{ kind: "unit", instanceId: instance.id, unit: unit.unit }],
      });
      const posting: CoordinatorUnit = { ...claimed, adoption: { ...claimed.adoption!, state: "posting" } };
      expect(
        await owner.compareAndReplaceUnit(
          claimed,
          { ...posting, adoption: { ...posting.adoption!, audit: { ...audit, firstHead: head } } },
          terminal.finishedAt + 4,
        ),
      ).toMatchObject({ ok: false });
      expect(await owner.compareAndReplaceUnit(claimed, posting, terminal.finishedAt + 4)).toEqual({ ok: true });
      expect(await owner.get(id)).toEqual(before);
      expect(await owner.preservationOwner(id, workspaceOwner)).toEqual(custody);
    });
  });
});
const diagnosis = () => ({
  eventCount: 0,
  toolCalls: 0,
  byCategory: Object.fromEntries(FRICTION_CATEGORIES.map((c) => [c, ZERO])) as RunRecord["diagnosis"]["byCategory"],
  findings: [],
  verdict: "no friction detected",
});

function record(id: string, threadKey: string): RunRecord {
  return {
    id,
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey,
    channelVisibility: "unknown",
    // Inside the retention window, or the finished record is trimmed on write.
    startedAt: Date.now() - 60_000,
    finishedAt: Date.now() - 1_000,
    status: "completed",
    eventCount: 1,
    storedEventCount: 1,
    truncated: false,
    events: [{ type: "tool_call", tool: "bash", summary: "ls", seq: 1 }],
    diagnosis: diagnosis(),
  };
}

const claimBody = (key: string, runId: string, threadKey: string, gen = "g1", over: Record<string, unknown> = {}) => ({
  storeKey: key,
  run: {
    runId,
    threadKey,
    gen,
    leaseMs: LEASE_MS,
    startedAt: 1_000,
    meta: { agent: "review", channelId: "slack:C1", userId: "slack:UALICE", threadKey },
    card: { channel: "C1", ts: "1.0" },
    system: "you review",
    tools: [{ name: "bash", description: "run", inputSchema: {} }],
    ...over,
  },
});

const step = (over: Record<string, unknown> = {}) => ({
  step: 1,
  seq: 10,
  turnIndex: 2,
  inFlight: [{ callId: "c1", tool: "bash" }],
  inboxConsumedSeq: 0,
  remainingMs: 600_000,
  turn: 1,
  iteration: 1,
  ...over,
});

describe("cross-channel named steer custody", () => {
  it("persists the original sender route and credential beside the canonical SQLite target", async () => {
    const key = storeKey();
    const runId = "cross-channel";
    const threadKey = "slack:C1:target";
    await post("/runs/claim", claimBody(key, runId, threadKey));
    const message = {
      version: 1,
      kind: "message",
      channelId: "slack:C2",
      threadKey: "slack:C2:source",
      userId: "slack:UALICE",
      authenticatedAs: "http:alice",
      sourceUrl: "https://acme.slack.com/archives/C2/p10",
      text: "keep this durable",
      at: 2_000,
    };
    expect(await post("/runs/inbox", { storeKey: key, runId, message })).toEqual({
      status: 200,
      data: { ok: true, seq: 1 },
    });
    const read = await post("/runs/inbox/read", { storeKey: key, runId });
    const target = {
      version: 1,
      runId,
      channelId: "slack:C1",
      threadKey,
      requester: "slack:UALICE",
      producerGen: "g1",
    };
    expect(read.data).toEqual({ items: [{ seq: 1, message: { ...message, target } }] });
    expect(messageFromInbox({ ...message, target }, 0, target)?.msg).toMatchObject({
      channelId: message.channelId,
      threadKey: message.threadKey,
      userId: message.userId,
      authenticatedAs: message.authenticatedAs,
      sourceUrl: message.sourceUrl,
      text: message.text,
    });
    for (const refused of [
      { ...message, target },
      { ...message, userId: "plane", kind: "provider-reissue" },
    ])
      expect((await post("/runs/inbox", { storeKey: key, runId, message: refused })).data).toEqual({ ok: false });
    expect((await post("/runs/inbox/read", { storeKey: key, runId })).data).toEqual(read.data);
  });
});

describe("closed SQLite inbox segment admission", () => {
  it("holds an oversized supported prior archive using SQLite UTF-8 bytes while retaining every original row", async () => {
    const key = storeKey();
    const id = "oversized-prior";
    const thread = "slack:C1:oversized-prior";
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await post("/runs/claim", claimBody(key, id, thread));
    await post("/runs/inbox", { storeKey: key, runId: id, message: { text: "original" } });
    await post("/runs/step", { storeKey: key, runId: id, gen: "g1", record: step() });
    await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: record(id, thread) });
    await post("/runs/claim", claimBody(key, id, thread, "g2"));
    let original: Array<{ step: number; json: string }> = [];
    await runInDurableObject(stub, (_owner: RunHistoryDO, state) => {
      const archive = JSON.parse(
        state.storage.sql.exec<{ json: string }>("SELECT json FROM run_steps WHERE run_id=? AND step=-1", id).one()
          .json,
      );
      archive.first.lastStep.padding = "雪".repeat(300_000);
      archive.latest.lastStep.padding = "雪".repeat(300_000);
      state.storage.sql.exec("UPDATE run_steps SET json=? WHERE run_id=? AND step=-1", JSON.stringify(archive), id);
      state.storage.sql.exec(
        "INSERT INTO run_steps(run_id,step,json) VALUES(?,?,?)",
        id,
        0,
        JSON.stringify(step({ step: 0 })),
      );
      original = state.storage.sql
        .exec<{ step: number; json: string }>("SELECT step,json FROM run_steps WHERE run_id=? ORDER BY step", id)
        .toArray();
      const size = state.storage.sql
        .exec<{ chars: number; bytes: number }>(
          "SELECT LENGTH(json) AS chars,LENGTH(CAST(json AS BLOB)) AS bytes FROM run_steps WHERE run_id=? AND step=-1",
          id,
        )
        .one();
      expect(size.chars).toBeLessThan(1.5 * 1024 * 1024);
      expect(size.bytes).toBeGreaterThan(1.5 * 1024 * 1024);
    });
    await expect(post("/runs/abandon", { storeKey: key, runId: id, gen: "g2" })).rejects.toThrow("unreadable");
    expect((await post("/runs/inbox/read", { storeKey: key, runId: id, gen: "g2", peek: true })).data).toEqual({
      ok: false,
      reason: "incomplete",
    });
    await runInDurableObject(stub, (_owner: RunHistoryDO, state) => {
      expect(
        state.storage.sql.exec("SELECT step,json FROM run_steps WHERE run_id=? ORDER BY step", id).toArray(),
      ).toEqual(original);
      expect(
        state.storage.sql.exec("SELECT * FROM live_runs WHERE run_id=? AND owner_gen='g2'", id).toArray(),
      ).toHaveLength(1);
      expect(state.storage.sql.exec("SELECT * FROM run_inbox WHERE run_id=?", id).toArray()).toHaveLength(1);
    });
  });

  it.each([160_000, 300_000])(
    "measures non-ASCII archive bytes before the closing transaction: characters=%s",
    async (characters) => {
      const key = storeKey();
      const id = "archive-byte-boundary";
      const thread = "slack:C1:archive-byte-boundary";
      const stub = env.RUNS.get(env.RUNS.idFromName(key));
      await post("/runs/claim", claimBody(key, id, thread));
      await post("/runs/inbox", { storeKey: key, runId: id, message: { text: "original" } });
      const originalStep = JSON.stringify({ ...step(), padding: "雪".repeat(characters) });
      if (characters === 160_000) {
        expect(
          (await post("/runs/step", { storeKey: key, runId: id, gen: "g1", record: JSON.parse(originalStep) })).status,
        ).toBe(200);
        await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: record(id, thread) });
        await runInDurableObject(stub, (_owner: RunHistoryDO, state) => {
          const archive = JSON.parse(
            state.storage.sql.exec<{ json: string }>("SELECT json FROM run_steps WHERE run_id=? AND step=-1", id).one()
              .json,
          );
          expect(archive.first.lastStep).toEqual(JSON.parse(originalStep));
          expect(archive.latest.lastStep).toEqual(JSON.parse(originalStep));
        });
      } else {
        await runInDurableObject(stub, (_owner: RunHistoryDO, state) => {
          state.storage.sql.exec("INSERT INTO run_steps(run_id,step,json) VALUES(?,?,?)", id, 1, originalStep);
        });
        await expect(
          post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: record(id, thread) }),
        ).rejects.toThrow("byte limit");
        await runInDurableObject(stub, (_owner: RunHistoryDO, state) => {
          expect(
            state.storage.sql.exec<{ json: string }>("SELECT json FROM run_steps WHERE run_id=? AND step=1", id).one()
              .json,
          ).toBe(originalStep);
          expect(state.storage.sql.exec("SELECT * FROM live_runs WHERE run_id=?", id).toArray()).toHaveLength(1);
          expect(state.storage.sql.exec("SELECT * FROM runs WHERE run_id=?", id).toArray()).toEqual([]);
          expect(state.storage.sql.exec("SELECT * FROM run_inbox WHERE run_id=?", id).toArray()).toHaveLength(1);
        });
      }
    },
  );

  it.each([-1, -2])(
    "holds an unsupported private key %s without discarding or reinterpreting its original bytes",
    async (keyValue) => {
      const key = storeKey();
      const id = "unknown-archive";
      const thread = "slack:C1:unknown-archive";
      const stub = env.RUNS.get(env.RUNS.idFromName(key));
      await post("/runs/claim", claimBody(key, id, thread));
      await post("/runs/step", { storeKey: key, runId: id, gen: "g1", record: step() });
      await post("/runs/inbox", { storeKey: key, runId: id, message: { text: "original" } });
      const original = '{"version":99,"opaque":"original private bytes"}';
      await runInDurableObject(stub, (_owner: RunHistoryDO, state) => {
        state.storage.sql.exec("INSERT INTO run_steps(run_id,step,json) VALUES(?,?,?)", id, keyValue, original);
      });
      await expect(post("/runs/abandon", { storeKey: key, runId: id, gen: "g1" })).rejects.toThrow("unreadable");
      expect((await post("/runs/inbox/read", { storeKey: key, runId: id })).data.items).toEqual([]);
      expect((await post("/runs/inbox/read", { storeKey: key, runId: id, gen: "g1", peek: true })).data).toEqual({
        ok: false,
        reason: "incomplete",
      });
      await post("/runs/handoff", { storeKey: key, gen: "g1", runIds: [id] });
      expect(
        (await post("/runs/reclaim", { storeKey: key, gen: "g3", now: 3_000, leaseMs: LEASE_MS })).data.runs,
      ).toMatchObject([{ lastStep: { step: 1 }, inbox: [] }]);
      await runInDurableObject(stub, (_owner: RunHistoryDO, state) => {
        expect(
          state.storage.sql
            .exec<{ json: string }>("SELECT json FROM run_steps WHERE run_id=? AND step=?", id, keyValue)
            .one().json,
        ).toBe(original);
      });
    },
  );

  it.each(["finish", "abandon"] as const)(
    "retains original bytes through %s, zero seeding and a second reclaim",
    async (ending) => {
      const key = storeKey();
      const id = "closed-segment";
      const thread = "slack:C1:closed-segment";
      const stub = env.RUNS.get(env.RUNS.idFromName(key));
      await post("/runs/claim", claimBody(key, id, thread));
      await post("/runs/inbox", {
        storeKey: key,
        runId: id,
        message: {
          version: 1,
          kind: "message",
          channelId: "slack:C1",
          threadKey: thread,
          userId: "slack:UALICE",
          text: "already delivered",
        },
      });
      await post("/runs/inbox", { storeKey: key, runId: id, message: { version: 99, text: "opaque original" } });
      await post("/plane/park", { storeKey: key, runId: id, provider: "anthropic" });
      await post("/plane/level", { storeKey: key, name: "provider", provider: "anthropic", side: "up" });
      let original: Array<{ seq: number; json: string }> = [];
      await runInDurableObject(stub, (owner: RunHistoryDO, state) => {
        original = state.storage.sql
          .exec<{ seq: number; json: string }>("SELECT seq,json FROM run_inbox WHERE run_id=? ORDER BY seq", id)
          .toArray();
        expect(JSON.parse(original[2].json)).toMatchObject({ kind: "provider-reissue", targetRunId: id });
        expect(owner.openPlaneEffects()).toMatchObject([{ kind: "steer", runId: id, seq: 3 }]);
      });
      await post("/runs/step", { storeKey: key, runId: id, gen: "g1", record: step({ inboxConsumedSeq: 3 }) });
      if (ending === "finish")
        await post("/runs/finish", {
          storeKey: key,
          runId: id,
          gen: "g1",
          record: { ...record(id, thread), restarting: true, restartUntil: 9_000 },
        });
      else await post("/runs/abandon", { storeKey: key, runId: id, gen: "g1" });
      await runInDurableObject(stub, (owner: RunHistoryDO) => {
        expect(owner.openPlaneEffects()).toEqual([]);
      });
      await post("/runs/claim", claimBody(key, id, thread, "g2"));
      await post("/runs/step", {
        storeKey: key,
        runId: id,
        gen: "g2",
        record: step({ step: 0, inboxConsumedSeq: 0, inboxDeferredSeqs: [] }),
      });
      await post("/runs/handoff", { storeKey: key, gen: "g2", runIds: [id] });
      const reclaimed = await post("/runs/reclaim", { storeKey: key, gen: "g3", now: 3_000, leaseMs: LEASE_MS });
      expect(reclaimed.data.runs).toMatchObject([{ lastStep: { step: 0, inboxConsumedSeq: 0 }, inbox: [] }]);
      expect((await post("/runs/inbox/read", { storeKey: key, runId: id, gen: "g3", peek: true })).data).toMatchObject({
        ok: true,
        items: [],
      });
      await runInDurableObject(stub, (_owner: RunHistoryDO, state) => {
        expect(
          state.storage.sql.exec("SELECT seq,json FROM run_inbox WHERE run_id=? ORDER BY seq", id).toArray(),
        ).toEqual(original);
      });
      expect(
        (await post("/runs/inbox", { storeKey: key, runId: id, message: { text: "new segment input" } })).data,
      ).toEqual({ ok: true, seq: 4 });
      expect((await post("/runs/inbox/read", { storeKey: key, runId: id })).data.items).toMatchObject([{ seq: 4 }]);
      expect(
        (await post("/runs/step", { storeKey: key, runId: id, gen: "g3", record: step({ step: -1 }) })).status,
      ).toBe(400);
    },
  );
});

function timeSealedRunStages(
  onTestFailed: (handler: () => void) => void,
  now = () => performance.now(),
  emit = (message: string) => console.error(message),
) {
  const completed: Array<{ stage: string; elapsedMs: number }> = [];
  let pending: { stage: string; startedAt: number } | undefined;
  onTestFailed(() => {
    const pendingStage = pending ? `${pending.stage}=${Math.round(now() - pending.startedAt)}ms` : "none";
    const completedStages = completed.map(({ stage, elapsedMs }) => `${stage}=${elapsedMs}ms`).join(", ") || "none";
    emit(`[memory diagnostics] sealed-run stages: completed=${completedStages}; pending=${pendingStage}`);
  });
  return async <T>(stage: string, operation: () => Promise<T>): Promise<T> => {
    const startedAt = now();
    pending = { stage, startedAt };
    try {
      return await operation();
    } finally {
      completed.push({ stage, elapsedMs: Math.round(now() - startedAt) });
      pending = undefined;
    }
  };
}

describe("run ledger — claim and admission (item 29)", () => {
  it("mints resident fences only for the live owner, in ledger order", async () => {
    const key = storeKey();
    const threadKey = "slack:C1:resident-fence";
    const body = (runId: string, gen: string, keyOverride = threadKey) => ({
      storeKey: key,
      runId,
      gen,
      threadKey: keyOverride,
    });
    expect(await post("/runs/resident-claim", body("r1", "g1"))).toMatchObject({
      status: 409,
      data: { reason: "unknown-run" },
    });
    expect((await post("/runs/claim", claimBody(key, "r1", threadKey))).status).toBe(200);
    expect(await post("/runs/resident-claim", body("r1", "g1"))).toMatchObject({
      status: 200,
      data: { ok: true, fence: 1 },
    });
    expect(await post("/runs/resident-claim", body("r1", "g1", "wrong-thread"))).toMatchObject({
      status: 409,
      data: { reason: "fenced" },
    });
    expect(await post("/runs/resident-claim", body("r1", "g1"))).toMatchObject({
      status: 200,
      data: { ok: true, fence: 2 },
    });
  });
  it("claim → 200; a second run on the same thread → 409 thread-live naming the live run; the owner's re-claim is idempotent; /runs/live lists it", async () => {
    const key = storeKey();
    expect(await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).toMatchObject({
      status: 200,
      data: { ok: true },
    });
    const busy = await post("/runs/claim", claimBody(key, "r2", "slack:C1:1.0"));
    expect(busy.status).toBe(409);
    expect(busy.data).toEqual({
      ok: false,
      reason: "thread-live",
      live: { runId: "r1", agent: "review", startedAt: 1_000 },
    });
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).status).toBe(200);
    const live = await post("/runs/live", { storeKey: key });
    expect(live.status).toBe(200);
    const runs = live.data.runs as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: "r1",
      threadKey: "slack:C1:1.0",
      ownerGen: "g1",
      phase: "live",
      stop: null,
      card: { channel: "C1", ts: "1.0" },
      system: "you review",
    });
    expect(typeof runs[0].leaseUntil).toBe("number");
    // Live runs are NOT in the finished listing.
    const list = await post("/runs/list", { storeKey: key });
    expect(list.data.items).toEqual([]);
  });

  it("a claim with `phase: attaching` reserves the thread before the prompt exists (item 42): the row lists as attaching with its request and an empty prompt; the owner's later claim with the prompt promotes it to live in place; reclaim keeps an expired attaching row's phase", async () => {
    const key = storeKey();
    const request = {
      channelId: "slack:C1",
      userId: "slack:UA",
      threadKey: "slack:C1:1.0",
      text: "review it",
      at: 900,
    };
    const reserve = claimBody(key, "r1", "slack:C1:1.0", "g1", {
      phase: "attaching",
      system: "",
      tools: [],
      card: null,
      meta: { agent: "review", channelId: "slack:C1", userId: "slack:UA", threadKey: "slack:C1:1.0", request },
    });
    expect(await post("/runs/claim", reserve)).toMatchObject({ status: 200, data: { ok: true } });
    let runs = (await post("/runs/live", { storeKey: key })).data.runs as Array<Record<string, unknown>>;
    expect(runs[0]).toMatchObject({ runId: "r1", phase: "attaching", system: "", tools: [], card: null });
    expect((runs[0].meta as Record<string, unknown>).request).toEqual(request);
    expect((await post("/runs/claim", claimBody(key, "r2", "slack:C1:1.0"))).status).toBe(409);
    // The prompt lands: promoted in place, identity and start unchanged.
    expect(await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0", "g1", { state: { n: 1 } }))).toMatchObject({
      status: 200,
      data: { ok: true },
    });
    runs = (await post("/runs/live", { storeKey: key })).data.runs as Array<Record<string, unknown>>;
    expect(runs[0]).toMatchObject({
      runId: "r1",
      phase: "live",
      system: "you review",
      card: { channel: "C1", ts: "1.0" },
      state: { n: 1 },
      startedAt: 1_000,
    });
    // A bad phase is a 400.
    expect((await post("/runs/claim", claimBody(key, "r3", "slack:C1:3.0", "g1", { phase: "sleeping" }))).status).toBe(
      400,
    );
    // An expired attaching row is reclaimed as attaching, request and inbox in hand.
    await post(
      "/runs/claim",
      claimBody(key, "r9", "slack:C1:9.0", "g1", { ...reserve.run, runId: "r9", threadKey: "slack:C1:9.0" }),
    );
    await post("/runs/inbox", { storeKey: key, runId: "r9", message: { text: "also this" } });
    const future = Date.now() + LEASE_MS + 1_000;
    const r = await post("/runs/reclaim", { storeKey: key, gen: "g2", now: future, leaseMs: LEASE_MS });
    const taken = (r.data.runs as Array<Record<string, unknown>>).find(
      (x) => (x.row as Record<string, unknown>).runId === "r9",
    )!;
    expect(taken.reclaimedFrom).toBe("attaching");
    expect(taken.row).toMatchObject({ ownerGen: "g2", phase: "attaching" });
    expect(((taken.row as Record<string, unknown>).meta as Record<string, unknown>).request).toEqual(request);
    expect((taken.inbox as Array<{ message: { text: string } }>).map((i) => i.message.text)).toEqual(["also this"]);
    // Abandon: the live rows go with no record; fenced from any other generation; unknown afterwards.
    expect((await post("/runs/abandon", { storeKey: key, runId: "r9", gen: "g1" })).status).toBe(409);
    expect(await post("/runs/abandon", { storeKey: key, runId: "r9", gen: "g2" })).toMatchObject({
      status: 200,
      data: { ok: true },
    });
    runs = (await post("/runs/live", { storeKey: key })).data.runs as Array<Record<string, unknown>>;
    expect(runs.map((x) => x.runId)).toEqual(["r1"]);
    // Ending the live owner cannot dispose of an opaque original row.
    expect((await post("/runs/inbox/read", { storeKey: key, runId: "r9", afterSeq: 0 })).data.items).toEqual([
      {
        seq: 1,
        message: {
          text: "also this",
          target: {
            version: 1,
            runId: "r9",
            channelId: "slack:C1",
            threadKey: "slack:C1:1.0",
            requester: "slack:UA",
            producerGen: "g1",
          },
        },
      },
    ]);
    expect((await post("/runs/list", { storeKey: key })).data.items).toEqual([]);
    expect((await post("/runs/abandon", { storeKey: key, runId: "r9", gen: "g2" })).status).toBe(409);
  });

  it("promotion preserves live state assigned while the run was attaching and accepts its next transition", async () => {
    const key = storeKey();
    const reserve = claimBody(key, "promoted", "slack:C1:promoted", "g1", {
      phase: "attaching",
      system: "",
      tools: [],
      card: null,
    });
    expect(await post("/runs/claim", reserve)).toMatchObject({ status: 200, data: { ok: true } });

    expect(
      await post("/runs/live-state", {
        storeKey: key,
        runId: "promoted",
        gen: "g1",
        assignment: { expectedSeq: 0, eventSeq: 1, at: 100, state: "admitted", bound: 1_000 },
      }),
    ).toMatchObject({
      status: 200,
      data: {
        ok: true,
        liveState: { state: "admitted", since: 100, bound: 1_000 },
        liveStateSeq: 1,
      },
    });

    expect(
      await post(
        "/runs/claim",
        claimBody(key, "promoted", "slack:C1:promoted", "g1", {
          state: { binding: { backend: "resident", workspace: "/workspace/promoted" } },
        }),
      ),
    ).toMatchObject({ status: 200, data: { ok: true } });
    expect((await post("/runs/live", { storeKey: key })).data.runs).toMatchObject([
      {
        runId: "promoted",
        phase: "live",
        state: {
          binding: { backend: "resident", workspace: "/workspace/promoted" },
          liveState: { state: "admitted", since: 100, bound: 1_000 },
          liveStateSeq: 1,
        },
      },
    ]);

    expect(
      await post("/runs/live-state", {
        storeKey: key,
        runId: "promoted",
        gen: "g1",
        assignment: { expectedSeq: 1, eventSeq: 2, at: 200, state: "working", bound: 1_000 },
      }),
    ).toMatchObject({
      status: 200,
      data: {
        ok: true,
        liveState: { state: "working", since: 200, bound: 1_000 },
        liveStateSeq: 2,
      },
    });
    expect((await post("/runs/live", { storeKey: key })).data.runs).toHaveLength(1);
  });

  it("validates: a bad run id, gen, lease, or missing fields → 400; no bearer → 401", async () => {
    const key = storeKey();
    expect((await post("/runs/claim", claimBody(key, "bad id!", "t"))).status).toBe(400);
    expect((await post("/runs/claim", claimBody(key, "r1", "t", "bad gen!"))).status).toBe(400);
    expect((await post("/runs/claim", claimBody(key, "r1", "t", "g1", { leaseMs: 10 }))).status).toBe(400);
    expect((await post("/runs/claim", claimBody(key, "r1", "t", "g1", { system: undefined }))).status).toBe(400);
    expect((await post("/runs/claim", claimBody(key, "r1", "t"), { "content-type": "application/json" })).status).toBe(
      401,
    );
  });
});

describe("run ledger — the fence (item 28)", () => {
  it("heartbeat, append, step, state, finishing and finish from another generation → 409 fenced; an unknown run → 409 unknown-run", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    const fenced = { status: 409, data: { ok: false, reason: "fenced" } };
    expect(await post("/runs/heartbeat", { storeKey: key, runId: "r1", gen: "g2", leaseMs: LEASE_MS })).toEqual(fenced);
    expect(
      await post("/runs/append", {
        storeKey: key,
        runId: "r1",
        gen: "g2",
        events: [{ type: "tool_call", tool: "bash", summary: "x", seq: 1 }],
      }),
    ).toEqual(fenced);
    expect(await post("/runs/step", { storeKey: key, runId: "r1", gen: "g2", record: step() })).toEqual(fenced);
    expect(await post("/runs/state", { storeKey: key, runId: "r1", gen: "g2", state: {} })).toEqual(fenced);
    expect(await post("/runs/finishing", { storeKey: key, runId: "r1", gen: "g2" })).toEqual(fenced);
    expect(
      await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g2", record: record("r1", "slack:C1:1.0") }),
    ).toEqual(fenced);
    expect(await post("/runs/heartbeat", { storeKey: key, runId: "nope", gen: "g1", leaseMs: LEASE_MS })).toEqual({
      status: 409,
      data: { ok: false, reason: "unknown-run" },
    });
  });

  it("the owner's heartbeat extends the lease and reports a stop any generation requested; stop says whether the owner is live", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    const before = ((await post("/runs/live", { storeKey: key })).data.runs as Array<{ leaseUntil: number }>)[0]
      .leaseUntil;
    expect(await post("/runs/stop", { storeKey: key, runId: "r1", mode: "soft" })).toEqual({
      status: 200,
      data: { ok: true, ownerLive: true },
    });
    await new Promise((r) => setTimeout(r, 5));
    const hb = await post("/runs/heartbeat", { storeKey: key, runId: "r1", gen: "g1", leaseMs: LEASE_MS });
    expect(hb).toEqual({ status: 200, data: { ok: true, stop: "soft", phase: "live", effects: [] } });
    const after = ((await post("/runs/live", { storeKey: key })).data.runs as Array<{ leaseUntil: number }>)[0]
      .leaseUntil;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(await post("/runs/stop", { storeKey: key, runId: "nope", mode: "hard" })).toEqual({
      status: 200,
      data: { ok: false },
    });
  });
});

describe("run ledger — steps, events, inbox, state (items 30–31)", () => {
  it("the SQLite ledger fences and sequences a resumed setup boundary after provider wait", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "resume-state", "slack:C1:resume-state"));
    for (const [expectedSeq, state] of [
      [0, "admitted"],
      [1, "working"],
      [2, "waiting_provider"],
    ] as const) {
      expect(
        await post("/runs/live-state", {
          storeKey: key,
          runId: "resume-state",
          gen: "g1",
          assignment: { expectedSeq, eventSeq: expectedSeq + 1, at: 100, state, bound: 1_000 },
        }),
      ).toMatchObject({ status: 200, data: { ok: true } });
    }
    expect(await post("/runs/handoff", { storeKey: key, gen: "g1", runIds: ["resume-state"] })).toMatchObject({
      status: 200,
      data: { marked: ["resume-state"] },
    });
    expect(await post("/runs/reclaim", { storeKey: key, gen: "g2", now: Date.now(), leaseMs: LEASE_MS })).toMatchObject(
      {
        status: 200,
        data: { runs: [expect.objectContaining({ row: expect.objectContaining({ runId: "resume-state" }) })] },
      },
    );
    const assignment = { expectedSeq: 3, eventSeq: 4, at: 200, state: "admitted", bound: 900, resumeSegment: true };
    expect(await post("/runs/live-state", { storeKey: key, runId: "resume-state", gen: "g1", assignment })).toEqual({
      status: 409,
      data: { ok: false, reason: "fenced" },
    });
    expect(
      await post("/runs/live-state", { storeKey: key, runId: "resume-state", gen: "g2", assignment }),
    ).toMatchObject({
      status: 200,
      data: { ok: true, liveState: { state: "admitted", since: 200 }, liveStateSeq: 4 },
    });
    expect(await post("/runs/live-state", { storeKey: key, runId: "resume-state", gen: "g2", assignment })).toEqual({
      status: 400,
      data: { ok: false, reason: "stale-sequence" },
    });
    const events = (await post("/runs/live-events", { storeKey: key, runId: "resume-state" })).data.events as Array<{
      seq: number;
      type: string;
    }>;
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [1, "run_state"],
      [2, "run_state"],
      [3, "run_state"],
      [4, "run_state"],
    ]);
  });

  it("live-state assignment commits its boundary and projection together, while a pre-commit refusal exposes neither half", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "state-1", "slack:C1:state"));
    const admitted = await post("/runs/live-state", {
      storeKey: key,
      runId: "state-1",
      gen: "g1",
      assignment: { expectedSeq: 0, eventSeq: 1, at: 100, state: "admitted", bound: 1_000 },
    });
    expect(admitted).toMatchObject({
      status: 200,
      data: { ok: true, liveState: { state: "admitted", since: 100, bound: 1_000 }, liveStateSeq: 1 },
    });
    let live = (await post("/runs/live", { storeKey: key })).data.runs as Array<Record<string, unknown>>;
    expect(live[0]).toMatchObject({
      liveState: { state: "admitted", since: 100, bound: 1_000 },
      liveStateSeq: 1,
    });
    expect((await post("/runs/live-events", { storeKey: key, runId: "state-1" })).data.events).toHaveLength(1);

    expect(
      await post("/runs/live-state", {
        storeKey: key,
        runId: "state-1",
        gen: "g1",
        assignment: {
          expectedSeq: 1,
          at: 200,
          state: "working",
          bound: 900,
          sourceEvents: [{ type: "tool_call", tool: "bash", summary: "x", seq: 1, at: 200 }],
        },
      }),
    ).toEqual({ status: 400, data: { ok: false, reason: "stale-sequence" } });
    live = (await post("/runs/live", { storeKey: key })).data.runs as Array<Record<string, unknown>>;
    expect(live[0]).toMatchObject({
      liveState: { state: "admitted", since: 100, bound: 1_000 },
      liveStateSeq: 1,
    });
    expect((await post("/runs/live-events", { storeKey: key, runId: "state-1" })).data.events).toHaveLength(1);
  });
  it("append lands event rows keyed by seq while the run is live (the finished-runs routes do not see a live run — its events reach them with the finish record); an over-cap event is 400; step records replace by step number", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    const events = [1, 2, 3].map((seq) => ({ type: "tool_call", tool: "bash", summary: `s${seq}`, seq }));
    expect(await post("/runs/append", { storeKey: key, runId: "r1", gen: "g1", events })).toEqual({
      status: 200,
      data: { ok: true },
    });
    const seqs = await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_inst, state) =>
      state.storage.sql
        .exec<{ seq: number }>(`SELECT seq FROM run_events WHERE run_id = ? ORDER BY seq`, "r1")
        .toArray()
        .map((r) => r.seq),
    );
    expect(seqs).toEqual([1, 2, 3]);
    // Live runs are not finished runs: the history routes answer as for an unknown id —
    // the ledger's own read is how a reclaim gets at them (item 36); an unknown run is empty.
    expect((await post("/runs/events", { storeKey: key, id: "r1" })).data.events).toBeNull();
    const liveEvents = (await post("/runs/live-events", { storeKey: key, runId: "r1" })).data.events as Array<{
      seq: number;
      type: string;
    }>;
    expect(liveEvents.map((e) => [e.seq, e.type])).toEqual([
      [1, "tool_call"],
      [2, "tool_call"],
      [3, "tool_call"],
    ]);
    expect((await post("/runs/live-events", { storeKey: key, runId: "nope" })).data.events).toEqual([]);
    expect((await post("/runs/live-events", { storeKey: key, runId: "bad id" })).status).toBe(400);
    const huge = { type: "tool_result", tool: "bash", summary: "x", output: "y".repeat(70_000), seq: 4 };
    expect((await post("/runs/append", { storeKey: key, runId: "r1", gen: "g1", events: [huge] })).status).toBe(400);
    expect(await post("/runs/step", { storeKey: key, runId: "r1", gen: "g1", record: step() })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(await post("/runs/step", { storeKey: key, runId: "r1", gen: "g1", record: step({ inFlight: [] }) })).toEqual(
      { status: 200, data: { ok: true } },
    );
    expect((await post("/runs/step", { storeKey: key, runId: "r1", gen: "g1", record: { step: 1 } })).status).toBe(400);
  });

  it("inbox appends with increasing seq from any generation; state replaces; both refused for an unknown run", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    expect(await post("/runs/inbox", { storeKey: key, runId: "r1", message: { text: "a" } })).toEqual({
      status: 200,
      data: { ok: true, seq: 1 },
    });
    expect(await post("/runs/inbox", { storeKey: key, runId: "r1", message: { text: "b" } })).toEqual({
      status: 200,
      data: { ok: true, seq: 2 },
    });
    expect(await post("/runs/inbox", { storeKey: key, runId: "nope", message: { text: "c" } })).toEqual({
      status: 200,
      data: { ok: false },
    });
    // Read back past a seq (item 40): the resume's re-read at adopt time.
    expect(await post("/runs/inbox/read", { storeKey: key, runId: "r1", afterSeq: 1 })).toEqual({
      status: 200,
      data: {
        items: [
          {
            seq: 2,
            message: {
              text: "b",
              target: {
                version: 1,
                runId: "r1",
                channelId: "slack:C1",
                threadKey: "slack:C1:1.0",
                requester: "slack:UALICE",
                producerGen: "g1",
              },
            },
          },
        ],
      },
    });
    expect((await post("/runs/inbox/read", { storeKey: key, runId: "r1" })).data).toEqual({
      items: [
        {
          seq: 1,
          message: {
            text: "a",
            target: {
              version: 1,
              runId: "r1",
              channelId: "slack:C1",
              threadKey: "slack:C1:1.0",
              requester: "slack:UALICE",
              producerGen: "g1",
            },
          },
        },
        {
          seq: 2,
          message: {
            text: "b",
            target: {
              version: 1,
              runId: "r1",
              channelId: "slack:C1",
              threadKey: "slack:C1:1.0",
              requester: "slack:UALICE",
              producerGen: "g1",
            },
          },
        },
      ],
    });
    expect((await post("/runs/inbox/read", { storeKey: key, runId: "nope", afterSeq: 0 })).data).toEqual({ items: [] });
    expect((await post("/runs/inbox/read", { storeKey: key, runId: "r1", afterSeq: -1 })).status).toBe(400);
    expect((await post("/runs/inbox/read", { storeKey: key, runId: "r1", afterSeq: "2" })).status).toBe(400);
    expect(await post("/runs/state", { storeKey: key, runId: "r1", gen: "g1", state: { verdict: "approve" } })).toEqual(
      { status: 200, data: { ok: true } },
    );
    const live = (await post("/runs/live", { storeKey: key })).data.runs as Array<{ state: unknown }>;
    expect(live[0].state).toEqual({ verdict: "approve" });
  });
});

describe("durable inbox terminal custody", () => {
  it("returns an observational peek only for the current original generation and keeps SQLite bytes", async () => {
    const key = storeKey(),
      id = "opaque-peek",
      thread = "slack:C1:opaque-peek";
    await post("/runs/claim", claimBody(key, id, thread));
    await post("/runs/inbox", { storeKey: key, runId: id, message: { version: 99, text: "opaque original" } });
    expect(
      (await post("/runs/inbox/read", { storeKey: key, runId: id, gen: "wrong-gen", afterSeq: 0, peek: true })).data,
    ).toEqual({ ok: false, reason: "fenced" });
    expect(
      (await post("/runs/inbox/read", { storeKey: key, runId: id, gen: "g1", afterSeq: 0, peek: true })).data,
    ).toMatchObject({
      ok: true,
      version: 1,
      runId: id,
      gen: "g1",
      items: [{ seq: 1, witness: { version: 1, runId: id, seq: 1 } }],
      boundary: { lastStep: null },
    });
    expect((await post("/runs/inbox/read", { storeKey: key, runId: id, afterSeq: 0 })).data.items).toHaveLength(1);
  });
  it("keeps opaque canonical SQLite rows at terminal finish without inferring consumption", async () => {
    const key = storeKey(),
      id = "opaque-terminal",
      thread = "slack:C1:opaque-terminal";
    await post("/runs/claim", claimBody(key, id, thread));
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    const original = JSON.stringify({ version: 99, text: "opaque original" });
    await runInDurableObject(stub, (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec("INSERT INTO run_inbox(run_id,seq,json) VALUES(?,?,?)", id, 1, original);
    });
    expect(
      (await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: record(id, thread) })).data,
    ).toMatchObject({ ok: true, stored: true });
    await runInDurableObject(stub, (_owner: RunHistoryDO, state) => {
      expect(
        state.storage.sql.exec<{ json: string }>("SELECT json FROM run_inbox WHERE run_id=? AND seq=1", id).one().json,
      ).toBe(original);
    });
  });
});

describe("run ledger — finishing, finish, handoff, reclaim (items 31, 33)", () => {
  it("guards a paused same-generation hard-stop seal and removes its durable owner once", async () => {
    const key = storeKey();
    const id = "paused-child";
    const threadKey = "slack:C1:paused-child";
    await post(
      "/runs/claim",
      claimBody(key, id, threadKey, "g1", {
        state: { binding: { backend: "resident", workspace: "/workspace/kept" } },
      }),
    );
    const stopRecord = { ...record(id, threadKey), status: "stopped_hard" as const };
    const finish = (gen: string) =>
      post("/runs/finish", { storeKey: key, runId: id, gen, record: stopRecord, requireStoppedPause: true });
    expect((await finish("g1")).status).toBe(409); // live owner cannot be mistaken for a paused one
    expect(
      (await post("/runs/handoff", { storeKey: key, gen: "g1", runIds: [id], pausedForRetry: true })).data,
    ).toMatchObject({ marked: [id] });
    expect((await finish("g2")).status).toBe(409); // different generation cannot seal it
    expect((await finish("g1")).status).toBe(409); // not stopped yet
    expect((await post("/runs/stop", { storeKey: key, runId: id, mode: "hard" })).status).toBe(200);
    expect((await finish("g1")).data).toMatchObject({ ok: true, stored: true });
    expect((await finish("g1")).status).toBe(409); // no duplicate finish/event
    expect((await post("/runs/live", { storeKey: key })).data.runs).toEqual([]);
    expect((await post("/runs/summary", { storeKey: key, id })).data.summary).toMatchObject({ status: "stopped_hard" });
    expect(
      (await post("/runs/reclaim", { storeKey: key, gen: "g2", now: Date.now(), leaseMs: LEASE_MS })).data.runs,
    ).toEqual([]);
  });

  it("finishing is a CAS taken once; finish writes the finished record and removes every live row in one step; the record then lists as finished", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    await post("/runs/step", { storeKey: key, runId: "r1", gen: "g1", record: step() });
    await post("/runs/inbox", { storeKey: key, runId: "r1", message: { text: "a" } });
    expect(await post("/runs/finishing", { storeKey: key, runId: "r1", gen: "g1" })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(await post("/runs/finishing", { storeKey: key, runId: "r1", gen: "g1" })).toEqual({
      status: 409,
      data: { ok: false, reason: "fenced" },
    });
    const fin = await post("/runs/finish", {
      storeKey: key,
      runId: "r1",
      gen: "g1",
      record: record("r1", "slack:C1:1.0"),
    });
    // `event: none` — a record with no coordinator sends nothing (item 47).
    expect(fin).toEqual({ status: 200, data: { ok: true, stored: true, event: "none" } });
    expect((await post("/runs/live", { storeKey: key })).data.runs).toEqual([]);
    const got = await post("/runs/get", { storeKey: key, id: "r1" });
    expect((got.data.record as RunRecord).status).toBe("completed");
    const list = await post("/runs/list", { storeKey: key });
    expect((list.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual(["r1"]);
    // The thread is free again.
    expect((await post("/runs/claim", claimBody(key, "r2", "slack:C1:1.0"))).status).toBe(200);
    // finish with a record whose id differs from runId is refused before any write.
    expect(
      (await post("/runs/finish", { storeKey: key, runId: "r2", gen: "g1", record: record("other", "slack:C1:1.0") }))
        .status,
    ).toBe(400);
  });

  it("handoff marks this generation's live runs; reclaim takes expired and handed-off rows with the last step, the unconsumed inbox and jobs, and re-owns them; a live lease is left alone", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "expired", "slack:C1:1.0"));
    await post("/runs/claim", claimBody(key, "handed", "slack:C1:2.0"));
    await post("/runs/claim", claimBody(key, "alive", "slack:C1:3.0", "g1", { leaseMs: 3_600_000 }));
    // g2's own row with a lapsed lease: never taken by g2's own reclaim (a heartbeat that did not land, not a dead owner).
    await post("/runs/claim", claimBody(key, "mine", "slack:C1:4.0", "g2"));
    await post("/runs/step", { storeKey: key, runId: "expired", gen: "g1", record: step({ inboxConsumedSeq: 1 }) });
    await post("/runs/inbox", { storeKey: key, runId: "expired", message: { text: "first" } });
    await post("/runs/inbox", { storeKey: key, runId: "expired", message: { text: "second" } });
    expect(await post("/runs/handoff", { storeKey: key, gen: "g1", runIds: ["handed", "alive-not-mine"] })).toEqual({
      status: 200,
      data: { marked: ["handed"] },
    });
    const future = Date.now() + LEASE_MS + 1_000; // past `expired`'s lease, inside `alive`'s hour
    const r = await post("/runs/reclaim", { storeKey: key, gen: "g2", now: future, leaseMs: LEASE_MS });
    expect(r.status).toBe(200);
    const runs = r.data.runs as Array<{
      row: { runId: string; ownerGen: string; phase: string };
      lastStep: { step: number } | null;
      inbox: Array<{ message: { text: string } }>;
    }>;
    expect(runs.map((x) => x.row.runId).sort()).toEqual(["expired", "handed"]);
    const expired = runs.find((x) => x.row.runId === "expired")!;
    expect(expired.row).toMatchObject({ ownerGen: "g2", phase: "live" });
    expect(expired.lastStep?.step).toBe(1);
    expect(expired.inbox.map((i) => i.message.text)).toEqual(["second"]);
    // The old generation is fenced; the new one writes.
    expect((await post("/runs/step", { storeKey: key, runId: "expired", gen: "g1", record: step() })).status).toBe(409);
    expect(
      (await post("/runs/step", { storeKey: key, runId: "expired", gen: "g2", record: step({ step: 2 }) })).status,
    ).toBe(200);
    const live = (await post("/runs/live", { storeKey: key })).data.runs as Array<{ runId: string; ownerGen: string }>;
    expect(live.find((x) => x.runId === "alive")?.ownerGen).toBe("g1");
    expect(live.find((x) => x.runId === "mine")?.ownerGen).toBe("g2"); // untouched by its own generation's reclaim
  });

  it("reclaim offers the deferred rows at or below the cursor with every row past it; a malformed deferred list is refused", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "parked", "slack:C1:1.0"));
    for (const text of ["ordinary", "earlier read", "provider up", "later"])
      await post("/runs/inbox", { storeKey: key, runId: "parked", message: { text } });
    for (const inboxDeferredSeqs of [[0], [1.5], "1", [-1]])
      expect(
        (
          await post("/runs/step", {
            storeKey: key,
            runId: "parked",
            gen: "g1",
            record: { ...step({ inboxConsumedSeq: 3 }), inboxDeferredSeqs },
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await post("/runs/step", {
          storeKey: key,
          runId: "parked",
          gen: "g1",
          record: step({ inboxConsumedSeq: 3, inboxDeferredSeqs: [1] }),
        })
      ).status,
    ).toBe(200);
    const r = await post("/runs/reclaim", {
      storeKey: key,
      gen: "g2",
      now: Date.now() + LEASE_MS + 1_000,
      leaseMs: LEASE_MS,
    });
    const [taken] = r.data.runs as Array<{ inbox: Array<{ seq: number; message: { text: string } }> }>;
    expect(taken!.inbox.map((i) => [i.seq, i.message.text])).toEqual([
      [1, "ordinary"],
      [4, "later"],
    ]);
  });
});

// docs/reference/specs/run-history.md items 47–48: the coordinator's event rides
// the one handler every terminal record commits through, and the row and record
// carry the instance and the spawn's key.
describe("run ledger — the coordinator's event and the key (items 47–48)", () => {
  const TAG = { parentInstanceId: "ship_acme_api_1", idempotencyKey: "ship_acme_api_1:u12/0/coding" };
  type Sent = { instance: string; type: string; payload: unknown };

  /** The Workflow binding as the object sees it, doubled: what `finish` sent, or
   *  an engine that refuses because the instance ended. Installed on the live
   *  object, so the send goes through the handler's own code path. */
  async function coordinatorDouble(key: string, behaviour: "ok" | "not-running" | "absent" = "ok"): Promise<Sent[]> {
    const sent: Sent[] = [];
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const holder = inst as unknown as { env: Record<string, unknown> };
      // `absent`: a state Worker deployed without the binding (the release
      // before it bound the bot's class) — the pool's own binding is the stub
      // Worker's, so absence is installed, never assumed.
      if (behaviour === "absent") {
        const { SHIP_COORDINATOR: _binding, ...without } = holder.env;
        holder.env = without;
        return;
      }
      holder.env = {
        ...holder.env,
        SHIP_COORDINATOR: {
          get: async (id: string) => ({
            sendEvent: async (event: { type: string; payload: unknown }) => {
              if (behaviour === "not-running") throw new Error("instance is not running");
              sent.push({ instance: id, type: event.type, payload: event.payload });
            },
          }),
        },
      };
    });
    return sent;
  }

  const childRecord = (id: string, threadKey: string, status: RunRecord["status"] = "completed"): RunRecord => ({
    ...record(id, threadKey),
    status,
    ...TAG,
  });

  it("preserves exact maintenance transport in the native ledger and never calls a Workflow on completion", async () => {
    const key = storeKey(),
      runId = "maintenance-child",
      threadKey = "slack:C1:maintenance";
    const sent = await coordinatorDouble(key);
    const identity = { ...TAG, coordinatorUnit: "ONE", maintenanceActionId: "m_" + "a".repeat(64) };
    const meta = { ...claimBody(key, runId, threadKey).run.meta, ...identity };
    expect((await post("/runs/claim", claimBody(key, runId, threadKey, "g1", { meta }))).status).toBe(200);
    expect(
      (
        await post(
          "/runs/claim",
          claimBody(key, "malformed", "slack:C1:malformed", "g1", { meta: { ...meta, maintenanceActionId: "bad" } }),
        )
      ).status,
    ).toBe(400);
    const tag = {
      type: "coordinator_tag",
      parentInstanceId: identity.parentInstanceId,
      unit: "ONE",
      branch: "fix/pr",
      maintenanceActionId: identity.maintenanceActionId,
      seq: 1,
    };
    const append = (events: unknown[]) => post("/runs/append", { storeKey: key, runId, gen: "g1", events });
    expect(await append([tag])).toMatchObject({ status: 200, data: { ok: true } });
    expect(await append([{ ...tag, maintenanceActionId: "m_" + "b".repeat(64) }])).toMatchObject({
      status: 409,
      data: { reason: "fenced" },
    });
    expect(await append([{ type: "tool_call", tool: "bash", summary: "replacement", seq: 1 }])).toMatchObject({
      status: 409,
      data: { reason: "fenced" },
    });
    expect(
      await append([
        { ...tag, seq: 5 },
        { type: "tool_call", tool: "bash", summary: "same batch erase", seq: 5 },
      ]),
    ).toMatchObject({ status: 409, data: { reason: "fenced" } });
    expect((await post("/runs/live-events", { storeKey: key, runId })).data.events).toEqual([tag]);
    const finish = (value: unknown) => post("/runs/finish", { storeKey: key, runId, gen: "g1", record: value });
    expect(await finish(childRecord(runId, threadKey))).toMatchObject({ status: 409, data: { reason: "fenced" } });
    const terminal = { ...childRecord(runId, threadKey), ...identity, events: [tag] };
    expect(await finish(terminal)).toMatchObject({
      status: 200,
      data: { ok: true, stored: true, event: "no-binding" },
    });
    expect((await post("/runs/get", { storeKey: key, id: runId })).data.record).toEqual(terminal);
    expect(sent).toEqual([]);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO) => {
      await expect(
        owner.claim(
          claimBody(key, runId, threadKey, "g1", { meta: { ...meta, maintenanceActionId: undefined } }).run,
          Date.now(),
        ),
      ).rejects.toThrow("maintenance transport identity");
      expect(await owner.get(runId)).toEqual(terminal);
    });
  });

  it("the test pool leaves the real Workflow engine unbound, so only a test's live-object double can own a workflow promise", () => {
    expect(env.SHIP_COORDINATOR).toBeUndefined();
  });

  it("a record carrying parentInstanceId committed by the owner's finish sends exactly one `run-finished-<runId>` to that instance, after the commit, and the response says so", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key);
    await post(
      "/runs/claim",
      claimBody(key, "r1", "slack:C1:1.0", "g1", {
        meta: { ...claimBody(key, "r1", "slack:C1:1.0").run.meta, ...TAG },
      }),
    );
    const fin = await post("/runs/finish", {
      storeKey: key,
      runId: "r1",
      gen: "g1",
      record: childRecord("r1", "slack:C1:1.0"),
    });
    expect(fin).toEqual({ status: 200, data: { ok: true, stored: true, event: "sent" } });
    expect(sent).toEqual([
      {
        instance: "ship_acme_api_1",
        type: "run-finished-r1",
        payload: expect.objectContaining({ runId: "r1", status: "completed", parentInstanceId: "ship_acme_api_1" }),
      },
    ]);
    // The commit stood: the row is gone and the record lists as finished, its tag on it.
    expect((await post("/runs/live", { storeKey: key })).data.runs).toEqual([]);
    const got = (await post("/runs/get", { storeKey: key, id: "r1" })).data.record as RunRecord;
    expect(got).toMatchObject({ status: "completed", ...TAG });
  });

  it("the reclaim's close (an expired live row taken by the next generation) and the admission's close (a reserved row it supersedes) each send exactly one event", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key);
    const base = claimBody(key, "expired", "slack:C1:1.0").run.meta;
    await post("/runs/claim", claimBody(key, "expired", "slack:C1:1.0", "g1", { meta: { ...base, ...TAG } }));
    await post(
      "/runs/claim",
      claimBody(key, "reserved", "slack:C1:2.0", "g1", {
        phase: "attaching",
        system: "",
        tools: [],
        card: null,
        meta: { ...base, threadKey: "slack:C1:2.0", ...TAG, request: { text: "do the unit" } },
      }),
    );
    const future = Date.now() + LEASE_MS + 1_000;
    const taken = (await post("/runs/reclaim", { storeKey: key, gen: "g2", now: future, leaseMs: LEASE_MS })).data
      .runs as Array<{ row: { runId: string } }>;
    expect(taken.map((t) => t.row.runId).sort()).toEqual(["expired", "reserved"]);
    expect(
      await post("/runs/finish", {
        storeKey: key,
        runId: "expired",
        gen: "g2",
        record: childRecord("expired", "slack:C1:1.0", "interrupted"),
      }),
    ).toMatchObject({ status: 200, data: { ok: true, event: "sent" } });
    expect(
      await post("/runs/finish", {
        storeKey: key,
        runId: "reserved",
        gen: "g2",
        record: childRecord("reserved", "slack:C1:2.0", "interrupted"),
      }),
    ).toMatchObject({ status: 200, data: { ok: true, event: "sent" } });
    expect(sent.map((s) => s.type)).toEqual(["run-finished-expired", "run-finished-reserved"]);
    expect(sent.map((s) => (s.payload as { status: string }).status)).toEqual(["interrupted", "interrupted"]);
  });

  it("a terminal record committed through put, outside the ledger's finish — the run loop's or a reclaim's interrupted close, the pi harness's restart — sends `run-finished-<runId>` once; the start tombstone (finishedAt = startedAt) sends nothing; a record without the tag sends nothing", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key);
    // The tombstone a run writes at its start: not a close, so no wake.
    const started = record("p1", "slack:C1:3.0");
    await post("/runs/put", {
      storeKey: key,
      record: { ...started, finishedAt: started.startedAt, status: "interrupted", ...TAG },
    });
    expect(sent).toEqual([]);
    // The interrupted close written outside `finish`: one send, the record's status on it.
    expect(
      await post("/runs/put", {
        storeKey: key,
        record: {
          ...childRecord("p1", "slack:C1:3.0", "interrupted"),
          events: [
            {
              type: "coordinator_tag",
              parentInstanceId: "ship_acme_api_1",
              transportWorkflowId: "recovery-review-1",
              at: 1,
            },
          ],
          eventCount: 1,
        },
      }),
    ).toMatchObject({ status: 200, data: { ok: true, stored: true } });
    expect(sent).toEqual([
      {
        instance: "recovery-review-1",
        type: "run-finished-p1",
        payload: expect.objectContaining({ runId: "p1", status: "interrupted", parentInstanceId: "ship_acme_api_1" }),
      },
    ]);
    // A plain record — no coordinator — wakes nobody.
    await post("/runs/put", { storeKey: key, record: record("p2", "slack:C1:4.0") });
    expect(sent).toHaveLength(1);
  });

  it("a record without parentInstanceId sends nothing; a fenced finish sends nothing", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key);
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    await post(
      "/runs/claim",
      claimBody(key, "r2", "slack:C1:2.0", "g1", {
        meta: { ...claimBody(key, "r2", "slack:C1:2.0").run.meta, ...TAG },
      }),
    );
    expect(
      await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", "slack:C1:1.0") }),
    ).toEqual({ status: 200, data: { ok: true, stored: true, event: "none" } });
    expect(
      (await post("/runs/finish", { storeKey: key, runId: "r2", gen: "g9", record: childRecord("r2", "slack:C1:2.0") }))
        .status,
    ).toBe(409);
    expect(sent).toEqual([]);
  });

  it("a send the engine refuses — the instance ended — is swallowed: the finish still commits and the response names the failure", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key, "not-running");
    await post(
      "/runs/claim",
      claimBody(key, "r1", "slack:C1:1.0", "g1", {
        meta: { ...claimBody(key, "r1", "slack:C1:1.0").run.meta, ...TAG },
      }),
    );
    const fin = await post("/runs/finish", {
      storeKey: key,
      runId: "r1",
      gen: "g1",
      record: childRecord("r1", "slack:C1:1.0"),
    });
    expect(fin).toEqual({ status: 200, data: { ok: true, stored: true, event: "failed" } });
    expect(sent).toEqual([]);
    expect((await post("/runs/live", { storeKey: key })).data.runs).toEqual([]);
    expect(((await post("/runs/get", { storeKey: key, id: "r1" })).data.record as RunRecord).status).toBe("completed");
  });

  it("a Worker without the coordinator binding (the release before it bound the bot's class) commits as before and answers no-binding", async () => {
    const key = storeKey();
    await coordinatorDouble(key, "absent");
    await post(
      "/runs/claim",
      claimBody(key, "r1", "slack:C1:1.0", "g1", {
        meta: { ...claimBody(key, "r1", "slack:C1:1.0").run.meta, ...TAG },
      }),
    );
    expect(
      await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: childRecord("r1", "slack:C1:1.0") }),
    ).toEqual({ status: 200, data: { ok: true, stored: true, event: "no-binding" } });
  });

  it("the claim stores the key on the row and a second claim on the thread is refused naming it; a malformed key or instance id in the meta is 400", async () => {
    const key = storeKey();
    const meta = { ...claimBody(key, "r1", "slack:C1:1.0").run.meta, ...TAG, costCapUsd: 50 };
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0", "g1", { meta }))).status).toBe(200);
    const live = (await post("/runs/live", { storeKey: key })).data.runs as Array<{ meta: Record<string, unknown> }>;
    expect(live[0].meta).toMatchObject({ ...TAG, costCapUsd: 50 });
    const busy = await post("/runs/claim", claimBody(key, "r2", "slack:C1:1.0"));
    expect(busy).toEqual({
      status: 409,
      data: {
        ok: false,
        reason: "thread-live",
        live: { runId: "r1", agent: "review", startedAt: 1_000, idempotencyKey: TAG.idempotencyKey },
      },
    });
    expect(
      (
        await post(
          "/runs/claim",
          claimBody(key, "r3", "slack:C1:3.0", "g1", { meta: { ...meta, idempotencyKey: "no-step" } }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          "/runs/claim",
          claimBody(key, "r3", "slack:C1:3.0", "g1", { meta: { ...meta, parentInstanceId: "has:colon" } }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await post("/runs/claim", claimBody(key, "r3", "slack:C1:3.0", "g1", { meta: { ...meta, costCapUsd: 0 } })))
        .status,
    ).toBe(400);
    // The tag is both fields or neither: one alone is refused before it reaches a row.
    const { idempotencyKey: _k, ...instanceOnly } = meta;
    expect((await post("/runs/claim", claimBody(key, "r3", "slack:C1:3.0", "g1", { meta: instanceOnly }))).status).toBe(
      400,
    );
  });
});

// docs/reference/specs/run-history.md item 49: the parent ship record the
// coordinator's spawn route reads the requester from lives on the state Worker.
describe("run ledger — the coordinator instance record (item 49)", () => {
  const instance: CoordinatorInstance = {
    id: "ship_acme_api_1",
    kind: "ship",
    userId: "slack:UALICE",
    userName: "alice",
    channelId: "slack:C1",
    threadKey: "slack:C1:1.0",
    repo: "acme/api",
    branch: "plan/orchestration/u12",
    base: "main",
    createdAt: 1_000,
  };

  it("put stores the record and get reads it back; an identical put is idempotent; a different record under the same id is refused as exists; an unknown id is null", async () => {
    const key = storeKey();
    expect(await post("/runs/coordinator/put", { storeKey: key, instance })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).toEqual({
      status: 200,
      data: { instance },
    });
    expect(await post("/runs/coordinator/put", { storeKey: key, instance })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(await post("/runs/coordinator/put", { storeKey: key, instance: { ...instance, branch: "other" } })).toEqual({
      status: 409,
      data: { ok: false, reason: "exists" },
    });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({ instance });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: "ship_none" })).data).toEqual({ instance: null });
  });

  it("confirms only the exact unreconciled create and leaves its unit rows intact", async () => {
    const key = storeKey();
    const pending: CoordinatorInstance = { ...instance, admission: "unreconciled" };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: "U12",
      slug: "u12",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
    };
    expect((await post("/runs/coordinator/put", { storeKey: key, instance: pending })).status).toBe(200);
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [unit] })).status).toBe(200);
    expect(
      await post("/runs/coordinator/admission/confirm", { storeKey: key, expected: { ...pending, runId: "other" } }),
    ).toEqual({ status: 409, data: { ok: false, reason: "stale" } });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({
      instance: pending,
    });
    expect(await post("/runs/coordinator/admission/confirm", { storeKey: key, expected: pending })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect((await post("/runs/coordinator/admission/confirm", { storeKey: key, expected: pending })).status).toBe(200);
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({
      instance: { ...pending, admission: "created" },
    });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: instance.id })).data).toEqual({
      units: [unit],
    });
    expect((await post("/runs/coordinator/admission/confirm", { storeKey: key, expected: instance })).status).toBe(400);
  });

  // Record 0060 / issue 1924: the hard stop's mark on the instance row —
  // written when the hosted parent is sealed, read back by the runner's routes.
  it("stop marks the instance row and get reads the mark back; a second mark keeps the first `at`; an unknown id is 409 unknown_instance; a malformed body is 400", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    expect(await post("/runs/coordinator/stop", { storeKey: key, instanceId: instance.id, at: 5_000 })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({
      instance: { ...instance, stop: { at: 5_000 } },
    });
    expect((await post("/runs/coordinator/stop", { storeKey: key, instanceId: instance.id, at: 9_000 })).status).toBe(
      200,
    );
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({
      instance: { ...instance, stop: { at: 5_000 } },
    });
    expect(await post("/runs/coordinator/stop", { storeKey: key, instanceId: "ship_none", at: 5_000 })).toEqual({
      status: 409,
      data: { ok: false, reason: "unknown_instance" },
    });
    expect((await post("/runs/coordinator/stop", { storeKey: key, instanceId: "has:colon", at: 5_000 })).status).toBe(
      400,
    );
    expect((await post("/runs/coordinator/stop", { storeKey: key, instanceId: instance.id })).status).toBe(400);
  });

  it.each([
    { pr: { number: 7, url: "https://github.com/acme/api/pull/7" } },
    { resume: { pr: 7 } },
    { lastPush: "a".repeat(40) },
    { progress: { phase: "publication-pending" } },
    {
      wakes: {
        wait: {
          kind: "segment" as const,
          index: 1,
          runId: "prior-run",
          spendUsd: 0,
          texts: [],
          senders: [],
          leaseMs: 1000,
        },
      },
    },
    { ending: { kind: "interrupted", report: "legacy ending", at: 1000 } },
  ])("replacement retains existing publication or execution evidence: %j", async (facts) => {
    const key = storeKey();
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: "U12",
      slug: "u12",
      branch: "plan/orchestration/u12",
      dependsOn: [],
      rounds: [],
      ...facts,
    };
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [unit] })).status).toBe(200);
    expect(
      await post("/runs/coordinator/replace", {
        storeKey: key,
        instance: { ...instance, runId: "replacement", createdAt: 2000 },
      }),
    ).toMatchObject({ status: 409, data: { ok: false, reason: "exists" } });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data.instance).toEqual(instance);
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: instance.id })).data.units).toEqual(
      [unit],
    );
  });

  it("refuses replacement of unreadable unit bytes without deleting the original owner", async () => {
    const key = storeKey();
    await post("/runs/coordinator/put", { storeKey: key, instance });
    const unit = {
      instanceId: instance.id,
      unit: "U12",
      slug: "u12",
      branch: "plan/orchestration/u12",
      dependsOn: [],
      rounds: [],
    };
    await post("/runs/coordinator/units/put", { storeKey: key, units: [unit] });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      state.storage.sql.exec(`UPDATE coordinator_units SET json = '{' WHERE instance_id = ?`, instance.id);
    });
    expect(
      await post("/runs/coordinator/replace", { storeKey: key, instance: { ...instance, runId: "replacement" } }),
    ).toMatchObject({ status: 409, data: { ok: false, reason: "exists" } });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data.instance).toEqual(instance);
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      expect(
        state.storage.sql
          .exec<{ json: string }>(`SELECT json FROM coordinator_units WHERE instance_id = ?`, instance.id)
          .one().json,
      ).toBe("{");
    });
  });

  it("replace writes the record over whatever the id holds — a different record, or none — drops the id's unit rows and no other instance's; a malformed record is 400", async () => {
    const key = storeKey();
    expect(await post("/runs/coordinator/put", { storeKey: key, instance })).toEqual({
      status: 200,
      data: { ok: true },
    });
    const row = (instanceId: string, unit: string): CoordinatorUnit => ({
      instanceId,
      unit,
      slug: unit.toLowerCase(),
      branch: `plan/orchestration/${unit.toLowerCase()}`,
      dependsOn: [],
      rounds: [],
    });
    await post("/runs/coordinator/units/put", {
      storeKey: key,
      units: [row(instance.id, "U12"), row(instance.id, "U13"), row("ship_other", "U12")],
    });
    const again = { ...instance, runId: "run-s2", createdAt: 2_000 };
    expect(await post("/runs/coordinator/replace", { storeKey: key, instance: again })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({ instance: again });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: instance.id })).data).toEqual({
      units: [],
    });
    const others = (await post("/runs/coordinator/units/list", { storeKey: key, instanceId: "ship_other" })).data
      .units as CoordinatorUnit[];
    expect(others.map((u) => u.unit)).toEqual(["U12"]);
    const fresh = { ...again, id: "ship_fresh" };
    expect((await post("/runs/coordinator/replace", { storeKey: key, instance: fresh })).status).toBe(200);
    expect((await post("/runs/coordinator/get", { storeKey: key, id: "ship_fresh" })).data).toEqual({
      instance: fresh,
    });
    expect(
      (await post("/runs/coordinator/replace", { storeKey: key, instance: { ...instance, kind: "review" } })).status,
    ).toBe(400);
  });

  it("validates: a malformed record or id is 400; no bearer is 401", async () => {
    const key = storeKey();
    expect(
      (await post("/runs/coordinator/put", { storeKey: key, instance: { ...instance, kind: "review" } })).status,
    ).toBe(400);
    expect((await post("/runs/coordinator/put", { storeKey: key })).status).toBe(400);
    expect((await post("/runs/coordinator/get", { storeKey: key, id: "has:colon" })).status).toBe(400);
    expect(
      (await post("/runs/coordinator/get", { storeKey: key, id: instance.id }, { "content-type": "application/json" }))
        .status,
    ).toBe(401);
  });
});

// Feature: docs/reference/specs/agent-ship.md item 16 and run-history.md item 50 —
// decision-record reservations survive bot-process restarts in the state Worker,
// with already-persisted unit and run rows included in the claim set.
describe("run ledger — main-agent task claims", () => {
  it("commits a main task only at the latest private requester revision", async () => {
    const key = storeKey();
    const firstUnit = ["U", "1"].join("");
    const threadKey = "slack:DMAIN:1700000000.000001";
    const requesterId = "slack:UALICE";
    const record = (messageId: string, questionTarget?: string) =>
      post("/runs/coordinator/requester-turn/record", {
        storeKey: key,
        input: { threadKey, requesterId, messageId, ...(questionTarget ? { questionTarget } : {}) },
      });
    expect((await record("1700000000.000001", "acme/api")).data).toMatchObject({
      ok: true,
      turn: { revision: 1, questionTarget: "acme/api" },
    });
    expect((await record("1700000000.000002")).data).toMatchObject({
      ok: true,
      turn: { revision: 2, priorQuestionTarget: "acme/api" },
    });
    const instance: CoordinatorInstance = {
      id: "plan_main_act_1",
      kind: "ship",
      userId: requesterId,
      channelId: "slack:DMAIN",
      threadKey,
      repo: "acme/api",
      branch: "plan/main-act/u1",
      base: "main",
      plan: { id: "main-act" },
      merge: "person",
      createdAt: 1_000,
    };
    const link = { mainThreadKey: threadKey, actId: "act-fix" };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: firstUnit,
      slug: "u1",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
      workBrief: {
        requesterId,
        mainThreadKey: threadKey,
        actId: link.actId,
        repo: instance.repo,
        base: "main",
        question: "Why did signup fail?",
        findings: [],
        requestedChange: "Fix signup",
      },
    };
    const authority = { requesterId, sourceMessageId: "1700000000.000002", revision: 2, repo: "acme/api" };
    expect(
      (
        await post("/runs/coordinator/main-task/claim", {
          storeKey: key,
          key: link,
          instance,
          unit,
          authority: { ...authority, revision: 1 },
        })
      ).status,
    ).toBe(409);
    expect((await record("1700000000.000003")).status).toBe(200);
    expect(
      (
        await post("/runs/coordinator/main-task/claim", {
          storeKey: key,
          key: link,
          instance,
          unit,
          authority,
        })
      ).status,
    ).toBe(409);
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({ instance: null });
    expect((await post("/runs/coordinator/main-task/get", { storeKey: key, key: link })).data).toEqual({ link: null });
  });

  it("claims the link with its instance and unit and replays it after a new request", async () => {
    const key = storeKey();
    const firstUnit = ["U", "1"].join("");
    const instance: CoordinatorInstance = {
      id: "plan_main_act_1",
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:CMAIN",
      threadKey: "slack:CMAIN:1.0",
      repo: "acme/api",
      branch: "plan/main-act/u1",
      base: "main",
      plan: { id: "main-act" },
      merge: "person",
      createdAt: 1_000,
    };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: firstUnit,
      slug: "u1",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
      workBrief: {
        requesterId: instance.userId,
        mainThreadKey: "slack:CMAIN:1.0",
        actId: "act-1",
        repo: instance.repo,
        base: instance.base!,
        question: "What failed?",
        findings: [],
        requestedChange: "Fix it",
      },
    };
    const link = { mainThreadKey: "slack:CMAIN:1.0", actId: "act-1" };
    const authority = { requesterId: instance.userId, sourceMessageId: "1", revision: 1, repo: instance.repo };
    expect(
      await post("/runs/coordinator/requester-turn/record", {
        storeKey: key,
        input: { threadKey: link.mainThreadKey, requesterId: instance.userId, messageId: "1" },
      }),
    ).toMatchObject({ status: 200, data: { turn: { revision: 1 } } });
    expect(
      await post("/runs/coordinator/main-task/claim", { storeKey: key, key: link, instance, unit, authority }),
    ).toEqual({
      status: 200,
      data: { ok: true, created: true, link: { instanceId: instance.id, unit: firstUnit, authority } },
    });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({ instance });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: instance.id })).data).toEqual({
      units: [unit],
    });
    expect(
      (await post("/runs/coordinator/units/put", { storeKey: key, units: [{ ...unit, workBrief: undefined }] })).status,
    ).toBe(200);
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: instance.id })).data).toEqual({
      units: [unit],
    });
    expect(
      (
        await post("/runs/coordinator/units/claim-legacy-continuation", {
          storeKey: key,
          expected: unit,
          recovered: { ...unit, title: "Progressed", workBrief: undefined },
        })
      ).status,
    ).toBe(200);
    const progressed = { ...unit, title: "Progressed" };
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: instance.id })).data).toEqual({
      units: [progressed],
    });
    const answer = { kind: "segment", index: 1, spendUsd: null, texts: [], senders: [] } as const;
    const waitId = `${firstUnit}/idle/1`;
    expect(
      (
        await post("/runs/coordinator/wake", {
          storeKey: key,
          unit: { ...progressed, workBrief: undefined },
          waitId,
          answer,
          seqs: [],
          by: "segment:1",
        })
      ).status,
    ).toBe(200);
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: instance.id })).data).toEqual({
      units: [{ ...progressed, wakes: { [waitId]: answer } }],
    });
    expect((await post("/runs/coordinator/main-task/get", { storeKey: key, key: link })).data).toEqual({
      link: { instanceId: instance.id, unit: firstUnit, authority },
    });
    expect(
      (
        await post("/runs/coordinator/main-task/claim", {
          storeKey: key,
          key: link,
          instance: { ...instance, id: "plan_other" },
          unit: { ...unit, instanceId: "plan_other" },
          authority,
        })
      ).data,
    ).toEqual({ ok: true, created: false, link: { instanceId: instance.id, unit: firstUnit, authority } });
    expect(
      (
        await post("/runs/coordinator/main-task/claim", {
          storeKey: key,
          key: { ...link, actId: "act-2" },
          instance,
          unit: { ...unit, workBrief: { ...unit.workBrief!, actId: "act-2" } },
          authority,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post("/runs/coordinator/main-task/claim", {
          storeKey: key,
          key: { mainThreadKey: "slack:COTHER:2.0", actId: "act-3" },
          instance: { ...instance, id: "plan_other_thread" },
          authority,
          unit: {
            ...unit,
            instanceId: "plan_other_thread",
            workBrief: { ...unit.workBrief!, mainThreadKey: "slack:COTHER:2.0", actId: "act-3" },
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (await post("/runs/coordinator/replace", { storeKey: key, instance: { ...instance, branch: "other" } })).status,
    ).toBe(409);
    expect(
      (
        await post("/runs/coordinator/main-task/claim", {
          storeKey: key,
          key: link,
          instance,
          unit: { ...unit, workBrief: { ...unit.workBrief!, question: "x".repeat(5000) } },
          authority,
        })
      ).status,
    ).toBe(400);
  });
});

describe("run ledger — durable decision-record reservations (agent-ship item 16)", () => {
  it("advances past reservations persisted on unit and run rows, and reuses a task key after a process restart", async () => {
    const key = storeKey();
    const instance: CoordinatorInstance = {
      id: "ship_record_reservations",
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:C1",
      threadKey: "slack:C1:1.0",
      repo: "acme/api",
      branch: "plan/records/u1",
      base: "main",
      createdAt: 1_000,
    };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: ["U", "1"].join(""),
      slug: "u1",
      branch: "plan/records/u1",
      dependsOn: [],
      record: "0075",
      rounds: [],
    };
    await post("/runs/coordinator/put", { storeKey: key, instance });
    await post("/runs/coordinator/units/put", { storeKey: key, units: [unit] });

    expect(
      await post("/runs/decision-record/reserve", {
        storeKey: key,
        repo: "acme/api",
        taskKey: "1111111111111111",
        claimed: ["0074"],
      }),
    ).toEqual({ status: 200, data: { number: "0076" } });
    expect(
      await post("/runs/decision-record/reserve", {
        storeKey: key,
        repo: "acme/api",
        taskKey: "1111111111111111",
        claimed: ["0074"],
      }),
    ).toEqual({ status: 200, data: { number: "0076" } });

    await post("/runs/put", {
      storeKey: key,
      record: { ...record("record-run", "slack:C1:2.0"), repo: "acme/api", record: "0077" },
    });
    expect(
      await post("/runs/decision-record/reserve", {
        storeKey: key,
        repo: "acme/api",
        taskKey: "2222222222222222",
        claimed: ["0074"],
      }),
    ).toEqual({ status: 200, data: { number: "0078" } });
  });
});

describe("run ledger — the coordinator's unit rows (item 50)", () => {
  it("commits recovery history and settlement atomically while fencing older writers", async () => {
    const storeKeyValue = storeKey();
    const call = (path: string, body: Record<string, unknown>) =>
      post(`/runs/coordinator/${path}`, { storeKey: storeKeyValue, ...body });
    const instance: CoordinatorInstance = {
      id: "ship_history",
      kind: "ship",
      userId: "slack:UA",
      channelId: "slack:C1",
      threadKey: "slack:C1:1.0",
      repo: "acme/api",
      branch: "plan/u1",
      base: "main",
      plan: { id: "history" },
      merge: "person",
      createdAt: 1,
      admission: "unreconciled",
    };
    let row: CoordinatorUnit = {
      instanceId: instance.id,
      unit: "U12",
      slug: "u1",
      branch: instance.branch,
      threadKey: instance.threadKey,
      dependsOn: [],
      rounds: [],
      ending: { kind: "aborted", report: "original", at: 10 },
    };
    expect((await call("put", { instance })).status).toBe(200);
    expect((await call("units/put", { units: [row] })).status).toBe(200);
    for (const number of [1, 2]) {
      const { ending, ...active } = row;
      const replacement: CoordinatorUnit = {
        ...active,
        recovery: {
          kind: "findings",
          round: number,
          expectedHeadSha: "a".repeat(40),
          remainingMs: 1000,
          claimedAt: 20 + number,
          step: `U12/recovery/${number}/findings`,
          reviewRunId: `review-${number}`,
          reviewKey: `review-key-${number}`,
          previousEnding: ending!,
          workflowId: `recovery-${number}`,
          deadlineAt: 1000,
        },
      };
      const input = {
        kind: "claim" as const,
        expected: row,
        replacement,
        request: { userId: instance.userId, threadKey: instance.threadKey, messageId: `slack:C1:${number + 1}.0` },
      };
      if (number === 1) {
        expect(await call("recovery/transition", { input })).toMatchObject({
          status: 409,
          data: { ok: false, reason: "conflict" },
        });
        expect((await call("recovery/history", { key: row, after: 0 })).data.receipts).toEqual([]);
        expect((await call("admission/confirm", { expected: { ...instance, runId: "different-create" } })).status).toBe(
          409,
        );
        expect((await call("admission/confirm", { expected: instance })).status).toBe(200);
        await runInDurableObject(
          env.RUNS.get(env.RUNS.idFromName(storeKeyValue)),
          async (store: RunHistoryDO, state) => {
            state.storage.sql.exec(
              `CREATE TRIGGER fail_recovery_action BEFORE INSERT ON coordinator_recovery_journal WHEN NEW.kind = 'action' BEGIN SELECT RAISE(ABORT, 'action write failed'); END`,
            );
            await expect(store.transitionRecovery(input, 20)).rejects.toThrow("action write failed");
            expect(state.storage.sql.exec(`SELECT * FROM coordinator_recovery_journal`).toArray()).toEqual([]);
            state.storage.sql.exec(`DROP TRIGGER fail_recovery_action`);
          },
        );
        expect((await call("units/list", { instanceId: instance.id })).data.units).toEqual([row]);
      }
      const claim = await call("recovery/transition", { input });
      expect(claim.status).toBe(200);
      row = claim.data.unit as CoordinatorUnit;
      expect(await call("recovery/transition", { input })).toMatchObject({
        status: 200,
        data: { ok: true, unit: row, replayed: true },
      });
      expect((await call("units/claim-legacy-continuation", { expected: row, recovered: active })).status).toBe(409);
      expect((await call("units/put", { units: [{ ...active, unit: "U13" }, active] })).status).toBe(409);
      expect((await call("replace", { instance })).status).toBe(409);
      const { recovery, ...settling } = row;
      const completed = await call("recovery/transition", {
        input: {
          kind: "settle",
          expected: row,
          replacement: {
            ...settling,
            ending: { kind: "aborted", report: `result ${number}`, at: 30 + number },
            recoveryReceipt: { reviewRunId: recovery!.reviewRunId, workflowId: recovery!.workflowId, at: 30 + number },
          },
        },
      });
      expect(completed.status).toBe(200);
      row = completed.data.unit as CoordinatorUnit;
      const savedHistory = await call("recovery/history", { key: row, after: 0 });
      expect((await call("admission/confirm", { expected: instance })).status).toBe(200);
      expect((await call("units/list", { instanceId: instance.id })).data.units).toEqual([row]);
      expect(await call("recovery/history", { key: row, after: 0 })).toEqual(savedHistory);
      expect((await call("get", { id: instance.id })).data.instance).toEqual({ ...instance, admission: "created" });
    }
    const history = await call("recovery/history", { key: { instanceId: row.instanceId, unit: row.unit }, after: 0 });
    expect(history).toMatchObject({
      status: 200,
      data: {
        cursor: 3,
        more: false,
        receipts: [
          { ending: { report: "original" } },
          { ending: { report: "result 1" } },
          { ending: { report: "result 2" } },
        ],
      },
    });
    expect((await call("units/list", { instanceId: instance.id })).data.units).toEqual([row]);
    const { ending: lastEnding, ...last } = row;
    const request = { userId: instance.userId, threadKey: instance.threadKey, messageId: "slack:C1:later" };
    const third = await call("recovery/transition", {
      input: {
        kind: "claim",
        expected: row,
        request,
        replacement: {
          ...last,
          recovery: {
            kind: "findings",
            round: 3,
            expectedHeadSha: "a".repeat(40),
            remainingMs: 1000,
            claimedAt: 40,
            step: "U12/recovery/3/findings",
            reviewRunId: "review-3",
            reviewKey: "review-key-3",
            previousEnding: lastEnding,
            workflowId: "recovery-3",
            deadlineAt: 1000,
          },
        },
      },
    });
    expect(third.status).toBe(200);
    const refusal = { kind: "refuse", expected: third.data.unit, replacement: row, error: "recovery_workflow_failed" };
    expect(await call("recovery/transition", { input: refusal })).toMatchObject({
      status: 200,
      data: { ok: true, unit: row },
    });
    expect(await call("recovery/transition", { input: refusal })).toMatchObject({
      status: 200,
      data: { ok: true, unit: row, replayed: true },
    });
    expect(await call("recovery/action", { key: { instanceId: instance.id, unit: row.unit }, request })).toMatchObject({
      status: 200,
      data: { action: { state: "refused", error: "recovery_workflow_failed", consumed: false } },
    });
    expect(await call("recovery/history", { key: { instanceId: instance.id, unit: row.unit }, after: 0 })).toEqual(
      history,
    );
  });
  const INSTANCE_ID = "ship_acme_api_1";
  const instance: CoordinatorInstance = {
    id: INSTANCE_ID,
    kind: "ship",
    userId: "slack:UALICE",
    channelId: "slack:C1",
    threadKey: "slack:C1:1.0",
    repo: "acme/api",
    branch: "plan/orchestration",
    base: "main",
    merge: "person",
    createdAt: 1000,
  };
  const unit = (name: string, over: Partial<CoordinatorUnit> = {}): CoordinatorUnit => ({
    instanceId: INSTANCE_ID,
    unit: name,
    slug: name.toLowerCase(),
    branch: `plan/orchestration/${name.toLowerCase()}`,
    dependsOn: [],
    rounds: [],
    ...over,
  });

  it("fences stale full-row and wake writes after typed settlement without committing part of a batch", async () => {
    const key = storeKey();
    const stale = unit("U12");
    const settled: CoordinatorUnit = {
      ...stale,
      ending: {
        kind: "aborted",
        report: "Stopped",
        at: 2_000,
        outcome: { schemaVersion: 1, kind: "aborted", reviewRounds: 1 },
      },
    };
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [stale] })).status).toBe(200);
    expect(
      (
        await post("/runs/coordinator/events/append", {
          storeKey: key,
          instanceId: INSTANCE_ID,
          unit: "U12",
          event: { sender: "slack:UALICE", text: "Proceed", mode: "steer", at: 1_000 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/runs/coordinator/units/claim-legacy-continuation", {
          storeKey: key,
          expected: stale,
          recovered: settled,
        })
      ).status,
    ).toBe(200);
    expect(
      await post("/runs/coordinator/units/put", {
        storeKey: key,
        units: [unit("U13"), { ...stale, startedAt: 3_000 }],
      }),
    ).toEqual({ status: 409, data: { ok: false, reason: "settled" } });
    expect(
      await post("/runs/coordinator/wake", {
        storeKey: key,
        unit: stale,
        waitId: "U12/wait/1",
        answer: { kind: "answered", reply: "Proceed" },
        seqs: [1],
        by: "wake",
      }),
    ).toEqual({ status: 409, data: { ok: false, reason: "settled" } });
    expect(
      (
        await post("/runs/coordinator/events/list", {
          storeKey: key,
          instanceId: INSTANCE_ID,
          unit: "U12",
          unconsumedOnly: true,
        })
      ).data,
    ).toMatchObject({ events: [{ seq: 1, text: "Proceed" }] });
    expect(
      await post("/runs/coordinator/replace", {
        storeKey: key,
        instance: {
          id: INSTANCE_ID,
          kind: "ship",
          userId: "slack:UALICE",
          channelId: "slack:C1",
          threadKey: "slack:C1:1.0",
          repo: "acme/api",
          branch: "plan/orchestration",
          base: "main",
          plan: { id: "orchestration" },
          merge: "person",
          createdAt: 1_000,
        },
      }),
    ).toEqual({ status: 409, data: { ok: false, reason: "exists" } });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: INSTANCE_ID })).data).toEqual({
      units: [settled],
    });
    expect(
      (
        await post("/runs/coordinator/units/claim-legacy-continuation", {
          storeKey: key,
          expected: settled,
          recovered: stale,
        })
      ).status,
    ).toBe(200);
  });

  it("persists a typed outcome and rejects malformed or foreign pull request facts without changing the stored row", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    const pr = { number: 7, url: "https://github.com/acme/api/pull/7" };
    const row = unit("U12", {
      pr,
      ending: {
        kind: "aborted",
        report: "Display only",
        at: 2_000,
        outcome: {
          schemaVersion: 1,
          kind: "aborted",
          reviewRounds: 2,
          terminalPr: { state: "merged", ...pr, mergeSha: "c".repeat(40), headSha: "b".repeat(40) },
          findings: {
            stop: "head_mismatch",
            observedHead: "a".repeat(40),
            remoteHead: "b".repeat(40),
            missingOutputCount: 1,
          },
        },
      },
    });
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [unit("U12", { pr })] })).status).toBe(
      200,
    );
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [row] })).status).toBe(200);
    for (const bad of [
      { ...row, ending: { ...row.ending, kind: "merged" } },
      { ...row, pr: { ...pr, number: 8 } },
      { ...row, ending: { ...row.ending, outcome: { ...row.ending!.outcome, schemaVersion: 2 } } },
    ]) {
      expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [bad] })).status).toBe(400);
      expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: INSTANCE_ID })).data).toEqual({
        units: [row],
      });
    }
  });

  it("put writes the rows and list reads an instance's back in first-written order; a row is replaced whole and keeps its place; another instance's rows never appear; an unknown instance lists none", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    expect(
      (await post("/runs/coordinator/put", { storeKey: key, instance: { ...instance, id: "ship_other" } })).status,
    ).toBe(200);
    expect(
      await post("/runs/coordinator/units/put", {
        storeKey: key,
        units: [unit("U12"), unit("U13", { dependsOn: ["U12"] })],
      }),
    ).toEqual({ status: 200, data: { ok: true } });
    expect(
      (
        await post("/runs/coordinator/units/put", {
          storeKey: key,
          units: [{ ...unit("U99"), instanceId: "ship_other" }],
        })
      ).status,
    ).toBe(200);
    const listed = await post("/runs/coordinator/units/list", { storeKey: key, instanceId: INSTANCE_ID });
    expect(listed.status).toBe(200);
    expect((listed.data.units as CoordinatorUnit[]).map((u) => u.unit)).toEqual(["U12", "U13"]);
    const reached = unit("U12", {
      threadKey: "slack:C1:2.0",
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      rounds: [{ index: 0, agent: "coding", outcome: "started", at: 1_000 }],
    });
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [reached] })).status).toBe(200);
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: INSTANCE_ID })).data).toEqual({
      units: [reached, unit("U13", { dependsOn: ["U12"] })],
    });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: "ship_none" })).data).toEqual({
      units: [],
    });
  });

  it("claim-legacy-continuation atomically replaces only the exact expected row, so a concurrent or stale caller cannot erase newer state", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    const legacy = unit("U12", {
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      ending: { kind: "merge_ready", report: "ready", at: 2_000 },
    });
    const recovered = {
      ...legacy,
      lastPush: "1".repeat(40),
      publication: {
        repo: "acme/api",
        pr: 7,
        headRef: legacy.branch,
        baseRef: "main",
        expectedHeadSha: "1".repeat(40),
        publicationRef: legacy.branch,
        owner: { instanceId: INSTANCE_ID, unit: "U12" },
      },
    } satisfies CoordinatorUnit;
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [legacy] })).status).toBe(200);

    expect(
      await post("/runs/coordinator/units/claim-legacy-continuation", { storeKey: key, expected: legacy, recovered }),
    ).toEqual({ status: 200, data: { ok: true } });
    expect(
      await post("/runs/coordinator/units/claim-legacy-continuation", { storeKey: key, expected: legacy, recovered }),
    ).toEqual({ status: 409, data: { ok: false, reason: "stale" } });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: INSTANCE_ID })).data).toEqual({
      units: [recovered],
    });
  });

  it("the full-row CAS atomically binds an ordinary open pull request and rejects a stale PR-only write", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    const unbound = unit("U12");
    const head = "a".repeat(40);
    const bound = {
      ...unbound,
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      publication: {
        repo: "acme/api",
        pr: 7,
        headRef: unbound.branch,
        baseRef: "main",
        expectedHeadSha: head,
        publicationRef: unbound.branch,
        owner: { instanceId: INSTANCE_ID, unit: "U12" },
      },
    } satisfies CoordinatorUnit;
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [unbound] })).status).toBe(200);

    expect(
      await post("/runs/coordinator/units/claim-legacy-continuation", {
        storeKey: key,
        expected: unbound,
        recovered: bound,
      }),
    ).toEqual({ status: 200, data: { ok: true } });
    expect(
      await post("/runs/coordinator/units/claim-legacy-continuation", {
        storeKey: key,
        expected: unbound,
        recovered: { ...unbound, pr: bound.pr },
      }),
    ).toEqual({ status: 409, data: { ok: false, reason: "stale" } });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: INSTANCE_ID })).data).toEqual({
      units: [bound],
    });
  });

  it("lists only active recovery rows in SQL, ignores terminal history, and fails closed on malformed candidate JSON", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    const active = unit("U12", {
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      recovery: {
        kind: "review",
        round: 2,
        expectedHeadSha: "a".repeat(40),
        remainingMs: 60_000,
        claimedAt: 2_000,
        step: "U12/recovery/2/review",
        reviewRunId: "review-1",
        previousEnding: { kind: "aborted", report: "recoverable", at: 1_000 },
        workflowId: "recovery-review-1",
        deadlineAt: 62_000,
        reviewKey: `${INSTANCE_ID}:U12/1/review`,
      },
    });
    const terminal = unit("U13", {
      ending: { kind: "merged", report: "done", at: 3_000 },
    });
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [active, terminal] })).status).toBe(200);
    const stub = env.RUNS.get(env.RUNS.idFromName(key));

    await expect(runInDurableObject(stub, (inst: RunHistoryDO) => inst.listActiveRecoveries())).resolves.toEqual([
      active,
    ]);

    await runInDurableObject(stub, async (_inst, state) => {
      state.storage.sql.exec(
        `INSERT INTO coordinator_units (instance_id, unit, json, updated_at) VALUES (?, ?, ?, ?)`,
        INSTANCE_ID,
        "U14",
        `{"recovery":`,
        4_000,
      );
    });
    await expect(runInDurableObject(stub, (inst: RunHistoryDO) => inst.listActiveRecoveries())).rejects.toThrow();
  });

  it("the validating wake boundary accepts a first-segment resume without inventing a renewal segment row", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    const row = unit("U12", {
      startedAt: 1_000,
      idle: { why: "stopped", at: 2_000, renewalsLeft: 2, spendUsd: null, wakes: 1 },
    });
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [row] })).status).toBe(200);
    expect(
      (
        await post("/runs/coordinator/events/append", {
          storeKey: key,
          instanceId: INSTANCE_ID,
          unit: "U12",
          event: { sender: "slack:UALICE", text: "resume", mode: "wake", at: 3_000 },
        })
      ).status,
    ).toBe(200);
    const answer = {
      kind: "segment",
      index: 1,
      spendUsd: null,
      texts: ["Alice: resume"],
      senders: ["Alice"],
      leaseMs: 60_000,
    } as const;
    const { idle: _idle, ...resumed } = row;
    expect(
      await post("/runs/coordinator/wake", {
        storeKey: key,
        unit: resumed,
        waitId: "U12/idle/1",
        answer,
        seqs: [1],
        by: "segment:1",
      }),
    ).toEqual({ status: 200, data: { ok: true } });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: INSTANCE_ID })).data).toEqual({
      units: [{ ...resumed, wakes: { "U12/idle/1": answer } }],
    });
    expect(
      (await post("/runs/coordinator/events/list", { storeKey: key, instanceId: INSTANCE_ID, unit: "U12" })).data,
    ).toMatchObject({ events: [{ consumedBy: "segment:1" }] });
  });

  it("validates: an empty list, a malformed row or instance id is 400; no bearer is 401", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [] })).status).toBe(400);
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [{ unit: "U12" }] })).status).toBe(400);
    expect(
      (
        await post("/runs/coordinator/units/claim-legacy-continuation", {
          storeKey: key,
          expected: unit("U12"),
          recovered: { ...unit("U12"), unit: "U13" },
        })
      ).status,
    ).toBe(400);
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: "has:colon" })).status).toBe(400);
    expect(
      (
        await post(
          "/runs/coordinator/units/list",
          { storeKey: key, instanceId: INSTANCE_ID },
          {
            "content-type": "application/json",
          },
        )
      ).status,
    ).toBe(401);
  });
});

// Feature: docs/reference/specs/run-history.md item 50 and record 0051's reply-as-event rule —
// the thread events of a unit-owned thread: a sibling table of the unit rows,
// appended in arrival order under the per-event cap, consumed once.
describe("run ledger — the coordinator's unit events (record 0051's reply-as-event rule)", () => {
  const INSTANCE_ID = "ship_acme_api_1";
  const event = (text: string, over: Record<string, unknown> = {}) => ({
    sender: "slack:UALICE",
    text,
    mode: "steer",
    at: 5_000,
    ...over,
  });

  it("guards a main-task steer against a stop in the same append transaction", async () => {
    const key = storeKey();
    const instance: CoordinatorInstance = {
      id: INSTANCE_ID,
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:C1",
      threadKey: "slack:C1:1.0",
      repo: "acme/api",
      branch: "plan/steer/u12",
      base: "main",
      createdAt: 1_000,
    };
    const unit: CoordinatorUnit = {
      instanceId: INSTANCE_ID,
      unit: "U12",
      slug: "u12",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
    };
    const body = { storeKey: key, instanceId: INSTANCE_ID, unit: "U12", requireActive: true };
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [unit] })).status).toBe(200);
    expect(
      await post("/runs/coordinator/events/append", { ...body, event: event("first", { id: "steer-1" }) }),
    ).toEqual({
      status: 200,
      data: { ok: true, seq: 1 },
    });
    expect((await post("/runs/coordinator/stop", { storeKey: key, instanceId: INSTANCE_ID, at: 6_000 })).status).toBe(
      200,
    );
    expect(
      await post("/runs/coordinator/events/append", { ...body, event: event("later", { id: "steer-2" }) }),
    ).toEqual({
      status: 409,
      data: { ok: false, reason: "ended" },
    });
    expect((await post("/runs/coordinator/events/list", body)).data).toMatchObject({ events: [{ text: "first" }] });
  });

  it("atomically refuses main-task steer and stop after the claimed branch changes", async () => {
    const key = storeKey();
    const instance: CoordinatorInstance = {
      id: INSTANCE_ID,
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:C1",
      threadKey: "slack:C1:1.0",
      repo: "acme/api",
      branch: "plan/steer/u12",
      base: "main",
      plan: { id: "main-steer" },
      merge: "person",
      createdAt: 1_000,
    };
    const unit: CoordinatorUnit = {
      instanceId: INSTANCE_ID,
      unit: "U12",
      slug: "u12",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
      workBrief: {
        requesterId: instance.userId,
        mainThreadKey: instance.threadKey,
        actId: "act-steer",
        repo: instance.repo,
        base: instance.base!,
        question: "What failed?",
        findings: [],
        requestedChange: "Fix it",
      },
    };
    const binding = {
      key: { mainThreadKey: instance.threadKey, actId: "act-steer" },
      instanceId: instance.id,
      unit: unit.unit,
      branch: instance.branch,
      channelId: instance.channelId,
      requesterId: instance.userId,
    };
    const authority = { requesterId: instance.userId, sourceMessageId: "1", revision: 1, repo: instance.repo };
    expect(
      (
        await post("/runs/coordinator/requester-turn/record", {
          storeKey: key,
          input: { threadKey: instance.threadKey, requesterId: instance.userId, messageId: "1" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await post("/runs/coordinator/main-task/claim", { storeKey: key, key: binding.key, instance, unit, authority }))
        .status,
    ).toBe(200);
    const first = event("first steer", { id: "steer-first" });
    const firstAppend = {
      storeKey: key,
      instanceId: instance.id,
      unit: unit.unit,
      requireActive: true,
      binding,
    };
    expect(await post("/runs/coordinator/events/append", { ...firstAppend, event: first })).toEqual({
      status: 200,
      data: { ok: true, seq: 1, event: { ...first, seq: 1 } },
    });
    expect(
      await post("/runs/coordinator/events/append", {
        ...firstAppend,
        event: event("changed words", { id: "steer-first" }),
      }),
    ).toEqual({ status: 200, data: { ok: true, seq: 1, event: { ...first, seq: 1 } } });
    expect(
      (await post("/runs/coordinator/units/put", { storeKey: key, units: [{ ...unit, branch: "plan/other" }] })).status,
    ).toBe(200);
    expect(
      await post("/runs/coordinator/events/append", {
        storeKey: key,
        instanceId: instance.id,
        unit: unit.unit,
        event: event("stale steer", { id: "steer-stale" }),
        requireActive: true,
        binding,
      }),
    ).toEqual({ status: 409, data: { ok: false, reason: "stale" } });
    expect(
      await post("/runs/coordinator/stop", { storeKey: key, instanceId: instance.id, at: 6_000, binding }),
    ).toEqual({
      status: 409,
      data: { ok: false, reason: "stale" },
    });
    expect(
      (await post("/runs/coordinator/events/list", { storeKey: key, instanceId: instance.id, unit: unit.unit })).data,
    ).toEqual({ events: [{ ...first, seq: 1 }] });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({ instance });
  });

  it("append assigns sequences in order and caps per event; list filters unconsumed; mark-consumed is idempotent; a put of the unit row leaves the events untouched", async () => {
    const key = storeKey();
    const body = { storeKey: key, instanceId: INSTANCE_ID, unit: "U12" };
    const seeded = event("first", { id: `${INSTANCE_ID}:U12:ship-request` });
    expect(await post("/runs/coordinator/events/append", { ...body, event: seeded })).toEqual({
      status: 200,
      data: { ok: true, seq: 1 },
    });
    expect(await post("/runs/coordinator/events/append", { ...body, event: seeded })).toEqual({
      status: 200,
      data: { ok: true, seq: 1 },
    });
    expect(await post("/runs/coordinator/events/append", { ...body, event: event("second") })).toEqual({
      status: 200,
      data: { ok: true, seq: 2 },
    });
    // Over the durable cap (400 KiB): the attachments are dropped whole and the row says how many.
    const heavy = event("third", { attachments: [{ mediaType: "image/png", data: "x".repeat(500 * 1024) }] });
    expect((await post("/runs/coordinator/events/append", { ...body, event: heavy })).data).toEqual({
      ok: true,
      seq: 3,
    });
    const all = await post("/runs/coordinator/events/list", body);
    const rows = all.data.events as Array<Record<string, unknown>>;
    expect(rows.map((e) => [e.seq, e.text])).toEqual([
      [1, "first"],
      [2, "second"],
      [3, "third"],
    ]);
    expect(rows[2]!.attachments).toBeUndefined();
    expect(rows[2]!.attachmentsDropped).toBe(1);
    // Consumed once: a second mark keeps the first consumer; list filters unconsumed.
    expect(
      (await post("/runs/coordinator/events/mark-consumed", { ...body, seqs: [1, 2], by: "spawn:U12/1/fix" })).data,
    ).toEqual({ ok: true });
    expect(
      (await post("/runs/coordinator/events/mark-consumed", { ...body, seqs: [1], by: "spawn:U12/2/fix" })).data,
    ).toEqual({ ok: true });
    const unconsumed = await post("/runs/coordinator/events/list", { ...body, unconsumedOnly: true });
    expect((unconsumed.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([3]);
    const after = await post("/runs/coordinator/events/list", body);
    expect((after.data.events as Array<{ consumedBy?: string }>).map((e) => e.consumedBy)).toEqual([
      "spawn:U12/1/fix",
      "spawn:U12/1/fix",
      undefined,
    ]);
    // A put of the unit row — the whole-row upsert — leaves the events untouched (record 0051).
    const row: CoordinatorUnit = {
      instanceId: INSTANCE_ID,
      unit: "U12",
      slug: "u12",
      branch: "plan/orchestration/u12",
      dependsOn: [],
      rounds: [],
      threadKey: "slack:C1:2.0",
    };
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [row] })).status).toBe(200);
    const kept = await post("/runs/coordinator/events/list", body);
    expect((kept.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([1, 2, 3]);
    // Another unit's list is its own.
    expect((await post("/runs/coordinator/events/list", { ...body, unit: "U13" })).data).toEqual({ events: [] });
    // A text alone over the cap is cut to fit and the row says how many characters went.
    const wordy = event("w".repeat(500 * 1024));
    expect((await post("/runs/coordinator/events/append", { ...body, event: wordy })).data).toEqual({
      ok: true,
      seq: 4,
    });
    const events = async () =>
      (await post("/runs/coordinator/events/list", body)).data.events as Array<Record<string, unknown>>;
    const fourth = (await events())[3]!;
    expect((fourth.text as string).length).toBeLessThan(500 * 1024);
    expect(fourth.textDropped).toBe(500 * 1024 - (fourth.text as string).length);
    // A caller's `consumedBy` never rides the append: the row is born unconsumed in its JSON as in its column.
    const presumptuous = event("fifth", { consumedBy: "spawn:U12/9/fix" });
    expect((await post("/runs/coordinator/events/append", { ...body, event: presumptuous })).data).toEqual({
      ok: true,
      seq: 5,
    });
    expect((await events())[4]!.consumedBy).toBeUndefined();
    const stillOpen = await post("/runs/coordinator/events/list", { ...body, unconsumedOnly: true });
    expect((stillOpen.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("validates: a malformed event, unit, instance id, seqs or consumer is 400", async () => {
    const key = storeKey();
    const body = { storeKey: key, instanceId: INSTANCE_ID, unit: "U12" };
    expect((await post("/runs/coordinator/events/append", { ...body, event: { text: "x" } })).status).toBe(400);
    expect(
      (
        await post("/runs/coordinator/events/append", {
          storeKey: key,
          instanceId: "has:colon",
          unit: "U12",
          event: event("x"),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/runs/coordinator/events/append", {
          storeKey: key,
          instanceId: INSTANCE_ID,
          unit: "u/12",
          event: event("x"),
        })
      ).status,
    ).toBe(400);
    expect((await post("/runs/coordinator/events/mark-consumed", { ...body, seqs: [0], by: "r" })).status).toBe(400);
    expect((await post("/runs/coordinator/events/mark-consumed", { ...body, seqs: [1], by: "" })).status).toBe(400);
  });
});

// Feature: docs/reference/specs/session-log.md item 7 — the sessions registry
// on RunHistoryDO and the sweep's drop: a session object goes only when every
// kept run of the session is gone and no live run holds its thread, owner row
// first, then the rows.
describe("the sessions registry and the sweep's drop of a session log", () => {
  const sql = <T extends Record<string, unknown>>(key: string, query: string, ...params: unknown[]) =>
    runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_inst, state) =>
      state.storage.sql.exec<T>(query, ...params).toArray(),
    );
  const sessionOf = (threadKey: string, agent: string) => `${threadKey}:${agent}`;
  const sessionStub = (skey: string) => env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(skey));
  const withSession = (threadKey: string, agent: string, seedFrom: number) => ({
    session: { key: sessionOf(threadKey, agent), seedFrom, request: seedFrom, range: { from: seedFrom } },
  });
  const seedRows = async (skey: string, gen: string, runId: string, count: number) => {
    await post("/runs/session/owner", { key: skey, runId, gen });
    await post("/runs/session/write", {
      key: skey,
      gen,
      rows: Array.from({ length: count }, (_, i) => ({
        idx: i,
        part: 0,
        json: JSON.stringify({ role: "user", part: { type: "text", text: `turn ${i}` } }),
      })),
      attachments: [],
    });
  };

  it("a claim with a session registers it under its thread and agent; the finish stamps the run's row with the session key, refreshes the registry's finish time and the object's bytes", async () => {
    const key = storeKey();
    const thread = "slack:C1:1.0";
    const skey = sessionOf(thread, "review");
    expect(
      (
        await post(
          "/runs/claim",
          claimBody(key, "r1", thread, "g1", {
            meta: {
              agent: "review",
              channelId: "slack:C1",
              userId: "u",
              threadKey: thread,
              ...withSession(thread, "review", 0),
            },
          }),
        )
      ).status,
    ).toBe(200);
    expect(await sql(key, `SELECT key, thread_key, agent, last_finished_at, bytes FROM sessions`)).toEqual([
      { key: skey, thread_key: thread, agent: "review", last_finished_at: 0, bytes: 0 },
    ]);
    await seedRows(skey, "g1", "r1", 3);
    const rec = { ...record("r1", thread), session: { key: skey, seedFrom: 0, request: 0, range: { from: 0, to: 2 } } };
    expect((await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: rec })).status).toBe(200);
    expect(await sql(key, `SELECT run_id, session_key FROM runs`)).toEqual([{ run_id: "r1", session_key: skey }]);
    const [row] = await sql<{ last_finished_at: number; bytes: number }>(
      key,
      `SELECT last_finished_at, bytes FROM sessions WHERE key = ?`,
      skey,
    );
    expect(row.last_finished_at).toBe(rec.finishedAt);
    expect(row.bytes).toBeGreaterThan(0);
    // The finish cleared nothing: the log's rows stay for the next run.
    expect((await post("/runs/session/tail", { key: skey })).data).toEqual({ next: 3 });
    // A record without a session leaves the column null.
    await post("/runs/put", { storeKey: key, record: record("plain", "slack:C1:9.0") });
    expect(await sql(key, `SELECT session_key FROM runs WHERE run_id = 'plain'`)).toEqual([{ session_key: null }]);
  });

  it("the sweep drops a session object only once every kept run of it is gone and no live run holds the thread — owner cleared, rows gone, registry row deleted; a session with a kept run or a live thread stays", async () => {
    const key = storeKey();
    const now = Date.now();
    const DAY = 86_400_000;
    const gone = "slack:C1:1.0";
    const kept = "slack:C1:2.0";
    const live = "slack:C1:3.0";
    const sGone = sessionOf(gone, "review");
    const sKept = sessionOf(kept, "review");
    const sLive = sessionOf(live, "review");
    const sLiveOther = sessionOf(live, "coding");
    // Three finished sessions: one whose only run is old, one whose run is fresh,
    // one whose old run finished but whose thread has a live run of another agent.
    for (const [runId, thread, skey, finishedAt] of [
      ["r-gone", gone, sGone, now - 40 * DAY],
      ["r-kept", kept, sKept, now - 1000],
      ["r-live", live, sLive, now - 40 * DAY],
    ] as const) {
      await seedRows(skey, "g1", runId, 2);
      await post(
        "/runs/claim",
        claimBody(key, runId, thread, "g1", {
          meta: {
            agent: "review",
            channelId: "slack:C1",
            userId: "u",
            threadKey: thread,
            ...withSession(thread, "review", 0),
          },
        }),
      );
      const rec = {
        ...record(runId, thread),
        startedAt: finishedAt - 5000,
        finishedAt,
        session: { key: skey, seedFrom: 0, request: 0, range: { from: 0, to: 1 } },
      };
      await post("/runs/finish", { storeKey: key, runId, gen: "g1", record: rec });
    }
    // The live run on the third thread, a coding session with no record yet.
    await seedRows(sLiveOther, "g1", "r-live-2", 1);
    await post(
      "/runs/claim",
      claimBody(key, "r-live-2", live, "g1", {
        meta: {
          agent: "coding",
          channelId: "slack:C1",
          userId: "u",
          threadKey: live,
          ...withSession(live, "coding", 0),
        },
      }),
    );
    expect((await sql(key, `SELECT key FROM sessions ORDER BY key`)).map((r) => r.key)).toEqual(
      [sGone, sKept, sLive, sLiveOther].sort(),
    );
    // Retention keeps 30 days: the two old records fall out at the sweep.
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), (inst: RunHistoryDO) => inst.alarm());
    expect((await sql(key, `SELECT run_id FROM runs ORDER BY run_id`)).map((r) => r.run_id)).toEqual(["r-kept"]);
    expect((await sql(key, `SELECT key FROM sessions ORDER BY key`)).map((r) => r.key)).toEqual(
      [sKept, sLive, sLiveOther].sort(),
    );
    // The dropped object: owner gone (a late write is unknown-run), rows gone.
    expect((await post("/runs/session/write", { key: sGone, gen: "g1", rows: [], attachments: [] })).data).toEqual({
      ok: false,
      reason: "unknown-run",
    });
    expect((await post("/runs/session/tail", { key: sGone })).data).toEqual({ next: 0 });
    // The kept session and both sessions of the live thread are untouched.
    expect((await post("/runs/session/tail", { key: sKept })).data).toEqual({ next: 2 });
    expect((await post("/runs/session/tail", { key: sLive })).data).toEqual({ next: 2 });
    expect((await post("/runs/session/tail", { key: sLiveOther })).data).toEqual({ next: 1 });
    expect(await runInDurableObject(sessionStub(sLive), (inst: SessionLogDO) => inst.rowCount())).toBe(2);
  });

  it("the drop decides on what it re-reads at each drop, not on the candidate list: a run that went live on the thread, or a record that named the session, between the list and the drop keeps the session and its registry row", async () => {
    const key = storeKey();
    const now = Date.now();
    const DAY = 86_400_000;
    const threadA = "slack:C1:11.0";
    const threadB = "slack:C1:12.0";
    const sA = sessionOf(threadA, "review");
    const sB = sessionOf(threadB, "review");
    for (const [runId, thread, skey] of [
      ["r-a", threadA, sA],
      ["r-b", threadB, sB],
    ] as const) {
      await seedRows(skey, "g1", runId, 2);
      await post(
        "/runs/claim",
        claimBody(key, runId, thread, "g1", {
          meta: {
            agent: "review",
            channelId: "slack:C1",
            userId: "u",
            threadKey: thread,
            ...withSession(thread, "review", 0),
          },
        }),
      );
      await post("/runs/finish", {
        storeKey: key,
        runId,
        gen: "g1",
        record: {
          ...record(runId, thread),
          startedAt: now - 40 * DAY - 5000,
          finishedAt: now - 40 * DAY,
          session: { key: skey, seedFrom: 0, request: 0, range: { from: 0, to: 1 } },
        },
      });
    }
    // The list the sweep's transaction would produce once retention drops both old records.
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_inst, state) => {
      state.storage.sql.exec(`DELETE FROM run_events WHERE run_id IN ('r-a', 'r-b')`);
      state.storage.sql.exec(`DELETE FROM runs WHERE run_id IN ('r-a', 'r-b')`);
    });
    const candidates = [
      { key: sA, threadKey: threadA },
      { key: sB, threadKey: threadB },
    ];
    // Between the list and the drop: a new run goes live on thread A, and a
    // fresh record names session B.
    await post(
      "/runs/claim",
      claimBody(key, "r-a2", threadA, "g1", {
        meta: { agent: "coding", channelId: "slack:C1", userId: "u", threadKey: threadA },
      }),
    );
    await post("/runs/put", {
      storeKey: key,
      record: { ...record("r-b2", threadB), session: { key: sB, seedFrom: 2, request: 2, range: { from: 2, to: 3 } } },
    });
    const dropped = await runInDurableObject(stub, (inst: RunHistoryDO) => inst.sweepSessions(candidates));
    expect(dropped).toBe(0);
    expect((await post("/runs/session/tail", { key: sA })).data).toEqual({ next: 2 });
    expect((await post("/runs/session/tail", { key: sB })).data).toEqual({ next: 2 });
    expect((await sql(key, `SELECT key FROM sessions ORDER BY key`)).map((r) => r.key)).toEqual([sA, sB].sort());
    // Once thread A's run finishes with no record and session B's record is gone, the same list drops both.
    await post("/runs/abandon", { storeKey: key, runId: "r-a2", gen: "g1" });
    await post("/runs/delete", { storeKey: key, id: "r-b2" });
    expect(await runInDurableObject(stub, (inst: RunHistoryDO) => inst.sweepSessions(candidates))).toBe(2);
    expect((await post("/runs/session/tail", { key: sA })).data).toEqual({ next: 0 });
    expect(await sql(key, `SELECT key FROM sessions`)).toEqual([]);
  });
});

describe("run ledger — intake receipts (item 59)", () => {
  it("emits telemetry after one committed receipt, never on replay or legacy writes, and contains sink failures", async () => {
    const key = storeKey();
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (instance: RunHistoryDO) => {
      const holder = instance as unknown as { metrics: { write(point: RunMetricsPoint): void } };
      const previous = holder.metrics;
      const points: RunMetricsPoint[] = [];
      holder.metrics = {
        write: (point) => {
          points.push(point);
        },
      };
      const row: IntakeReceipt = {
        verdict: "silent",
        reason: "private text",
        source: "model",
        mode: "classify",
        model: "typesafe/jev-1.13.0",
        gen: 1,
        threadKey: "slack:C1:1.0",
        decidedAt: 1000,
        experiment: {
          id: "trial",
          messageKey: "C1:2.0",
          arm: "jev",
          elapsedMs: 150,
          calls: 1,
          inputTokens: 800,
          outputTokens: 42,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          knownCostUsd: 0.0000336,
          unpricedCalls: 0,
          missingUsageCalls: 0,
        },
      };
      try {
        expect((await instance.recordIntake("C1:2.0", row, 0, true)).inserted).toBe(true);
        expect(await instance.readIntake("C1:2.0")).toEqual(row);
        expect((await instance.recordIntake("C1:2.0", { ...row, verdict: "addressed" }, 0, true)).inserted).toBe(false);
        await instance.recordIntake("legacy", row, 0);
        expect(points).toHaveLength(1);
        expect(points[0]!.blobs[0]).toBe("intake-1");
        expect(points[0]!.blobs[5]).toBe("silent");
        await instance.recordIntake("C1:3.0", { ...row, verdict: "addressed" }, 0, true);
        expect(points.map((point) => point.blobs[5])).toEqual(["silent", "addressed"]);
        holder.metrics = {
          write: () => {
            throw new Error("sink unavailable");
          },
        };
        expect((await instance.recordIntake("C1:4.0", { ...row, verdict: "addressed" }, 0, true)).inserted).toBe(true);
        expect((await instance.readIntake("C1:4.0"))?.verdict).toBe("addressed");
      } finally {
        holder.metrics = previous;
      }
    });
  });
  const HOUR = 3_600_000;
  const intakeReceipt = (threadKey: string, over: Record<string, unknown> = {}) => ({
    verdict: "silent",
    reason: "answering a colleague",
    source: "model",
    mode: "classify",
    model: "prov/mini",
    gen: 3,
    threadKey,
    decidedAt: 5_000,
    ...over,
  });

  it("the insert is if-absent inside the transaction: the first write answers inserted with the row, a second on the key answers the first stored row; read answers the row or null", async () => {
    const key = storeKey();
    expect((await post("/runs/intake/read", { storeKey: key, key: "slack:C1:2.0" })).data).toEqual({ receipt: null });
    const first = intakeReceipt("slack:C1:1.0", {
      source: "error",
      providerFailure: "credit-or-quota-exhausted",
      reason: "The model provider's credit or quota is exhausted; this request did not start.",
    });
    expect(await post("/runs/intake", { storeKey: key, key: "slack:C1:2.0", receipt: first })).toMatchObject({
      status: 200,
      data: { inserted: true, stored: first },
    });
    const second = intakeReceipt("slack:C1:1.0", { verdict: "addressed", decidedAt: 6_000, gen: 9 });
    expect((await post("/runs/intake", { storeKey: key, key: "slack:C1:2.0", receipt: second })).data).toEqual({
      inserted: false,
      stored: first,
    });
    expect((await post("/runs/intake/read", { storeKey: key, key: "slack:C1:2.0" })).data).toEqual({
      receipt: first,
    });
  });

  it("claims one failure delivery atomically, releases a rejected post, and closes a successful post", async () => {
    const key = storeKey();
    const receiptKey = "slack:C1:2.0";
    await post("/runs/intake", {
      storeKey: key,
      key: receiptKey,
      receipt: intakeReceipt("slack:C1:1.0", { source: "error", providerFailure: "transient" }),
    });
    const claim = (poster: string, claimedAt = 5_000) =>
      post("/runs/intake/delivery/claim", { storeKey: key, key: receiptKey, poster, claimedAt });
    const [a, b] = await Promise.all([claim("poster-a"), claim("poster-b")]);
    expect([a.data.claimed, b.data.claimed].sort()).toEqual([false, true]);
    const owner = a.data.claimed === true ? "poster-a" : "poster-b";
    const loser = owner === "poster-a" ? "poster-b" : "poster-a";

    await post("/runs/intake/delivery/finish", {
      storeKey: key,
      key: receiptKey,
      poster: loser,
      delivered: false,
    });
    expect((await claim("poster-c")).data).toEqual({ claimed: false });
    await post("/runs/intake/delivery/finish", {
      storeKey: key,
      key: receiptKey,
      poster: owner,
      delivered: false,
    });
    expect((await claim("poster-c")).data).toEqual({ claimed: true });
    await post("/runs/intake/delivery/finish", {
      storeKey: key,
      key: receiptKey,
      poster: "poster-c",
      delivered: true,
    });
    expect((await claim("poster-d", Number.MAX_SAFE_INTEGER)).data).toEqual({ claimed: false });
  });

  it("list answers a thread's rows and rows since an instant, oldest first", async () => {
    const key = storeKey();
    const a = intakeReceipt("slack:C1:1.0", { decidedAt: 1_000 });
    const b = intakeReceipt("slack:C1:1.0", { decidedAt: 3_000, verdict: "addressed" });
    const other = intakeReceipt("slack:C2:9.0", { decidedAt: 2_000 });
    await post("/runs/intake", { storeKey: key, key: "slack:C1:3.0", receipt: b });
    await post("/runs/intake", { storeKey: key, key: "slack:C1:2.0", receipt: a });
    await post("/runs/intake", { storeKey: key, key: "slack:C2:9.5", receipt: other });
    expect((await post("/runs/intake/list", { storeKey: key, threadKey: "slack:C1:1.0" })).data).toEqual({
      receipts: [a, b],
    });
    expect((await post("/runs/intake/list", { storeKey: key, since: 2_000 })).data).toEqual({
      receipts: [other, b],
    });
    expect((await post("/runs/intake/list", { storeKey: key, threadKey: "slack:C1:1.0", since: 2_000 })).data).toEqual({
      receipts: [b],
    });
    expect((await post("/runs/intake/list", { storeKey: key })).data).toEqual({ receipts: [a, other, b] });
  });

  it("the alarm prunes by both arms of the bound: a 30 minute window keeps a row 24 hours, a two day window keeps it the window plus the drain deadline", async () => {
    const key = storeKey();
    const now = Date.now();
    const min30 = 30 * 60_000;
    const twoDays = 48 * HOUR;
    const at = (hoursAgo: number) => intakeReceipt("slack:C1:1.0", { decidedAt: now - hoursAgo * HOUR });
    // The 24-hour arm: a 30 minute window keeps rows 24 hours, no more.
    await post("/runs/intake", { storeKey: key, key: "k:24h-out", receipt: at(25), windowMs: min30 });
    await post("/runs/intake", { storeKey: key, key: "k:24h-kept", receipt: at(23), windowMs: min30 });
    // The window arm: a two-day window keeps rows the window plus the drain (90 min).
    await post("/runs/intake", { storeKey: key, key: "k:win-out", receipt: at(50), windowMs: twoDays });
    await post("/runs/intake", { storeKey: key, key: "k:win-kept", receipt: at(49), windowMs: twoDays });
    expect(await runDurableObjectAlarm(env.RUNS.get(env.RUNS.idFromName(key)))).toBe(true); // armed by the first insert
    const read = async (k: string) =>
      (await post("/runs/intake/read", { storeKey: key, key: k })).data.receipt as unknown;
    expect(await read("k:24h-out")).toBeNull();
    expect(await read("k:24h-kept")).not.toBeNull();
    expect(await read("k:win-out")).toBeNull();
    expect(await read("k:win-kept")).not.toBeNull();
  });

  it("validates: a missing or overlong key, a malformed receipt or windowMs is 400; no bearer is 401", async () => {
    const key = storeKey();
    expect((await post("/runs/intake", { storeKey: key, receipt: intakeReceipt("slack:C1:1.0") })).status).toBe(400);
    expect(
      (await post("/runs/intake", { storeKey: key, key: "k".repeat(300), receipt: intakeReceipt("slack:C1:1.0") }))
        .status,
    ).toBe(400);
    expect(
      (await post("/runs/intake", { storeKey: key, key: "slack:C1:2.0", receipt: { verdict: "maybe" } })).status,
    ).toBe(400);
    expect(
      (
        await post("/runs/intake", {
          storeKey: key,
          key: "slack:C1:2.0",
          receipt: intakeReceipt("slack:C1:1.0"),
          windowMs: -5,
        })
      ).status,
    ).toBe(400);
    expect((await post("/runs/intake/read", { storeKey: key })).status).toBe(400);
    expect((await post("/runs/intake/list", { storeKey: key, since: "yesterday" })).status).toBe(400);
    expect(
      (
        await post(
          "/runs/intake",
          { storeKey: key, key: "k", receipt: intakeReceipt("slack:C1:1.0") },
          { "content-type": "application/json" },
        )
      ).status,
    ).toBe(401);
  });
});

describe("the plane's admission stage — /plane/admit, reservations, the seal's walk (orchestration-plane; record 0064)", () => {
  const requester = "slack:UALICE";
  const admit = (key: string, threadKey: string, text: string) =>
    post("/plane/admit", { storeKey: key, threadKey, requester, request: { text } });

  it("two asks a second apart on one thread: the first is admitted with a reservation, the second queued at position 1; the first's claim promotes the reservation; the seal admits the queued run with its attaching row", async () => {
    const key = storeKey();
    const t = "slack:C1:1.0";
    const one = await admit(key, t, "one");
    expect(one.status).toBe(200);
    expect(one.data.kind).toBe("admitted");
    expect(typeof one.data.reservation).toBe("string");
    const two = await admit(key, t, "two");
    expect(two.data).toMatchObject({
      kind: "queued",
      position: 1,
      waiting: [{ kind: "thread_free", threadKey: t, met: false }],
    });
    const queuedId = two.data.id as string;
    const queued = await post("/plane/queued", { storeKey: key, runId: queuedId });
    expect(queued.data.row).toMatchObject({ runId: queuedId, state: "waiting" });
    expect(queued.data.row).not.toHaveProperty("liveState");
    // The ledger claim promotes the reservation: the row retires in the claim's
    // transaction and the live row holds the thread from there.
    expect((await post("/runs/claim", claimBody(key, "r1", t))).status).toBe(200);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      expect(sql.exec(`SELECT * FROM plane_reservations`).toArray()).toEqual([]);
    });
    // A third ask still queues — the thread is live, position ranks it behind the second.
    expect((await admit(key, t, "three")).data).toMatchObject({ kind: "queued", position: 2 });
    // The seal flips thread_free: the queued run is admitted, its admit effect
    // is offered carrying the stored request, and its attaching row exists
    // under the plane's id (the restart-from-request path's shape).
    expect(
      (await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", t) })).status,
    ).toBe(200);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const effects = inst.openPlaneEffects();
      expect(effects.map((e) => e.id)).toEqual([`admit:${queuedId}`]);
      expect(effects[0]).toMatchObject({ kind: "admit", runId: queuedId, threadKey: t, request: { text: "two" } });
      const live = await inst.listLive();
      const row = live.find((r) => r.runId === queuedId)!;
      expect(row).toMatchObject({ threadKey: t, ownerGen: "plane", phase: "attaching" });
      expect(row.meta.request).toEqual({ text: "two" });
      expect(await inst.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({ ok: true, owners: [] });
    });
  });

  it("a duplicate admit decision after a roll keeps the effect's first offer and the attaching row (INSERT OR IGNORE)", async () => {
    const key = storeKey();
    const t = "slack:C2:2.0";
    await admit(key, t, "one");
    await post("/runs/claim", claimBody(key, "r1", t));
    const q = (await admit(key, t, "two")).data.id as string;
    await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", t) });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.id)).toEqual([`admit:${q}`]);
    });
  });

  it("runs stop on a queued id withdraws it: the row goes withdrawn, a second withdraw answers false, and the seal admits nothing", async () => {
    const key = storeKey();
    const t = "slack:C3:3.0";
    await admit(key, t, "one");
    await post("/runs/claim", claimBody(key, "r1", t));
    const q = (await admit(key, t, "two")).data.id as string;
    expect((await post("/plane/withdraw", { storeKey: key, runId: q })).data).toEqual({ withdrawn: true });
    expect((await post("/plane/withdraw", { storeKey: key, runId: q })).data).toEqual({ withdrawn: false });
    expect((await post("/plane/queued", { storeKey: key, runId: q })).data.row).toMatchObject({ state: "withdrawn" });
    await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", t) });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects()).toEqual([]);
    });
  });

  it("a pending deploy queues an ask on deploy_settled and deploy.landed flips it, admitting the queued run", async () => {
    const key = storeKey();
    const t = "slack:C4:4.0";
    expect((await post("/plane/deploy", { storeKey: key, phase: "pending" })).status).toBe(200);
    const asked = await admit(key, t, "hi");
    expect(asked.data).toMatchObject({
      kind: "queued",
      position: 1,
      waiting: [{ kind: "deploy_settled", met: false }],
    });
    const landed = await post("/plane/deploy", { storeKey: key, phase: "landed", version: "1.0.0" });
    expect(landed.data).toEqual({ ok: true, admitted: 1 });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.kind)).toEqual(["admit"]);
    });
  });

  const sealedRunFailureOutput: string[] = [];

  it.fails("the real onTestFailed lifecycle emits completed and pending sealed-run stages", async (context) => {
    let now = 10;
    const timed = timeSealedRunStages(
      (handler) => context.onTestFailed(handler),
      () => now,
      (message) => sealedRunFailureOutput.push(message),
    );
    await timed("admit", async () => {
      now = 15;
    });
    void timed("claim", () => new Promise(() => {}));
    now = 24;

    expect("forced failure").toBe("success");
  });

  it("preserves completed and pending stage diagnostics from the genuine failure", () => {
    expect(sealedRunFailureOutput).toEqual([
      "[memory diagnostics] sealed-run stages: completed=admit=5ms; pending=claim=9ms",
    ]);
  });

  it("effects for a sealed run are dropped at the seal: an admitted-then-finished run's open admit goes with its finish", async (context) => {
    const timed = timeSealedRunStages((handler) => context.onTestFailed(handler));
    const key = storeKey();
    const t = "slack:C5:5.0";
    await timed("admit", () => admit(key, t, "one"));
    await timed("claim", () => post("/runs/claim", claimBody(key, "r1", t)));
    const q = (await timed("queued admit", () => admit(key, t, "two"))).data.id as string;
    await timed("first finish", () =>
      post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", t) }),
    );
    // The plane's attaching row is another generation's with an expired lease:
    // the reclaim takes it (the restart-from-request path) and its finish seals it.
    const reclaimed = await timed("reclaim", () =>
      post("/runs/reclaim", { storeKey: key, gen: "g2", now: Date.now(), leaseMs: LEASE_MS }),
    );
    expect((reclaimed.data.runs as Array<{ row: { runId: string } }>).map((r) => r.row.runId)).toContain(q);
    expect(
      (
        await timed("second finish", () =>
          post("/runs/finish", { storeKey: key, runId: q, gen: "g2", record: record(q, t) }),
        )
      ).status,
    ).toBe(200);
    await timed("final inspection", () =>
      runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
        expect(inst.openPlaneEffects()).toEqual([]);
      }),
    );
  });

  it("a push that fails leaves the effect on the next heartbeat answer: the bot answered 404, nothing was acked, and the offer rides the heartbeat", async () => {
    const key = storeKey();
    const t = "slack:C6:6.0";
    await admit(key, t, "one");
    await post("/runs/claim", claimBody(key, "r1", t));
    const q = (await admit(key, t, "two")).data.id as string;
    const pushes: { url: string; auth: string | null }[] = [];
    let startedPush!: () => void;
    let finishPush!: () => void;
    const pushStarted = new Promise<void>((resolve) => {
      startedPush = resolve;
    });
    const pushCanFinish = new Promise<void>((resolve) => {
      finishPush = resolve;
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      // A BOT binding whose push dead-ends (the container down, an older bot
      // without the route): the fetch answers 404 and delivers nothing.
      const withBot = inst as unknown as { env: Record<string, unknown> };
      withBot.env = {
        ...withBot.env,
        BOT: {
          fetch: async (url: string, init: { headers: Record<string, string> }) => {
            pushes.push({ url: String(url), auth: init.headers.authorization ?? null });
            startedPush();
            await pushCanFinish;
            return new Response("not found", { status: 404 });
          },
        },
      };
    });
    // The seal walks the queue and pushes the admit. Its response stays
    // independent, while waitUntil and the test guard own the unfinished I/O.
    const finishing = post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", t) });
    await pushStarted;
    expect(() => assertNoPendingBackgroundTasks()).toThrow(/plane effect push \(admit:/);
    finishPush();
    await finishing;
    await vi.waitFor(() => expect(() => assertNoPendingBackgroundTasks()).not.toThrow());
    expect(pushes).toEqual([{ url: "https://bot/plane/effects", auth: "Bearer test-token" }]);
    // Nothing was acked: the offer stands and rides the next heartbeat answer.
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.id)).toEqual([`admit:${q}`]);
    });
    const t2 = "slack:C6:6.1";
    await post("/runs/claim", claimBody(key, "r2", t2));
    const beat = await post("/runs/heartbeat", { storeKey: key, runId: "r2", gen: "g1", leaseMs: LEASE_MS });
    expect((beat.data.effects as Array<{ id: string }>).map((e) => e.id)).toEqual([`admit:${q}`]);
  });

  it("validates: a missing threadKey, requester or request is 400; a malformed withdraw run id is 400", async () => {
    const key = storeKey();
    expect((await post("/plane/admit", { storeKey: key, requester, request: {} })).status).toBe(400);
    expect((await post("/plane/admit", { storeKey: key, threadKey: "slack:C1:1.0", request: {} })).status).toBe(400);
    expect(
      (await post("/plane/admit", { storeKey: key, threadKey: "slack:C1:1.0", requester, request: [] })).status,
    ).toBe(400);
    expect((await post("/plane/withdraw", { storeKey: key, runId: "" })).status).toBe(400);
    expect((await post("/plane/deploy", { storeKey: key, phase: "later" })).status).toBe(400);
  });
});

describe("the plane's resident stage — /plane/level, /plane/observe, the re-ask alarm (orchestration-plane item 9; record 0064)", () => {
  const requester = "slack:UALICE";
  const level = (key: string, resident: string, name: string, side: string, generation = "gen-1") =>
    post("/plane/level", { storeKey: key, resident, name, side, generation });
  const residentAsk = (key: string, threadKey: string, resident: string, over: Record<string, unknown> = {}) =>
    post("/plane/admit", {
      storeKey: key,
      threadKey,
      requester,
      request: { text: "code" },
      stage: "resident",
      resident,
      ...over,
    });

  it("a queued admission awaits its alarm scheduling before the RPC response returns", async () => {
    const key = storeKey();
    await level(key, "owner/repo", "seat", "above");
    let awaited = false;
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const alarm = inst as unknown as { ensurePlaneReaskAlarm(now: number): Promise<void> };
      alarm.ensurePlaneReaskAlarm = () =>
        ({
          then(resolve: () => void) {
            awaited = true;
            resolve();
          },
        }) as Promise<void>;
    });

    expect((await residentAsk(key, "slack:C10:0.0", "owner/repo")).data.kind).toBe("queued");
    expect(awaited).toBe(true);
  });

  it("a queued admission returns its committed answer when alarm scheduling fails", async () => {
    const key = storeKey();
    await level(key, "owner/repo", "seat", "above");
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const alarm = inst as unknown as { ensurePlaneReaskAlarm(now: number): Promise<void> };
      alarm.ensurePlaneReaskAlarm = () => Promise.reject(new Error("alarm unavailable"));
    });

    const asked = await residentAsk(key, "slack:C10:0.1", "owner/repo");
    expect(asked).toMatchObject({ status: 200, data: { kind: "queued", position: 1 } });
    expect((await post("/plane/queued", { storeKey: key, runId: asked.data.id })).data.row).toMatchObject({
      state: "waiting",
    });
  });

  it("a level report lands in plane_levels; an above seat queues a resident ask holding no reservation; the below report admits it with its attaching row", async () => {
    const key = storeKey();
    const t = "slack:C10:1.0";
    expect((await level(key, "owner/repo", "seat", "above")).data).toEqual({ admitted: 0 });
    const asked = await residentAsk(key, t, "owner/repo");
    expect(asked.data).toMatchObject({
      kind: "queued",
      position: 1,
      waiting: [{ kind: "seat", resident: "owner/repo", met: false }],
    });
    const q = asked.data.id as string;
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      expect(sql.exec(`SELECT resident, name, side FROM plane_levels`).toArray()).toEqual([
        { resident: "owner/repo", name: "seat", side: "above" },
      ]);
      // A resident-stage ask holds nothing: its thread was reserved at admission.
      expect(sql.exec(`SELECT * FROM plane_reservations WHERE run_id = ?`, q).toArray()).toEqual([]);
      expect((await inst.listLive()).find((r) => r.runId === q)).toBeUndefined();
    });
    expect((await level(key, "owner/repo", "seat", "below")).data).toEqual({ admitted: 1 });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.id)).toEqual([`admit:${q}`]);
      expect((await inst.listLive()).find((r) => r.runId === q)).toMatchObject({
        ownerGen: "plane",
        phase: "attaching",
      });
    });
  });

  it("an observation after the admit's ack re-enters the row and the next below report re-offers the SAME admit — the acked row never swallows it", async () => {
    const key = storeKey();
    const t = "slack:C11:1.0";
    await level(key, "owner/repo", "seat", "above");
    const q = (await residentAsk(key, t, "owner/repo")).data.id as string;
    expect((await level(key, "owner/repo", "seat", "below")).data).toEqual({ admitted: 1 });
    // The bot took the offer and acked it done; then the attach met the pool refusal.
    await post("/plane/ack", { storeKey: key, id: `admit:${q}`, outcome: "done" });
    let alarmAwaited = false;
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const alarm = inst as unknown as { ensurePlaneReaskAlarm(now: number): Promise<void> };
      alarm.ensurePlaneReaskAlarm = () =>
        ({
          then(resolve: () => void) {
            alarmAwaited = true;
            resolve();
          },
        }) as Promise<void>;
    });
    const observed = await post("/plane/observe", {
      storeKey: key,
      runId: q,
      resident: "owner/repo",
      refusal: "user-pool-exhausted: no free worker user",
    });
    expect(observed.data).toEqual({ reentered: true });
    expect(alarmAwaited).toBe(true);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      // The refusal is evidence: the seat level is written back above.
      expect(sql.exec(`SELECT side FROM plane_levels WHERE resident = 'owner/repo' AND name = 'seat'`).one()).toEqual({
        side: "above",
      });
      expect(sql.exec(`SELECT state FROM plane_queue WHERE run_id = ?`, q).one()).toEqual({ state: "waiting" });
      expect(inst.openPlaneEffects()).toEqual([]);
    });
    // The next below report walks the re-entered row: the admit is offered
    // again despite the acked row under the same id (the pre-insert delete).
    expect((await level(key, "owner/repo", "seat", "below")).data).toEqual({ admitted: 1 });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.id)).toEqual([`admit:${q}`]);
    });
    // An observation for a run the queue holds waiting (not admitted) is a no-op.
    expect(
      (
        await post("/plane/observe", {
          storeKey: key,
          runId: "unknown-run",
          resident: "owner/repo",
          refusal: "draining",
        })
      ).data,
    ).toEqual({ reentered: false });
  });

  it("an observation returns its committed re-entry when alarm scheduling fails", async () => {
    const key = storeKey();
    await level(key, "owner/repo", "seat", "above");
    const q = (await residentAsk(key, "slack:C11:1.1", "owner/repo")).data.id as string;
    expect((await level(key, "owner/repo", "seat", "below")).data).toEqual({ admitted: 1 });
    await post("/plane/ack", { storeKey: key, id: `admit:${q}`, outcome: "done" });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const alarm = inst as unknown as { ensurePlaneReaskAlarm(now: number): Promise<void> };
      alarm.ensurePlaneReaskAlarm = () => Promise.reject(new Error("alarm unavailable"));
    });

    expect(
      await post("/plane/observe", {
        storeKey: key,
        runId: q,
        resident: "owner/repo",
        refusal: "draining",
      }),
    ).toMatchObject({ status: 200, data: { reentered: true } });
    expect((await post("/plane/queued", { storeKey: key, runId: q })).data.row).toMatchObject({ state: "waiting" });
  });

  it("a drain post opens the resident-drain window — an ask queues on it, a restartOf passes — and the below post lifts it, admitting the queued run", async () => {
    const key = storeKey();
    const t = "slack:C12:1.0";
    expect((await level(key, "registry", "drain", "above")).data).toEqual({ admitted: 0 });
    const asked = await post("/plane/admit", { storeKey: key, threadKey: t, requester, request: { text: "hi" } });
    expect(asked.data).toMatchObject({
      kind: "queued",
      position: 1,
      waiting: [{ kind: "window_open", window: "resident-drain", met: false }],
    });
    // A restart of a run the resident already holds passes the window.
    expect(
      (
        await post("/plane/admit", {
          storeKey: key,
          threadKey: "slack:C12:2.0",
          requester,
          request: {},
          restartOf: true,
        })
      ).data.kind,
    ).toBe("admitted");
    expect((await level(key, "registry", "drain", "below")).data).toEqual({ admitted: 1 });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.id)).toEqual([`admit:${asked.data.id as string}`]);
    });
  });

  it("the re-ask alarm probes a silent resident within the cadence, pulls the sweep alarm forward, and re-offers the probe after its ack", async () => {
    const key = storeKey();
    const cadence = 60_000;
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await level(key, "owner/repo", "memory", "above");
    const asked = await residentAsk(key, "slack:C13:1.0", "owner/repo", { reaskMs: cadence });
    expect(asked.data).toMatchObject({
      kind: "queued",
      waiting: [{ kind: "memory", resident: "owner/repo", met: false }],
    });
    // The cadence's pull-forward, judged directly on the private ensure (the
    // pool's alarm helper deletes the scheduled alarm around a trigger, so its
    // stored time cannot be read back after one): a far sweep alarm is pulled
    // to the cadence; an earlier alarm is never pushed back.
    type WithAlarm = {
      ctx: DurableObjectState;
      sql: SqlStorage;
      ensurePlaneReaskAlarm(now: number): Promise<void>;
    };
    await runInDurableObject(stub, async (inst: RunHistoryDO) => {
      const priv = inst as unknown as WithAlarm;
      const now = Date.now();
      await priv.ctx.storage.setAlarm(now + 6 * 3_600_000);
      await priv.ensurePlaneReaskAlarm(now);
      expect(((await priv.ctx.storage.getAlarm()) as number) - now).toBeLessThanOrEqual(cadence);

      const sooner = now + cadence / 2;
      await priv.ctx.storage.setAlarm(sooner);
      await priv.ensurePlaneReaskAlarm(now);
      expect(await priv.ctx.storage.getAlarm()).toBe(sooner);

      // Make the report old enough for a probe without installing a native,
      // one-millisecond alarm that can still be in flight after this case.
      priv.sql.exec(`UPDATE plane_levels SET reported_at = ? WHERE resident = ?`, now - cadence - 1, "owner/repo");
    });
    const openIds = () =>
      runInDurableObject(stub, async (inst: RunHistoryDO) => inst.openPlaneEffects().map((e) => e.id));

    // The helper consumes and awaits the alarm handler. Its re-armed future
    // slot is then consumed the same way, so no handler crosses the test edge.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await openIds()).toEqual(["probe:owner/repo"]);
    await post("/plane/ack", { storeKey: key, id: "probe:owner/repo", outcome: "done" });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await openIds()).toEqual(["probe:owner/repo"]);

    await post("/plane/ack", { storeKey: key, id: "probe:owner/repo", outcome: "done" });
    expect((await level(key, "owner/repo", "memory", "below")).data).toEqual({ admitted: 1 });
    await runInDurableObject(stub, async (inst: RunHistoryDO) => {
      await (inst as unknown as WithAlarm).ctx.storage.deleteAlarm();
    });
  });

  it("a paused-maintenance alarm still probes a waiting resident and offers an expired lease", async () => {
    const key = storeKey();
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await level(key, "owner/repo", "memory", "above");
    await residentAsk(key, "slack:C13:paused", "owner/repo", { reaskMs: 60_000 });
    expect(await post("/runs/claim", claimBody(key, "lease-paused", "slack:C13:lease-paused"))).toMatchObject({
      status: 200,
    });
    await runInDurableObject(stub, async (instance: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `UPDATE plane_levels SET reported_at = ? WHERE resident = ?`,
        Date.now() - 61_000,
        "owner/repo",
      );
      state.storage.sql.exec(`UPDATE live_runs SET lease_until = 1 WHERE run_id = ?`, "lease-paused");
      const subject = instance as unknown as { env: { RUN_HISTORY_MAINTENANCE?: string } };
      const prior = subject.env.RUN_HISTORY_MAINTENANCE;
      subject.env.RUN_HISTORY_MAINTENANCE = "paused";
      try {
        await instance.alarm();
      } finally {
        subject.env.RUN_HISTORY_MAINTENANCE = prior;
      }
      expect(instance.openPlaneEffects().map((effect) => effect.id)).toContain("probe:owner/repo");
      expect(
        state.storage.sql.exec(`SELECT run_id FROM live_runs WHERE run_id = 'lease-paused'`).toArray(),
      ).toHaveLength(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("validates: a level with a missing resident, a bad name or side, or a non-string generation is 400; an observation with a bad run id, missing resident or empty refusal is 400", async () => {
    const key = storeKey();
    expect((await post("/plane/level", { storeKey: key, name: "seat", side: "below", generation: "g" })).status).toBe(
      400,
    );
    expect(
      (await post("/plane/level", { storeKey: key, resident: "r", name: "cpu", side: "below", generation: "g" }))
        .status,
    ).toBe(400);
    expect(
      (await post("/plane/level", { storeKey: key, resident: "r", name: "seat", side: "over", generation: "g" }))
        .status,
    ).toBe(400);
    expect((await post("/plane/level", { storeKey: key, resident: "r", name: "seat", side: "below" })).status).toBe(
      400,
    );
    expect(
      (await post("/plane/observe", { storeKey: key, runId: "no spaces!", resident: "r", refusal: "draining" })).status,
    ).toBe(400);
    expect((await post("/plane/observe", { storeKey: key, runId: "r1", refusal: "draining" })).status).toBe(400);
    expect((await post("/plane/observe", { storeKey: key, runId: "r1", resident: "r", refusal: "" })).status).toBe(400);
  });
});

describe("the plane's checkpoint steers and the provider condition — the heartbeat body, /plane/park, /plane/level provider (record 0064)", () => {
  const SENTENCE =
    "finish the step you are on, push a checkpoint and end the round; start no new command; the resident takes your push";
  const beat = (key: string, runId: string, facts?: Record<string, unknown>) =>
    post("/runs/heartbeat", { storeKey: key, runId, gen: "g1", leaseMs: 30_000, ...(facts ? { facts } : {}) });
  const facts = (round: number, over: Record<string, unknown> = {}) => ({
    round,
    coding: true,
    startedAt: 1,
    inFlight: { callId: "c1", tool: "bash", sinceAt: 1, boundMs: 1 },
    ...over,
  });
  const inbox = async (key: string, runId: string) =>
    (await post("/runs/inbox/read", { storeKey: key, runId, afterSeq: 0 })).data.items as Array<{
      seq: number;
      message: Record<string, unknown>;
    }>;

  it("a heartbeat whose facts cross a bound writes ONE inbox row — the fixed sentence, sender plane — in the heartbeat's own transaction; a second beat in the round writes none, a new round writes one, a second cause repeats no sentence", async () => {
    const key = storeKey();
    const t = "slack:C20:1.0";
    await post("/runs/claim", claimBody(key, "r1", t));
    expect((await beat(key, "r1", facts(1))).status).toBe(200);
    let items = await inbox(key, "r1");
    expect(items).toHaveLength(1);
    expect(items[0].message).toMatchObject({ text: SENTENCE, userId: "plane" });
    // Same round, same cause: nothing more; a second cause (no_push, far past the window) records its row but repeats no sentence.
    await beat(key, "r1", facts(1));
    await beat(key, "r1", facts(1, { inFlight: undefined, startedAt: 1, pushedHead: undefined }));
    expect(await inbox(key, "r1")).toHaveLength(1);
    // A new round steers once more.
    await beat(key, "r1", facts(2));
    items = await inbox(key, "r1");
    expect(items).toHaveLength(2);
    expect(items[1].message).toMatchObject({ text: SENTENCE, userId: "plane" });
  });

  it("a facts-less heartbeat and healthy facts steer nothing", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r2", "slack:C20:2.0"));
    await beat(key, "r2");
    await beat(key, "r2", {
      round: 1,
      coding: true,
      startedAt: Date.now(),
      inFlight: { callId: "c", tool: "bash", sinceAt: Date.now(), boundMs: 600_000 },
    });
    expect(await inbox(key, "r2")).toEqual([]);
  });

  it("a provider down and parked live run recover atomically as one durable row and one pushed offered steer; repeat up writes nothing", async () => {
    const key = storeKey();
    const pushed: Array<Record<string, unknown>> = [];
    await post("/runs/claim", claimBody(key, "r3", "slack:C20:3.0"));
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const withBot = inst as unknown as { env: Record<string, unknown> };
      withBot.env = {
        ...withBot.env,
        BOT: {
          fetch: async (_url: string, init: { body: string }) => {
            pushed.push(JSON.parse(init.body) as Record<string, unknown>);
            return new Response("ok");
          },
        },
      };
    });
    expect(
      (
        await post("/plane/level", {
          storeKey: key,
          name: "provider",
          provider: "anthropic",
          side: "down",
          cause: "credit-or-quota-exhausted",
        })
      ).data,
    ).toEqual({ admitted: 0 });
    expect((await post("/plane/park", { storeKey: key, runId: "r3", provider: "anthropic" })).data).toEqual({
      parked: true,
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      expect(sql.exec(`SELECT resident, name, side, cause FROM plane_levels`).toArray()).toEqual([
        {
          resident: "anthropic",
          name: "provider",
          side: "above",
          cause: "credit-or-quota-exhausted",
        },
      ]);
      expect(sql.exec(`SELECT kind, key FROM plane_reservations`).toArray()).toEqual([
        { kind: "park", key: "anthropic#r3" },
      ]);
    });
    await post("/plane/level", { storeKey: key, name: "provider", provider: "anthropic", side: "up" });
    const items = await inbox(key, "r3");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      seq: 1,
      message: { userId: "plane", plane: { steer: "reissue", provider: "anthropic" } },
    });
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    const effect = (pushed[0]!.effects as Array<Record<string, unknown>>)[0];
    expect(effect).toMatchObject({
      id: "steer:r3:1",
      kind: "steer",
      runId: "r3",
      seq: 1,
      message: items[0]!.message,
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      expect(sql.exec(`SELECT * FROM plane_reservations WHERE kind = 'park'`).toArray()).toEqual([]);
      expect(inst.openPlaneEffects()).toEqual([effect]);
    });
    await post("/plane/level", { storeKey: key, name: "provider", provider: "anthropic", side: "up" });
    expect(await inbox(key, "r3")).toHaveLength(1);
    expect(pushed).toHaveLength(1);
  });

  it("fences a pushed steer and renews its owner's lease atomically before registry delivery", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r-fenced", "slack:C20:3.1", "gen-stale"));
    await post("/plane/park", { storeKey: key, runId: "r-fenced", provider: "anthropic" });
    await post("/plane/level", { storeKey: key, name: "provider", provider: "anthropic", side: "up" });

    expect(
      (
        await post("/plane/steer/fence", {
          storeKey: key,
          id: "steer:r-fenced:1",
          runId: "r-fenced",
          gen: "gen-stale",
          leaseMs: LEASE_MS,
        })
      ).data,
    ).toEqual({ accepted: true });
    const [row] = (await post("/runs/live", { storeKey: key })).data.runs as Array<{ leaseUntil: number }>;
    expect(
      (
        await post("/runs/reclaim", {
          storeKey: key,
          gen: "gen-owner",
          now: row!.leaseUntil - 1,
          leaseMs: LEASE_MS,
        })
      ).data.runs,
    ).toEqual([]);
    expect(
      (
        await post("/runs/reclaim", {
          storeKey: key,
          gen: "gen-owner",
          now: row!.leaseUntil,
          leaseMs: LEASE_MS,
        })
      ).data.runs,
    ).toMatchObject([{ row: { runId: "r-fenced", ownerGen: "gen-owner" } }]);
    expect(
      (
        await post("/plane/steer/fence", {
          storeKey: key,
          id: "steer:r-fenced:1",
          runId: "r-fenced",
          gen: "gen-stale",
          leaseMs: LEASE_MS,
        })
      ).data,
    ).toEqual({ accepted: false });
  });

  it("a stale generation cannot close a steer offer after reclaim; the durable owner heartbeat receives and closes it", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r-owner", "slack:C20:3.1", "gen-stale"));
    await post("/plane/park", { storeKey: key, runId: "r-owner", provider: "anthropic" });
    await post("/plane/level", { storeKey: key, name: "provider", provider: "anthropic", side: "up" });
    const reclaimed = await post("/runs/reclaim", {
      storeKey: key,
      gen: "gen-owner",
      now: Date.now() + 2 * LEASE_MS,
      leaseMs: LEASE_MS,
    });
    expect(reclaimed.data.runs).toMatchObject([{ row: { runId: "r-owner", ownerGen: "gen-owner" } }]);

    await post("/plane/ack", {
      storeKey: key,
      id: "steer:r-owner:1",
      outcome: "done",
      owner: { runId: "r-owner", gen: "gen-stale" },
    });
    const ownerBeat = () =>
      post("/runs/heartbeat", { storeKey: key, runId: "r-owner", gen: "gen-owner", leaseMs: LEASE_MS });
    expect((await ownerBeat()).data.effects).toMatchObject([{ id: "steer:r-owner:1", kind: "steer", seq: 1 }]);

    await post("/plane/ack", {
      storeKey: key,
      id: "steer:r-owner:1",
      outcome: "done",
      owner: { runId: "r-owner", gen: "gen-owner" },
    });
    expect((await ownerBeat()).data.effects).toEqual([]);
  });

  it("a failed provider-up transaction writes neither the durable row nor its steer effect", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r4", "slack:C20:4.0"));
    await post("/plane/park", { storeKey: key, runId: "r4", provider: "anthropic" });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      for (let i = 0; i < 256; i++)
        sql.exec(
          `INSERT INTO plane_effects (id, body_json, offered_at, acked_at) VALUES (?, ?, ?, NULL)`,
          `probe:cap-${i}`,
          JSON.stringify({ id: `probe:cap-${i}`, kind: "probe", resident: `r-${i}` }),
          i,
        );
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(() => inst.planeLevel({ name: "provider", provider: "anthropic", side: "up" }, Date.now())).toThrow(
        /plane_effects total cap/,
      );
    });
    expect(await inbox(key, "r4")).toEqual([]);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      expect(sql.exec(`SELECT COUNT(*) AS n FROM plane_effects`).one().n).toBe(256);
      expect(sql.exec(`SELECT key FROM plane_reservations WHERE kind = 'park'`).toArray()).toEqual([
        { key: "anthropic#r4" },
      ]);
    });
  });

  it("a failed live push leaves both the durable row and steer offer for an owner heartbeat; sealing first removes the park and produces no steer", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r5", "slack:C20:5.0"));
    await post("/plane/park", { storeKey: key, runId: "r5", provider: "anthropic" });
    let pushed!: () => void;
    const pushStarted = new Promise<void>((resolve) => {
      pushed = resolve;
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const withBot = inst as unknown as { env: Record<string, unknown> };
      withBot.env = {
        ...withBot.env,
        BOT: {
          fetch: async () => {
            pushed();
            return new Response("down", { status: 503 });
          },
        },
      };
    });
    await post("/plane/level", { storeKey: key, name: "provider", provider: "anthropic", side: "up" });
    await pushStarted;
    expect(await inbox(key, "r5")).toHaveLength(1);
    const beat = await post("/runs/heartbeat", { storeKey: key, runId: "r5", gen: "g1", leaseMs: LEASE_MS });
    expect(beat.data.effects).toMatchObject([{ id: "steer:r5:1", kind: "steer", seq: 1 }]);

    const sealedKey = storeKey();
    const thread = "slack:C20:5.1";
    await post("/runs/claim", claimBody(sealedKey, "r6", thread));
    await post("/plane/park", { storeKey: sealedKey, runId: "r6", provider: "anthropic" });
    await post("/runs/finish", { storeKey: sealedKey, runId: "r6", gen: "g1", record: record("r6", thread) });
    await post("/plane/level", { storeKey: sealedKey, name: "provider", provider: "anthropic", side: "up" });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(sealedKey)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects()).toEqual([]);
    });
  });
});

describe("the plane's endings and the alarm — the cause on close, /plane/reclaimed, the lease-end offer (record 0064)", () => {
  const TAG = { parentInstanceId: "ship_acme_api_1", idempotencyKey: "ship_acme_api_1:u12/0/coding" };
  type Sent = { instance: string; type: string; payload: unknown };

  /** The Workflow binding doubled on the live object (item 47's pattern). */
  async function coordinatorDouble(key: string): Promise<Sent[]> {
    const sent: Sent[] = [];
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const holder = inst as unknown as { env: Record<string, unknown> };
      holder.env = {
        ...holder.env,
        SHIP_COORDINATOR: {
          get: async (id: string) => ({
            sendEvent: async (event: { type: string; payload: unknown }) => {
              sent.push({ instance: id, type: event.type, payload: event.payload });
            },
          }),
        },
      };
    });
    return sent;
  }

  async function endingOf(key: string, runId: string): Promise<unknown> {
    let ending: unknown;
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      ending = inst.planeEndingOf(runId);
    });
    return ending;
  }

  it("the owner's finish records ended {kind, cause} exactly when the row closes — completed maps to completed, an interrupted record with `restarting` to resident_replaced, a bare interrupted to lease_lapsed — and the first cause stands", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", "slack:C1:1.0") });
    expect(await endingOf(key, "r1")).toMatchObject({ kind: "completed", cause: "completed" });
    await post("/runs/claim", claimBody(key, "r2", "slack:C1:2.0"));
    await post("/runs/finish", {
      storeKey: key,
      runId: "r2",
      gen: "g1",
      record: { ...record("r2", "slack:C1:2.0"), status: "interrupted", restarting: true },
    });
    expect(await endingOf(key, "r2")).toMatchObject({ kind: "interrupted", cause: "resident_replaced" });
    await post("/runs/claim", claimBody(key, "r3", "slack:C1:3.0"));
    await post("/runs/finish", {
      storeKey: key,
      runId: "r3",
      gen: "g1",
      record: { ...record("r3", "slack:C1:3.0"), status: "interrupted" },
    });
    expect(await endingOf(key, "r3")).toMatchObject({ kind: "interrupted", cause: "lease_lapsed" });
    // First cause stands: a later report cannot rewrite r2's ending.
    const again = await post("/plane/reclaimed", { storeKey: key, outcomes: [{ runId: "r2", outcome: "closed" }] });
    expect(again.data).toEqual({ recorded: [{ runId: "r2", cause: "resident_replaced" }] });
    expect(await endingOf(key, "r2")).toMatchObject({ cause: "resident_replaced" });
  });

  it("a same-id successor's finish replaces a standing resident_replaced — a restarting close is the run continuing, not its end, so a restarted run that completes reads completed as its record does", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:9.0"));
    await post("/runs/finish", {
      storeKey: key,
      runId: "r1",
      gen: "g1",
      record: { ...record("r1", "slack:C1:9.0"), status: "interrupted", restarting: true },
    });
    expect(await endingOf(key, "r1")).toMatchObject({ kind: "interrupted", cause: "resident_replaced" });
    // The restart reuses the run's id (run-history item 42) and completes.
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:9.0"));
    await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", "slack:C1:9.0") });
    expect(await endingOf(key, "r1")).toMatchObject({ kind: "completed", cause: "completed" });
    // A completed ending is final: a later report cannot rewrite it.
    await post("/plane/reclaimed", { storeKey: key, outcomes: [{ runId: "r1", outcome: "closed" }] });
    expect(await endingOf(key, "r1")).toMatchObject({ cause: "completed" });
  });

  it("/plane/reclaimed records lease_lapsed for a closed row and nothing for resume, restart or rehost — a roll that resumes every row assigns nothing", async () => {
    const key = storeKey();
    const r = await post("/plane/reclaimed", {
      storeKey: key,
      outcomes: [
        { runId: "a", outcome: "resume" },
        { runId: "b", outcome: "restart" },
        { runId: "c", outcome: "rehost" },
        { runId: "d", outcome: "closed" },
      ],
    });
    expect(r).toEqual({ status: 200, data: { recorded: [{ runId: "d", cause: "lease_lapsed" }] } });
    expect(await endingOf(key, "a")).toBeNull();
    expect(await endingOf(key, "b")).toBeNull();
    expect(await endingOf(key, "c")).toBeNull();
    expect(await endingOf(key, "d")).toMatchObject({ kind: "interrupted", cause: "lease_lapsed" });
    // A malformed word is refused by name.
    expect(
      (await post("/plane/reclaimed", { storeKey: key, outcomes: [{ runId: "x", outcome: "ended" }] })).status,
    ).toBe(400);
  });

  it("a claim whose meta carries restartOf under a coordinator sends the parent one child-resumed-<runId>; a claim without restartOf sends nothing; a Worker without the binding claims as before", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key);
    const meta = { ...claimBody(key, "r1", "slack:C2:1.0").run.meta, ...TAG, restartOf: "r1" };
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C2:1.0", "g1", { meta }))).data).toMatchObject({
      ok: true,
    });
    expect(sent).toEqual([
      {
        instance: "ship_acme_api_1",
        type: "child-resumed-r1",
        payload: expect.objectContaining({ runId: "r1", kind: "resumed", parentInstanceId: "ship_acme_api_1" }),
      },
    ]);
    // Without restartOf: a plain claim under the same coordinator says nothing.
    await post(
      "/runs/claim",
      claimBody(key, "r2", "slack:C2:2.0", "g1", {
        meta: { ...claimBody(key, "r2", "slack:C2:2.0").run.meta, ...TAG },
      }),
    );
    expect(sent).toHaveLength(1);
    // A Worker without the binding: the claim still lands (no throw, no send).
    const bare = storeKey();
    expect(
      (
        await post(
          "/runs/claim",
          claimBody(bare, "r9", "slack:C2:9.0", "g1", {
            meta: { ...claimBody(bare, "r9", "slack:C2:9.0").run.meta, ...TAG, restartOf: "r9" },
          }),
        )
      ).data,
    ).toMatchObject({ ok: true });
  });

  it("the alarm at a lease end offers the row and never ends a run — the row stays live and unclosed, and the owner's heartbeat re-arms the alarm to the new earliest", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C3:1.0"));
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    const armed = await runInDurableObject(stub, async (inst: RunHistoryDO) =>
      (inst as unknown as { ctx: { storage: { getAlarm(): Promise<number | null> } } }).ctx.storage.getAlarm(),
    );
    expect(armed).not.toBeNull();
    // The claim armed the alarm at the lease end (within the lease, not the 6 h sweep).
    expect(armed! - Date.now()).toBeLessThanOrEqual(LEASE_MS);
    // Fire it as if the lease end passed: the row is offered, never closed.
    expect(await runDurableObjectAlarm(env.RUNS.get(env.RUNS.idFromName(key)))).toBe(true);
    const live = await post("/runs/live", { storeKey: key });
    expect((live.data.runs as { runId: string }[]).map((r) => r.runId)).toEqual(["r1"]);
    expect(await endingOf(key, "r1")).toBeNull();
    // The owner's heartbeat extends the lease and moves the plane's alarm on.
    await post("/runs/heartbeat", { storeKey: key, runId: "r1", gen: "g1", leaseMs: LEASE_MS });
    const rearmed = await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) =>
      (inst as unknown as { ctx: { storage: { getAlarm(): Promise<number | null> } } }).ctx.storage.getAlarm(),
    );
    expect(rearmed).not.toBeNull();
    expect(rearmed!).toBeGreaterThanOrEqual(armed!);
  });

  it("a consumed alarm never strands a static due — ensurePlaneAlarm judges the armed slot, not the meta row, and an earlier foreign alarm is left to fire first", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C3:2.0"));
    type WithAlarm = {
      ctx: { storage: { getAlarm(): Promise<number | null>; setAlarm(at: number): Promise<void> } };
      ensurePlaneAlarm(now: number): Promise<void>;
    };
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const priv = inst as unknown as WithAlarm;
      const now = Date.now();
      // An earlier alarm (the re-ask's) fired and was consumed; the handler
      // re-armed the sweep far out. The earliest due (the lease end) did not
      // move, so the meta row still equals it — the wake must be re-armed.
      await priv.ctx.storage.setAlarm(now + 6 * 3_600_000);
      await priv.ensurePlaneAlarm(now);
      expect(((await priv.ctx.storage.getAlarm()) as number) - now).toBeLessThanOrEqual(LEASE_MS);
      // An earlier alarm someone else armed is left to fire first.
      const sooner = now + 1;
      await priv.ctx.storage.setAlarm(sooner);
      await priv.ensurePlaneAlarm(now);
      expect(await priv.ctx.storage.getAlarm()).toBe(sooner);
    });
  });
});

describe("run ledger — durable branch publication", () => {
  it.each(["", "[]", "null", '{"version":2}', "{"])(
    "preserves unreadable private publication evidence and refuses replacement: %s",
    async (raw) => {
      const key = storeKey();
      const id = "unreadable-publication";
      const terminal = record(id, "slack:C1:unreadable-publication");
      expect((await post("/runs/put", { storeKey: key, record: terminal })).status).toBe(200);
      const stub = env.RUNS.get(env.RUNS.idFromName(key));
      await runInDurableObject(stub, async (instance: RunHistoryDO, state) => {
        state.storage.sql.exec(`UPDATE runs SET work_evidence_json = ?, finished_at = 1 WHERE run_id = ?`, raw, id);
        await expect(instance.put(terminal)).rejects.toThrow();
        (instance as unknown as { trim(policy: Record<string, number>, now: number, fence: undefined): unknown }).trim(
          { retentionDays: 1, maxRuns: 1, maxBytes: 16 * 1024 * 1024 },
          Date.now(),
          undefined,
        );
        expect(
          state.storage.sql
            .exec<{ work_evidence_json: string }>(`SELECT work_evidence_json FROM runs WHERE run_id = ?`, id)
            .one().work_evidence_json,
        ).toBe(raw);
      });
      expect((await post("/runs/get", { storeKey: key, id })).data.record).toBeNull();
    },
  );

  it("advances listing past unreadable protected bytes to an older unresolved producer", async () => {
    const key = storeKey();
    const id = "older-intent";
    const thread = "slack:C1:older-intent";
    expect((await post("/runs/claim", claimBody(key, id, thread))).status).toBe(200);
    await post("/runs/state", {
      storeKey: key,
      runId: id,
      gen: "g1",
      state: {
        branchPublication: { version: 1, repo: "private/repo", branches: [], complete: false },
      },
    });
    await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: record(id, thread) });
    await post("/runs/put", { storeKey: key, record: record("newer-unreadable", "slack:C1:newer-unreadable") });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `UPDATE runs SET summary_json = '{}', finished_at = ? WHERE run_id = 'newer-unreadable'`,
        Date.now(),
      );
    });
    const first = (await post("/runs/list", { storeKey: key, limit: 1 })).data;
    expect(first.items).toEqual([]);
    expect(first.nextBefore).toMatchObject({ id: "newer-unreadable" });
    const next = (
      await post("/runs/list", {
        storeKey: key,
        limit: 1,
        before: first.nextBefore.finishedAt,
        beforeId: first.nextBefore.id,
      })
    ).data;
    expect(next.items.map((item: { id: string }) => item.id)).toEqual([id]);
  });

  it.each(["missing", "malformed", "different"])(
    "retains the terminal outcome using only saved producer publication: %s",
    async (mode) => {
      const key = storeKey();
      const id = `publication-${mode}`;
      const thread = `slack:C1:${id}`;
      const projection = { version: 1 as const, repo: "private/repo", branches: [], complete: true };
      expect((await post("/runs/claim", claimBody(key, id, thread))).status).toBe(200);
      if (mode !== "missing")
        expect(
          (
            await post("/runs/state", {
              storeKey: key,
              runId: id,
              gen: "g1",
              state: { branchPublication: mode === "malformed" ? { ...projection, version: 2 } : projection },
            })
          ).status,
        ).toBe(200);
      const terminal = record(id, thread);
      if (mode !== "malformed")
        terminal.branchPublication = mode === "different" ? { ...projection, complete: false } : projection;
      expect((await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: terminal })).status).toBe(200);
      const stored = (await post("/runs/get", { storeKey: key, id })).data.record;
      expect(stored).toMatchObject({ id, status: "completed" });
      expect(stored.branchPublication).toEqual(mode === "different" ? projection : undefined);
      if (mode === "malformed") {
        const stub = env.RUNS.get(env.RUNS.idFromName(key));
        await runInDurableObject(stub, async (instance: RunHistoryDO, state) => {
          const row = state.storage.sql
            .exec<{ work_evidence_json: string }>(`SELECT work_evidence_json FROM runs WHERE run_id = ?`, id)
            .one();
          expect(JSON.parse(row.work_evidence_json).branchPublication).toEqual({ ...projection, version: 2 });
          state.storage.sql.exec(`UPDATE runs SET finished_at = 1 WHERE run_id = ?`, id);
          (
            instance as unknown as { trim(policy: Record<string, number>, now: number, fence: undefined): unknown }
          ).trim({ retentionDays: 1, maxRuns: 1, maxBytes: 16 * 1024 * 1024 }, Date.now(), undefined);
          expect(state.storage.sql.exec(`SELECT run_id FROM runs WHERE run_id = ?`, id).toArray()).toHaveLength(1);
        });
      }
      expect((await post("/runs/live", { storeKey: key })).data.runs).toEqual([]);
    },
  );

  it.each(["pending", "malformed", "foreign", "absent"])(
    "finishes with only canonical review publication and retains unknown evidence: %s",
    async (mode) => {
      const key = storeKey();
      const id = `review-publication-${mode}`;
      const thread = `slack:C1:${id}`;
      const receipt = {
        version: 1 as const,
        runId: id,
        target: { repo: "private/repo", number: 7, commitId: "a".repeat(40) },
        bodyHash: "b".repeat(64),
        state: "pending" as const,
      };
      const canonical =
        mode === "malformed"
          ? { ...receipt, version: 2 }
          : mode === "foreign"
            ? { ...receipt, runId: "another-run" }
            : receipt;
      expect((await post("/runs/claim", claimBody(key, id, thread))).status).toBe(200);
      if (mode !== "absent")
        expect(
          (
            await post("/runs/state", {
              storeKey: key,
              runId: id,
              gen: "g1",
              state: { reviewPublication: canonical },
            })
          ).status,
        ).toBe(200);
      const terminal = record(id, thread);
      terminal.repo = "private/repo";
      terminal.reviewPublication = { ...receipt, state: "accepted" };
      expect((await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: terminal })).status).toBe(200);
      const stored = (await post("/runs/get", { storeKey: key, id })).data.record;
      expect(stored).toMatchObject({ id, status: "completed" });
      expect(stored.reviewPublication).toEqual(mode === "pending" ? receipt : undefined);
      expect((await post("/runs/summary", { storeKey: key, id })).data.summary).not.toHaveProperty("reviewPublication");
      for (const item of (await post("/runs/list", { storeKey: key })).data.items)
        expect(item).not.toHaveProperty("reviewPublication");
      const stub = env.RUNS.get(env.RUNS.idFromName(key));
      await runInDurableObject(stub, async (instance: RunHistoryDO, state) => {
        if (mode === "malformed" || mode === "foreign") {
          const row = state.storage.sql
            .exec<{ work_evidence_json: string }>(`SELECT work_evidence_json FROM runs WHERE run_id = ?`, id)
            .one();
          expect(JSON.parse(row.work_evidence_json).reviewPublication).toEqual(canonical);
        }
        state.storage.sql.exec(`UPDATE runs SET finished_at = 1 WHERE run_id = ?`, id);
        (instance as unknown as { trim(policy: Record<string, number>, now: number, fence: undefined): unknown }).trim(
          { retentionDays: 1, maxRuns: 1, maxBytes: 16 * 1024 * 1024 },
          Date.now(),
          undefined,
        );
        expect(state.storage.sql.exec(`SELECT run_id FROM runs WHERE run_id = ?`, id).toArray()).toHaveLength(
          mode === "absent" ? 0 : 1,
        );
      });
    },
  );

  it.each(["absent", "valid", "malformed"])("folds only saved native push receipts at finish: %s", async (mode) => {
    const key = storeKey(),
      id = `native-push-${mode}`,
      thread = `slack:C1:${id}`;
    const receipts = [{ ref: "codex/original", sha: "a".repeat(40), by: "push" as const }];
    const canonical =
      mode === "malformed"
        ? [{ ...receipts[0], sha: "short" }]
        : [
            ...receipts.map((r) => ({ ...r, type: "pushed_head", seq: 1 })),
            { ...receipts[0], sha: "b".repeat(40), type: "pushed_head", seq: 2 },
          ];
    await post("/runs/claim", claimBody(key, id, thread));
    if (mode !== "absent")
      await post("/runs/state", { storeKey: key, runId: id, gen: "g1", state: { branchPushReceipts: canonical } });
    const terminal = { ...record(id, thread), repo: "private/repo", branchPushReceipts: receipts };
    expect((await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: terminal })).status).toBe(200);
    const saved = (await post("/runs/get", { storeKey: key, id })).data.record;
    expect(saved).not.toBeNull();
    expect(saved.branchPushReceipts).toEqual(mode === "valid" ? [{ ...receipts[0], sha: "b".repeat(40) }] : undefined);
    for (const summary of [
      (await post("/runs/summary", { storeKey: key, id })).data.summary,
      ...(await post("/runs/list", { storeKey: key })).data.items,
    ])
      expect(summary).not.toHaveProperty("branchPushReceipts");
    if (mode === "malformed")
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO, state) => {
        const row = state.storage.sql
          .exec<{ work_evidence_json: string }>(`SELECT work_evidence_json FROM runs WHERE run_id = ?`, id)
          .one();
        expect(JSON.parse(row.work_evidence_json).branchPushReceipts).toEqual(canonical);
        state.storage.sql.exec(`UPDATE runs SET finished_at = 1 WHERE run_id = ?`, id);
        (owner as unknown as { trim(policy: Record<string, number>, now: number, fence: undefined): unknown }).trim(
          { retentionDays: 1, maxRuns: 1, maxBytes: 16 * 1024 * 1024 },
          Date.now(),
          undefined,
        );
        expect(state.storage.sql.exec(`SELECT run_id FROM runs WHERE run_id = ?`, id).toArray()).toHaveLength(1);
      });
  });

  it("retains unresolved direct publication through finish and physical history trimming", async () => {
    const key = storeKey();
    const id = "unresolved-publication";
    const thread = "slack:C1:unresolved-publication";
    const branchPublication = {
      version: 1,
      repo: "private/repo",
      complete: false,
      branches: [],
      pending: { id: "intent-a", ref: "private/branch", headSha: "a".repeat(40), pr: 7 },
    };
    expect((await post("/runs/claim", claimBody(key, id, thread))).status).toBe(200);
    expect(
      (await post("/runs/state", { storeKey: key, runId: id, gen: "g1", state: { branchPublication } })).status,
    ).toBe(200);
    const terminal = record(id, thread);
    terminal.startedAt = Date.now() - 3 * 86_400_000;
    terminal.finishedAt = Date.now() - 2 * 86_400_000;
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        JSON.stringify({ retentionDays: 1, maxRuns: 1, maxBytes: 16 * 1024 * 1024, policyUpdatedAt: Date.now() }),
      );
    });
    expect((await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: terminal })).status).toBe(200);
    await post("/runs/put", { storeKey: key, record: record("ordinary-publication", "slack:C1:ordinary") });
    const newer = record("newer-publication", "slack:C1:newer");
    newer.finishedAt = Date.now();
    await post("/runs/put", { storeKey: key, record: newer });
    expect((await post("/runs/get", { storeKey: key, id })).data.record?.branchPublication).toEqual(branchPublication);
    expect((await post("/runs/events", { storeKey: key, id })).data.events).not.toBeNull();
    const summaries = (await post("/runs/list", { storeKey: key })).data.items;
    expect(summaries.map((item: { id: string }) => item.id)).toEqual(["newer-publication", id]);
    for (const summary of [(await post("/runs/summary", { storeKey: key, id })).data.summary, ...summaries]) {
      expect(summary).not.toHaveProperty("branchPublication");
      expect(JSON.stringify(summary)).not.toContain("private/branch");
    }
    await runInDurableObject(stub, async (_instance: RunHistoryDO, state) => {
      expect(state.storage.sql.exec(`SELECT run_id FROM runs ORDER BY run_id`).toArray()).toEqual([
        { run_id: "newer-publication" },
        { run_id: id },
      ]);
      expect(state.storage.sql.exec(`SELECT run_id FROM live_runs`).toArray()).toEqual([]);
      expect(state.storage.sql.exec(`SELECT unit FROM coordinator_units`).toArray()).toEqual([]);
    });
  });

  it("folds the fenced producer projection at finish independently of events and hides it on summaries", async () => {
    const key = storeKey();
    const id = "publication-owner";
    const thread = "slack:C1:publication-owner";
    const branchPublication = {
      version: 1,
      repo: "private/repo",
      complete: false,
      branches: [{ ref: "accepted/branch", pr: 7 }],
      pending: { id: "intent-a", ref: "uncertain/branch", headSha: "a".repeat(40) },
    };
    expect((await post("/runs/claim", claimBody(key, id, thread))).status).toBe(200);
    expect(
      await post("/runs/state", { storeKey: key, runId: id, gen: "foreign", state: { branchPublication } }),
    ).toMatchObject({ status: 409, data: { reason: "fenced" } });
    expect(
      (await post("/runs/state", { storeKey: key, runId: id, gen: "g1", state: { branchPublication } })).status,
    ).toBe(200);
    expect(
      (await post("/runs/finish", { storeKey: key, runId: id, gen: "g1", record: record(id, thread) })).status,
    ).toBe(200);
    const stored = (await post("/runs/get", { storeKey: key, id })).data.record as RunRecord;
    expect(stored.branchPublication).toEqual(branchPublication);
    expect(stored.events.some((event) => event.type === "pr_opened")).toBe(false);
    for (const summary of [
      (await post("/runs/summary", { storeKey: key, id })).data.summary,
      ...(await post("/runs/list", { storeKey: key })).data.items,
    ]) {
      expect(summary).not.toHaveProperty("branchPublication");
      expect(JSON.stringify(summary)).not.toContain("uncertain/branch");
    }
  });
});

describe("maintenance server clock", () => {
  async function prepare() {
    const key = storeKey();
    const input = {
      version: 1,
      intent: {
        kind: "command",
        requestId: "command:clock",
        actorId: "slack:UALICE",
        userId: "slack:UALICE",
        channelId: "slack:C1",
        threadKey: "slack:C1:clock-child",
      },
      target: { repo: "acme/api", pr: 7, ref: "codex/clock", base: "main", headSha: "a".repeat(40) },
      createdAt: 1000,
      bounds: { leaseMinutes: 30, spendCapUsd: 1 },
    };
    const admitted = await post("/runs/coordinator/maintenance/admit", { storeKey: key, input });
    expect(admitted.status).toBe(200);
    const row = admitted.data.unit as CoordinatorUnit;
    const cell = row.currentEffect!;
    const planned = await post("/runs/coordinator/units/effect-transition", {
      storeKey: key,
      input: {
        kind: "prepare",
        expected: row,
        execution: cell.execution,
        effect: {
          ...cell,
          preparation: undefined,
          calls: [{ operation: "spawn", agent: "coding", state: "unstarted" }],
        },
      },
    });
    expect(planned.status).toBe(200);
    return {
      key,
      row: planned.data.unit as CoordinatorUnit,
      execution: cell.execution,
      effectId: cell.id,
      admittedAt: cell.execution.maintenance!.admittedAt,
    };
  }
  it("refuses a new maintenance begin at the original server deadline without changing the prepared cell", async () => {
    const h = await prepare();
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(h.key)), async (owner: RunHistoryDO) => {
      expect(
        await owner.transitionUnitEffect(
          { kind: "begin", expected: h.row, execution: h.execution, effectId: h.effectId, call: 0 },
          h.admittedAt + 30 * 60_000,
        ),
      ).toEqual({ ok: false, reason: "stopped" });
      expect(await owner.listUnits(h.row.instanceId)).toEqual([h.row]);
    });
  });
  it("credits an exact durably admitted maintenance child whose bot start precedes the Worker timestamp", async () => {
    const h = await prepare();
    const begun = await post("/runs/coordinator/units/effect-transition", {
      storeKey: h.key,
      input: { kind: "begin", expected: h.row, execution: h.execution, effectId: h.effectId, call: 0 },
    });
    expect(begun.status).toBe(200);
    const row = begun.data.unit as CoordinatorUnit;
    const runId = "clock-child",
      threadKey = "slack:C1:clock-child",
      actionId = h.execution.maintenance!.id;
    const meta = {
      agent: "coding",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey,
      repo: "acme/api",
      ref: row.branch,
      parentInstanceId: row.instanceId,
      coordinatorUnit: row.unit,
      coordinatorAttempt: 0,
      idempotencyKey: `${row.instanceId}:${h.effectId}`,
      maintenanceActionId: actionId,
      operationTarget: { repo: "acme/api", ref: row.branch },
    };
    expect(
      (await post("/runs/claim", claimBody(h.key, runId, threadKey, "g1", { meta, startedAt: h.admittedAt - 5000 })))
        .status,
    ).toBe(200);
    const tag = {
      type: "coordinator_tag",
      parentInstanceId: row.instanceId,
      unit: row.unit,
      branch: row.branch,
      base: "main",
      maintenanceActionId: actionId,
      publication: row.publication,
      seq: 1,
    };
    expect((await post("/runs/append", { storeKey: h.key, runId, gen: "g1", events: [tag] })).status).toBe(200);
    const complete = await post("/runs/coordinator/units/effect-transition", {
      storeKey: h.key,
      input: {
        kind: "complete",
        expected: row,
        execution: h.execution,
        effectId: h.effectId,
        call: 0,
        outcome: { state: "accepted", runId },
      },
    });
    expect(complete).toMatchObject({
      status: 200,
      data: {
        ok: true,
        unit: {
          currentEffect: { calls: [{ operation: "spawn", state: "accepted", runId }] },
          rounds: [{ maintenance: { actionId, runId, budgetUsd: 1 } }],
        },
      },
    });
  });
});

describe("durable maintenance admission", () => {
  it("atomically rebinds only a settled same-requester intent and retains foreign or live owners", async () => {
    const key = storeKey();
    const input = {
      version: 1 as const,
      intent: {
        kind: "command" as const,
        requestId: "command:original",
        actorId: "slack:UALICE",
        userId: "slack:UALICE",
        channelId: "slack:C1",
        threadKey: "slack:C1:maintenance",
      },
      target: { repo: "acme/api", pr: 7, ref: "codex/maintenance", base: "main", headSha: "a".repeat(40) },
      createdAt: 1000,
      bounds: { leaseMinutes: 30, spendCapUsd: 1 },
    };
    const first = (await post("/runs/coordinator/maintenance/admit", { storeKey: key, input })).data;
    expect(first.ok).toBe(true);
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (owner: RunHistoryDO) => {
      const cancelled = await owner.transitionUnitEffect(
        { kind: "cancel", expected: first.unit, execution: first.execution, effectId: first.effectId, call: 0 },
        2000,
      );
      expect(cancelled.ok).toBe(true);
      if (!cancelled.ok) throw new Error("cancel refused");
      expect(
        (
          await owner.transitionUnitEffect(
            { kind: "settle", expected: cancelled.unit, execution: first.execution, effectId: first.effectId },
            2001,
          )
        ).ok,
      ).toBe(true);
    });
    const moved = {
      ...input,
      intent: { ...input.intent, requestId: "command:moved" },
      target: { ...input.target, headSha: "b".repeat(40), base: "release" },
    };
    for (const patch of [
      { userId: "slack:UBOB", actorId: "slack:UBOB" },
      { channelId: "slack:C2" },
      { authenticatedAs: "http:other" },
      { postedBy: "slack:OTHER" },
    ])
      expect(
        await post("/runs/coordinator/maintenance/admit", {
          storeKey: key,
          input: { ...input, intent: { ...moved.intent, ...patch } },
        }),
      ).toMatchObject({ status: 409, data: { ok: false, reason: "owned" } });
    const rebound = await post("/runs/coordinator/maintenance/admit", { storeKey: key, input: moved });
    expect(rebound).toMatchObject({
      status: 200,
      data: {
        ok: true,
        instance: first.instance,
        unit: {
          publication: { ...first.unit.publication, expectedHeadSha: moved.target.headSha, baseRef: "release" },
          currentEffect: { target: moved.target, ordinal: 2 },
        },
      },
    });
    await runInDurableObject(stub, async (owner: RunHistoryDO, state) => {
      const active = rebound.data.unit as CoordinatorUnit;
      const prepared = await owner.transitionUnitEffect(
        {
          kind: "prepare",
          expected: active,
          execution: rebound.data.execution,
          effect: { ...active.currentEffect!, preparation: undefined },
        },
        3000,
      );
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error("prepare refused");
      const begun = await owner.transitionUnitEffect(
        {
          kind: "begin",
          expected: prepared.unit,
          execution: rebound.data.execution,
          effectId: rebound.data.effectId,
          call: 0,
        },
        3001,
      );
      expect(begun.ok).toBe(true);
      if (!begun.ok) throw new Error("begin refused");
      expect(
        await owner.admitMaintenance({ ...moved, intent: { ...moved.intent, requestId: "command:rival" } }, 3002),
      ).toEqual({ ok: false, reason: "owned" });
      expect(
        (
          await owner.transitionUnitEffect(
            {
              kind: "complete",
              expected: begun.unit,
              execution: rebound.data.execution,
              effectId: rebound.data.effectId,
              call: 0,
              outcome: { state: "uncertain" },
            },
            3003,
          )
        ).ok,
      ).toBe(true);
      expect(
        await owner.admitMaintenance({ ...moved, intent: { ...moved.intent, requestId: "command:uncertain" } }, 3004),
      ).toEqual({ ok: false, reason: "owned" });
      expect(await owner.listUnits(first.instance.id)).toHaveLength(1);
      expect(
        state.storage.sql.exec(`SELECT json FROM coordinator_instances WHERE instance_id = ?`, first.instance.id).one(),
      ).toEqual({ json: JSON.stringify(first.instance) });
    });
  });
  it("atomically reserves actual command intent and refuses a rival without a Workflow", async () => {
    const key = storeKey();
    const input = {
      version: 1,
      intent: {
        kind: "command",
        requestId: "command:first",
        actorId: "slack:UALICE",
        userId: "slack:UALICE",
        channelId: "slack:C1",
        threadKey: "slack:C1:maintenance",
      },
      target: { repo: "acme/api", pr: 7, ref: "codex/maintenance", base: "main", headSha: "a".repeat(40) },
      createdAt: 1000,
      bounds: { leaseMinutes: 30, spendCapUsd: 1 },
    };
    const first = await post("/runs/coordinator/maintenance/admit", { storeKey: key, input });
    expect(first).toMatchObject({
      status: 200,
      data: {
        ok: true,
        instance: { kind: "maintenance", userId: "slack:UALICE" },
        unit: { currentEffect: { preparation: "reserved", phase: "active", calls: [{ state: "unstarted" }] } },
      },
    });
    expect(first.data.execution.workflowId).toBeUndefined();
    expect((await post("/runs/coordinator/maintenance/admit", { storeKey: key, input })).data).toMatchObject({
      ok: true,
      replayed: true,
      effectId: first.data.effectId,
    });
    expect(
      (
        await post("/runs/coordinator/maintenance/admit", {
          storeKey: key,
          input: { ...input, intent: { ...input.intent, requestId: "command:rival" } },
        })
      ).status,
    ).toBe(409);
    expect(
      (await post("/runs/coordinator/pull-owners", { storeKey: key, target: { repo: "acme/api", pr: 7 } })).data,
    ).toMatchObject({
      ok: true,
      owners: [expect.objectContaining({ kind: "unit", instanceId: first.data.instance.id })],
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO) => {
      expect(await owner.offerCoordinatorReconciliation(first.data.instance.id, "ONE", 2000)).toEqual({
        offered: false,
      });
      expect(owner.openPlaneEffects()).toEqual([]);
    });
  });
});

describe("complete canonical pull ownership", () => {
  it.each(["checkpoint", "model"] as const)(
    "admits the original pre-PR %s child and retains its workspace obligation through PR binding",
    async (producer) => {
      const key = storeKey(),
        id = "initial_coding",
        thread = "slack:C1:initial-coding",
        head = "b".repeat(40);
      const instance: CoordinatorInstance = {
        id: "initial_ship",
        branch: "fix/initial",
        kind: "ship",
        userId: "slack:UALICE",
        channelId: "slack:C1",
        threadKey: thread,
        repo: "acme/api",
        base: "main",
        merge: "person",
        createdAt: 1,
      };
      const unit: CoordinatorUnit = {
        instanceId: instance.id,
        unit: "ROOT",
        slug: "root",
        branch: "fix/initial",
        dependsOn: [],
        rounds: [],
        currentEffect: {
          version: 1,
          id: "ROOT/0/coding",
          ordinal: 2,
          execution: { workflowId: instance.id },
          phase: "settled",
          target: { repo: instance.repo, ref: "fix/initial", base: "main", headSha: "a".repeat(40) },
          calls: [{ operation: "spawn", state: "accepted", runId: id }],
        },
      };
      const binding: PublicationBinding = {
        runId: id,
        instanceId: instance.id,
        step: `${instance.id}:ROOT/0/coding`,
        repo: instance.repo,
        branch: unit.branch,
        requester: instance.userId,
        threadKey: thread,
        generation: "g1",
        baseHeadSha: "a".repeat(40),
      };
      const publicationSettlement: PublicationSettlement = {
        version: 1,
        binding,
        checkpoint: { kind: producer === "model" ? "clean" : "created", head },
        publication: producer === "model" ? { kind: "not_attempted" } : { kind: "accepted", head },
        preservation: { kind: "pending" },
        release: { kind: "pending" },
      };
      const publication = { version: 1, repo: instance.repo, branches: [], complete: false };
      const native = [{ ref: unit.branch, sha: head, by: "push" }];
      const meta = {
        agent: "coding",
        repo: instance.repo,
        channelId: instance.channelId,
        userId: instance.userId,
        threadKey: thread,
        parentInstanceId: instance.id,
        coordinatorUnit: unit.unit,
        coordinatorAttempt: 0,
        idempotencyKey: binding.step,
      };
      expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
      expect(
        (await post("/runs/coordinator/units/put", { storeKey: key, units: [{ ...unit, currentEffect: undefined }] }))
          .status,
      ).toBe(200);
      const stub = env.RUNS.get(env.RUNS.idFromName(key));
      await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
        state.storage.sql.exec(
          `UPDATE coordinator_units SET json = ? WHERE instance_id = ? AND unit = ?`,
          JSON.stringify(unit),
          instance.id,
          unit.unit,
        );
      });
      expect(
        (
          await post(
            "/runs/claim",
            claimBody(key, id, thread, "g1", {
              meta,
              state: {
                branchPublication: publication,
                branchPushReceipts: native,
                publicationSettlement,
                binding: {
                  backend: "resident",
                  ref: unit.branch,
                  workspace: "/workspace/threads/initial/fix-initial",
                  user: "worker1",
                  container: "container",
                  ownerGen: "g1",
                  ownerFence: 7,
                },
              },
            }),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await post("/runs/finish", {
            storeKey: key,
            runId: id,
            gen: "g1",
            record: { ...record(id, thread), ...meta, headSha: head, publicationSettlement },
          })
        ).status,
      ).toBe(200);
      await runInDurableObject(stub, async (owner: RunHistoryDO, state) => {
        const expected = { ok: true, owners: [{ kind: "unit", instanceId: instance.id, unit: unit.unit }] };
        const before = state.storage.sql
          .exec(`SELECT json FROM workspace_settlements WHERE allocation_json IS NULL OR json IS NOT NULL`)
          .toArray();
        expect(before).toHaveLength(1);
        expect(await owner.findPullOwners({ repo: instance.repo, ref: unit.branch })).toEqual(expected);
        expect(await owner.findPullOwners({ repo: "other/repo", pr: 7 })).toEqual({ ok: true, owners: [] });
        if (producer === "model") {
          const source = state.storage.sql
            .exec<{ summary_json: string; work_evidence_json: string }>(
              `SELECT summary_json, work_evidence_json FROM runs WHERE run_id = ?`,
              id,
            )
            .one();
          state.storage.sql.exec(
            `UPDATE coordinator_units SET json = ? WHERE instance_id = ? AND unit = ?`,
            JSON.stringify({
              ...unit,
              ending: {
                kind: "aborted",
                report: "no PR",
                at: 2,
                outcome: { schemaVersion: 1, kind: "aborted", reviewRounds: 0 },
              },
            }),
            instance.id,
            unit.unit,
          );
          expect(
            (
              await post("/runs/coordinator/pull-owners", {
                storeKey: key,
                target: { repo: instance.repo, ref: unit.branch },
              })
            ).data,
          ).toEqual({ ok: true, owners: [] });
          expect(
            state.storage.sql
              .exec(`SELECT json FROM workspace_settlements WHERE allocation_json IS NULL OR json IS NOT NULL`)
              .toArray(),
          ).toEqual(before);
          state.storage.sql.exec(
            `UPDATE coordinator_units SET json = ? WHERE instance_id = ? AND unit = ?`,
            JSON.stringify(unit),
            instance.id,
            unit.unit,
          );
          const summary = JSON.parse(source.summary_json);
          const privateWork = JSON.parse(source.work_evidence_json);
          const assertHeld = async () =>
            expect(
              (
                await post("/runs/coordinator/pull-owners", {
                  storeKey: key,
                  target: { repo: instance.repo, pr: 999 },
                  diagnostic: true,
                })
              ).data,
            ).toMatchObject({ ok: false, reason: "incomplete" });
          for (const altered of [
            { headSha: undefined },
            { headSha: "c".repeat(40) },
            {
              publicationSettlement: { ...publicationSettlement, checkpoint: { kind: "clean", head: "c".repeat(40) } },
            },
            { publicationSettlement: { ...publicationSettlement, binding: { ...binding, baseHeadSha: undefined } } },
            {
              publicationSettlement: { ...publicationSettlement, binding: { ...binding, baseHeadSha: "c".repeat(40) } },
            },
            ...["pending", "unknown", "rejected", "accepted"].map((kind) => ({
              publicationSettlement: { ...publicationSettlement, publication: { kind, head, reason: "unconfirmed" } },
            })),
          ]) {
            state.storage.sql.exec(
              `UPDATE runs SET summary_json = ? WHERE run_id = ?`,
              JSON.stringify({ ...summary, ...altered }),
              id,
            );
            await assertHeld();
          }
          state.storage.sql.exec(`UPDATE runs SET summary_json = ? WHERE run_id = ?`, source.summary_json, id);
          for (const altered of [
            { branchPushReceipts: [] },
            { branchPushReceipts: [{ ref: unit.branch, sha: head, by: "salvage" }] },
            { branchPushReceipts: [{ ref: "fix/foreign", sha: head, by: "push" }] },
            { branchPushReceipts: [...native, { ref: "fix/foreign", sha: head, by: "push" }] },
            {
              doorPublicationPending: {
                id: "unknown",
                repo: instance.repo,
                update: { ref: `refs/heads/${unit.branch}`, old: "a".repeat(40), next: head },
              },
            },
          ]) {
            state.storage.sql.exec(
              `UPDATE runs SET work_evidence_json = ? WHERE run_id = ?`,
              JSON.stringify({ ...privateWork, ...altered }),
              id,
            );
            await assertHeld();
          }
          state.storage.sql.exec(
            `UPDATE runs SET work_evidence_json = ? WHERE run_id = ?`,
            source.work_evidence_json,
            id,
          );
          for (const effect of [
            { ...unit.currentEffect!, phase: "active" },
            { ...unit.currentEffect!, calls: [{ operation: "spawn", state: "unknown" }] },
            { ...unit.currentEffect!, calls: [{ operation: "spawn", state: "accepted", runId: "foreign_child" }] },
          ]) {
            state.storage.sql.exec(
              `UPDATE coordinator_units SET json = ? WHERE instance_id = ? AND unit = ?`,
              JSON.stringify({ ...unit, currentEffect: effect }),
              instance.id,
              unit.unit,
            );
            await assertHeld();
          }
          state.storage.sql.exec(
            `UPDATE coordinator_units SET json = ? WHERE instance_id = ? AND unit = ?`,
            JSON.stringify(unit),
            instance.id,
            unit.unit,
          );
          const retained = state.storage.sql
            .exec<{ owner_key: string; revision: number; json: string }>(
              `SELECT owner_key, revision, json FROM workspace_settlements WHERE json IS NOT NULL`,
            )
            .one();
          const obligation = JSON.parse(retained.json);
          for (const altered of [
            { owner: { ...obligation.owner, ownerGen: "foreign_generation" } },
            { binding: { ...obligation.binding, ref: "fix/foreign" } },
            { binding: { ...obligation.binding, publicationBaseSha: "c".repeat(40) } },
          ]) {
            state.storage.sql.exec(
              `UPDATE workspace_settlements SET json = ? WHERE owner_key = ? AND revision = ?`,
              JSON.stringify({ ...obligation, ...altered }),
              retained.owner_key,
              retained.revision,
            );
            await assertHeld();
          }
          state.storage.sql.exec(
            `UPDATE workspace_settlements SET json = ? WHERE owner_key = ? AND revision = ?`,
            retained.json,
            retained.owner_key,
            retained.revision,
          );
          state.storage.sql.exec(
            `INSERT INTO workspace_settlements (owner_key, revision, json) VALUES (?, ?, ?)`,
            retained.owner_key,
            retained.revision + 1,
            retained.json,
          );
          await assertHeld();
          state.storage.sql.exec(
            `DELETE FROM workspace_settlements WHERE owner_key = ? AND revision = ?`,
            retained.owner_key,
            retained.revision + 1,
          );
          expect(
            (
              await post("/runs/coordinator/pull-owners", {
                storeKey: key,
                target: { repo: instance.repo, ref: unit.branch },
              })
            ).data,
          ).toEqual(expected);
          expect(
            state.storage.sql.exec(`SELECT summary_json, work_evidence_json FROM runs WHERE run_id = ?`, id).one(),
          ).toEqual(source);
        }
        const actionId = `r_${"d".repeat(64)}`;
        const recovering: CoordinatorUnit = {
          ...unit,
          history: { version: 1, receiptId: "rc_claim" },
          recovery: {
            kind: "coding",
            round: 0,
            actionId,
            workflowId: `recovery-${actionId}`,
            expectedHeadSha: head,
            remainingMs: 1000,
            claimedAt: 2,
            deadlineAt: 1002,
            step: `${unit.unit}/recovery/${actionId}/0/coding`,
            codingRunId: id,
            codingKey: binding.step,
            previousEnding: { kind: "failed", report: "PR creation refused", at: 1 },
            accounting: {
              spendUsd: 0,
              children: [{ runId: id, key: binding.step, usd: 0 }],
              grant: { renewals: 0 },
              renewalsSpent: 0,
            },
          },
        };
        state.storage.sql.exec(
          `UPDATE coordinator_units SET json = ? WHERE instance_id = ? AND unit = ?`,
          JSON.stringify(recovering),
          instance.id,
          unit.unit,
        );
        expect(await owner.findPullOwners({ repo: instance.repo, ref: unit.branch })).toEqual({
          ok: true,
          owners: [{ kind: "unit", instanceId: instance.id, unit: unit.unit, actionId }],
        });
        state.storage.sql.exec(
          `UPDATE coordinator_units SET json = ? WHERE instance_id = ? AND unit = ?`,
          JSON.stringify(unit),
          instance.id,
          unit.unit,
        );
        const effect = {
          ...unit.currentEffect!,
          id: "ROOT/0/coding/pr-check",
          ordinal: 3,
          phase: "active" as const,
          target: { ...unit.currentEffect!.target, headSha: head },
          calls: [{ operation: "pull_create" as const, state: "unstarted" as const }],
        };
        const admitted = await owner.transitionUnitEffect(
          { kind: "admit", expected: unit, execution: { workflowId: instance.id }, effect },
          3,
        );
        expect(admitted).toMatchObject({ ok: true });
        if (!admitted.ok) throw new Error("original effect refused");
        const begun = await owner.transitionUnitEffect(
          { kind: "begin", expected: admitted.unit, execution: effect.execution, effectId: effect.id, call: 0 },
          4,
        );
        if (!begun.ok) throw new Error("original effect begin refused");
        const completed = await owner.transitionUnitEffect(
          {
            kind: "complete",
            expected: begun.unit,
            execution: effect.execution,
            effectId: effect.id,
            call: 0,
            outcome: {
              state: "accepted",
              commitSha: head,
              pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
            },
          },
          5,
        );
        if (!completed.ok) throw new Error("original effect completion refused");
        const settled = await owner.transitionUnitEffect(
          { kind: "settle", expected: completed.unit, execution: effect.execution, effectId: effect.id },
          6,
        );
        if (!settled.ok) throw new Error("original effect settlement refused");
        const mapped = {
          ...settled.unit,
          pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
          publication: {
            repo: instance.repo,
            pr: 7,
            headRef: unit.branch,
            publicationRef: unit.branch,
            baseRef: "main",
            expectedHeadSha: head,
            owner: { instanceId: instance.id, unit: unit.unit },
          },
        };
        expect(await owner.compareAndReplaceUnit(settled.unit, mapped, 7)).toEqual({ ok: true });
        expect(await owner.findPullOwners({ repo: instance.repo, pr: 7 })).toEqual(expected);
        const ended: CoordinatorUnit = {
          ...mapped,
          ending: {
            kind: "refused",
            report: "ended",
            at: 8,
            outcome: { schemaVersion: 1, kind: "refused", reviewRounds: 0 },
          },
        };
        expect(await owner.compareAndReplaceUnit(mapped, ended, 8)).toEqual({ ok: true });
        expect(await owner.findPullOwners({ repo: instance.repo, ref: unit.branch })).toEqual({ ok: true, owners: [] });
        expect(
          state.storage.sql
            .exec(`SELECT json FROM workspace_settlements WHERE allocation_json IS NULL OR json IS NOT NULL`)
            .toArray(),
        ).toEqual(before);
        const evidence = state.storage.sql
          .exec<{ summary_json: string }>(`SELECT summary_json FROM runs WHERE run_id = ?`, id)
          .one();
        expect(JSON.parse(evidence.summary_json).branchPublication).toEqual(publication);
      });
    },
  );
  it("refuses competing PR reservations inside the unit compare-and-replace transaction", async () => {
    const key = storeKey();
    const instance: CoordinatorInstance = {
      id: "atomic_owner",
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:C1",
      threadKey: "slack:C1:atomic-owner",
      repo: "acme/api",
      branch: "fix/atomic",
      base: "main",
      merge: "person",
      createdAt: 1,
    };
    const draft: CoordinatorUnit = {
      instanceId: instance.id,
      unit: "FIRST",
      slug: "first",
      branch: "fix/first",
      dependsOn: [],
      rounds: [],
    };
    const held = {
      ...draft,
      unit: "HELD",
      branch: "fix/held",
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
    };
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [draft, held] })).status).toBe(200);
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (owner: RunHistoryDO, state) => {
      expect(await owner.compareAndReplaceUnit(draft, { ...draft, pr: held.pr }, 3)).toEqual({
        ok: false,
        reason: "owned",
      });
      const fresh = { ...draft, unit: "FRESH", branch: "fix/fresh" };
      const bindingsBefore = state.storage.sql.exec(`SELECT * FROM context_refs`).toArray();
      expect(await owner.putUnits([fresh, { ...draft, pr: held.pr }], 4)).toEqual({ ok: false, reason: "owned" });
      expect(await owner.listUnits(instance.id)).toEqual([draft, held]);
      expect(state.storage.sql.exec(`SELECT * FROM context_refs`).toArray()).toEqual(bindingsBefore);
      expect(
        await owner.appendUnitEvent(instance.id, draft.unit, {
          sender: instance.userId,
          text: "keep me",
          mode: "wake",
          at: 2,
        }),
      ).toMatchObject({ ok: true });
      expect(
        await owner.answerUnitWake(
          { ...draft, pr: held.pr },
          "wait/1",
          { kind: "answered", reply: "go" },
          [1],
          "wake",
          5,
        ),
      ).toEqual({ ok: false, reason: "owned" });
      expect(await owner.listUnitEvents(instance.id, draft.unit, true)).toEqual([
        expect.objectContaining({ text: "keep me" }),
      ]);
      expect(
        JSON.parse(
          state.storage.sql
            .exec<{ json: string }>(
              `SELECT json FROM coordinator_units WHERE instance_id = ? AND unit = ?`,
              instance.id,
              draft.unit,
            )
            .one().json,
        ),
      ).toEqual(draft);
      const started = { ...draft, startedAt: 6 };
      expect(await owner.putUnits([started], 6)).toEqual({ ok: true });
      expect(await owner.putUnits([draft], 7)).toEqual({ ok: false, reason: "settled" });
      expect(await owner.answerUnitWake(draft, "wait/2", { kind: "answered", reply: "go" }, [1], "wake", 7)).toEqual({
        ok: false,
        reason: "settled",
      });
      expect(await owner.compareAndReplaceUnit(started, draft, 7)).toEqual({ ok: false, reason: "stale" });
      const rival = { ...draft, unit: "RIVAL" };
      expect(await owner.putUnits([rival], 8)).toEqual({ ok: true });
      expect(await owner.putUnits([{ ...rival, startedAt: 9 }], 9)).toEqual({ ok: false, reason: "owned" });
      expect(await owner.listUnits(instance.id)).toEqual([started, held, rival]);
    });
  });
  it("preserves live events and pins when history deletion names no terminal row", async () => {
    const key = storeKey(),
      id = "live_delete",
      thread = "slack:C1:live-delete";
    expect((await post("/runs/claim", claimBody(key, id, thread))).status).toBe(200);
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO context_refs (holder_run_id, source_run_id, session_key) VALUES (?, ?, '')`,
        id,
        id,
      );
      const before = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?`, id)
        .one().n;
      expect(await _owner.delete(id)).toBe(false);
      expect(
        state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?`, id).one().n,
      ).toBe(before);
      expect(
        state.storage.sql
          .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM context_refs WHERE holder_run_id = ?`, id)
          .one().n,
      ).toBe(1);
    });
  });
  it("folds canonical Door intent at finish and refuses mismatched settlement bindings", async () => {
    const key = storeKey(),
      id = "reclaimed_door",
      thread = "slack:C1:reclaimed-door";
    const door = {
      id: "call",
      repo: "acme/api",
      update: { ref: "refs/heads/fix/door", old: "a".repeat(40), next: "b".repeat(40) },
    };
    expect(
      (
        await post(
          "/runs/claim",
          claimBody(key, id, thread, "g1", {
            meta: { channelId: "slack:C1", userId: "slack:UALICE", threadKey: thread, repo: "acme/api" },
            state: { doorPublicationPending: door },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/runs/finish", {
          storeKey: key,
          runId: id,
          gen: "g1",
          record: { ...record(id, thread), repo: "acme/api" },
        })
      ).status,
    ).toBe(200);
    expect(
      await post("/runs/coordinator/pull-owners", { storeKey: key, target: { repo: "acme/api", ref: "fix/door" } }),
    ).toMatchObject({ data: { ok: true, owners: [{ kind: "run", runId: id }] } });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      const settlement = {
        version: 1,
        revision: 1,
        owner: { runId: "settlement", ownerGen: "g1", ownerFence: 1 },
        binding: null,
        record: { id: "settlement", threadKey: thread, status: "completed", userId: "slack:UALICE", repo: "acme/api" },
        publication: {
          version: 1,
          repo: "acme/api",
          branches: [],
          complete: false,
          pending: { id: "call", pr: 7, headSha: "a".repeat(40) },
        },
      };
      state.storage.sql.exec(
        `INSERT INTO workspace_settlements (owner_key, revision, json) VALUES ('wrong-owner', 1, ?)`,
        JSON.stringify(settlement),
      );
      expect(await _owner.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({ ok: false, reason: "incomplete" });
    });
  });
  it("reads unhosted units, direct private intent and unsettled effects without public listing authority", async () => {
    const key = storeKey();
    const instance: CoordinatorInstance = {
      id: "unhosted_pull_owner",
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:C1",
      threadKey: "slack:C1:owner",
      repo: "acme/api",
      branch: "fix/task",
      base: "main",
      merge: "person",
      createdAt: 1,
    };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: "UOWNER",
      slug: "task",
      branch: "fix/task",
      dependsOn: [],
      rounds: [],
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
    };
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [unit] })).status).toBe(200);
    const lookup = (target: unknown) => post("/runs/coordinator/pull-owners", { storeKey: key, target });
    expect(await lookup({ repo: "ACME/API", pr: 7 })).toMatchObject({
      status: 200,
      data: { ok: true, owners: [{ kind: "unit", instanceId: instance.id, unit: "UOWNER" }] },
    });
    const runId = "direct_pull_owner";
    const threadKey = "slack:C1:direct-pull";
    expect(
      (
        await post(
          "/runs/claim",
          claimBody(key, runId, threadKey, "g1", {
            state: {
              binding: {
                backend: "resident",
                ownerGen: "g1",
                ownerFence: 7,
                ref: "fix/direct",
                workspace: "/workspace/threads/t/direct",
                user: "worker2",
                container: "vm-1",
              },
              branchPublication: {
                version: 1,
                repo: "acme/api",
                branches: [],
                complete: false,
                pending: { id: "call", pr: 8, headSha: "a".repeat(40) },
              },
            },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/runs/finish", {
          storeKey: key,
          runId,
          gen: "g1",
          record: { ...record(runId, threadKey), repo: "acme/api" },
        })
      ).status,
    ).toBe(200);
    expect(await lookup({ repo: "acme/api", pr: 8 })).toMatchObject({
      status: 200,
      data: { ok: true, owners: [{ kind: "run", runId }] },
    });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO plane_effects (id, body_json, offered_at) VALUES (?, ?, 1)`,
        "rebase:acme/api#9",
        JSON.stringify({
          id: "rebase:acme/api#9",
          kind: "rebase_round",
          repo: "acme/api",
          number: 9,
          headSha: "a".repeat(40),
          brief: "rebase",
        }),
      );
    });
    expect(await lookup({ repo: "acme/api", pr: 9 })).toMatchObject({
      status: 200,
      data: { ok: true, owners: [{ kind: "effect", id: "rebase:acme/api#9" }] },
    });
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `UPDATE runs SET work_evidence_json = ? WHERE run_id = ?`,
        JSON.stringify({ version: 1, branchPublication: null }),
        runId,
      );
    });
    expect(await lookup({ repo: "acme/api", pr: 8 })).toMatchObject({
      status: 200,
      data: { ok: false, reason: "incomplete" },
    });
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `UPDATE runs SET work_evidence_json = ? WHERE run_id = ?`,
        JSON.stringify({
          version: 1,
          branchPublication: {
            version: 1,
            repo: "acme/api",
            complete: false,
            branches: [],
            pending: { id: "call", pr: 8, headSha: "a".repeat(40) },
          },
        }),
        runId,
      );
    });
    expect(await lookup({ repo: "other/repo", pr: 7 })).toMatchObject({ status: 200, data: { ok: true, owners: [] } });
    expect((await lookup({ repo: "acme/api" })).status).toBe(400);
    const doorId = "terminal_door_owner";
    expect(
      (
        await post("/runs/put", {
          storeKey: key,
          record: {
            ...record(doorId, "slack:C1:door-owner"),
            startedAt: 0,
            finishedAt: 1,
            repo: "acme/api",
            doorPublicationPending: {
              id: "door-call",
              repo: "acme/api",
              update: { ref: "refs/heads/fix/door", old: "a".repeat(40), next: "b".repeat(40) },
            },
          },
        })
      ).status,
    ).toBe(200);
    expect(await lookup({ repo: "acme/api", ref: "fix/door" })).toMatchObject({
      status: 200,
      data: { ok: true, owners: [{ kind: "run", runId: doorId }] },
    });
    expect(await post("/runs/delete", { storeKey: key, id: runId })).toMatchObject({
      status: 409,
      data: { ok: false, reason: "publication_pending" },
    });
    expect(await lookup({ repo: "acme/api", pr: 8 })).toMatchObject({
      status: 200,
      data: { ok: true, owners: [{ kind: "run", runId }] },
    });
    expect((await post("/runs/claim", claimBody(key, "corrupt_live", "slack:C1:corrupt-live"))).status).toBe(200);
    expect(await lookup({ repo: "other/repo", pr: 7 })).toMatchObject({ status: 200, data: { ok: true, owners: [] } });
    for (const meta of [[], 7, {}]) {
      await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
        state.storage.sql.exec(
          `UPDATE live_runs SET meta_json = ? WHERE run_id = 'corrupt_live'`,
          JSON.stringify(meta),
        );
      });
      expect(await lookup({ repo: "other/repo", pr: 7 })).toMatchObject({
        status: 200,
        data: { ok: false, reason: "incomplete" },
      });
    }
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(`DELETE FROM live_runs WHERE run_id = 'corrupt_live'`);
    });

    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(`UPDATE runs SET work_evidence_json = '{' WHERE run_id = ?`, runId);
    });
    expect(await lookup({ repo: "acme/api", pr: 8 })).toMatchObject({
      status: 200,
      data: { ok: false, reason: "incomplete" },
    });
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(`DELETE FROM runs WHERE run_id = ?`, runId);
    });
    expect(await lookup({ repo: "acme/api", pr: 8 })).toMatchObject({
      status: 200,
      data: { ok: true, owners: [{ kind: "run", runId }] },
    });
  });

  it("ignores historical display bytes while retaining canonical terminal publication", async () => {
    const key = storeKey(),
      stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (owner: RunHistoryDO, state) => {
      const label = "x".repeat(Math.floor(1.4 * 1024 * 1024));
      for (let i = 0; i < 4; i++) {
        const row = {
          ...record(`large_${i}`, `slack:C1:large-${i}`),
          repo: "acme/api",
          label,
          ...(i === 3
            ? {
                branchPublication: {
                  version: 1,
                  repo: "acme/api",
                  branches: [],
                  complete: false,
                  pending: { id: "pending-call", pr: 7, headSha: "a".repeat(40) },
                },
              }
            : {}),
        };
        state.storage.sql.exec(
          `INSERT INTO runs (run_id, channel_id, user_id, thread_key, started_at, finished_at, stored_at, status, event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json) VALUES (?, 'slack:C1', 'slack:UALICE', ?, 1, 2, 2, 'completed', 0, 0, 0, ?, '{}', ?)`,
          row.id,
          row.threadKey,
          label.length,
          JSON.stringify(row),
        );
        expect(await owner.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({
          ok: true,
          owners: i === 3 ? [{ kind: "run", runId: row.id }] : [],
        });
      }
    });
  });
  it("bounds canonical producer bytes before parsing", async () => {
    const key = storeKey(),
      stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (owner: RunHistoryDO, state) => {
      for (let i = 0; i < 4; i++) {
        const row = {
          ...record(`large_owner_${i}`, `slack:C1:large-owner-${i}`),
          repo: "acme/api",
          branchPublication: {
            version: 1,
            repo: "acme/api",
            branches: [],
            complete: false,
            pending: { id: "x".repeat(Math.floor(1.4 * 1024 * 1024)), pr: 7, headSha: "a".repeat(40) },
          },
        };
        state.storage.sql.exec(
          `INSERT INTO runs (run_id, channel_id, user_id, thread_key, started_at, finished_at, stored_at, status, event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json) VALUES (?, 'slack:C1', 'slack:UALICE', ?, 1, 2, 2, 'completed', 0, 0, 0, ?, '{}', ?)`,
          row.id,
          row.threadKey,
          JSON.stringify(row).length,
          JSON.stringify(row),
        );
      }
      expect(await owner.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({ ok: false, reason: "incomplete" });
    });
  });
  it("retains unreadable canonical identity and publication after excluding display fields", async () => {
    const key = storeKey(),
      id = "projected_owner",
      terminal = { ...record(id, "slack:C1:projected-owner"), repo: "acme/api" };
    expect((await post("/runs/put", { storeKey: key, record: terminal })).status).toBe(200);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO, state) => {
      for (const raw of [
        "{",
        "null",
        "[]",
        "{}",
        JSON.stringify({ ...terminal, id: "foreign_owner" }),
        JSON.stringify({ ...terminal, userId: null }),
        JSON.stringify({ ...terminal, parentInstanceId: "parent_without_key" }),
        JSON.stringify({ ...terminal, branchPublication: null }),
        JSON.stringify({ ...terminal, branchPublication: { version: 2 } }),
        JSON.stringify({ ...terminal, doorPublicationPending: { id: "unresolved" } }),
        JSON.stringify({ ...terminal, doorPublicationPending: null }).replace(
          '"doorPublicationPending":null',
          '"doorPublicationPending":NaN',
        ),
      ]) {
        state.storage.sql.exec(`UPDATE runs SET summary_json = ? WHERE run_id = ?`, raw, id);
        expect(await owner.findPullOwners({ repo: "acme/api", pr: 7 })).toEqual({ ok: false, reason: "incomplete" });
        expect(
          state.storage.sql.exec<{ summary_json: string }>(`SELECT summary_json FROM runs WHERE run_id = ?`, id).one()
            .summary_json,
        ).toBe(raw);
      }
    });
  });
});

describe("unit effect owner transaction", () => {
  it("HTTP queue receipts retain the stopped owner until exact native terminal resolution", async () => {
    const key = storeKey();
    const instance: CoordinatorInstance = {
      id: "effect_queue_contract",
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:C1",
      threadKey: "slack:C1:effect-queue",
      repo: "acme/api",
      branch: "fix/effect",
      base: "main",
      merge: "person",
      createdAt: 1,
    };
    const execution = { workflowId: instance.id };
    const target = { repo: instance.repo, ref: instance.branch, base: "main", headSha: "a".repeat(40), pr: 7 };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: "ONE",
      slug: "one",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      publication: {
        repo: instance.repo,
        pr: 7,
        headRef: instance.branch,
        publicationRef: instance.branch,
        baseRef: "main",
        expectedHeadSha: target.headSha,
        owner: { instanceId: instance.id, unit: "ONE" },
      },
    };
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [unit] })).status).toBe(200);
    const route = (input: unknown) => post("/runs/coordinator/units/effect-transition", { storeKey: key, input });
    const effect = {
      version: 1,
      id: "ONE/merge/0",
      ordinal: 1,
      execution,
      target,
      phase: "active",
      calls: [{ operation: "enqueue", state: "unstarted" }],
    };
    let answer = await route({ kind: "admit", expected: unit, execution, effect });
    expect(answer.status).toBe(200);
    let row = answer.data.unit;
    answer = await route({ kind: "begin", expected: row, execution, effectId: effect.id, call: 0 });
    expect(answer.status).toBe(200);
    row = answer.data.unit;
    expect(
      (
        await route({
          kind: "complete",
          expected: row,
          execution,
          effectId: effect.id,
          call: 0,
          outcome: { state: "accepted", commitSha: "9".repeat(40) },
        })
      ).status,
    ).toBe(400);
    answer = await route({
      kind: "complete",
      expected: row,
      execution,
      effectId: effect.id,
      call: 0,
      outcome: { state: "accepted" },
    });
    expect(answer.status).toBe(200);
    row = answer.data.unit;
    await post("/runs/coordinator/stop", { storeKey: key, instanceId: instance.id, at: 2 });
    expect(await route({ kind: "settle", expected: row, execution, effectId: effect.id })).toMatchObject({
      status: 409,
      data: { reason: "uncertain" },
    });
    expect(
      (
        await route({
          kind: "resolve",
          expected: row,
          execution,
          effectId: effect.id,
          call: 0,
          observation: { kind: "pull_merged", ...target, headSha: "b".repeat(40), commitSha: "9".repeat(40) },
        })
      ).status,
    ).toBe(409);
    answer = await route({
      kind: "resolve",
      expected: row,
      execution,
      effectId: effect.id,
      call: 0,
      observation: { kind: "pull_dequeued", ...target },
    });
    expect(answer).toMatchObject({ status: 200, data: { unit: { currentEffect: { phase: "settled" } } } });
  });

  it("canonical competing branch owners refuse effect admission without changing either row or context pins", async () => {
    const key = storeKey();
    const instance: CoordinatorInstance = {
      id: "effect_conflict",
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:C1",
      threadKey: "slack:C1:effect-conflict",
      repo: "acme/api",
      branch: "fix/effect",
      base: "main",
      merge: "person",
      createdAt: 1,
    };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: "ONE",
      slug: "one",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
    };
    const rival = { ...unit, unit: "OTHER" };
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [unit, rival] })).status).toBe(200);
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (owner: RunHistoryDO, state) => {
      const before = state.storage.sql.exec(`SELECT * FROM context_refs`).toArray();
      const execution = { workflowId: instance.id };
      expect(
        await owner.transitionUnitEffect(
          {
            kind: "admit",
            expected: unit,
            execution,
            effect: {
              version: 1,
              id: "one/branch",
              ordinal: 1,
              phase: "active",
              execution,
              target: { repo: instance.repo, ref: unit.branch, base: instance.base!, headSha: "a".repeat(40) },
              calls: [{ operation: "branch_create", state: "unstarted" }],
            },
          },
          2,
        ),
      ).toEqual({ ok: false, reason: "owned" });
      expect(await owner.listUnits(instance.id)).toEqual([unit, rival]);
      expect(state.storage.sql.exec(`SELECT * FROM context_refs`).toArray()).toEqual(before);
    });
  });
  it("retains partial accepted work after stop and denies stale writers and unknown replay", async () => {
    const key = storeKey();
    const instance: CoordinatorInstance = {
      id: "effect_owner",
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:C1",
      threadKey: "slack:C1:effect",
      repo: "acme/api",
      branch: "fix/effect",
      base: "main",
      merge: "person",
      createdAt: 1,
    };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: "ONE",
      slug: "one",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
    };
    const execution = { workflowId: instance.id };
    const effect = {
      version: 1,
      id: "one/branch",
      ordinal: 1,
      execution,
      target: { repo: instance.repo, ref: unit.branch, base: instance.base, headSha: "a".repeat(40) },
      phase: "active",
      calls: [
        { operation: "branch_create", state: "unstarted" },
        { operation: "spawn", state: "unstarted" },
      ],
    } as const;
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [unit] })).status).toBe(200);
    const route = (input: unknown) => post("/runs/coordinator/units/effect-transition", { storeKey: key, input });
    expect(await route({ kind: "admit", expected: unit, execution: { workflowId: "wrong" }, effect })).toMatchObject({
      status: 409,
      data: { reason: "execution" },
    });
    expect(
      await route({
        kind: "admit",
        expected: unit,
        execution,
        effect: { ...effect, calls: [{ operation: "merge", state: "unstarted", resourceId: 2 }] },
      }),
    ).toMatchObject({ status: 400 });
    const activeResponse = await route({ kind: "admit", expected: unit, execution, effect });
    expect(activeResponse).toMatchObject({ status: 200, data: { ok: true } });
    const active = activeResponse.data.unit as CoordinatorUnit;
    const pendingResponse = await route({ kind: "begin", expected: active, execution, effectId: effect.id, call: 0 });
    expect(pendingResponse).toMatchObject({ status: 200, data: { ok: true } });
    const pending = pendingResponse.data.unit as CoordinatorUnit;
    expect(await route({ kind: "begin", expected: active, execution, effectId: effect.id, call: 0 })).toMatchObject({
      status: 409,
      data: { reason: "stale" },
    });
    expect(await route({ kind: "begin", expected: pending, execution, effectId: effect.id, call: 0 })).toMatchObject({
      status: 409,
      data: { reason: "uncertain" },
    });
    expect(
      await post("/runs/coordinator/units/claim-legacy-continuation", {
        storeKey: key,
        expected: pending,
        recovered: unit,
      }),
    ).toMatchObject({ status: 409, data: { reason: "stale" } });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (owner: RunHistoryDO, state) => {
      const before = state.storage.sql.exec(`SELECT * FROM context_refs`).toArray();
      expect(await owner.putUnits([{ ...unit, unit: "OTHER", branch: "fix/other" }, unit], 4)).toEqual({
        ok: false,
        reason: "settled",
      });
      expect(await owner.listUnits(instance.id)).toEqual([pending]);
      expect(state.storage.sql.exec(`SELECT * FROM context_refs`).toArray()).toEqual(before);
    });
    expect((await post("/runs/coordinator/stop", { storeKey: key, instanceId: instance.id, at: 5 })).status).toBe(200);
    expect(
      await route({
        kind: "complete",
        expected: pending,
        execution,
        effectId: effect.id,
        call: 0,
        outcome: { state: "refused", cause: "not_started" },
      }),
    ).toMatchObject({ status: 400 });
    const complete = await route({
      kind: "complete",
      expected: pending,
      execution,
      effectId: effect.id,
      call: 0,
      outcome: { state: "accepted", commitSha: "b".repeat(40) },
    });
    expect(complete).toMatchObject({ status: 200, data: { ok: true } });
    expect(
      await route({ kind: "begin", expected: complete.data.unit, execution, effectId: effect.id, call: 1 }),
    ).toMatchObject({ status: 409, data: { reason: "stopped" } });
    const cancelled = await route({
      kind: "cancel",
      expected: complete.data.unit,
      execution,
      effectId: effect.id,
      call: 1,
    });
    expect(cancelled).toMatchObject({ status: 200, data: { ok: true } });
    const settled = await route({ kind: "settle", expected: cancelled.data.unit, execution, effectId: effect.id });
    expect(settled).toMatchObject({ status: 200, data: { unit: { currentEffect: { phase: "settled" } } } });
    expect(
      await route({
        kind: "admit",
        expected: settled.data.unit,
        execution,
        effect: { ...effect, id: "next", ordinal: 2 },
      }),
    ).toMatchObject({ status: 409, data: { reason: "stopped" } });
    await runInDurableObject(stub, async (owner: RunHistoryDO, state) => {
      const row = settled.data.unit as CoordinatorUnit;
      const unknown = {
        ...row,
        currentEffect: { ...effect, calls: [{ operation: "branch_create", state: "uncertain" }] },
      } as CoordinatorUnit;
      state.storage.sql.exec(
        `UPDATE coordinator_units SET json = ? WHERE instance_id = ? AND unit = ?`,
        JSON.stringify(unknown),
        instance.id,
        unit.unit,
      );
      expect(
        await owner.transitionUnitEffect({ kind: "settle", expected: unknown, execution, effectId: effect.id }, 6),
      ).toEqual({ ok: false, reason: "uncertain" });
      expect(await owner.listUnits(instance.id)).toEqual([unknown]);
      const proof = {
        kind: "branch_ref" as const,
        repo: instance.repo,
        ref: unit.branch,
        headSha: effect.target.headSha,
      };
      expect(
        await owner.transitionUnitEffect(
          {
            kind: "resolve",
            expected: unknown,
            execution,
            effectId: effect.id,
            call: 0,
            observation: { ...proof, headSha: "b".repeat(40) },
          },
          6,
        ),
      ).toEqual({ ok: false, reason: "conflict" });
      expect(await owner.listUnits(instance.id)).toEqual([unknown]);
      const resolved = await owner.transitionUnitEffect(
        { kind: "resolve", expected: unknown, execution, effectId: effect.id, call: 0, observation: proof },
        6,
      );
      expect(resolved).toMatchObject({
        ok: true,
        unit: { currentEffect: { calls: [{ state: "accepted", commitSha: effect.target.headSha }] } },
      });
      // A corrupt retained private row refuses, and its bytes survive.
      state.storage.sql.exec(
        `UPDATE coordinator_units SET json = 'private-invalid' WHERE instance_id = ? AND unit = ?`,
        instance.id,
        unit.unit,
      );
      expect(await owner.transitionUnitEffect({ kind: "admit", expected: unit, execution, effect }, 7)).toEqual({
        ok: false,
        reason: "incomplete",
      });
      expect(
        state.storage.sql
          .exec<{ json: string }>(
            `SELECT json FROM coordinator_units WHERE instance_id = ? AND unit = ?`,
            instance.id,
            unit.unit,
          )
          .one().json,
      ).toBe("private-invalid");
    });
  });
});

describe("spawn effect durable receipt transaction", () => {
  it.each(["coding", "review"] as const)(
    "reads the exact %s child and retained admission inside the unit transaction, preserving unknown work on absent or foreign evidence",
    async (preset) => {
      const key = storeKey();
      const instance: CoordinatorInstance = {
        id: "spawn_exact",
        kind: "ship",
        userId: "slack:UALICE",
        channelId: "slack:C1",
        threadKey: "slack:C1:spawn-exact",
        repo: "acme/api",
        branch: "fix/spawn",
        base: "main",
        merge: "person",
        createdAt: 1,
      };
      const execution = { workflowId: instance.id };
      const unit: CoordinatorUnit = {
        instanceId: instance.id,
        unit: "ONE",
        slug: "one",
        branch: instance.branch,
        threadKey: instance.threadKey,
        dependsOn: [],
        rounds: [],
        currentEffect: {
          version: 1,
          ordinal: 1,
          id: preset === "review" ? "ONE/1/review" : "ONE/0/coding",
          execution,
          target: {
            repo: instance.repo,
            ref: instance.branch,
            base: "main",
            headSha: "a".repeat(40),
            ...(preset === "review" ? { pr: 7 } : {}),
          },
          phase: "active",
          calls: [{ operation: "spawn", state: "uncertain" }],
        },
      };
      if (preset === "review") {
        unit.pr = { number: 7, url: "https://github.com/acme/api/pull/7" };
        unit.publication = {
          repo: instance.repo,
          pr: 7,
          headRef: unit.branch,
          baseRef: "main",
          expectedHeadSha: "a".repeat(40),
          publicationRef: unit.branch,
          owner: { instanceId: instance.id, unit: unit.unit },
        };
      }
      expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
      const stub = env.RUNS.get(env.RUNS.idFromName(key));
      await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
        state.storage.sql.exec(
          `INSERT INTO coordinator_units (instance_id, unit, json, updated_at) VALUES (?, ?, ?, ?)`,
          instance.id,
          unit.unit,
          JSON.stringify(unit),
          2,
        );
      });
      const input = {
        kind: "resolve",
        expected: unit,
        execution,
        effectId: unit.currentEffect!.id,
        call: 0,
        observation: { kind: "spawn_run", runId: "spawn-child" },
      };
      const resolve = () => post("/runs/coordinator/units/effect-transition", { storeKey: key, input });
      expect(await resolve()).toMatchObject({ status: 409, data: { reason: "unavailable" } });
      const meta = {
        agent: preset,
        channelId: instance.channelId,
        userId: instance.userId,
        threadKey: instance.threadKey,
        repo: instance.repo,
        ref: unit.branch,
        parentInstanceId: instance.id,
        coordinatorUnit: unit.unit,
        coordinatorAttempt: 0,
        idempotencyKey: `${instance.id}:${unit.currentEffect!.id}`,
        ...(preset === "review" ? { pr: 7, headSha: "a".repeat(40) } : {}),
      };
      expect(
        (await post("/runs/claim", claimBody(key, "spawn-child", instance.threadKey, "g1", { meta }))).status,
      ).toBe(200);
      expect(await resolve()).toMatchObject({ status: 409, data: { reason: "incomplete" } });
      const tag = {
        type: "coordinator_tag",
        parentInstanceId: instance.id,
        unit: unit.unit,
        branch: unit.branch,
        base: "main",
        seq: 2,
        ...(unit.publication ? { publication: unit.publication } : {}),
      };
      const original = {
        type: "run_meta",
        agent: preset,
        seq: 1,
        repo: instance.repo,
        ref: unit.branch,
        pr: 7,
        headSha: "a".repeat(40),
      };
      expect(
        (await post("/runs/append", { storeKey: key, runId: "spawn-child", gen: "g1", events: [original, tag] }))
          .status,
      ).toBe(200);
      await runInDurableObject(stub, async (owner: RunHistoryDO, state) => {
        state.storage.sql.exec(
          `UPDATE live_runs SET meta_json = ? WHERE run_id = ?`,
          JSON.stringify({ ...meta, userId: "slack:UBOB" }),
          "spawn-child",
        );
        expect(await resolve()).toMatchObject({ status: 409, data: { reason: "conflict" } });
        expect(await owner.listUnits(instance.id)).toEqual([unit]);
        state.storage.sql.exec(
          `UPDATE live_runs SET meta_json = ? WHERE run_id = ?`,
          JSON.stringify(meta),
          "spawn-child",
        );
      });
      const { pr: _pr, ...summaryMeta } = meta;
      const tombstone = {
        ...record("spawn-child", instance.threadKey),
        ...summaryMeta,
        startedAt: 1000,
        status: "interrupted",
        provisional: true,
        events: [original, tag],
      };
      expect((await post("/runs/put", { storeKey: key, record: tombstone })).status).toBe(200);
      expect(await resolve()).toMatchObject({ status: 200, data: { ok: true } });
      await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
        // Retained uncertain input, not a successful rollback of a recorded receipt.
        state.storage.sql.exec(
          `UPDATE coordinator_units SET json = ? WHERE instance_id = ? AND unit = ?`,
          JSON.stringify(unit),
          instance.id,
          unit.unit,
        );
        state.storage.sql.exec(`DELETE FROM live_runs WHERE run_id = ?`, "spawn-child");
      });
      expect(await resolve()).toMatchObject({ status: 409, data: { reason: "unavailable" } });
      await runInDurableObject(stub, async (owner: RunHistoryDO, state) => {
        expect(await owner.listUnits(instance.id)).toEqual([unit]);
        state.storage.sql.exec(
          `UPDATE runs SET summary_json = ? WHERE run_id = ?`,
          JSON.stringify({
            ...tombstone,
            status: "completed",
            headSha: "c".repeat(40),
            provisional: undefined,
            events: undefined,
          }),
          "spawn-child",
        );
      });
      expect((await post("/runs/coordinator/stop", { storeKey: key, instanceId: instance.id, at: 3 })).status).toBe(
        200,
      );
      expect(await resolve()).toMatchObject({
        status: 200,
        data: {
          ok: true,
          unit: {
            currentEffect: {
              calls: [{ operation: "spawn", state: "accepted", runId: "spawn-child" }],
            },
          },
        },
      });
    },
  );
});

// Feature: docs/reference/specs/orchestration-plane.md — unfinishable historical reports never acquire a blocking offer.
describe("durable original report eligibility", () => {
  const instance: CoordinatorInstance = {
    id: "report_eligibility",
    kind: "ship",
    userId: "slack:UALICE",
    channelId: "slack:C1",
    threadKey: "slack:C1:original",
    repo: "acme/api",
    branch: "fix/original",
    base: "main",
    createdAt: 1000,
    admission: "created",
  };
  const unit: CoordinatorUnit = {
    instanceId: instance.id,
    unit: "ONE",
    slug: "original",
    branch: instance.branch,
    dependsOn: [],
    rounds: [],
    ending: { kind: "aborted", report: "Original private detail", at: 2000 },
  };
  async function prepare(row: CoordinatorUnit) {
    const key = storeKey();
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [row] })).status).toBe(200);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO) => {
      const holder = owner as unknown as { env: Record<string, unknown> };
      holder.env = {
        ...holder.env,
        SHIP_COORDINATOR: { get: async () => ({ status: async () => ({ status: "errored" }) }) },
      };
    });
    return key;
  }
  it("retains historical ending bytes without a blocking offer when identity or original rendering is missing", async () => {
    for (const row of [unit, { ...unit, ending: { ...unit.ending!, deliveryId: "original/end" } }]) {
      const key = await prepare(row);
      expect(
        (await post("/runs/coordinator/reconcile/offer", { storeKey: key, instanceId: instance.id, unit: unit.unit }))
          .data,
      ).toEqual({ offered: false });
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO) => {
        expect(owner.openPlaneEffects()).toEqual([]);
        expect(await owner.listUnits(instance.id)).toEqual([row]);
      });
    }
  });
  it("still offers an original report with its saved raw delivery and retained rendering", async () => {
    const row = { ...unit, ending: { ...unit.ending!, deliveryId: "original/end", threadReport: "Original summary" } };
    const key = await prepare(row);
    expect(
      (await post("/runs/coordinator/reconcile/offer", { storeKey: key, instanceId: instance.id, unit: unit.unit }))
        .data,
    ).toEqual({ offered: true });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO) => {
      expect(owner.openPlaneEffects()).toHaveLength(1);
      expect(await owner.listUnits(instance.id)).toEqual([row]);
    });
  });
  it("offers only the strictly decoded original canonical report when retained rendering is absent", async () => {
    const row = { ...unit, ending: { ...unit.ending!, deliveryId: "original/end" } };
    const key = await prepare(row);
    const reportOwner = {
      instanceId: instance.id,
      unit: unit.unit,
      attempt: 0,
      requester: instance.userId,
      channelId: instance.channelId,
      threadKey: instance.threadKey,
      deliveryId: row.ending!.deliveryId!,
    };
    const proposal = { text: row.ending!.report, threadText: "Original immutable summary" };
    const admission = await coordinatorReportAdmission(reportOwner, proposal);
    const ledger = {
      appendSession: async (
        sessionKey: string,
        rowId: string,
        rows: Array<{ part: number; json: string }>,
        context?: ContextDependencies,
      ) => env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)).appendKeyed(rowId, rows, context),
      readSessionEntry: async (sessionKey: string, rowId: string) =>
        env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(sessionKey)).readEntry(rowId),
    };
    expect(await freezeAdmittedCoordinatorReport(ledger, admission, reportOwner, proposal)).toEqual(proposal);
    expect(
      (await post("/runs/coordinator/reconcile/offer", { storeKey: key, instanceId: instance.id, unit: unit.unit }))
        .data,
    ).toEqual({ offered: true });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO) => {
      expect(owner.openPlaneEffects()).toHaveLength(1);
      expect(await owner.listUnits(instance.id)).toEqual([row]);
    });
  });
});

describe("coordinator admission diagnostics", () => {
  it("logs a bounded failing check and retains the refused ownership rows", async () => {
    const key = storeKey();
    const instance: CoordinatorInstance = {
      id: "diagnostic_owner",
      kind: "ship",
      userId: "cli:owner",
      channelId: "cli:local",
      threadKey: "cli:task",
      repo: "acme/api",
      branch: "fix/task",
      base: "main",
      merge: "person",
      createdAt: 1,
    };
    await post("/runs/coordinator/put", { storeKey: key, instance });
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        "INSERT INTO coordinator_units (instance_id, unit, json, updated_at) VALUES (?, ?, ?, ?)",
        "foreign_owner",
        "BROKEN",
        JSON.stringify({ privateText: "secret-fixture" }),
        1,
      );
    });
    const log = vi.spyOn(console, "log");
    try {
      const row: CoordinatorUnit = {
        instanceId: instance.id,
        unit: "ROOT",
        slug: "task",
        branch: instance.branch,
        dependsOn: [],
        rounds: [],
        pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      };
      expect(await post("/runs/coordinator/units/put", { storeKey: key, units: [row] })).toMatchObject({
        status: 409,
        data: { ok: false, reason: "incomplete" },
      });
      const lines = log.mock.calls.map(([line]) => String(line));
      const diagnostic = lines
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line))
        .find((value) => value.event === "coordinator_unit_admission_refused");
      expect(diagnostic).toMatchObject({
        instanceId: instance.id,
        unit: "ROOT",
        reason: "incomplete",
        diagnostic: { check: "unit_shape", source: "units", rowIndex: 0 },
      });
      expect(JSON.stringify(diagnostic)).not.toContain("secret-fixture");
      await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
        expect(
          state.storage.sql
            .exec<{ json: string }>("SELECT json FROM coordinator_units WHERE instance_id = ?", "foreign_owner")
            .one().json,
        ).toBe(JSON.stringify({ privateText: "secret-fixture" }));
        expect(
          state.storage.sql.exec("SELECT json FROM coordinator_units WHERE instance_id = ?", instance.id).toArray(),
        ).toEqual([]);
      });
    } finally {
      log.mockRestore();
    }
  });
});

describe("bounded SQLite terminal pull-owner candidates", () => {
  const candidateInstance: CoordinatorInstance = {
    id: "target_index",
    kind: "ship",
    userId: "slack:UALICE",
    channelId: "slack:C1",
    threadKey: "slack:C1:target",
    repo: "acme/api",
    branch: "fix/target",
    base: "main",
    createdAt: 1,
  };
  const candidateUnit: CoordinatorUnit = {
    instanceId: candidateInstance.id,
    unit: "UINDEX",
    slug: "target",
    branch: candidateInstance.branch,
    dependsOn: [],
    rounds: [],
    pr: { number: 8, url: "https://github.com/acme/api/pull/8" },
  };
  const pending = (pr: number) => ({
    version: 1 as const,
    repo: "acme/api",
    branches: [],
    complete: false,
    pending: { id: "retained-call", pr, ref: "fix/held", headSha: "a".repeat(40) },
  });
  async function insertCandidate(key: string, id = "retained", pr = 7) {
    const row = { ...record(id, `slack:C1:${id}`), repo: "acme/api", branchPublication: pending(pr) };
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO runs (run_id, channel_id, user_id, thread_key, started_at, finished_at, stored_at,
        status, event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json)
        VALUES (?, 'slack:C1', 'slack:UALICE', ?, 1, 2, 2, 'completed', 0, 0, 0, ?, '{}', ?)`,
        id,
        row.threadKey,
        JSON.stringify(row).length,
        JSON.stringify(row),
      );
    });
    return row;
  }
  const lookup = async (
    key: string,
    target: { repo: string; pr?: number; ref?: string } = { repo: "acme/api", pr: 8 },
  ) => (await post("/runs/coordinator/pull-owners", { storeKey: key, target })).data;
  it("makes bounded index progress then admits a disjoint target while preserving every retained source", async () => {
    const key = storeKey();
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      for (let i = 0; i < 4; i++) {
        const row = {
          ...record(`index_large_${i}`, `slack:C1:index-${i}`),
          repo: "acme/api",
          branchPublication: {
            version: 1,
            repo: "acme/api",
            branches: [],
            complete: false,
            pending: { id: "x".repeat(Math.floor(1.4 * 1024 * 1024)), pr: 7, headSha: "a".repeat(40) },
          },
        };
        state.storage.sql.exec(
          `INSERT INTO runs (run_id, channel_id, user_id, thread_key, started_at, finished_at, stored_at, status, event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json) VALUES (?, 'slack:C1', 'slack:UALICE', ?, 1, 2, 2, 'completed', 0, 0, 0, ?, '{}', ?)`,
          row.id,
          row.threadKey,
          JSON.stringify(row).length,
          JSON.stringify(row),
        );
      }
    });
    const originals = (await cells(key)).runs;
    const request = { storeKey: key, target: { repo: "ACME/API", pr: 8 } };
    expect((await post("/runs/coordinator/pull-owners", request)).data).toEqual({ ok: false, reason: "incomplete" });
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      expect(
        state.storage.sql.exec(`SELECT run_id FROM terminal_pull_owner_coverage WHERE dirty=0 AND valid=1`).toArray(),
      ).toHaveLength(3);
      const charged = state.storage.sql
        .exec<{ bytes: number }>(
          `SELECT SUM(length(summary_json)*3) AS bytes FROM runs
        WHERE run_id IN (SELECT run_id FROM terminal_pull_owner_coverage WHERE dirty=0 AND valid=1)`,
        )
        .one().bytes;
      expect(charged).toBeLessThanOrEqual(16 * 1024 * 1024);
    });
    expect((await post("/runs/coordinator/pull-owners", request)).data).toEqual({ ok: true, owners: [] });
    expect((await post("/runs/coordinator/pull-owners", request)).data).toEqual({ ok: true, owners: [] });
    expect((await post("/runs/coordinator/put", { storeKey: key, instance: candidateInstance })).data).toEqual({
      ok: true,
    });
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [candidateUnit] })).data).toEqual({
      ok: true,
    });
    expect(
      (await post("/runs/coordinator/pull-owners", { ...request, target: { repo: "acme/api", pr: 7 } })).data,
    ).toEqual({ ok: false, reason: "incomplete" });
    expect((await cells(key)).runs).toEqual(originals);
    await runInDurableObject(stub, async (_owner: RunHistoryDO, state) => {
      expect(state.storage.sql.exec("SELECT run_id FROM runs").toArray()).toHaveLength(4);
      expect(
        state.storage.sql.exec<{ bytes: number }>("SELECT MIN(length(summary_json)) AS bytes FROM runs").one().bytes,
      ).toBeGreaterThan(1.4 * 1024 * 1024);
    });
  });
  it.each(["summary", "private"] as const)(
    "invalidates %s source updates before a new unit can claim the old negative",
    async (mode) => {
      const key = storeKey();
      await insertCandidate(key);
      expect(await lookup(key)).toEqual({ ok: true, owners: [] });
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
        if (mode === "summary")
          state.storage.sql.exec(
            `UPDATE runs SET summary_json=json_set(summary_json,'$.branchPublication',json(?)) WHERE run_id='retained'`,
            JSON.stringify(pending(8)),
          );
        else
          state.storage.sql.exec(
            `UPDATE runs SET work_evidence_json=? WHERE run_id='retained'`,
            JSON.stringify({ version: 1, branchPublication: pending(8) }),
          );
        expect(
          state.storage.sql
            .exec<{ dirty: number }>(`SELECT dirty FROM terminal_pull_owner_coverage WHERE run_id='retained'`)
            .one().dirty,
        ).toBe(1);
      });
      expect((await post("/runs/coordinator/put", { storeKey: key, instance: candidateInstance })).data).toEqual({
        ok: true,
      });
      expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [candidateUnit] })).data).toEqual({
        ok: false,
        reason: "owned",
      });
      expect(await lookup(key)).toEqual({ ok: true, owners: [{ kind: "run", runId: "retained" }] });
      expect(
        (await post("/runs/coordinator/units/list", { storeKey: key, instanceId: candidateInstance.id })).data.units,
      ).toEqual([]);
    },
  );
  it("revalidates unindexed sources and refuses incomplete candidate coverage", async () => {
    const key = storeKey();
    const original = await insertCandidate(key, "retained", 8);
    expect(await lookup(key)).toEqual({ ok: true, owners: [{ kind: "run", runId: "retained" }] });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(`DELETE FROM terminal_pull_owner_coverage WHERE run_id='retained'`);
      state.storage.sql.exec(`DELETE FROM terminal_pull_owner_targets WHERE run_id='retained'`);
    });
    expect(await lookup(key)).toEqual({ ok: true, owners: [{ kind: "run", runId: "retained" }] });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(`DELETE FROM terminal_pull_owner_targets WHERE run_id='retained'`);
      expect(
        JSON.parse(
          state.storage.sql
            .exec<{ summary_json: string }>(`SELECT summary_json FROM runs WHERE run_id='retained'`)
            .one().summary_json,
        ),
      ).toEqual(original);
    });
    expect(await lookup(key)).toEqual({ ok: false, reason: "incomplete" });
  });
  it.each(["publication", "door", "identity", "legacy", "json", "private"] as const)(
    "keeps retained foreign %s failures globally held after backfill",
    async (mode) => {
      const key = storeKey();
      await insertCandidate(key);
      expect(await lookup(key, { repo: "other/repo", pr: 8 })).toEqual({ ok: true, owners: [] });
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
        if (mode === "publication")
          state.storage.sql.exec(
            `UPDATE runs SET summary_json=json_set(summary_json,'$.branchPublication',json('{"version":9}'))`,
          );
        if (mode === "door")
          state.storage.sql.exec(
            `UPDATE runs SET summary_json=json_set(summary_json,'$.doorPublicationPending',json('{"private":"preserve"}'))`,
          );
        if (mode === "identity")
          state.storage.sql.exec(`UPDATE runs SET summary_json=json_set(summary_json,'$.threadKey','')`);
        if (mode === "legacy")
          state.storage.sql.exec(
            `UPDATE runs SET summary_json=json_set(summary_json,'$.branchPublication',json('{"version":1,"branches":[],"complete":false}'))`,
          );
        if (mode === "json") state.storage.sql.exec(`UPDATE runs SET summary_json='{'`);
        if (mode === "private")
          state.storage.sql.exec(`UPDATE runs SET work_evidence_json='{"version":9,"private":"preserve"}'`);
      });
      const before = await cells(key);
      expect(await lookup(key, { repo: "other/repo", pr: 8 })).toEqual({ ok: false, reason: "incomplete" });
      expect(await lookup(key, { repo: "other/repo", pr: 8 })).toEqual({ ok: false, reason: "incomplete" });
      expect(await cells(key)).toEqual(before);
    },
  );
  it("revalidates deletion and reinsertion of the same canonical run id", async () => {
    const key = storeKey();
    await insertCandidate(key);
    expect(await lookup(key)).toEqual({ ok: true, owners: [] });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(`DELETE FROM runs WHERE run_id='retained'`);
      expect(state.storage.sql.exec(`SELECT * FROM terminal_pull_owner_coverage`).toArray()).toEqual([]);
      expect(state.storage.sql.exec(`SELECT * FROM terminal_pull_owner_targets`).toArray()).toEqual([]);
    });
    expect(await lookup(key)).toEqual({ ok: true, owners: [] });
    await insertCandidate(key, "retained", 8);
    expect(await lookup(key)).toEqual({ ok: true, owners: [{ kind: "run", runId: "retained" }] });
  });
  it("sees a changed source after awaited input custody and before the admission transaction", async () => {
    const key = storeKey();
    await insertCandidate(key);
    expect(await lookup(key)).toEqual({ ok: true, owners: [] });
    await post("/runs/coordinator/put", { storeKey: key, instance: candidateInstance });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO, state) => {
      const internal = owner as unknown as {
        withRangePins: (holders: unknown, action: () => Promise<unknown>) => Promise<unknown>;
      };
      const pins = internal.withRangePins.bind(owner);
      internal.withRangePins = (holders, action) =>
        pins(holders, async () => {
          state.storage.sql.exec(
            `UPDATE runs SET summary_json=json_set(summary_json,'$.branchPublication',json(?)) WHERE run_id='retained'`,
            JSON.stringify(pending(8)),
          );
          return action();
        });
      try {
        expect(await owner.putUnits([candidateUnit], 100)).toEqual({ ok: false, reason: "owned" });
      } finally {
        internal.withRangePins = pins;
      }
      expect(state.storage.sql.exec(`SELECT * FROM coordinator_units`).toArray()).toEqual([]);
    });
  });
  it("rereads workspace and unit dependencies even when every terminal candidate is disjoint", async () => {
    const key = storeKey();
    await insertCandidate(key);
    expect(await lookup(key)).toEqual({ ok: true, owners: [] });
    const settlement = {
      version: 1,
      revision: 1,
      owner: { runId: "workspace", ownerGen: "g1", ownerFence: 7 },
      binding: null,
      record: {
        id: "workspace",
        threadKey: "slack:C1:workspace",
        status: "completed",
        userId: "slack:UALICE",
        repo: "acme/api",
      },
      publication: pending(8),
    };
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO workspace_settlements (owner_key,revision,json) VALUES (?,1,?)`,
        JSON.stringify(["workspace", "g1", 7]),
        JSON.stringify(settlement),
      );
    });
    expect(await lookup(key)).toEqual({ ok: true, owners: [{ kind: "run", runId: "workspace" }] });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(`UPDATE workspace_settlements SET json='{'`);
    });
    expect(await lookup(key)).toEqual({ ok: false, reason: "incomplete" });
  });

  it("rereads audit and settlement terminal dependencies even without ordinary candidate keys", async () => {
    const key = storeKey();
    await insertCandidate(key, "dependency");
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `UPDATE runs SET summary_json=json_set(summary_json,'$.branchPublication',json('{"version":1,"branches":[],"complete":true}'))`,
      );
    });
    expect(await lookup(key, { repo: "other/repo", pr: 8 })).toEqual({ ok: true, owners: [] });
    await post("/runs/coordinator/put", { storeKey: key, instance: candidateInstance });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO, state) => {
      const spawn = {
        version: 1,
        id: "UINDEX/0/coding",
        ordinal: 2,
        execution: { workflowId: candidateInstance.id },
        phase: "settled",
        target: { repo: candidateInstance.repo, ref: candidateUnit.branch, base: "main", headSha: "a".repeat(40) },
        calls: [{ operation: "spawn", state: "accepted", runId: "dependency" }],
      };
      const adopted = {
        ...candidateUnit,
        adoption: {
          version: 1,
          actionId: "audit-action",
          runId: "dependency",
          headSha: "b".repeat(40),
          requester: candidateInstance.userId,
          threadKey: candidateInstance.threadKey,
          messageId: "source",
          claimedAt: 3,
          state: "claimed",
          audit: {
            version: 1,
            firstHead: "a".repeat(40),
            head: "b".repeat(40),
            eventCount: 1,
            eventDigest: "c".repeat(64),
            spawn,
            projection: "{}",
          },
        },
      };
      state.storage.sql.exec(
        `INSERT INTO coordinator_units (instance_id,unit,json,updated_at) VALUES (?,?,?,3)`,
        candidateInstance.id,
        candidateUnit.unit,
        JSON.stringify(adopted),
      );
      const internal = owner as unknown as {
        terminalPullOwnershipRow: (row: { run_id: string }, diagnostics?: unknown) => unknown;
      };
      const decode = internal.terminalPullOwnershipRow.bind(owner);
      const seen: string[] = [];
      internal.terminalPullOwnershipRow = (row, diagnostics) => {
        seen.push(row.run_id);
        return decode(row, diagnostics);
      };
      try {
        expect(await owner.findPullOwners({ repo: "other/repo", pr: 8 })).toEqual({ ok: false, reason: "incomplete" });
        expect(seen).toEqual(["dependency"]);
        state.storage.sql.exec(`DELETE FROM coordinator_units`);
        state.storage.sql.exec(
          `INSERT INTO workspace_settlements (owner_key,revision,json) VALUES (?,1,?)`,
          JSON.stringify(["dependency", "g1", 7]),
          JSON.stringify({
            version: 1,
            revision: 1,
            owner: { runId: "dependency", ownerGen: "g1", ownerFence: 7 },
            binding: null,
            record: {
              id: "dependency",
              threadKey: "slack:C1:dependency",
              status: "completed",
              userId: "slack:UALICE",
              repo: "acme/api",
            },
            publication: pending(8),
          }),
        );
        seen.length = 0;
        expect(await owner.findPullOwners({ repo: "other/repo", pr: 8 })).toEqual({ ok: true, owners: [] });
        expect(seen).toEqual(["dependency"]);
      } finally {
        internal.terminalPullOwnershipRow = decode;
      }
    });
  });

  it("queries normalized keys for branch and cross-repository Door custody", async () => {
    const key = storeKey();
    await insertCandidate(key);
    expect(await lookup(key, { repo: "ACME/API", ref: "refs/heads/fix/held" })).toEqual({
      ok: true,
      owners: [{ kind: "run", runId: "retained" }],
    });
    const door = {
      id: "held-door",
      repo: "other/repo",
      pr: 12,
      update: { ref: "refs/heads/fix/door", old: "a".repeat(40), next: "b".repeat(40) },
    };
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `UPDATE runs SET summary_json=json_set(summary_json,'$.doorPublicationPending',json(?))`,
        JSON.stringify(door),
      );
    });
    expect(await lookup(key, { repo: "OTHER/REPO", ref: "fix/door" })).toEqual({
      ok: true,
      owners: [{ kind: "run", runId: "retained" }],
    });
    const before = await indexCells(key);
    expect(await lookup(key, { repo: "OTHER/REPO", pr: 12 })).toEqual({
      ok: true,
      owners: [{ kind: "run", runId: "retained" }],
    });
    expect(await indexCells(key)).toEqual(before);
  });

  it("rebuilds a missing or older projection version from canonical source within the same bounds", async () => {
    const key = storeKey();
    await insertCandidate(key, "retained", 8);
    expect(await lookup(key)).toEqual({ ok: true, owners: [{ kind: "run", runId: "retained" }] });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(`UPDATE meta SET value='unsupported' WHERE key='terminal_pull_owner_index_version'`);
      state.storage.sql.exec(`DELETE FROM terminal_pull_owner_targets`);
    });
    expect(await lookup(key)).toEqual({ ok: true, owners: [{ kind: "run", runId: "retained" }] });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      expect(
        state.storage.sql
          .exec<{ value: string }>(`SELECT value FROM meta WHERE key='terminal_pull_owner_index_version'`)
          .one().value,
      ).toBe("1");
    });
  });

  it("refuses same-cardinality derived key drift before a false negative can admit a unit", async () => {
    const key = storeKey();
    await insertCandidate(key, "retained", 8);
    expect(await lookup(key)).toEqual({ ok: true, owners: [{ kind: "run", runId: "retained" }] });
    const original = await cells(key);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(`UPDATE terminal_pull_owner_targets SET repo='other/repo' WHERE run_id='retained'`);
      expect(
        state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM terminal_pull_owner_targets`).one().n,
      ).toBe(1);
      expect(
        state.storage.sql.exec<{ target_count: number }>(`SELECT target_count FROM terminal_pull_owner_coverage`).one()
          .target_count,
      ).toBe(1);
    });
    expect(await lookup(key)).toEqual({ ok: false, reason: "incomplete" });
    expect(await cells(key)).toEqual(original);
    expect(await lookup(key)).toEqual({ ok: true, owners: [{ kind: "run", runId: "retained" }] });
  });
  async function indexCells(key: string) {
    return runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => ({
      coverage: state.storage.sql.exec(`SELECT * FROM terminal_pull_owner_coverage ORDER BY run_id`).toArray(),
      targets: state.storage.sql
        .exec(`SELECT * FROM terminal_pull_owner_targets ORDER BY run_id,repo,pr,ref`)
        .toArray(),
    }));
  }
  async function cells(key: string) {
    return runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => ({
      runs: state.storage.sql.exec(`SELECT run_id,summary_json,work_evidence_json FROM runs`).toArray(),
      units: state.storage.sql.exec(`SELECT * FROM coordinator_units`).toArray(),
      settlements: state.storage.sql.exec(`SELECT * FROM workspace_settlements`).toArray(),
    }));
  }
});

describe("private initial publication owner qualification in SQLite", () => {
  const target = { repo: "acme/api", pr: 7 };
  const originalInstance: CoordinatorInstance = {
    id: "original_owner",
    kind: "ship",
    userId: "slack:UALICE",
    channelId: "slack:C1",
    threadKey: "slack:C1:original",
    repo: "acme/api",
    branch: "fix/original",
    base: "main",
    createdAt: 1,
  };
  const originalUnit: CoordinatorUnit = {
    instanceId: originalInstance.id,
    unit: "UOWNER",
    slug: "original",
    branch: originalInstance.branch,
    dependsOn: [],
    rounds: [],
  };
  async function seedQualification(withUnit = false) {
    const key = storeKey(),
      id = "original_coding";
    const value = {
      ...record(id, originalInstance.threadKey),
      agent: "coding",
      eventCount: 0,
      storedEventCount: 0,
      events: [],
      repo: target.repo,
      ...(withUnit
        ? {
            parentInstanceId: originalInstance.id,
            coordinatorUnit: originalUnit.unit,
            coordinatorAttempt: 0,
            idempotencyKey: `${originalInstance.id}:${originalUnit.unit}/0/coding`,
          }
        : {}),
      branchPublication: { version: 1, repo: target.repo, branches: [], complete: false },
    };
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO runs (run_id, channel_id, user_id, thread_key, started_at, finished_at, stored_at,
        status, event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json)
        VALUES (?, 'slack:C1', 'slack:UALICE', ?, 1, 2, 2, 'completed', 0, 0, 0, ?, '{}', ?)`,
        id,
        value.threadKey,
        JSON.stringify(value).length,
        JSON.stringify(value),
      );
      if (withUnit) {
        state.storage.sql.exec(
          `INSERT INTO coordinator_instances(instance_id,json,created_at) VALUES (?,?,1)`,
          originalInstance.id,
          JSON.stringify(originalInstance),
        );
        state.storage.sql.exec(
          `INSERT INTO coordinator_units(instance_id,unit,json,updated_at) VALUES (?,?,?,1)`,
          originalInstance.id,
          originalUnit.unit,
          JSON.stringify(originalUnit),
        );
      }
    });
    return { key, id, value };
  }
  it("locates one exact failed canonical run through the existing authenticated read while preserving ownership refusal", async () => {
    const key = storeKey(),
      id = "original_coding";
    const value = {
      ...record(id, "slack:C1:original"),
      agent: "coding",
      eventCount: 0,
      storedEventCount: 0,
      events: [],
      repo: "acme/api",
      branchPublication: { version: 1, repo: "acme/api", branches: [], complete: false },
    };
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO runs (run_id, channel_id, user_id, thread_key, started_at, finished_at, stored_at,
        status, event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json)
        VALUES (?, 'slack:C1', 'slack:UALICE', ?, 1, 2, 2, 'completed', 0, 0, 0, ?, '{}', ?)`,
        id,
        value.threadKey,
        JSON.stringify(value).length,
        JSON.stringify(value),
      );
    });
    const result = (
      await post("/runs/coordinator/pull-owners", {
        storeKey: key,
        target: { repo: "acme/api", pr: 7 },
        diagnostic: true,
        qualifyRecord: true,
      })
    ).data;
    expect(result).toMatchObject({
      ok: false,
      reason: "incomplete",
      qualification: {
        version: 1,
        runId: id,
        failedPredicate: "canonical_unit",
        targetDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        ownerProjectionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        dependencyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(
      (await post("/runs/coordinator/pull-owners", { storeKey: key, target: { repo: "acme/api", pr: 7 } })).data,
    ).toEqual({ ok: false, reason: "incomplete" });
    const read = (await post("/runs/get", { storeKey: key, id })).data.record as RunRecord;
    const reconstructed = await qualifyPullOwnerSnapshot(
      pullOwnerQualificationSnapshot(
        { repo: "acme/api", pr: 7 },
        {
          runId: id,
          repo: read.repo,
          live: false,
          record: read,
          publication: read.branchPublication,
          pushReceipts: read.branchPushReceipts,
          door: read.doorPublicationPending,
        },
        [],
        "canonical_unit",
      )!,
    );
    expect(result.qualification).toEqual(reconstructed);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      expect(
        state.storage.sql.exec<{ summary_json: string }>(`SELECT summary_json FROM runs WHERE run_id=?`, id).one()
          .summary_json,
      ).toBe(JSON.stringify(value));
    });
  });
  it("keeps anonymous/default decisions and original source bytes exact; only explicit qualification emits the key", async () => {
    const { key, value } = await seedQualification();
    const anonymous = (await post("/runs/coordinator/pull-owners", { storeKey: key, target, diagnostic: true })).data;
    expect(anonymous).not.toHaveProperty("qualification");
    expect(JSON.stringify(anonymous)).not.toMatch(/original_coding|slack:|acme\/|fix\//);
    const qualified = (
      await post("/runs/coordinator/pull-owners", { storeKey: key, target, diagnostic: true, qualifyRecord: true })
    ).data;
    const { qualification, ...normal } = qualified;
    expect(normal.ok).toBe(anonymous.ok);
    expect(normal.reason).toBe(anonymous.reason);
    expect(normal.diagnostic).toMatchObject({ stage: "run_initial_coding_owner", cause: "validation", source: "runs" });
    expect(Object.keys(qualification as object).sort()).toEqual([
      "dependencyDigest",
      "failedPredicate",
      "ownerProjectionDigest",
      "runId",
      "targetDigest",
      "version",
    ]);
    expect(JSON.stringify(qualification)).not.toMatch(/slack:|acme\/|fix\/|userId|threadKey|branch/);
    const after = (await post("/runs/get", { storeKey: key, id: value.id })).data.record as RunRecord;
    expect(after.branchPublication).toEqual(value.branchPublication);
  });
  it("captures the owner and canonical dependency before asynchronous hashing and makes later changes detectable", async () => {
    const { key, id, value } = await seedQualification(true);
    const expected = await qualifyPullOwnerSnapshot(
      pullOwnerQualificationSnapshot(
        target,
        {
          runId: id,
          repo: value.repo,
          live: false,
          record: value,
          publication: value.branchPublication,
        },
        [{ instance: originalInstance, unit: originalUnit }],
        "native_confirmation",
      )!,
    );
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO, state) => {
      const pending = owner.findPullOwners(target, true, true);
      state.storage.sql.exec(
        `UPDATE runs SET summary_json=json_set(summary_json,'$.threadKey','slack:C1:changed') WHERE run_id=?`,
        id,
      );
      state.storage.sql.exec(`UPDATE coordinator_instances SET json=json_set(json,'$.userName','changed')`);
      const result = await pending;
      expect(result).toMatchObject({ ok: false, reason: "incomplete", qualification: expected });
      const later = await owner.findPullOwners(target, true, true);
      expect(later.ok).toBe(false);
      if (!later.ok) {
        expect(later.qualification!.ownerProjectionDigest).not.toBe(expected.ownerProjectionDigest);
        expect(later.qualification!.dependencyDigest).not.toBe(expected.dependencyDigest);
      }
      expect(state.storage.sql.exec(`SELECT * FROM coordinator_unit_events`).toArray()).toEqual([]);
    });
  });
  it("requires existing authentication and exact boolean opt-in without changing invalid/success or legacy failure decisions", async () => {
    const { key } = await seedQualification();
    for (const flags of [{ qualifyRecord: true }, { diagnostic: true, qualifyRecord: "yes" }])
      expect((await post("/runs/coordinator/pull-owners", { storeKey: key, target, ...flags })).status).toBe(400);
    const denied = await fetchMemoryTest(`${BASE}/runs/coordinator/pull-owners`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-fixture", "content-type": "application/json" },
      body: JSON.stringify({ storeKey: key, target, diagnostic: true, qualifyRecord: true }),
    });
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain("original_coding");
    expect(
      (
        await post("/runs/coordinator/pull-owners", {
          storeKey: storeKey(),
          target,
          diagnostic: true,
          qualifyRecord: true,
        })
      ).data,
    ).toEqual({ ok: true, owners: [] });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(`UPDATE runs SET summary_json='{'`);
    });
    const unreadable = (
      await post("/runs/coordinator/pull-owners", { storeKey: key, target, diagnostic: true, qualifyRecord: true })
    ).data;
    expect(unreadable.ok).toBe(false);
    expect(unreadable.reason).toBe("incomplete");
    expect(unreadable).not.toHaveProperty("qualification");
  });
});

describe("read-only pull-owner scan diagnostics", () => {
  it("reports an unreadable global producer before target matching without changing raw state", async () => {
    const key = storeKey(),
      id = "diagnostic_foreign_private";
    await post("/runs/claim", claimBody(key, id, "slack:C1:diagnostic"));
    const raw = '{"private":"DO_NOT_ECHO_DIAGNOSTIC_BODY"';
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(`UPDATE live_runs SET meta_json = ? WHERE run_id = ?`, raw, id);
    });
    const request = { storeKey: key, target: { repo: "other/repo", pr: 7 } };
    expect((await post("/runs/coordinator/pull-owners", request)).data).toEqual({ ok: false, reason: "incomplete" });
    const result = (await post("/runs/coordinator/pull-owners", { ...request, diagnostic: true })).data;
    expect(result).toMatchObject({
      ok: false,
      reason: "incomplete",
      diagnostic: {
        version: 1,
        stage: "inventory_live_producer",
        source: "live_runs",
        rowIndex: 0,
        rowsRead: 1,
        sourceBytes: expect.any(Number),
        cause: "json",
      },
    });
    expect(JSON.stringify(result)).not.toContain(id);
    expect(JSON.stringify(result)).not.toContain("DO_NOT_ECHO");
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      expect(
        state.storage.sql.exec<{ meta_json: string }>(`SELECT meta_json FROM live_runs WHERE run_id = ?`, id).one()
          .meta_json,
      ).toBe(raw);
    });
  });
  it("reports a byte limit with existing estimate and unchanged incomplete authority", async () => {
    const key = storeKey();
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      for (let i = 0; i < 4; i++) {
        const row = {
          ...record(`diag_large_${i}`, `slack:C1:diag-large-${i}`),
          repo: "acme/api",
          branchPublication: {
            version: 1,
            repo: "acme/api",
            branches: [],
            complete: false,
            pending: { id: "x".repeat(Math.floor(1.4 * 1024 * 1024)), pr: 7, headSha: "a".repeat(40) },
          },
        };
        state.storage.sql.exec(
          `INSERT INTO runs (run_id, channel_id, user_id, thread_key, started_at, finished_at, stored_at, status, event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json) VALUES (?, 'slack:C1', 'slack:UALICE', ?, 1, 2, 2, 'completed', 0, 0, 0, ?, '{}', ?)`,
          row.id,
          row.threadKey,
          JSON.stringify(row).length,
          JSON.stringify(row),
        );
      }
    });
    const result = (
      await post("/runs/coordinator/pull-owners", {
        storeKey: key,
        target: { repo: "acme/api", pr: 7 },
        diagnostic: true,
      })
    ).data;
    expect(result).toMatchObject({
      ok: false,
      reason: "incomplete",
      diagnostic: {
        version: 1,
        stage: "inventory_byte_limit",
        source: "runs",
        rowIndex: 3,
        rowsRead: 4,
        cause: "byte-limit",
      },
    });
    expect((result.diagnostic as { sourceBytes: number }).sourceBytes).toBeGreaterThan(16 * 1024 * 1024);
  });
  it("reports a row limit without widening the scan or mutating effect rows", async () => {
    const key = storeKey();
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<32768) INSERT INTO plane_effects (id, body_json, offered_at) SELECT 'diag-' || i, 'null', 1 FROM n`,
      );
    });
    const result = (
      await post("/runs/coordinator/pull-owners", {
        storeKey: key,
        target: { repo: "acme/api", pr: 7 },
        diagnostic: true,
      })
    ).data;
    expect(result).toMatchObject({
      ok: false,
      reason: "incomplete",
      diagnostic: {
        version: 1,
        stage: "inventory_row_limit",
        source: "effects",
        rowIndex: 32768,
        rowsRead: 32769,
        cause: "row-limit",
      },
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      expect(state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM plane_effects`).one().n).toBe(32769);
    });
  });
  it("requires the existing bearer and leaves successful/default reads unchanged", async () => {
    const key = storeKey(),
      request = { storeKey: key, target: { repo: "acme/api", pr: 7 }, diagnostic: true };
    expect((await post("/runs/coordinator/pull-owners", request, {})).status).toBe(401);
    expect((await post("/runs/coordinator/pull-owners", request)).data).toEqual({ ok: true, owners: [] });
  });
});

describe("pull-owner diagnostic validation and read stages", () => {
  it("distinguishes typed validation from JSON inventory failures", async () => {
    const key = storeKey(),
      id = "diagnostic_validation";
    await post("/runs/put", {
      storeKey: key,
      record: { ...record(id, "slack:C1:diagnostic-validation"), repo: "acme/api" },
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      const row = {
        ...record(id, "slack:C1:diagnostic-validation"),
        repo: "acme/api",
        branchPublication: { version: 2 },
      };
      state.storage.sql.exec(`UPDATE runs SET summary_json = ? WHERE run_id = ?`, JSON.stringify(row), id);
    });
    const result = (
      await post("/runs/coordinator/pull-owners", {
        storeKey: key,
        target: { repo: "other/repo", pr: 7 },
        diagnostic: true,
      })
    ).data;
    expect(result).toMatchObject({
      ok: false,
      reason: "incomplete",
      diagnostic: { stage: "run_publication", cause: "validation", source: "runs", rowIndex: 0, rowsRead: 1 },
    });
    expect(JSON.stringify(result)).not.toContain(id);
  });
  it("marks a storage-read failure at its current source without copying the exception", async () => {
    const key = storeKey();
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (owner: RunHistoryDO, state) => {
      state.storage.sql.exec(`DROP TABLE coordinator_units`);
      expect(await owner.findPullOwners({ repo: "acme/api", pr: 7 }, true)).toEqual({
        ok: false,
        reason: "incomplete",
        diagnostic: {
          version: 1,
          stage: "ownership_scan",
          cause: "read",
          source: "units",
          rowsRead: 0,
          sourceBytes: 0,
        },
      });
    });
  });
});

describe("pull-owner source-local diagnostic provenance", () => {
  const faults = [
    ["publication", "run_publication", { branchPublication: { version: 2, privateText: "secret-fixture" } }],
    ["door", "run_door", { doorPublicationPending: { privateText: "secret-fixture" } }],
    [
      "initial owner",
      "run_initial_coding_owner",
      { branchPublication: { version: 1, repo: "acme/api", branches: [], complete: false } },
    ],
  ] as const;
  async function healthyLives(key: string, count: number) {
    for (let i = 0; i < count; i++)
      expect(
        (await post("/runs/claim", claimBody(key, "provenance-live-" + i, "slack:C1:provenance:" + i))).data,
      ).toMatchObject({ ok: true });
  }
  async function cells(key: string) {
    return runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => ({
      live: state.storage.sql.exec("SELECT * FROM live_runs").toArray(),
      terminal: state.storage.sql.exec("SELECT * FROM runs").toArray(),
    }));
  }
  async function read(key: string, diagnostic = true) {
    return (
      await post("/runs/coordinator/pull-owners", {
        storeKey: key,
        target: { repo: "acme/api", pr: 7 },
        ...(diagnostic ? { diagnostic: true } : {}),
      })
    ).data;
  }
  it.each(faults)("retains the live source and actual local ordinal for %s validation", async (_name, stage, fault) => {
    const key = storeKey();
    await healthyLives(key, 2);
    const id = "provenance-bad-live";
    await post("/runs/claim", claimBody(key, id, "slack:C1:provenance:bad"));
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec("UPDATE live_runs SET state_json=? WHERE run_id=?", JSON.stringify(fault), id);
    });
    const before = await cells(key);
    const result = await read(key);
    expect(result).toMatchObject({
      ok: false,
      reason: "incomplete",
      diagnostic: { stage, source: "live_runs", rowIndex: 2, cause: "validation" },
    });
    expect(await cells(key)).toEqual(before);
    expect(JSON.stringify(result)).not.toMatch(/secret-fixture|provenance-bad-live|state_json|privateText/);
  });
  it("reports a live empty identity at its actual local ordinal without changing unreadable rows", async () => {
    const key = storeKey();
    await healthyLives(key, 2);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec("UPDATE live_runs SET run_id='' WHERE run_id=?", "provenance-live-1");
    });
    const before = await cells(key);
    expect(await read(key)).toMatchObject({
      ok: false,
      reason: "incomplete",
      diagnostic: { stage: "run_shape", source: "live_runs", rowIndex: 1, cause: "validation" },
    });
    expect(await cells(key)).toEqual(before);
  });
  it.each(faults)(
    "retains terminal ordinal zero after two healthy live rows for %s validation",
    async (_name, stage, fault) => {
      const key = storeKey();
      await healthyLives(key, 2);
      const id = "provenance-bad-terminal";
      await post("/runs/put", {
        storeKey: key,
        record: { ...record(id, "slack:C1:provenance:terminal"), repo: "acme/api" },
      });
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
        const current = state.storage.sql
          .exec<{ summary_json: string }>("SELECT summary_json FROM runs WHERE run_id=?", id)
          .one();
        state.storage.sql.exec(
          "UPDATE runs SET summary_json=? WHERE run_id=?",
          JSON.stringify({ ...JSON.parse(current.summary_json), ...fault }),
          id,
        );
      });
      const before = await cells(key);
      expect(await read(key)).toMatchObject({
        ok: false,
        reason: "incomplete",
        diagnostic: { stage, source: "runs", rowIndex: 0, cause: "validation" },
      });
      expect(await cells(key)).toEqual(before);
    },
  );
  it("preserves terminal-local positions with no live inventory", async () => {
    const key = storeKey(),
      id = "provenance-terminal-only";
    await post("/runs/put", { storeKey: key, record: { ...record(id, "slack:C1:provenance:only"), repo: "acme/api" } });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      const current = state.storage.sql
        .exec<{ summary_json: string }>("SELECT summary_json FROM runs WHERE run_id=?", id)
        .one();
      state.storage.sql.exec(
        "UPDATE runs SET summary_json=? WHERE run_id=?",
        JSON.stringify({ ...JSON.parse(current.summary_json), branchPublication: { version: 2 } }),
        id,
      );
    });
    expect(await read(key)).toMatchObject({
      ok: false,
      reason: "incomplete",
      diagnostic: { stage: "run_publication", source: "runs", rowIndex: 0 },
    });
  });
  it.each(["json", "live shape", "terminal shape"])(
    "preserves existing physical %s failures before merged validation",
    async (fault) => {
      const key = storeKey();
      await healthyLives(key, 2);
      await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
        if (fault === "json")
          state.storage.sql.exec("UPDATE live_runs SET state_json='{' WHERE run_id=?", "provenance-live-1");
        if (fault === "live shape")
          state.storage.sql.exec("UPDATE live_runs SET meta_json='{}' WHERE run_id=?", "provenance-live-1");
      });
      if (fault === "terminal shape") {
        const id = "provenance-unreadable-terminal";
        await post("/runs/put", {
          storeKey: key,
          record: { ...record(id, "slack:C1:provenance:unreadable"), repo: "acme/api" },
        });
        await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
          state.storage.sql.exec("UPDATE runs SET summary_json='null' WHERE run_id=?", id);
        });
      }
      const before = await cells(key);
      expect(await read(key)).toMatchObject({
        ok: false,
        reason: "incomplete",
        diagnostic: {
          stage: fault === "terminal shape" ? "inventory_terminal_producer" : "inventory_live_producer",
          source: fault === "terminal shape" ? "runs" : "live_runs",
          rowIndex: fault === "terminal shape" ? 0 : 1,
          cause: fault === "json" ? "json" : "shape",
        },
      });
      expect(await cells(key)).toEqual(before);
    },
  );
  it("omits diagnostics on default incomplete reads", async () => {
    const key = storeKey();
    await healthyLives(key, 1);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec("UPDATE live_runs SET state_json=?", '{"branchPublication":{"version":2}}');
    });
    expect(await read(key, false)).toEqual({ ok: false, reason: "incomplete" });
  });
  it("preserves successful owners and omits diagnostics when opted in", async () => {
    const key = storeKey();
    await healthyLives(key, 1);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_owner: RunHistoryDO, state) => {
      state.storage.sql.exec(
        "UPDATE live_runs SET state_json=?",
        JSON.stringify({
          branchPublication: {
            version: 1,
            repo: "acme/api",
            branches: [{ ref: "fix/provenance", sha: "a".repeat(40), pr: 7 }],
            complete: true as const,
          },
        }),
      );
    });
    expect(await read(key)).toEqual({ ok: true, owners: [{ kind: "run", runId: "provenance-live-0" }] });
  });
});

describe("original policy owning SQLite state transaction", () => {
  it.each([
    "omitted-harness",
    "omitted-policy",
    "changed",
    "invalid",
    "legacy-backfill",
    "lifecycle",
    "first-launch",
    "legacy-absence",
  ])("preserves admitted policy through actual HTTP state: %s", async (mode) => {
    const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      sk = "runs:session-policy:" + crypto.randomUUID();
    const client = new WorkerRunLedger({
      baseUrl: BASE,
      token: "test-token",
      storeKey: sk,
      fetch: (url, init) => fetchMemoryTest(String(url), init),
    });
    const policy = { version: 1, commandRoute: "hosted-review", identity: "read" };
    const facts = {
      harness: "pi",
      pid: 42,
      processBirth: "original",
      root: "/workspace/original",
      bearerHash: "a".repeat(64),
      sessionFile: "/workspace/original/session.jsonl",
      wire: "openai-responses",
      logOffset: 0,
      sessionPolicy: policy,
    };
    const { sessionPolicy: _, ...legacy } = facts;
    const initial = mode === "first-launch" ? {} : { harness: mode.startsWith("legacy") ? legacy : facts };
    expect(
      await client.claim({
        runId: id,
        threadKey: "mcp:fixture:policy",
        gen: "g1",
        startedAt: 1,
        leaseMs: 10000,
        system: "original",
        tools: [],
        meta: {
          channelId: "mcp:fixture",
          threadKey: "mcp:fixture:policy",
          userId: "slack:fixture",
          profile: { machine: "repo-resident", identity: "read", minutes: 25 },
        },
        state: initial,
      }),
    ).toMatchObject({ ok: true });
    const before = await client.peekInbox(id, "g1", 0);
    expect(before.ok).toBe(true);
    const incoming =
      mode === "omitted-harness"
        ? { verdict: "later" }
        : mode === "omitted-policy"
          ? { harness: { ...legacy, logOffset: 12 } }
          : mode === "changed"
            ? { harness: { ...facts, sessionPolicy: { version: 1, commandRoute: "native", identity: "read" } } }
            : mode === "invalid"
              ? { harness: { ...facts, sessionPolicy: { ...policy, extra: true } } }
              : mode === "legacy-absence"
                ? { harness: { ...legacy, logOffset: 12 } }
                : { harness: { ...facts, logOffset: 12 } };
    const result = await client.setState(id, "g1", incoming);
    const after = await client.peekInbox(id, "g1", 0);
    expect(after.ok).toBe(true);
    if (["changed", "invalid", "legacy-backfill"].includes(mode)) {
      expect(result).toEqual({ ok: false, reason: "fenced" });
      expect(after).toEqual(before);
    } else {
      expect(result).toEqual({ ok: true });
      if (after.ok && mode !== "legacy-absence")
        expect(after.boundary.state).toHaveProperty("harness.sessionPolicy", policy);
    }
    expect(await client.setState(id, "foreign", incoming)).toEqual({ ok: false, reason: "fenced" });
    expect(await client.peekInbox(id, "g1", 0)).toEqual(after);
  });
});

import { preserveHarnessPolicy } from "../../src/core/runLedger/checkpointState.ts";
it("matches omitted-policy caller bytes to actual SQLite readback after accepted HTTP reply loss", async () => {
  const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    sk = "runs:session-policy:" + crypto.randomUUID();
  let writes = 0;
  const ordinary = (url: RequestInfo | URL, init?: RequestInit) => fetchMemoryTest(String(url), init);
  const client = new WorkerRunLedger({ baseUrl: BASE, token: "test-token", storeKey: sk, fetch: ordinary });
  const policy = { version: 1, commandRoute: "hosted-review", identity: "read" };
  const facts = {
    harness: "pi",
    pid: 42,
    processBirth: "original",
    root: "/workspace/original",
    bearerHash: "a".repeat(64),
    sessionFile: "/workspace/original/session.jsonl",
    wire: "openai-responses",
    logOffset: 0,
    sessionPolicy: policy,
  };
  expect(
    await client.claim({
      runId: id,
      threadKey: "mcp:fixture:policy",
      gen: "g1",
      startedAt: 1,
      leaseMs: 10000,
      system: "original",
      tools: [],
      meta: { channelId: "mcp:fixture", threadKey: "mcp:fixture:policy", userId: "slack:fixture" },
      state: { harness: facts, original: "retained" },
    }),
  ).toMatchObject({ ok: true });
  const before = await client.peekInbox(id, "g1", 0);
  if (!before.ok) throw new Error("owner missing");
  const { sessionPolicy: _, ...legacy } = facts;
  const expected = preserveHarnessPolicy(before.boundary.state as Record<string, unknown>, {
    ...(before.boundary.state as Record<string, unknown>),
    harness: { ...legacy, logOffset: 12 },
  })!;
  const saved = structuredClone(expected);
  const lost = new WorkerRunLedger({
    baseUrl: BASE,
    token: "test-token",
    storeKey: sk,
    fetch: async (url, init) => {
      expect(new URL(String(url)).pathname).toBe("/runs/state");
      writes++;
      const response = await ordinary(url, init);
      expect(response.status).toBe(200);
      await response.text();
      throw new Error("accepted reply lost");
    },
  });
  let witness: unknown;
  try {
    await lost.setState(id, "g1", expected);
    throw new Error("reply was not lost");
  } catch (error) {
    expect(error).toMatchObject({ name: "UncertainStoreError" });
    witness = (error as { request: unknown }).request;
  }
  const actual = await client.peekInbox(id, "g1", 0);
  if (!actual.ok) throw new Error("owner missing");
  expect(await sourceHash(actual.boundary.state)).toBe(await sourceHash(expected));
  expect(actual.boundary.state).toEqual(JSON.parse((witness as { payload: string }).payload).state);
  expect(expected).toEqual(saved);
  expect(writes).toBe(1);
});

it("keeps one rejected archive from resetting unrelated live ownership", async () => {
  const key = "runs:archive-reset-domain:" + crypto.randomUUID();
  const stub = env.RUNS.get(env.RUNS.idFromName(key));
  const thread = "http:fixture:archive";
  expect((await post("/runs/claim", claimBody(key, "archive-source", thread))).status).toBe(200);
  expect((await post("/runs/claim", claimBody(key, "policy-sibling", "http:fixture:policy"))).status).toBe(200);
  await runInDurableObject(stub, async (instance, state) => {
    (instance as unknown as { fixtureIdentity?: string }).fixtureIdentity = "same-object";
    state.storage.sql.exec(
      "UPDATE live_runs SET state_json=? WHERE run_id=?",
      JSON.stringify({ unitSeedReceipt: { version: 1 } }),
      "archive-source",
    );
  });
  const refusal = await runInDurableObject(stub, async (instance) => {
    try {
      await instance.put(record("archive-source", thread));
      return { accepted: true };
    } catch (error) {
      return { accepted: false, message: error instanceof Error ? error.message : "unknown" };
    }
  });
  expect(refusal).toEqual({ accepted: false, message: "work evidence does not match its canonical run" });
  const fresh = env.RUNS.get(env.RUNS.idFromName(key));
  const observed = await runInDurableObject(fresh, async (instance) => ({
    identity: (instance as unknown as { fixtureIdentity?: string }).fixtureIdentity,
    live: (await instance.listLive()).map((row) => ({ id: row.runId, gen: row.ownerGen })),
  }));
  expect(observed.live).toContainEqual({ id: "policy-sibling", gen: "g1" });
  expect(observed.identity).toBe("same-object");
  const policy = {
    harness: {
      harness: "pi",
      pid: 2,
      logOffset: 0,
      sessionPolicy: { version: 1, commandRoute: "native", identity: "none" },
    },
  };
  expect(await post("/runs/state", { storeKey: key, runId: "policy-sibling", gen: "g1", state: policy })).toMatchObject(
    { status: 200, data: { ok: true } },
  );
  const stored = await runInDurableObject(fresh, async (_instance, state) => ({
    corrupt: state.storage.sql
      .exec<{ state_json: string }>("SELECT state_json FROM live_runs WHERE run_id=?", "archive-source")
      .one().state_json,
    archived: state.storage.sql.exec("SELECT run_id FROM runs WHERE run_id=?", "archive-source").toArray(),
  }));
  expect(JSON.parse(stored.corrupt)).toEqual({ unitSeedReceipt: { version: 1 } });
  expect(stored.archived).toEqual([]);
});

describe("state-write holds across Durable Object RPC", () => {
  const id = "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee",
    gen = "g-rpc";
  const claim = () => ({
    runId: id,
    threadKey: "http:fixture:rpc-state",
    gen,
    leaseMs: 30000,
    startedAt: 1,
    phase: "attaching" as const,
    system: "fixture system",
    tools: [],
    meta: {
      agent: "general",
      channelId: "http:fixture",
      userId: "http:fixture",
      threadKey: "http:fixture:rpc-state",
      profile: { machine: "none" as const, identity: "none" as const, minutes: 4 },
    },
  });
  const state = {
    harness: {
      harness: "pi",
      pid: 4242,
      logOffset: 0,
      sessionPolicy: { version: 1, commandRoute: "native", identity: "none" },
    },
  };
  const request = (key: string) => {
    const body = JSON.stringify({ storeKey: key, runId: id, gen, state });
    return new Request("https://memory.test/runs/state", {
      method: "POST",
      body,
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(body).length),
      },
    });
  };
  function routedEnv(stub: ReturnType<typeof env.RUNS.get>, override: (name: PropertyKey) => unknown) {
    const wrapped = new Proxy(stub, {
      get(target, name) {
        const replacement = override(name);
        if (replacement !== undefined) return replacement;
        const value = Reflect.get(target, name, target);
        // RpcCallable does not have Function.bind: accessing it invokes a remote
        // method named bind. Reflect.apply preserves the actual stub invocation.
        return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
      },
    });
    const namespace = new Proxy(env.RUNS, {
      get(target, name) {
        if (name === "get") return () => wrapped;
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
      },
    });
    return new Proxy(env, {
      get(target, name) {
        return name === "RUNS" ? namespace : Reflect.get(target, name, target);
      },
    });
  }
  it.each(["promotion-preflight", "state-rpc-before", "state-rpc-after", "acknowledgment"] as const)(
    "binds bounded %s failure facts to the exact wire request without acknowledging or replaying state",
    async (stage) => {
      const key = "runs:state-failure:" + stage,
        stub = env.RUNS.get(env.RUNS.idFromName(key));
      expect((await stub.claim(claim(), 1)).ok).toBe(true);
      let calls = 0;
      const routed = routedEnv(stub, (name) => {
        if (
          (stage === "promotion-preflight" && name === "promotionHold") ||
          (stage !== "promotion-preflight" && name === "setState")
        )
          return async (...args: unknown[]) => {
            calls++;
            if (stage === "state-rpc-after")
              expect(await Reflect.apply(stub.setState, stub, args)).toEqual({ ok: true });
            if (stage === "acknowledgment") return { ok: true, privateCause: "private reply bytes" };
            throw new TypeError("private request and exception bytes");
          };
        return undefined;
      });
      const wire = (await request(key).text()) + " \n";
      const digest = (await storeRequestWitness("/runs/state", wire)).digest;
      const logs: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((line) => logs.push(String(line)));
      let response: Response;
      try {
        response = await memoryWorker.fetch(
          new Request(request(key).url, {
            method: "POST",
            body: wire,
            headers: {
              ...Object.fromEntries(request(key).headers),
              "content-length": String(new TextEncoder().encode(wire).length),
            },
          }),
          routed,
        );
      } finally {
        log.mockRestore();
      }
      expect(response.status).toBe(500);
      const diagnosis = JSON.parse(response.headers.get(STATE_WRITE_DIAGNOSTIC_HEADER)!);
      expect(diagnosis).toEqual({
        version: 1,
        requestDigest: digest,
        failure:
          stage === "acknowledgment"
            ? { stage, replyShape: "ok" }
            : {
                stage: stage === "promotion-preflight" ? stage : "state-rpc",
                errorKind: "type",
              },
      });
      const body = await response.text();
      expect(body).not.toContain("private");
      expect(JSON.stringify(diagnosis)).not.toContain("private");
      expect(calls).toBe(1);
      const trace = logs
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((value) => value?.span === "state.fetch");
      expect(trace).toMatchObject({
        status: "error",
        attrs: {
          httpStatus: 500,
          requestDigest: digest,
          stateWriteStage: stage === "promotion-preflight" || stage === "acknowledgment" ? stage : "state-rpc",
        },
      });
      expect(trace.errorMessage).toBe(
        stage === "acknowledgment"
          ? "run state RPC returned an invalid acknowledgement"
          : "private request and exception bytes",
      );
      const current = (await stub.listLive())[0];
      expect(current.ownerGen).toBe(gen);
      if (stage === "state-rpc-after")
        expect(current.state).toHaveProperty("harness.sessionPolicy", state.harness.sessionPolicy);
      else expect(current.state).not.toHaveProperty("harness");
    },
  );
  it("returns the existing held response when preparation arrives after the actual RPC preflight", async () => {
    const key = "runs:rpc-state-race",
      stub = env.RUNS.get(env.RUNS.idFromName(key));
    expect((await stub.claim(claim(), 1)).ok).toBe(true);
    const body = JSON.stringify({ storeKey: key, run: { ...claim(), phase: "live" } });
    let preflights = 0;
    const routed = routedEnv(stub, (name) =>
      name === "promotionHold"
        ? async (...args: unknown[]) => {
            const observed = await Reflect.apply(stub.promotionHold, stub, args);
            expect(observed).toBeNull();
            preflights++;
            expect((await stub.preparePromotion(body)).kind).toBe("prepared");
            return observed;
          }
        : undefined,
    );
    const response = await memoryWorker.fetch(request(key), routed);
    expect(preflights).toBe(1);
    expect(response.status).toBe(423);
    expect(await response.json()).toEqual({ kind: "held", reason: "promotion_pending", runId: id });
    expect((await stub.listLive())[0].state).not.toHaveProperty("harness");
    expect(await stub.promotionHold(id, gen)).toMatchObject({ kind: "held", runId: id });
  });
  it("does not turn an unknown error after an actual state commit into a held response, even when its name matches", async () => {
    const key = "runs:rpc-state-unknown",
      stub = env.RUNS.get(env.RUNS.idFromName(key));
    expect((await stub.claim(claim(), 1)).ok).toBe(true);
    const routed = routedEnv(stub, (name) =>
      name === "setState"
        ? async (...args: unknown[]) => {
            expect(await Reflect.apply(stub.setState, stub, args)).toEqual({ ok: true });
            try {
              await Reflect.apply(Reflect.get(stub, "undefinedFixtureMethod"), stub, []);
            } catch (error) {
              expect(error).toMatchObject({ remote: true });
              Object.assign(error as object, { name: "PromotionPendingError", kind: "promotion-pending", runId: id });
              throw error;
            }
            throw new Error("remote unknown-outcome control did not throw");
          }
        : undefined,
    );
    const response = await memoryWorker.fetch(request(key), routed);
    expect(response.status).toBe(500);
    expect(JSON.parse(response.headers.get(STATE_WRITE_DIAGNOSTIC_HEADER)!)).toMatchObject({
      failure: { stage: "state-rpc", errorKind: "error" },
    });
    expect((await stub.listLive())[0].state).toHaveProperty("harness.sessionPolicy", state.harness.sessionPolicy);
  });
  it("keeps an ordinary identity-none state write acknowledged through the real HTTP and RPC path", async () => {
    const key = "runs:rpc-state-positive",
      stub = env.RUNS.get(env.RUNS.idFromName(key));
    expect((await stub.claim(claim(), 1)).ok).toBe(true);
    const response = await fetchMemoryTest(request(key).url, {
      method: "POST",
      headers: request(key).headers,
      body: await request(key).text(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect((await stub.listLive())[0].state).toHaveProperty("harness.sessionPolicy", state.harness.sessionPolicy);
  });
  it.each([
    null,
    { kind: "held", reason: "promotion_pending", runId: "ffffffff-ffff-4fff-afff-ffffffffffff" },
    { kind: "held", reason: "unknown", runId: id },
    { kind: "held", reason: "promotion_pending", runId: id, unexpected: true },
    { ok: true, kind: "unknown" },
  ])("rejects a malformed, foreign or unknown RPC acknowledgement: %j", async (value) => {
    const key = "runs:rpc-state-invalid",
      stub = env.RUNS.get(env.RUNS.idFromName(key));
    expect((await stub.claim(claim(), 1)).ok).toBe(true);
    const routed = routedEnv(stub, (name) => (name === "setState" ? async () => value : undefined));
    const response = await memoryWorker.fetch(request(key), routed);
    expect(response.status).toBe(500);
    expect(JSON.parse(response.headers.get(STATE_WRITE_DIAGNOSTIC_HEADER)!)).toMatchObject({
      failure: { stage: "acknowledgment" },
    });
    expect((await stub.listLive())[0].state).not.toHaveProperty("harness");
  });
  it("keeps an actual foreign-generation state write fenced without changing its owner", async () => {
    const key = "runs:rpc-state-fenced",
      stub = env.RUNS.get(env.RUNS.idFromName(key));
    expect((await stub.claim(claim(), 1)).ok).toBe(true);
    const original = request(key),
      body = JSON.parse(await original.text());
    body.gen = "foreign-gen";
    const encoded = JSON.stringify(body);
    const response = await fetchMemoryTest(original.url, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(encoded).length),
      },
      body: encoded,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, reason: "fenced" });
    expect((await stub.listLive())[0]).toMatchObject({ ownerGen: gen, state: {} });
  });
});
