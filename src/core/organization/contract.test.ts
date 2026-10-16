import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteOrganizationStore } from "./sqlite.js";
import type { PersonDirectory } from "../identity/contract.js";
import type { DirectorySqlStorage } from "../identity/sqlite.js";
import { InMemoryOrganizationStore } from "./memory.js";
import { OrganizationService } from "./service.js";
import type { OrganizationEnvelope, OrganizationLimits, OrganizationStore } from "./contract.js";
import { nativeMediaDigest } from "../nativeMedia.js";

const identity = { issuer: "access:test", tenant: null, subject: "alice" };
const limits: OrganizationLimits = {
  pendingPerActor: 1,
  pendingPerSource: 3,
  pendingPerOrganization: 4,
  reservedReconciliation: 1,
  contentTtlMs: 90,
  receiptTtlMs: 365,
};
const envelope = (key = "message-1", subject = "alice"): OrganizationEnvelope => ({
  version: 1,
  organization: "org:test",
  source: "http",
  sourceEvent: key,
  actor: {
    identity: { ...identity, subject },
    kind: "human",
    principal: `access:${subject}`,
    stream: `access:${subject}`,
    bindingRevision: 0,
    onBehalfOf: null,
  },
  key,
  digest: "a".repeat(64),
  destination: { kind: "broad" },
  workload: "message",
  target: null,
  content: "Private request",
  context: [],
});
function organizationContract(
  factory: (now: () => number) => OrganizationStore & { directory: PersonDirectory },
  _name: string,
) {
  describe("organization store contract", () => {
    it("expires native pending manifests at the source deadline without shortening stream text or renewing receipts", async () => {
      let now = 1;
      const store = factory(() => now);
      const native = {
        ...envelope(),
        source: "slack" as const,
        sourceReference: {
          actorId: "slack:UALICE",
          userId: "slack:UALICE",
          channelId: "slack:D1",
          threadKey: "slack:D1:1",
          messageId: "1",
        },
      };
      const media = {
        version: 1 as const,
        channelId: "slack:D1",
        userId: "slack:UALICE",
        threadKey: "slack:D1:1",
        messageId: "1",
        rawTextDigest: "a".repeat(64),
        sourceFilesDigest: "b".repeat(64),
        files: [
          {
            id: "slack:file:F1",
            kind: "image" as const,
            slot: 0,
            index: 0,
            mediaType: "image/png",
            size: 12,
            representationDigest: "c".repeat(64),
          },
        ],
      };
      const value = { ...native, nativeMedia: media, nativeMediaDigest: await nativeMediaDigest(media) };
      const admitted = await store.execute({
        action: "admit",
        envelope: value,
        limits: { ...limits, sourceSnapshotTtlMs: 30 },
      });
      expect(admitted).toMatchObject({ status: "receipt", receipt: { createdAt: 1, expiresAt: 366 } });
      const claimed = await store.execute({
        action: "claim",
        organization: value.organization,
        owner: "lane",
        leaseMs: 100,
      });
      if (claimed.status !== "state" || !claimed.state.lease) throw new Error("No lease");
      const read = () =>
        store.execute({
          action: "pending",
          organization: value.organization,
          owner: "lane",
          generation: claimed.state.lease!.generation,
          limit: 10,
        });
      expect(await read()).toMatchObject({
        status: "pending",
        envelopes: [{ nativeMedia: media, contentExpiresAt: 31 }],
      });
      now = 31;
      expect(await read()).toMatchObject({ status: "pending", envelopes: [] });
      const submission = await store.execute({
        action: "submission",
        organization: value.organization,
        actor: value.actor,
        source: "slack",
        key: value.key,
      });
      expect(submission).toMatchObject({
        status: "submission",
        envelope: { nativeMediaDigest: value.nativeMediaDigest },
        receipt: { expiresAt: 366 },
      });
      if (submission.status !== "submission") throw new Error("No receipt");
      expect(submission.envelope.nativeMedia).toBeUndefined();
      expect(
        await store.execute({ action: "admit", envelope: value, limits: { ...limits, sourceSnapshotTtlMs: 300 } }),
      ).toMatchObject({ status: "receipt", duplicate: true, receipt: { expiresAt: 366 } });
      expect(await read()).toMatchObject({ status: "pending", envelopes: [] });
      expect(
        await store.execute({
          action: "stream",
          organization: value.organization,
          actor: value.actor,
          stream: value.actor.stream!,
          identities: [value.actor.identity],
          after: 0,
          limit: 10,
        }),
      ).toMatchObject({ status: "stream", entries: [{ content: "Private request", expiresAt: 91 }] });
    });
    it("keeps source deletion bounded and durable across joined partitions without exposing unprocessed copies", async () => {
      const store = factory(() => 1);
      const address = {
        source: "slack" as const,
        issuer: "https://slack.com" as const,
        tenant: "TLOCAL",
        channelId: "slack:DLOCAL",
        messageId: "1.000001",
      };
      const value: OrganizationEnvelope = {
        ...envelope(),
        source: "slack",
        actor: {
          identity: { issuer: address.issuer, tenant: address.tenant, subject: "UALICE" },
          kind: "human",
          principal: "slack:UALICE",
          stream: "slack:UALICE",
          bindingRevision: 0,
          onBehalfOf: null,
        },
        sourceReference: {
          actorId: "slack:UALICE",
          userId: "slack:UALICE",
          channelId: address.channelId,
          threadKey: "slack:DLOCAL:1.000000",
          messageId: address.messageId,
        },
        content: "Copied native words",
      };
      const increased = { ...limits, pendingPerActor: 200, pendingPerSource: 200, pendingPerOrganization: 300 };
      expect(
        await store.execute({ action: "admit", envelope: { ...value, key: "source-only" }, limits: increased }),
      ).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
      const created = await store.directory.createPerson();
      if (created.status !== "created") throw new Error("person unavailable");
      expect(
        await store.directory.change({
          action: "link",
          identity: value.actor.identity,
          personId: created.person.id,
          expectedRevision: 0,
          actor: value.actor.identity,
          proof: { method: "dual-authentication", version: 1 },
        }),
      ).toMatchObject({ status: "changed" });
      const joined = { ...value.actor, stream: created.person.id, bindingRevision: 1 };
      for (let i = 0; i < 101; i++)
        expect(
          await store.execute({
            action: "admit",
            envelope: { ...value, actor: joined, key: `copy-${i}` },
            limits: increased,
          }),
        ).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
      const command = { action: "delete-source" as const, organization: value.organization, address, ttlMs: 365 };
      expect(await store.execute(command)).toEqual({ status: "busy" });
      expect(
        await store.execute({
          action: "stream",
          organization: value.organization,
          actor: joined,
          stream: joined.stream,
          identities: [joined.identity],
          after: 0,
          limit: 200,
        }),
      ).toMatchObject({ status: "stream", entries: [] });
      expect(await store.execute({ action: "source-deletes", organization: value.organization, limit: 1 })).toEqual({
        status: "source-deletes",
        addresses: [address],
      });
      expect(await store.execute(command)).toMatchObject({ status: "ok" });
      expect(await store.execute({ action: "source-deletes", organization: value.organization, limit: 1 })).toEqual({
        status: "source-deletes",
        addresses: [],
      });
      expect(await store.execute({ action: "source-deletes", organization: value.organization, limit: 101 })).toEqual({
        status: "invalid",
      });
      expect(await store.execute(command)).toEqual({ status: "ok", removed: 0 });
    });
    it("erases only a verified native source message and keeps its original receipt and owner", async () => {
      const store = factory(() => 1);
      const source = {
        source: "slack" as const,
        issuer: "https://slack.com" as const,
        tenant: "TLOCAL",
        channelId: "slack:DLOCAL",
        messageId: "1.000001",
      };
      const value: OrganizationEnvelope = {
        ...envelope("slack-original"),
        source: "slack",
        actor: {
          identity: { issuer: source.issuer, tenant: source.tenant, subject: "UALICE" },
          kind: "human",
          principal: "slack:UALICE",
          stream: "slack:UALICE",
          bindingRevision: 0,
          onBehalfOf: null,
        },
        sourceReference: {
          actorId: "slack:UALICE",
          userId: "slack:UALICE",
          channelId: source.channelId,
          threadKey: "slack:DLOCAL:1.000000",
          messageId: source.messageId,
        },
        content: "Deleted source words",
      };
      const admitted = await store.execute({ action: "admit", envelope: value, limits });
      if (admitted.status !== "receipt") throw new Error("not admitted");
      const claimed = await store.execute({
        action: "claim",
        organization: value.organization,
        owner: "original",
        leaseMs: 30,
      });
      if (claimed.status !== "state" || !claimed.state.lease) throw new Error("not claimed");
      expect(
        await store.execute({
          action: "settle",
          organization: value.organization,
          owner: "original",
          generation: claimed.state.lease.generation,
          receiptId: admitted.receipt.id,
          status: "accepted",
          ownerRunId: "original-run",
          reason: null,
          reply: "Derived reply words",
          contentTtlMs: 90,
        }),
      ).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
      const other = {
        ...value,
        key: "other-message",
        sourceEvent: "other-message",
        content: "Retained neighbor words",
        sourceReference: { ...value.sourceReference!, messageId: "1.000002" },
      };
      expect(await store.execute({ action: "admit", envelope: other, limits })).toMatchObject({
        status: "receipt",
        receipt: { status: "pending" },
      });
      expect(
        await store.execute({
          action: "stream",
          organization: value.organization,
          actor: value.actor,
          stream: value.actor.stream!,
          identities: [value.actor.identity],
          after: 0,
          limit: 100,
        }),
      ).toMatchObject({
        status: "stream",
        entries: [
          { content: "Deleted source words" },
          { content: "Derived reply words" },
          { content: "Retained neighbor words" },
        ],
      });
      const command = {
        action: "delete-source" as const,
        organization: value.organization,
        address: source,
        ttlMs: 365,
      };
      expect(await store.execute({ ...command, address: { ...source, tenant: "TFOREIGN" } })).toEqual({
        status: "ok",
        removed: 0,
      });
      expect(await store.execute(command)).toEqual({ status: "ok", removed: 2 });
      expect(await store.execute(command)).toEqual({ status: "ok", removed: 0 });
      expect(
        await store.execute({
          action: "delete",
          organization: value.organization,
          actor: value.actor,
          stream: value.actor.stream!,
          receiptId: admitted.receipt.id,
        }),
      ).toEqual({ status: "ok", removed: 0 });
      expect(
        await store.execute({
          action: "stream",
          organization: value.organization,
          actor: value.actor,
          stream: value.actor.stream!,
          identities: [value.actor.identity],
          after: 0,
          limit: 100,
        }),
      ).toMatchObject({ status: "stream", entries: [{ content: "Retained neighbor words" }] });
      expect(await store.execute({ action: "admit", envelope: value, limits })).toMatchObject({
        status: "receipt",
        duplicate: true,
        receipt: { id: admitted.receipt.id, status: "accepted", ownerRunId: "original-run", digest: value.digest },
      });
      expect(
        await store.execute({
          action: "reply",
          organization: value.organization,
          receiptId: admitted.receipt.id,
          actor: value.actor,
          ownerRunId: "original-run",
          replyKey: "late",
          digest: "c".repeat(64),
          content: "Late deleted words",
          contentTtlMs: 90,
        }),
      ).toEqual({ status: "not_found" });
      expect(await store.execute({ action: "owner-clears", organization: value.organization, limit: 10 })).toEqual({
        status: "owner-clears",
        items: [
          {
            receiptId: admitted.receipt.id,
            effectKey: admitted.receipt.effectKey,
            expiresAt: admitted.receipt.expiresAt,
          },
        ],
      });
      expect(
        await store.execute({
          action: "owner-clears",
          organization: value.organization,
          sourceMessage: { ...source, messageId: "1.000002" },
          limit: 1,
        }),
      ).toEqual({ status: "owner-clears", items: [] });
      expect(
        await store.execute({
          action: "owner-clears",
          organization: value.organization,
          sourceMessage: source,
          limit: 1,
        }),
      ).toEqual({
        status: "owner-clears",
        items: [
          {
            receiptId: admitted.receipt.id,
            effectKey: admitted.receipt.effectKey,
            expiresAt: admitted.receipt.expiresAt,
          },
        ],
      });
      expect(
        await store.execute({
          action: "admit",
          envelope: { ...value, key: "late-event", sourceEvent: "late-event" },
          limits,
        }),
      ).toMatchObject({ status: "receipt", receipt: { status: "rejected", reason: "Source message deleted." } });
    });
    it("retains protected MCP form-connection metadata and refuses an unknown consent mode atomically", async () => {
      const store = factory(() => 1);
      const value: OrganizationEnvelope = {
        ...envelope("form-connection"),
        source: "mcp",
        actor: {
          identity: { issuer: "token:test", tenant: null, subject: "device" },
          kind: "service",
          principal: "mcp:device",
          stream: null,
          bindingRevision: 0,
          onBehalfOf: null,
        },
        sourceReference: {
          actorId: "mcp:device",
          userId: "mcp:device",
          channelId: "mcp:default",
          threadKey: "mcp:default:command",
          approvalConnection: {
            id: "a".repeat(64),
            credentialId: "mcp:device",
            requestHash: "b".repeat(64),
            mode: "form",
          },
        },
      };
      expect(await store.execute({ action: "admit", envelope: value, limits })).toMatchObject({
        status: "receipt",
        receipt: { status: "pending" },
      });
      expect(
        await store.execute({
          action: "submission",
          organization: value.organization,
          actor: value.actor,
          source: value.source,
          key: value.key,
        }),
      ).toMatchObject({
        status: "submission",
        envelope: { sourceReference: { approvalConnection: { mode: "form" } } },
      });
      expect(
        await store.execute({
          action: "admit",
          envelope: {
            ...value,
            key: "invalid-mode",
            sourceReference: {
              ...value.sourceReference!,
              approvalConnection: { ...value.sourceReference!.approvalConnection!, mode: "browser" as "form" },
            },
          },
          limits,
        }),
      ).toEqual({ status: "invalid" });
    });
    it("admits an unlinked delegated service into only its own source stream and fences its old revision after unlink", async () => {
      const store = factory(() => 1);
      const serviceIdentity = { issuer: "token:test", tenant: null, subject: "device-one" };
      const service = new OrganizationService({
        store,
        directory: store.directory,
        limits,
        mappings: [
          { source: "mcp", issuer: "token:test", tenant: null, organization: "org:test" },
          { source: "http", issuer: identity.issuer, tenant: null, organization: "org:test" },
        ],
        authorize: async () => true,
        currentIdentityRead: async () => "allowed",
      });
      const auth = {
        source: "mcp" as const,
        identity: serviceIdentity,
        kind: "service" as const,
        organizations: ["org:test"],
        onBehalfOf: identity,
      };
      const original = await service.resolve(auth);
      expect(original).toEqual({
        organization: "org:test",
        actor: {
          identity: serviceIdentity,
          kind: "service",
          principal: 'mcp:["token:test",null,"device-one"]',
          stream: 'mcp:["token:test",null,"device-one"]',
          bindingRevision: 0,
          onBehalfOf: identity,
        },
      });
      if (!original) throw new Error("No delegated source actor");
      const request = {
        key: "delegated-source",
        sourceEvent: "delegated-source",
        destination: { kind: "broad" as const },
        workload: "message" as const,
        target: null,
        content: "Device-only request",
        context: [],
      };
      const admitted = await service.admit(auth, request);
      expect(admitted).toMatchObject({
        status: "receipt",
        duplicate: false,
        receipt: { status: "pending", actor: original.actor },
      });
      if (admitted.status !== "receipt") throw new Error("No receipt");
      expect(await service.replay(auth, request)).toEqual({ ...admitted, duplicate: true });
      const human = { source: "http" as const, identity, kind: "human" as const, organizations: ["org:test"] };
      expect(
        await service.admit(human, { ...request, key: "human-peer", content: "Human-only request" }),
      ).toMatchObject({ status: "receipt" });
      const peer = { ...auth, identity: { ...serviceIdentity, subject: "device-two" } };
      expect(
        await service.admit(peer, { ...request, key: "device-peer", content: "Other-device request" }),
      ).toMatchObject({ status: "receipt" });
      for (const read of [
        await service.stream(auth),
        await service.streamTail(auth),
        await service.streamForIdentities(auth, [identity, peer.identity, serviceIdentity]),
      ])
        expect(read).toMatchObject({
          entries: [{ content: "Device-only request", identity: serviceIdentity, onBehalfOf: identity }],
        });
      const own = await service.stream(auth);
      if (own.status !== "stream") throw new Error("No private stream");
      expect(own.entries).toHaveLength(1);
      expect(await service.stream(human)).toMatchObject({
        status: "stream",
        entries: [{ content: "Human-only request" }],
      });
      expect(await service.stream(peer)).toMatchObject({
        status: "stream",
        entries: [{ content: "Other-device request" }],
      });
      const machine = { ...auth, onBehalfOf: undefined };
      expect(await service.resolve(machine)).toMatchObject({
        actor: { identity: serviceIdentity, kind: "service", stream: null },
      });
      expect(await service.stream(machine)).toEqual({ status: "not_found" });
      const person = await store.directory.createPerson();
      if (person.status !== "created") throw new Error("No person");
      expect(
        await store.directory.change({
          action: "link",
          identity,
          personId: person.person.id,
          expectedRevision: 0,
          actor: identity,
          proof: { method: "dual-authentication", version: 1 },
        }),
      ).toMatchObject({ status: "changed" });
      expect(
        await store.directory.change({
          action: "revoke",
          identity,
          personId: person.person.id,
          expectedRevision: 1,
          actor: identity,
          proof: { method: "dual-authentication", version: 1 },
        }),
      ).toMatchObject({ status: "changed" });
      expect(await service.resolve(auth)).toMatchObject({ actor: { ...original.actor, bindingRevision: 2 } });
      expect(
        await store.execute({
          action: "stream",
          organization: "org:test",
          actor: original.actor,
          stream: original.actor.stream!,
          identities: [identity],
          after: 0,
          limit: 10,
        }),
      ).toEqual({ status: "fenced" });
      expect(await service.streamTail(auth)).toMatchObject({
        status: "stream_tail",
        entries: [{ content: "Device-only request" }],
      });
      expect(await service.delete(human, admitted.receipt.id)).toEqual({ status: "not_found" });
      expect(await service.delete(auth, admitted.receipt.id)).toEqual({ status: "ok", removed: 1 });
    });
    it("retains only a delegated service's joined history after unlink without rehosting its original owner", async () => {
      const store = factory(() => 1);
      const person = await store.directory.createPerson();
      if (person.status !== "created") throw new Error("No person");
      expect(
        await store.directory.change({
          action: "link",
          identity,
          personId: person.person.id,
          expectedRevision: 0,
          actor: identity,
          proof: { method: "dual-authentication", version: 1 },
        }),
      ).toMatchObject({ status: "changed" });
      const service = new OrganizationService({
        store,
        directory: store.directory,
        limits,
        mappings: [
          { source: "mcp", issuer: "token:test", tenant: null, organization: "org:test" },
          { source: "http", issuer: identity.issuer, tenant: null, organization: "org:test" },
        ],
        authorize: async () => true,
        currentIdentityRead: async () => "allowed",
      });
      const auth = {
        source: "mcp" as const,
        identity: { issuer: "token:test", tenant: null, subject: "device" },
        kind: "service" as const,
        organizations: ["org:test"],
        onBehalfOf: identity,
      };
      const original = await service.resolve(auth);
      if (!original) throw new Error("No original actor");
      const request = {
        key: "joined-device",
        sourceEvent: "joined-device",
        destination: { kind: "broad" as const },
        workload: "message" as const,
        target: null,
        content: "Owned joined device request",
        context: [],
      };
      const own = await service.admit(auth, request);
      expect(own).toMatchObject({
        status: "receipt",
        receipt: { actor: { identity: auth.identity, stream: person.person.id, bindingRevision: 1 } },
      });
      if (own.status !== "receipt") throw new Error("No owned receipt");
      const peer = { source: "http" as const, identity, kind: "human" as const, organizations: ["org:test"] };
      expect(
        await service.admit(peer, { ...request, key: "joined-peer", content: "Former person's peer request" }),
      ).toMatchObject({ status: "receipt" });
      expect(await service.streamTail(auth)).toMatchObject({
        status: "stream_tail",
        entries: [{ content: "Owned joined device request" }, { content: "Former person's peer request" }],
      });
      expect(
        await store.execute({ action: "claim", organization: "org:test", owner: "worker", leaseMs: 100 }),
      ).toMatchObject({ status: "state" });
      expect(
        await store.execute({
          action: "settle",
          organization: "org:test",
          owner: "worker",
          generation: 1,
          receiptId: own.receipt.id,
          status: "accepted",
          ownerRunId: "original-service-run",
          reason: null,
          reply: null,
          contentTtlMs: 90,
        }),
      ).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
      expect(
        await store.directory.change({
          action: "revoke",
          identity,
          personId: person.person.id,
          expectedRevision: 1,
          actor: identity,
          proof: { method: "authenticated-human", version: 1 },
        }),
      ).toMatchObject({ status: "changed" });
      const current = await service.resolve(auth);
      expect(current).toMatchObject({ actor: { stream: 'mcp:["token:test",null,"device"]', bindingRevision: 2 } });
      if (!current) throw new Error("No current source actor");
      for (const actor of [original.actor, current.actor])
        expect(
          await store.execute({
            action: "execution",
            organization: "org:test",
            actor,
            receiptId: own.receipt.id,
            ownerRunId: "original-service-run",
          }),
        ).toEqual({ status: "fenced" });
      expect(await service.streamTail(auth)).toMatchObject({
        status: "stream_tail",
        entries: [{ content: "Owned joined device request", identity: auth.identity }],
      });
      expect(await service.delete(peer, own.receipt.id)).toEqual({ status: "not_found" });
      expect(await service.delete(auth, own.receipt.id)).toEqual({ status: "ok", removed: 1 });
    });
    it("retains only its exact source history and policy census after unlink without changing the original actor", async () => {
      const store = factory(() => 1);
      const peer = { ...identity, subject: "aardvark" };
      const person = await store.directory.createPerson();
      if (person.status !== "created") throw new Error("No person");
      for (const external of [identity, peer])
        expect(
          await store.directory.change({
            action: "link",
            identity: external,
            personId: person.person.id,
            expectedRevision: 0,
            actor: identity,
            proof: { method: "dual-authentication", version: 1 },
          }),
        ).toMatchObject({ status: "changed" });
      const service = new OrganizationService({
        store,
        directory: store.directory,
        limits,
        mappings: [{ source: "http", issuer: identity.issuer, tenant: null, organization: "org:test" }],
        authorize: async () => true,
        currentIdentityRead: async () => "allowed",
      });
      const auth = (external: typeof identity) => ({
        source: "http" as const,
        identity: external,
        kind: "human" as const,
        organizations: ["org:test"],
      });
      const request = (key: string, content: string) => ({
        key,
        sourceEvent: key,
        content,
        destination: { kind: "broad" as const },
        workload: "message" as const,
        target: null,
        context: [],
      });
      const own = await service.admit(auth(identity), request("own-before-unlink", "Own earlier source content"));
      expect(own).toMatchObject({
        status: "receipt",
        receipt: { status: "pending", actor: { stream: person.person.id, bindingRevision: 1 } },
      });
      if (own.status !== "receipt") throw new Error("No own receipt");
      expect(await service.admit(auth(peer), request("peer-before-unlink", "Peer private content"))).toMatchObject({
        status: "receipt",
      });
      expect(
        await store.directory.change({
          action: "revoke",
          identity,
          personId: person.person.id,
          expectedRevision: 1,
          actor: identity,
          proof: { method: "dual-authentication", version: 1 },
        }),
      ).toMatchObject({ status: "changed" });
      const current = await service.resolve(auth(identity));
      if (!current) throw new Error("No independent source");
      expect(await service.streamTail(auth(identity), 1)).toMatchObject({
        status: "stream_tail",
        entries: [{ content: "Own earlier source content", stream: person.person.id }],
        hasMore: false,
      });
      expect(await service.stream(auth(identity), 0, 10)).toMatchObject({
        status: "stream",
        entries: [{ content: "Own earlier source content" }],
      });
      const catalogue = await store.execute({ action: "source-catalogue", ...current, limit: 1, paged: true });
      expect(catalogue).toMatchObject({ status: "source-catalogue", entries: [{ actor: { identity } }] });
      if (catalogue.status !== "source-catalogue" || catalogue.revision === undefined)
        throw new Error("No complete census");
      expect(catalogue.entries).toHaveLength(1);
      expect(catalogue.next).toBeUndefined();
      expect(
        await store.execute({
          action: "source-policy-observe",
          ...current,
          expectedRevision: catalogue.revision,
          observations: catalogue.entries.map((row) => ({ authority: row.authority, fingerprint: "a".repeat(64) })),
        }),
      ).toMatchObject({ status: "source-policies-observed" });
      expect(await store.execute({ action: "provenance", ...current, receiptId: own.receipt.id })).toMatchObject({
        status: "provenance",
        provenance: { actor: own.receipt.actor },
      });
      expect(await service.delete(auth(peer), own.receipt.id)).toEqual({ status: "not_found" });
      expect(await service.delete(auth(identity), own.receipt.id)).toEqual({ status: "ok", removed: 1 });
    });
    it("keeps an accepted unlinked owner's receipt and source history unchanged when linking later", async () => {
      const store = factory(() => 1);
      const peer = { ...identity, subject: "peer" };
      const service = new OrganizationService({
        store,
        directory: store.directory,
        limits,
        mappings: [{ source: "http", issuer: identity.issuer, tenant: null, organization: "org:test" }],
        authorize: async () => true,
        currentIdentityRead: async () => "allowed",
      });
      const auth = (external: typeof identity) => ({
        source: "http" as const,
        identity: external,
        kind: "human" as const,
        organizations: ["org:test"],
      });
      const input = {
        key: "before-link",
        sourceEvent: "before-link",
        content: "Only original source input",
        destination: { kind: "broad" as const },
        workload: "message" as const,
        target: null,
        context: [],
      };
      const admitted = await service.admit(auth(identity), input);
      if (admitted.status !== "receipt") throw new Error("No receipt");
      const original = await service.resolve(auth(identity));
      if (!original) throw new Error("No actor");
      const pending = envelope("before-link");
      pending.actor = original.actor;
      pending.sourceEvent = input.sourceEvent;
      pending.content = input.content;
      pending.digest = admitted.receipt.digest;
      const lease = { organization: "org:test", owner: "worker", generation: 1 };
      expect(
        await store.execute({ action: "claim", organization: "org:test", owner: "worker", leaseMs: 100 }),
      ).toMatchObject({ status: "state" });
      expect(await service.authorizeEffect(pending, { owner: "worker", generation: 1 })).toBe(true);
      const accepted = await store.execute({
        action: "settle",
        ...lease,
        receiptId: admitted.receipt.id,
        status: "accepted",
        ownerRunId: "original-run",
        reason: null,
        reply: null,
        contentTtlMs: 90,
      });
      expect(accepted).toMatchObject({
        status: "receipt",
        receipt: { status: "accepted", ownerRunId: "original-run" },
      });
      expect(await service.authorizeReply(pending)).toBe(true);
      expect(
        await service.admit(auth(peer), {
          ...input,
          key: "peer-old",
          sourceEvent: "peer-old",
          content: "Do not inherit this history",
        }),
      ).toMatchObject({ status: "receipt" });
      const person = await store.directory.createPerson();
      if (person.status !== "created") throw new Error("No person");
      for (const external of [identity, peer])
        expect(
          await store.directory.change({
            action: "link",
            identity: external,
            personId: person.person.id,
            expectedRevision: 0,
            actor: identity,
            proof: { method: "dual-authentication", version: 1 },
          }),
        ).toMatchObject({ status: "changed" });
      expect(await service.stream(auth(identity), 0, 10)).toMatchObject({
        status: "stream",
        entries: [{ content: "Only original source input", stream: original.actor.stream }],
      });
      const replay = await service.replay(auth(identity), input);
      expect(replay).toMatchObject({
        status: "receipt",
        duplicate: true,
        receipt: { actor: original.actor, ownerRunId: "original-run" },
      });
      // The current host must preserve native owned-unit read rights separately;
      // old logical stream authority does not gain the new joined audience.
      expect(await service.authorizeReply(pending)).toBe(false);
    });
    it.each(["settlement", "owner"] as const)(
      "retains original source proof when a shorter-lived %s reply expires",
      async (delivery) => {
        let now = 1;
        const store = factory(() => now);
        const request = envelope("retained-original");
        const service = new OrganizationService({
          store,
          directory: store.directory,
          limits,
          mappings: [{ source: "http", issuer: identity.issuer, tenant: null, organization: "org:test" }],
          authorize: async () => true,
          currentIdentityRead: async () => "allowed",
        });
        const auth = { source: "http" as const, identity, kind: "human" as const, organizations: ["org:test"] };
        const resolved = await service.resolve(auth);
        if (!resolved) throw new Error("no actor");
        request.actor = resolved.actor;
        const admitted = await store.execute({
          action: "admit",
          envelope: request,
          limits: { ...limits, receiptTtlMs: 10 },
        });
        if (admitted.status !== "receipt") throw new Error("no receipt");
        const lease = { organization: "org:test", owner: "worker", generation: 1 };
        expect(
          await store.execute({ action: "claim", organization: lease.organization, owner: lease.owner, leaseMs: 100 }),
        ).toMatchObject({ status: "state", state: { lease: { generation: 1 } } });
        now = 2;
        expect(
          await store.execute({
            action: "settle",
            ...lease,
            receiptId: admitted.receipt.id,
            status: "accepted",
            reason: null,
            ownerRunId: "original-owner",
            reply: delivery === "settlement" ? "Short answer" : null,
            contentTtlMs: 10,
          }),
        ).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
        await store.execute({ action: "complete", ...lease, through: 1 });
        if (delivery === "owner")
          expect(
            await store.execute({
              action: "reply",
              organization: "org:test",
              receiptId: admitted.receipt.id,
              actor: request.actor,
              ownerRunId: "original-owner",
              replyKey: "short",
              digest: "b".repeat(64),
              content: "Short answer",
              contentTtlMs: 10,
            }),
          ).toEqual({ status: "ok", removed: 0 });
        now = 13;
        expect(await store.execute({ action: "expire", organization: "org:test" })).toMatchObject({ status: "ok" });
        for (const read of [
          await service.stream(auth),
          await service.streamTail(auth),
          await service.streamForIdentities(auth, [identity]),
        ]) {
          expect(
            read.status === "stream" || read.status === "stream_tail"
              ? read.entries.map((entry) => entry.content)
              : read.status,
          ).toEqual(["Private request"]);
        }
        now = 91;
        expect(await store.execute({ action: "expire", organization: "org:test" })).toMatchObject({ status: "ok" });
        expect(
          await store.execute({
            action: "provenance",
            organization: "org:test",
            actor: request.actor,
            receiptId: admitted.receipt.id,
          }),
        ).toEqual({ status: "not_found" });
      },
    );
    it.each(["settlement", "owner"] as const)(
      "keeps late %s replies behind their original admission's linking cutoff",
      async (delivery) => {
        const store = factory(() => 1);
        const person = await store.directory.createPerson();
        if (person.status !== "created") throw new Error("no person");
        const peer = { ...identity, subject: "bob" };
        const link = async (source: typeof identity) => {
          expect(
            await store.directory.change({
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
        const original = {
          ...envelope("before-link"),
          actor: { ...envelope().actor, stream: person.person.id, bindingRevision: 1 },
        };
        const admit = async (request: OrganizationEnvelope) => {
          const result = await store.execute({ action: "admit", envelope: request, limits });
          if (result.status !== "receipt") throw new Error("no receipt");
          return result.receipt;
        };
        const finish = async (request: OrganizationEnvelope, receiptId: string, reply: string) => {
          const claim = await store.execute({
            action: "claim",
            organization: request.organization,
            owner: "process",
            leaseMs: 30,
          });
          if (claim.status !== "state" || !claim.state.lease) throw new Error("no lease");
          const lease = {
            organization: request.organization,
            owner: "process",
            generation: claim.state.lease.generation,
          };
          expect(
            await store.execute({
              action: "settle",
              ...lease,
              receiptId,
              status: "accepted",
              reason: null,
              ownerRunId: `owner:${receiptId}`,
              reply: delivery === "settlement" ? reply : null,
              contentTtlMs: 90,
            }),
          ).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
          expect(
            await store.execute({ action: "complete", ...lease, through: claim.state.lease.through }),
          ).toMatchObject({ status: "state" });
          if (delivery === "owner")
            expect(
              await store.execute({
                action: "reply",
                organization: request.organization,
                receiptId,
                actor: request.actor,
                ownerRunId: `owner:${receiptId}`,
                replyKey: "answer",
                digest: "a".repeat(64),
                content: reply,
                contentTtlMs: 90,
              }),
            ).toEqual({ status: "ok", removed: 0 });
        };
        const old = await admit(original);
        await link(peer);
        await finish(original, old.id, "Private pre-link answer");
        const future = { ...original, key: "after-link", sourceEvent: "after-link", content: "Future request" };
        await finish(future, (await admit(future)).id, "Future answer");
        const service = new OrganizationService({
          store,
          directory: store.directory,
          limits,
          mappings: [{ source: "http", issuer: identity.issuer, tenant: null, organization: "org:test" }],
          authorize: async () => true,
          currentIdentityRead: async () => "allowed",
        });
        const auth = (source: typeof identity) => ({
          source: "http" as const,
          identity: source,
          kind: "human" as const,
          organizations: ["org:test"],
        });
        for (const read of [
          await service.stream(auth(peer)),
          await service.streamTail(auth(peer)),
          await service.streamForIdentities(auth(peer), [identity, peer]),
        ]) {
          expect(read.status).toMatch(/^stream(?:_tail)?$/);
          expect(
            read.status === "stream" || read.status === "stream_tail"
              ? read.entries.map((entry) => entry.content)
              : null,
          ).toEqual(["Future request", "Future answer"]);
        }
        const own = await service.streamTail(auth(identity));
        expect(own.status === "stream_tail" ? own.entries.map((entry) => entry.content) : null).toEqual([
          "Private request",
          "Private pre-link answer",
          "Future request",
          "Future answer",
        ]);
      },
    );
    it("catalogues complete source authorities without growing for ordinary messages and refuses a capped census", async () => {
      let now = 1;
      const store = factory(() => now);
      const send = async (key: string, digest: string) => {
        const input = envelope(key);
        input.sourceReference = {
          actorId: "http:alice",
          userId: "http:alice",
          channelId: "http:home",
          threadKey: "http:home:alice",
          messageId: key,
          browserRevision: key.length,
          credentialDigest: digest,
          approvalConnection: { id: digest, credentialId: "http:alice", requestHash: "d".repeat(64) },
        };
        const issued = await store.execute({
          action: "issue",
          organization: input.organization,
          source: input.source,
          actor: input.actor,
          ttlMs: 500,
        });
        if (issued.status !== "key") throw new Error("not issued");
        input.key = issued.key;
        expect(
          (
            await store.execute({
              action: "admit",
              envelope: input,
              limits: { ...limits, pendingPerActor: 10, pendingPerSource: 10, pendingPerOrganization: 10 },
            })
          ).status,
        ).toBe("receipt");
      };
      await send("first", "a".repeat(64));
      await send("ordinary-next", "a".repeat(64));
      const query = {
        action: "source-catalogue" as const,
        organization: "org:test",
        actor: envelope().actor,
        limit: 3,
      };
      const same = await store.execute(query);
      expect(same).toMatchObject({
        status: "source-catalogue",
        accessRevision: 0,
        entries: [{ sourceReference: { credentialDigest: "a".repeat(64), messageId: "ordinary-next" }, allowed: true }],
      });
      if (same.status !== "source-catalogue") throw new Error("not catalogued");
      expect(same.entries).toHaveLength(1);
      await send("second-key", "b".repeat(64));
      await send("third-key", "c".repeat(64));
      expect(await store.execute({ ...query, limit: 2 })).toEqual({ status: "unavailable" });
      const complete = await store.execute(query);
      if (complete.status !== "source-catalogue") throw new Error("not catalogued");
      expect(complete.entries.map((entry) => entry.sourceReference?.credentialDigest).sort()).toEqual([
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
      ]);
      const pageOne = await store.execute({ ...query, paged: true, limit: 2 });
      expect(pageOne).toMatchObject({
        status: "source-catalogue",
        accessRevision: 0,
        entries: [{ allowed: true }, { allowed: true }],
      });
      if (pageOne.status !== "source-catalogue" || !pageOne.next || pageOne.revision === undefined)
        throw new Error("page unavailable");
      const pageTwo = await store.execute({ ...query, paged: true, after: pageOne.next, limit: 2 });
      expect(pageTwo).toMatchObject({
        status: "source-catalogue",
        accessRevision: 0,
        revision: pageOne.revision,
        entries: [{ allowed: true }],
      });
      if (pageTwo.status !== "source-catalogue") throw new Error("page unavailable");
      expect(
        [...pageOne.entries, ...pageTwo.entries].map((entry) => entry.sourceReference?.credentialDigest).sort(),
      ).toEqual(["a".repeat(64), "b".repeat(64), "c".repeat(64)]);
      const observe = {
        action: "source-policy-observe" as const,
        organization: query.organization,
        actor: query.actor,
        expectedRevision: pageOne.revision,
        observations: [...pageOne.entries, ...pageTwo.entries].map((entry) => ({
          authority: entry.authority,
          fingerprint: "d".repeat(64),
        })),
      };
      const initialized = await store.execute(observe);
      expect(initialized).toMatchObject({ status: "source-policies-observed", accessRevision: 0 });
      if (initialized.status !== "source-policies-observed") throw new Error("observation unavailable");
      expect(await store.execute({ ...observe, expectedRevision: initialized.revision })).toEqual(initialized);
      expect(await store.execute(observe)).toEqual({ status: "conflict" });
      const denied = await store.execute({
        ...observe,
        expectedRevision: initialized.revision,
        observations: [{ authority: pageOne.entries[0]!.authority, fingerprint: null }],
      });
      expect(denied).toMatchObject({ status: "source-policies-observed", accessRevision: 1 });
      expect(
        await store.execute({ ...query, actor: { ...query.actor, identity: { ...identity, subject: "bob" } } }),
      ).toEqual({ status: "fenced" });
      now = 500;
      expect(await store.execute(query)).toEqual({ status: "source-catalogue", accessRevision: 1, entries: [] });
    });
    it("preserves bounded own-source history and deletion after linking without inheriting another source's old history", async () => {
      const store = factory(() => 1);
      const service = new OrganizationService({
        store,
        directory: store.directory,
        limits,
        mappings: [{ source: "http", issuer: identity.issuer, tenant: null, organization: "org:test" }],
        authorize: async () => true,
        currentIdentityRead: async () => "allowed",
      });
      const other = { ...identity, subject: "bob" };
      const auth = (id: typeof identity) => ({
        source: "http" as const,
        identity: id,
        kind: "human" as const,
        organizations: ["org:test"],
      });
      const send = (id: typeof identity, key: string, content: string) =>
        service.admit(auth(id), {
          key,
          sourceEvent: key,
          content,
          destination: { kind: "broad" },
          workload: "message",
          target: null,
          context: [],
        });
      const original = await send(identity, "own-old", "My original history");
      if (original.status !== "receipt") throw new Error("no receipt");
      await send(other, "other-old", "Their original history");
      const person = await store.directory.createPerson();
      if (person.status !== "created") throw new Error("no person");
      for (const id of [identity, other])
        await store.directory.change({
          action: "link",
          identity: id,
          personId: person.person.id,
          expectedRevision: 0,
          actor: id,
          proof: { method: "dual-authentication", version: 1 },
        });
      await send(identity, "joined-new", "Future joined history");
      expect(await service.streamTail(auth(identity), 2)).toMatchObject({
        status: "stream_tail",
        entries: [
          { sequence: 1, content: "My original history" },
          { sequence: 3, content: "Future joined history" },
        ],
        hasMore: false,
      });
      expect(await service.streamTail(auth(other), 2)).toMatchObject({
        status: "stream_tail",
        entries: [
          { sequence: 2, content: "Their original history" },
          { sequence: 3, content: "Future joined history" },
        ],
        hasMore: false,
      });
      expect(await service.streamTail(auth(identity), 1, 3)).toMatchObject({
        status: "stream_tail",
        entries: [{ sequence: 1, content: "My original history" }],
        hasMore: false,
      });
      expect(await service.delete(auth(other), original.receipt.id)).toEqual({ status: "not_found" });
      expect(await service.delete(auth(identity), original.receipt.id)).toMatchObject({ status: "ok", removed: 1 });
      expect(await service.stream(auth(identity), 0, 2)).toMatchObject({
        status: "stream",
        entries: [{ sequence: 3, content: "Future joined history" }],
      });
    });
    it("limits private content deletion to the exact authenticated source even in a joined person stream", async () => {
      const store = factory(() => 1);
      const person = await store.directory.createPerson();
      if (person.status !== "created") throw new Error("no person");
      const other = { ...identity, subject: "bob" };
      for (const source of [identity, other])
        await store.directory.change({
          action: "link",
          identity: source,
          personId: person.person.id,
          expectedRevision: 0,
          actor: source,
          proof: { method: "dual-authentication", version: 1 },
        });
      const first = { ...envelope(), actor: { ...envelope().actor, stream: person.person.id, bindingRevision: 1 } };
      const receipt = await store.execute({ action: "admit", envelope: first, limits });
      if (receipt.status !== "receipt") throw new Error("no receipt");
      const command = {
        action: "delete" as const,
        organization: "org:test",
        stream: person.person.id,
        receiptId: receipt.receipt.id,
      };
      expect(
        await store.execute({ ...command, actor: { ...first.actor, identity: other, principal: "access:bob" } }),
      ).toEqual({ status: "not_found" });
      expect(
        await store.execute({
          action: "stream",
          organization: "org:test",
          stream: person.person.id,
          actor: first.actor,
          identities: [identity, other],
          after: 0,
          limit: 10,
        }),
      ).toMatchObject({ status: "stream", entries: [{ content: "Private request" }] });
      expect(await store.execute({ ...command, actor: first.actor })).toMatchObject({ status: "ok", removed: 1 });
    });
    it("uses a separate access epoch for policy changes without clearing drafts on messages", async () => {
      const store = factory(() => 1);
      const admitted = await store.execute({ action: "admit", envelope: envelope(), limits });
      expect(admitted.status).toBe("receipt");
      expect(await store.execute({ action: "get", organization: "org:test" })).toMatchObject({
        status: "state",
        state: { accessRevision: 0 },
      });
      await store.execute({ action: "access", organization: "org:test", identity, allowed: false });
      expect(await store.execute({ action: "get", organization: "org:test" })).toMatchObject({
        status: "state",
        state: { accessRevision: 1 },
      });
      await store.execute({ action: "access", organization: "org:test", identity, allowed: false });
      expect(await store.execute({ action: "get", organization: "org:test" })).toMatchObject({
        status: "state",
        state: { accessRevision: 1 },
      });
      await store.execute({ action: "access", organization: "org:test", identity, allowed: true });
      expect(await store.execute({ action: "get", organization: "org:test" })).toMatchObject({
        status: "state",
        state: { accessRevision: 2 },
      });
    });
    it("filters private history through the exact original source proof and holds unknown policy", async () => {
      const store = factory(() => 1);
      let decision: "allowed" | "denied" | "unavailable" = "allowed";
      const proofs: unknown[] = [];
      const service = new OrganizationService({
        store,
        directory: store.directory,
        limits,
        mappings: [{ source: "http", issuer: identity.issuer, tenant: null, organization: "org:test" }],
        authorize: async () => true,
        currentIdentityRead: async (source, reference) => {
          proofs.push([source, reference?.credentialDigest]);
          return decision;
        },
      });
      const auth = {
        source: "http" as const,
        identity,
        kind: "human" as const,
        organizations: ["org:test"],
        sourceReference: {
          actorId: "access:alice",
          userId: "access:alice",
          channelId: "http:home",
          threadKey: "http:home:alice",
          credentialDigest: "b".repeat(64),
        },
      };
      expect(
        await service.admit(auth, {
          key: "source-proof",
          sourceEvent: "source-proof",
          content: "Private request",
          destination: { kind: "broad" },
          workload: "message",
          target: null,
          context: [],
        }),
      ).toMatchObject({ status: "receipt" });
      expect(await service.streamTail(auth)).toMatchObject({
        status: "stream_tail",
        entries: [{ content: "Private request" }],
      });
      expect(proofs).toEqual([[identity, "b".repeat(64)]]);
      decision = "denied";
      expect(await service.streamTail(auth)).toMatchObject({ status: "stream_tail", entries: [] });
      decision = "unavailable";
      expect(await service.streamTail(auth)).toEqual({ status: "unavailable" });
    });
    it("links only future cross-source private activity at an atomic sequence cutoff even in the same millisecond", async () => {
      const store = factory(() => 1);
      const person = await store.directory.createPerson();
      if (person.status !== "created") throw new Error("no person");
      const second = { ...identity, subject: "bob" };
      const link = (linked: typeof identity) =>
        store.directory.change({
          action: "link",
          identity: linked,
          personId: person.person.id,
          expectedRevision: 0,
          actor: linked,
          proof: { method: "dual-authentication", version: 1 },
        });
      await link(identity);
      const first = {
        ...envelope("before-link"),
        actor: { ...envelope().actor, stream: person.person.id, bindingRevision: 1 },
      };
      const accept = async (e: OrganizationEnvelope) => {
        const admitted = await store.execute({ action: "admit", envelope: e, limits });
        if (admitted.status !== "receipt") throw new Error("not admitted");
        const claimed = await store.execute({
          action: "claim",
          organization: e.organization,
          owner: "process",
          leaseMs: 30,
        });
        if (claimed.status !== "state" || !claimed.state.lease) throw new Error("not claimed");
        const lease = { organization: e.organization, owner: "process", generation: claimed.state.lease.generation };
        await store.execute({
          action: "settle",
          ...lease,
          receiptId: admitted.receipt.id,
          status: "accepted",
          reason: null,
          reply: null,
          contentTtlMs: 90,
        });
        await store.execute({ action: "complete", ...lease, through: claimed.state.lease.through });
      };
      await accept(first);
      await link(second);
      const service = new OrganizationService({
        store,
        directory: store.directory,
        limits,
        mappings: [{ source: "http", issuer: identity.issuer, tenant: null, organization: "org:test" }],
        authorize: async () => true,
        currentIdentityRead: async () => "allowed",
      });
      const auth = (external: typeof identity) => ({
        source: "http" as const,
        identity: external,
        kind: "human" as const,
        organizations: ["org:test"],
      });
      expect(await service.streamTail(auth(second), 10)).toMatchObject({ status: "stream_tail", entries: [] });
      await accept({ ...first, key: "after-link", sourceEvent: "after-link", content: "Future shared activity" });
      expect(await service.streamTail(auth(second), 10)).toMatchObject({
        status: "stream_tail",
        entries: [{ sequence: 2, content: "Future shared activity" }],
      });
      expect(await service.stream(auth(identity), 0, 10)).toMatchObject({
        status: "stream",
        entries: [
          { sequence: 1, content: "Private request" },
          { sequence: 2, content: "Future shared activity" },
        ],
      });
      const before = await store.execute({ action: "get", organization: first.organization });
      if (before.status !== "state") throw new Error("no state");
      await store.directory.change({
        action: "revoke",
        identity,
        personId: person.person.id,
        expectedRevision: 1,
        actor: identity,
        proof: { method: "authenticated-human", version: 1 },
      });
      const hidden = await service.streamTail(auth(second), 10);
      expect(hidden).toMatchObject({ status: "stream_tail", entries: [] });
      if (hidden.status !== "stream_tail") throw new Error("no tail");
      expect(hidden.revision).toBe(before.state.revision + 1);
    });
    it("opens the latest private page with bounded older cursors and follows new replies", async () => {
      const store = factory(() => 1);
      const service = new OrganizationService({
        store,
        directory: store.directory,
        mappings: [{ source: "http", issuer: identity.issuer, tenant: null, organization: "org:test" }],
        limits,
        authorize: async () => true,
        currentIdentityRead: async () => "allowed",
      });
      const auth = { source: "http" as const, identity, kind: "human" as const, organizations: ["org:test"] };
      for (let index = 1; index <= 5; index++) {
        const admitted = await service.admit(auth, {
          key: `tail-${index}`,
          sourceEvent: `tail-${index}`,
          content: `Message ${index}`,
          destination: { kind: "broad" },
          workload: "message",
          target: null,
          context: [],
        });
        if (admitted.status !== "receipt") throw new Error("not admitted");
        const claimed = await store.execute({
          action: "claim",
          organization: "org:test",
          owner: "process",
          leaseMs: 30,
        });
        if (claimed.status !== "state" || !claimed.state.lease) throw new Error("not claimed");
        const lease = { organization: "org:test", owner: "process", generation: claimed.state.lease.generation };
        await store.execute({
          action: "settle",
          ...lease,
          receiptId: admitted.receipt.id,
          status: "accepted",
          reason: null,
          reply: null,
          contentTtlMs: 90,
        });
        await store.execute({ action: "complete", ...lease, through: claimed.state.lease.through });
      }
      expect(await service.streamTail(auth, 2)).toMatchObject({
        status: "stream_tail",
        entries: [
          { sequence: 4, content: "Message 4" },
          { sequence: 5, content: "Message 5" },
        ],
        cursor: 5,
        beforeCursor: 4,
        hasMore: true,
      });
      expect(await service.streamTail(auth, 2, 4)).toMatchObject({
        status: "stream_tail",
        entries: [
          { sequence: 2, content: "Message 2" },
          { sequence: 3, content: "Message 3" },
        ],
        cursor: 3,
        beforeCursor: 2,
        hasMore: true,
      });
      expect(await service.streamTail(auth, 2, 2)).toMatchObject({
        status: "stream_tail",
        entries: [{ sequence: 1, content: "Message 1" }],
        beforeCursor: 1,
        hasMore: false,
      });
      await service.admit(auth, {
        key: "tail-6",
        sourceEvent: "tail-6",
        content: "Message 6",
        destination: { kind: "broad" },
        workload: "message",
        target: null,
        context: [],
      });
      expect(await service.stream(auth, 5, 2)).toMatchObject({
        status: "stream",
        entries: [{ sequence: 6, content: "Message 6" }],
        cursor: 6,
        hasMore: false,
      });
      await store.execute({ action: "access", organization: "org:test", identity, allowed: false });
      expect(await service.streamTail(auth, 2)).toEqual({ status: "fenced" });
    });
    it("delivers an original owner's addressed reply once after lease completion and blocks deletion or revocation", async () => {
      const store = factory(() => 1);
      const e = envelope();
      const admitted = await store.execute({ action: "admit", envelope: e, limits });
      if (admitted.status !== "receipt") throw new Error("not admitted");
      const claimed = await store.execute({
        action: "claim",
        organization: e.organization,
        owner: "process",
        leaseMs: 30,
      });
      if (claimed.status !== "state" || !claimed.state.lease) throw new Error("not claimed");
      const lease = { organization: e.organization, owner: "process", generation: claimed.state.lease.generation };
      expect(
        await store.execute({
          action: "settle",
          ...lease,
          receiptId: admitted.receipt.id,
          status: "accepted",
          ownerRunId: "original-run",
          reason: null,
          reply: null,
          contentTtlMs: 90,
        }),
      ).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
      expect(await store.execute({ action: "complete", ...lease, through: claimed.state.lease.through })).toMatchObject(
        { status: "state", state: { lease: { expiresAt: 1 } } },
      );
      const reply = {
        action: "reply" as const,
        organization: e.organization,
        receiptId: admitted.receipt.id,
        actor: e.actor,
        ownerRunId: "original-run",
        replyKey: "final",
        digest: "a".repeat(64),
        content: "Original result",
        contentTtlMs: 90,
      };
      expect(await store.execute({ ...reply, ownerRunId: "rival-run" })).toEqual({ status: "fenced" });
      expect(await store.execute(reply)).toEqual({ status: "ok", removed: 0 });
      expect(await store.execute(reply)).toEqual({ status: "ok", removed: 0 });
      const stream = {
        action: "stream" as const,
        organization: e.organization,
        stream: e.actor.stream!,
        actor: e.actor,
        identities: [identity],
        after: 0,
        limit: 100,
      };
      expect(await store.execute(stream)).toMatchObject({
        status: "stream",
        entries: [
          { role: "user", content: "Private request" },
          { role: "assistant", content: "Original result" },
        ],
      });
      expect(await store.execute({ ...reply, replyKey: "secret", content: "API_TOKEN=abcd\n".repeat(2000) })).toEqual({
        status: "invalid",
      });
      expect(
        await store.execute({
          action: "delete",
          organization: e.organization,
          stream: e.actor.stream!,
          actor: e.actor,
          receiptId: admitted.receipt.id,
        }),
      ).toEqual({ status: "ok", removed: 2 });
      expect(await store.execute({ ...reply, replyKey: "late" })).toEqual({ status: "not_found" });
      expect(await store.execute({ action: "access", organization: e.organization, identity, allowed: false })).toEqual(
        { status: "ok", removed: 0 },
      );
      expect(await store.execute(reply)).toEqual({ status: "fenced" });
    });
    it("keeps one durable logical orchestrator and fences replacement owners", async () => {
      let now = 1;
      const store = factory(() => now);
      expect(await store.execute({ action: "wake", organization: "org:test" })).toMatchObject({
        status: "state",
        state: { orchestrator: "organization:org:test", wakeSequence: 1 },
      });
      expect(
        await store.execute({ action: "claim", organization: "org:test", owner: "first", leaseMs: 10 }),
      ).toMatchObject({ status: "state", state: { lease: { owner: "first", generation: 1, through: 1 } } });
      expect(await store.execute({ action: "claim", organization: "org:test", owner: "second", leaseMs: 10 })).toEqual({
        status: "busy",
      });
      now = 12;
      expect(
        await store.execute({ action: "claim", organization: "org:test", owner: "second", leaseMs: 10 }),
      ).toMatchObject({ status: "state", state: { lease: { generation: 2 } } });
      expect(
        await store.execute({
          action: "complete",
          organization: "org:test",
          owner: "first",
          generation: 1,
          through: 1,
        }),
      ).toEqual({ status: "fenced" });
      expect(
        await store.execute({
          action: "complete",
          organization: "org:test",
          owner: "second",
          generation: 2,
          through: 1,
        }),
      ).toMatchObject({ status: "state", state: { reconciledSequence: 1 } });
    });
    it("returns a durable retry receipt and rejects changed payload under its key", async () => {
      const store = factory(() => 1);
      const input = envelope();
      const first = await store.execute({ action: "admit", envelope: input, limits });
      expect(first).toMatchObject({
        status: "receipt",
        duplicate: false,
        receipt: { status: "pending", effectKey: "organization:org:test:1" },
      });
      expect(await store.execute({ action: "admit", envelope: input, limits })).toEqual({ ...first, duplicate: true });
      expect(
        await store.execute({
          action: "admit",
          envelope: { ...input, digest: "b".repeat(64), content: "Other request" },
          limits,
        }),
      ).toEqual({ status: "conflict" });
      expect(
        await store.execute({
          action: "stream",
          organization: "org:test",
          stream: "access:alice",
          actor: envelope().actor,
          after: 0,
          limit: 20,
          identities: [identity],
        }),
      ).toMatchObject({ status: "stream", entries: [{ sequence: 1, content: "Private request" }] });
    });
    it("shares one actor quota across message and act workloads while preserving another actor and reconciliation", async () => {
      for (const first of ["message", "act"] as const) {
        const store = factory(() => 1);
        expect(
          await store.execute({ action: "admit", envelope: { ...envelope("first"), workload: first }, limits }),
        ).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
        const switched = {
          ...envelope("switched"),
          workload: first === "message" ? ("act" as const) : ("message" as const),
        };
        expect(await store.execute({ action: "admit", envelope: switched, limits })).toMatchObject({
          status: "receipt",
          duplicate: false,
          receipt: { status: "throttled", effectKey: null },
        });
        expect(await store.execute({ action: "admit", envelope: switched, limits })).toMatchObject({
          status: "receipt",
          duplicate: true,
          receipt: { status: "throttled", effectKey: null },
        });
        expect(await store.execute({ action: "admit", envelope: envelope("peer", "bob"), limits })).toMatchObject({
          status: "receipt",
          receipt: { status: "pending" },
        });
        expect(
          await store.execute({
            action: "admit",
            envelope: { ...envelope("repair"), workload: "reconciliation" },
            limits,
          }),
        ).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
      }
    });
    it("contains an actor flood while another actor and reconciliation proceed", async () => {
      const store = factory(() => 1);
      expect(await store.execute({ action: "admit", envelope: envelope(), limits })).toMatchObject({
        status: "receipt",
        receipt: { status: "pending" },
      });
      expect(await store.execute({ action: "admit", envelope: envelope("next"), limits })).toMatchObject({
        status: "receipt",
        receipt: { status: "throttled", effectKey: null },
      });
      expect(await store.execute({ action: "admit", envelope: envelope("bob-1", "bob"), limits })).toMatchObject({
        status: "receipt",
        receipt: { status: "pending" },
      });
      expect(await store.execute({ action: "wake", organization: "org:test" })).toMatchObject({ status: "state" });
      expect(
        await store.execute({
          action: "stream",
          organization: "org:test",
          stream: "access:alice",
          actor: envelope().actor,
          after: 0,
          limit: 20,
          identities: [identity],
        }),
      ).toMatchObject({ status: "stream", entries: [{ content: "Private request", identity }] });
    });
    it("accepts one versioned target and returns the losing actor a stale receipt", async () => {
      const store = factory(() => 1);
      expect(
        await store.execute({ action: "observe", organization: "org:test", target: "question:one", revision: 7 }),
      ).toEqual({ status: "ok", removed: 0 });
      const target = { key: "question:one", revision: 7 };
      expect(await store.execute({ action: "admit", envelope: { ...envelope(), target }, limits })).toMatchObject({
        status: "receipt",
        receipt: { status: "pending", currentRevision: 7 },
      });
      expect(
        await store.execute({ action: "admit", envelope: { ...envelope("answer-b", "bob"), target }, limits }),
      ).toMatchObject({ status: "receipt", receipt: { status: "stale", currentRevision: 7, effectKey: null } });
      expect(
        await store.execute({ action: "observe", organization: "org:test", target: target.key, revision: 7 }),
      ).toEqual({ status: "ok", removed: 0 });
    });
    it("expires and deletes content while keeping replay prevention and historical attribution", async () => {
      let now = 1;
      const store = factory(() => now);
      const input = envelope();
      const first = await store.execute({ action: "admit", envelope: input, limits });
      expect(first).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
      if (first.status !== "receipt") throw new Error("admission failed");
      expect(
        await store.execute({ action: "claim", organization: "org:test", owner: "worker", leaseMs: 300 }),
      ).toMatchObject({ status: "state" });
      expect(
        await store.execute({
          action: "settle",
          organization: "org:test",
          owner: "worker",
          generation: 1,
          receiptId: first.receipt.id,
          status: "accepted",
          reason: null,
          reply: "Private reply",
          contentTtlMs: 90,
        }),
      ).toMatchObject({ status: "receipt", receipt: { status: "accepted", actor: { identity } } });
      expect(
        await store.execute({
          action: "delete",
          organization: "org:test",
          stream: "access:alice",
          actor: envelope().actor,
          receiptId: first.receipt.id,
        }),
      ).toEqual({ status: "ok", removed: 2 });
      expect(await store.execute({ action: "admit", envelope: input, limits })).toMatchObject({
        status: "receipt",
        duplicate: true,
        receipt: { status: "accepted" },
      });
      expect(
        await store.execute({
          action: "stream",
          organization: "org:test",
          stream: "access:alice",
          actor: envelope().actor,
          after: 0,
          limit: 20,
          identities: [identity],
        }),
      ).toMatchObject({ status: "stream", entries: [], cursor: 2, hasMore: false });
      now = 367;
      expect(await store.execute({ action: "expire", organization: "org:test" })).toEqual({ status: "ok", removed: 1 });
    });
    it("never copies a local thread message into the broad stream or another organization", async () => {
      const store = factory(() => 1);
      expect(
        await store.execute({
          action: "admit",
          envelope: { ...envelope(), destination: { kind: "thread", thread: "slack:thread" } },
          limits,
        }),
      ).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
      const read = {
        action: "stream" as const,
        organization: "org:test",
        stream: "access:alice",
        actor: envelope().actor,
        after: 0,
        limit: 20,
        identities: [identity],
      };
      expect(await store.execute(read)).toMatchObject({ status: "stream", entries: [], cursor: 0, hasMore: false });
      expect(await store.execute({ ...read, organization: "org:other" })).toMatchObject({
        status: "stream",
        entries: [],
        cursor: 0,
        hasMore: false,
      });
      expect(
        await store.execute({
          action: "admit",
          envelope: { ...envelope("broad-2", "bob"), content: "Bob private" },
          limits,
        }),
      ).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
      expect(
        await store.execute({
          ...read,
          stream: "access:bob",
          actor: envelope("bob", "bob").actor,
          identities: [{ ...identity, subject: "bob" }],
        }),
      ).toMatchObject({ status: "stream", entries: [{ content: "Bob private" }] });
    });
    it("releases a rejected reservation without changing the canonical question revision", async () => {
      let now = 1;
      const store = factory(() => now);
      const target = { key: "question:delete", revision: 7 };
      await store.execute({ action: "observe", organization: "org:test", target: target.key, revision: 7 });
      const first = await store.execute({ action: "admit", envelope: { ...envelope(), target }, limits });
      expect(first).toMatchObject({ status: "receipt", receipt: { status: "pending", currentRevision: 7 } });
      if (first.status !== "receipt") throw new Error("admission failed");
      expect(
        await store.execute({
          action: "delete",
          organization: "org:test",
          stream: "access:alice",
          actor: envelope().actor,
          receiptId: first.receipt.id,
        }),
      ).toEqual({ status: "ok", removed: 1 });
      expect(
        await store.execute({ action: "observe", organization: "org:test", target: target.key, revision: 7 }),
      ).toEqual({ status: "ok", removed: 0 });
      expect(
        await store.execute({
          action: "admit",
          envelope: { ...envelope("answer-after-delete", "bob"), target },
          limits,
        }),
      ).toMatchObject({ status: "receipt", receipt: { status: "pending", currentRevision: 7 } });
      now = 92;
      expect(
        await store.execute({
          action: "admit",
          envelope: { ...envelope("answer-after-expiry", "carol"), target },
          limits,
        }),
      ).toMatchObject({ status: "receipt", receipt: { status: "pending", currentRevision: 7 } });
      expect(await store.execute({ action: "admit", envelope: { ...envelope(), target }, limits })).toMatchObject({
        status: "receipt",
        duplicate: true,
        receipt: { status: "rejected", reason: "Message deleted." },
      });
    });
    it("fences a revoked reader and releases that actor's queued question reservation", async () => {
      const store = factory(() => 1);
      const person = await store.directory.createPerson();
      if (person.status !== "created") throw new Error("person unavailable");
      const proof = { method: "dual-authentication" as const, version: 1 };
      await store.directory.change({
        action: "link",
        identity,
        personId: person.person.id,
        expectedRevision: 0,
        actor: identity,
        proof,
      });
      const bound = { ...envelope(), actor: { ...envelope().actor, stream: person.person.id, bindingRevision: 1 } };
      const target = { key: "question:revoke", revision: 7 };
      await store.execute({ action: "observe", organization: "org:test", target: target.key, revision: 7 });
      expect(await store.execute({ action: "admit", envelope: { ...bound, target }, limits })).toMatchObject({
        status: "receipt",
        receipt: { status: "pending" },
      });
      expect(
        await store.execute({
          action: "stream",
          organization: "org:test",
          stream: person.person.id,
          actor: bound.actor,
          identities: [identity],
          after: 0,
          limit: 10,
        }),
      ).toMatchObject({ status: "stream", entries: [{ content: "Private request" }] });
      expect(
        await store.directory.change({
          action: "revoke",
          identity,
          personId: person.person.id,
          expectedRevision: 1,
          actor: identity,
          proof: { method: "authenticated-human", version: 1 },
        }),
      ).toMatchObject({ status: "changed", binding: { state: "revoked", revision: 2 } });
      expect(
        await store.execute({
          action: "stream",
          organization: "org:test",
          stream: person.person.id,
          actor: bound.actor,
          identities: [identity],
          after: 0,
          limit: 10,
        }),
      ).toEqual({ status: "fenced" });
      expect(
        await store.execute({ action: "admit", envelope: { ...envelope("new-answer", "bob"), target }, limits }),
      ).toMatchObject({ status: "receipt", receipt: { status: "pending", currentRevision: 7 } });
      expect(await store.execute({ action: "admit", envelope: { ...bound, target }, limits })).toMatchObject({
        status: "receipt",
        duplicate: true,
        receipt: { status: "rejected", reason: "Access changed." },
      });
    });
    it("rotates actor lanes across bounded batches and fences the lease snapshot", async () => {
      const store = factory(() => 1);
      const roomy = { ...limits, pendingPerActor: 3, pendingPerOrganization: 10 };
      await store.execute({ action: "admit", envelope: envelope("alice-1"), limits: roomy });
      await store.execute({ action: "admit", envelope: envelope("alice-2"), limits: roomy });
      await store.execute({ action: "admit", envelope: envelope("bob-1", "bob"), limits: roomy });
      expect(
        await store.execute({ action: "claim", organization: "org:test", owner: "worker", leaseMs: 100 }),
      ).toMatchObject({ status: "state", state: { lease: { through: 3 } } });
      const later = await store.execute({
        action: "admit",
        envelope: envelope("carol-1", "carol"),
        limits: { ...roomy, pendingPerSource: 5 },
      });
      if (later.status !== "receipt") throw new Error("later admission failed");
      const subjects: string[] = [];
      for (let i = 0; i < 3; i++) {
        const result = await store.execute({
          action: "pending",
          organization: "org:test",
          owner: "worker",
          generation: 1,
          limit: 1,
        });
        if (result.status !== "pending") throw new Error("pending unavailable");
        subjects.push(result.envelopes[0].actor.identity.subject);
      }
      expect(subjects).toEqual(["alice", "bob", "alice"]);
      expect(
        await store.execute({
          action: "settle",
          organization: "org:test",
          owner: "worker",
          generation: 1,
          receiptId: later.receipt.id,
          status: "accepted",
          reason: null,
          reply: null,
          contentTtlMs: 90,
        }),
      ).toEqual({ status: "stale" });
      expect(
        await store.execute({
          action: "complete",
          organization: "org:test",
          owner: "worker",
          generation: 1,
          through: 3,
        }),
      ).toEqual({ status: "busy" });
    });
    it("never exposes expired queued content beyond a cleanup batch", async () => {
      let now = 1;
      const store = factory(() => now);
      const roomy = {
        ...limits,
        pendingPerActor: 2000,
        pendingPerSource: 2000,
        pendingPerOrganization: 2002,
        contentTtlMs: 10,
      };
      for (let i = 0; i < 1001; i++) {
        const input = envelope("batch-" + i);
        input.actor = { ...input.actor, kind: "service", stream: null };
        const admitted = await store.execute({ action: "admit", envelope: input, limits: roomy });
        if (admitted.status !== "receipt" || admitted.receipt.status !== "pending")
          throw new Error("batch admission failed");
      }
      now = 12;
      expect(
        await store.execute({ action: "claim", organization: "org:test", owner: "worker", leaseMs: 100 }),
      ).toMatchObject({ status: "state" });
      expect(
        await store.execute({
          action: "pending",
          organization: "org:test",
          owner: "worker",
          generation: 1,
          limit: 100,
        }),
      ).toEqual({ status: "pending", envelopes: [], receipts: [] });
      const retry = envelope("batch-1000");
      retry.actor = { ...retry.actor, kind: "service", stream: null };
      expect(await store.execute({ action: "admit", envelope: retry, limits: roomy })).toMatchObject({
        status: "receipt",
        duplicate: true,
        receipt: { status: "rejected", reason: "Message expired." },
      });
    }, 20_000);
    it("preserves service attribution in a verified person's stream and redacts replies", async () => {
      const store = factory(() => 1);
      const person = await store.directory.createPerson();
      if (person.status !== "created") throw new Error("person unavailable");
      await store.directory.change({
        action: "link",
        identity,
        personId: person.person.id,
        expectedRevision: 0,
        actor: identity,
        proof: { method: "dual-authentication", version: 1 },
      });
      const serviceIdentity = { issuer: "service:test", tenant: null, subject: "automation" };
      const input = {
        ...envelope(),
        actor: {
          identity: serviceIdentity,
          kind: "service" as const,
          principal: "service:automation",
          stream: person.person.id,
          bindingRevision: 1,
          onBehalfOf: identity,
        },
      };
      const first = await store.execute({ action: "admit", envelope: input, limits });
      if (first.status !== "receipt") throw new Error("admission failed");
      await store.execute({ action: "claim", organization: "org:test", owner: "worker", leaseMs: 100 });
      expect(
        await store.execute({
          action: "settle",
          organization: "org:test",
          owner: "worker",
          generation: 1,
          receiptId: first.receipt.id,
          status: "accepted",
          reason: "API_TOKEN=private-token",
          reply: "API_TOKEN=private-token",
          contentTtlMs: 90,
        }),
      ).toMatchObject({ status: "receipt", receipt: { status: "accepted", reason: "API_TOKEN=«redacted»" } });
      const result = await store.execute({
        action: "stream",
        organization: "org:test",
        stream: person.person.id,
        actor: { ...envelope().actor, stream: person.person.id, bindingRevision: 1 },
        identities: [identity],
        after: 0,
        limit: 10,
      });
      expect(result).toMatchObject({
        status: "stream",
        entries: [
          { role: "user", identity: serviceIdentity, onBehalfOf: identity },
          { role: "assistant", identity: serviceIdentity, content: "API_TOKEN=«redacted»" },
        ],
      });
      expect(
        await store.execute({ action: "access", organization: "org:test", identity: serviceIdentity, allowed: false }),
      ).toEqual({ status: "ok", removed: 0 });
      expect(
        await store.execute({
          action: "stream",
          organization: "org:test",
          stream: person.person.id,
          actor: { ...envelope().actor, stream: person.person.id, bindingRevision: 1 },
          identities: [identity],
          after: 0,
          limit: 10,
        }),
      ).toMatchObject({ status: "stream", entries: [], cursor: 2, hasMore: false });
    });
    it("requires a fresh actor-bound browser key once and preserves retry receipts after its expiry", async () => {
      let now = 1;
      const store = factory(() => now);
      const input = { ...envelope(), source: "browser" as const };
      expect(await store.execute({ action: "admit", envelope: input, limits })).toEqual({ status: "invalid" });
      const issued = await store.execute({
        action: "issue",
        organization: "org:test",
        source: "browser",
        actor: input.actor,
        ttlMs: 10,
      });
      expect(issued).toMatchObject({ status: "key", expiresAt: 11 });
      if (issued.status !== "key") throw new Error("key unavailable");
      input.key = issued.key;
      expect(
        await store.execute({ action: "admit", envelope: { ...input, actor: envelope("other", "bob").actor }, limits }),
      ).toEqual({ status: "invalid" });
      const first = await store.execute({ action: "admit", envelope: input, limits });
      expect(first).toMatchObject({ status: "receipt", duplicate: false, receipt: { status: "pending" } });
      now = 12;
      expect(await store.execute({ action: "admit", envelope: input, limits })).toEqual({ ...first, duplicate: true });
      expect(
        await store.execute({
          action: "admit",
          envelope: { ...input, content: "Changed", digest: "b".repeat(64) },
          limits,
        }),
      ).toEqual({ status: "conflict" });
      expect(
        await store.execute({ action: "admit", envelope: { ...input, organization: "org:other" }, limits }),
      ).toEqual({ status: "invalid" });
    });
    it("advances the projection clock when a busy reconciliation rejects revoked content", async () => {
      const store = factory(() => 1);
      const person = await store.directory.createPerson();
      if (person.status !== "created") throw new Error("person unavailable");
      await store.directory.change({
        action: "link",
        identity,
        personId: person.person.id,
        expectedRevision: 0,
        actor: identity,
        proof: { method: "dual-authentication", version: 1 },
      });
      const bound = { ...envelope(), actor: { ...envelope().actor, stream: person.person.id, bindingRevision: 1 } };
      await store.execute({ action: "admit", envelope: bound, limits });
      await store.execute({ action: "admit", envelope: envelope("bob-live", "bob"), limits });
      await store.execute({ action: "claim", organization: "org:test", owner: "worker", leaseMs: 100 });
      await store.directory.change({
        action: "revoke",
        identity,
        personId: person.person.id,
        expectedRevision: 1,
        actor: identity,
        proof: { method: "authenticated-human", version: 1 },
      });
      const before = await store.execute({ action: "get", organization: "org:test" });
      if (before.status !== "state") throw new Error("state unavailable");
      expect(
        await store.execute({
          action: "complete",
          organization: "org:test",
          owner: "worker",
          generation: 1,
          through: 2,
        }),
      ).toEqual({ status: "busy" });
      const after = await store.execute({ action: "get", organization: "org:test" });
      if (after.status !== "state") throw new Error("state unavailable");
      expect(after.state.revision).toBe(before.state.revision + 1);
      expect(await store.execute({ action: "admit", envelope: bound, limits })).toMatchObject({
        status: "receipt",
        duplicate: true,
        receipt: { status: "rejected", reason: "Access changed." },
      });
    });
    it("checks the current lease and canonical question before its original owner starts an effect", async () => {
      const store = factory(() => 1);
      const input = { ...envelope(), target: { key: "question:effect", revision: 7 } };
      await store.execute({ action: "observe", organization: "org:test", target: input.target.key, revision: 7 });
      const admitted = await store.execute({ action: "admit", envelope: input, limits });
      if (admitted.status !== "receipt") throw new Error("admission failed");
      await store.execute({ action: "claim", organization: "org:test", owner: "worker", leaseMs: 100 });
      const effect = {
        action: "effect" as const,
        organization: "org:test",
        owner: "worker",
        generation: 1,
        source: input.source,
        key: input.key,
        actor: input.actor,
      };
      expect(await store.execute(effect)).toMatchObject({
        status: "receipt",
        receipt: { status: "pending", effectKey: admitted.receipt.effectKey },
      });
      expect(await store.execute({ ...effect, generation: 2 })).toEqual({ status: "fenced" });
      await store.execute({ action: "observe", organization: "org:test", target: input.target.key, revision: 8 });
      expect(await store.execute(effect)).toEqual({ status: "stale" });
      expect(await store.execute({ action: "admit", envelope: input, limits })).toMatchObject({
        status: "receipt",
        duplicate: true,
        receipt: { status: "rejected", reason: "The work or retention changed." },
      });
      expect(
        await store.execute({
          action: "admit",
          envelope: { ...envelope("new-question", "bob"), target: { ...input.target, revision: 8 } },
          limits,
        }),
      ).toMatchObject({ status: "receipt", receipt: { status: "pending", currentRevision: 8 } });
    });
    it("continues private stream pages past currently inaccessible source content", async () => {
      const store = factory(() => 1);
      const person = await store.directory.createPerson();
      if (person.status !== "created") throw new Error("person unavailable");
      const otherIdentity = { ...identity, issuer: "other:test" };
      for (const source of [identity, otherIdentity])
        await store.directory.change({
          action: "link",
          identity: source,
          personId: person.person.id,
          expectedRevision: 0,
          actor: source,
          proof: { method: "dual-authentication", version: 1 },
        });
      const actor = { ...envelope().actor, stream: person.person.id, bindingRevision: 1 };
      const inputs = [
        { ...envelope("visible-1"), actor, content: "First visible" },
        {
          ...envelope("hidden-2"),
          actor: { ...actor, identity: otherIdentity, principal: "other:alice" },
          content: "Hidden source",
        },
        { ...envelope("visible-3"), actor, content: "Last visible" },
      ];
      for (const input of inputs)
        expect(
          await store.execute({ action: "admit", envelope: input, limits: { ...limits, pendingPerActor: 3 } }),
        ).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
      const read = {
        action: "stream" as const,
        organization: "org:test",
        stream: person.person.id,
        actor,
        identities: [identity],
        limit: 1,
        after: 0,
      };
      expect(await store.execute(read)).toMatchObject({
        status: "stream",
        entries: [{ content: "First visible" }],
        cursor: 1,
        hasMore: true,
      });
      expect(await store.execute({ ...read, after: 1 })).toMatchObject({
        status: "stream",
        entries: [],
        cursor: 2,
        hasMore: true,
      });
      expect(await store.execute({ ...read, after: 2 })).toMatchObject({
        status: "stream",
        entries: [{ content: "Last visible" }],
        cursor: 3,
        hasMore: false,
      });
    });
    it("refuses redaction-expanded instructions atomically in every admission lane", async () => {
      let now = 1;
      const store = factory(() => now);
      let lane = 0;
      for (const kind of ["human", "service"] as const)
        for (const destination of [{ kind: "broad" as const }, { kind: "thread" as const, thread: "unit:thread" }])
          for (const workload of ["message", "reconciliation"] as const) {
            const input = {
              ...envelope("expanded-" + lane),
              organization: "org:expanded-" + lane++,
              destination,
              workload,
              content: "API_TOKEN=abcd\n".repeat(2000),
            };
            input.actor = { ...input.actor, kind, stream: kind === "service" ? null : input.actor.stream };
            expect(await store.execute({ action: "admit", envelope: input, limits })).toEqual({ status: "invalid" });
            expect(await store.execute({ action: "get", organization: input.organization })).toMatchObject({
              status: "state",
              state: { revision: 0, wakeSequence: 0, streamSequence: 0 },
            });
            const valid = { ...input, content: "Instruction remains whole" };
            const accepted = await store.execute({ action: "admit", envelope: valid, limits });
            expect(accepted).toMatchObject({ status: "receipt", duplicate: false, receipt: { status: "pending" } });
            if (accepted.status !== "receipt") throw new Error("valid admission failed");
            now += 100;
            expect(await store.execute({ action: "expire", organization: input.organization })).toMatchObject({
              status: "ok",
            });
            expect(await store.execute({ action: "get", organization: input.organization })).toMatchObject({
              status: "state",
              state: { wakeSequence: 1 },
            });
            if (kind === "human")
              expect(
                await store.execute({
                  action: "delete",
                  organization: input.organization,
                  stream: input.actor.stream!,
                  actor: input.actor,
                  receiptId: accepted.receipt.id,
                }),
              ).toMatchObject({ status: "ok" });
            expect(await store.execute({ action: "admit", envelope: valid, limits })).toMatchObject({
              status: "receipt",
              duplicate: true,
              receipt: { status: "rejected", reason: "Message expired." },
            });
          }
    });
    it("refuses expanded settlement text without changing the receipt or private projection", async () => {
      let now = 1;
      const store = factory(() => now);
      const person = await store.directory.createPerson();
      if (person.status !== "created") throw new Error("person unavailable");
      await store.directory.change({
        action: "link",
        identity,
        personId: person.person.id,
        expectedRevision: 0,
        actor: identity,
        proof: { method: "dual-authentication", version: 1 },
      });
      let lane = 0;
      for (const delegated of [false, true])
        for (const destination of [{ kind: "broad" as const }, { kind: "thread" as const, thread: "unit:thread" }])
          for (const field of ["reply", "reason"] as const) {
            const input = {
              ...envelope("settle-expanded-" + lane),
              organization: "org:settle-expanded-" + lane++,
              destination,
            };
            input.actor = delegated
              ? {
                  identity: { issuer: "service:test", tenant: null, subject: "automation" },
                  kind: "service",
                  principal: "service:automation",
                  stream: person.person.id,
                  bindingRevision: 1,
                  onBehalfOf: identity,
                }
              : { ...input.actor, stream: person.person.id, bindingRevision: 1 };
            const admitted = await store.execute({ action: "admit", envelope: input, limits });
            if (admitted.status !== "receipt") throw new Error("admission failed");
            await store.execute({ action: "claim", organization: input.organization, owner: "worker", leaseMs: 100 });
            const before = await store.execute({ action: "get", organization: input.organization });
            const settlement = {
              action: "settle" as const,
              organization: input.organization,
              owner: "worker",
              generation: 1,
              receiptId: admitted.receipt.id,
              status: "accepted" as const,
              reason: "Saved.",
              reply: "Safe reply",
              contentTtlMs: 90,
            };
            const expanded =
              field === "reply"
                ? { ...settlement, reply: "API_TOKEN=abcd\n".repeat(2000) }
                : { ...settlement, reason: "API_TOKEN=abcd ".repeat(136) };
            expect(await store.execute(expanded)).toEqual({ status: "invalid" });
            expect(await store.execute({ action: "get", organization: input.organization })).toEqual(before);
            expect(await store.execute({ action: "admit", envelope: input, limits })).toEqual({
              ...admitted,
              duplicate: true,
            });
            expect(await store.execute(settlement)).toMatchObject({
              status: "receipt",
              receipt: { status: "accepted", reason: "Saved." },
            });
            const reader = { ...envelope().actor, stream: person.person.id, bindingRevision: 1 };
            const transcript = await store.execute({
              action: "stream",
              organization: input.organization,
              actor: reader,
              stream: person.person.id,
              identities: [identity],
              after: 0,
              limit: 10,
            });
            expect(transcript).toMatchObject({
              status: "stream",
              entries:
                destination.kind === "broad"
                  ? [{ content: "Private request" }, { role: "assistant", content: "Safe reply" }]
                  : [],
            });
            now += 100;
            expect(await store.execute({ action: "expire", organization: input.organization })).toMatchObject({
              status: "ok",
            });
            expect(
              await store.execute({
                action: "delete",
                organization: input.organization,
                actor: input.actor,
                stream: person.person.id,
                receiptId: admitted.receipt.id,
              }),
            ).toMatchObject({ status: "ok" });
            expect(await store.execute({ action: "get", organization: input.organization })).toMatchObject({
              status: "state",
            });
          }
    });
  });
}
organizationContract((now) => new InMemoryOrganizationStore(now), "organization memory contract");

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
organizationContract((now) => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const storage: DirectorySqlStorage = {
    sql: {
      exec<T>(query: string, ...params: (string | number | null)[]): Iterable<T> {
        return db.prepare(query).all(...params) as T[];
      },
    },
    transactionSync<T>(body: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = body();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return new SqliteOrganizationStore(storage, now);
}, "organization SQLite contract");
