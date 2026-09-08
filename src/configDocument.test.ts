import { describe, expect, it } from "vitest";
import {
  BASE_CONFIG_DOCUMENT_KEY,
  baseConfigDocument,
  ConfigDocumentClient,
  isBaseConfigDocument,
  parseConfigLocation,
  STATE_CONFIG_LOCATION,
  stateWorkerFromEnv,
  type BaseConfigDocument,
} from "./configDocument.js";

// The base config as a document on the state Worker: the location grammar the
// bot reads `SWITCHBOARD_CONFIG` with, the document `deploy config` writes, and
// the client both use — every failure a problem naming the Worker or the env var.

describe("parseConfigLocation", () => {
  it("a path is a file; state:// is the base document; state://<key> names another", () => {
    expect(parseConfigLocation("./config/config.yaml")).toEqual({ kind: "file", path: "./config/config.yaml" });
    expect(parseConfigLocation(STATE_CONFIG_LOCATION)).toEqual({ kind: "state", key: BASE_CONFIG_DOCUMENT_KEY });
    expect(parseConfigLocation("state://")).toEqual({ kind: "state", key: "base" });
    expect(parseConfigLocation("state://staging")).toEqual({ kind: "state", key: "staging" });
  });
});

describe("baseConfigDocument / isBaseConfigDocument", () => {
  it("keeps the YAML as written, digests it, and records the source and time", () => {
    const doc = baseConfigDocument("providers: {}\n# note\n", "github://acme/infra/sb/config.yaml@main", new Date(0));
    expect(doc).toEqual({
      yaml: "providers: {}\n# note\n",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      source: "github://acme/infra/sb/config.yaml@main",
      pushedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(isBaseConfigDocument(doc)).toBe(true);
    expect(isBaseConfigDocument({ yaml: "x" })).toBe(false);
    expect(isBaseConfigDocument(null)).toBe(false);
  });
});

describe("stateWorkerFromEnv", () => {
  it("needs both the URL and the bearer, naming the missing one", () => {
    expect(stateWorkerFromEnv({ STATE_WORKER_URL: "https://s.example", MEMORY_TOKEN: "t" })).toEqual({
      ok: true,
      baseUrl: "https://s.example",
      token: "t",
    });
    expect(stateWorkerFromEnv({ MEMORY_TOKEN: "t" })).toMatchObject({
      ok: false,
      problem: expect.stringContaining("STATE_WORKER_URL is not set"),
    });
    expect(stateWorkerFromEnv({ STATE_WORKER_URL: "https://s.example" })).toMatchObject({
      ok: false,
      problem: expect.stringContaining("MEMORY_TOKEN is not set"),
    });
  });
});

describe("ConfigDocumentClient", () => {
  function fake(
    state: { document: unknown; version: number },
    opts: { failStatus?: number; down?: boolean; nonJson?: boolean } = {},
  ) {
    const calls: Array<{ path: string; body: Record<string, unknown>; auth: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (opts.down) throw new Error("ECONNREFUSED");
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ path: url.pathname, body, auth: new Headers(init?.headers).get("authorization") });
      if (opts.nonJson) return new Response("<html>", { status: 200 });
      if (opts.failStatus) return Response.json({ error: "nope" }, { status: opts.failStatus });
      if (url.pathname === "/config/get") return Response.json({ document: state.document, version: state.version });
      if (url.pathname === "/config/put") {
        if (body.expectedVersion !== state.version)
          return Response.json({ error: "version conflict", version: state.version }, { status: 409 });
        state.version += 1;
        state.document = body.document;
        return Response.json({ ok: true, version: state.version });
      }
      return new Response("{}", { status: 404 });
    };
    return {
      calls,
      client: new ConfigDocumentClient({ baseUrl: "https://state.example/", token: "tok", fetch: fetchImpl }),
    };
  }
  const DOC: BaseConfigDocument = baseConfigDocument("providers: {}\n", "config/config.yaml", new Date(0));

  it("reads the base document with its version (null when never pushed) and sends the bearer", async () => {
    const empty = fake({ document: null, version: 0 });
    expect(await empty.client.readBase()).toEqual({ ok: true, document: null, version: 0 });
    expect(empty.calls[0]).toMatchObject({ path: "/config/get", body: { key: "base" }, auth: "Bearer tok" });
    const full = fake({ document: DOC, version: 4 });
    expect(await full.client.readBase()).toEqual({ ok: true, document: DOC, version: 4 });
  });

  it("a document under the key that is not a base config is a problem, not a crash", async () => {
    const wrong = fake({ document: { channels: {} }, version: 1 });
    expect(await wrong.client.readBase()).toEqual({
      ok: false,
      problem: 'state Worker https://state.example: the "base" document is not a base config document',
    });
  });

  it("pushes over the current version (get, then put) and reports the new one; a concurrent push is a 409 said as such", async () => {
    const state = { document: null as unknown, version: 2 };
    const { calls, client } = fake(state);
    expect(await client.pushBase(DOC)).toEqual({ ok: true, version: 3 });
    expect(calls.map((c) => c.path)).toEqual(["/config/get", "/config/put"]);
    expect(calls[1].body).toEqual({ key: "base", document: DOC, expectedVersion: 2 });
    expect(state.document).toEqual(DOC);
    // Someone else moved the version between our get and put.
    const racy = new ConfigDocumentClient({
      baseUrl: "https://state.example",
      token: "tok",
      fetch: async (input) =>
        String(input).endsWith("/config/get")
          ? Response.json({ document: null, version: 5 })
          : Response.json({ error: "version conflict", version: 6 }, { status: 409 }),
    });
    expect(await racy.pushBase(DOC)).toMatchObject({
      ok: false,
      problem: expect.stringContaining("409 version conflict"),
    });
  });

  it("an unreachable Worker, a non-2xx (401 hints at the bearer), and a non-JSON answer are problems naming the Worker", async () => {
    expect(await fake({ document: null, version: 0 }, { down: true }).client.readBase()).toMatchObject({
      ok: false,
      problem: expect.stringContaining("state Worker https://state.example: /config/get failed — ECONNREFUSED"),
    });
    expect(await fake({ document: null, version: 0 }, { failStatus: 401 }).client.readBase()).toMatchObject({
      ok: false,
      problem: expect.stringContaining("HTTP 401 (nope) — is MEMORY_TOKEN the Worker's bearer?"),
    });
    expect(await fake({ document: null, version: 0 }, { nonJson: true }).client.readBase()).toMatchObject({
      ok: false,
      problem: expect.stringContaining("answered non-JSON"),
    });
  });
});
