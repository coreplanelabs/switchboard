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
    currentIdentityRead: async (source) => (source.issuer === identity.issuer ? "allowed" : "denied"),
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
  it("ignores idle reconciliation during reset capture and verification while detecting access and identity changes", async () => {
    const initial = client();
    const source = env.ORGANIZATIONS.get(env.ORGANIZATIONS.idFromName(`organization:v1:${initial.installation}`));
    const preview = await source.resetSettings("preview");
    const idle = async (store: WorkerOrganizationStore) => {
      const claimed = await store.execute({
        action: "claim",
        organization: "org:test",
        owner: "idle-process",
        leaseMs: 30_000,
      });
      if (claimed.status !== "state" || !claimed.state.lease) throw new Error("idle claim unavailable");
      expect(
        await store.execute({
          action: "complete",
          organization: "org:test",
          owner: "idle-process",
          generation: claimed.state.lease.generation,
          through: claimed.state.lease.through,
        }),
      ).toMatchObject({ status: "state" });
    };
    await idle(initial.store);
    expect(await source.resetSettings("preview")).toEqual(preview);
    await idle(initial.store);
    const operation = crypto.randomUUID();
    const captured = await source.resetSettings("freeze", operation);
    expect(captured).toEqual(preview);
    const replacement = client();
    const target = env.ORGANIZATIONS.get(env.ORGANIZATIONS.idFromName(`organization:v1:${replacement.installation}`));
    if (!("tables" in captured)) throw new Error("snapshot unavailable");
    expect(await target.resetSettings("restore", operation, captured)).toEqual(captured);
    await idle(replacement.store);
    expect(await target.resetSettings("preview")).toEqual(captured);
    expect(await target.resetSettings("verify", operation)).toEqual({ operation, phase: "verified" });
    expect(
      await replacement.store.execute({ action: "access", organization: "org:test", identity, allowed: false }),
    ).toEqual({ status: "ok", removed: 0 });
    const accessChanged = await target.resetSettings("preview");
    expect(accessChanged).not.toEqual(captured);
    const person = await replacement.store.directory.createPerson();
    if (person.status !== "created") throw new Error("person unavailable");
    expect(
      await replacement.store.directory.change({
        action: "link",
        identity: { ...identity, subject: "bob" },
        personId: person.person.id,
        expectedRevision: 0,
        actor: identity,
        proof: { method: "dual-authentication", version: 1 },
      }),
    ).toMatchObject({ status: "changed" });
    expect(await target.resetSettings("preview")).not.toEqual(accessChanged);
  });
  it("preserves identity and access cutoffs through a reset while discarding history and leases", async () => {
    const initial = client();
    await initial.store.execute({ action: "claim", organization: "org:test", owner: "old-process", leaseMs: 30_000 });
    const source = env.ORGANIZATIONS.get(env.ORGANIZATIONS.idFromName(`organization:v1:${initial.installation}`));
    await runInDurableObject(source, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE organization_rows SET body = json_set(body, '$.streamSequence', 100, '$.wakeSequence', 3, '$.reconciledSequence', 1) WHERE kind = 'state'",
      );
    });
    const created = await initial.store.directory.createPerson();
    if (created.status !== "created") throw new Error("person unavailable");
    const peer = { ...identity, subject: "bob" };
    for (const sourceIdentity of [identity, peer])
      expect(
        await initial.store.directory.change({
          action: "link",
          identity: sourceIdentity,
          personId: created.person.id,
          expectedRevision: 0,
          actor: sourceIdentity,
          proof: { method: "dual-authentication", version: 1 },
        }),
      ).toMatchObject({ status: "changed" });
    const operation = crypto.randomUUID();
    const beforeIdle = await source.resetSettings("preview");
    const idleState = await initial.store.execute({ action: "get", organization: "org:test" });
    if (idleState.status !== "state" || !idleState.state.lease) throw new Error("original lease unavailable");
    expect(
      await initial.store.execute({
        action: "complete",
        organization: "org:test",
        owner: "old-process",
        generation: idleState.state.lease.generation,
        through: idleState.state.lease.through,
      }),
    ).toMatchObject({ status: "state" });
    expect(await source.resetSettings("preview")).toEqual(beforeIdle);
    const snapshot = await source.resetSettings("freeze", operation);
    expect(snapshot).toEqual(beforeIdle);
    expect(await initial.store.directory.createPerson()).toEqual({ status: "unavailable" });
    const replacement = client();
    const target = env.ORGANIZATIONS.get(env.ORGANIZATIONS.idFromName(`organization:v1:${replacement.installation}`));
    if (!snapshot || !("tables" in snapshot)) throw new Error("snapshot unavailable");
    expect(await target.resetSettings("restore", operation, snapshot)).toEqual(snapshot);
    expect(await replacement.store.directory.resolve(peer)).toMatchObject({
      status: "bound",
      binding: { personId: created.person.id },
    });
    expect(await replacement.store.execute({ action: "get", organization: "org:test" })).toMatchObject({
      status: "state",
      state: { streamSequence: 100, wakeSequence: 0, reconciledSequence: 0, lease: null, laneCursor: null },
    });
    const startup = await replacement.store.execute({
      action: "claim",
      organization: "org:test",
      owner: "startup",
      leaseMs: 30_000,
    });
    if (startup.status !== "state" || !startup.state.lease) throw new Error("startup lease unavailable");
    expect(
      await replacement.store.execute({
        action: "complete",
        organization: "org:test",
        owner: "startup",
        generation: startup.state.lease.generation,
        through: startup.state.lease.through,
      }),
    ).toMatchObject({ status: "state" });
    expect(await target.resetSettings("preview")).toEqual(snapshot);
    const issued = await replacement.service.issue(auth, 30_000);
    if (issued.status !== "key") throw new Error("key unavailable");
    const admitted = await replacement.service.admit(auth, {
      key: issued.key,
      sourceEvent: "after-reset",
      content: "New request",
      destination: { kind: "broad" },
      workload: "message",
      target: null,
      context: [],
    });
    if (admitted.status !== "receipt") throw new Error("receipt unavailable");
    const claimed = await replacement.store.execute({
      action: "claim",
      organization: "org:test",
      owner: "new-process",
      leaseMs: 30_000,
    });
    if (claimed.status !== "state" || !claimed.state.lease) throw new Error("lease unavailable");
    expect(
      await replacement.store.execute({
        action: "settle",
        organization: "org:test",
        owner: "new-process",
        generation: claimed.state.lease.generation,
        receiptId: admitted.receipt.id,
        status: "accepted",
        ownerRunId: "new-run",
        reason: null,
        reply: "New answer",
        contentTtlMs: 90_000,
      }),
    ).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
    const tail = await replacement.service.streamTail({ ...auth, identity: peer });
    expect(
      tail.status === "stream_tail"
        ? tail.entries.map((entry) => ({ sequence: entry.sequence, content: entry.content }))
        : null,
    ).toEqual([
      { sequence: 101, content: "New request" },
      { sequence: 102, content: "New answer" },
    ]);
  });
  it("keeps pre-link requests and their late replies private through native SQLite client replacement", async () => {
    for (const delivery of ["settlement", "owner"] as const) {
      const initial = client();
      const person = await initial.store.directory.createPerson();
      if (person.status !== "created") throw new Error("no person");
      const peer = { ...identity, subject: "bob" };
      const link = async (source: typeof identity) => {
        expect(
          await initial.store.directory.change({
            action: "link",
            identity: source,
            personId: person.person.id,
            expectedRevision: 0,
            actor: source,
            proof: { method: "dual-authentication", version: 1 },
          }),
        ).toMatchObject({ status: "changed" });
      };
      await link(identity);
      const send = async (content: string) => {
        const issued = await initial.service.issue(auth, 30_000);
        if (issued.status !== "key") throw new Error("no key");
        const receipt = await initial.service.admit(auth, {
          key: issued.key,
          sourceEvent: content,
          content,
          destination: { kind: "broad" },
          workload: "message",
          target: null,
          context: [],
        });
        if (receipt.status !== "receipt") throw new Error("no receipt");
        return receipt.receipt;
      };
      const finish = async (receipt: Awaited<ReturnType<typeof send>>, content: string) => {
        const claimed = await initial.store.execute({
          action: "claim",
          organization: "org:test",
          owner: "process",
          leaseMs: 30_000,
        });
        if (claimed.status !== "state" || !claimed.state.lease) throw new Error("no lease");
        const lease = { organization: "org:test", owner: "process", generation: claimed.state.lease.generation };
        expect(
          await initial.store.execute({
            action: "settle",
            ...lease,
            receiptId: receipt.id,
            status: "accepted",
            ownerRunId: `owner:${receipt.id}`,
            reason: null,
            reply: delivery === "settlement" ? content : null,
            contentTtlMs: 90_000,
          }),
        ).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
        await initial.store.execute({ action: "complete", ...lease, through: claimed.state.lease.through });
        if (delivery === "owner")
          expect(
            await initial.store.execute({
              action: "reply",
              organization: "org:test",
              receiptId: receipt.id,
              actor: receipt.actor,
              ownerRunId: `owner:${receipt.id}`,
              replyKey: "answer",
              digest: "a".repeat(64),
              content,
              contentTtlMs: 90_000,
            }),
          ).toEqual({ status: "ok", removed: 0 });
      };
      const old = await send("Private pre-link request");
      await link(peer);
      await finish(old, "Private late answer");
      await finish(await send("Future request"), "Future answer");
      const replacement = client(initial.installation);
      const peerAuth = { ...auth, identity: peer };
      const peerRead = await replacement.service.streamTail(peerAuth);
      expect(peerRead.status === "stream_tail" ? peerRead.entries.map((entry) => entry.content) : null).toEqual([
        "Future request",
        "Future answer",
      ]);
      const own = await replacement.service.streamTail(auth);
      expect(own.status === "stream_tail" ? own.entries.map((entry) => entry.content) : null).toEqual([
        "Private pre-link request",
        "Private late answer",
        "Future request",
        "Future answer",
      ]);
    }
  });
  it("reads the latest private page and persists original-owner replies after the lease ends", async () => {
    const { service, store } = client();
    let first: { receiptId: string; actor: OrganizationEnvelope["actor"] } | undefined;
    for (let index = 1; index <= 3; index++) {
      const issued = await service.issue(auth, 30_000);
      if (issued.status !== "key") throw new Error("key unavailable");
      const admitted = await service.admit(auth, {
        key: issued.key,
        sourceEvent: `latest-${index}`,
        content: `Message ${index}`,
        destination: { kind: "broad" },
        workload: "message",
        target: null,
        context: [],
      });
      if (admitted.status !== "receipt") throw new Error("not admitted");
      if (!first) first = { receiptId: admitted.receipt.id, actor: admitted.receipt.actor };
      const claimed = await store.execute({
        action: "claim",
        organization: "org:test",
        owner: "process",
        leaseMs: 30_000,
      });
      if (claimed.status !== "state" || !claimed.state.lease) throw new Error("not claimed");
      const lease = { organization: "org:test", owner: "process", generation: claimed.state.lease.generation };
      expect(
        await store.execute({
          action: "settle",
          ...lease,
          receiptId: admitted.receipt.id,
          status: "accepted",
          ownerRunId: `original-${index}`,
          reason: null,
          reply: null,
          contentTtlMs: 90_000,
        }),
      ).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
      await store.execute({ action: "complete", ...lease, through: claimed.state.lease.through });
    }
    if (!first) throw new Error("no first receipt");
    const reply = {
      action: "reply" as const,
      organization: "org:test",
      receiptId: first.receiptId,
      actor: first.actor,
      ownerRunId: "original-1",
      replyKey: "result",
      digest: "a".repeat(64),
      content: "Original result",
      contentTtlMs: 90_000,
    };
    expect(await store.execute(reply)).toEqual({ status: "ok", removed: 0 });
    expect(await store.execute(reply)).toEqual({ status: "ok", removed: 0 });
    expect(await service.streamTail(auth, 2)).toMatchObject({
      status: "stream_tail",
      entries: [
        { sequence: 3, content: "Message 3" },
        { sequence: 4, content: "Original result" },
      ],
      cursor: 4,
      beforeCursor: 3,
      hasMore: true,
    });
    expect(await service.delete(auth, first.receiptId)).toEqual({ status: "ok", removed: 2 });
    expect(await store.execute({ ...reply, replyKey: "late" })).toEqual({ status: "not_found" });
    expect(await store.execute({ action: "owner-clears", organization: "org:test", limit: 10 })).toMatchObject({
      status: "owner-clears",
      items: [{ receiptId: first.receiptId }],
    });
    expect(await service.streamTail(auth, 2)).toMatchObject({
      status: "stream_tail",
      entries: [{ content: "Message 2" }, { content: "Message 3" }],
      hasMore: false,
    });
  });
  it("retains operation-bound account notices across client replacement and acknowledges only the addressed Slack notice", async () => {
    const first = client();
    const now = Date.now();
    const owner = {
      identity,
      audience: "app-test",
      browserHash: "b".repeat(64),
      proofVersion: 1,
      organization: "org:test",
      expiresAt: now + 90_000,
    };
    const policy = { tenant: "team-test", audience: "client-test", callbackUri: "https://app.test/callback" };
    const began = await first.store.directory.link({
      action: "begin",
      auth: owner,
      accessRevision: 0,
      organization: "org:test",
      operation: { kind: "link", target: "slack" },
      slackPolicy: policy,
      stateHash: "c".repeat(64),
      nonceHash: "d".repeat(64),
      expiresAt: now + 90_000,
      resultExpiresAt: now + 180_000,
    });
    expect(began.status).toBe("ok");
    if (began.status !== "ok") throw new Error("No operation");
    const id = began.intent.id;
    expect(
      await first.store.directory.link({
        action: "claim",
        id,
        auth: owner,
        expectedRevision: 1,
        stateHash: "c".repeat(64),
      }),
    ).toMatchObject({ status: "claimed" });
    const slack = { issuer: "https://slack.com", tenant: "team-test", subject: "member-test" };
    expect(
      await first.store.directory.link({
        action: "prove",
        id,
        auth: owner,
        expectedRevision: 2,
        proof: {
          identity: slack,
          audience: policy.audience,
          callbackUri: policy.callbackUri,
          nonceHash: "d".repeat(64),
          expiresAt: now + 90_000,
          expectedRevision: 0,
        },
      }),
    ).toMatchObject({ status: "ok", intent: { state: "awaiting-consent" } });
    const commit = { action: "commit" as const, id, auth: owner, expectedRevision: 3, consent: true };
    const outcome = await first.store.directory.link(commit);
    expect(outcome).toMatchObject({
      status: "committed",
      receipt: { operation: { kind: "link", target: "slack" }, outcome: "created" },
    });
    if (outcome.status !== "committed") throw new Error("No account outcome");
    const replacement = client(first.installation);
    expect(await replacement.store.directory.link(commit)).toEqual(outcome);
    const binding = await replacement.store.directory.resolve(identity);
    expect(binding).toMatchObject({ status: "bound", binding: { personId: outcome.receipt.personId, revision: 1 } });
    const notices = await replacement.store.directory.link({ action: "notices", auth: owner });
    expect(notices.status).toBe("notices");
    if (notices.status !== "notices") throw new Error("No addressed notices");
    expect(
      notices.notices.map((row) => ({ id: row.id, identity: row.identity, deliveredAt: row.deliveredAt })),
    ).toEqual([
      { id: `${id}:access`, identity, deliveredAt: null },
      { id: `${id}:slack`, identity: slack, deliveredAt: null },
    ]);
    expect(await replacement.store.directory.pendingNotices!("org:test", 1)).toMatchObject({
      status: "notices",
      notices: [{ id: `${id}:slack` }],
    });
    expect(await replacement.store.directory.markNoticeAttempted!("org:test", `${id}:slack`)).toEqual({
      status: "attempted",
    });
    expect(await client(first.installation).store.directory.pendingNotices!("org:test", 1)).toMatchObject({
      status: "notices",
      notices: [{ id: `${id}:slack`, attempts: 1 }],
    });
    expect(await replacement.store.directory.markNoticeDelivered!("org:test", `${id}:access`)).toEqual({
      status: "not_found",
    });
    expect(await replacement.store.directory.markNoticeDelivered!("org:test", `${id}:slack`)).toEqual({
      status: "delivered",
    });
    expect(await client(first.installation).store.directory.markNoticeDelivered!("org:test", `${id}:slack`)).toEqual({
      status: "delivered",
    });
    expect(await replacement.store.directory.pendingNotices!("org:test", 1)).toEqual({
      status: "notices",
      notices: [],
    });
    expect(await replacement.store.directory.link({ action: "notices", auth: owner })).toMatchObject({
      status: "notices",
      notices: [{ id: `${id}:access`, deliveredAt: null }],
    });
    expect(await replacement.store.directory.resolve(identity)).toEqual(binding);
  });
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
    const peer = { ...identity, subject: "peer" };
    expect(
      await replacement.store.directory.change({
        action: "link",
        identity: peer,
        personId: person.person.id,
        expectedRevision: 0,
        actor: identity,
        proof: { method: "dual-authentication", version: 1 },
      }),
    ).toMatchObject({ status: "changed" });
    const peerAuth = { ...auth, identity: peer };
    const peerKey = await replacement.service.issue(peerAuth, 30_000);
    if (peerKey.status !== "key") throw new Error("peer key unavailable");
    expect(
      await replacement.service.admit(peerAuth, {
        ...input,
        key: peerKey.key,
        sourceEvent: "peer-private-send",
        content: "Former peer private request",
      }),
    ).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
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
    const retainedOwn = await replacement.service.stream(auth);
    expect(retainedOwn.status).toBe("stream");
    if (retainedOwn.status !== "stream") throw new Error("own source stream unavailable");
    expect(retainedOwn.entries.map((entry) => ({ content: entry.content, identity: entry.identity }))).toEqual([
      { content: "Private request", identity },
    ]);
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
