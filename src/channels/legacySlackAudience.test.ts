import { describe, expect, it } from "vitest";
import { createLegacySlackAudience } from "./legacySlackAudience.js";
import { createOrganizationAuthentication, type NativeOrganizationProof } from "./organizationAuthentication.js";
import { InMemoryOrganizationStore } from "../core/organization/memory.js";
import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";
import { InMemoryRunStore } from "../core/runStore.js";
import { InMemoryCoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import { InMemoryPrivateWorkerLog } from "../core/privateWorkerLog.js";
import { contextCapsuleOf } from "../core/dispatch/unitContext.js";
import { rehostPrivateWorkerIO, privateWorkerThreadKey } from "./privateWorker.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunRecord } from "../core/runRecord.js";
import type { CoordinatorInstance } from "../core/coordinator/contract.js";
import type { ChannelIO } from "../core/types.js";
import type { LegacySlackAudienceOptions } from "./legacySlackAudience.js";

async function fixture() {
  const ledger = new InMemoryRunLedger(() => 1000),
    runs = new InMemoryRunStore({ now: () => 1000 });
  const instances = new InMemoryCoordinatorInstanceStore(ledger);
  const instance: CoordinatorInstance = {
    id: "legacy-work",
    kind: "ship",
    userId: "slack:UALICE",
    channelId: "slack:D1",
    threadKey: "slack:D1:1",
    repo: "example/app",
    branch: "work",
    base: "main",
    merge: "person",
    plan: { id: "legacy" },
    createdAt: 1,
  };
  const unitKey = { instanceId: instance.id, unit: "U10" };
  const unit = {
    ...unitKey,
    slug: "legacy",
    branch: instance.branch,
    dependsOn: [],
    rounds: [],
    workBrief: {
      requesterId: instance.userId,
      mainThreadKey: instance.threadKey,
      actId: "legacy",
      repo: instance.repo,
      base: "main",
      question: "Why?",
      findings: [],
      requestedChange: "Fix it",
    },
    context: contextCapsuleOf({
      version: 1,
      source: {
        runId: "legacy-source",
        requester: instance.userId,
        channelId: instance.channelId,
        threadKey: instance.threadKey,
      },
      session: { key: `${instance.threadKey}:main`, from: 0, to: -1 },
      assets: [],
      notepad: { text: "Old lexical source must not be restored", updatedAt: 1, hash: "a".repeat(64) },
    }),
  };
  await instances.recordRequesterTurn({ requesterId: instance.userId, threadKey: instance.threadKey, messageId: "1" });
  expect(
    await instances.claimMainTask({ mainThreadKey: instance.threadKey, actId: "legacy" }, instance, unit, {
      requesterId: instance.userId,
      sourceMessageId: "1",
      revision: 1,
      repo: instance.repo,
    }),
  ).toMatchObject({ ok: true, created: true });
  const audience = {
    kind: "slack-unshared-im" as const,
    channelId: instance.channelId,
    userId: instance.userId,
    threadKey: instance.threadKey,
  };
  const record: RunRecord = {
    id: "legacy-source",
    userId: instance.userId,
    channelId: instance.channelId,
    threadKey: instance.threadKey,
    channelVisibility: "dm",
    directAudience: audience,
    repo: instance.repo,
    agent: "main",
    startedAt: 1,
    finishedAt: 2,
    status: "completed",
    eventCount: 1,
    storedEventCount: 1,
    truncated: false,
    diagnosis: analyzeRunFriction([]),
    events: [{ type: "input", messageId: "1", text: "Old lexical source must not be restored" }],
  };
  expect((await runs.put(record)).stored).toBe(true);
  const store = new InMemoryOrganizationStore(() => 1000);
  const identity = { issuer: "https://slack.com", tenant: "workspace", subject: "UALICE" };
  let proof: NativeOrganizationProof = {
    status: "verified",
    identity,
    actorId: instance.userId,
    kind: "human",
    organizationMember: true,
    privateSource: true,
    epoch: "fresh",
    directAudience: audience,
  };
  let repoAllowed = true,
    nativePrivate = true;
  const authentication = createOrganizationAuthentication({
    organization: "fixture",
    mappings: [{ source: "slack", ...identity, organization: "fixture" }],
    directory: store.directory,
    store,
    auth: () => ({ tokens: {} }),
    grantsFor: () => ({
      actions: new Set(["runs:read"]),
      channels: new Set(),
      repos: new Set(repoAllowed ? [instance.repo] : []),
    }),
    currentBrowser: async () => ({ status: "unavailable" }),
    currentSlack: async () => proof,
  });
  const posts: string[] = [];
  const native: ChannelIO = {
    reply: async (text) => {
      posts.push(text);
    },
    directAudience: () => audience,
    verifyDirectAudience: async () => (nativePrivate ? { ok: true } : { ok: false, code: "direct-audience-denied" }),
    history: async () => {
      throw new Error("Native source history must not be read");
    },
    status: async () => ({ update() {}, done: async () => {} }),
  };
  const options: LegacySlackAudienceOptions = {
    organization: "fixture",
    ledger,
    runs,
    instances,
    authenticate: (address) => authentication.resolveNative({ ...address, text: "" }, { source: "slack", identity }),
    addressIO: async () => native,
  };
  const origin = { sourceRunId: record.id, unitKey, userId: instance.userId, threadKey: instance.threadKey };
  return {
    origin,
    options,
    record,
    runs,
    instances,
    unit,
    posts,
    audience,
    revoke: () => {
      repoAllowed = false;
    },
    revokeNative: () => {
      proof = { status: "fenced" };
    },
    share: () => {
      nativePrivate = false;
    },
  };
}

describe("legacy private Slack recipient restoration", () => {
  it("rehosts only the original claimed worker and recipient without restoring source history", async () => {
    const f = await fixture();
    const helper = createLegacySlackAudience(f.options);
    const recipient = await helper.recipient(f.origin);
    expect(recipient?.actor.id).toBe("slack:UALICE");
    expect(await recipient?.verify()).toEqual({ ok: true });
    await recipient!.io.reply("Original unit needs your answer");
    expect(f.posts).toEqual(["Original unit needs your answer"]);
    await expect(recipient!.io.history()).rejects.toThrow("Original source history is not restored");
    expect(recipient!.io.openThread).toBeUndefined();
    expect(recipient!.io.rehostOrganizationInput).toBeUndefined();
    const log = new InMemoryPrivateWorkerLog();
    const thread = privateWorkerThreadKey(f.origin.unitKey);
    await log.append(thread, { kind: "reply", text: "Owned unit result", at: 2 });
    const worker = rehostPrivateWorkerIO(log, f.origin.unitKey, {
      clock: () => 1000,
      currentInputId: "original-worker",
      instances: f.instances,
      ioFor: (origin) =>
        origin.sourceRunId && origin.unitKey
          ? helper.restore({ ...origin, sourceRunId: origin.sourceRunId, unitKey: origin.unitKey })
          : undefined,
    });
    expect(await worker.history()).toEqual([{ role: "assistant", text: "Owned unit result", at: 2 }]);
    expect(await worker.privateWorkerDestination?.()).toEqual(f.audience);
    f.revoke();
    expect(await recipient!.verify()).toEqual({ ok: false, code: "direct-audience-unavailable" });
    await expect(recipient!.io.reply("Forbidden late reply")).rejects.toThrow(
      "original private recipient is unavailable",
    );
    await expect(worker.history()).rejects.toThrow("private worker audience unavailable");
    expect(f.posts).toEqual(["Original unit needs your answer"]);
  });

  it("refuses revoked native facts, a shared destination, mismatched address or claim and relayed source", async () => {
    const f = await fixture();
    const helper = createLegacySlackAudience(f.options);
    expect((await helper.recipient(f.origin))?.actor.id).toBe("slack:UALICE");
    expect(await helper.restore({ ...f.origin, userId: "slack:UBOB" })).toBeUndefined();
    expect(await helper.restore({ ...f.origin, threadKey: "slack:D1:2" })).toBeUndefined();
    expect(await helper.restore({ ...f.origin, unitKey: { ...f.origin.unitKey, unit: "U11" } })).toBeUndefined();
    f.share();
    expect(await helper.restore(f.origin)).toBeUndefined();
    const revoked = await fixture();
    revoked.revokeNative();
    expect(await createLegacySlackAudience(revoked.options).restore(revoked.origin)).toBeUndefined();
    for (const change of [
      { authenticatedAs: "http:owner" },
      { postedBy: "slack:UWORKER" },
      { relayedBy: "worker" },
      { organizationIngressRunId: "modern-source" },
    ]) {
      const relayed = await fixture();
      const relayedHelper = createLegacySlackAudience(relayed.options);
      expect((await relayedHelper.recipient(relayed.origin))?.actor.id).toBe("slack:UALICE");
      expect(
        (
          await relayed.runs.put({
            ...relayed.record,
            ...change,
            ...("organizationIngressRunId" in change ? {} : { directAudience: undefined }),
          })
        ).stored,
      ).toBe(true);
      expect(await relayedHelper.restore(relayed.origin)).toBeUndefined();
    }
  });

  it("never falls back when modern ingress exists is fenced unavailable or unreadable", async () => {
    const f = await fixture();
    expect((await createLegacySlackAudience(f.options).recipient(f.origin))?.actor.id).toBe("slack:UALICE");
    for (const status of ["record", "fenced", "unavailable"] as const) {
      const ledger = {
        readIngressByRun: async () => ({ status }) as Awaited<ReturnType<typeof f.options.ledger.readIngressByRun>>,
      };
      expect(await createLegacySlackAudience({ ...f.options, ledger }).restore(f.origin)).toBeUndefined();
    }
    expect(
      await createLegacySlackAudience({
        ...f.options,
        ledger: {
          readIngressByRun: async () => {
            throw new Error("Store unavailable");
          },
        },
      }).restore(f.origin),
    ).toBeUndefined();
    expect(f.posts).toEqual([]);
  });
});
