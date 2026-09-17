import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryLinearInbox, SqlLinearInbox, type LinearSql } from "./inbox.js";
import type { LinearWebhookEvent } from "./webhook.js";

const event: LinearWebhookEvent = {
  key: "org:session:created",
  receivedAt: 100,
  payload: { organizationId: "org", type: "AgentSessionEvent", action: "created", agentSession: { id: "session" } },
};
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function sqlStore() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql: LinearSql = {
    exec<T extends Record<string, unknown>>(query: string, ...params: (string | number | null)[]) {
      const rows = db.prepare(query).all(...params) as T[];
      return { toArray: () => rows };
    },
  };
  return { sql, inbox: new SqlLinearInbox(sql) };
}

for (const kind of ["memory", "sqlite"] as const) {
  describe(`Linear event inbox — ${kind}`, () => {
    const make = () => (kind === "memory" ? new InMemoryLinearInbox() : sqlStore().inbox);
    it("defers only an unbound claim, preserves FIFO and lets stop bypass waiting prompts", async () => {
      const inbox = make();
      await inbox.accept(event);
      await inbox.accept({ ...event, key: "follow" });
      await inbox.claim(200, 100, "a");
      await inbox.begin(event.key, "a");
      expect(await inbox.defer(event.key, "wrong", 400)).toBe(false);
      expect(await inbox.defer(event.key, "a", 400)).toBe(true);
      expect(await inbox.claim(300, 100, "b")).toBeUndefined();
      await inbox.accept({
        ...event,
        key: "stop",
        payload: { ...event.payload, action: "prompted", agentActivity: { signal: "stop" } },
      });
      expect((await inbox.claim(300, 100, "stop"))?.event.key).toBe("stop");
      await inbox.complete("stop", "stop", 300);
      const resumed = await inbox.claim(400, 100, "c");
      expect(resumed?.event.key).toBe(event.key);
      expect(resumed?.begun).toBeUndefined();
      await inbox.begin(event.key, "c");
      await inbox.bind(event.key, "c", "run");
      expect(await inbox.defer(event.key, "c", 500)).toBe(false);
    });
    it("commits once, claims in arrival order and refuses concurrent consumers until lease expiry", async () => {
      const inbox = make();
      expect(await inbox.accept(event)).toBe(true);
      expect(await inbox.accept(event)).toBe(false);
      await inbox.accept({ ...event, key: "org:session:prompted:p1", receivedAt: 101 });
      const first = await inbox.claim(200, 1000, "lease-a");
      expect(first).toMatchObject({ event, lease: "lease-a", attempts: 1 });
      await inbox.begin(event.key, "lease-a");
      expect((await inbox.claim(200, 1000, "lease-b"))?.event.key).toBe("org:session:prompted:p1");
      expect(await inbox.claim(1199, 1000, "lease-c")).toBeUndefined();
      expect(await inbox.claim(1200, 1000, "lease-c")).toMatchObject({ event, lease: "lease-c", attempts: 2 });
      expect(await inbox.complete(event.key, "lease-a", 1300)).toBe(false);
      expect(await inbox.complete(event.key, "lease-c", 1300)).toBe(true);
      expect(await inbox.accept(event)).toBe(false);
    });
    it("persists the run binding, renews ownership and requeues transient failures", async () => {
      const inbox = make();
      await inbox.accept(event);
      await inbox.claim(200, 100, "a");
      expect(await inbox.begin(event.key, "wrong")).toBe(false);
      expect(await inbox.begin(event.key, "a")).toBe(true);
      expect(await inbox.bind(event.key, "wrong", "run")).toBe(false);
      expect(await inbox.bind(event.key, "a", "run")).toBe(true);
      expect(await inbox.renew(event.key, "a", 500)).toBe(true);
      expect(await inbox.claim(499, 100, "b")).toBeUndefined();
      expect(await inbox.retry(event.key, "a", 600)).toBe(true);
      expect(await inbox.claim(599, 100, "b")).toBeUndefined();
      expect(await inbox.claim(600, 100, "b")).toMatchObject({ runId: "run", begun: true, attempts: 2 });
      expect(await inbox.renew(event.key, "a", 900)).toBe(false);
    });
    it("prunes only completed delivery tombstones, keeping pending work", async () => {
      const inbox = make();
      await inbox.accept(event);
      await inbox.claim(200, 100, "a");
      await inbox.complete(event.key, "a", 250);
      await inbox.accept({ ...event, key: "pending" });
      await inbox.prune(251);
      expect(await inbox.accept(event)).toBe(true);
      expect((await inbox.claim(300, 100, "b"))?.event.key).toBe("pending");
    });
    it("cancels revoked workspace requests while preserving control events and other installations", async () => {
      const inbox = make();
      await inbox.accept(event);
      await inbox.claim(200, 100, "a");
      await inbox.accept({ ...event, key: "other", payload: { ...event.payload, organizationId: "other" } });
      await inbox.accept({
        ...event,
        key: "revoke",
        payload: { ...event.payload, type: "OAuthApp", action: "revoked" },
      });
      await inbox.cancelOrganization("org", 250);
      expect(await inbox.renew(event.key, "a", 500)).toBe(false);
      expect(await inbox.accept(event)).toBe(false);
      expect((await inbox.claim(300, 100, "b"))?.event.key).toBe("other");
      expect((await inbox.claim(300, 100, "c"))?.event.key).toBe("revoke");
    });
    it("holds dispatch and later turns until acknowledgement succeeds, retaining failed acknowledgements", async () => {
      const inbox = make();
      await inbox.accept(event, { acknowledge: true });
      await inbox.accept({ ...event, key: "follow" });
      expect(await inbox.hasPendingAcks()).toBe(true);
      expect(await inbox.claim(200, 100, "consumer")).toBeUndefined();
      expect(await inbox.claimAck(200, 100, "edge")).toMatchObject({ event, lease: "edge" });
      expect(await inbox.acknowledge(event.key, "wrong", 201)).toBe(false);
      expect(await inbox.retry(event.key, "edge", 250)).toBe(true);
      expect(await inbox.claimAck(249, 100, "retry")).toBeUndefined();
      expect(await inbox.claimAck(250, 100, "retry")).toMatchObject({ event });
      expect(await inbox.acknowledge(event.key, "retry", 251)).toBe(true);
      expect(await inbox.hasPendingAcks()).toBe(false);
      expect(await inbox.claim(251, 100, "consumer")).toMatchObject({ event });
      expect(await inbox.claim(251, 100, "follow")).toBeUndefined();
      await inbox.begin(event.key, "consumer");
      expect((await inbox.claim(251, 100, "follow"))?.event.key).toBe("follow");
    });
    it("does not let a retrying pre-dispatch request be overtaken in its session", async () => {
      const inbox = make();
      await inbox.accept(event);
      await inbox.accept({ ...event, key: "follow" });
      await inbox.accept({ ...event, key: "other", payload: { ...event.payload, agentSession: { id: "other" } } });
      await inbox.claim(200, 100, "first");
      await inbox.retry(event.key, "first", 400);
      expect((await inbox.claim(300, 100, "next"))?.event.key).toBe("other");
      expect(await inbox.claim(300, 100, "later")).toBeUndefined();
      expect((await inbox.claim(400, 100, "retry"))?.event.key).toBe(event.key);
    });
  });
}

describe("durable Linear event recovery", () => {
  it("restores an unfinished acknowledgement before making its request dispatchable", async () => {
    const { sql, inbox } = sqlStore();
    await inbox.accept(event, { acknowledge: true });
    await inbox.claimAck(200, 100, "old");
    const restored = new SqlLinearInbox(sql);
    expect(await restored.claim(300, 100, "consumer")).toBeUndefined();
    expect(await restored.claimAck(300, 100, "new")).toMatchObject({ event, attempts: 2 });
    expect(await restored.acknowledge(event.key, "old", 301)).toBe(false);
    expect(await restored.acknowledge(event.key, "new", 301)).toBe(true);
    expect(await restored.claim(301, 100, "consumer")).toMatchObject({ event });
  });
  it("restores a leased event and its run after host replacement without truncating large context", async () => {
    const { sql, inbox } = sqlStore();
    const large = { ...event, payload: { ...event.payload, promptContext: "説明".repeat(80_000) } };
    await inbox.accept(large);
    await inbox.claim(200, 100, "old");
    await inbox.bind(event.key, "old", "run");
    const restored = new SqlLinearInbox(sql);
    expect(await restored.claim(299, 100, "new")).toBeUndefined();
    expect(await restored.claim(300, 100, "new")).toMatchObject({ event: large, runId: "run" });
  });
});
