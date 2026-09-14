import { describe, expect, it } from "vitest";
import {
  ABORT_RULE_ID,
  artifactsBucketHost,
  bucketCallProblem,
  bucketTokenMissingProblem,
  describeRules,
  EXPIRE_RULE_ID,
  lifecycleRulesFor,
  privacyOf,
  rulesMatch,
} from "./artifactsBucket.js";

// Feature: docs/reference/specs/execution.md item 20 (record 0033) — the bucket's
// operator-side settings: the two lifecycle rules for a retention, the privacy
// verdict from the two domain settings, and the host's four Cloudflare calls
// under CLOUDFLARE_API_TOKEN, each failure in the API's words.

describe("artifacts bucket — the rules", () => {
  it("a retention gives two rules over every key: delete after the retention, abort an incomplete multipart upload after one day", () => {
    const rules = lifecycleRulesFor(30);
    expect(rules).toEqual([
      {
        id: EXPIRE_RULE_ID,
        enabled: true,
        conditions: { prefix: "" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 30 * 86_400 } },
      },
      {
        id: ABORT_RULE_ID,
        enabled: true,
        conditions: { prefix: "" },
        abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 86_400 } },
      },
    ]);
    expect(describeRules(rules)).toEqual([
      "switchboard-artifacts-expire: delete every object 30 days after it was written",
      "switchboard-artifacts-abort-multipart: abort an incomplete multipart upload after 1 day",
    ]);
    expect(lifecycleRulesFor(1)[0]!.deleteObjectsTransition!.condition.maxAge).toBe(86_400);
    expect(() => lifecycleRulesFor(0)).toThrow(/integer >= 1/);
    expect(() => lifecycleRulesFor(2.5)).toThrow(/integer >= 1/);
  });

  it("the read-back matches when both rules are there as written; a missing, disabled or differently aged rule is named; another id is left alone", () => {
    const wanted = lifecycleRulesFor(30);
    expect(
      rulesMatch({ rules: [...wanted, { id: "someone-elses", enabled: true, conditions: { prefix: "x/" } }] }, wanted),
    ).toEqual({
      ok: true,
    });
    expect(rulesMatch({ rules: [wanted[0]] }, wanted)).toEqual({
      ok: false,
      problem: "rule switchboard-artifacts-abort-multipart is missing",
    });
    expect(
      rulesMatch(
        {
          rules: [
            { ...wanted[0], enabled: false },
            { ...wanted[1], abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 172_800 } } },
          ],
        },
        wanted,
      ),
    ).toEqual({
      ok: false,
      problem:
        "rule switchboard-artifacts-expire is not enabled; rule switchboard-artifacts-abort-multipart has maxAge 172800, not 86400",
    });
    expect(rulesMatch({}, wanted)).toEqual({ ok: false, problem: "the read-back carries no `rules` array" });
    expect(rulesMatch(null, wanted)).toEqual({ ok: false, problem: "the read-back carries no `rules` array" });
  });
});

describe("artifacts bucket — privacy", () => {
  it("private exactly when the managed domain is off and no custom domain is enabled; otherwise every open setting is named", () => {
    expect(privacyOf({ domain: "pub-abc.r2.dev", enabled: false }, [])).toEqual({ private: true, open: [] });
    expect(
      privacyOf({ domain: "pub-abc.r2.dev", enabled: false }, [{ domain: "files.example.com", enabled: false }]),
    ).toEqual({ private: true, open: [] });
    expect(
      privacyOf({ domain: "pub-abc.r2.dev", enabled: true }, [
        { domain: "files.example.com", enabled: true },
        { domain: "old.example.com", enabled: false },
      ]),
    ).toEqual({
      private: false,
      open: ["the managed r2.dev domain pub-abc.r2.dev is enabled", "the custom domain files.example.com is enabled"],
    });
  });
});

describe("artifacts bucket — the host's calls", () => {
  const ACCOUNT = "acct-fixture";
  const BUCKET = "switchboard-artifacts";
  const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}`;

  function cloudflare(answer: (method: string, url: string, body: string | undefined) => Response) {
    const calls: Array<{ method: string; url: string; auth: string | null; body: string | undefined }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ method, url, auth: new Headers(init?.headers).get("authorization"), body });
      return answer(method, url, body);
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }
  const envelope = (result: unknown) =>
    new Response(JSON.stringify({ success: true, errors: [], messages: [], result }));

  it("puts the rules and reads them back under the bearer; the domain reads are parsed to the two shapes", async () => {
    const stored: { rules?: unknown } = {};
    const cf = cloudflare((method, url, body) => {
      if (url === `${BASE}/lifecycle` && method === "PUT") {
        stored.rules = (JSON.parse(body!) as { rules: unknown }).rules;
        return envelope({});
      }
      if (url === `${BASE}/lifecycle`) return envelope({ rules: stored.rules ?? [] });
      if (url === `${BASE}/domains/managed`)
        return envelope({ bucketId: "b1", domain: "pub-abc.r2.dev", enabled: false });
      if (url === `${BASE}/domains/custom`)
        return envelope({
          domains: [{ domain: "files.example.com", enabled: true, status: { ownership: "active", ssl: "active" } }],
        });
      return new Response("nope", { status: 404 });
    });
    const io = artifactsBucketHost({ env: { CLOUDFLARE_API_TOKEN: "cf-token" }, fetch: cf.fetchImpl });
    const rules = lifecycleRulesFor(30);
    expect(await io.putLifecycle(ACCOUNT, BUCKET, rules)).toEqual({ ok: true, value: undefined });
    const read = await io.getLifecycle(ACCOUNT, BUCKET);
    expect(read).toEqual({ ok: true, value: { rules } });
    expect(await io.managedDomain(ACCOUNT, BUCKET)).toEqual({
      ok: true,
      value: { domain: "pub-abc.r2.dev", enabled: false },
    });
    expect(await io.customDomains(ACCOUNT, BUCKET)).toEqual({
      ok: true,
      value: [{ domain: "files.example.com", enabled: true }],
    });
    expect(cf.calls.map((c) => `${c.method} ${c.url.slice(BASE.length)}`)).toEqual([
      "PUT /lifecycle",
      "GET /lifecycle",
      "GET /domains/managed",
      "GET /domains/custom",
    ]);
    expect(cf.calls.every((c) => c.auth === "Bearer cf-token")).toBe(true);
    expect(JSON.parse(cf.calls[0]!.body!)).toEqual({ rules });
  });

  it("no token → the problem names CLOUDFLARE_API_TOKEN and the permission, and nothing is called", async () => {
    const cf = cloudflare(() => new Response("must not be called", { status: 500 }));
    const io = artifactsBucketHost({ env: {}, fetch: cf.fetchImpl });
    const r = await io.getLifecycle(ACCOUNT, BUCKET);
    expect(r).toEqual({ ok: false, problem: bucketTokenMissingProblem() });
    expect(bucketTokenMissingProblem()).toMatch(
      /CLOUDFLARE_API_TOKEN is not set.*Workers R2 Storage: Edit.*never used here/,
    );
    expect(cf.calls).toEqual([]);
  });

  it("a refused call names the permission (401/403), another status keeps the API's words, success:false carries its errors, a thrown fetch its reason, and a malformed shape is named", async () => {
    const answers: Record<string, Response> = {
      "PUT /lifecycle": new Response('{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}', {
        status: 403,
      }),
      "GET /lifecycle": new Response(
        '{"success":false,"errors":[{"code":10042,"message":"bucket not found"}],"result":null}',
        {
          status: 200,
        },
      ),
      "GET /domains/managed": new Response("<html>bad gateway</html>", { status: 502 }),
      "GET /domains/custom": envelope({ domains: "not-a-list" }),
    };
    const cf = cloudflare(
      (method, url) => answers[`${method} ${url.slice(BASE.length)}`] ?? new Response("", { status: 404 }),
    );
    const io = artifactsBucketHost({ env: { CLOUDFLARE_API_TOKEN: "t" }, fetch: cf.fetchImpl });
    const put = await io.putLifecycle(ACCOUNT, BUCKET, lifecycleRulesFor(30));
    expect(put).toEqual({
      ok: false,
      problem: bucketCallProblem(
        "PUT",
        `${BASE}/lifecycle`,
        403,
        answers["PUT /lifecycle"] ? '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}' : "",
      ),
    });
    expect((put as { problem: string }).problem).toMatch(
      /HTTP 403 — the token lacks the permission \(Workers R2 Storage: Edit/,
    );
    expect(await io.getLifecycle(ACCOUNT, BUCKET)).toEqual({
      ok: false,
      problem: `GET ${BASE}/lifecycle answered success: false — bucket not found`,
    });
    expect(await io.managedDomain(ACCOUNT, BUCKET)).toEqual({
      ok: false,
      problem: `GET ${BASE}/domains/managed answered HTTP 502: <html>bad gateway</html>`,
    });
    expect(await io.customDomains(ACCOUNT, BUCKET)).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/custom-domains answer has no domains array/),
    });
    const down = artifactsBucketHost({
      env: { CLOUDFLARE_API_TOKEN: "t" },
      fetch: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    expect(await down.getLifecycle(ACCOUNT, BUCKET)).toEqual({
      ok: false,
      problem: `GET ${BASE}/lifecycle failed — ECONNRESET`,
    });
  });
});
