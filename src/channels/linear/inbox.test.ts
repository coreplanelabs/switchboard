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
    it("commits once, claims in arrival order and refuses concurrent consumers until lease expiry", async () => {
      const inbox = make();
      expect(await inbox.accept(event)).toBe(true);
      expect(await inbox.accept(event)).toBe(false);
      await inbox.accept({ ...event, key: "org:session:prompted:p1", receivedAt: 101 });
      const first = await inbox.claim(200, 1000, "lease-a");
      expect(first).toMatchObject({ event, lease: "lease-a", attempts: 1 });
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
      expect(await inbox.bind(event.key, "wrong", "run")).toBe(false);
      expect(await inbox.bind(event.key, "a", "run")).toBe(true);
      expect(await inbox.renew(event.key, "a", 500)).toBe(true);
      expect(await inbox.claim(499, 100, "b")).toBeUndefined();
      expect(await inbox.retry(event.key, "a", 600)).toBe(true);
      expect(await inbox.claim(599, 100, "b")).toBeUndefined();
      expect(await inbox.claim(600, 100, "b")).toMatchObject({ runId: "run", attempts: 2 });
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
  });
}

describe("durable Linear event recovery", () => {
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
