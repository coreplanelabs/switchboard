import { createHmac } from "node:crypto";
import { globSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { InMemoryPersonDirectory } from "../core/identity/memory.js";
import { SqlitePersonDirectory } from "../core/identity/sqlite.js";
import type { PersonDirectory } from "../core/identity/contract.js";
import { LinkCeremony } from "../core/identity/linkCeremony.js";
import { FakeAccessProofProvider, FakeSlackProofProvider } from "../core/identity/testing/fakeHumanProofs.js";
import { LinkBrowser, type LinkConsentView } from "./linkBrowser.js";

const origin = "https://localhost";
const path = "/account-link";
const start = 1_800_000_000_000;
const accessIdentity = { issuer: "https://proof.cloudflareaccess.com", tenant: null, subject: "human-a" };
const slackIdentity = { issuer: "https://slack.com" as const, tenant: "TDEMO", subject: "UDEMO" };
const policy = { tenant: slackIdentity.tenant, audience: "client-a", callbackUri: `${origin}${path}/callback` };
const evidence = { strategy: "access", token: "fixture-jwt" };
const close: (() => void)[] = [];
afterEach(() => {
  close.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
});

function harness(kind = "memory") {
  let time = start;
  const now = () => time;
  let db: DatabaseSync | undefined;
  let directory: PersonDirectory;
  const file = join(mkdtempSync(join(tmpdir(), "browser-link-")), "directory.sqlite");
  const open = () => {
    db = new DatabaseSync(file);
    directory = new SqlitePersonDirectory(
      {
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
      },
      now,
    );
  };
  if (kind === "sqlite") open();
  else directory = new InMemoryPersonDirectory(now);
  close.push(() => db?.close());
  const proof = {
    kind: "human" as const,
    identity: accessIdentity,
    audience: "application",
    issuedAt: start,
    expiresAt: start + 3600_000,
  };
  const access = new FakeAccessProofProvider([
    { credential: evidence.token, proof },
    { credential: "subject-switch", proof: { ...proof, identity: { ...accessIdentity, subject: "other-human" } } },
    { credential: "issuer-switch", proof: { ...proof, identity: { ...accessIdentity, issuer: "https://other.test" } } },
    { credential: "audience-switch", proof: { ...proof, audience: "other-application" } },
    { credential: "refreshed", proof: { ...proof, expiresAt: start + 7200_000 } },
  ]);
  const slack = new FakeSlackProofProvider({
    identity: slackIdentity,
    audience: policy.audience,
    callbackUri: policy.callbackUri,
    expiresAt: start + 300_000,
  });
  const ceremony = () => new LinkCeremony({ directory, access, slack, now }, policy);
  const adapter = (mode?: "local-fixture", site = origin) =>
    new LinkBrowser({ ceremony: ceremony(), origin: site, mode });
  let cookie = "";
  const request = (
    route: string,
    fields?: Record<string, string>,
    headers: Record<string, string> = {},
    credential = evidence.token,
  ) =>
    adapter("local-fixture").handle(
      new Request(`${origin}${route}`, {
        method: fields ? "POST" : "GET",
        headers: {
          cookie,
          ...(fields
            ? { origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" }
            : {}),
          ...headers,
        },
        body: fields ? new URLSearchParams(fields) : undefined,
      }),
      { ...evidence, token: credential },
    );
  async function view() {
    const response = await request(path);
    if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0];
    return (await response.json()) as LinkConsentView;
  }
  async function begin() {
    const v = await view();
    assert(v.stage === "start");
    const response = await request(`${path}/begin`, { csrf: v.csrf });
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("; Path=/; Secure; HttpOnly; SameSite=Lax");
    expect(response.headers.get("set-cookie")).not.toMatch(/Domain=|Expires=/);
    cookie = response.headers.get("set-cookie")!.split(";")[0];
    const url = new URL(response.headers.get("location")!);
    return {
      callback: `${path}/callback?${new URLSearchParams({ state: url.searchParams.get("state")!, code: "fixture-code" })}`,
      authorization: url.href,
    };
  }
  async function ready() {
    const b = await begin();
    await request(b.callback);
    const v = await view();
    assert(v.stage === "awaiting-consent");
    return { ...b, view: v, fields: { csrf: v.csrf, revision: String(v.revision), consent: "yes" } };
  }
  return {
    access,
    slack,
    adapter,
    request,
    view,
    begin,
    ready,
    ceremony,
    get directory() {
      return directory;
    },
    get cookie() {
      return cookie;
    },
    acceptCookie(response: Response) {
      const set = response.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
    },
    at(t: number) {
      time = t;
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
  };
}

describe("staged browser linking", () => {
  it("keeps the entry disabled and refuses nonlocal fixture origins", async () => {
    const h = harness();
    const verify = vi.spyOn(h.access, "verify");
    const link = vi.spyOn(h.directory, "link");
    for (const adapter of [h.adapter(), h.adapter("local-fixture", "https://production.test")]) {
      const response = await adapter.handle(new Request(`${origin}${path}`), evidence);
      expect(response.status).toBe(404);
    }
    expect(verify).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
    // An enabling registration must deliberately change this release fence.
    for (const file of globSync("src/**/*.ts").filter((f) => !f.endsWith(".test.ts") && !f.endsWith("linkBrowser.ts")))
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from ["'].*\/linkBrowser\.js["']/);
    expect(readFileSync("web/src/routes.ts", "utf8")).not.toContain("account-link");
    expect(readFileSync("web/src/main.ts", "utf8")).not.toContain("account-link");
  });
  it("contains asynchronous rendering failures instead of leaking them to a host logger", async () => {
    const h = harness();
    await h.ready();
    const ceremony = h.ceremony();
    vi.spyOn(ceremony, "inspect").mockRejectedValue(new Error("credential-bearing-error"));
    const adapter = new LinkBrowser({ ceremony, origin, mode: "local-fixture" });
    const response = await adapter.handle(new Request(`${origin}${path}`, { headers: { cookie: h.cookie } }), evidence);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ stage: "unavailable" });
  });
  for (const kind of ["memory", "sqlite"])
    describe(kind, () => {
      it("protects every POST and rejects client-selected targets", async () => {
        const h = harness(kind);
        const v = await h.view();
        assert(v.stage === "start");
        expect((await h.request(`${path}/begin`, { csrf: v.csrf }, { origin: "https://foreign.test" })).status).toBe(
          403,
        );
        expect((await h.request(`${path}/begin`, { csrf: v.csrf }, { "sec-fetch-site": "cross-site" })).status).toBe(
          403,
        );
        expect((await h.request(`${path}/begin`, { csrf: "wrong" })).status).toBe(403);
        const r = await h.ready();
        for (const action of ["commit", "cancel", "interrupt"]) {
          expect((await h.request(`${path}/${action}`, { ...r.fields, csrf: "wrong" })).status).toBe(403);
          expect((await h.request(`${path}/${action}`, r.fields, { origin: "null" })).status).toBe(403);
        }
        expect((await h.request(`${path}/commit`, { ...r.fields, personId: "person:chosen" })).status).toBe(400);
        expect((await h.request(`${path}/commit`, { ...r.fields, team: "TOTHER" })).status).toBe(400);
        expect(await h.directory.resolve(accessIdentity)).toEqual({ status: "unknown" });
      });
      it("shows verified accounts and requires explicit local consent", async () => {
        const h = harness(kind);
        const r = await h.ready();
        expect(r.view).toMatchObject({
          access: { ...accessIdentity, audience: "application" },
          slack: slackIdentity,
          expiresAt: start + 300_000,
        });
        expect(h.cookie).toMatch(/^__Host-sb-link=link:/);
        expect(await h.directory.resolve(accessIdentity)).toEqual({ status: "unknown" });
        expect((await h.request(`${path}/commit`, { ...r.fields, consent: "no" })).status).toBe(400);
        expect(await h.directory.resolve(slackIdentity)).toEqual({ status: "unknown" });
        const response = await h.request(`${path}/commit`, r.fields);
        expect(response.status).toBe(303);
        expect(await h.view()).toMatchObject({ stage: "committed" });
        expect(await h.directory.resolve(accessIdentity)).toMatchObject({ status: "bound", binding: { revision: 1 } });
        expect(await h.directory.resolve(slackIdentity)).toMatchObject({ status: "bound", binding: { revision: 1 } });
      });
      it("revalidates the browser and exact Access account at callback and consent", async () => {
        const h = harness(kind);
        const b = await h.begin();
        for (const token of ["subject-switch", "issuer-switch", "audience-switch"])
          await h.request(b.callback, undefined, {}, token);
        await h.request(b.callback, undefined, { cookie: h.cookie.replace(/\.[^.]+$/, `.${"b".repeat(43)}`) });
        await h.request(b.callback, undefined, { cookie: "" });
        expect(h.slack.exchanges).toBe(0);
        await h.request(b.callback);
        const v = await h.view();
        assert(v.stage === "awaiting-consent");
        const fields = { csrf: v.csrf, revision: String(v.revision), consent: "yes" };
        for (const token of ["subject-switch", "issuer-switch", "audience-switch"]) {
          expect((await h.request(`${path}/commit`, fields, {}, token)).status).toBe(403);
        }
        expect((await h.request(`${path}/commit`, fields, { cookie: "" })).status).toBe(403);
        expect(await h.directory.resolve(accessIdentity)).toEqual({ status: "unknown" });
      });
      it("refuses cancelled and expired intents without extending the deadline", async () => {
        const h = harness(kind);
        const r = await h.ready();
        await h.request(`${path}/cancel`, { csrf: r.view.cancelCsrf, revision: String(r.view.revision) });
        await h.request(r.callback);
        expect(await h.view()).toMatchObject({ stage: "cancelled" });
        expect((await h.request(`${path}/commit`, r.fields)).status).toBe(409);
        const h2 = harness(kind);
        const r2 = await h2.ready();
        h2.at(start + 300_000);
        expect((await h2.request(`${path}/commit`, r2.fields, {}, "refreshed")).status).toBe(409);
        expect(await h2.view()).toMatchObject({ stage: "expired" });
        expect(await h2.directory.resolve(accessIdentity)).toEqual({ status: "unknown" });
        const h3 = harness(kind);
        const b3 = await h3.begin();
        h3.at(start + 600_000);
        await h3.request(b3.callback, undefined, {}, "refreshed");
        expect(h3.slack.exchanges).toBe(0);
      });
      it("lets a protected terminal browser start fresh without losing the old result window", async () => {
        const h = harness(kind);
        const r = await h.ready();
        await h.request(`${path}/cancel`, { csrf: r.view.cancelCsrf, revision: String(r.view.revision) });
        const oldCookie = h.cookie;
        const terminal = await h.view();
        assert(terminal.stage === "cancelled");
        expect(terminal.restartCsrf).toMatch(/^[0-9a-f]{64}$/);
        assert(terminal.restartCsrf);
        expect(h.cookie).toBe(oldCookie);
        expect((await h.request(`${path}/restart`, { csrf: "wrong" })).status).toBe(403);
        expect(
          (await h.request(`${path}/restart`, { csrf: terminal.restartCsrf }, { origin: "https://foreign.test" }))
            .status,
        ).toBe(403);
        expect((await h.request(`${path}/restart`, { csrf: terminal.restartCsrf, personId: "chosen" })).status).toBe(
          400,
        );
        expect(h.cookie).toBe(oldCookie);
        const oldResult = h.dump();
        const restarted = await h.request(`${path}/restart`, { csrf: terminal.restartCsrf });
        expect(restarted.status).toBe(303);
        expect(restarted.headers.get("location")).toBe(`${origin}${path}`);
        expect(restarted.headers.get("set-cookie")).toMatch(/^__Host-sb-link=seed:/);
        expect(h.dump()).toBe(oldResult);
        expect((await h.request(path)).status).toBe(200);
        expect(await h.view()).toMatchObject({ stage: "cancelled" });
        h.acceptCookie(restarted);
        expect(await h.view()).toMatchObject({ stage: "start" });
        await h.begin();
        expect(h.cookie).toMatch(/^__Host-sb-link=link:/);
        expect(h.cookie).not.toBe(oldCookie);
        expect((await h.request(path, undefined, { cookie: oldCookie })).status).toBe(200);
        expect((await (await h.request(path, undefined, { cookie: oldCookie })).json()).stage).toBe("cancelled");
        expect(
          (
            await h.request(
              `${path}/cancel`,
              { csrf: r.view.cancelCsrf, revision: String(r.view.revision) },
              { cookie: oldCookie },
            )
          ).status,
        ).toBe(303);
        expect(await h.directory.resolve(accessIdentity)).toEqual({ status: "unknown" });
      });
      it("offers a fresh start after failure and expiry but never replaces an active or committed session", async () => {
        const h = harness(kind);
        const pending = await h.begin();
        expect((await h.view()).stage).toBe("pending");
        const restartToken = createHmac("sha256", h.cookie.split("=")[1]).update("link-form:restart:").digest("hex");
        expect((await h.request(`${path}/restart`, { csrf: restartToken })).status).toBe(409);
        await h.request(pending.callback);
        const ready = await h.view();
        assert(ready.stage === "awaiting-consent");
        await h.request(`${path}/commit`, { csrf: ready.csrf, revision: String(ready.revision), consent: "yes" });
        const committed = await h.view();
        expect(committed.stage).toBe("committed");
        expect("restartCsrf" in committed).toBe(false);
        expect((await h.request(`${path}/restart`, { csrf: restartToken })).status).toBe(409);
        const failed = harness(kind);
        const b = await failed.begin();
        vi.spyOn(failed.slack, "exchange").mockResolvedValueOnce(null);
        await failed.request(b.callback);
        const failure = await failed.view();
        assert(failure.stage === "failed");
        expect(failure.restartCsrf).toMatch(/^[0-9a-f]{64}$/);
        assert(failure.restartCsrf);
        expect((await failed.request(`${path}/restart`, { csrf: failure.restartCsrf })).status).toBe(303);
        const expiredSession = harness(kind);
        await expiredSession.begin();
        expiredSession.at(start + 1_200_000);
        const expired = await expiredSession.view();
        assert(expired.stage === "expired");
        expect(expired.restartCsrf).toMatch(/^[0-9a-f]{64}$/);
        assert(expired.restartCsrf);
        expect(
          (await expiredSession.request(`${path}/restart`, { csrf: expired.restartCsrf }, {}, "refreshed")).status,
        ).toBe(303);
      });
      it("fences callback replay and interrupted exchange across reconstruction", async () => {
        const h = harness(kind);
        const b = await h.begin();
        let release!: (v: null) => void;
        const exchange = vi.spyOn(h.slack, "exchange").mockImplementation(
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        );
        const inFlight = h.request(b.callback);
        await vi.waitFor(() => expect(exchange).toHaveBeenCalledTimes(1));
        h.reopen();
        await h.request(b.callback);
        const v = await h.view();
        assert(v.stage === "exchanging");
        await h.request(`${path}/interrupt`, { csrf: v.interruptCsrf!, revision: String(v.revision) });
        release(null);
        await inFlight;
        expect(await h.view()).toMatchObject({ stage: "failed" });
        await h.request(b.callback);
        expect(exchange).toHaveBeenCalledTimes(1);
        expect(await h.directory.resolve(accessIdentity)).toEqual({ status: "unknown" });
      });
      it("replays duplicate final POSTs and response loss without another mutation", async () => {
        const h = harness(kind);
        const r = await h.ready();
        const responses = await Promise.all([
          h.request(`${path}/commit`, r.fields),
          h.request(`${path}/commit`, r.fields),
        ]);
        expect(responses.map((r) => r.status)).toEqual([303, 303]);
        const committed = h.dump();
        h.reopen();
        expect((await h.request(`${path}/commit`, r.fields)).status).toBe(303);
        expect(await h.view()).toMatchObject({ stage: "committed" });
        await h.request(r.callback);
        expect(h.slack.exchanges).toBe(1);
        expect(h.dump()).toBe(committed);
        expect(await h.directory.receipts(accessIdentity)).toMatchObject({
          receipts: [expect.objectContaining({ action: "link" })],
        });
        expect(await h.directory.receipts(slackIdentity)).toMatchObject({
          receipts: [expect.objectContaining({ action: "link" })],
        });
        h.at(start + 1200_000);
        const closed = await h.view();
        expect(closed).toEqual({ stage: "result-expired" });
        const restartToken = createHmac("sha256", h.cookie.split("=")[1]).update("link-form:restart:").digest("hex");
        expect((await h.request(`${path}/restart`, { csrf: restartToken })).status).toBe(409);
        expect(
          await h
            .ceremony()
            .read({ id: h.cookie.split("=")[1].split(".")[0], browser: h.cookie.split(".")[1] }, evidence),
        ).toEqual({ status: "expired" });
        expect(await h.directory.resolve(accessIdentity)).toMatchObject({ status: "bound" });
      });
      it("contains callback secrets and suppresses credential-bearing failures", async () => {
        const h = harness(kind);
        const sinks = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
        const commands = vi.spyOn(h.directory, "link");
        const b = await h.begin();
        const cookie = h.cookie;
        vi.spyOn(h.slack, "exchange").mockRejectedValueOnce(
          new Error("fixture-code fixture-jwt client-secret refresh-token raw-query"),
        );
        const response = await h.request(b.callback);
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe(`${origin}${path}`);
        expect(await response.text()).toBe("");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
        const dump = h.dump() + JSON.stringify(await h.view()) + JSON.stringify(commands.mock.calls);
        for (const secret of [
          "fixture-code",
          "fixture-jwt",
          "client-secret",
          "refresh-token",
          "raw-query",
          cookie.split(".")[1],
          new URL(b.authorization).searchParams.get("state")!,
          new URL(b.authorization).searchParams.get("nonce")!,
        ])
          expect(dump).not.toContain(secret);
        for (const sink of sinks) expect(sink).not.toHaveBeenCalled();
        for (const bad of [`${b.callback}&code=second-code`, `${b.callback}&error=raw-query`]) {
          const refused = await h.request(bad);
          expect(refused.status).toBe(303);
          expect(await refused.text()).toBe("");
        }
      });
    });
});
