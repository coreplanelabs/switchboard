import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign as rsaSign } from "node:crypto";
import { type AccessConfig, type AccessJwk, type VerifyDeps } from "./accessAuth.js";
import {
  accessVerifier,
  buildDashboardVerifier,
  isLocalhostBase,
  isLoopbackAddress,
  LOOPBACK_ONLY_BODY,
  loopbackVerifier,
  tokenVerifier,
  type DashboardRequest,
} from "./dashboardAuth.js";

// Feature: features/access-gate.md — dashboard auth is a Strategy. Three
// verifiers behind one `verify(req) → identity | refusal`, each strategy's
// allow and refuse cases, `none`'s one rule (loopback on a localhost
// deployment), and the composition that fails fast by name.

/** A request double: headers + the socket's peer address (`null` → no address at all). */
const req = (headers: Record<string, string> = {}, remoteAddress: string | null = "127.0.0.1"): DashboardRequest => ({
  headers,
  socket: { remoteAddress: remoteAddress ?? undefined },
});

// ── access ───────────────────────────────────────────────────────────────────

const KID = "kid-1";
const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-1";
const access: AccessConfig = { teamDomain: TEAM, aud: AUD };
const NOW_SEC = 1_700_000_000;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk: AccessJwk = { ...(publicKey.export({ format: "jwk" }) as AccessJwk), kid: KID };
const deps = (): VerifyDeps => ({ fetchJwks: vi.fn(async () => [jwk]), now: () => NOW_SEC * 1000 });
const b64 = (s: string) => Buffer.from(s).toString("base64url");
/** A token signed exactly as Access signs one (RS256 over header.payload). */
function mint(payload: Record<string, unknown>): string {
  const input = `${b64(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }))}.${b64(JSON.stringify(payload))}`;
  return `${input}.${rsaSign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}
const validClaims = { iss: `https://${TEAM}`, aud: AUD, sub: "user-1", email: "u@example.com", exp: NOW_SEC + 3600 };

describe("accessVerifier — the Cloudflare Access strategy", () => {
  it("admits a valid Cf-Access-Jwt-Assertion as its identity", async () => {
    const v = accessVerifier(access, deps());
    expect(v.mode).toBe("access");
    await expect(v.verify(req({ "cf-access-jwt-assertion": mint(validClaims) }))).resolves.toEqual({
      ok: true,
      identity: { sub: "user-1", email: "u@example.com" },
    });
  });

  it("refuses a missing header, a malformed token and an expired one with 403 (fail closed)", async () => {
    const v = accessVerifier(access, deps());
    const forbidden = { ok: false, status: 403, body: "forbidden" };
    await expect(v.verify(req())).resolves.toEqual(forbidden);
    await expect(v.verify(req({ "cf-access-jwt-assertion": "garbage.token.here" }))).resolves.toEqual(forbidden);
    await expect(
      v.verify(req({ "cf-access-jwt-assertion": mint({ ...validClaims, exp: NOW_SEC - 1 }) })),
    ).resolves.toEqual(forbidden);
  });

  it("does not care where the request comes from — a remote socket with a valid token is admitted", async () => {
    const v = accessVerifier(access, deps());
    const r = await v.verify(req({ "cf-access-jwt-assertion": mint(validClaims) }, "203.0.113.9"));
    expect(r.ok).toBe(true);
  });

  it("admits a service token (empty sub, common_name) as the service identity — serviceTokenAllowed decides where it may go", async () => {
    const v = accessVerifier(access, deps());
    const token = mint({ ...validClaims, sub: "", email: undefined, common_name: "svc-1" });
    await expect(v.verify(req({ "cf-access-jwt-assertion": token }))).resolves.toEqual({
      ok: true,
      identity: { sub: "", commonName: "svc-1" },
    });
  });

  it("names the team domain in its description, never a token", () => {
    expect(accessVerifier(access, deps()).describe()).toBe(`access (Cloudflare Access SSO, ${TEAM})`);
  });
});

// ── token ────────────────────────────────────────────────────────────────────

describe("tokenVerifier — a bearer resolving to one configured actor", () => {
  const v = tokenVerifier({ token: "s3cret-token", env: "DASHBOARD_TOKEN", subject: "ops" });

  it("admits `Authorization: Bearer <token>` as the configured subject (scheme case-insensitive, whitespace tolerated)", async () => {
    expect(v.mode).toBe("token");
    const ok = { ok: true, identity: { sub: "ops" } };
    await expect(v.verify(req({ authorization: "Bearer s3cret-token" }))).resolves.toEqual(ok);
    await expect(v.verify(req({ authorization: "bearer   s3cret-token " }))).resolves.toEqual(ok);
  });

  it("refuses no header, another scheme, a wrong token, a prefix of the token, and an empty bearer", async () => {
    const forbidden = { ok: false, status: 403, body: "forbidden" };
    await expect(v.verify(req())).resolves.toEqual(forbidden);
    await expect(v.verify(req({ authorization: "Basic s3cret-token" }))).resolves.toEqual(forbidden);
    await expect(v.verify(req({ authorization: "Bearer wrong" }))).resolves.toEqual(forbidden);
    await expect(v.verify(req({ authorization: "Bearer s3cret" }))).resolves.toEqual(forbidden);
    await expect(v.verify(req({ authorization: "Bearer s3cret-token-and-more" }))).resolves.toEqual(forbidden);
    await expect(v.verify(req({ authorization: "Bearer " }))).resolves.toEqual(forbidden);
  });

  it("is admitted from any address — the bearer is the credential, not the socket", async () => {
    const r = await v.verify(req({ authorization: "Bearer s3cret-token" }, "203.0.113.9"));
    expect(r.ok).toBe(true);
  });

  it("describes the env var and the actor, never the token", () => {
    expect(v.describe()).toBe("token (bearer from $DASHBOARD_TOKEN → access:ops)");
    expect(v.describe()).not.toContain("s3cret");
  });
});

// ── none ─────────────────────────────────────────────────────────────────────

describe("loopbackVerifier — `none` serves loopback callers on a localhost deployment only", () => {
  it("admits a loopback socket (v4, v6, mapped) on a localhost deployment as access:loopback", async () => {
    for (const base of [undefined, "http://localhost:3000", "http://127.0.0.1:8080", "http://[::1]:8080"]) {
      const v = loopbackVerifier(base);
      expect(v.mode).toBe("none");
      for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
        await expect(v.verify(req({}, addr))).resolves.toEqual({ ok: true, identity: { sub: "loopback" } });
      }
    }
  });

  it("refuses a non-loopback socket with 403 and the reason, whatever headers it carries", async () => {
    const v = loopbackVerifier(undefined);
    for (const addr of ["10.0.0.7", "203.0.113.9", null, ""]) {
      await expect(v.verify(req({ authorization: "Bearer anything" }, addr))).resolves.toEqual({
        ok: false,
        status: 403,
        body: LOOPBACK_ONLY_BODY,
      });
    }
  });

  it("refuses every request — loopback included — when PUBLIC_BASE_URL names a public host or is malformed", async () => {
    for (const base of ["https://switchboard.example.dev", "switchboard.example.com", "not a url"]) {
      const v = loopbackVerifier(base);
      const r = await v.verify(req({}, "127.0.0.1"));
      expect([base, r.ok]).toEqual([base, false]);
    }
  });

  it("isLoopbackAddress recognizes v4, v6 and mapped loopback only", () => {
    expect(["127.0.0.1", "::1", "::ffff:127.0.0.1"].map(isLoopbackAddress)).toEqual([true, true, true]);
    expect(["10.0.0.1", "203.0.113.9", undefined, ""].map(isLoopbackAddress)).toEqual([false, false, false, false]);
  });

  it("isLocalhostBase: unset or a localhost host (any port) is local; a public host or a malformed value is not, and never throws", () => {
    expect(isLocalhostBase(undefined)).toBe(true);
    expect(isLocalhostBase("")).toBe(true);
    expect(isLocalhostBase("http://localhost:3000")).toBe(true);
    expect(isLocalhostBase("http://127.0.0.1")).toBe(true);
    expect(isLocalhostBase("http://[::1]:8080")).toBe(true);
    expect(isLocalhostBase("https://switchboard.example.dev")).toBe(false);
    expect(() => isLocalhostBase("switchboard.example.com")).not.toThrow();
    expect(isLocalhostBase("switchboard.example.com")).toBe(false);
    expect(isLocalhostBase("not a url")).toBe(false);
  });
});

// ── composition ──────────────────────────────────────────────────────────────

describe("buildDashboardVerifier — composing the configured strategy, failing fast by name", () => {
  const base = { access: null, env: {}, verify: deps(), publicBaseUrl: undefined };

  it("no key, no ACCESS_* → the loopback strategy (today's no-Access deployment boots unchanged)", () => {
    expect(buildDashboardVerifier({ ...base, dashboard: undefined }).mode).toBe("none");
  });

  it("no key, ACCESS_* set → the Access strategy", () => {
    expect(buildDashboardVerifier({ ...base, dashboard: undefined, access }).mode).toBe("access");
  });

  it("access without ACCESS_* is a startup error naming both variables", () => {
    expect(() => buildDashboardVerifier({ ...base, dashboard: { auth: "access" } })).toThrow(
      /dashboard\.auth is access but ACCESS_TEAM_DOMAIN and ACCESS_AUD are not both set/,
    );
  });

  it("token reads the bearer from the named env var (default DASHBOARD_TOKEN) and resolves to the configured actor", async () => {
    const v = buildDashboardVerifier({
      ...base,
      dashboard: { auth: "token", token: { actor: "access:ops" } },
      env: { DASHBOARD_TOKEN: "abc" },
    });
    expect(v.mode).toBe("token");
    await expect(v.verify(req({ authorization: "Bearer abc" }))).resolves.toEqual({
      ok: true,
      identity: { sub: "ops" },
    });
    const named = buildDashboardVerifier({
      ...base,
      dashboard: { auth: "token", token: { env: "MY_DASH", actor: "access:ops" } },
      env: { MY_DASH: "xyz", DASHBOARD_TOKEN: "abc" },
    });
    await expect(named.verify(req({ authorization: "Bearer abc" }))).resolves.toMatchObject({ ok: false });
    await expect(named.verify(req({ authorization: "Bearer xyz" }))).resolves.toMatchObject({ ok: true });
  });

  it("token without the env var, or without a usable actor, is a startup error naming the missing piece", () => {
    expect(() =>
      buildDashboardVerifier({ ...base, dashboard: { auth: "token", token: { actor: "access:ops" } } }),
    ).toThrow(/dashboard\.auth is token but DASHBOARD_TOKEN is not set/);
    expect(() =>
      buildDashboardVerifier({
        ...base,
        dashboard: { auth: "token", token: { env: "MY_DASH", actor: "access:ops" } },
        env: { MY_DASH: "   " },
      }),
    ).toThrow(/MY_DASH is not set/);
    expect(() =>
      buildDashboardVerifier({ ...base, dashboard: { auth: "token" }, env: { DASHBOARD_TOKEN: "abc" } }),
    ).toThrow(/dashboard\.token\.actor must name the bearer's actor as access:<name>/);
    expect(() =>
      buildDashboardVerifier({
        ...base,
        dashboard: { auth: "token", token: { actor: "access:svc:ops" } },
        env: { DASHBOARD_TOKEN: "abc" },
      }),
    ).toThrow(/access:<name>/);
  });

  it("an explicit none on a deployment with a public address is a startup error; the implicit none never is", () => {
    expect(() =>
      buildDashboardVerifier({
        ...base,
        dashboard: { auth: "none" },
        publicBaseUrl: "https://switchboard.example.dev",
      }),
    ).toThrow(/dashboard\.auth is none, which serves loopback callers on a localhost deployment only/);
    expect(buildDashboardVerifier({ ...base, dashboard: { auth: "none" } }).mode).toBe("none");
    expect(
      buildDashboardVerifier({ ...base, dashboard: { auth: "none" }, publicBaseUrl: "http://localhost:3000" }).mode,
    ).toBe("none");
    // No key: the deployment never chose `none`, so it boots as before and
    // refuses each request instead.
    const implicit = buildDashboardVerifier({
      ...base,
      dashboard: undefined,
      publicBaseUrl: "https://switchboard.example.dev",
    });
    expect(implicit.mode).toBe("none");
  });

  it("an explicit mode wins even when the environment would have picked another", () => {
    expect(buildDashboardVerifier({ ...base, dashboard: { auth: "none" }, access }).mode).toBe("none");
    expect(
      buildDashboardVerifier({
        ...base,
        dashboard: { auth: "token", token: { actor: "access:ops" } },
        access,
        env: { DASHBOARD_TOKEN: "abc" },
      }).mode,
    ).toBe("token");
  });
});
