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

const origin = "https://app.test",
  now = 1000;
const accessIdentity = { issuer: "https://app.cloudflareaccess.com", tenant: null, subject: "alice" };
const slackIdentity = { issuer: "https://slack.com" as const, tenant: "TDEMO", subject: "UDEMO" };
const actorAlice = actor("user", "access:alice", { actions: "all", channels: "all", repos: "all" });
const context: IdentityRuntimeContext = { actor: actorAlice, evidence: { strategy: "access", token: "fixture-jwt" } };
function fixture(options: { disabled?: boolean; missingSecret?: boolean; publicBaseUrl?: string } = {}) {
  const directory = new InMemoryPersonDirectory(() => now);
  const config = { slackClientId: "client-a", slackTeamId: "TDEMO", slackClientSecretEnv: "SLACK_LINK_SECRET" };
  const policy = { tenant: "TDEMO", audience: "client-a", callbackUri: `${origin}${IDENTITY_PATH}/callback` };
  const access = new FakeAccessProofProvider([
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
  const runtime = createIdentityRuntime({
    config: options.disabled ? undefined : config,
    directory,
    access: { teamDomain: "app.cloudflareaccess.com", aud: "access-app" },
    publicBaseUrl: options.publicBaseUrl ?? origin,
    now: () => now,
    readSecret: () => (options.missingSecret ? undefined : "fixture-client-secret"),
    authorize: () => true,
    providers: { access, slack },
    page: makePageSender({ js: "/green.js", css: [] }, ALL_CAPABILITIES, { csp: GREEN_PAGE_CSP }),
  });
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
  return { runtime, directory, request };
}

describe("browser identity activation", () => {
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
    expect((await h.request()).seed?.view).toEqual({ stage: "committed" });
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
