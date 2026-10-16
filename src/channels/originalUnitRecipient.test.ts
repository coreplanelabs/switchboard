// Feature: docs/reference/specs/organization-orchestration.md — source-owned unit metadata survives identity projection changes.
import { describe, expect, it, vi } from "vitest";
import { ALL_GRANTS } from "../core/authz/grants.js";
import { NO_GRANTS, type Grants } from "../core/authz/types.js";
import { InMemoryOrganizationStore } from "../core/organization/memory.js";
import { OrganizationService } from "../core/organization/service.js";
import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";
import { InMemoryCoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import type { CoordinatorInstance, CoordinatorUnit } from "../core/coordinator/contract.js";
import { contextCapsuleOf } from "../core/dispatch/unitContext.js";
import { createOrganizationAuthentication, type NativeOrganizationProof } from "./organizationAuthentication.js";
import { createOriginalUnitRecipient } from "./originalUnitRecipient.js";

async function fixture() {
  let now = 1;
  const store = new InMemoryOrganizationStore(() => now),
    ledger = new InMemoryRunLedger(() => now);
  const coordinator = new InMemoryCoordinatorInstanceStore(ledger);
  const identity = { issuer: "https://slack.com", tenant: "team", subject: "UALICE" };
  const msg = {
    userId: "slack:UALICE",
    channelId: "slack:D1",
    threadKey: "slack:D1:1000.1",
    messageId: "1000.1",
    text: "Private source",
  };
  let currentProof: NativeOrganizationProof = {
    status: "verified",
    identity,
    actorId: msg.userId,
    kind: "human",
    organizationMember: true,
    privateSource: true,
    epoch: "native-1",
    directAudience: {
      kind: "slack-unshared-im",
      channelId: msg.channelId,
      userId: msg.userId,
      threadKey: msg.threadKey,
    },
  };
  let grants: Grants = ALL_GRANTS;
  const mappings = [
    { source: "slack" as const, issuer: identity.issuer, tenant: identity.tenant, organization: "org:test" },
  ];
  const authentication = createOrganizationAuthentication({
    organization: "org:test",
    mappings,
    grantsFor: () => grants,
    auth: () => ({ tokens: {} }),
    personalTokens: undefined,
    directory: store.directory,
    store,
    ledger,
    currentBrowser: async () => ({ status: "unavailable" }),
    currentSlack: async () => currentProof,
    channelsOf: async () => new Set([msg.channelId]),
    questionOwner: async () => ({ status: "unavailable" }),
  });
  const native = await authentication.resolveNative(msg, { source: "slack", identity });
  if (native.status !== "resolved") throw new Error("No native source");
  const auth = {
    ...native.authentication,
    sourceReference: {
      ...native.authentication.sourceReference!,
      privateSource: true as const,
      capturedPrivateEpoch: "a".repeat(64),
      sourceRepository: "sample/api",
    },
  };
  const organization = new OrganizationService({
    store,
    directory: store.directory,
    mappings,
    limits: {
      pendingPerActor: 3,
      pendingPerSource: 5,
      pendingPerOrganization: 10,
      reservedReconciliation: 1,
      contentTtlMs: 90,
      receiptTtlMs: 365,
    },
    authorize: async () => true,
    currentIdentityRead: async () => "allowed",
  });
  const admitted = await organization.admit(auth, {
    key: "original",
    sourceEvent: "1000.1",
    content: msg.text,
    context: [],
    target: null,
    destination: { kind: "broad" },
    workload: "message",
  });
  if (admitted.status !== "receipt") throw new Error("No admission");
  const resolved = await organization.resolve(auth);
  if (!resolved) throw new Error("No source actor");
  const saved = await store.execute({ action: "submission", ...resolved, source: "slack", key: "original" });
  if (saved.status !== "submission") throw new Error("No protected submission");
  const lease = { organization: "org:test", owner: "owner", generation: 1 };
  await store.execute({ action: "claim", organization: "org:test", owner: "owner", leaseMs: 100 });
  const effect = await store.execute({
    action: "effect",
    ...lease,
    source: "slack",
    key: "original",
    actor: resolved.actor,
  });
  if (effect.status !== "receipt" || !effect.receipt.effectKey) throw new Error("No effect owner");
  const origin = { ...saved.envelope, content: "", context: [] };
  const claimed = await ledger.consumeIngress({
    effectKey: effect.receipt.effectKey,
    digest: admitted.receipt.digest,
    requester: msg.userId,
    threadKey: msg.threadKey,
    request: { envelope: { ...origin, content: msg.text } },
    contentExpiresAt: 31,
    origin,
    originExpiresAt: admitted.receipt.expiresAt,
    receiptId: admitted.receipt.id,
  });
  if (claimed.status !== "claimed") throw new Error("No original source owner");
  const runId = claimed.record.runId;
  await ledger.finishIngress({
    effectKey: claimed.record.effectKey,
    digest: claimed.record.digest,
    runId,
    status: "completed",
    outcome: "Original source response completed",
  });
  await store.execute({
    action: "settle",
    ...lease,
    receiptId: admitted.receipt.id,
    status: "accepted",
    ownerRunId: runId,
    reason: null,
    reply: null,
    contentTtlMs: 90,
  });
  const instance: CoordinatorInstance = {
    id: "owned",
    kind: "ship",
    userId: msg.userId,
    channelId: msg.channelId,
    threadKey: msg.threadKey,
    repo: "sample/api",
    branch: "work",
    base: "main",
    merge: "person",
    plan: { id: "owned" },
    createdAt: 1,
    runId,
  };
  const unit: CoordinatorUnit = {
    instanceId: instance.id,
    unit: "U101",
    slug: "owned",
    branch: instance.branch,
    dependsOn: [],
    rounds: [],
    threadKey: "worker:owned:U101",
    workBrief: {
      requesterId: msg.userId,
      mainThreadKey: msg.threadKey,
      actId: "owned",
      repo: instance.repo,
      base: instance.base!,
      question: "A private question",
      findings: [],
      requestedChange: "Fix it",
    },
    context: contextCapsuleOf({
      version: 1,
      source: { runId, requester: msg.userId, channelId: msg.channelId, threadKey: msg.threadKey },
      session: { key: "source", from: 0, to: -1 },
      assets: [],
    }),
  };
  const messageId = `browser:${admitted.receipt.revision}:${encodeURIComponent(msg.messageId)}`;
  expect(
    await coordinator.recordRequesterTurn({ requesterId: msg.userId, threadKey: msg.threadKey, messageId }),
  ).toMatchObject({ ok: true });
  expect(
    await coordinator.claimMainTask({ mainThreadKey: msg.threadKey, actId: "owned" }, instance, unit, {
      requesterId: msg.userId,
      sourceMessageId: messageId,
      revision: 1,
      repo: instance.repo,
    }),
  ).toMatchObject({ ok: true });
  const recipient = createOriginalUnitRecipient({
    organizationId: "org:test",
    ledger,
    store,
    organization,
    coordinator,
    authentication,
    now: () => now,
  });
  return {
    recipient,
    store,
    ledger,
    coordinator,
    identity,
    instance,
    unit,
    origin,
    organization,
    key: { instanceId: instance.id, unit: unit.unit },
    runId,
    at(value: number) {
      now = value;
    },
    proof(value: NativeOrganizationProof) {
      currentProof = value;
    },
    denyCurrentOrg() {
      grants = NO_GRANTS;
      currentProof = { ...currentProof, organizationMember: false } as NativeOrganizationProof;
    },
  };
}
describe("original owned unit recipient", () => {
  it("reads the exact accepted unit after initial link and unlink without restoring source input or a joined reply sink", async () => {
    const h = await fixture();
    h.at(40);
    const source = await h.ledger.readIngressByRun(h.runId);
    expect(source).toMatchObject({ status: "record", record: { request: null } });
    const person = await h.store.directory.createPerson();
    if (person.status !== "created") throw new Error("No person");
    for (const identity of [h.identity, { issuer: "https://access.test", tenant: null, subject: "browser" }])
      expect(
        await h.store.directory.change({
          action: "link",
          identity,
          personId: person.person.id,
          expectedRevision: 0,
          actor: h.identity,
          proof: { method: "dual-authentication", version: 1 },
        }),
      ).toMatchObject({ status: "changed" });
    expect(await h.organization.authorizeReply(h.origin)).toBe(false);
    const recipient = await h.recipient.read(h.key);
    expect(recipient).toMatchObject({
      sourceRunId: h.runId,
      identity: h.identity,
      requesterId: "slack:UALICE",
      channelId: "slack:D1",
      threadKey: "slack:D1:1000.1",
      unitKey: h.key,
      actor: { id: "slack:UALICE", self: ["slack:UALICE"] },
    });
    expect(Object.keys(recipient!).sort()).toEqual([
      "actor",
      "channelId",
      "identity",
      "requesterId",
      "sourceRunId",
      "threadKey",
      "unitKey",
    ]);
    await h.store.directory.change({
      action: "revoke",
      identity: h.identity,
      personId: person.person.id,
      expectedRevision: 1,
      actor: h.identity,
      proof: { method: "dual-authentication", version: 1 },
    });
    expect(await h.recipient.read(h.key)).toMatchObject({
      actor: { id: "slack:UALICE", self: ["slack:UALICE"] },
      identity: h.identity,
    });
    expect(await h.organization.authorizeReply(h.origin)).toBe(false);
    h.proof({ status: "fenced" });
    expect(await h.recipient.read(h.key)).toBeUndefined();
  });
  it("refuses missing canonical ownership, expired attribution and lost current source permission", async () => {
    const h = await fixture();
    expect(await h.recipient.read({ instanceId: "foreign", unit: h.key.unit })).toBeUndefined();
    h.denyCurrentOrg();
    expect(await h.recipient.read(h.key)).toBeUndefined();
    const expired = await fixture();
    expired.at(367);
    expect(await expired.recipient.read(expired.key)).toBeUndefined();
  });
  it("withholds owned metadata when source permission changes during the canonical ownership recheck", async () => {
    const h = await fixture();
    const getMainTask = h.coordinator.getMainTask.bind(h.coordinator);
    let reads = 0;
    vi.spyOn(h.coordinator, "getMainTask").mockImplementation(async (key) => {
      const result = await getMainTask(key);
      if (++reads === 2) h.denyCurrentOrg();
      return result;
    });
    expect(await h.recipient.read(h.key)).toBeUndefined();
  });
});
