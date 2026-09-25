import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, describe, expect, it } from "vitest";
import {
  resolvePerson,
  runBindingAttribution,
  type BindingChange,
  type ChangeResult,
  type ExternalIdentity,
  type PersonDirectory,
  type PersonId,
} from "./contract.js";
import { InMemoryPersonDirectory } from "./memory.js";
import { SqlitePersonDirectory, type DirectorySqlStorage } from "./sqlite.js";

const first: ExternalIdentity = { issuer: "https://issuer.test", tenant: "workspace", subject: "subject-a" };
const second: ExternalIdentity = { ...first, subject: "subject-b" };
const proof = { method: "dual-authentication" as const, version: 1 };
const now = () => 42;
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function database(path: string) {
  const db = new DatabaseSync(path);
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
  return { db, directory: new SqlitePersonDirectory(storage, now) };
}
function dbPath() {
  return join(mkdtempSync(join(tmpdir(), "swb-person-")), "directory.sqlite");
}
async function person(directory: PersonDirectory): Promise<PersonId> {
  const result = await directory.createPerson();
  assert(result.status === "created");
  return result.person.id;
}
function link(personId: PersonId, identity = first): BindingChange {
  return { action: "link", personId, identity, expectedRevision: 0, actor: first, proof };
}
async function receipts(directory: PersonDirectory, identity = first) {
  const result = await directory.receipts(identity);
  assert(result.status === "ok");
  return result.receipts;
}

const factories = {
  memory: () => {
    const directory = new InMemoryPersonDirectory(now);
    return [directory, directory] as const;
  },
  sqlite: () => {
    const path = dbPath();
    return [database(path).directory, database(path).directory] as const;
  },
};

describe("person directory contract", () => {
  for (const [name, factory] of Object.entries(factories))
    describe(name, () => {
      it("binds two authenticated subjects to one opaque person", async () => {
        const [directory, other] = factory();
        const id = await person(directory);
        expect(id).toMatch(/^person:[0-9a-f-]{36}$/);
        expect(await person(directory)).not.toBe(id);
        expect(await directory.change(link(id))).toMatchObject({ status: "changed", binding: { revision: 1 } });
        expect(await other.change({ ...link(id, second), actor: second })).toMatchObject({ status: "changed" });
        for (const identity of [first, second])
          expect(await other.resolve(identity)).toMatchObject({
            status: "bound",
            binding: { identity, personId: id, state: "active", revision: 1, proof },
          });
      });

      it("isolates issuer tenant and exact subject tuples", async () => {
        const [directory] = factory();
        const identities = [
          first,
          { ...first, issuer: "other" },
          { ...first, tenant: "other" },
          { ...first, tenant: null },
          { ...first, subject: "Subject-a" },
          { issuer: "a:b", tenant: "c", subject: "d" },
          { issuer: "a", tenant: "b:c", subject: "d" },
        ];
        const ids = [];
        for (const identity of identities) {
          const id = await person(directory);
          ids.push(id);
          expect(await directory.resolve(identity)).toEqual({ status: "unknown" });
          expect((await directory.change(link(id, identity))).status).toBe("changed");
          expect(await directory.resolve(identity)).toMatchObject({ status: "bound", binding: { personId: id } });
        }
        expect(new Set(ids).size).toBe(identities.length);
      });

      it("commits only one person for concurrent links of one subject", async () => {
        const [directory, other] = factory();
        const ids = await Promise.all([person(directory), person(other)]);
        const results = await Promise.all([directory.change(link(ids[0])), other.change(link(ids[1]))]);
        expect(results.map((r) => r.status).sort()).toEqual(["changed", "conflict"]);
        const winner = results.find((r) => r.status === "changed");
        assert(winner?.status === "changed");
        expect(await other.resolve(first)).toEqual({ status: "bound", binding: winner.binding });
        expect(await receipts(directory)).toHaveLength(1);
      });

      it("email collision grants no person claim", async () => {
        const [directory] = factory();
        const claimsA = { ...first, email: "same@example.test" };
        const claimsB = { ...second, email: "same@example.test" };
        const id = await person(directory);
        await directory.change(link(id));
        expect(await directory.resolve(second)).toEqual({ status: "unknown" });
        expect(await directory.resolve(claimsB)).toEqual({ status: "invalid" });
        expect(await directory.change({ ...link(id), identity: claimsA })).toEqual({ status: "invalid" });
        expect(await directory.change({ ...link(id, second), proof: { method: "email", version: 1 } } as any)).toEqual({
          status: "invalid",
        });
        expect(await receipts(directory, second)).toEqual([]);
      });

      it("fences stale writes and refuses ordinary resurrection after revoke", async () => {
        const [directory, other] = factory();
        const input = link(await person(directory));
        await directory.change(input);
        expect((await other.resolve(first)).status).toBe("bound");
        const revoke = { ...input, action: "revoke" as const, expectedRevision: 1 };
        expect(await directory.change(revoke)).toMatchObject({
          status: "changed",
          binding: { state: "revoked", revision: 2 },
        });
        expect(await other.resolve(first)).toEqual({ status: "revoked", revision: 2 });
        for (const stale of [input, { ...input, expectedRevision: 1 }, revoke])
          expect(await other.change(stale)).toEqual({ status: "stale" });
        expect(await other.change({ ...input, expectedRevision: 2 })).toEqual({ status: "revoked" });
        expect(await receipts(directory)).toHaveLength(2);
      });

      it("recovers only the revoked person with administrator recovery proof", async () => {
        const [directory, other] = factory();
        const input = link(await person(directory));
        await directory.change(input);
        await directory.change({ ...input, action: "revoke", expectedRevision: 1 });
        const recover = { ...input, action: "recover" as const, expectedRevision: 2, actor: second };
        expect(await other.change(recover)).toEqual({ status: "invalid" });
        const audited = { ...recover, proof: { method: "administrator-recovery" as const, version: 2 } };
        expect(await other.change({ ...audited, personId: await person(directory) })).toEqual({ status: "conflict" });
        expect(await other.change(audited)).toMatchObject({
          status: "changed",
          binding: { revision: 3, state: "active", proof: audited.proof },
        });
        expect(await directory.change(audited)).toEqual({ status: "stale" });
        const history = await receipts(directory);
        expect(history.map((r) => r.action)).toEqual(["link", "revoke", "recover"]);
        expect(history[2]).toMatchObject({ actor: second, binding: { personId: input.personId, changedAt: 42 } });
      });

      it("persists closed proof metadata and projects only safe run attribution", async () => {
        const [directory] = factory();
        const input = link(await person(directory));
        for (const extra of [{ token: "secret-token" }, { email: "same@example.test" }, { payload: "raw-proof" }])
          expect(await directory.change({ ...input, proof: { ...proof, ...extra } })).toEqual({ status: "invalid" });
        const result = await directory.change(input);
        assert(result.status === "changed");
        expect(runBindingAttribution(result.binding)).toEqual({
          personId: input.personId,
          bindingRevision: 1,
          proofMethod: proof.method,
          proofVersion: 1,
        });
        expect(await receipts(directory)).toEqual([{ action: "link", actor: first, binding: result.binding }]);
        const revoked = await directory.change({ ...input, action: "revoke", expectedRevision: 1 });
        assert(revoked.status === "changed");
        expect(runBindingAttribution(revoked.binding)).toBeUndefined();
        expect(runBindingAttribution({ ...result.binding, proof: { ...proof, token: "secret" } })).toBeUndefined();
      });

      it("refreshes at the current revision without exposing mutable stored objects", async () => {
        const [directory, other] = factory();
        const input = link(await person(directory));
        const linked = await directory.change(input);
        assert(linked.status === "changed");
        linked.binding.proof.version = 99;
        input.identity = second;
        const resolved = await other.resolve(first);
        assert(resolved.status === "bound");
        resolved.binding.state = "revoked";
        const history = await receipts(other);
        history[0].binding.revision = 100;
        const refreshed = await directory.change({
          ...link(input.personId),
          expectedRevision: 1,
          proof: { ...proof, version: 2 },
        });
        expect(refreshed).toMatchObject({ status: "changed", binding: { revision: 2, proof: { version: 2 } } });
        expect(await other.change({ ...link(input.personId), expectedRevision: 1 })).toEqual({ status: "stale" });
        expect((await receipts(other)).map((r) => r.binding.revision)).toEqual([1, 2]);
        expect((await receipts(other))[0].binding.proof.version).toBe(1);
      });

      it("rejects invalid writes without receipts", async () => {
        const [directory] = factory();
        const input = link(await person(directory));
        const unknown = "person:00000000-0000-4000-8000-000000000000" as PersonId;
        expect(await directory.change({ ...input, personId: unknown })).toEqual({ status: "unknown_person" });
        for (const change of [
          { ...input, expectedRevision: -1 },
          { ...input, expectedRevision: 1.5 },
          { ...input, expectedRevision: Number.MAX_SAFE_INTEGER },
          { ...input, personId: "slack:someone" },
          { ...input, identity: { ...first, tenant: undefined } },
          { ...input, proof: { ...proof, version: 0 } },
        ])
          expect(await directory.change(change as any)).toEqual({ status: "invalid" });
        expect(await receipts(directory)).toEqual([]);
        expect(await directory.change({ ...input, action: "revoke" })).toEqual({ status: "unknown" });
      });
    });
});

describe("SQLite person directory", () => {
  it("arbitrates independent processes contending for one identity", async () => {
    const path = dbPath();
    const { db, directory } = database(path);
    const ids = await Promise.all([person(directory), person(directory)]);
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      import { SqlitePersonDirectory } from ${JSON.stringify(new URL("./sqlite.ts", import.meta.url).href)};
      const db = new DatabaseSync(${JSON.stringify(path)});
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
          const result = await directory.change(input);
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
      // Both processes announce their attempt while this connection holds the
      // write lock. Releasing it forces SQLite, not the JS event loop, to arbitrate.
      db.exec("BEGIN IMMEDIATE");
      let starting = 0;
      const results = children.map(
        (child, index) =>
          new Promise<ChangeResult>((resolve, reject) => {
            child.on("message", (message) => {
              if (message === "starting") {
                if (++starting === 2) db.exec("COMMIT");
              } else resolve(message as ChangeResult);
            });
            child.once("error", reject);
            child.once("exit", (code) => reject(new Error(`writer exited ${code}`)));
            child.send(link(ids[index]));
          }),
      );
      expect((await Promise.all(results)).map((r) => r.status).sort()).toEqual(["changed", "conflict"]);
      expect(await receipts(directory)).toHaveLength(1);
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      for (const child of children) child.kill();
    }
  });

  it("preserves binding and revocation across database reopen", async () => {
    const path = dbPath();
    const initial = database(path);
    const input = link(await person(initial.directory));
    await initial.directory.change(input);
    initial.db.close();
    databases.splice(databases.indexOf(initial.db), 1);
    const restarted = database(path);
    expect(await restarted.directory.resolve(first)).toMatchObject({
      status: "bound",
      binding: { personId: input.personId, proof, revision: 1 },
    });
    await restarted.directory.change({ ...input, action: "revoke", expectedRevision: 1 });
    restarted.db.close();
    databases.splice(databases.indexOf(restarted.db), 1);
    const final = database(path).directory;
    expect(await final.resolve(first)).toEqual({ status: "revoked", revision: 2 });
    expect((await receipts(final)).map((r) => r.action)).toEqual(["link", "revoke"]);
    expect(await final.change(input)).toEqual({ status: "stale" });
  });

  it("rolls back the binding if its receipt cannot commit", async () => {
    const { db, directory } = database(dbPath());
    const input = link(await person(directory));
    db.exec(
      "CREATE TRIGGER refuse_receipt BEFORE INSERT ON person_binding_receipts BEGIN SELECT RAISE(ABORT, 'unavailable'); END",
    );
    expect(await directory.change(input)).toEqual({ status: "unavailable" });
    expect(await directory.resolve(first)).toEqual({ status: "unknown" });
    expect(await receipts(directory)).toEqual([]);
    db.exec("DROP TRIGGER refuse_receipt");
    expect((await directory.change(input)).status).toBe("changed");
  });

  it("refuses corrupt or mismatched durable bindings", async () => {
    const { db, directory } = database(dbPath());
    const input = link(await person(directory));
    const result = await directory.change(input);
    assert(result.status === "changed");
    for (const body of [
      "not json",
      JSON.stringify({ ...result.binding, identity: second }),
      JSON.stringify({ ...result.binding, proof: { ...proof, token: "secret" } }),
      JSON.stringify({ ...result.binding, personId: "person:00000000-0000-4000-8000-000000000000" }),
    ]) {
      db.prepare("UPDATE person_bindings SET body = ?").run(body);
      expect(await directory.resolve(first)).toEqual({ status: "conflict" });
      expect(await directory.change({ ...input, expectedRevision: 1 })).toEqual({ status: "conflict" });
    }
  });
});

describe("directory resolution", () => {
  it("fails closed without a directory or when storage fails", async () => {
    expect(await resolvePerson(undefined, first)).toEqual({ status: "unavailable" });
    const broken = {
      resolve: async () => {
        throw new Error("token=secret");
      },
    } as unknown as PersonDirectory;
    expect(await resolvePerson(broken, first)).toEqual({ status: "unavailable" });
    const failingStorage: DirectorySqlStorage = {
      sql: {
        exec: () => {
          throw new Error("token=secret");
        },
      },
      transactionSync: (body) => body(),
    };
    expect(() => new SqlitePersonDirectory(failingStorage, now)).toThrowError(/^person directory unavailable$/);
    const { db, directory } = database(dbPath());
    const input = link(await person(directory));
    await directory.change(input);
    db.close();
    databases.splice(databases.indexOf(db), 1);
    expect(await directory.resolve(first)).toEqual({ status: "unavailable" });
    expect(await directory.change(input)).toEqual({ status: "unavailable" });
    expect(await directory.createPerson()).toEqual({ status: "unavailable" });
    expect(await directory.receipts(first)).toEqual({ status: "unavailable" });
  });
});
