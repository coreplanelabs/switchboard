import { randomUUID } from "node:crypto";
import { env, runInDurableObject } from "cloudflare:test";
import type { ConfigDO } from "./worker.ts";
import { baseConfigDocument, ConfigDocumentClient, type ConfigPublicationSnapshot } from "../../src/configDocument.ts";
import { fetchMemoryTest } from "./testFetch.ts";
import { describe, expect, it } from "vitest";

// Feature: docs/reference/specs/routing-and-config.md item 12 — the ConfigDO: versioned
// runtime config documents (the bot's chat-set `overrides`). Runs in workerd
// against the real SQLite-backed Durable Object.

const BASE = "https://memory.test";
const AUTH = { authorization: "Bearer test-token", "content-type": "application/json" };

let n = 0;
const key = () => `doc-${Date.now().toString(36)}-${n++}`;

async function post(path: string, body: unknown, headers: Record<string, string> = AUTH) {
  return fetchMemoryTest(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) }, async (res) => {
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text);
    } catch {
      // non-JSON: leave {}
    }
    return { status: res.status, data };
  });
}

describe("ConfigDO routes", () => {
  it("counts input-source drift without private bytes or changing a refusal when telemetry fails", async () => {
    const sourceKey = key();
    const targetKey = key();
    const stub = env.CONFIG.get(env.CONFIG.idFromName("config"));
    const captured = await runInDurableObject(stub, async (instance: ConfigDO) => {
      const lines: unknown[][] = [];
      const log = console.log;
      try {
        await instance.put(sourceKey, { private: "source secret" }, 0, 0);
        await instance.put(targetKey, { private: "target secret" }, 0, 0);
        console.log = (...args: unknown[]) => {
          lines.push(args);
        };
        const refused = await instance.put(targetKey, { private: "candidate secret" }, 1, 1, {
          key: sourceKey,
          version: 0,
        });
        await instance.put(targetKey, {}, 0, 2, { key: sourceKey, version: 1 });
        console.log = () => {
          throw new Error("telemetry unavailable");
        };
        const loggingFailure = await instance.put(targetKey, {}, 1, 3, { key: sourceKey, version: 0 });
        return {
          lines,
          refused,
          loggingFailure,
          source: await instance.get(sourceKey),
          target: await instance.get(targetKey),
        };
      } finally {
        console.log = log;
      }
    });
    expect(captured).toEqual({
      lines: [[`[config/put] refused ${targetKey}: source ${sourceKey} v1 != v0`]],
      refused: { ok: false, version: 1 },
      loggingFailure: { ok: false, version: 1 },
      source: { document: { private: "source secret" }, version: 1 },
      target: { document: { private: "target secret" }, version: 1 },
    });
  });

  it("counts snapshot replacement refusals without private bytes or changes to stored inputs", async () => {
    const snapshotKey = `deploy-base-${randomUUID()}`;
    const mutableKey = key();
    const stub = env.CONFIG.get(env.CONFIG.idFromName("config"));
    const captured = await runInDurableObject(stub, async (instance: ConfigDO) => {
      const lines: unknown[][] = [];
      const log = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args);
      };
      try {
        await instance.put(snapshotKey, { private: "original private bytes" }, 0, 0);
        const refusal = await instance.put(snapshotKey, { private: "replacement private bytes" }, 1, 1);
        await instance.put(mutableKey, { private: "ordinary config" }, 0, 0);
        await instance.put(mutableKey, { private: "ordinary replacement" }, 1, 1);
        await instance.put(mutableKey, {}, 0, 2);
        console.log = () => {
          throw new Error("telemetry unavailable");
        };
        const loggingFailure = await instance.put(snapshotKey, {}, 1, 2);
        return { lines, refusal, loggingFailure, stored: await instance.get(snapshotKey) };
      } finally {
        console.log = log;
      }
    });
    expect(captured).toEqual({
      lines: [[`[config/put] refused replacing snapshot ${snapshotKey} v1`]],
      refusal: { ok: false, version: 1 },
      loggingFailure: { ok: false, version: 1 },
      stored: { document: { private: "original private bytes" }, version: 1 },
    });
  });

  it("advertises the feature; refuses unauthenticated and non-POST", async () => {
    const health = await fetchMemoryTest(`${BASE}/healthz`, undefined, (res) => res.json());
    expect((health as { features: string[] }).features).toContain("config");
    expect((await post("/config/get", { key: "overrides" }, { "content-type": "application/json" })).status).toBe(401);
    expect((await fetchMemoryTest(`${BASE}/config/get`, { method: "GET" })).status).toBe(405);
  });

  it("get of an unknown key is null at version 0; put creates v1, replaces to v2, and a stale expectedVersion is a 409 carrying the current version", async () => {
    const k = key();
    expect((await post("/config/get", { key: k })).data).toEqual({ document: null, version: 0 });
    expect(
      (
        await post("/config/put", {
          key: k,
          document: { channels: { a: { agent: "coding" } }, users: {} },
          expectedVersion: 0,
        })
      ).data,
    ).toEqual({ ok: true, version: 1 });
    expect((await post("/config/get", { key: k })).data).toEqual({
      document: { channels: { a: { agent: "coding" } }, users: {} },
      version: 1,
    });
    // A writer that loaded v1 replaces it.
    expect(
      (
        await post("/config/put", {
          key: k,
          document: { channels: {}, users: { u: { effort: "low" } } },
          expectedVersion: 1,
        })
      ).data,
    ).toEqual({ ok: true, version: 2 });
    // A writer still holding v1 (or v0) is refused and told the current version — nothing is clobbered.
    const stale = await post("/config/put", { key: k, document: { channels: {}, users: {} }, expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.data).toEqual({ error: "version conflict", version: 2 });
    expect((await post("/config/get", { key: k })).data).toEqual({
      document: { channels: {}, users: { u: { effort: "low" } } },
      version: 2,
    });
  });

  it("the base client preserves a successor document on the real SQLite compare-and-swap", async () => {
    const k = key();
    const client = new ConfigDocumentClient({
      baseUrl: BASE,
      token: "test-token",
      fetch: (input, init) => fetchMemoryTest(String(input), init),
    });
    const original = baseConfigDocument("# original\n", "admin", new Date(0));
    const successor = baseConfigDocument("# successor\n", "admin", new Date(1));
    const candidate = baseConfigDocument("# candidate\n", "deploy", new Date(2));
    expect(await client.pushBase(original, k, 0)).toEqual({ ok: true, version: 1 });
    const frozen = await client.readBase(k);
    if (!frozen.ok) throw new Error(frozen.problem);
    expect(await client.pushBase(successor, k, frozen.version)).toEqual({ ok: true, version: 2 });
    expect(await client.pushBase(candidate, k, frozen.version)).toMatchObject({ ok: false, write: "not-written" });
    expect(await client.readBase(k)).toEqual({ ok: true, document: successor, version: 2 });
  });

  it("an input snapshot survives a new client and cannot be replaced even with its current version", async () => {
    const publicationId = randomUUID();
    const snapshotKey = `deploy-base-${publicationId}`;
    const original = baseConfigDocument("# original private bytes\n", "admin", new Date(0));
    const candidate = baseConfigDocument("# candidate private bytes\n", "deploy", new Date(1));
    const snapshot: ConfigPublicationSnapshot = {
      schema: 1,
      kind: "base-config-publication",
      publicationId,
      stateWorkerUrl: BASE,
      baseKey: key(),
      priorVersion: 7,
      priorDocument: original,
      expectedCandidateVersion: 8,
      candidate,
    };
    const client = () =>
      new ConfigDocumentClient({
        baseUrl: BASE,
        token: "test-token",
        fetch: (input, init) => fetchMemoryTest(String(input), init),
      });
    expect(await client().recordPublicationSnapshot(snapshotKey, snapshot)).toEqual({ ok: true, version: 1 });
    expect(await client().readPublicationSnapshot(snapshotKey)).toEqual({ ok: true, snapshot });
    expect(
      (
        await post("/config/put", {
          key: snapshotKey,
          document: { ...snapshot, candidate: original },
          expectedVersion: 1,
        })
      ).status,
    ).toBe(409);
    expect(await client().readPublicationSnapshot(snapshotKey)).toEqual({ ok: true, snapshot });
  });

  it("an unknown committed snapshot ACK is not retried and the exact inputs remain readable", async () => {
    const publicationId = randomUUID();
    const snapshotKey = `deploy-base-${publicationId}`;
    const snapshot: ConfigPublicationSnapshot = {
      schema: 1,
      kind: "base-config-publication",
      publicationId,
      stateWorkerUrl: BASE,
      baseKey: key(),
      priorVersion: 0,
      priorDocument: null,
      expectedCandidateVersion: 1,
      candidate: baseConfigDocument("# original request\n", "deploy", new Date(1)),
    };
    let writes = 0;
    const uncertain = new ConfigDocumentClient({
      baseUrl: BASE,
      token: "test-token",
      fetch: async (input, init) => {
        writes++;
        await fetchMemoryTest(String(input), init, (response) => response.text());
        return Response.json({});
      },
    });
    expect(await uncertain.recordPublicationSnapshot(snapshotKey, snapshot)).toMatchObject({
      ok: false,
      write: "unknown",
    });
    expect(writes).toBe(1);
    const fresh = new ConfigDocumentClient({
      baseUrl: BASE,
      token: "test-token",
      fetch: (input, init) => fetchMemoryTest(String(input), init),
    });
    expect(await fresh.readPublicationSnapshot(snapshotKey)).toEqual({ ok: true, snapshot });
    expect(await fresh.readBase(snapshot.baseKey)).toEqual({ ok: true, document: null, version: 0 });
  });

  it("two snapshot owners race one base without losing either request or attributing the loser", async () => {
    const baseKey = key();
    const snapshots: ConfigPublicationSnapshot[] = [0, 1].map((n) => ({
      schema: 1,
      kind: "base-config-publication",
      publicationId: randomUUID(),
      stateWorkerUrl: BASE,
      baseKey,
      priorVersion: 0,
      priorDocument: null,
      expectedCandidateVersion: 1,
      candidate: baseConfigDocument("# identical YAML\n", `writer-${n}`, new Date(n)),
    }));
    const client = () =>
      new ConfigDocumentClient({
        baseUrl: BASE,
        token: "test-token",
        fetch: (input, init) => fetchMemoryTest(String(input), init),
      });
    for (const snapshot of snapshots)
      expect(await client().recordPublicationSnapshot(`deploy-base-${snapshot.publicationId}`, snapshot)).toEqual({
        ok: true,
        version: 1,
      });
    const outcomes = await Promise.all(snapshots.map((snapshot) => client().pushBase(snapshot.candidate, baseKey, 0)));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toEqual([expect.objectContaining({ write: "not-written" })]);
    const winner = snapshots[outcomes.findIndex((o) => o.ok)];
    expect(await client().readBase(baseKey)).toEqual({ ok: true, document: winner.candidate, version: 1 });
    for (const snapshot of snapshots)
      expect(await client().readPublicationSnapshot(`deploy-base-${snapshot.publicationId}`)).toEqual({
        ok: true,
        snapshot,
      });
  });

  it("a new target slot cannot bless an input source changed after preparation", async () => {
    const sourceKey = key();
    const targetKey = key();
    const original = baseConfigDocument("# original\n", "admin", new Date(0));
    const successor = baseConfigDocument("# successor\n", "admin", new Date(1));
    const client = new ConfigDocumentClient({
      baseUrl: BASE,
      token: "test-token",
      fetch: (input, init) => fetchMemoryTest(String(input), init),
    });
    expect(await client.pushBase(original, sourceKey, 0)).toEqual({ ok: true, version: 1 });
    expect(await client.pushBase(successor, sourceKey, 1)).toEqual({ ok: true, version: 2 });
    expect(await client.pushBase(original, targetKey, 0, { key: sourceKey, version: 1 })).toMatchObject({
      ok: false,
      write: "not-written",
    });
    expect(await client.readBase(targetKey)).toEqual({ ok: true, document: null, version: 0 });
    expect(await client.readBase(sourceKey)).toEqual({ ok: true, document: successor, version: 2 });
  });

  it("matching source and target predicates publish once while preserving the input source", async () => {
    const sourceKey = key();
    const targetKey = key();
    const original = baseConfigDocument("# original\n", "admin", new Date(0));
    const candidate = baseConfigDocument("# candidate\n", "publisher", new Date(1));
    const client = new ConfigDocumentClient({
      baseUrl: BASE,
      token: "test-token",
      fetch: (input, init) => fetchMemoryTest(String(input), init),
    });
    expect(await client.pushBase(original, sourceKey, 0)).toEqual({ ok: true, version: 1 });
    expect(await client.pushBase(candidate, targetKey, 0, { key: sourceKey, version: 1 })).toEqual({
      ok: true,
      version: 1,
    });
    expect(await client.pushBase(original, targetKey, 0, { key: sourceKey, version: 1 })).toMatchObject({
      ok: false,
      write: "not-written",
    });
    expect(await client.readBase(sourceKey)).toEqual({ ok: true, document: original, version: 1 });
    expect(await client.readBase(targetKey)).toEqual({ ok: true, document: candidate, version: 1 });
  });

  it("an invalid source predicate refuses before creating the target", async () => {
    const targetKey = key();
    expect(
      (
        await post("/config/put", {
          key: targetKey,
          document: {},
          expectedVersion: 0,
          sourcePrecondition: { key: "base", version: -1 },
        })
      ).status,
    ).toBe(400);
    expect((await post("/config/get", { key: targetKey })).data).toEqual({ document: null, version: 0 });
  });

  it("validates: bad key, non-object document, bad expectedVersion, oversize document; unknown route 404", async () => {
    expect((await post("/config/get", { key: "Bad Key" })).status).toBe(400);
    expect((await post("/config/put", { key: key(), document: [1], expectedVersion: 0 })).status).toBe(400);
    expect((await post("/config/put", { key: key(), document: {}, expectedVersion: -1 })).status).toBe(400);
    expect((await post("/config/put", { key: key(), document: {}, expectedVersion: 1.5 })).status).toBe(400);
    expect(
      (await post("/config/put", { key: key(), document: { big: "x".repeat(300 * 1024) }, expectedVersion: 0 })).status,
    ).toBe(413);
    // The cap is BYTES: 100 K three-byte characters are 100 K UTF-16 code units but 300 KB.
    expect(
      (await post("/config/put", { key: key(), document: { big: "€".repeat(100 * 1024) }, expectedVersion: 0 })).status,
    ).toBe(413);
    expect(
      (await post("/config/put", { key: key(), document: { big: "€".repeat(80 * 1024) }, expectedVersion: 0 })).status,
    ).toBe(200);
    expect((await post("/config/nope", { key: key() })).status).toBe(404);
  });
});

describe("ConfigDO secrets + tickets (docs/reference/specs/mcp-tools.md items 15–16)", () => {
  it("put → get → delete a sealed credential; the blob is stored verbatim and never interpreted", async () => {
    const serverId = `user:slack:U${key()}/vanta`;
    const sealed = { serverId, keyId: "k1", sealed: "AAAA", updatedAt: 3 };
    expect((await post("/config/secrets/get", { serverId })).data).toEqual({ sealed: null });
    expect((await post("/config/secrets/put", { sealed })).data).toEqual({ ok: true });
    expect((await post("/config/secrets/get", { serverId })).data).toEqual({ sealed });
    await post("/config/secrets/put", { sealed: { ...sealed, sealed: "BBBB", updatedAt: 4 } });
    expect(((await post("/config/secrets/get", { serverId })).data.sealed as { sealed: string }).sealed).toBe("BBBB");
    expect((await post("/config/secrets/delete", { serverId })).data).toEqual({ ok: true, removed: true });
    expect((await post("/config/secrets/delete", { serverId })).data).toEqual({ ok: true, removed: false });
    expect((await post("/config/secrets/put", { sealed: { serverId } })).status).toBe(400);
    expect((await post("/config/secrets/get", {})).status).toBe(400);
  });

  it("tickets: put (insert or replace) → get; a bad nonce is 400; writes sweep tickets expired more than a day ago", async () => {
    const serverId = `org/${key()}`;
    const nonce = `${"t".repeat(20)}${key()}`;
    const ticket = {
      nonce,
      serverId,
      requesterId: "slack:UALICE",
      createdAt: 1,
      expiresAt: Date.now() + 600_000,
      state: "pending",
    };
    expect((await post("/config/tickets/get", { nonce })).data).toEqual({ ticket: null });
    expect((await post("/config/tickets/put", { ticket })).data).toEqual({ ok: true });
    expect((await post("/config/tickets/get", { nonce })).data).toEqual({ ticket });
    await post("/config/tickets/put", { ticket: { ...ticket, state: "opened", openedBy: { sub: "cf", at: 2 } } });
    expect(((await post("/config/tickets/get", { nonce })).data.ticket as { state: string }).state).toBe("opened");
    expect((await post("/config/tickets/put", { ticket: { nonce: "short" } })).status).toBe(400);
    expect((await post("/config/tickets/get", { nonce: "short" })).status).toBe(400);
    const old = { ...ticket, nonce: `${"o".repeat(20)}${key()}`, expiresAt: Date.now() - 2 * 24 * 3600_000 };
    await post("/config/tickets/put", { ticket: old });
    await post("/config/tickets/put", { ticket: { ...ticket, nonce: `${"r".repeat(20)}${key()}` } }); // sweeps `old`
    expect((await post("/config/tickets/get", { nonce: old.nonce })).data).toEqual({ ticket: null });
  });

  it("tickets/transition is a compare-and-swap on the stored state: applied once; the race loser sees applied=false and the row is untouched", async () => {
    const serverId = `org/${key()}`;
    const nonce = `${"c".repeat(20)}${key()}`;
    const ticket = {
      nonce,
      serverId,
      requesterId: "slack:UALICE",
      createdAt: 1,
      expiresAt: Date.now() + 600_000,
      state: "pending",
    };
    const first = { ...ticket, state: "opened", openedBy: { sub: "cf-a", at: 2 } };
    const second = { ...ticket, state: "opened", openedBy: { sub: "cf-b", at: 3 } };
    expect((await post("/config/tickets/transition", { ticket: first, fromState: "pending" })).data).toEqual({
      ok: true,
      applied: false,
    }); // unknown nonce
    await post("/config/tickets/put", { ticket });
    expect((await post("/config/tickets/transition", { ticket: first, fromState: "pending" })).data).toEqual({
      ok: true,
      applied: true,
    });
    expect((await post("/config/tickets/transition", { ticket: second, fromState: "pending" })).data).toEqual({
      ok: true,
      applied: false,
    });
    expect(
      ((await post("/config/tickets/get", { nonce })).data.ticket as { openedBy: { sub: string } }).openedBy.sub,
    ).toBe("cf-a");
    // OAuth (item 18): opened → authorizing carries the sealed pending record, opaque here; the callback then claims it.
    const authorizing = { ...first, state: "authorizing", oauth: { keyId: "k1", sealed: "c2VhbGVk" } };
    expect((await post("/config/tickets/transition", { ticket: authorizing, fromState: "opened" })).data).toEqual({
      ok: true,
      applied: true,
    });
    expect(
      ((await post("/config/tickets/get", { nonce })).data.ticket as { state: string; oauth: { sealed: string } }).oauth
        .sealed,
    ).toBe("c2VhbGVk");
    const done = { ...authorizing, state: "completed", completedBy: { sub: "cf-a", at: 4 } };
    expect((await post("/config/tickets/transition", { ticket: done, fromState: "opened" })).data).toEqual({
      ok: true,
      applied: false,
    }); // it is authorizing now
    expect((await post("/config/tickets/transition", { ticket: done, fromState: "authorizing" })).data).toEqual({
      ok: true,
      applied: true,
    });
    expect((await post("/config/tickets/transition", { ticket: done, fromState: "authorizing" })).data).toEqual({
      ok: true,
      applied: false,
    });
    expect((await post("/config/tickets/transition", { ticket: done, fromState: "done" })).status).toBe(400);
    expect(
      (await post("/config/tickets/transition", { ticket: { nonce: "short" }, fromState: "pending" })).status,
    ).toBe(400);
  });
});

describe("ConfigDO personal MCP tokens", () => {
  it("stores only a digest, lists by owner, and revokes only for that owner", async () => {
    const token = { digest: "a".repeat(64), subject: `personal:${key()}`, email: "one@example.com", createdAt: 42 };
    const other = { ...token, digest: "b".repeat(64), subject: `personal:${key()}` };
    expect((await post("/config/personal-tokens/get", { digest: token.digest })).data).toEqual({ token: null });
    expect((await post("/config/personal-tokens/put", { token })).data).toEqual({ ok: true });
    await post("/config/personal-tokens/put", { token: other });
    expect((await post("/config/personal-tokens/get", { digest: token.digest })).data).toEqual({ token });
    expect((await post("/config/personal-tokens/list", { subject: token.subject })).data).toEqual({ tokens: [token] });
    expect(
      (await post("/config/personal-tokens/delete", { digest: token.digest, subject: other.subject })).data,
    ).toEqual({ ok: true, removed: false });
    expect(
      (await post("/config/personal-tokens/delete", { digest: token.digest, subject: token.subject })).data,
    ).toEqual({ ok: true, removed: true });
    expect((await post("/config/personal-tokens/get", { digest: token.digest })).data).toEqual({ token: null });
    expect((await post("/config/personal-tokens/put", { token: { ...token, digest: "bad" } })).status).toBe(400);
  });
});

// Feature: docs/reference/specs/routing-and-config.md item 25 — the confirmation a
// routed write is offered as: one row per thread in this object, consumed once
// for its requester, expiry stamped and judged on the object's clock.
describe("ConfigDO confirmations (docs/reference/specs/routing-and-config.md item 25)", () => {
  const TTL = 600_000;
  const requester = "slack:UREQ";
  const row = (id: string, threadKey: string, body: Record<string, unknown> = { command: "config.set" }) => ({
    id,
    threadKey,
    requester,
    body,
    ttlMs: TTL,
  });

  it("browser approval updates only the existing bound offer and single-use consumption requires that connection", async () => {
    const id = `c-${key()}`;
    const connectionId = "a".repeat(64);
    const message = { userId: requester, approvalConnection: { id: connectionId } };
    await post("/config/confirmations/put", row(id, `mcp:default:${key()}`, { command: "repo.offboard", message }));
    expect((await post("/config/confirmations/consume", { id, actorIds: [requester], connectionId })).data).toEqual({
      refused: "foreign",
    });
    expect(
      (await post("/config/confirmations/approve", { id, actorIds: [requester], connectionId: "b".repeat(64) })).data,
    ).toEqual({ refused: "foreign" });
    const approval = await post("/config/confirmations/approve", { id, actorIds: [requester], connectionId });
    expect(approval.data.row).toMatchObject({ id, body: { browserApproved: true, command: "repo.offboard" } });
    expect((await post("/config/confirmations/consume", { id, actorIds: [requester] })).data).toEqual({
      refused: "foreign",
    });
    const results = await Promise.all(
      [1, 2].map(() => post("/config/confirmations/consume", { id, actorIds: [requester], connectionId })),
    );
    expect(results.filter((result) => "row" in result.data)).toHaveLength(1);
    expect(results.find((result) => "row" in result.data)?.data.row).toMatchObject({
      id,
      body: { browserApproved: true, command: "repo.offboard" },
    });
    expect(results.find((result) => "refused" in result.data)?.data).toEqual({ refused: "used" });
    expect((await post("/config/confirmations/approve", { id, actorIds: [requester], connectionId })).data).toEqual({
      refused: "used",
    });
  });

  it("put stamps expiresAt on the object's clock from the ttl; consume returns the row once for the requester and deletes it; a second consume is `used`", async () => {
    const id = `c-${key()}`;
    const thread = `slack:CX:${key()}`;
    const before = Date.now();
    const put = await post("/config/confirmations/put", row(id, thread, { command: "config.set", n: 1 }));
    const after = Date.now();
    expect(put.status).toBe(200);
    const expiresAt = put.data.expiresAt as number;
    expect(expiresAt).toBeGreaterThanOrEqual(before + TTL);
    expect(expiresAt).toBeLessThanOrEqual(after + TTL);
    const consumed = await post("/config/confirmations/consume", { id, actorIds: [requester] });
    expect(consumed.data).toEqual({
      row: { id, threadKey: thread, requester, expiresAt, body: { command: "config.set", n: 1 } },
    });
    expect((await post("/config/confirmations/consume", { id, actorIds: [requester] })).data).toEqual({
      refused: "used",
    });
  });

  it("a row past its expiry is refused `expired` on touch and deleted — the refusal names the row, the object's clock decides, never the caller's", async () => {
    const id = `c-${key()}`;
    const thread = `slack:CX:${key()}`;
    await post("/config/confirmations/put", { ...row(id, thread), ttlMs: 0 });
    // The deleted row rides the refusal so the bot can record the click (record 0054).
    expect((await post("/config/confirmations/consume", { id, actorIds: [requester] })).data).toEqual({
      refused: "expired",
      row: { id, threadKey: thread, requester, expiresAt: expect.any(Number), body: { command: "config.set" } },
    });
    expect((await post("/config/confirmations/consume", { id, actorIds: [requester] })).data).toEqual({
      refused: "used",
    });
  });

  it("an actor whose ids miss the requester is refused `foreign` — the refusal names the kept row; the requester's own id, or a list holding it, consumes", async () => {
    const id = `c-${key()}`;
    const thread = `slack:CX:${key()}`;
    await post("/config/confirmations/put", row(id, thread));
    const kept = { id, threadKey: thread, requester, expiresAt: expect.any(Number), body: { command: "config.set" } };
    expect((await post("/config/confirmations/consume", { id, actorIds: ["slack:UOTHER"] })).data).toEqual({
      refused: "foreign",
      row: kept,
    });
    expect(
      (await post("/config/confirmations/consume", { id, actorIds: ["access:sub-1", "slack:UOTHER"] })).data,
    ).toEqual({ refused: "foreign", row: kept });
    const consumed = await post("/config/confirmations/consume", { id, actorIds: ["access:sub-1", requester] });
    expect((consumed.data.row as { id: string }).id).toBe(id);
  });

  it("put replaces the thread's older row: after a second put the first id reads `used`, and another thread's row is untouched", async () => {
    const thread = `slack:CX:${key()}`;
    const first = `c-${key()}`;
    const second = `c-${key()}`;
    const elsewhere = `c-${key()}`;
    await post("/config/confirmations/put", row(elsewhere, `slack:CY:${key()}`));
    await post("/config/confirmations/put", row(first, thread));
    await post("/config/confirmations/put", row(second, thread));
    expect((await post("/config/confirmations/consume", { id: first, actorIds: [requester] })).data).toEqual({
      refused: "used",
    });
    expect(
      ((await post("/config/confirmations/consume", { id: second, actorIds: [requester] })).data.row as { id: string })
        .id,
    ).toBe(second);
    expect(
      (
        (await post("/config/confirmations/consume", { id: elsewhere, actorIds: [requester] })).data.row as {
          id: string;
        }
      ).id,
    ).toBe(elsewhere);
  });

  it("pending-by-thread answers the thread's unexpired row without deleting it, null for a thread with none, and null when the thread's row is past its expiry — the object's clock decides", async () => {
    const thread = `slack:CX:${key()}`;
    const id = `c-${key()}`;
    expect((await post("/config/confirmations/pending-by-thread", { threadKey: thread })).data).toEqual({ row: null });
    const put = await post("/config/confirmations/put", row(id, thread));
    const expiresAt = put.data.expiresAt as number;
    const pending = { id, threadKey: thread, requester, expiresAt, body: { command: "config.set" } };
    expect((await post("/config/confirmations/pending-by-thread", { threadKey: thread })).data).toEqual({
      row: pending,
    });
    // A read deletes nothing: the same row answers again and still consumes.
    expect((await post("/config/confirmations/pending-by-thread", { threadKey: thread })).data).toEqual({
      row: pending,
    });
    expect(
      ((await post("/config/confirmations/consume", { id, actorIds: [requester] })).data.row as { id: string }).id,
    ).toBe(id);
    // An expired row present reads as none — the reader checks expiry, nothing sweeps — and stays for the consume to name `expired`.
    const expired = `c-${key()}`;
    await post("/config/confirmations/put", { ...row(expired, thread), ttlMs: 0 });
    expect((await post("/config/confirmations/pending-by-thread", { threadKey: thread })).data).toEqual({ row: null });
    expect((await post("/config/confirmations/consume", { id: expired, actorIds: [requester] })).data).toMatchObject({
      refused: "expired",
    });
  });

  it("cancel deletes the row for the requester and refuses a stranger; a cancelled or unknown id reads `used`", async () => {
    const id = `c-${key()}`;
    await post("/config/confirmations/put", row(id, `slack:CX:${key()}`));
    expect((await post("/config/confirmations/cancel", { id, actorIds: ["slack:UOTHER"] })).data).toEqual({
      refused: "foreign",
    });
    expect((await post("/config/confirmations/cancel", { id, actorIds: [requester] })).data).toEqual({ ok: true });
    expect((await post("/config/confirmations/consume", { id, actorIds: [requester] })).data).toEqual({
      refused: "used",
    });
    expect((await post("/config/confirmations/cancel", { id, actorIds: [requester] })).data).toEqual({
      refused: "used",
    });
  });

  it("cancel-by-thread deletes the thread's row for the requester, refuses a stranger, and reads `used` on a thread with none; another thread's row stays; the body stays opaque, a row stored before the bot's union included", async () => {
    const thread = `slack:CX:${key()}`;
    const other = `slack:CY:${key()}`;
    const id = `c-${key()}`;
    const elsewhere = `c-${key()}`;
    expect(
      (await post("/config/confirmations/cancel-by-thread", { threadKey: thread, actorIds: [requester] })).data,
    ).toEqual({
      refused: "used",
    });
    // The stored body is yesterday's shape — no `kind` — and cancels the same way.
    await post("/config/confirmations/put", row(id, thread, { command: "config.set", input: { args: [] } }));
    await post("/config/confirmations/put", row(elsewhere, other));
    expect(
      (await post("/config/confirmations/cancel-by-thread", { threadKey: thread, actorIds: ["slack:UOTHER"] })).data,
    ).toEqual({ refused: "foreign" });
    expect(
      (await post("/config/confirmations/cancel-by-thread", { threadKey: thread, actorIds: [requester] })).data,
    ).toEqual({ ok: true });
    expect((await post("/config/confirmations/consume", { id, actorIds: [requester] })).data).toEqual({
      refused: "used",
    });
    expect(
      (
        (await post("/config/confirmations/consume", { id: elsewhere, actorIds: [requester] })).data.row as {
          id: string;
        }
      ).id,
    ).toBe(elsewhere);
  });

  it("validates: a malformed id, an empty threadKey or requester, a non-object body, a bad ttl and a non-list actorIds are 400", async () => {
    const good = row(`c-${key()}`, `slack:CX:${key()}`);
    expect((await post("/config/confirmations/put", { ...good, id: "no spaces allowed" })).status).toBe(400);
    expect((await post("/config/confirmations/put", { ...good, threadKey: "" })).status).toBe(400);
    expect((await post("/config/confirmations/put", { ...good, requester: 7 })).status).toBe(400);
    expect((await post("/config/confirmations/put", { ...good, body: [1] })).status).toBe(400);
    expect((await post("/config/confirmations/put", { ...good, ttlMs: -1 })).status).toBe(400);
    expect((await post("/config/confirmations/put", { ...good, ttlMs: 1.5 })).status).toBe(400);
    expect((await post("/config/confirmations/consume", { id: "no spaces", actorIds: [requester] })).status).toBe(400);
    expect((await post("/config/confirmations/consume", { id: good.id, actorIds: requester })).status).toBe(400);
    expect((await post("/config/confirmations/cancel", { id: good.id, actorIds: [1] })).status).toBe(400);
    expect(
      (await post("/config/confirmations/cancel-by-thread", { threadKey: "", actorIds: [requester] })).status,
    ).toBe(400);
    expect(
      (await post("/config/confirmations/cancel-by-thread", { threadKey: `slack:CX:${key()}`, actorIds: 7 })).status,
    ).toBe(400);
    expect((await post("/config/confirmations/pending-by-thread", { threadKey: "" })).status).toBe(400);
    expect((await post("/config/confirmations/pending-by-thread", { threadKey: 7 })).status).toBe(400);
  });
});
