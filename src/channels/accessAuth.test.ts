import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign as rsaSign, createHmac, type KeyObject } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  isServiceToken,
  JwksCache,
  parseAccessConfig,
  parseAccessDevBypass,
  requireAccessForRuns,
  verifyAccessJwt,
  type AccessConfig,
  type AccessJwk,
  type JwksFetcher,
  type VerifyDeps,
} from "./accessAuth.js";

// Feature: features/access-gate.md — fail-closed, app-layer Cloudflare Access
// (SSO) enforcement for the /runs* surface. Cloudflare's edge injects a signed
// RS256 JWT in `Cf-Access-Jwt-Assertion`; we re-verify it ourselves so /runs
// refuses to serve if the edge rule is ever misconfigured or a client spoofs
// the header. The JWKS fetch is an injectable seam (real impl + this test impl);
// a throwaway RSA keypair mints tokens signed exactly as Access signs them.

// --- Test key material + JWT minting ---------------------------------------

const KID = "test-kid-1";
const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-tag-123";
const config: AccessConfig = { teamDomain: TEAM, aud: AUD };

// Fixed injected clock. now() is milliseconds (matches Date.now / the house
// pattern); JWT claims are seconds.
const NOW_SEC = 1_700_000_000;
const NOW_MS = NOW_SEC * 1000;

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk: AccessJwk = { ...(publicKey.export({ format: "jwk" }) as AccessJwk), kid: KID };

const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

function mint(priv: KeyObject, header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const signingInput = `${h}.${p}`;
  const sig = rsaSign("RSA-SHA256", Buffer.from(signingInput), priv).toString("base64url");
  return `${signingInput}.${sig}`;
}

/** Build a compact JWS with an explicitly supplied signature string (for
 *  crafting forgeries: alg:none, HMAC-signed, tampered). */
function assemble(header: Record<string, unknown>, payload: Record<string, unknown>, sig: string): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.${sig}`;
}

const rs256Header = (over: Record<string, unknown> = {}) => ({ alg: "RS256", kid: KID, typ: "JWT", ...over });
const claims = (over: Record<string, unknown> = {}) => ({
  iss: `https://${TEAM}`,
  aud: AUD,
  sub: "user-1",
  email: "user@example.com",
  iat: NOW_SEC,
  nbf: NOW_SEC,
  exp: NOW_SEC + 3600,
  ...over,
});

const fetcher = (keys: AccessJwk[] = [jwk]): JwksFetcher => vi.fn(async () => keys);
const deps = (fetchJwks: JwksFetcher = fetcher(), cache?: JwksCache): VerifyDeps => ({
  fetchJwks,
  now: () => NOW_MS,
  cache,
});

// --- verifyAccessJwt --------------------------------------------------------

describe("verifyAccessJwt", () => {
  it("accepts a valid RS256 token and returns { sub, email }", async () => {
    const token = mint(privateKey, rs256Header(), claims());
    expect(await verifyAccessJwt(token, config, deps())).toEqual({ sub: "user-1", email: "user@example.com" });
  });

  it("returns { sub } with email undefined when the email claim is absent", async () => {
    const token = mint(privateKey, rs256Header(), claims({ email: undefined }));
    expect(await verifyAccessJwt(token, config, deps())).toEqual({ sub: "user-1", email: undefined });
  });

  it("rejects an expired token (exp in the past)", async () => {
    const token = mint(privateKey, rs256Header(), claims({ exp: NOW_SEC - 3600 }));
    expect(await verifyAccessJwt(token, config, deps())).toBeNull();
  });

  it("rejects a token whose exp claim is missing", async () => {
    const token = mint(privateKey, rs256Header(), claims({ exp: undefined }));
    expect(await verifyAccessJwt(token, config, deps())).toBeNull();
  });

  it("rejects an aud mismatch (string and array forms)", async () => {
    const wrongString = mint(privateKey, rs256Header(), claims({ aud: "someone-else" }));
    const wrongArray = mint(privateKey, rs256Header(), claims({ aud: ["a", "b"] }));
    expect(await verifyAccessJwt(wrongString, config, deps())).toBeNull();
    expect(await verifyAccessJwt(wrongArray, config, deps())).toBeNull();
  });

  it("accepts aud as an array that includes the configured AUD", async () => {
    const token = mint(privateKey, rs256Header(), claims({ aud: ["other", AUD] }));
    expect(await verifyAccessJwt(token, config, deps())).toMatchObject({ sub: "user-1" });
  });

  it("rejects an iss mismatch", async () => {
    const token = mint(privateKey, rs256Header(), claims({ iss: "https://evil.cloudflareaccess.com" }));
    expect(await verifyAccessJwt(token, config, deps())).toBeNull();
  });

  it("rejects a token whose nbf is in the future beyond skew", async () => {
    const token = mint(privateKey, rs256Header(), claims({ nbf: NOW_SEC + 3600 }));
    expect(await verifyAccessJwt(token, config, deps())).toBeNull();
  });

  // --- Signature integrity (red-verifiable: skipping sig verify flips these) ---

  it("rejects a token with a tampered signature", async () => {
    const token = mint(privateKey, rs256Header(), claims());
    const [h, p, s] = token.split(".");
    const flipped = s[0] === "A" ? "B" + s.slice(1) : "A" + s.slice(1);
    expect(await verifyAccessJwt(`${h}.${p}.${flipped}`, config, deps())).toBeNull();
  });

  it("rejects a token whose payload was altered after signing", async () => {
    const token = mint(privateKey, rs256Header(), claims());
    const sig = token.split(".")[2];
    const forged = assemble(rs256Header(), claims({ sub: "attacker" }), sig);
    expect(await verifyAccessJwt(forged, config, deps())).toBeNull();
  });

  it("rejects a token signed by a different (attacker) key", async () => {
    const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const token = mint(attacker.privateKey, rs256Header(), claims());
    expect(await verifyAccessJwt(token, config, deps())).toBeNull();
  });

  // --- Algorithm confusion (the critical defense) ------------------------------

  it("rejects alg:none with an empty signature", async () => {
    const token = assemble({ alg: "none", kid: KID }, claims(), "");
    expect(await verifyAccessJwt(token, config, deps())).toBeNull();
  });

  it("rejects alg:none even when a valid RS256 signature is attached (alg guard, red-verifiable)", async () => {
    // A real RS256 signature, but the header lies that alg is "none". Removing
    // the alg guard would make our hardcoded RSA verify accept this signature.
    const h = b64url(JSON.stringify({ alg: "none", kid: KID }));
    const p = b64url(JSON.stringify(claims()));
    const sig = rsaSign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url");
    expect(await verifyAccessJwt(`${h}.${p}.${sig}`, config, deps())).toBeNull();
  });

  it("rejects an HS256 token forged with the public key as the HMAC secret", async () => {
    const h = b64url(JSON.stringify({ alg: "HS256", kid: KID }));
    const p = b64url(JSON.stringify(claims()));
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    const sig = createHmac("sha256", pubPem).update(`${h}.${p}`).digest("base64url");
    expect(await verifyAccessJwt(`${h}.${p}.${sig}`, config, deps())).toBeNull();
  });

  it("rejects alg:HS256 even when a valid RS256 signature is attached (alg guard, red-verifiable)", async () => {
    // Header claims HS256; the signature is a genuine RS256 signature. Without
    // the alg guard, our RSA verify would accept it — the classic alg-confusion.
    const h = b64url(JSON.stringify({ alg: "HS256", kid: KID }));
    const p = b64url(JSON.stringify(claims()));
    const sig = rsaSign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url");
    expect(await verifyAccessJwt(`${h}.${p}.${sig}`, config, deps())).toBeNull();
  });

  // --- Malformed input (never throws) -----------------------------------------

  it("returns null (never throws) for malformed or empty tokens", async () => {
    for (const bad of ["", "   ", "a", "a.b", "a.b.c.d", "not.base64url.$$$", "....", "a..c"]) {
      await expect(verifyAccessJwt(bad, config, deps())).resolves.toBeNull();
    }
  });

  it("returns null when the header base64 decodes to non-JSON", async () => {
    const p = b64url(JSON.stringify(claims()));
    expect(await verifyAccessJwt(`${b64url("not json")}.${p}.AAAA`, config, deps())).toBeNull();
  });

  // --- kid resolution + JWKS caching ------------------------------------------

  it("rejects a token whose header has no kid", async () => {
    const token = mint(privateKey, { alg: "RS256", typ: "JWT" }, claims());
    const fetchJwks = fetcher();
    expect(await verifyAccessJwt(token, config, deps(fetchJwks))).toBeNull();
  });

  it("returns null for an unknown kid after exactly one refetch attempt", async () => {
    const token = mint(privateKey, rs256Header({ kid: "nonexistent" }), claims());
    const fetchJwks = fetcher([jwk]); // only KID is ever returned
    expect(await verifyAccessJwt(token, config, deps(fetchJwks))).toBeNull();
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it("caches JWKS by kid: the fetcher is called once across repeated verifies of the same kid", async () => {
    const fetchJwks = fetcher([jwk]);
    const cache = new JwksCache();
    const shared = deps(fetchJwks, cache);
    const token = mint(privateKey, rs256Header(), claims());
    expect(await verifyAccessJwt(token, config, shared)).toMatchObject({ sub: "user-1" });
    expect(await verifyAccessJwt(token, config, shared)).toMatchObject({ sub: "user-1" });
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it("after the interval elapses, a rotated kid IS picked up (one refetch, then verifies)", async () => {
    const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk2: AccessJwk = { ...(rotated.publicKey.export({ format: "jwk" }) as AccessJwk), kid: "kid-2" };
    let keys: AccessJwk[] = [jwk];
    const fetchJwks = vi.fn(async () => keys);
    const cache = new JwksCache();
    let clock = NOW_MS;
    const shared: VerifyDeps = { fetchJwks, now: () => clock, cache, minRefetchIntervalMs: 30_000 };

    // Warm the cache with the original key.
    expect(await verifyAccessJwt(mint(privateKey, rs256Header(), claims()), config, shared)).toMatchObject({
      sub: "user-1",
    });
    expect(fetchJwks).toHaveBeenCalledTimes(1);

    // A token with a new kid arrives; JWKS is rotated to include it.
    keys = [jwk, jwk2];
    const rotatedToken = mint(rotated.privateKey, rs256Header({ kid: "kid-2" }), claims());

    // Just inside the interval the unknown kid is negative-cached: no refetch, no verify.
    clock += 29_999;
    expect(await verifyAccessJwt(rotatedToken, config, shared)).toBeNull();
    expect(fetchJwks).toHaveBeenCalledTimes(1);

    // At the interval boundary exactly one refetch picks up the rotated kid.
    clock += 1; // 30_000ms since the last successful fetch
    expect(await verifyAccessJwt(rotatedToken, config, shared)).toMatchObject({ sub: "user-1" });
    expect(fetchJwks).toHaveBeenCalledTimes(2); // exactly one refetch for the rotated kid
  });

  it("requests the JWKS from the team domain's cdn-cgi certs URL", async () => {
    const fetchJwks = fetcher();
    await verifyAccessJwt(mint(privateKey, rs256Header(), claims()), config, deps(fetchJwks));
    expect(fetchJwks).toHaveBeenCalledWith(`https://${TEAM}/cdn-cgi/access/certs`);
  });

  it("fails closed (null) when the JWKS fetch throws", async () => {
    const fetchJwks = vi.fn(async () => {
      throw new Error("network down");
    });
    const token = mint(privateKey, rs256Header(), claims());
    await expect(verifyAccessJwt(token, config, deps(fetchJwks))).resolves.toBeNull();
  });
});

// --- JwksCache (TTL) --------------------------------------------------------

describe("JwksCache", () => {
  it("re-fetches once a cached key has passed its TTL", async () => {
    const fetchJwks = fetcher([jwk]);
    const cache = new JwksCache();
    let clock = NOW_MS;
    const shared: VerifyDeps = { fetchJwks, now: () => clock, cache, ttlSeconds: 60 };
    const token = mint(privateKey, rs256Header(), claims({ exp: NOW_SEC + 100_000 }));

    expect(await verifyAccessJwt(token, config, shared)).toMatchObject({ sub: "user-1" });
    clock += 30_000; // within TTL
    expect(await verifyAccessJwt(token, config, shared)).toMatchObject({ sub: "user-1" });
    expect(fetchJwks).toHaveBeenCalledTimes(1);

    clock += 60_000; // now past the 60s TTL
    expect(await verifyAccessJwt(token, config, shared)).toMatchObject({ sub: "user-1" });
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });
});

// --- JWKS unknown-kid hardening (negative cache + single-flight) -------------
// An unauthenticated client can mint well-formed tokens carrying random `kid`s
// and loop GET /runs. Without these guards each such request drives one
// origin→Cloudflare certs fetch (latency + an amplification vector). resolveKey
// must (1) single-flight concurrent fetches so N racing unknown kids share ONE
// fetch, and (2) negative-cache so, after a successful fetch, another is
// suppressed until minRefetchIntervalMs elapses — a genuinely rotated kid is
// still picked up once the interval passes (see the rotation test above).

describe("JWKS unknown-kid hardening", () => {
  const MIN_REFETCH_MS = 30_000;

  it("single-flights concurrent unknown-kid verifies into ≤1 fetch", async () => {
    // The fetcher returns only the real KID; the queried kid is never present,
    // so every verify resolves null — but they must share ONE fetch.
    const fetchJwks = fetcher([jwk]);
    const cache = new JwksCache();
    const shared: VerifyDeps = { fetchJwks, now: () => NOW_MS, cache, minRefetchIntervalMs: MIN_REFETCH_MS };
    const token = mint(privateKey, rs256Header({ kid: "unknown" }), claims());

    // All five verifies are kicked off before the shared fetch settles.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => verifyAccessJwt(token, config, shared)),
    );

    expect(fetchJwks).toHaveBeenCalledTimes(1); // single-flight: one fetch for all five
    expect(results).toEqual([null, null, null, null, null]); // unknown kid ⇒ all fail closed
  });

  it("negative-caches: repeated unknown-kid verifies within the interval do not refetch", async () => {
    const fetchJwks = fetcher([jwk]); // real KID only; the queried kid is never present
    const cache = new JwksCache();
    let clock = NOW_MS;
    const shared: VerifyDeps = { fetchJwks, now: () => clock, cache, minRefetchIntervalMs: MIN_REFETCH_MS };
    const token = mint(privateKey, rs256Header({ kid: "unknown" }), claims());

    expect(await verifyAccessJwt(token, config, shared)).toBeNull(); // first: the one allowed fetch
    expect(fetchJwks).toHaveBeenCalledTimes(1);

    clock += 10_000; // within the 30s interval
    expect(await verifyAccessJwt(token, config, shared)).toBeNull();
    clock += 19_999; // 29.999s since the fetch — still inside the interval
    expect(await verifyAccessJwt(token, config, shared)).toBeNull();
    expect(fetchJwks).toHaveBeenCalledTimes(1); // negative cache: no per-request amplification
  });

  it("still verifies a valid token off the warm cache without refetching", async () => {
    const fetchJwks = fetcher([jwk]);
    const cache = new JwksCache();
    let clock = NOW_MS;
    const shared: VerifyDeps = { fetchJwks, now: () => clock, cache, minRefetchIntervalMs: MIN_REFETCH_MS };
    const token = mint(privateKey, rs256Header(), claims());

    expect(await verifyAccessJwt(token, config, shared)).toMatchObject({ sub: "user-1" });
    clock += MIN_REFETCH_MS * 10; // well past the interval; the warm kid needs no refetch
    expect(await verifyAccessJwt(token, config, shared)).toMatchObject({ sub: "user-1" });
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });
});

// --- parseAccessConfig ------------------------------------------------------

describe("parseAccessConfig", () => {
  it("returns the config when both env vars are set", () => {
    expect(parseAccessConfig({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD })).toEqual({ teamDomain: TEAM, aud: AUD });
  });

  it("trims whitespace and strips scheme + trailing slash from the team domain", () => {
    expect(parseAccessConfig({ ACCESS_TEAM_DOMAIN: `  https://${TEAM}/  `, ACCESS_AUD: `  ${AUD}  ` })).toEqual({
      teamDomain: TEAM,
      aud: AUD,
    });
    expect(parseAccessConfig({ ACCESS_TEAM_DOMAIN: `http://${TEAM}`, ACCESS_AUD: AUD })?.teamDomain).toBe(TEAM);
  });

  it("returns null unless BOTH vars are set and non-blank", () => {
    expect(parseAccessConfig({})).toBeNull();
    expect(parseAccessConfig({ ACCESS_TEAM_DOMAIN: TEAM })).toBeNull();
    expect(parseAccessConfig({ ACCESS_AUD: AUD })).toBeNull();
    expect(parseAccessConfig({ ACCESS_TEAM_DOMAIN: "   ", ACCESS_AUD: AUD })).toBeNull();
    expect(parseAccessConfig({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "   " })).toBeNull();
  });
});

// --- parseAccessDevBypass ---------------------------------------------------

describe("parseAccessDevBypass", () => {
  it("is true only for truthy '1'/'true' (case-insensitive)", () => {
    expect(parseAccessDevBypass({ ACCESS_DEV_BYPASS: "1" })).toBe(true);
    expect(parseAccessDevBypass({ ACCESS_DEV_BYPASS: "true" })).toBe(true);
    expect(parseAccessDevBypass({ ACCESS_DEV_BYPASS: "TRUE" })).toBe(true);
  });

  it("is false for anything else, including unset/blank/other strings", () => {
    expect(parseAccessDevBypass({})).toBe(false);
    expect(parseAccessDevBypass({ ACCESS_DEV_BYPASS: "" })).toBe(false);
    expect(parseAccessDevBypass({ ACCESS_DEV_BYPASS: "0" })).toBe(false);
    expect(parseAccessDevBypass({ ACCESS_DEV_BYPASS: "false" })).toBe(false);
    expect(parseAccessDevBypass({ ACCESS_DEV_BYPASS: "yes" })).toBe(false);
  });
});

// --- requireAccessForRuns (the gate) ----------------------------------------

describe("requireAccessForRuns", () => {
  const header = (token: string): IncomingHttpHeaders => ({ "cf-access-jwt-assertion": token });

  it("config present + valid header → ok with identity", async () => {
    const token = mint(privateKey, rs256Header(), claims());
    const res = await requireAccessForRuns(header(token), { config, verify: deps(), devBypass: false });
    expect(res).toEqual({ ok: true, identity: { sub: "user-1", email: "user@example.com" } });
  });

  it("config present + missing header → 403 forbidden", async () => {
    const res = await requireAccessForRuns({}, { config, verify: deps(), devBypass: false });
    expect(res).toEqual({ ok: false, status: 403, body: "forbidden" });
  });

  it("config present + bad token → 403 forbidden", async () => {
    const res = await requireAccessForRuns(header("garbage.token.here"), { config, verify: deps(), devBypass: false });
    expect(res).toEqual({ ok: false, status: 403, body: "forbidden" });
  });

  it("config present + spoofed HS256 token → 403 forbidden", async () => {
    const h = b64url(JSON.stringify({ alg: "HS256", kid: KID }));
    const p = b64url(JSON.stringify(claims()));
    const sig = rsaSign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url");
    const res = await requireAccessForRuns(header(`${h}.${p}.${sig}`), { config, verify: deps(), devBypass: false });
    expect(res).toEqual({ ok: false, status: 403, body: "forbidden" });
  });

  it("config null + no dev bypass → 403 forbidden (FAIL CLOSED)", async () => {
    const res = await requireAccessForRuns(header("anything"), { config: null, verify: deps(), devBypass: false });
    expect(res).toEqual({ ok: false, status: 403, body: "forbidden" });
  });

  it("config null + dev bypass → ok with the dev-bypass identity", async () => {
    const res = await requireAccessForRuns({}, { config: null, verify: deps(), devBypass: true });
    expect(res).toEqual({ ok: true, identity: { sub: "dev-bypass" } });
  });
});

// --- Service tokens (KTD13) -------------------------------------------------

describe("verifyAccessJwt — Cloudflare Access service tokens", () => {
  it("accepts an empty sub + non-empty common_name as a service-token identity", async () => {
    const token = mint(privateKey, rs256Header(), claims({ sub: "", email: undefined, common_name: "reader-bot.access" }));
    const identity = await verifyAccessJwt(token, config, deps());
    expect(identity).toEqual({ sub: "", commonName: "reader-bot.access" });
    expect(identity && isServiceToken(identity)).toBe(true);
  });

  it("accepts an absent sub with a common_name; rejects empty sub without one, and an empty or non-string common_name", async () => {
    const absent = claims({ common_name: "svc-1" }) as Record<string, unknown>;
    delete absent.sub;
    expect(await verifyAccessJwt(mint(privateKey, rs256Header(), absent), config, deps())).toEqual({ sub: "", commonName: "svc-1" });
    expect(await verifyAccessJwt(mint(privateKey, rs256Header(), claims({ sub: "" })), config, deps())).toBeNull();
    expect(await verifyAccessJwt(mint(privateKey, rs256Header(), claims({ sub: "", common_name: "" })), config, deps())).toBeNull();
    expect(await verifyAccessJwt(mint(privateKey, rs256Header(), claims({ sub: "", common_name: 42 })), config, deps())).toBeNull();
  });

  it("a browser token stays a browser identity even when it also carries common_name", async () => {
    const token = mint(privateKey, rs256Header(), claims({ common_name: "ignored" }));
    const identity = await verifyAccessJwt(token, config, deps());
    expect(identity).toEqual({ sub: "user-1", email: "user@example.com" });
    expect(identity && isServiceToken(identity)).toBe(false);
  });

  it("service tokens go through the same claim checks (expired → null)", async () => {
    const token = mint(privateKey, rs256Header(), claims({ sub: "", common_name: "svc-1", exp: NOW_SEC - 1 }));
    expect(await verifyAccessJwt(token, config, deps())).toBeNull();
  });

  it("the gate admits a service token in Cf-Access-Jwt-Assertion", async () => {
    const token = mint(privateKey, rs256Header(), claims({ sub: "", common_name: "svc-1" }));
    const res = await requireAccessForRuns({ "cf-access-jwt-assertion": token }, { config, verify: deps(), devBypass: false });
    expect(res).toEqual({ ok: true, identity: { sub: "", commonName: "svc-1" } });
  });
});
