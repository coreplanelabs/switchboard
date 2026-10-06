import { describe, expect, it } from "vitest";
import { secretsFrom } from "./secrets.js";
import {
  BASE_CONFIG_DOCUMENT_KEY,
  baseConfigDocument,
  bindLoadedBaseConfigReceipt,
  ConfigDocumentClient,
  isBaseConfigDocument,
  loadedBaseConfigReceipt,
  parseConfigLocation,
  STATE_CONFIG_LOCATION,
  stateWorkerFrom,
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

describe("loaded base receipt", () => {
  it("binds a frozen byte digest to one process without exposing a file path or config contents", () => {
    const loaded = loadedBaseConfigReceipt({ kind: "file" }, "providers: {}\n# private text\n");
    const bound = bindLoadedBaseConfigReceipt(loaded, {
      commit: "abc123",
      startedAt: Date.UTC(2026, 9, 1),
      generation: "gen-1",
    });
    expect(bound).toEqual({
      schema: 1,
      source: { kind: "file" },
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      process: { commit: "abc123", startedAt: "2026-10-01T00:00:00.000Z", generation: "gen-1" },
    });
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.source)).toBe(true);
    expect(Object.isFrozen(bound.process)).toBe(true);
    expect(JSON.stringify(bound)).not.toContain("private text");
  });
});

describe("stateWorkerFrom", () => {
  it("needs both the URL and the bearer, naming the missing one; the bearer comes back wrapped", () => {
    const both = stateWorkerFrom({ STATE_WORKER_URL: "https://s.example" }, secretsFrom({ MEMORY_TOKEN: "t" }));
    expect(both).toMatchObject({ ok: true, baseUrl: "https://s.example" });
    if (!both.ok) throw new Error("unreachable");
    expect(both.token.reveal()).toBe("t");
    expect(`${both.token}`).toBe("[secret:MEMORY_TOKEN]");
    expect(stateWorkerFrom({}, secretsFrom({ MEMORY_TOKEN: "t" }))).toMatchObject({
      ok: false,
      problem: expect.stringContaining("STATE_WORKER_URL is not set"),
    });
    expect(stateWorkerFrom({ STATE_WORKER_URL: "https://s.example" }, secretsFrom({}))).toMatchObject({
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

  it("refuses an invalid version on the same base read", async () => {
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect(await fake({ document: DOC, version }).client.readBase()).toMatchObject({
        ok: false,
        problem: expect.stringContaining("invalid version"),
      });
    }
  });

  it("pushes over the current version (get, then put) and reports the new one; a concurrent push is a 409 said as such", async () => {
    const state = { document: DOC as unknown, version: 2 };
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
          ? Response.json({ document: DOC, version: 5 })
          : Response.json({ error: "version conflict", version: 6 }, { status: 409 }),
    });
    expect(await racy.pushBase(DOC)).toMatchObject({
      ok: false,
      problem: expect.stringContaining("409 version conflict"),
    });
  });

  it("a frozen version refuses a newer admin setting without refreshing or retrying", async () => {
    const successor = baseConfigDocument("# newer admin setting\n", "admin", new Date(1));
    const state = { document: successor as unknown, version: 5 };
    const { client, calls } = fake(state);
    const outcome = await client.pushBase(DOC, "base", 4);
    expect(outcome).toMatchObject({ ok: false, write: "not-written" });
    expect(calls.map((c) => c.path)).toEqual(["/config/put"]);
    expect(state).toEqual({ document: successor, version: 5 });
  });

  it.each([
    {},
    { ok: false, version: 5 },
    { ok: true },
    { ok: true, version: 4 },
    { ok: true, version: 6 },
    { ok: true, version: 5.5 },
    null,
    [[]],
  ])("does not credit an uncertain acknowledgement: %j", async (body) => {
    let puts = 0;
    const client = new ConfigDocumentClient({
      baseUrl: "https://state.example",
      token: "tok",
      fetch: async (input) => {
        if (String(input).endsWith("/config/get")) return Response.json({ document: DOC, version: 4 });
        puts++;
        return Response.json(body);
      },
    });
    expect(await client.pushBase(DOC)).toMatchObject({ ok: false, write: "unknown" });
    expect(puts).toBe(1);
  });

  it.each(["transport", "server", "non-json"])("a %s failure after send leaves one unknown write", async (failure) => {
    let puts = 0;
    const client = new ConfigDocumentClient({
      baseUrl: "https://state.example",
      token: "tok",
      fetch: async (input) => {
        if (String(input).endsWith("/config/get")) return Response.json({ document: DOC, version: 4 });
        puts++;
        if (failure === "transport") throw new Error("connection lost");
        return failure === "server" ? Response.json({ error: "failed" }, { status: 500 }) : new Response("<html>");
      },
    });
    expect(await client.pushBase(DOC)).toMatchObject({ ok: false, write: "unknown" });
    expect(puts).toBe(1);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER, Number.NaN])(
    "an invalid frozen version %s sends nothing",
    async (version) => {
      const { client, calls } = fake({ document: DOC, version: 4 });
      expect(await client.pushBase(DOC, "base", version)).toMatchObject({ ok: false, write: "not-written" });
      expect(calls).toEqual([]);
    },
  );

  it("does not treat a missing field or a corrupt stored null as initial absence", async () => {
    for (const document of [undefined, null]) {
      const { client, calls } = fake({ document, version: 4 });
      expect(await client.pushBase(DOC)).toMatchObject({ ok: false, write: "not-written" });
      expect(calls.map((c) => c.path)).toEqual(["/config/get"]);
    }
  });

  it("a committed write with a lost body is unknown and never retried", async () => {
    let stored: unknown;
    let puts = 0;
    const client = new ConfigDocumentClient({
      baseUrl: "https://state.example",
      token: "tok",
      fetch: async (input, init) => {
        if (String(input).endsWith("/config/get")) return Response.json({ document: null, version: 0 });
        puts++;
        stored = JSON.parse(String(init?.body)).document;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("body lost"));
            },
          }),
        );
      },
    });
    expect(await client.pushBase(DOC)).toMatchObject({ ok: false, write: "unknown" });
    expect(stored).toEqual(DOC);
    expect(puts).toBe(1);
  });

  it("refuses canonical bytes whose digest disagrees before a direct write", async () => {
    const { client, calls } = fake({ document: { ...DOC, yaml: "# changed bytes" }, version: 4 });
    expect(await client.readBase()).toMatchObject({ ok: false });
    expect(await client.pushBase(DOC)).toMatchObject({ ok: false, write: "not-written" });
    expect(calls.every((c) => c.path === "/config/get")).toBe(true);
  });

  it("keeps private bytes out of failure output from a server or transport", async () => {
    for (const fail of [
      async () => {
        throw new Error(DOC.yaml);
      },
      async () => Response.json({ error: DOC.yaml }, { status: 500 }),
    ]) {
      const client = new ConfigDocumentClient({ baseUrl: "https://state.example", token: "tok", fetch: fail });
      const result = await client.pushBase(DOC, "base", 4);
      expect(result).toMatchObject({ ok: false, write: "unknown" });
      expect(JSON.stringify(result)).not.toContain(DOC.yaml.trim());
    }
  });

  it.each([
    [new DOMException("private timeout details", "TimeoutError"), "timeout"],
    [new DOMException("private abort details", "AbortError"), "request aborted"],
    [
      new TypeError("private fetch details", {
        cause: Object.assign(new Error("private DNS details"), { code: "ENOTFOUND" }),
      }),
      "DNS lookup failed (ENOTFOUND)",
    ],
    [
      new TypeError("private fetch details", {
        cause: Object.assign(new Error("private connection details"), { code: "ECONNREFUSED" }),
      }),
      "connection refused (ECONNREFUSED)",
    ],
    [Object.assign(new Error("private lookup details"), { code: "EAI_AGAIN" }), "DNS lookup failed (EAI_AGAIN)"],
    [Object.assign(new Error("private reset details"), { code: "ECONNRESET" }), "connection reset (ECONNRESET)"],
    [Object.assign(new Error("private timeout details"), { code: "ETIMEDOUT" }), "timeout (ETIMEDOUT)"],
    [
      Object.assign(new Error("private timeout details"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
      "timeout (UND_ERR_CONNECT_TIMEOUT)",
    ],
  ])("keeps a safe transport cause without crediting or retrying the write: %s", async (error, reason) => {
    let sends = 0;
    const client = new ConfigDocumentClient({
      baseUrl: "https://state.example",
      token: "private-bearer",
      fetch: async () => {
        sends++;
        throw error;
      },
    });
    expect(await client.pushBase(DOC, "base", 4)).toEqual({
      ok: false,
      write: "unknown",
      problem: `state Worker https://state.example: /config/put request failed — ${reason}; config write outcome unknown`,
    });
    expect(sends).toBe(1);
  });

  it("does not disclose arbitrary transport fields or thrown values", async () => {
    for (const error of [
      "private-bearer",
      Object.assign(new Error(DOC.yaml), { code: "private-bearer", cause: { code: DOC.yaml } }),
    ]) {
      const client = new ConfigDocumentClient({
        baseUrl: "https://state.example",
        token: "private-bearer",
        fetch: async () => {
          throw error;
        },
      });
      const result = await client.pushBase(DOC, "base", 4);
      expect(result).toMatchObject({ ok: false, write: "unknown" });
      expect(JSON.stringify(result)).not.toContain("private-bearer");
      expect(JSON.stringify(result)).not.toContain(DOC.yaml.trim());
    }
  });

  it("an old server's positive put without a source-fence receipt remains unknown", async () => {
    let writes = 0;
    const client = new ConfigDocumentClient({
      baseUrl: "https://state.example",
      token: "test",
      fetch: async () => {
        writes++;
        return Response.json({ ok: true, version: 1 });
      },
    });
    expect(await client.pushBase(DOC, "base-" + "a".repeat(40), 0, { key: "base", version: 3 })).toMatchObject({
      ok: false,
      write: "unknown",
    });
    expect(writes).toBe(1);
  });

  it("an unreachable Worker, a non-2xx (401 hints at the bearer), and a non-JSON answer are problems naming the Worker", async () => {
    expect(await fake({ document: null, version: 0 }, { down: true }).client.readBase()).toMatchObject({
      ok: false,
      problem: expect.stringContaining("state Worker https://state.example: /config/get request failed"),
    });
    expect(await fake({ document: null, version: 0 }, { failStatus: 401 }).client.readBase()).toMatchObject({
      ok: false,
      problem: expect.stringContaining("HTTP 401 — is MEMORY_TOKEN the Worker's bearer?"),
    });
    expect(await fake({ document: null, version: 0 }, { nonJson: true }).client.readBase()).toMatchObject({
      ok: false,
      problem: expect.stringContaining("answered non-JSON"),
    });
  });
});
