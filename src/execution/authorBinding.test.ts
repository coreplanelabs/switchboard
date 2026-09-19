import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Feature: docs/reference/specs/authorization.md item 18 (record 0062) — the
// author binding read side: `resolveLogin` is one `GET /users/<login>` over the
// read credential (a 404 is "no such login", never a throw), `resolveById`
// follows the immutable id (`GET /user/<id>`), and `bindingOf(person, store)`
// reads the STORED binding only — a bare config.yaml login is resolved once per
// process and cached; a stored pair whose id now answers a different login is
// refused with one `[identity]` line and yields no pair.

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID", "GH_TOKEN"];

type Route = () => Response;
const json =
  (body: unknown, status = 200): Route =>
  () =>
    new Response(JSON.stringify(body), { status });

/** A fetch answering by URL; every call is recorded (URL + Authorization header). */
function routes(table: Record<string, Route>) {
  const calls: { url: string; auth: string | undefined }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") ?? undefined });
    return table[url]?.() ?? new Response("not found", { status: 404 });
  });
  return { fetchMock, calls };
}

async function freshModule() {
  vi.resetModules();
  return import("./authorBinding.js");
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GH_TOKEN = "tok";
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveLogin / resolveById", () => {
  it("resolveLogin: GET /users/<login> over the read credential → { login, id }; a 404 answers undefined", async () => {
    const mod = await freshModule();
    const { fetchMock, calls } = routes({
      "https://api.github.com/users/ivy-dev": json({ login: "ivy-dev", id: 4242 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await mod.resolveLogin("ivy-dev")).toEqual({ login: "ivy-dev", id: 4242 });
    expect(calls).toEqual([{ url: "https://api.github.com/users/ivy-dev", auth: "Bearer tok" }]);
    expect(await mod.resolveLogin("no-such-login")).toBeUndefined();
  });

  it("resolveById: GET /user/<id> follows the account through a rename; a 404 answers undefined", async () => {
    const mod = await freshModule();
    const { fetchMock } = routes({
      "https://api.github.com/user/4242": json({ login: "ivy-renamed", id: 4242 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await mod.resolveById(4242)).toEqual({ login: "ivy-renamed", id: 4242 });
    expect(await mod.resolveById(7)).toBeUndefined();
  });

  it("a non-404 failure throws naming the status — never read as 'no such login'", async () => {
    const mod = await freshModule();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    await expect(mod.resolveLogin("ivy-dev")).rejects.toThrow(/500/);
  });
});

describe("bindingOf — reads the stored binding only", () => {
  const storeWith = (github: { login: string; id: number } | string | undefined) => ({
    userGithubBinding: () => github,
  });

  it("no stored binding → no pair, and GitHub is never asked", async () => {
    const mod = await freshModule();
    const { fetchMock, calls } = routes({});
    vi.stubGlobal("fetch", fetchMock);
    expect(await mod.bindingOf("slack:UONE", storeWith(undefined))).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("a stored { login, id } resolves by id: the stored pair when the login still matches (case-insensitively)", async () => {
    const mod = await freshModule();
    const { fetchMock } = routes({
      "https://api.github.com/user/4242": json({ login: "Ivy-Dev", id: 4242 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await mod.bindingOf("slack:UONE", storeWith({ login: "ivy-dev", id: 4242 }))).toEqual({
      login: "ivy-dev",
      id: 4242,
    });
  });

  it("a stored id whose current login differs is refused with one `[identity]` line and yields no pair — never followed", async () => {
    const mod = await freshModule();
    const { fetchMock } = routes({
      "https://api.github.com/user/4242": json({ login: "ivy-renamed", id: 4242 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await mod.bindingOf("slack:UONE", storeWith({ login: "ivy-dev", id: 4242 }))).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/^\[identity\].*ivy-dev.*ivy-renamed/s));
  });

  it("a bare config.yaml login is resolved once (GET /users/<login>) and cached for the process", async () => {
    const mod = await freshModule();
    const { fetchMock, calls } = routes({
      "https://api.github.com/users/ivy-dev": json({ login: "ivy-dev", id: 4242 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await mod.bindingOf("slack:UONE", storeWith("ivy-dev"))).toEqual({ login: "ivy-dev", id: 4242 });
    expect(await mod.bindingOf("slack:UONE", storeWith("ivy-dev"))).toEqual({ login: "ivy-dev", id: 4242 });
    expect(calls).toHaveLength(1);
  });

  it("a failed read yields no pair (fail closed), and is not cached as an answer", async () => {
    const mod = await freshModule();
    let failures = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        failures++;
        return new Response("boom", { status: 500 });
      }),
    );
    expect(await mod.bindingOf("slack:UONE", storeWith("ivy-dev"))).toBeUndefined();
    expect(await mod.bindingOf("slack:UONE", storeWith({ login: "ivy-dev", id: 4242 }))).toBeUndefined();
    expect(failures).toBe(2);
  });
});
