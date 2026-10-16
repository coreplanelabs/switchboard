// Feature: docs/reference/specs/browser-home.md — live account verification uses the two-sided consent ceremony.
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { InMemoryPersonDirectory } from "../core/identity/memory.js";
import { FakeAccessProofProvider, FakeSlackProofProvider } from "../core/identity/testing/fakeHumanProofs.js";
import { actor } from "../core/authz/testing.js";
import { GREEN_PAGE_CSP, makePageSender } from "./webShell.js";
import { ALL_CAPABILITIES } from "../core/capabilities.js";
import type { IdentitySeed } from "./identitySeed.js";
import { createIdentityRuntime, IDENTITY_PATH, type IdentityRuntimeContext } from "./identityRuntime.js";
import { AccessHumanProofAdapter } from "./linkProofAccess.js";
import type { AccessProofProvider } from "../core/identity/humanProof.js";
import type { AccessJwk } from "./accessAuth.js";
import { generateKeyPairSync, sign } from "node:crypto";

const origin = "https://app.test",
  now = 1000;
const accessIdentity = { issuer: "https://app.cloudflareaccess.com", tenant: null, subject: "alice" };
const slackIdentity = { issuer: "https://slack.com" as const, tenant: "TDEMO", subject: "UDEMO" };
const actorAlice = actor(
  "user",
  "access:alice",
  { actions: "all", channels: "all", repos: "all" },
  { memberOfOrganizations: new Set(["org:test"]) },
);
const context: IdentityRuntimeContext = { actor: actorAlice, evidence: { strategy: "access", token: "fixture-jwt" } };
function fixture(
  options: {
    disabled?: boolean;
    missingSecret?: boolean;
    publicBaseUrl?: string;
    deliver?: (notice: import("../core/identity/linkContract.js").IdentityNotice) => Promise<boolean>;
    clock?: () => number;
    accessProof?: AccessProofProvider;
  } = {},
) {
  const clock = options.clock ?? (() => now);
  const directory = new InMemoryPersonDirectory(clock);
  const config = { slackClientId: "client-a", slackTeamId: "TDEMO", slackClientSecretEnv: "SLACK_LINK_SECRET" };
  const policy = { tenant: "TDEMO", audience: "client-a", callbackUri: `${origin}${IDENTITY_PATH}/callback` };
  const access =
    options.accessProof ??
    new FakeAccessProofProvider([
      {
        credential: "fixture-jwt",
        proof: {
          kind: "human",
          identity: accessIdentity,
          audience: "access-app",
          issuedAt: now,
          expiresAt: now + 600_000,
        },
      },
    ]);
  const slack = new FakeSlackProofProvider({
    identity: slackIdentity,
    audience: policy.audience,
    callbackUri: policy.callbackUri,
    expiresAt: now + 600_000,
  });
  const runtimeOptions = {
    organization: "org:test",
    config: options.disabled ? undefined : config,
    directory,
    access: { teamDomain: "app.cloudflareaccess.com", aud: "access-app" },
    publicBaseUrl: options.publicBaseUrl ?? origin,
    now: clock,
    readSecret: (_name: string) => (options.missingSecret ? undefined : "fixture-client-secret"),
    authorize: (_actor: import("../core/authz/types.js").Actor) => true,
    providers: { access, slack },
    deliverNotice: options.deliver,
    page: makePageSender({ js: "/green.js", css: [] }, ALL_CAPABILITIES, { csp: GREEN_PAGE_CSP }),
  };
  let runtime = createIdentityRuntime(runtimeOptions);
  let cookie = "";
  async function request(
    path = IDENTITY_PATH,
    fields?: Record<string, string>,
    supplied: IdentityRuntimeContext | null = context,
    extra: Record<string, string> = {},
  ) {
    let status = 0,
      body = "",
      finish: () => void = () => {};
    const headers: Record<string, string> = {};
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const req = {
      url: path,
      method: fields ? "POST" : "GET",
      headers: {
        accept: "application/json",
        cookie,
        ...(fields
          ? { origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" }
          : {}),
        ...extra,
      },
      async *[Symbol.asyncIterator]() {
        if (fields) yield Buffer.from(new URLSearchParams(fields).toString());
      },
    } as IncomingMessage;
    const res = {
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
      },
      writeHead(code: number, values: Record<string, string>) {
        status = code;
        for (const [key, value] of Object.entries(values ?? {})) headers[key.toLowerCase()] = value;
      },
      end(value = "") {
        body = value;
        finish();
      },
    } as unknown as ServerResponse;
    expect(runtime(req, res, supplied ?? undefined)).toBe(true);
    await ended;
    if (headers["set-cookie"]) cookie = headers["set-cookie"].split(";")[0];
    return { status, body, headers, seed: body && body.startsWith("{") ? (JSON.parse(body) as IdentitySeed) : null };
  }
  return {
    get runtime() {
      return runtime;
    },
    replaceServer(change?: { missingSlack?: boolean }) {
      runtime = createIdentityRuntime(change?.missingSlack ? { ...runtimeOptions, config: undefined } : runtimeOptions);
    },
    directory,
    request,
    slack,
  };
}

describe("browser identity activation", () => {
  it.each([false, true])(
    "rechecks the signed receiver after addressed notice retries before exposing linked accounts: expired %s",
    async (expire) => {
      let at = now,
        hold = false,
        enter: () => void = () => {},
        release: () => void = () => {};
      const clock = () => at;
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const jwk: AccessJwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture-key" };
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = `${encode({ alg: "RS256", kid: "fixture-key" })}.${encode({ iss: accessIdentity.issuer, aud: "access-app", sub: "alice", iat: 1, exp: 60 })}`;
      const token = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
      const accessProof = new AccessHumanProofAdapter(
        { teamDomain: "app.cloudflareaccess.com", aud: "access-app" },
        { now: clock, fetchJwks: async () => [jwk] },
      );
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const resumed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const delivery = vi.fn(async () => {
        if (hold) {
          enter();
          await resumed;
        }
        return false;
      });
      const h = fixture({ clock, accessProof, deliver: delivery });
      const signedContext = { actor: actorAlice, evidence: { strategy: "access", token } };
      const initial = (await h.request(IDENTITY_PATH, undefined, signedContext)).seed!.view!;
      if (initial.stage !== "start") throw new Error("No current signed proof");
      const begin = await h.request(`${IDENTITY_PATH}/begin`, { csrf: initial.csrf }, signedContext);
      const authorization = new URL(begin.headers.location);
      await h.request(
        `${IDENTITY_PATH}/callback?${new URLSearchParams({ state: authorization.searchParams.get("state")!, code: "fixture-code" })}`,
        undefined,
        signedContext,
      );
      const consent = (await h.request(IDENTITY_PATH, undefined, signedContext)).seed!.view!;
      if (consent.stage !== "awaiting-consent") throw new Error("No verified pair");
      expect(
        (
          await h.request(
            `${IDENTITY_PATH}/commit`,
            { csrf: consent.csrf, revision: "3", consent: "yes" },
            signedContext,
          )
        ).status,
      ).toBe(303);
      hold = true;
      const pending = h.request(IDENTITY_PATH, undefined, signedContext);
      await entered;
      if (expire) at = 61000;
      expect((await accessProof.verify(signedContext.evidence))?.identity ?? null).toEqual(
        expire ? null : accessIdentity,
      );
      release();
      const read = await pending;
      expect({
        status: read.status,
        accountCount: read.seed?.accounts?.length ?? 0,
        canWrite: read.seed?.canWrite,
      }).toEqual({ status: expire ? 403 : 200, accountCount: expire ? 0 : 2, canWrite: !expire });
      if (expire) expect(read.seed?.view).toBeNull();
      expect(h.slack.exchanges).toBe(1);
    },
  );
  it("keeps exact signed-in identity reads and notice acknowledgment available when Slack setup is removed, while binding changes stay unavailable", async () => {
    const h = fixture();
    const start = (await h.request()).seed!.view!;
    if (start.stage !== "start") throw new Error("No fresh verification");
    const initiated = await h.request(`${IDENTITY_PATH}/begin`, { csrf: start.csrf });
    const authorization = new URL(initiated.headers.location);
    await h.request(
      `${IDENTITY_PATH}/callback?${new URLSearchParams({ state: authorization.searchParams.get("state")!, code: "fixture-code" })}`,
    );
    const consent = (await h.request()).seed!.view!;
    if (consent.stage !== "awaiting-consent") throw new Error("No two-sided proof");
    expect(
      (await h.request(`${IDENTITY_PATH}/commit`, { csrf: consent.csrf, revision: "3", consent: "yes" })).status,
    ).toBe(303);
    h.replaceServer({ missingSlack: true });
    const read = (await h.request()).seed!;
    expect(read).toMatchObject({
      view: null,
      canWrite: false,
      canAcknowledge: true,
      accounts: [
        { identity: accessIdentity, state: "active" },
        { identity: slackIdentity, state: "active" },
      ],
      notices: [{ outcome: "created" }],
      unavailable: "This installation has not configured account verification.",
    });
    const notice = read.notices![0];
    expect((await h.request(`${IDENTITY_PATH}/acknowledge`, { csrf: notice.csrf, notice: notice.id })).status).toBe(
      303,
    );
    expect((await h.request()).seed!.notices).toEqual([]);
    expect((await h.request(`${IDENTITY_PATH}/begin`, { csrf: start.csrf })).status).toBe(403);
    expect(
      (await h.request(`${IDENTITY_PATH}/commit`, { csrf: consent.csrf, revision: "3", consent: "yes" })).status,
    ).toBe(403);
    const noOrg = { ...context, actor: actor("user", "access:alice", { actions: "all" }) };
    const denied = await h.request(IDENTITY_PATH, undefined, noOrg);
    expect(denied.status).toBe(403);
    expect(denied.seed?.accounts).toBeUndefined();
    expect(h.slack.exchanges).toBe(1);
  });
  it("retries the stable Slack notice after server replacement without borrowing an Access proof or acknowledging the browser notice", async () => {
    let allowed = false;
    const delivery = vi.fn(async (_notice: import("../core/identity/linkContract.js").IdentityNotice) => allowed);
    const h = fixture({ deliver: delivery });
    const initial = (await h.request()).seed!.view!;
    if (initial.stage !== "start") throw new Error("No fresh verification");
    const started = await h.request(`${IDENTITY_PATH}/begin`, { csrf: initial.csrf });
    const authorization = new URL(started.headers.location);
    await h.request(
      `${IDENTITY_PATH}/callback?${new URLSearchParams({ state: authorization.searchParams.get("state")!, code: "fixture-code" })}`,
    );
    const verified = (await h.request()).seed!.view!;
    if (verified.stage !== "awaiting-consent") throw new Error("No verified pair");
    expect(
      (await h.request(`${IDENTITY_PATH}/commit`, { csrf: verified.csrf, revision: "3", consent: "yes" })).status,
    ).toBe(303);
    expect(await h.runtime.retryNotices()).toEqual({ status: "ok", delivered: 0 });
    const pending = await h.directory.pendingNotices("org:test", 20);
    expect(pending).toMatchObject({ status: "notices", notices: [{ identity: slackIdentity }] });
    h.replaceServer();
    allowed = true;
    expect(await h.runtime.retryNotices()).toEqual({ status: "ok", delivered: 1 });
    h.replaceServer();
    expect(await h.runtime.retryNotices()).toEqual({ status: "ok", delivered: 0 });
    expect(delivery).toHaveBeenCalledTimes(2);
    expect(delivery.mock.calls[0][0].id).toBe(delivery.mock.calls[1][0].id);
    expect((await h.request()).seed!.notices).toMatchObject([{ outcome: "created" }]);
    expect((await h.request()).seed!.pendingNotices).toBe(1);
  });
  it("verifies each unlink and recovery afresh, checks current administrator permission and acknowledges only delivered browser notices", async () => {
    let deliver = false;
    const delivery = vi.fn(async (_notice: import("../core/identity/linkContract.js").IdentityNotice) => deliver);
    const h = fixture({ deliver: delivery });
    async function operation(kind: "link" | "unlink" | "recover") {
      let view = (await h.request()).seed!.view!;
      if ("restartCsrf" in view && view.restartCsrf) {
        expect((await h.request(`${IDENTITY_PATH}/restart`, { csrf: view.restartCsrf })).status).toBe(303);
        view = (await h.request()).seed!.view!;
      }
      if (view.stage !== "start") throw new Error("No fresh verification");
      const token = view.operations?.find((op) => op.kind === kind && op.target === "slack");
      const begin = await h.request(
        `${IDENTITY_PATH}/${kind === "link" ? "begin" : kind}`,
        kind === "link" ? { csrf: view.csrf } : { csrf: token!.csrf, target: "slack" },
      );
      expect(begin.status).toBe(303);
      const authorization = new URL(begin.headers.location);
      await h.request(
        `${IDENTITY_PATH}/callback?${new URLSearchParams({ state: authorization.searchParams.get("state")!, code: "fixture-code" })}`,
      );
      const consent = (await h.request()).seed!.view!;
      if (consent.stage !== "awaiting-consent") throw new Error("Missing two-sided proof");
      expect(consent.operation).toEqual({ kind, target: "slack" });
      return { csrf: consent.csrf, revision: String(consent.revision), consent: "yes" };
    }
    expect((await h.request(`${IDENTITY_PATH}/commit`, await operation("link"))).status).toBe(303);
    const first = (await h.request()).seed!;
    expect(first.accounts).toMatchObject([{ state: "active" }, { state: "active" }]);
    expect(first.pendingNotices).toBe(1);
    expect(first.notices).toHaveLength(1);
    const notice = first.notices![0];
    expect((await h.request(`${IDENTITY_PATH}/acknowledge`, { notice: notice.id, csrf: "invalid" })).status).toBe(403);
    expect((await h.request(`${IDENTITY_PATH}/acknowledge`, { notice: notice.id, csrf: notice.csrf })).status).toBe(
      303,
    );
    expect((await h.request(`${IDENTITY_PATH}/acknowledge`, { notice: notice.id, csrf: notice.csrf })).status).toBe(
      303,
    );
    const afterAck = (await h.request()).seed!;
    expect(afterAck.notices).toEqual([]);
    expect(afterAck.pendingNotices).toBe(0);
    expect(await h.directory.pendingNotices("org:test", 20)).toMatchObject({
      status: "notices",
      notices: [{ identity: slackIdentity, deliveredAt: null }],
    });
    deliver = true;
    expect((await h.request()).seed!.pendingNotices).toBe(0);
    expect(delivery.mock.calls.length).toBeGreaterThan(1);
    expect(new Set(delivery.mock.calls.map((call) => (call as unknown as [{ id: string }])[0].id)).size).toBe(1);
    expect((await h.request(`${IDENTITY_PATH}/commit`, await operation("unlink"))).status).toBe(303);
    expect(await h.directory.resolve(slackIdentity)).toEqual({ status: "revoked", revision: 2 });
    const recovery = await operation("recover");
    const nonAdmin = {
      ...context,
      actor: actor(
        "user",
        "access:alice",
        { actions: new Set(), channels: "all" },
        { memberOfOrganizations: new Set(["org:test"]) },
      ),
    };
    expect((await h.request(`${IDENTITY_PATH}/commit`, recovery, nonAdmin)).status).toBe(403);
    expect(await h.directory.resolve(slackIdentity)).toEqual({ status: "revoked", revision: 2 });
    expect((await h.request(`${IDENTITY_PATH}/commit`, recovery)).status).toBe(303);
    expect(await h.directory.resolve(slackIdentity)).toMatchObject({ status: "bound", binding: { revision: 3 } });
    expect(h.slack.exchanges).toBe(3);
  });
  it("protects every identity response while keeping local form submissions same-origin", async () => {
    const h = fixture();
    const outputs = [
      await h.request(),
      await h.request(IDENTITY_PATH, undefined, context, { accept: "text/html" }),
      await fixture({ disabled: true }).request(),
      await fixture({ missingSecret: true }).request(IDENTITY_PATH, undefined, context, { accept: "text/html" }),
      await h.request(IDENTITY_PATH, undefined, null),
      await h.request(`${IDENTITY_PATH}/callback?code=private-code`, undefined, null),
      await h.request(`${IDENTITY_PATH}/begin`, { csrf: "invalid" }),
      await h.request(`${IDENTITY_PATH}/begin`, { csrf: "invalid" }, context, { accept: "text/html" }),
      await h.request(IDENTITY_PATH, undefined, {
        ...context,
        actor: actor("user", "access:foreign", { actions: "all" }),
      }),
    ];
    for (const [index, output] of outputs.entries()) {
      expect(output.headers["cache-control"]).toBe("no-store");
      expect(output.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(output.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      const formPage = index === 1;
      expect(output.headers["referrer-policy"]).toBe(formPage ? "same-origin" : "no-referrer");
      expect(output.body).not.toContain("private-code");
    }
    const initial = (await h.request()).seed!.view!;
    if (initial.stage !== "start") throw new Error("verification did not start");
    const begin = await h.request(`${IDENTITY_PATH}/begin`, { csrf: initial.csrf });
    expect(begin.status).toBe(303);
    expect(begin.headers["referrer-policy"]).toBe("no-referrer");
    expect(begin.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(new URL(begin.headers.location).origin).toBe("https://provider.test");
    expect(
      (await h.request(`${IDENTITY_PATH}/begin`, { csrf: initial.csrf }, context, { origin: "null" })).status,
    ).toBe(403);
  });
  it("keeps refused hosted HTML private while a successful consent form preserves its local Origin", async () => {
    const h = fixture();
    const form = await h.request(IDENTITY_PATH, undefined, context, { accept: "text/html" });
    expect(form.status).toBe(200);
    expect(form.headers["referrer-policy"]).toBe("same-origin");
    const refusal = await h.request(IDENTITY_PATH, undefined, context, {
      accept: "text/html",
      cookie: `__Host-sb-link=link:11111111-1111-4111-8111-111111111111.${"a".repeat(43)}`,
    });
    expect(refusal.status).toBe(403);
    expect(refusal.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(refusal.headers["referrer-policy"]).toBe("no-referrer");
    expect(refusal.headers["cache-control"]).toBe("no-store");
    expect(refusal.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
  it("keeps unavailable identity notices and negotiated JSON private", async () => {
    const normal = fixture();
    const json = await normal.request(IDENTITY_PATH, undefined, context, {
      accept: 'application/json; profile="text/html"',
    });
    expect(json.status).toBe(200);
    expect(json.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(json.headers["referrer-policy"]).toBe("no-referrer");
    const unavailable = fixture();
    vi.spyOn(unavailable.directory, "link").mockRejectedValue(new Error("directory unavailable"));
    const outputs = [
      await fixture({ disabled: true }).request(IDENTITY_PATH, undefined, context, { accept: "text/html" }),
      await fixture({ missingSecret: true }).request(IDENTITY_PATH, undefined, context, { accept: "text/html" }),
      await fixture({ publicBaseUrl: "http://app.test" }).request(IDENTITY_PATH, undefined, context, {
        accept: "text/html",
      }),
      await unavailable.request(IDENTITY_PATH, undefined, context, {
        accept: "text/html",
        cookie: `__Host-sb-link=link:11111111-1111-4111-8111-111111111111.${"a".repeat(43)}`,
      }),
    ];
    for (const output of outputs) {
      expect(output.status).toBe(200);
      expect(output.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(output.headers["referrer-policy"]).toBe("no-referrer");
      expect(output.headers["cache-control"]).toBe("no-store");
      expect(output.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    }
    const form = await fixture().request(IDENTITY_PATH, undefined, context, { accept: "text/html" });
    expect(form.status).toBe(200);
    expect(form.headers["referrer-policy"]).toBe("same-origin");
  });
  it("serves the selected green identity document with protected native forms and the pinned Slack redirect allowed", async () => {
    const rendered = await fixture().request(IDENTITY_PATH, undefined, context, { accept: "text/html" });
    expect(rendered.status).toBe(200);
    expect(rendered.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(
      rendered.headers["content-security-policy"]
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("form-action")),
    ).toBe("form-action 'self' https://slack.com");
    expect(rendered.body).toContain('"page":"identities"');
    expect(rendered.body).toContain('src="/green.js"');
  });
  it("keeps absent configuration and a named missing secret truthfully unavailable", async () => {
    const disabled = await fixture({ disabled: true }).request();
    expect(disabled.seed).toMatchObject({
      page: "identities",
      view: null,
      canWrite: false,
      unavailable: "This installation has not configured account verification.",
    });
    const missing = await fixture({ missingSecret: true }).request();
    expect(missing.seed).toMatchObject({
      page: "identities",
      view: null,
      canWrite: false,
      unavailable: "Account verification requires SLACK_LINK_SECRET.",
    });
  });
  it("verifies both accounts before explicit consent and returns the same durable link on an identical retry", async () => {
    const h = fixture();
    const initial = await h.request();
    expect(initial.status).toBe(200);
    expect(initial.seed).toMatchObject({ page: "identities", canWrite: true, view: { stage: "start" } });
    const view = initial.seed!.view!;
    if (view.stage !== "start") throw new Error("verification did not start");
    const begin = await h.request(`${IDENTITY_PATH}/begin`, { csrf: view.csrf });
    expect(begin.status).toBe(303);
    expect(begin.headers["set-cookie"]).toContain("Secure; HttpOnly; SameSite=Lax");
    const authorization = new URL(begin.headers.location);
    const callback = await h.request(
      `${IDENTITY_PATH}/callback?${new URLSearchParams({ state: authorization.searchParams.get("state")!, code: "fixture-code" })}`,
    );
    expect(callback.headers.location).toBe(`${origin}${IDENTITY_PATH}`);
    expect(callback.body).toBe("");
    expect(await h.directory.resolve(accessIdentity)).toEqual({ status: "unknown" });
    const consent = (await h.request()).seed!.view!;
    expect(consent).toMatchObject({
      stage: "awaiting-consent",
      access: { subject: "alice" },
      slack: { subject: "UDEMO", tenant: "TDEMO" },
    });
    if (consent.stage !== "awaiting-consent") throw new Error("accounts were not verified");
    const fields = { csrf: consent.csrf, revision: String(consent.revision), consent: "yes" };
    expect((await h.request(`${IDENTITY_PATH}/commit`, fields)).status).toBe(303);
    const binding = await h.directory.resolve(accessIdentity);
    expect(binding).toMatchObject({
      status: "bound",
      binding: { identity: accessIdentity, revision: 1, proof: { method: "dual-authentication", version: 1 } },
    });
    expect((await h.request(`${IDENTITY_PATH}/commit`, fields)).status).toBe(303);
    expect(await h.directory.resolve(accessIdentity)).toEqual(binding);
    expect((await h.request()).seed?.view).toMatchObject({
      stage: "committed",
      operation: { kind: "link", target: "slack" },
    });
  });
  it("refuses service, view-as and cross-site mutation without creating an account binding", async () => {
    const h = fixture();
    const loaded = await h.request();
    expect(loaded.status).toBe(200);
    const initial = loaded.seed!.view!;
    if (initial.stage !== "start") throw new Error("verification did not start");
    const fields = { csrf: initial.csrf };
    expect(
      (
        await h.request(`${IDENTITY_PATH}/begin`, fields, {
          ...context,
          actor: actor("service", "access:svc:automation", { actions: "all", channels: "all", repos: "all" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.request(`${IDENTITY_PATH}/begin`, fields, {
          ...context,
          actor: { ...actorAlice, viewingAs: { id: "slack:UOTHER" } },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.request(`${IDENTITY_PATH}/begin`, fields, context, {
          origin: "https://foreign.test",
          "sec-fetch-site": "cross-site",
        })
      ).status,
    ).toBe(403);
    expect(await h.directory.resolve(accessIdentity)).toEqual({ status: "unknown" });
    expect(await h.directory.resolve(slackIdentity)).toEqual({ status: "unknown" });
  });
});
