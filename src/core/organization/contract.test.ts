import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteOrganizationStore } from "./sqlite.js";
import type { PersonDirectory } from "../identity/contract.js";
import type { DirectorySqlStorage } from "../identity/sqlite.js";
import { InMemoryOrganizationStore } from "./memory.js";
import type { OrganizationEnvelope, OrganizationLimits, OrganizationStore } from "./contract.js";

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
      const before = await store.execute({ action: "get", organization: "org:test" });
      if (before.status !== "state") throw new Error("state unavailable");
      await store.directory.change({
        action: "revoke",
        identity,
        personId: person.person.id,
        expectedRevision: 1,
        actor: identity,
        proof: { method: "authenticated-human", version: 1 },
      });
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
                actor: reader,
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
