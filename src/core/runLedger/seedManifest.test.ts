import { describe, it, expect } from "vitest";
import { buildExpectedSeedManifest } from "./seedManifest.js";
import type { OpenRunRequest } from "./writeThrough.js";
import type { ClaimRequest } from "./types.js";
import { UNKNOWN_CONTEXT_DEPENDENCIES } from "../references/contextDependencies.js";
const runId = "dddddddd-dddd-4ddd-dddd-dddddddddddd",
  threadKey = "mcp:fixture:seed";
function inputs() {
  const req: ClaimRequest = {
    runId,
    threadKey,
    gen: "gen-A",
    startedAt: 1,
    leaseMs: 30_000,
    system: "actual original system",
    tools: [],
    phase: "live",
    meta: {
      channelId: "mcp:fixture",
      userId: "slack:fixture",
      threadKey,
      profile: { machine: "repo-resident", identity: "read", minutes: 25 },
      session: {
        key: "task:fixture:seed",
        threadSession: "task:fixture:@thread",
        seedFrom: 4,
        request: 4,
        range: { from: 4 },
      },
    },
  };
  const open: Pick<OpenRunRequest, "runId" | "threadKey" | "startedAt" | "system" | "seed"> = {
    runId,
    threadKey,
    startedAt: 1,
    system: req.system,
    seed: {
      messages: [{ role: "user", content: [{ type: "text", text: "actual request" }] }],
      actors: ["slack:fixture"],
      context: UNKNOWN_CONTEXT_DEPENDENCIES,
      notepad: "actual resolved notes",
      budgetMs: 1_500_000,
    },
  };
  return {
    bodyJson: JSON.stringify({ storeKey: "runs:fixture", run: req }),
    open,
    observation: { key: "task:fixture:seed", next: 4 },
  };
}
describe("immutable expected seed before effects", () => {
  it("builds one canonical complete expected input manifest without mutating actual resolved input", async () => {
    const input = inputs(),
      before = structuredClone(input);
    const result = await buildExpectedSeedManifest(input);
    expect(result).toMatchObject({
      kind: "built",
      manifest: { version: 1, runId, gen: "gen-A", count: 1, from: 4, through: 4, reusedCount: 0, budgetMs: 1_500_000 },
    });
    expect(await buildExpectedSeedManifest(structuredClone(input))).toEqual(result);
    expect(input).toEqual(before);
  });
});

import { InMemoryRunLedger } from "./inMemory.js";
import { WorkerRunLedger } from "../runLedgerWorker.js";
import { promotionBodyOf } from "./promotion.js";
import { turnRows } from "./transcript.js";
import { ATTACHMENT_REF_BYTES } from "./types.js";
import {
  canonicalSeedJson,
  encodeExpectedSeedHeader,
  decodeExpectedSeedHeader,
  EXPECTED_SEED_MAX_HEADER_BYTES,
  requestHeaderBytes,
  WORKER_REQUEST_HEADER_BYTES,
} from "./seedManifest.js";

describe("expected seed complete content and private envelope", () => {
  it.each(["actor", "context", "notepad", "system", "budget", "attachment"])(
    "changes sealed input digest for the actual changed %s",
    async (part) => {
      const a = inputs();
      a.open.seed!.messages[0].content.push({
        type: "image",
        mediaType: "image/png",
        data: "a".repeat(ATTACHMENT_REF_BYTES + 1),
      });
      const original = await buildExpectedSeedManifest(a);
      expect(original.kind).toBe("built");
      const changed = structuredClone(a);
      if (part === "actor") changed.open.seed!.actors = ["slack:OTHER"];
      if (part === "context") changed.open.seed!.context = { ...UNKNOWN_CONTEXT_DEPENDENCIES, revision: 1 };
      if (part === "notepad") changed.open.seed!.notepad = "different original notes";
      if (part === "system") {
        changed.open.system = "different system";
        const body = JSON.parse(changed.bodyJson);
        body.run.system = changed.open.system;
        changed.bodyJson = JSON.stringify(body);
      }
      if (part === "budget") {
        changed.open.seed!.budgetMs = 600_000;
        const body = JSON.parse(changed.bodyJson);
        body.run.meta.profile.minutes = 10;
        changed.bodyJson = JSON.stringify(body);
      }
      if (part === "attachment")
        changed.open.seed!.messages[0].content[1] = {
          type: "image",
          mediaType: "image/png",
          data: "b".repeat(ATTACHMENT_REF_BYTES + 1),
        };
      const next = await buildExpectedSeedManifest(changed);
      expect(next.kind).toBe("built");
      if (original.kind !== "built" || next.kind !== "built") throw new Error("builder refused complete input");
      expect(next.digest).not.toBe(original.digest);
    },
  );
  it.each(["seed", "context", "notepad", "actors", "range", "empty", "system"])(
    "holds incomplete or inconsistent actual input before effects: %s",
    async (mode) => {
      const input = inputs();
      if (mode === "seed") input.open.seed = undefined;
      if (mode === "context") input.open.seed!.context = undefined;
      if (mode === "notepad") input.open.seed!.notepad = undefined;
      if (mode === "actors") input.open.seed!.actors = [];
      if (mode === "range") input.observation.next = 5;
      if (mode === "empty") input.open.seed!.messages = [];
      if (mode === "system") input.open.system = "foreign system";
      expect(await buildExpectedSeedManifest(input)).toMatchObject({ kind: "held" });
    },
  );
  it.each(["complete", "missing", "foreign", "changed", "truncated"])(
    "binds the actual reused source rather than guessing from its pointer: %s",
    async (mode) => {
      const input = inputs(),
        req = JSON.parse(input.bodyJson).run;
      req.meta.session.request = 5;
      req.meta.session.range.from = 5;
      input.bodyJson = JSON.stringify({ storeKey: "runs:fixture", run: req });
      input.open.seed!.messages.push({ role: "user", content: [{ type: "text", text: "new original request" }] });
      input.open.seed!.actors = ["slack:fixture", "slack:fixture"];
      input.open.seed!.log = { from: 4, turns: 1 };
      const prior = turnRows(4, input.open.seed!.messages[0], {}, "slack:fixture");
      const observation = {
        key: input.observation.key,
        next: 5,
        reused: {
          key: input.observation.key,
          from: 4,
          through: 4,
          next: 5,
          rows: prior.rows,
          attachments: prior.attachments,
          context: UNKNOWN_CONTEXT_DEPENDENCIES,
          notepad: input.open.seed!.notepad!,
          owner: { runId, gen: "gen-OLD" },
        },
      };
      if (mode === "missing")
        return expect(
          await buildExpectedSeedManifest({ ...input, observation: { key: observation.key, next: 5 } }),
        ).toMatchObject({ kind: "held" });
      if (mode === "foreign") observation.reused.key = "task:foreign";
      if (mode === "changed")
        observation.reused.rows = turnRows(4, {
          role: "user",
          content: [{ type: "text", text: "foreign earlier request" }],
        }).rows;
      if (mode === "truncated") observation.reused.rows = [];
      const result = await buildExpectedSeedManifest({ ...input, observation });
      expect(result).toMatchObject(
        mode === "complete"
          ? { kind: "built", manifest: { reusedCount: 1, from: 4, through: 5, reused: { count: 1 } } }
          : { kind: "held" },
      );
    },
  );
  it("seals manifest with original body once, binds actual receipts, and never upgrades absent legacy", async () => {
    const input = inputs(),
      built = await buildExpectedSeedManifest(input);
    if (built.kind !== "built") throw new Error("fixture refused");
    const req = promotionBodyOf(input.bodyJson)!,
      store = new InMemoryRunLedger(() => 2);
    await store.claim({ ...req, phase: "attaching", system: "" });
    expect(await store.preparePromotion(input.bodyJson, built.manifest)).toMatchObject({
      kind: "prepared",
      receipt: { expectedSeedSha256: built.digest },
    });
    expect(await store.readPromotion({ runId: req.runId, gen: req.gen })).toMatchObject({
      kind: "prepared",
      preparation: { bodyJson: input.bodyJson, expectedSeed: built.manifest },
    });
    expect(
      await store.preparePromotion(input.bodyJson, { ...built.manifest, notepadHash: "b".repeat(64) }),
    ).toMatchObject({ kind: "held" });
    expect(await store.claim(req, input.bodyJson)).toMatchObject({
      ok: true,
      promotionCommit: { phase: "unconfirmed", expectedSeedSha256: built.digest },
    });
    await expect(store.abandon(req.runId, req.gen)).rejects.toMatchObject({ name: "PromotionPendingError" });
    const legacy = new InMemoryRunLedger(() => 2);
    await legacy.claim({ ...req, phase: "attaching", system: "" });
    await legacy.preparePromotion(input.bodyJson);
    expect(await legacy.preparePromotion(input.bodyJson, built.manifest)).toEqual({ kind: "held", reason: "mismatch" });
    expect(await legacy.claim(req, input.bodyJson)).toMatchObject({
      ok: true,
      promotionCommit: { phase: "unconfirmed" },
    });
  });
  it("uses canonical ASCII encoding and refuses duplicate noncanonical malformed headers", async () => {
    const built = await buildExpectedSeedManifest(inputs());
    if (built.kind !== "built") throw new Error("fixture refused");
    const encoded = encodeExpectedSeedHeader(built.manifest);
    expect(encoded.length).toBeLessThanOrEqual(EXPECTED_SEED_MAX_HEADER_BYTES);
    expect(decodeExpectedSeedHeader(encoded)).toEqual(built.manifest);
    expect(canonicalSeedJson(built.manifest)).not.toContain("actual request");
    for (const bad of [encoded + ", " + encoded, "é", encoded + " ", btoa(JSON.stringify(built.manifest)), "%%"]) {
      expect(decodeExpectedSeedHeader(bad)).toBeUndefined();
    }
    expect(
      requestHeaderBytes(
        new Headers({
          "content-type": "application/json",
          authorization: "Bearer fixture",
          host: "receiver.invalid",
          "content-length": "524288",
          "x-switchboard-expected-seed": encoded,
        }),
      ),
    ).toBeLessThan(WORKER_REQUEST_HEADER_BYTES);
  });
  it("declines old receipt without the actual expected manifest digest", async () => {
    const input = inputs(),
      built = await buildExpectedSeedManifest(input);
    if (built.kind !== "built") throw new Error("fixture refused");
    const store = new InMemoryRunLedger(() => 2),
      req = promotionBodyOf(input.bodyJson)!;
    await store.claim({ ...req, phase: "attaching", system: "" });
    let calls = 0;
    const client = new WorkerRunLedger({
      baseUrl: "https://old.invalid",
      storeKey: "runs:fixture",
      token: "fixture",
      fetch: async (_input, init) => {
        calls++;
        return Response.json(await store.preparePromotion(String(init?.body)));
      },
    });
    expect(await client.preparePromotion(input.bodyJson, built.manifest)).toEqual({
      kind: "held",
      reason: "unsupported",
    });
    expect(calls).toBe(1);
    expect(store.live.get(req.runId)?.phase).toBe("attaching");
  });
});

it("keeps the maximum existing key and scalar schema at full body size without a wrapper cap", async () => {
  const input = inputs(),
    body = JSON.parse(input.bodyJson),
    from = 4_000_000_000_000_000;
  body.run.gen = "g".repeat(128);
  body.run.threadKey = "\u0000".repeat(256);
  body.run.startedAt = -0.0000010000000000000002;
  body.run.meta = {
    ...body.run.meta,
    threadKey: body.run.threadKey,
    channelId: "\u0000".repeat(512),
    userId: "\u0000".repeat(512),
    authenticatedAs: "\u0000".repeat(512),
    postedBy: "\u0000".repeat(512),
    profile: { ...body.run.meta.profile, minutes: 150_000_000_000 },
    session: {
      ...body.run.meta.session,
      key: "a".repeat(512),
      seedFrom: from,
      request: from + 1,
      range: { from: from + 1 },
    },
  };
  body.run.system = "";
  body.run.system = "x".repeat(512 * 1024 - new TextEncoder().encode(JSON.stringify(body)).byteLength);
  input.bodyJson = JSON.stringify(body);
  input.open = {
    ...input.open,
    threadKey: body.run.threadKey,
    startedAt: body.run.startedAt,
    system: body.run.system,
    seed: {
      ...input.open.seed!,
      messages: [
        { role: "user", content: [{ type: "text", text: "actual prior" }] },
        { role: "user", content: [{ type: "text", text: "actual next" }] },
      ],
      actors: ["slack:fixture", "slack:fixture"],
      budgetMs: 9_000_000_000_000_000,
      log: { from, turns: 1 },
    },
  };
  const prior = turnRows(from, input.open.seed!.messages[0], {}, "slack:fixture");
  const built = await buildExpectedSeedManifest({
    ...input,
    observation: {
      key: body.run.meta.session.key,
      next: from + 1,
      reused: {
        key: body.run.meta.session.key,
        from,
        through: from,
        next: from + 1,
        rows: prior.rows,
        attachments: prior.attachments,
        context: UNKNOWN_CONTEXT_DEPENDENCIES,
        notepad: input.open.seed!.notepad!,
        owner: { runId, gen: "g".repeat(128) },
      },
    },
  });
  expect(built.kind).toBe("built");
  if (built.kind !== "built") throw new Error("maximum supported input refused");
  const encoded = encodeExpectedSeedHeader(built.manifest);
  expect(encoded.length).toBeLessThanOrEqual(EXPECTED_SEED_MAX_HEADER_BYTES);
  expect(decodeExpectedSeedHeader(encoded)).toEqual(built.manifest);
  expect(new TextEncoder().encode(input.bodyJson).byteLength).toBe(512 * 1024);
  const normalHeaders = new Headers({
    "content-type": "application/json",
    authorization: "Bearer fixture",
    host: "localhost:18712",
    "content-length": "524288",
    "user-agent": "node",
    accept: "*/*",
    "accept-encoding": "gzip, deflate",
    "sec-fetch-mode": "cors",
    connection: "keep-alive",
    "x-switchboard-expected-seed": encoded,
  });
  expect(requestHeaderBytes(normalHeaders)).toBeLessThan(WORKER_REQUEST_HEADER_BYTES);
  const store = new InMemoryRunLedger(() => 2),
    req = promotionBodyOf(input.bodyJson)!;
  await store.claim({ ...req, phase: "attaching", system: "" });
  expect(await store.preparePromotion(input.bodyJson, built.manifest)).toMatchObject({
    kind: "prepared",
    receipt: { expectedSeedSha256: built.digest },
  });
  const receiver = new WorkerRunLedger({
    baseUrl: "http://localhost:18712",
    token: "fixture",
    storeKey: "runs:fixture",
    fetch: async (_input, init) => {
      expect(init?.body).toBe(input.bodyJson);
      const header = new Headers(init?.headers).get("x-switchboard-expected-seed");
      expect(header).toBe(encoded);
      return Response.json(await store.preparePromotion(String(init?.body), decodeExpectedSeedHeader(header)));
    },
  });
  expect(await receiver.preparePromotion(input.bodyJson, built.manifest)).toMatchObject({ kind: "prepared" });
});

it("captures the actual submitted manifest before its first await and rejects later archive equivocation", async () => {
  const input = inputs(),
    built = await buildExpectedSeedManifest(input);
  if (built.kind !== "built") throw new Error("fixture refused");
  const original = structuredClone(built.manifest),
    req = promotionBodyOf(input.bodyJson)!,
    store = new InMemoryRunLedger(() => 2);
  await store.claim({ ...req, phase: "attaching", system: "" });
  const preparing = store.preparePromotion(input.bodyJson, built.manifest);
  built.manifest.notepadHash = "b".repeat(64);
  expect(await preparing).toMatchObject({ kind: "prepared", receipt: { expectedSeedSha256: built.digest } });
  const saved = await store.readPromotion({ runId: req.runId, gen: req.gen });
  expect(saved).toMatchObject({ kind: "prepared", preparation: { expectedSeed: original } });
  const internals = store as unknown as {
    workspaceObligations: Map<string, { allocation: { promotion: { expectedSeed: typeof original } } }>;
  };
  const row = [...internals.workspaceObligations.values()][0];
  row.allocation.promotion.expectedSeed.notepadHash = "c".repeat(64);
  expect(await store.readPromotion({ runId: req.runId, gen: req.gen })).toEqual({ kind: "held", reason: "corrupt" });
  await expect(store.claim(req, input.bodyJson)).rejects.toMatchObject({ name: "PromotionPendingError" });
  expect(store.live.get(req.runId)?.phase).toBe("attaching");
});
