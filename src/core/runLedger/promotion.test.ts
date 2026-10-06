import { getAgent } from "../../agents/registry.js";
import { originalColdAllocation, workspaceDurabilityKey } from "./workspaceDurability.js";
import { describe, expect, it } from "vitest";
import { InMemoryRunLedger } from "./inMemory.js";
import { WorkerRunLedger } from "../runLedgerWorker.js";
import type { ClaimRequest } from "./types.js";
import {
  PROMOTION_BODY_BYTES,
  promotionBodyHash,
  promotionBytes,
  promotionPreparationOf,
  promotionBodyOf,
} from "./promotion.js";
const request = (): ClaimRequest => ({
  runId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  threadKey: "mcp:fixture:promotion",
  gen: "gen-A",
  startedAt: 1,
  leaseMs: 30_000,
  system: "",
  tools: [],
  phase: "attaching",
  meta: {
    agent: "review",
    channelId: "mcp:fixture",
    threadKey: "mcp:fixture:promotion",
    userId: "slack:fixture",
    readonly: true,
    profile: { machine: "repo-resident", identity: "read", minutes: 25 },
  },
});
const body = (r = request()): string =>
  JSON.stringify({
    storeKey: "runs:fixture",
    run: {
      ...r,
      phase: "live",
      system: "original prompt",
      state: { binding: { backend: "resident", workspace: "/private/original" } },
    },
  });
describe("original promotion private prepare", () => {
  it("keeps closed receiver refusal reasons distinct and rejects malformed response flags", async () => {
    for (const reason of ["legacy", "fenced", "mismatch", "oversize", "corrupt", "unsupported", "unknown"] as const) {
      const client = new WorkerRunLedger({
        baseUrl: "https://receiver.invalid",
        token: "fixture",
        storeKey: "runs:fixture",
        fetch: async () => Response.json({ kind: "held", reason }),
      });
      expect(await client.preparePromotion(body())).toEqual({ kind: "held", reason });
      expect(await client.readPromotion({ runId: request().runId, gen: request().gen })).toEqual({
        kind: "held",
        reason,
      });
    }
    const malformed = new WorkerRunLedger({
      baseUrl: "https://receiver.invalid",
      token: "fixture",
      storeKey: "runs:fixture",
      fetch: async () => Response.json({ kind: "held", reason: "fenced", callerPermission: true }),
    });
    expect(await malformed.preparePromotion(body())).toEqual({ kind: "held", reason: "unknown" });
  });
  it("recognizes a known pending precondition only for the actual requested run and closed source result", async () => {
    const req = request();
    for (const returnedRun of [req.runId, "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"]) {
      const client = new WorkerRunLedger({
        baseUrl: "https://receiver.invalid",
        token: "fixture",
        storeKey: "runs:fixture",
        fetch: async () =>
          Response.json({ kind: "held", reason: "promotion_pending", runId: returnedRun }, { status: 423 }),
      });
      const held = client.abandon(req.runId, req.gen);
      if (returnedRun === req.runId)
        await expect(held).rejects.toMatchObject({ name: "PromotionPendingError", runId: req.runId });
      else await expect(held).rejects.not.toMatchObject({ name: "PromotionPendingError" });
    }
  });
  it("refuses the actual claim lease and metadata boundary without changing a direct original", async () => {
    for (const invalid of [-1, 0, 999, 3600001, 1000.5]) {
      const store = new InMemoryRunLedger(() => 2),
        req = request();
      await store.claim(req);
      const old = structuredClone(store.live.get(req.runId));
      const wire = body({ ...req, leaseMs: invalid });
      expect(await store.preparePromotion(wire)).toEqual({ kind: "held", reason: "corrupt" });
      let calls = 0;
      const client = new WorkerRunLedger({
        baseUrl: "https://receiver.invalid",
        token: "fixture",
        storeKey: "runs:fixture",
        fetch: async () => {
          calls++;
          return Response.json({});
        },
      });
      expect(await client.preparePromotion(wire)).toEqual({ kind: "held", reason: "corrupt" });
      expect(calls).toBe(0);
      expect(store.live.get(req.runId)).toEqual(old);
    }
  });
  it("stores the complete original wire bytes and returns a detached receiver receipt without changing the live reservation", async () => {
    const store = new InMemoryRunLedger(() => 2),
      req = request();
    await store.claim(req);
    const live = structuredClone(store.live.get(req.runId)),
      raw = body(req);
    const result = await store.preparePromotion(raw);
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error("prepare refused");
    expect(result.receipt).toEqual({
      version: 1,
      runId: req.runId,
      threadKey: req.threadKey,
      gen: req.gen,
      startedAt: req.startedAt,
      namespace: req.meta.channelId,
      requester: req.meta.userId,
      revision: 1,
      bodySha256: await promotionBodyHash(raw),
    });
    result.receipt.requester = "changed";
    expect(store.live.get(req.runId)).toEqual(live);
    const saved = await store.readPromotion({ runId: req.runId, gen: req.gen });
    expect(saved).toMatchObject({
      kind: "prepared",
      preparation: { bodyJson: raw, receipt: { requester: req.meta.userId } },
    });
    expect(await store.preparePromotion(raw)).toMatchObject({ kind: "prepared" });
    expect(await store.preparePromotion(raw.replace("original prompt", "replacement"))).toMatchObject({
      kind: "held",
      reason: "mismatch",
    });
    expect(await store.readPromotion({ runId: req.runId, gen: req.gen })).toEqual(saved);
    expect(
      promotionPreparationOf({ ...(saved.kind === "prepared" ? saved.preparation : {}), callerPermit: true }),
    ).toBeUndefined();
  });
  it("keeps pending and corrupt original witnesses ahead of state finish abandon handoff and restart cleanup", async () => {
    for (const corrupt of [false, true]) {
      const store = new InMemoryRunLedger(() => 2),
        req = request();
      await store.claim(req);
      expect(await store.preparePromotion(body(req))).toMatchObject({ kind: "prepared" });
      if (corrupt) {
        const internals = store as unknown as {
          workspaceObligations: Map<string, { allocation: { promotion: unknown } }>;
        };
        internals.workspaceObligations.values().next().value!.allocation.promotion = {
          malformed: "original private bytes",
        };
      }
      const saved = structuredClone(store.live.get(req.runId));
      await expect(store.setState(req.runId, req.gen, { binding: { backend: "sandbox" } })).rejects.toMatchObject({
        name: "PromotionPendingError",
      });
      await expect(store.finishing(req.runId, req.gen)).rejects.toMatchObject({ name: "PromotionPendingError" });
      await expect(store.abandon(req.runId, req.gen)).rejects.toMatchObject({ name: "PromotionPendingError" });
      expect(await store.handoff(req.gen, [req.runId], { pausedForRetry: true })).toEqual({ marked: [] });
      expect(await store.reclaim("gen-NEW", 100_000, 30_000)).toEqual([]);
      expect(store.live.get(req.runId)).toEqual(saved);
      await expect(store.claim({ ...req, phase: "live" })).rejects.toMatchObject({ name: "PromotionPendingError" });
    }
  });
  it("keeps the existing full 512KiB wire fence without shrinking it for a string wrapper", async () => {
    const store = new InMemoryRunLedger(() => 2),
      req = request();
    await store.claim(req);
    const packet = { storeKey: "runs:fixture", run: { ...req, phase: "live", system: "" } };
    packet.run.system = "x".repeat(PROMOTION_BODY_BYTES - promotionBytes(JSON.stringify(packet)));
    const exact = JSON.stringify(packet);
    expect(promotionBytes(exact)).toBe(PROMOTION_BODY_BYTES);
    expect(await store.preparePromotion(exact)).toMatchObject({ kind: "prepared" });
    expect(await store.preparePromotion(exact + " ")).toEqual({ kind: "held", reason: "oversize" });
    expect(await store.readPromotion({ runId: req.runId, gen: req.gen })).toMatchObject({
      kind: "prepared",
      preparation: { bodyJson: exact },
    });
  });
  it("does not promote on an old unsupported receiver and reads unknown prepare acceptance without replay", async () => {
    let calls = 0;
    const old = new WorkerRunLedger({
      baseUrl: "https://older.invalid",
      token: "fixture",
      storeKey: "runs:fixture",
      fetch: async () => {
        calls++;
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    expect(await old.preparePromotion(body())).toEqual({ kind: "held", reason: "unsupported" });
    expect(calls).toBe(1);
    const store = new InMemoryRunLedger(() => 2),
      req = request();
    await store.claim(req);
    let prepares = 0;
    const client = new WorkerRunLedger({
      baseUrl: "https://receiver.invalid",
      token: "fixture",
      storeKey: "runs:fixture",
      fetch: async (input, init) => {
        if (String(input).endsWith("/prepare")) {
          prepares++;
          await store.preparePromotion(String(init?.body));
          throw new Error("reply lost after actual prepare");
        }
        const query = JSON.parse(String(init?.body));
        return Response.json(await store.readPromotion(query));
      },
    });
    expect(await client.preparePromotion(body(req))).toEqual({ kind: "held", reason: "unknown" });
    expect(prepares).toBe(1);
    expect(await client.readPromotion({ runId: req.runId, gen: req.gen })).toMatchObject({
      kind: "prepared",
      preparation: { bodyJson: body(req) },
    });
    expect(prepares).toBe(1);
  });
});

// Feature: docs/reference/specs/run-history.md — commit is private and remains unconfirmed.
function allocatedRequest(): ClaimRequest {
  const req = request();
  req.meta = { ...req.meta, repo: "fixture/repo", ref: "codex/fixture", headSha: "a".repeat(40), pr: 42 };
  req.meta.workspaceAllocation = originalColdAllocation({
    runId: req.runId,
    registered: getAgent("review"),
    identity: req.meta,
    target: { repo: req.meta.repo!, ref: req.meta.ref!, headSha: req.meta.headSha!, pr: 42 },
  });
  return req;
}
describe("original promotion receiver commit", () => {
  it.each([false, true])(
    "commits the exact saved body once and reads its actual unconfirmed receipt without releasing original custody: allocated=%s",
    async (allocated) => {
      const store = new InMemoryRunLedger(() => 2),
        req = allocated ? allocatedRequest() : request();
      await store.claim(req);
      const raw = body(req),
        original = promotionBodyOf(raw)!;
      expect(await store.preparePromotion(raw)).toMatchObject({ kind: "prepared" });
      const committed = await store.claim(original, raw);
      expect(committed).toMatchObject({
        ok: true,
        allocationAck: { allocation: req.meta.workspaceAllocation ?? null },
        promotionCommit: { phase: "unconfirmed" },
      });
      const snapshot = structuredClone(store.live.get(req.runId));
      expect(snapshot).toMatchObject({
        phase: "live",
        system: "original prompt",
        state: { binding: { workspace: "/private/original" } },
      });
      expect(await store.claim(original, raw)).toEqual(committed);
      expect(store.live.get(req.runId)).toEqual(snapshot);
      expect(await store.readPromotion({ runId: req.runId, gen: req.gen })).toMatchObject({
        kind: "committed",
        preparation: { bodyJson: raw },
        receipt: committed.ok ? committed.promotionCommit : undefined,
      });
      await expect(store.abandon(req.runId, req.gen)).rejects.toMatchObject({ name: "PromotionPendingError" });
      expect(await store.reclaim("gen-NEW", 100_000, 30_000)).toEqual([]);
    },
  );
  it.each(["body", "actor", "target", "gen", "start", "revision", "digest", "corrupt", "request"])(
    "holds a conflicting prepared commit without changing original custody: %s",
    async (mode) => {
      const store = new InMemoryRunLedger(() => 2),
        req = allocatedRequest(),
        raw = body(req);
      await store.claim(req);
      await store.preparePromotion(raw);
      let wire = raw;
      const original = promotionBodyOf(raw)!;
      const internals = store as unknown as {
        workspaceObligations: Map<
          string,
          { revision: number; allocation: { promotion: { receipt: { bodySha256: string } } } }
        >;
      };
      const archive = internals.workspaceObligations.get(workspaceDurabilityKey(req.runId))!;
      if (mode === "revision") archive.revision = 2;
      if (mode === "digest") archive.allocation.promotion.receipt.bodySha256 = "b".repeat(64);
      if (mode === "corrupt") Object.assign(archive.allocation.promotion, { unexpected: true });
      if (mode === "body") wire = raw + " ";
      if (mode === "actor") original.meta.userId = "slack:OTHER";
      if (mode === "target") original.meta.ref = "codex/rival";
      if (mode === "gen") original.gen = "gen-OTHER";
      if (mode === "start") original.startedAt = 2;
      if (mode === "request") original.system = "substituted caller parameter";
      if (["actor", "target", "gen", "start"].includes(mode))
        wire = JSON.stringify({ storeKey: "runs:fixture", run: original });
      const before = structuredClone(store.live.get(req.runId)),
        bytes = structuredClone(archive);
      const outcome = store.claim(original, wire);
      if (mode === "gen") expect(await outcome).toMatchObject({ ok: false, live: { runId: req.runId } });
      else await expect(outcome).rejects.toMatchObject({ name: "PromotionPendingError" });
      expect(store.live.get(req.runId)).toEqual(before);
      expect(archive).toEqual(bytes);
    },
  );
  it("declines an old receiver before sending a prepared commit", async () => {
    const paths: string[] = [];
    const client = new WorkerRunLedger({
      baseUrl: "https://old.invalid",
      token: "fixture",
      storeKey: "runs:fixture",
      fetch: async (input) => {
        paths.push(new URL(String(input)).pathname);
        return Response.json({ error: "unsupported" }, { status: 404 });
      },
    });
    await expect(client.claim(promotionBodyOf(body())!, body())).rejects.toThrow("no claim was sent");
    expect(paths).toEqual(["/runs/promotion/read"]);
  });
  it("reads actual accepted commit after lost reply without repeating its mutation", async () => {
    const store = new InMemoryRunLedger(() => 2),
      req = request(),
      raw = body(req);
    await store.claim(req);
    await store.preparePromotion(raw);
    let claims = 0;
    const transport: typeof fetch = async (input, init) => {
      const payload = String(init?.body),
        request = JSON.parse(payload);
      if (String(input).endsWith("/read")) return Response.json(await store.readPromotion(request));
      claims++;
      const committed = await store.claim(request.run, payload);
      expect(committed).toMatchObject({ ok: true, promotionCommit: { phase: "unconfirmed" } });
      throw new Error("actual committed reply lost");
    };
    const client = new WorkerRunLedger({
      baseUrl: "https://receiver.invalid",
      token: "fixture",
      storeKey: "runs:fixture",
      fetch: transport,
    });
    await expect(client.claim(promotionBodyOf(raw)!, raw)).rejects.toMatchObject({
      name: "UnknownAllocationClaimError",
    });
    const restarted = new WorkerRunLedger({
      baseUrl: "https://receiver.invalid",
      token: "fixture",
      storeKey: "runs:fixture",
      fetch: transport,
    });
    expect(await restarted.readPromotion({ runId: req.runId, gen: req.gen })).toMatchObject({
      kind: "committed",
      preparation: { bodyJson: raw },
      receipt: { phase: "unconfirmed" },
      allocationAck: { allocation: null },
    });
    expect(await restarted.claim(promotionBodyOf(raw)!, raw)).toMatchObject({
      ok: true,
      promotionCommit: { phase: "unconfirmed" },
    });
    expect(claims).toBe(1);
  });
  it.each(["target", "binding", "system", "owner"])(
    "does not read a committed receipt for substituted canonical state: %s",
    async (mode) => {
      const store = new InMemoryRunLedger(() => 2),
        req = request(),
        raw = body(req);
      await store.claim(req);
      await store.preparePromotion(raw);
      await store.claim(promotionBodyOf(raw)!, raw);
      const row = store.live.get(req.runId)!;
      if (mode === "target") row.meta.ref = "codex/rival";
      if (mode === "binding") row.state.binding = { backend: "resident", workspace: "/private/rival" };
      if (mode === "system") row.system = "substituted";
      if (mode === "owner") row.ownerGen = "gen-OTHER";
      expect(await store.readPromotion({ runId: req.runId, gen: req.gen })).toMatchObject({ kind: "held" });
      if (mode !== "owner")
        await expect(store.claim(promotionBodyOf(raw)!, raw)).rejects.toMatchObject({ name: "PromotionPendingError" });
    },
  );
});
