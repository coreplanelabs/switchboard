import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import type { PersonDirectory } from "./contract.js";
import { InMemoryPersonDirectory } from "./memory.js";
import { SqlitePersonDirectory, type DirectorySqlStorage } from "./sqlite.js";
import { LinkCeremony } from "./linkCeremony.js";
import { FakeAccessProofProvider, FakeSlackProofProvider } from "./testing/fakeHumanProofs.js";
import { proofDigest } from "./humanProof.js";

const start = 1_800_000_000_000;
const accessIdentity = { issuer: "https://proof.cloudflareaccess.com", tenant: null, subject: "human-a" };
const slackIdentity = { issuer: "https://slack.com" as const, tenant: "TDEMO", subject: "UDEMO" };
const policy = { tenant: slackIdentity.tenant, audience: "client-a", callbackUri: "https://app.test/link/callback" };
const evidence = { strategy: "access", token: "fixture-access" };
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups.splice(0).forEach((close) => close());
});
function harness(kind: string, accessExpiry = start + 3600_000, slackExpiry = start + 300_000) {
  let time = start;
  const now = () => time;
  let db: DatabaseSync | undefined;
  let directory: PersonDirectory;
  const path = join(mkdtempSync(join(tmpdir(), "proof-")), "proof.sqlite");
  const open = () => {
    db = new DatabaseSync(path);
    const storage: DirectorySqlStorage = {
      sql: { exec: (sql, ...params) => db!.prepare(sql).all(...params) as any },
      transactionSync: (body) => {
        db!.exec("BEGIN IMMEDIATE");
        try {
          const result = body();
          db!.exec("COMMIT");
          return result;
        } catch (e) {
          db!.exec("ROLLBACK");
          throw e;
        }
      },
    };
    directory = new SqlitePersonDirectory(storage, now);
  };
  if (kind === "sqlite") open();
  else directory = new InMemoryPersonDirectory(now);
  cleanups.push(() => db?.close());
  const access = new FakeAccessProofProvider([
    {
      credential: "fixture-access",
      proof: {
        kind: "human",
        identity: accessIdentity,
        audience: "application",
        issuedAt: start,
        expiresAt: accessExpiry,
      },
    },
    {
      credential: "fixture-switched",
      proof: {
        kind: "human",
        identity: { ...accessIdentity, subject: "human-other" },
        audience: "application",
        issuedAt: start,
        expiresAt: accessExpiry,
      },
    },
    {
      credential: "fixture-refreshed",
      proof: {
        kind: "human",
        identity: accessIdentity,
        audience: "application",
        issuedAt: start,
        expiresAt: start + 7200_000,
      },
    },
  ]);
  const slack = new FakeSlackProofProvider({
    identity: slackIdentity,
    audience: policy.audience,
    callbackUri: policy.callbackUri,
    expiresAt: slackExpiry,
  });
  const ceremony = () => new LinkCeremony({ directory, access, slack, now }, policy);
  return {
    access,
    slack,
    ceremony,
    get directory() {
      return directory;
    },
    at(v: number) {
      time = v;
    },
    reopen() {
      if (db) {
        db.close();
        open();
      }
    },
    dump() {
      return db
        ? JSON.stringify(
            ["person_link_intents", "person_link_outcomes", "person_bindings", "person_binding_receipts"].map((t) =>
              db!.prepare(`SELECT * FROM ${t}`).all(),
            ),
          )
        : JSON.stringify((directory as any).state, (_k, v) => (v instanceof Map ? [...v] : v));
    },
    async begin() {
      const result = await ceremony().begin(evidence);
      assert(result.status === "started");
      const url = new URL(result.authorizationUrl);
      return {
        ...result,
        request: {
          session: result.session,
          evidence,
          method: "GET",
          callbackUri: policy.callbackUri,
          query: new URLSearchParams({ state: url.searchParams.get("state")!, code: "fixture-code" }),
        },
      };
    },
  };
}

describe("offline link ceremony", () => {
  for (const kind of ["memory", "sqlite"])
    describe(kind, () => {
      it("hands only validated metadata to the atomic consent transaction", async () => {
        const h = harness(kind);
        const b = await h.begin();
        expect(b.expiresAt).toBe(start + 600_000);
        const response = await h.ceremony().callback(b.request);
        expect(response.result).toMatchObject({
          status: "ok",
          intent: { state: "awaiting-consent", expiresAt: start + 300_000 },
        });
        expect(await h.directory.resolve(accessIdentity)).toEqual({ status: "unknown" });
        expect(await h.ceremony().commit(b.session, evidence, 3, false)).toEqual({ status: "consent_required" });
        const result = await h.ceremony().commit(b.session, evidence, 3, true);
        expect(result).toMatchObject({
          status: "committed",
          receipt: { consent: true, actor: accessIdentity, slack: { identity: slackIdentity } },
        });
        expect(await h.directory.resolve(accessIdentity)).toMatchObject({ status: "bound", binding: { revision: 1 } });
        expect(await h.directory.resolve(slackIdentity)).toMatchObject({ status: "bound", binding: { revision: 1 } });
        h.reopen();
        expect(await h.ceremony().read(b.session, evidence)).toEqual(result);
        expect(h.slack.exchanges).toBe(1);
      });
      it("rejects replay concurrent callbacks wrong state wrong browser and account switch", async () => {
        const h = harness(kind);
        const b = await h.begin();
        for (const request of [
          { ...b.request, query: new URLSearchParams({ state: "wrong", code: "fixture-code" }) },
          { ...b.request, session: { ...b.session, browser: "b".repeat(43) } },
          { ...b.request, evidence: { ...evidence, token: "fixture-switched" } },
          { ...b.request, evidence: { strategy: "none", token: "fixture-access" } },
        ])
          expect((await h.ceremony().callback(request)).result.status).not.toBe("ok");
        expect(h.slack.exchanges).toBe(0);
        const results = await Promise.all([h.ceremony().callback(b.request), h.ceremony().callback(b.request)]);
        expect(results.filter((r) => r.result.status === "ok")).toHaveLength(1);
        expect(h.slack.exchanges).toBe(1);
        expect(await h.ceremony().commit(b.session, { ...evidence, token: "fixture-switched" }, 3, true)).toEqual({
          status: "not_found",
        });
        await h.ceremony().commit(b.session, evidence, 3, true);
        expect((await h.ceremony().callback(b.request)).result.status).toBe("already_claimed");
        expect(h.slack.exchanges).toBe(1);
      });
      it("bounds Access Slack intent and result lifetimes without refresh extension", async () => {
        const h = harness(kind, start + 120_000, start + 300_000);
        const b = await h.begin();
        expect(b.expiresAt).toBe(start + 120_000);
        h.at(start + 120_000);
        expect(
          (await h.ceremony().callback({ ...b.request, evidence: { ...evidence, token: "fixture-refreshed" } })).result
            .status,
        ).toBe("expired");
        expect(h.slack.exchanges).toBe(0);
        const h2 = harness(kind);
        const b2 = await h2.begin();
        await h2.ceremony().callback(b2.request);
        h2.at(start + 300_000);
        expect(await h2.ceremony().commit(b2.session, evidence, 3, true)).toEqual({ status: "expired" });
        const h3 = harness(kind);
        const b3 = await h3.begin();
        await h3.ceremony().callback(b3.request);
        await h3.ceremony().commit(b3.session, evidence, 3, true);
        h3.at(start + 1200_000);
        expect(await h3.ceremony().read(b3.session, evidence)).toEqual({ status: "expired" });
      });
      it("fails callback crashes and recovers a durable claim without exchanging again", async () => {
        const h = harness(kind);
        const b = await h.begin();
        vi.spyOn(h.slack, "exchange").mockRejectedValueOnce(new Error("code-secret jwt-secret"));
        expect((await h.ceremony().callback(b.request)).result.status).toBe("failed");
        expect((await h.ceremony().callback(b.request)).result.status).toBe("failed");
        const h2 = harness(kind);
        const b2 = await h2.begin();
        const auth = {
          identity: accessIdentity,
          audience: "application",
          browserHash: proofDigest(b2.session.browser),
          proofVersion: 1,
          expiresAt: start + 3600_000,
        };
        expect(
          await h2.directory.link({
            action: "claim",
            id: b2.session.id,
            auth,
            expectedRevision: 1,
            stateHash: proofDigest(b2.request.query.get("state")!),
          }),
        ).toMatchObject({ status: "claimed" });
        h2.reopen();
        expect((await h2.ceremony().callback(b2.request)).result.status).toBe("already_claimed");
        expect(await h2.ceremony().interrupt(b2.session, evidence)).toEqual({ status: "failed" });
        expect(h2.slack.exchanges).toBe(0);
        expect(await h2.directory.resolve(accessIdentity)).toEqual({ status: "unknown" });
      });
      it("rejects callback transport drift and keeps secrets out of persistence and responses", async () => {
        const h = harness(kind);
        const b = await h.begin();
        const query = new URLSearchParams(b.request.query);
        query.append("code", "second-code");
        for (const request of [
          { ...b.request, method: "POST" },
          { ...b.request, callbackUri: policy.callbackUri + "/" },
          { ...b.request, query },
        ]) {
          const result = await h.ceremony().callback(request);
          expect(result.result.status).toBe("invalid");
          expect(result.response).toEqual({
            status: 303,
            headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", Location: "https://app.test/" },
          });
        }
        expect(h.slack.exchanges).toBe(0);
        const response = await h.ceremony().callback(b.request);
        await h.ceremony().commit(b.session, evidence, 3, true);
        const serialized = h.dump() + JSON.stringify(response);
        for (const secret of [
          "fixture-code",
          "fixture-access",
          b.session.browser,
          b.request.query.get("state")!,
          new URL(b.authorizationUrl).searchParams.get("nonce")!,
        ])
          expect(serialized).not.toContain(secret);
      });
    });
});
