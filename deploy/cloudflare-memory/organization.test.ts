import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OrganizationEnvelope } from "../../src/core/organization/contract.js";
import { WorkerOrganizationStore } from "../../src/core/organization/worker.js";
import { OrganizationService } from "../../src/core/organization/service.js";
import { fetchMemoryTest } from "./testFetch.ts";
const identity = { issuer: "access:test", tenant: null, subject: "alice" };
const auth = { source: "browser" as const, identity, kind: "human" as const };
function client(installation = crypto.randomUUID()) {
  const store = new WorkerOrganizationStore({
    baseUrl: "https://memory.test",
    token: "test-token",
    installation,
    fetch: async (input, init) =>
      fetchMemoryTest(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init),
  });
  const service = new OrganizationService({
    store,
    directory: store.directory,
    mappings: [{ source: "browser", issuer: "access:test", tenant: null, organization: "org:test" }],
    limits: {
      pendingPerActor: 3,
      pendingPerSource: 10,
      pendingPerOrganization: 20,
      reservedReconciliation: 1,
      contentTtlMs: 90_000,
      receiptTtlMs: 365_000,
    },
    authorize: async () => true,
  });
  return { store, service, installation };
}
async function post(command: unknown, token = "test-token") {
  const body = JSON.stringify({ installation: crypto.randomUUID(), command });
  return fetchMemoryTest(
    "https://memory.test/organization/execute",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(body).length),
      },
      body,
    },
    async (response) => ({ status: response.status, body: await response.json() }),
  );
}
describe("OrganizationDO routes", () => {
  it("applies bearer and schema fences before storage", async () => {
    expect(await post({ action: "get", organization: "org:test" }, "wrong-token")).toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
    expect(await post({ action: "admit", envelope: { version: 2 }, limits: {} })).toEqual({
      status: 400,
      body: { status: "invalid" },
    });
    expect(await post({ action: "get", organization: "org:test" })).toMatchObject({
      status: 200,
      body: { status: "state", state: { orchestrator: "organization:org:test" } },
    });
  });
  it("keeps proved identities and private content across client replacement and fences revocation", async () => {
    const first = client();
    const person = await first.store.directory.createPerson();
    expect(person).toMatchObject({ status: "created" });
    if (person.status !== "created") throw new Error("person unavailable");
    expect(
      await first.store.directory.change({
        action: "link",
        identity,
        personId: person.person.id,
        expectedRevision: 0,
        actor: identity,
        proof: { method: "dual-authentication", version: 1 },
      }),
    ).toMatchObject({ status: "changed", binding: { revision: 1 } });
    const key = await first.service.issue(auth, 30_000);
    if (key.status !== "key") throw new Error("key unavailable");
    const input = {
      sourceEvent: "browser-send",
      key: key.key,
      destination: { kind: "broad" as const },
      workload: "message" as const,
      target: null,
      content: "Private request",
      context: [],
    };
    const receipt = await first.service.admit(auth, input);
    expect(receipt).toMatchObject({
      status: "receipt",
      receipt: { status: "pending", actor: { stream: person.person.id } },
    });
    const replacement = client(first.installation);
    expect(await replacement.service.admit(auth, input)).toEqual({ ...receipt, duplicate: true });
    expect(await replacement.service.stream(auth)).toMatchObject({
      status: "stream",
      entries: [{ content: "Private request", identity }],
    });
    expect(await client().service.stream(auth)).toMatchObject({ status: "stream", entries: [] });
    const resolved = await first.service.resolve(auth);
    if (!resolved) throw new Error("actor unavailable");
    expect(
      await replacement.store.directory.change({
        action: "revoke",
        identity,
        personId: person.person.id,
        expectedRevision: 1,
        actor: identity,
        proof: { method: "authenticated-human", version: 1 },
      }),
    ).toMatchObject({ status: "changed", binding: { revision: 2 } });
    expect(
      await first.store.execute({
        action: "stream",
        ...resolved,
        stream: person.person.id,
        identities: [identity],
        after: 0,
        limit: 10,
      }),
    ).toEqual({ status: "fenced" });
    expect(await replacement.service.stream(auth)).toEqual({ status: "not_found" });
  });
  it("refuses unknown stored schema versions without overwriting rows", async () => {
    const { store, installation } = client();
    expect(await store.execute({ action: "wake", organization: "org:test" })).toMatchObject({
      status: "state",
      state: { wakeSequence: 1 },
    });
    const stub = env.ORGANIZATIONS.get(env.ORGANIZATIONS.idFromName(`organization:v1:${installation}`));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE organization_rows SET body = json_set(body, '$.version', 2) WHERE kind = 'state'");
    });
    expect(await store.execute({ action: "wake", organization: "org:test" })).toEqual({ status: "unavailable" });
    const retained = await runInDurableObject(stub, (_instance, state) =>
      [...state.storage.sql.exec<{ body: string }>("SELECT body FROM organization_rows WHERE kind = 'state'")].map(
        (row) => JSON.parse(row.body),
      ),
    );
    expect(retained).toMatchObject([{ version: 2, wakeSequence: 1 }]);
  });
  it("rejects redaction growth without poisoning durable admission or settlement", async () => {
    const { store, service } = client();
    const oversized: OrganizationEnvelope = {
      version: 1,
      organization: "org:test",
      source: "http",
      sourceEvent: "direct-store",
      actor: {
        identity,
        kind: "human",
        principal: "access:alice",
        stream: "access:alice",
        bindingRevision: 0,
        onBehalfOf: null,
      },
      key: "expanded",
      digest: "a".repeat(64),
      destination: { kind: "broad" },
      workload: "message",
      target: null,
      content: "API_TOKEN=abcd\n".repeat(2000),
      context: [],
    };
    const limits = {
      pendingPerActor: 3,
      pendingPerSource: 10,
      pendingPerOrganization: 20,
      reservedReconciliation: 1,
      contentTtlMs: 90_000,
      receiptTtlMs: 365_000,
    };
    expect(await store.execute({ action: "admit", envelope: oversized, limits })).toEqual({ status: "invalid" });
    expect(
      await store.execute({
        action: "admit",
        envelope: {
          ...oversized,
          organization: "org:service",
          destination: { kind: "thread", thread: "unit:thread" },
          workload: "reconciliation",
          actor: { ...oversized.actor, kind: "service", stream: null },
        },
        limits,
      }),
    ).toEqual({ status: "invalid" });
    expect(await store.execute({ action: "get", organization: "org:test" })).toMatchObject({
      status: "state",
      state: { revision: 0, wakeSequence: 0, streamSequence: 0 },
    });
    const issued = await service.issue(auth, 30_000);
    if (issued.status !== "key") throw new Error("key unavailable");
    const admitted = await service.admit(auth, {
      sourceEvent: "safe-event",
      key: issued.key,
      destination: { kind: "broad" },
      workload: "message",
      target: null,
      content: "Safe instruction",
      context: [],
    });
    expect(admitted).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
    if (admitted.status !== "receipt") throw new Error("admission failed");
    await store.execute({ action: "claim", organization: "org:test", owner: "worker", leaseMs: 30_000 });
    const before = await store.execute({ action: "get", organization: "org:test" });
    const settle = {
      action: "settle" as const,
      organization: "org:test",
      owner: "worker",
      generation: 1,
      receiptId: admitted.receipt.id,
      status: "accepted" as const,
      reason: "Saved.",
      reply: "Safe reply",
      contentTtlMs: 90_000,
    };
    expect(await store.execute({ ...settle, reply: oversized.content })).toEqual({ status: "invalid" });
    expect(await store.execute({ ...settle, reason: "API_TOKEN=abcd ".repeat(136) })).toEqual({ status: "invalid" });
    expect(await store.execute({ action: "get", organization: "org:test" })).toEqual(before);
    expect(await store.execute(settle)).toMatchObject({
      status: "receipt",
      receipt: { status: "accepted", reason: "Saved." },
    });
    expect(await service.stream(auth)).toMatchObject({
      status: "stream",
      entries: [{ content: "Safe instruction" }, { content: "Safe reply" }],
    });
    expect(await service.delete(auth, admitted.receipt.id)).toEqual({ status: "ok", removed: 2 });
    expect(await store.execute({ action: "expire", organization: "org:test" })).toMatchObject({ status: "ok" });
    expect(await store.execute({ action: "get", organization: "org:test" })).toMatchObject({ status: "state" });
  });
  it("replays reordered logical payloads through the real Worker while preserving raw differences", async () => {
    const { service } = client();
    const issued = await service.issue(auth, 30_000);
    if (issued.status !== "key") throw new Error("key unavailable");
    const original = {
      sourceEvent: "ordered-event",
      key: issued.key,
      destination: { kind: "broad" as const },
      workload: "message" as const,
      target: null,
      content: "Raw API_TOKEN=abcd",
      context: [
        { kind: "unit" as const, key: "unit:one" },
        { kind: "run" as const, key: "run:one" },
      ],
    };
    const receipt = await service.admit(auth, original);
    expect(receipt).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
    const reordered = {
      context: [
        { key: "unit:one", kind: "unit" as const },
        { key: "run:one", kind: "run" as const },
      ],
      content: original.content,
      target: null,
      workload: "message" as const,
      destination: { kind: "broad" as const },
      key: issued.key,
      sourceEvent: "ordered-event",
    };
    expect(await service.admit(auth, reordered)).toEqual({ ...receipt, duplicate: true });
    expect(await service.admit(auth, { ...reordered, content: "Raw API_TOKEN=wxyz" })).toEqual({ status: "conflict" });
    expect(await service.admit(auth, { ...reordered, context: [...reordered.context].reverse() })).toEqual({
      status: "conflict",
    });
  });
});
