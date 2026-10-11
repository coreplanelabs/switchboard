import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { JwksCache, type AccessJwk } from "./accessAuth.js";
import { accessVerifier } from "./dashboardAuth.js";
import { createOrganizationNativeSources } from "./organizationNativeSources.js";
describe("organization native sources", () => {
  it("keeps a valid signed browser session unavailable through a cert outage and revalidates after recovery", async () => {
    const config = { teamDomain: "fixture.cloudflareaccess.com", aud: "dashboard" };
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk: AccessJwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture-key" };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = (kid = "fixture-key", exp = 60) => {
      const unsigned = `${encode({ alg: "RS256", kid })}.${encode({ iss: `https://${config.teamDomain}`, aud: config.aud, sub: "alice", exp })}`;
      return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
    };
    let now = 0,
      available = true;
    const dashboard = accessVerifier(config, {
      cache: new JwksCache(),
      now: () => now,
      ttlSeconds: 1,
      minRefetchIntervalMs: 0,
      fetchJwks: async () => {
        if (!available) throw new Error("certs unavailable");
        return [jwk];
      },
    });
    const native = createOrganizationNativeSources({
      organization: "fixture",
      slackTeamId: "T_FIXTURE",
      access: config,
      dashboard,
      slack: {
        auth: { test: async () => ({}) },
        users: { info: async () => ({}) },
        conversations: { info: async () => ({}) },
      },
    });
    const identity = native.browserIdentity({ sub: "alice" });
    const request = { headers: { "cf-access-jwt-assertion": token() } };
    native.rememberBrowser(request, { sub: "alice" });
    expect(await native.currentBrowser(identity)).toMatchObject({ status: "verified", actorId: "access:alice" });
    now = 2000;
    available = false;
    const [gate, proof] = await Promise.all([dashboard.verify(request), native.currentBrowser(identity)]);
    expect({ gate, proof }).toEqual({
      gate: { ok: false, status: 503, body: "authentication unavailable" },
      proof: { status: "unavailable" },
    });
    available = true;
    expect(await native.currentBrowser(identity)).toMatchObject({
      status: "verified",
      actorId: "access:alice",
      identity,
    });
    // A forged signature and an absent key after a successful refresh are
    // actual refusals, unlike an unavailable provider.
    const valid = token();
    const parts = valid.split(".");
    const signature = Buffer.from(parts[2]!, "base64url");
    signature[0] = signature[0]! ^ 1;
    native.rememberBrowser(
      { headers: { "cf-access-jwt-assertion": `${parts[0]}.${parts[1]}.${signature.toString("base64url")}` } },
      { sub: "alice" },
    );
    expect(await native.currentBrowser(identity)).toEqual({ status: "fenced" });
    native.rememberBrowser({ headers: { "cf-access-jwt-assertion": token("missing-key") } }, { sub: "alice" });
    expect(await native.currentBrowser(identity)).toEqual({ status: "fenced" });
    now = 4000;
    available = false;
    native.rememberBrowser({ headers: { "cf-access-jwt-assertion": token("fixture-key", 1) } }, { sub: "alice" });
    expect(await native.currentBrowser(identity)).toEqual({ status: "fenced" });
  });

  it("requires a fresh verified browser credential after restart and refuses the same saved subject after expiry", async () => {
    let valid = true;
    const options = {
      organization: "fixture",
      access: { teamDomain: "fixture.cloudflareaccess.com", aud: "dashboard" },
      dashboard: {
        mode: "access" as const,
        describe: () => "fixture",
        verify: async () =>
          valid
            ? { ok: true as const, identity: { sub: "alice", email: "not-authority@example.test" } }
            : { ok: false as const, status: 403, body: "forbidden" },
      },
      slackTeamId: "T_FIXTURE",
      slack: {
        auth: { test: async () => ({ team_id: "T_FIXTURE" }) },
        users: { info: async () => ({ user: { team_id: "T_FIXTURE" } }) },
        conversations: { info: async () => ({}) },
      },
    };
    const adapter = createOrganizationNativeSources(options);
    const identity = adapter.browserIdentity({ sub: "alice" });
    expect(await adapter.currentBrowser(identity)).toEqual({ status: "unavailable" });
    adapter.rememberBrowser({ headers: {} }, { sub: "alice" });
    expect(await adapter.currentBrowser(identity)).toMatchObject({
      status: "verified",
      actorId: "access:alice",
      organizationMember: true,
    });
    expect(await createOrganizationNativeSources(options).currentBrowser(identity)).toEqual({ status: "unavailable" });
    valid = false;
    expect(await adapter.currentBrowser(identity)).toEqual({ status: "fenced" });
  });
  it("rechecks Slack installation, user membership and the original private reply address", async () => {
    let shared = false;
    const adapter = createOrganizationNativeSources({
      organization: "fixture",
      access: null,
      dashboard: {
        mode: "none",
        describe: () => "fixture",
        verify: async () => ({ ok: false, status: 403, body: "forbidden" }),
      },
      slackTeamId: "T_FIXTURE",
      slack: {
        auth: { test: async () => ({ team_id: "T_FIXTURE" }) },
        users: { info: async () => ({ user: { team_id: "T_FIXTURE", real_name: "Alice" } }) },
        conversations: {
          info: async () => ({ channel: { user: "U_ALICE", is_im: true, is_org_shared: false, is_shared: shared } }),
        },
      },
    });
    const identity = { issuer: "https://slack.com", tenant: "T_FIXTURE", subject: "U_ALICE" };
    const reference = {
      actorId: "slack:U_ALICE",
      userId: "slack:U_ALICE",
      channelId: "slack:D_PRIVATE",
      threadKey: "slack:D_PRIVATE:1",
    };
    expect(await adapter.currentSlack(identity, undefined, reference)).toMatchObject({
      status: "verified",
      privateSource: true,
    });
    shared = true;
    expect(await adapter.currentSlack(identity, undefined, reference)).toEqual({ status: "fenced" });
    expect(await adapter.currentSlack({ ...identity, tenant: "T_OTHER" })).toEqual({ status: "fenced" });
  });
});
