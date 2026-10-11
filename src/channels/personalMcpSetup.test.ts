import { describe, expect, it, vi } from "vitest";
import { createPersonalMcpSetupHandler } from "./personalMcpSetup.js";
import { InMemoryPersonalTokenStore } from "../mcp/personalTokens.js";
import { withWorkViewScope } from "./workViewScope.js";
import { NO_GRANTS } from "../core/authz/types.js";

describe("personal MCP setup", () => {
  const challenge = "a".repeat(64);
  const identity = { sub: "one", email: "one@example.com" };
  const grantsFor = (id: string) =>
    id === "mcp:personal:one"
      ? { actions: new Set(["dispatch", "runs:read"]), channels: "all" as const, repos: new Set<string>() }
      : NO_GRANTS;

  function request(method: string, url: string, body = "", origin = "https://bot.example") {
    async function* chunks() {
      yield Buffer.from(body);
    }
    const req = Object.assign(chunks(), {
      method,
      url,
      headers: {
        host: "bot.example",
        origin,
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
      },
    });
    let status = 0;
    let payload = "";
    const res = {
      writeHead: (code: number) => {
        status = code;
      },
      end: (text?: string) => {
        payload = text ?? "";
      },
    };
    return { req: req as never, res: res as never, status: () => status, payload: () => payload };
  }

  it("refuses device writes in a trusted Person view before reading the form, while own and All views still approve", async () => {
    const store = new InMemoryPersonalTokenStore();
    const handler = createPersonalMcpSetupHandler({ store, grantsFor, publicOrigin: "https://bot.example" });
    const actor = { kind: "user" as const, id: "access:one", grants: NO_GRANTS };
    let read = false;
    async function* chunks() {
      read = true;
      yield Buffer.from(`action=approve&challenge=${challenge}`);
    }
    const blocked = request("POST", "/settings/connect");
    handler(Object.assign(chunks(), blocked.req) as never, blocked.res, identity, {
      ...actor,
      viewingAs: { id: "access:two" },
    });
    await vi.waitFor(() => expect(blocked.status()).toBe(403));
    expect(read).toBe(false);
    expect(await store.get(challenge)).toBeNull();
    await store.put({
      digest: challenge,
      subject: "personal:one",
      userId: "access:one",
      email: identity.email,
      createdAt: 1,
    });
    const revoke = request("POST", "/settings/connect", `action=revoke&challenge=${challenge}`);
    handler(revoke.req, revoke.res, identity, { ...actor, viewingAs: { id: "access:two" } });
    await vi.waitFor(() => expect(revoke.status()).toBe(403));
    expect((await store.get(challenge))?.userId).toBe("access:one");
    await store.delete(challenge, "personal:one");
    for (const viewer of [
      actor,
      withWorkViewScope({ ...actor }, { mode: "everyone", ownerIds: [], canEveryone: true }),
    ]) {
      const own = request("POST", "/settings/connect", `action=approve&challenge=${challenge}`);
      handler(own.req, own.res, identity, viewer);
      await vi.waitFor(() => expect(own.status()).toBe(200));
      expect((await store.get(challenge))?.userId).toBe("access:one");
      await store.delete(challenge, "personal:one");
    }
  });

  it("approves a digest after sign-in and the matching same-origin form, then revokes only that owner's device", async () => {
    const store = new InMemoryPersonalTokenStore();
    const handler = createPersonalMcpSetupHandler({ store, grantsFor, publicOrigin: "https://bot.example" });
    const page = request("GET", `/settings/connect?challenge=${challenge}`);
    expect(handler(page.req, page.res, identity)).toBe(true);
    await vi.waitFor(() => expect(page.status()).toBe(200));
    expect(page.payload()).toContain(challenge.slice(0, 8).toUpperCase());
    const approve = request("POST", "/settings/connect", `action=approve&challenge=${challenge}`);
    handler(approve.req, approve.res, identity);
    await vi.waitFor(() => expect(approve.status()).toBe(200));
    expect((await store.get(challenge))?.subject).toBe("personal:one");
    const foreign = request("POST", "/settings/connect", `action=revoke&challenge=${challenge}`);
    handler(foreign.req, foreign.res, { sub: "two", email: "two@example.com" });
    await vi.waitFor(() => expect(foreign.status()).toBe(403));
    expect(await store.get(challenge)).not.toBeNull();
    const revoke = request("POST", "/settings/connect", `action=revoke&challenge=${challenge}`);
    handler(revoke.req, revoke.res, identity);
    await vi.waitFor(() => expect(revoke.status()).toBe(303));
    expect(await store.get(challenge)).toBeNull();
  });

  it("rejects cross-site posts and sessions without a verified email", async () => {
    const store = new InMemoryPersonalTokenStore();
    const handler = createPersonalMcpSetupHandler({ store, grantsFor, publicOrigin: "https://bot.example" });
    const foreign = request(
      "POST",
      "/settings/connect",
      `action=approve&challenge=${challenge}`,
      "https://elsewhere.example",
    );
    handler(foreign.req, foreign.res, identity);
    await vi.waitFor(() => expect(foreign.status()).toBe(403));
    expect(await store.get(challenge)).toBeNull();
    const unlinked = request("GET", "/settings/connect");
    handler(unlinked.req, unlinked.res, { sub: "one" });
    await vi.waitFor(() => expect(unlinked.status()).toBe(403));
  });

  it("binds the exact authenticated Access subject even when its email matches a Slack account", async () => {
    const store = new InMemoryPersonalTokenStore();
    const options = {
      store,
      grantsFor,
      publicOrigin: "https://bot.example",
      personByEmail: async () => ({ id: "slack:UALICE" }),
    };
    const handler = createPersonalMcpSetupHandler(options);
    const approve = request("POST", "/settings/connect", `action=approve&challenge=${challenge}`);
    handler(approve.req, approve.res, identity);
    await vi.waitFor(() => expect(approve.status()).toBe(200));
    expect(await store.get(challenge)).toMatchObject({ subject: "personal:one", userId: "access:one" });
  });

  it("pins only the host Access realm and organization at approval and requires a new code after a realm change", async () => {
    const store = new InMemoryPersonalTokenStore();
    const options = {
      store,
      grantsFor,
      publicOrigin: "https://bot.example",
      approval: { access: { teamDomain: "team.example", aud: "app-one" }, organization: "org-one" },
    };
    const handler = createPersonalMcpSetupHandler(options);
    const approve = request(
      "POST",
      "/settings/connect",
      `action=approve&challenge=${challenge}&issuer=https://evil.example&audience=evil&organization=evil&subject=two`,
    );
    handler(approve.req, approve.res, identity);
    await vi.waitFor(() => expect(approve.status()).toBe(200));
    expect((await store.get(challenge))?.approval).toEqual({
      version: 1,
      issuer: "https://team.example",
      audience: "app-one",
      organization: "org-one",
      subject: "one",
    });
    const original = await store.get(challenge);
    const exact = request("POST", "/settings/connect", `action=approve&challenge=${challenge}`);
    handler(exact.req, exact.res, { ...identity, email: "changed@example.com" });
    await vi.waitFor(() => expect(exact.status()).toBe(200));
    expect(await store.get(challenge)).toEqual(original);
    for (const approval of [
      { ...options.approval, access: { ...options.approval.access, teamDomain: "other.example" } },
      { ...options.approval, access: { ...options.approval.access, aud: "app-two" } },
      { ...options.approval, organization: "org-two" },
    ]) {
      const changed = request("POST", "/settings/connect", `action=approve&challenge=${challenge}`);
      createPersonalMcpSetupHandler({ ...options, approval })(changed.req, changed.res, identity);
      await vi.waitFor(() => expect(changed.status()).toBe(409));
      expect(await store.get(challenge)).toEqual(original);
    }
    const legacyDigest = "b".repeat(64);
    await store.put({ digest: legacyDigest, subject: "personal:one", email: identity.email, createdAt: 1 });
    const legacy = request("POST", "/settings/connect", `action=approve&challenge=${legacyDigest}`);
    handler(legacy.req, legacy.res, identity);
    await vi.waitFor(() => expect(legacy.status()).toBe(409));
    expect((await store.get(legacyDigest))?.approval).toBeUndefined();
    const page = request("GET", "/settings/connect");
    handler(page.req, page.res, identity);
    await vi.waitFor(() => expect(page.status()).toBe(200));
    expect(page.payload()).toContain("Reissue required: revoke this device and connect again.");
    const revoke = request("POST", "/settings/connect", `action=revoke&challenge=${legacyDigest}`);
    handler(revoke.req, revoke.res, identity);
    await vi.waitFor(() => expect(revoke.status()).toBe(303));
    expect(await store.get(legacyDigest)).toBeNull();
  });

  it("refuses absent or literal null POST Origin and does not rewrite an existing email-derived binding", async () => {
    const store = new InMemoryPersonalTokenStore();
    const handler = createPersonalMcpSetupHandler({ store, grantsFor, publicOrigin: "https://bot.example" });
    for (const origin of [undefined, "null"]) {
      const approve = request("POST", "/settings/connect", `action=approve&challenge=${challenge}`);
      (approve.req as { headers: Record<string, unknown> }).headers.origin = origin;
      handler(approve.req, approve.res, identity);
      await vi.waitFor(() => expect(approve.status()).toBe(403));
      expect(await store.get(challenge)).toBeNull();
    }
    await store.put({
      digest: challenge,
      subject: "personal:one",
      userId: "slack:UALICE",
      email: identity.email,
      createdAt: 1,
    });
    const approve = request("POST", "/settings/connect", `action=approve&challenge=${challenge}`);
    handler(approve.req, approve.res, identity);
    await vi.waitFor(() => expect(approve.status()).toBe(409));
    expect(await store.get(challenge)).toBeNull();
    expect(await store.list("personal:one")).toEqual([expect.objectContaining({ userId: "slack:UALICE" })]);
    const page = request("GET", "/settings/connect");
    handler(page.req, page.res, identity);
    await vi.waitFor(() => expect(page.status()).toBe(200));
    expect(page.payload()).toContain("Reissue required: revoke this device and connect again.");
  });
});
