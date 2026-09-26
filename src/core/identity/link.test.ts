import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import type { PersonDirectory } from "./contract.js";
import { linkAuditSchema, type LinkCommand, type LinkResult } from "./linkContract.js";
import { InMemoryPersonDirectory } from "./memory.js";
import { SqlitePersonDirectory, type DirectorySqlStorage } from "./sqlite.js";

const access = { issuer: "https://access.test", tenant: null, subject: "human-a" };
const slack = { issuer: "https://slack.com" as const, tenant: "team-a", subject: "human-b" };
const auth = { identity: access, audience: "app-a", browserHash: "b".repeat(64), expiresAt: 900, proofVersion: 1 };
const begin = {
  action: "begin" as const,
  auth,
  accessRevision: 0,
  stateHash: "a".repeat(64),
  nonceHash: "c".repeat(64),
  slackPolicy: { tenant: "team-a", audience: "client-a", callbackUri: "https://app.test/callback" },
  expiresAt: 500,
  resultExpiresAt: 800,
};
const proof = {
  identity: slack,
  audience: "client-a",
  callbackUri: begin.slackPolicy.callbackUri,
  nonceHash: begin.nonceHash,
  expiresAt: 600,
  expectedRevision: 0,
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) close();
});
function dbPath() {
  return join(mkdtempSync(join(tmpdir(), "swb-link-")), "directory.sqlite");
}
function harness(kind: string, path = dbPath()) {
  let time = 42;
  let db: DatabaseSync | undefined;
  let directory: PersonDirectory;
  const now = () => time;
  const open = () => {
    db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    const storage: DirectorySqlStorage = {
      sql: { exec: (sql, ...params) => db!.prepare(sql).all(...params) as any },
      transactionSync: (body) => {
        db!.exec("BEGIN IMMEDIATE");
        try {
          const result = body();
          db!.exec("COMMIT");
          return result;
        } catch (error) {
          db!.exec("ROLLBACK");
          throw error;
        }
      },
    };
    directory = new SqlitePersonDirectory(storage, now);
  };
  if (kind === "sqlite") open();
  else directory = new InMemoryPersonDirectory(now);
  cleanups.push(() => db?.close());
  return {
    get directory() {
      return directory;
    },
    get db() {
      return db!;
    },
    at(value: number) {
      time = value;
    },
    reopen() {
      db!.close();
      open();
    },
    counts() {
      if (db)
        return ["directory_people", "person_bindings", "person_binding_receipts", "person_link_outcomes"].map((table) =>
          Number(db!.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n),
        );
      const state = (directory as any).state;
      return [state.people.size, state.bindings.size, [...state.history.values()].flat().length, state.audits.size];
    },
    corrupt(table: "intents" | "audits", id: string, update: (value: any) => any) {
      if (db) {
        const name = table === "intents" ? "person_link_intents" : "person_link_outcomes";
        const old = JSON.parse(db.prepare(`SELECT body FROM ${name} WHERE id = ?`).get(id)!.body as string);
        db.prepare(`UPDATE ${name} SET body = ? WHERE id = ?`).run(JSON.stringify(update(old)), id);
      } else {
        const rows = (directory as any).state[table];
        rows.set(id, update(rows.get(id)));
      }
    },
    failAudit() {
      if (db) {
        db.exec(
          "CREATE TRIGGER refuse_audit BEFORE INSERT ON person_link_outcomes BEGIN SELECT RAISE(ABORT, 'secret-storage-error'); END",
        );
        return () => db!.exec("DROP TRIGGER refuse_audit");
      }
      const original = Map.prototype.set;
      const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, key, value) {
        if (value && typeof value === "object" && "outcome" in value && "consent" in value)
          throw new Error("secret-storage-error");
        return original.call(this, key, value);
      });
      return () => spy.mockRestore();
    },
  };
}
async function start(directory: PersonDirectory, input = begin) {
  const result = await directory.link(input);
  assert(result.status === "ok");
  return result.intent.id;
}
async function ready(directory: PersonDirectory, input = begin, slackProof = proof) {
  const id = await start(directory, input);
  expect(
    await directory.link({ action: "claim", id, auth: input.auth, expectedRevision: 1, stateHash: input.stateHash }),
  ).toMatchObject({ status: "claimed", intent: { revision: 2 } });
  expect(
    await directory.link({ action: "prove", id, auth: input.auth, expectedRevision: 2, proof: slackProof }),
  ).toMatchObject({ status: "ok", intent: { state: "awaiting-consent", revision: 3 } });
  return id;
}
function commit(id: string): LinkCommand {
  return { action: "commit", id, auth, expectedRevision: 3, consent: true };
}
async function bind(directory: PersonDirectory, identity = access as typeof access | typeof slack) {
  const person = await directory.createPerson();
  assert(person.status === "created");
  expect(
    (
      await directory.change({
        action: "link",
        identity,
        personId: person.person.id,
        expectedRevision: 0,
        actor: access,
        proof: { method: "dual-authentication", version: 1 },
      })
    ).status,
  ).toBe("changed");
  return person.person.id;
}

describe("atomic link contract", () => {
  for (const kind of ["memory", "sqlite"])
    describe(kind, () => {
      it("creates one person and both bindings atomically", async () => {
        const h = harness(kind),
          d = h.directory;
        const id = await ready(d);
        expect(h.counts()).toEqual([0, 0, 0, 0]);
        const result = await d.link(commit(id));
        assert(result.status === "committed");
        expect(result.receipt).toMatchObject({
          id,
          outcome: "created",
          consent: true,
          access: { beforeRevision: 0, afterRevision: 1 },
          slack: { beforeRevision: 0, afterRevision: 1 },
          proofVersion: 1,
        });
        for (const identity of [access, slack])
          expect(await d.resolve(identity)).toMatchObject({
            status: "bound",
            binding: { personId: result.receipt.personId, revision: 1 },
          });
        expect(h.counts()).toEqual([1, 2, 2, 1]);
      });
      it("selects the known person and preserves already linked revisions", async () => {
        for (const known of [access, slack]) {
          const h = harness(kind),
            d = h.directory;
          const personId = await bind(d, known);
          const id = await ready(
            d,
            { ...begin, accessRevision: known === access ? 1 : 0 },
            { ...proof, expectedRevision: known === slack ? 1 : 0 },
          );
          const linked = await d.link(commit(id));
          expect(linked).toMatchObject({ status: "committed", receipt: { outcome: "linked", personId } });
          expect(await d.link(commit(id))).toEqual(linked);
          expect(await d.link({ action: "read", id, auth })).toEqual(linked);
          const second = await ready(d, { ...begin, accessRevision: 1 }, { ...proof, expectedRevision: 1 });
          const alreadyLinked = await d.link(commit(second));
          expect(alreadyLinked).toMatchObject({
            status: "committed",
            receipt: {
              outcome: "already-linked",
              personId,
              access: { beforeRevision: 1, afterRevision: 1 },
              slack: { beforeRevision: 1, afterRevision: 1 },
            },
          });
          expect(await d.link(commit(second))).toEqual(alreadyLinked);
          expect(await d.link({ action: "read", id: second, auth })).toEqual(alreadyLinked);
          expect(h.counts()).toEqual([1, 2, 2, 2]);
        }
      });
      it("refuses conflicts tombstones and stale observations without partial writes", async () => {
        for (const reason of ["conflict", "revoked", "stale"] as const)
          for (const identity of [access, slack]) {
            const h = harness(kind),
              d = h.directory;
            const personId = await bind(d, identity);
            if (reason === "conflict") await bind(d, identity === access ? slack : access);
            if (reason === "revoked")
              await d.change({
                action: "revoke",
                identity,
                personId,
                expectedRevision: 1,
                actor: access,
                proof: { method: "authenticated-human", version: 1 },
              });
            const observed = reason === "stale" ? 0 : reason === "revoked" ? 2 : 1;
            const id = await ready(
              d,
              { ...begin, accessRevision: reason === "conflict" ? 1 : identity === access ? observed : 0 },
              { ...proof, expectedRevision: reason === "conflict" ? 1 : identity === slack ? observed : 0 },
            );
            const before = h.counts();
            expect(await d.link(commit(id))).toEqual({ status: reason });
            expect(h.counts()).toEqual([...before.slice(0, 3), 1]);
            expect(await d.link(commit(id))).toEqual({ status: reason });
            expect(h.counts()).toEqual([...before.slice(0, 3), 1]);
          }
      });
      it("fences authentication proof consent and intent revisions", async () => {
        const h = harness(kind),
          d = h.directory,
          id = await start(d);
        const claim = { action: "claim" as const, id, auth, expectedRevision: 1, stateHash: begin.stateHash };
        for (const wrong of [
          { ...auth, identity: { ...access, subject: "other" } },
          { ...auth, audience: "other" },
          { ...auth, browserHash: "d".repeat(64) },
        ])
          expect(await d.link({ ...claim, auth: wrong })).toEqual({ status: "not_found" });
        expect(await d.link({ ...claim, auth: { ...auth, expiresAt: 42 } })).toEqual({ status: "invalid" });
        expect(await d.link({ ...claim, auth: { ...auth, proofVersion: 2 } })).toEqual({ status: "stale" });
        expect(await d.link({ ...claim, stateHash: "d".repeat(64) })).toEqual({ status: "invalid" });
        expect(await d.link({ ...claim, expectedRevision: 2 })).toEqual({ status: "stale" });
        expect((await d.link(claim)).status).toBe("claimed");
        for (const wrong of [
          { ...proof, nonceHash: "d".repeat(64) },
          { ...proof, audience: "other" },
          { ...proof, callbackUri: "https://elsewhere.test/callback" },
          { ...proof, identity: { ...slack, tenant: "other" } },
        ])
          expect(await d.link({ action: "prove", id, auth, expectedRevision: 2, proof: wrong })).toEqual({
            status: "invalid",
          });
        expect(await d.link(commit(id))).toEqual({ status: "stale" });
        expect((await d.link({ action: "prove", id, auth, expectedRevision: 2, proof })).status).toBe("ok");
        expect(await d.link({ ...commit(id), consent: false } as LinkCommand)).toEqual({ status: "consent_required" });
        expect(h.counts()).toEqual([0, 0, 0, 0]);
        expect((await d.link(commit(id))).status).toBe("committed");
      });
      it("claims a callback once and fails an interrupted exchange", async () => {
        const h = harness(kind),
          d = h.directory,
          id = await start(d);
        const claim = { action: "claim" as const, id, auth, expectedRevision: 1, stateHash: begin.stateHash };
        expect((await d.link(claim)).status).toBe("claimed");
        expect(await d.link({ ...claim, expectedRevision: 2 })).toEqual({ status: "already_claimed" });
        expect(await d.link({ action: "interrupt", id, auth, expectedRevision: 2 })).toEqual({ status: "failed" });
        expect(await d.link({ action: "prove", id, auth, expectedRevision: 2, proof })).toEqual({ status: "failed" });
        expect(h.counts()).toEqual([0, 0, 0, 1]);
      });
      it("serializes overlapping intents without adopting the winner", async () => {
        const h = harness(kind),
          d = h.directory;
        const ids = await Promise.all([ready(d), ready(d)]);
        expect((await Promise.all(ids.map((id) => d.link(commit(id))))).map((r) => r.status).sort()).toEqual([
          "committed",
          "stale",
        ]);
        expect(h.counts()).toEqual([1, 2, 2, 2]);
      });
      it("expires and cancels intents without bindings", async () => {
        for (const action of ["expire", "cancel", "shorten"] as const) {
          const h = harness(kind),
            d = h.directory;
          const id = await ready(d, begin, { ...proof, expiresAt: action === "shorten" ? 100 : 600 });
          if (action === "cancel")
            expect(await d.link({ action: "cancel", id, auth, expectedRevision: 3 })).toEqual({ status: "cancelled" });
          else h.at(action === "shorten" ? 100 : 500);
          expect(await d.link(commit(id))).toEqual({ status: action === "cancel" ? "cancelled" : "expired" });
          expect(h.counts()).toEqual([0, 0, 0, 1]);
        }
      });
      it("rolls back every write on audit failure", async () => {
        const h = harness(kind),
          d = h.directory,
          id = await ready(d);
        const restore = h.failAudit();
        expect(await d.link(commit(id))).toEqual({ status: "unavailable" });
        restore();
        expect(h.counts()).toEqual([0, 0, 0, 0]);
        expect(await d.link({ action: "read", id, auth })).toMatchObject({
          status: "ok",
          intent: { state: "awaiting-consent", revision: 3 },
        });
        expect((await d.link(commit(id))).status).toBe("committed");
        expect(h.counts()).toEqual([1, 2, 2, 1]);
      });
      it("replays a lost response without restoring a revoked binding", async () => {
        const h = harness(kind),
          d = h.directory,
          id = await ready(d);
        const lost = await d.link(commit(id));
        assert(lost.status === "committed");
        expect(await d.link(commit(id))).toEqual(lost);
        for (const other of [
          { ...auth, browserHash: "d".repeat(64) },
          { ...auth, identity: { ...access, subject: "other" } },
        ])
          expect(await d.link({ action: "read", id, auth: other } as LinkCommand)).toEqual({ status: "not_found" });
        await d.change({
          action: "revoke",
          identity: slack,
          personId: lost.receipt.personId!,
          expectedRevision: 1,
          actor: access,
          proof: { method: "authenticated-human", version: 1 },
        });
        h.at(550);
        expect(await d.link(commit(id))).toEqual(lost);
        expect(await d.link({ action: "read", id, auth })).toEqual(lost);
        expect(await d.resolve(slack)).toEqual({ status: "revoked", revision: 2 });
        expect(h.counts()).toEqual([1, 2, 3, 1]);
        h.at(800);
        expect(await d.link({ action: "read", id, auth })).toEqual({ status: "expired" });
        expect(await d.link({ action: "inspect", id, auth })).toEqual({ status: "already_claimed" });
      });
      it("requires the original revision and consent for committed retries", async () => {
        const h = harness(kind),
          d = h.directory,
          id = await ready(d);
        const lost = await d.link(commit(id));
        assert(lost.status === "committed");
        for (const expectedRevision of [0, 1, 2, 4, 5])
          for (const consent of [false, true])
            expect(await d.link({ ...commit(id), expectedRevision, consent } as LinkCommand)).toEqual({
              status: "stale",
            });
        expect(await d.link({ ...commit(id), consent: false } as LinkCommand)).toEqual({ status: "consent_required" });
        expect(await d.link(commit(id))).toEqual(lost);
        expect(await d.link({ action: "read", id, auth })).toEqual(lost);
        expect(h.counts()).toEqual([1, 2, 2, 1]);
      });
      it("refuses replay when valid receipt facts contradict the committed snapshot", async () => {
        for (const table of ["intents", "audits"] as const)
          for (const field of ["person", "slack-subject", "slack-tenant", "at"] as const) {
            const h = harness(kind),
              d = h.directory,
              id = await ready(d);
            const lost = await d.link(commit(id));
            assert(lost.status === "committed");
            const other = await d.createPerson();
            assert(other.status === "created");
            const otherSlack = { ...slack, subject: "another-human" };
            expect(
              (
                await d.change({
                  action: "link",
                  identity: otherSlack,
                  personId: lost.receipt.personId!,
                  expectedRevision: 0,
                  actor: access,
                  proof: { method: "dual-authentication", version: 1 },
                })
              ).status,
            ).toBe("changed");
            // Even another valid relationship is not the one this intent committed.
            const before = h.counts();
            h.corrupt(table, id, (row) => {
              const receipt = table === "intents" ? row.receipt : row;
              if (field === "person") receipt.personId = other.person.id;
              else if (field === "slack-subject") receipt.slack.identity = otherSlack;
              else if (field === "slack-tenant") receipt.slack.identity.tenant = "another-team";
              else receipt.at++;
              expect(linkAuditSchema.safeParse(receipt).success).toBe(true);
              return row;
            });
            expect(await d.link({ action: "read", id, auth })).toEqual({ status: "conflict" });
            expect(await d.link(commit(id))).toEqual({ status: "conflict" });
            expect(h.counts()).toEqual(before);
          }
      });
      it("refuses inconsistent persisted intent and audit states", async () => {
        for (const field of ["state", "revision", "receipt", "personId"] as const) {
          const h = harness(kind),
            d = h.directory,
            id = await ready(d);
          await d.link(commit(id));
          h.corrupt(field === "personId" ? "audits" : "intents", id, (row) => ({
            ...row,
            [field]: field === "state" ? "failed" : field === "revision" ? 3 : field === "receipt" ? undefined : null,
          }));
          expect(await d.link({ action: "read", id, auth })).toEqual({ status: "conflict" });
          expect(await d.link(commit(id))).toEqual({ status: "conflict" });
          expect(h.counts()).toEqual([1, 2, 2, 1]);
        }
      });
      it("fences revocation and refresh after proof staging", async () => {
        for (const action of ["revoke", "link"] as const) {
          const h = harness(kind),
            d = h.directory;
          const personId = await bind(d, access);
          const id = await ready(d, { ...begin, accessRevision: 1 });
          await d.change({
            action,
            identity: access,
            personId,
            expectedRevision: 1,
            actor: access,
            proof: { method: "dual-authentication", version: 1 },
          });
          expect(await d.link(commit(id))).toEqual({ status: "stale" });
          expect(await d.resolve(slack)).toEqual({ status: "unknown" });
          expect(h.counts()).toEqual([1, 1, 2, 1]);
        }
      });
      it("returns one receipt for concurrent retries of the same intent", async () => {
        const h = harness(kind),
          d = h.directory,
          id = await ready(d);
        const results = await Promise.all([d.link(commit(id)), d.link(commit(id))]);
        expect(results[0].status).toBe("committed");
        expect(results[1]).toEqual(results[0]);
        expect(h.counts()).toEqual([1, 2, 2, 1]);
      });
      it("rejects credential payloads and isolates returned objects", async () => {
        const h = harness(kind),
          d = h.directory;
        for (const extra of [
          { token: "secret" },
          { code: "secret" },
          { email: "human@example.test" },
          { personId: "chosen" },
        ])
          expect(await d.link({ ...begin, ...extra } as LinkCommand)).toEqual({ status: "invalid" });
        const id = await ready(d);
        const result = await d.link(commit(id));
        assert(result.status === "committed");
        const original = structuredClone(result);
        result.receipt.access.afterRevision = 99;
        expect(await d.link({ action: "read", id, auth })).toEqual(original);
        expect(JSON.stringify(original)).not.toMatch(/stateHash|nonceHash|browserHash|token|email/);
      });
    });
});

describe("durable link intent", () => {
  it("serializes independent writers at the database authority", async () => {
    const path = dbPath();
    const h = harness("sqlite", path);
    const ids = await Promise.all([ready(h.directory), ready(h.directory)]);
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      import { SqlitePersonDirectory } from ${JSON.stringify(new URL("./sqlite.ts", import.meta.url).href)};
      const db = new DatabaseSync(${JSON.stringify(path)});
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA busy_timeout = 5000');
      const directory = new SqlitePersonDirectory({
        sql: { exec: (query, ...params) => db.prepare(query).all(...params) },
        transactionSync(body) {
          db.exec('BEGIN IMMEDIATE');
          try { const result = body(); db.exec('COMMIT'); return result; }
          catch (error) { db.exec('ROLLBACK'); throw error; }
        }
      }, () => 42);
      process.on('message', input => {
        process.send('starting', async () => {
          const result = await directory.link(input);
          db.close(); process.send(result, () => process.disconnect());
        });
      });
      process.send('ready');
    `;
    const children = ids.map(() =>
      spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      }),
    );
    try {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              child.once("message", (message) => (message === "ready" ? resolve() : reject(new Error("not ready"))));
              child.once("error", reject);
              child.once("exit", (code) => reject(new Error(`writer exited ${code}`)));
            }),
        ),
      );
      h.db.exec("BEGIN IMMEDIATE");
      let starting = 0;
      const results = children.map(
        (child, index) =>
          new Promise<LinkResult>((resolve, reject) => {
            child.on("message", (message) => {
              if (message === "starting") {
                if (++starting === 2) h.db.exec("COMMIT");
              } else resolve(message as LinkResult);
            });
            child.once("error", reject);
            child.once("exit", (code) => reject(new Error(`writer exited ${code}`)));
            child.send(commit(ids[index]));
          }),
      );
      expect((await Promise.all(results)).map((r) => r.status).sort()).toEqual(["committed", "stale"]);
      expect(h.counts()).toEqual([1, 2, 2, 2]);
    } finally {
      if (h.db.isTransaction) h.db.exec("ROLLBACK");
      for (const child of children) child.kill();
    }
  });
  it("survives restart at claim consent and committed response loss", async () => {
    const h = harness("sqlite");
    const abandoned = await start(h.directory);
    expect(
      (
        await h.directory.link({
          action: "claim",
          id: abandoned,
          auth,
          expectedRevision: 1,
          stateHash: begin.stateHash,
        })
      ).status,
    ).toBe("claimed");
    h.reopen();
    expect(
      await h.directory.link({ action: "claim", id: abandoned, auth, expectedRevision: 2, stateHash: begin.stateHash }),
    ).toEqual({ status: "already_claimed" });
    expect(await h.directory.link({ action: "interrupt", id: abandoned, auth, expectedRevision: 2 })).toEqual({
      status: "failed",
    });
    const id = await ready(h.directory);
    h.reopen();
    const lost = await h.directory.link(commit(id));
    assert(lost.status === "committed");
    expect(
      (
        await h.directory.change({
          action: "revoke",
          identity: slack,
          personId: lost.receipt.personId!,
          expectedRevision: 1,
          actor: access,
          proof: { method: "authenticated-human", version: 1 },
        })
      ).status,
    ).toBe("changed");
    h.reopen();
    expect(await h.directory.link(commit(id))).toEqual(lost);
    expect(await h.directory.link({ action: "read", id, auth })).toEqual(lost);
    expect(await h.directory.resolve(slack)).toEqual({ status: "revoked", revision: 2 });
    expect(h.counts()).toEqual([1, 2, 3, 2]);
    h.corrupt("audits", id, (row) => ({
      ...row,
      slack: { ...row.slack, identity: { ...slack, subject: "another-human" } },
    }));
    h.reopen();
    expect(await h.directory.link(commit(id))).toEqual({ status: "conflict" });
    expect(await h.directory.link({ action: "read", id, auth })).toEqual({ status: "conflict" });
    expect(h.counts()).toEqual([1, 2, 3, 2]);
  });
});
