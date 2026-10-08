import * as verification from "./seedVerification.js";
import { describe, it, expect, vi } from "vitest";
import { InMemoryRunLedger } from "./inMemory.js";
import { buildExpectedSeedManifest } from "./seedManifest.js";
import { UNKNOWN_CONTEXT_DEPENDENCIES } from "../references/contextDependencies.js";
import { workspaceDurabilityKey, type WorkspaceDurabilityArchive } from "./workspaceDurability.js";

const id = "ffffffff-ffff-4fff-ffff-ffffffffffff",
  gen = "gen-SOURCE",
  key = "task:fixture:source",
  thread = "mcp:fixture:source";
async function setupSource(clock: () => number = () => 2) {
  const store = new InMemoryRunLedger(clock),
    messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "actual original request" }] }];
  const req = {
    runId: id,
    threadKey: thread,
    gen,
    startedAt: 1,
    leaseMs: 30000,
    system: "actual system",
    tools: [],
    phase: "live" as const,
    meta: {
      agent: "review",
      userId: "slack:fixture",
      channelId: "mcp:fixture",
      threadKey: thread,
      profile: { machine: "repo-resident" as const, identity: "read" as const, minutes: 25 },
      session: { key, threadSession: "task:fixture:@thread", seedFrom: 0, request: 0, range: { from: 0 } },
    },
  };
  const bodyJson = JSON.stringify({ storeKey: "runs:fixture", run: req });
  const built = await buildExpectedSeedManifest({
    bodyJson,
    open: {
      runId: id,
      threadKey: thread,
      startedAt: 1,
      system: req.system,
      seed: {
        messages,
        actors: ["slack:fixture"],
        context: UNKNOWN_CONTEXT_DEPENDENCIES,
        notepad: "original notes",
        budgetMs: 1500000,
      },
    },
    observation: { key, next: 0 },
  });
  if (built.kind !== "built") throw new Error("fixture refused");
  await store.claim({ ...req, phase: "attaching", system: "" });
  await store.preparePromotion(bodyJson, built.manifest);
  await store.claim(req, bodyJson);
  await store.claimSession(key, id, gen);
  expect(
    await store.writeSessionSources(key, id, gen, {
      version: 1,
      status: "unknown",
      context: UNKNOWN_CONTEXT_DEPENDENCIES,
    }),
  ).toEqual({ ok: true });
  await store.writeNotepad(key, gen, "original notes", id);
  await store.seed(id, gen, [{ idx: 0, message: messages[0], actor: "slack:fixture" }], key);
  const ref = {
    storeKey: "runs:fixture",
    runId: id,
    gen,
    bodySha256: built.manifest.bodySha256,
    expectedSeedSha256: built.digest,
  };
  return { store, messages, req, ref, built };
}
describe("source-own expected seed verification", () => {
  it("authenticates the original committed manifest and atomically holds its actual source input", async () => {
    const { store, ref } = await setupSource();
    const result = await store.verifyExpectedSeed(key, ref);
    expect(result).toMatchObject({
      kind: "verified",
      receipt: { phase: "pending-confirmation", runId: id, gen, key, from: 0, through: 0, count: 1 },
    });
    await expect(store.claimSession(key, "other", gen)).rejects.toMatchObject({ name: "SourceSeedPendingError" });
    await expect(store.writeNotepad(key, gen, "changed", id)).rejects.toMatchObject({ name: "SourceSeedPendingError" });
  });
});

describe("pending source writer barrier controls", () => {
  it.each(["owner", "notes", "context", "rows", "append", "release", "checkpoint"])(
    "retains original source after ACK and refuses attempted %s mutation",
    async (mode) => {
      const { store, ref, messages } = await setupSource();
      const original = await store.verifyExpectedSeed(key, ref);
      expect(original.kind).toBe("verified");
      let operation: Promise<unknown>;
      if (mode === "owner") operation = store.claimSession(key, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", "gen-OTHER");
      else if (mode === "notes") operation = store.writeNotepad(key, gen, "foreign notes", id);
      else if (mode === "context")
        operation = store.writeSessionSources(key, id, gen, {
          version: 1,
          status: "unknown",
          context: { ...UNKNOWN_CONTEXT_DEPENDENCIES, revision: 1 },
        });
      else if (mode === "rows")
        operation = store.seed(
          id,
          gen,
          [
            {
              idx: 0,
              message: { role: "user", content: [{ type: "text", text: "foreign input" }] },
              actor: "slack:fixture",
            },
          ],
          key,
        );
      else if (mode === "append")
        operation = store.appendSession(key, "late-row", [
          { part: 0, json: JSON.stringify({ role: "user", part: { type: "text", text: "late" } }) },
        ]);
      else if (mode === "release") operation = store.releaseSession(key, id, gen);
      else
        operation = store.normalizeContextOrigins({
          key,
          runId: id,
          gen,
          expected: {
            beforeHash: "a".repeat(64),
            revision: 0,
            inputs: { transcriptHash: "a".repeat(64), systemHash: "a".repeat(64), notepadHash: "a".repeat(64) },
          },
        });
      await expect(operation).rejects.toMatchObject({ name: "SourceSeedPendingError" });
      expect(await store.readExpectedSeed(key, ref)).toEqual(original);
      expect(await store.seed(id, gen, [{ idx: 0, message: messages[0], actor: "slack:fixture" }], key)).toEqual({
        ok: true,
      });
      expect(await store.writeNotepad(key, gen, "original notes", id)).toEqual({ ok: true });
      await store.claimSession(key, id, gen);
    },
  );
  it("a valid newer pruning revision cannot remove pending holder and does not alter its immutable receipt", async () => {
    const { store, ref } = await setupSource();
    const original = await store.verifyExpectedSeed(key, ref);
    const revision = await store.custodyPinRevision(key);
    expect(await store.retainRangePinsIfRevision(key, revision!, [])).toMatchObject({ ok: true });
    const newer = await store.custodyPinRevision(key);
    expect(newer!.revision).toBeGreaterThan(revision!.revision);
    expect(await store.retainRangePinsIfRevision(key, newer!, [])).toMatchObject({ ok: true });
    expect(await store.readExpectedSeed(key, ref)).toEqual(original);
    expect(await store.verifyExpectedSeed(key, ref)).toEqual(original);
  });
  it.each(["store", "body", "manifest", "gen", "key"])(
    "requires actual canonical original references and holds a foreign %s",
    async (mode) => {
      const { store, ref } = await setupSource();
      const altered = { ...ref };
      let target = key;
      if (mode === "store") altered.storeKey = "runs:foreign";
      if (mode === "body") altered.bodySha256 = "b".repeat(64);
      if (mode === "manifest") altered.expectedSeedSha256 = "b".repeat(64);
      if (mode === "gen") altered.gen = "gen-OTHER";
      if (mode === "key") target = "task:foreign";
      expect(await store.verifyExpectedSeed(target, altered)).toMatchObject({ kind: "held" });
      expect(await store.readExpectedSeed(key, ref)).toEqual({ kind: "held", reason: "missing" });
    },
  );
  it("source mutation during hash awaits prevents own-transaction verification without installing a hold", async () => {
    const { store, ref } = await setupSource();
    const actual = verification.verifiedSourceSeedHashes;
    const spy = vi.spyOn(verification, "verifiedSourceSeedHashes").mockImplementationOnce(async (...args) => {
      const hashes = await actual(...args);
      await store.writeNotepad(key, gen, "changed while hashing", id);
      return hashes;
    });
    expect(await store.verifyExpectedSeed(key, ref)).toMatchObject({ kind: "held" });
    expect(await store.readExpectedSeed(key, ref)).toEqual({ kind: "held", reason: "missing" });
    spy.mockRestore();
  });
});

describe("receiver confirmation and authenticated source release", () => {
  async function ready(clock?: () => number) {
    const fixture = await setupSource(clock);
    await fixture.store.step(
      id,
      gen,
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
      key,
    );
    const source = await fixture.store.verifyExpectedSeed(key, fixture.ref);
    expect(source.kind).toBe("verified");
    return { ...fixture, source };
  }
  it("confirms actual canonical source and seed facts, then releases only the temporary source mutation hold", async () => {
    const { store, ref, source } = await ready();
    const confirm = await store.confirmPromotion(ref);
    expect(confirm).toMatchObject({
      kind: "confirmed",
      receipt: { phase: "confirmed", source: source.kind === "verified" ? source.receipt : null },
    });
    expect(await store.readPromotion({ runId: id, gen })).toMatchObject(confirm);
    await expect(store.writeNotepad(key, gen, "changed", id)).rejects.toMatchObject({ name: "SourceSeedPendingError" });
    expect(await store.readExpectedSeed(key, ref)).toEqual(source);
    const revision = await store.custodyPinRevision(key);
    const released = await store.releaseExpectedSeed(key, ref);
    expect(released).toMatchObject({ kind: "verified", release: { phase: "released" } });
    expect(await store.readExpectedSeed(key, ref)).toEqual(released);
    expect(await store.custodyPinRevision(key)).toEqual(revision);
    expect(store.sessions.get(key)?.rangePins?.[id]).toContainEqual({ from: 0, to: 0 });
    expect(await store.writeNotepad(key, gen, "changed", id)).toEqual({ ok: true });
    expect(await store.readExpectedSeed(key, ref)).toEqual(released);
    expect(await store.releaseExpectedSeed(key, ref)).toEqual(released);
    expect(await store.confirmPromotion(ref)).toEqual(confirm);
  });
  it("confirms the original seed across an authenticated heartbeat without renewing its budget or changing custody", async () => {
    let now = 2;
    const { store, ref, source } = await ready(() => now);
    const before = structuredClone(store.live.get(id)!);
    const prepared = await store.readPromotion({ runId: id, gen });
    const read = store.readExpectedSeed.bind(store);
    let beats = 0;
    store.readExpectedSeed = async (...args) => {
      const actual = await read(...args);
      now += 10_000;
      expect(await store.heartbeat(id, gen, 30_000)).toMatchObject({ ok: true });
      beats++;
      return actual;
    };
    const confirmed = await store.confirmPromotion(ref);
    store.readExpectedSeed = read;
    expect(beats).toBe(1);
    expect(confirmed.kind).toBe("confirmed");
    const after = structuredClone(store.live.get(id)!);
    expect(after.leaseUntil).toBe(before.leaseUntil + 10_000);
    expect({ ...after, leaseUntil: before.leaseUntil }).toEqual(before);
    const original = await store.readPromotion({ runId: id, gen });
    expect(original.kind).toBe("confirmed");
    if (prepared.kind !== "committed" || original.kind !== "confirmed")
      throw new Error("original confirmation required");
    expect(original.preparation).toEqual(prepared.preparation);
    expect(original.commit).toEqual(prepared.receipt);
    expect(await store.readExpectedSeed(key, ref)).toEqual(source);
    await expect(store.writeNotepad(key, gen, "changed", id)).rejects.toMatchObject({ name: "SourceSeedPendingError" });
  });
  it.each(["owner", "stop", "state", "system", "seed", "step", "meta", "archive", "budget"] as const)(
    "keeps concurrent %s drift fenced even beside a valid owner heartbeat",
    async (mode) => {
      let now = 2;
      const { store, ref, source } = await ready(() => now);
      const read = store.readExpectedSeed.bind(store);
      store.readExpectedSeed = async (...args) => {
        const actual = await read(...args);
        now += 10_000;
        expect(await store.heartbeat(id, gen, 30_000)).toMatchObject({ ok: true });
        const row = store.live.get(id)!;
        if (mode === "owner") row.ownerGen = "foreign-owner";
        if (mode === "stop") row.stop = "hard";
        if (mode === "state") row.state = { ...row.state, semanticChange: true };
        if (mode === "system") row.system = "foreign system";
        if (mode === "meta") row.meta.channelId = "mcp:foreign";
        if (mode === "budget") row.meta.profile!.minutes = 24;
        const step = store.steps.get(id)![0];
        if (mode === "seed") step.turnIndex = 2;
        if (mode === "step") store.steps.get(id)!.push({ ...step, step: 1 });
        if (mode === "archive") {
          const held = store as unknown as {
            workspaceObligations: Map<string, { allocation: WorkspaceDurabilityArchive }>;
          };
          held.workspaceObligations.get(workspaceDurabilityKey(id))!.allocation.startedAt += 1;
        }
        return actual;
      };
      expect(await store.confirmPromotion(ref)).toMatchObject({ kind: "held", reason: "mismatch" });
      store.readExpectedSeed = read;
      expect(store.sessions.get(key)?.expectedSeedPending).toEqual(source.kind === "verified" ? source.receipt : null);
      expect(store.sessions.get(key)?.expectedSeedRelease).toBeUndefined();
      await expect(store.writeNotepad(key, gen, "changed", id)).rejects.toMatchObject({
        name: "SourceSeedPendingError",
      });
    },
  );
  it.each([
    "system",
    "budget",
    "missing-step",
    "later-step",
    "flight",
    "count",
    "owner",
    "namespace",
    "body",
    "manifest",
  ])("holds a conflicting actual %s and preserves the source holder", async (mode) => {
    const { store, ref, source } = await ready();
    const row = store.live.get(id)!;
    const step = store.steps.get(id)![0];
    if (mode === "system") row.system = "foreign system";
    if (mode === "budget") row.meta.profile!.minutes = 24;
    if (mode === "missing-step") store.steps.delete(id);
    if (mode === "later-step") store.steps.get(id)!.push({ ...step, step: 1 });
    if (mode === "flight") step.inFlight = [{ callId: "foreign", tool: "bash" }];
    if (mode === "count") step.turnIndex = 2;
    if (mode === "owner") row.ownerGen = "gen-OTHER";
    if (mode === "namespace") row.meta.channelId = "mcp:foreign";
    const changed = { ...ref };
    if (mode === "body") changed.bodySha256 = "b".repeat(64);
    if (mode === "manifest") changed.expectedSeedSha256 = "b".repeat(64);
    expect(await store.confirmPromotion(changed)).toMatchObject({ kind: "held" });
    expect(await store.releaseExpectedSeed(key, changed)).toMatchObject({ kind: "held" });
    expect(store.sessions.get(key)?.expectedSeedPending).toEqual(source.kind === "verified" ? source.receipt : null);
    await expect(store.claimSession(key, "other", gen)).rejects.toMatchObject({ name: "SourceSeedPendingError" });
  });
  it("rereads Runs facts after the actual source ACK and every hash await", async () => {
    const { store, ref } = await ready();
    const read = store.readExpectedSeed.bind(store);
    store.readExpectedSeed = async (...args) => {
      const actual = await read(...args);
      store.live.get(id)!.system = "changed after source acknowledgment";
      return actual;
    };
    expect(await store.confirmPromotion(ref)).toMatchObject({ kind: "held" });
    await expect(store.writeNotepad(key, gen, "changed", id)).rejects.toMatchObject({ name: "SourceSeedPendingError" });
  });
  it("source release refuses ownership and source changes after canonical confirmation read", async () => {
    const { store, ref } = await ready();
    expect((await store.confirmPromotion(ref)).kind).toBe("confirmed");
    const read = store.readPromotion.bind(store);
    store.readPromotion = async (...args) => {
      const actual = await read(...args);
      store.sessions.get(key)!.owner = { runId: id, gen: "gen-OTHER" };
      return actual;
    };
    expect(await store.releaseExpectedSeed(key, ref)).toMatchObject({ kind: "held" });
    expect(store.sessions.get(key)?.expectedSeedRelease).toBeUndefined();
  });
  it("no-session and unsupported legacy originals remain held without inventing empty seed evidence", async () => {
    const { req, messages } = await setupSource();
    const store = new InMemoryRunLedger(() => 2),
      input = structuredClone(req);
    delete (input.meta as { session?: unknown }).session;
    const bodyJson = JSON.stringify({ storeKey: "runs:fixture", run: input });
    const built = await buildExpectedSeedManifest({
      bodyJson,
      open: { ...input, seed: { messages, budgetMs: 1500000, context: UNKNOWN_CONTEXT_DEPENDENCIES, notepad: "" } },
      observation: { next: 0 },
    });
    if (built.kind !== "built") throw new Error("fixture refused");
    const ref = {
      storeKey: "runs:fixture",
      runId: id,
      gen,
      bodySha256: built.manifest.bodySha256,
      expectedSeedSha256: built.digest,
    };
    await store.claim({ ...input, phase: "attaching", system: "" });
    expect(await store.confirmPromotion(ref)).toMatchObject({ kind: "held" });
    await store.preparePromotion(bodyJson, built.manifest);
    await store.claim(input, bodyJson);
    expect(await store.confirmPromotion(ref)).toMatchObject({ kind: "held" });
    expect(store.transcripts.get(id)?.rows).toEqual([]);
  });
  it("a distinct same-session original earns its own receipt and never borrows the released predecessor", async () => {
    const first = await ready();
    const firstConfirmed = await first.store.confirmPromotion(first.ref);
    const firstReleased = await first.store.releaseExpectedSeed(key, first.ref);
    expect(firstConfirmed.kind).toBe("confirmed");
    await first.store.abandon(id, gen);
    const secondId = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee",
      secondGen = "gen-SUCCESSOR";
    const req = structuredClone(first.req);
    req.runId = secondId;
    req.gen = secondGen;
    req.startedAt = 3;
    req.system = "actual distinct successor system";
    req.meta.profile.minutes = 10;
    req.meta.session.seedFrom = 1;
    req.meta.session.request = 1;
    req.meta.session.range.from = 1;
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "actual distinct successor input" }] },
    ];
    const bodyJson = JSON.stringify({ storeKey: "runs:fixture", run: req });
    const built = await buildExpectedSeedManifest({
      bodyJson,
      open: {
        ...req,
        seed: {
          messages,
          actors: ["slack:fixture"],
          budgetMs: 600000,
          context: UNKNOWN_CONTEXT_DEPENDENCIES,
          notepad: "successor notes",
        },
      },
      observation: { key, next: 1 },
    });
    if (built.kind !== "built") throw new Error("fixture refused");
    const ref = {
      storeKey: "runs:fixture",
      runId: secondId,
      gen: secondGen,
      bodySha256: built.manifest.bodySha256,
      expectedSeedSha256: built.digest,
    };
    await first.store.claim({ ...req, phase: "attaching", system: "" });
    await first.store.preparePromotion(bodyJson, built.manifest);
    await first.store.claim(req, bodyJson);
    await first.store.claimSession(key, secondId, secondGen);
    await first.store.writeSessionSources(key, secondId, secondGen, {
      version: 1,
      status: "unknown",
      context: UNKNOWN_CONTEXT_DEPENDENCIES,
    });
    await first.store.writeNotepad(key, secondGen, "successor notes", secondId);
    await first.store.seed(secondId, secondGen, [{ idx: 1, message: messages[0], actor: "slack:fixture" }], key);
    await first.store.step(
      secondId,
      secondGen,
      { step: 0, seq: 0, turnIndex: 1, inFlight: [], inboxConsumedSeq: 0, remainingMs: 600000, turn: 0, iteration: 0 },
      [],
      key,
    );
    const secondSource = await first.store.verifyExpectedSeed(key, ref);
    expect(secondSource).toMatchObject({ kind: "verified", receipt: { runId: secondId, from: 1, through: 1 } });
    expect(await first.store.readExpectedSeed(key, first.ref)).toEqual(firstReleased);
    const secondConfirmed = await first.store.confirmPromotion(ref);
    expect(secondConfirmed).toMatchObject({ kind: "confirmed", receipt: { runId: secondId, budgetMs: 600000 } });
    expect(await first.store.releaseExpectedSeed(key, ref)).toMatchObject({
      kind: "verified",
      release: { phase: "released" },
    });
    const revision = await first.store.custodyPinRevision(key);
    await first.store.retainRangePinsIfRevision(key, revision!, []);
    expect(first.store.sessions.get(key)?.rangePins?.[id]).toContainEqual({ from: 0, to: 0 });
    expect(first.store.sessions.get(key)?.rangePins?.[secondId]).toContainEqual({ from: 1, to: 1 });
    expect(await first.store.readExpectedSeed(key, first.ref)).toEqual(firstReleased);
    const alias = { ...ref, bodySha256: first.ref.bodySha256, expectedSeedSha256: first.ref.expectedSeedSha256 };
    expect(await first.store.readExpectedSeed(key, alias)).toMatchObject({ kind: "held" });
  });
  it("confirmation without known source release remains outside reclaim handoff and terminal cleanup", async () => {
    const { store, ref } = await ready();
    expect((await store.confirmPromotion(ref)).kind).toBe("confirmed");
    const row = structuredClone(store.live.get(id));
    expect(await store.reclaim("gen-NEXT", 100000, 30000)).toEqual([]);
    expect(await store.handoff(gen, [id])).toEqual({ marked: [] });
    await expect(store.finishing(id, gen)).rejects.toMatchObject({ name: "PromotionPendingError" });
    await expect(store.abandon(id, gen)).rejects.toMatchObject({ name: "PromotionPendingError" });
    expect(store.live.get(id)).toEqual(row);
  });
});
