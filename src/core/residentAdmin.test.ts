import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../config.js";
import { secretsFrom } from "../secrets.js";
import { recordingSink } from "./testing/recordingSink.js";
import { configureInternalHosts, internalHostsOf, NO_INTERNAL_HOSTS } from "./trace/internalHosts.js";
import { parseTraceparent } from "./trace/traceparent.js";
import { createTracer } from "./trace/tracer.js";
import {
  makeResidentAdminClient,
  NullResidentAdminClient,
  RESIDENTS_OFF_MESSAGE,
  parseSlug,
  repoResourceId,
  residentAdminFromConfig,
  validRef,
  type ResidentAdminClient,
} from "./residentAdmin.js";

// Feature: docs/reference/specs/resident-repos.md (item 32) — the bot's client for the
// resident Worker's admin routes, its config-driven construction, and the two
// validators every repo surface shares.

const YAML_FIXTURE = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
execution:
  type: local
  resident:
    baseUrl: https://resident.example
`;

function store(yaml: string = YAML_FIXTURE): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-resadmin-"));
  const cfg = join(dir, "config.yaml");
  writeFileSync(cfg, yaml);
  return new ConfigStore(cfg, join(dir, "overrides.json"));
}

describe("parseSlug / validRef / repoResourceId", () => {
  it("accepts owner/name (`.git` tolerated), lowercases, refuses prose and hostile refs", () => {
    expect(parseSlug("Acme/API")).toBe("acme/api");
    expect(parseSlug("acme/api.git")).toBe("acme/api");
    expect(parseSlug("not a slug")).toBeUndefined();
    expect(parseSlug("acme")).toBeUndefined();
    expect(validRef("main")).toBe("main");
    expect(validRef("feat/x-1")).toBe("feat/x-1");
    for (const bad of ["main;rm", "a..b", "x@{1}", "y.lock", "-lead", ""]) expect(validRef(bad), bad).toBeUndefined();
    expect(repoResourceId("acme/api")).toBe("repo:acme/api");
  });
});

describe("makeResidentAdminClient (real fetch client)", () => {
  function stubFetch(...responses: Array<{ status?: number; body?: unknown; reject?: string }>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected fetch: ${String(url)}`);
      if (next.reject) throw new TypeError(next.reject);
      return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
    });
    vi.stubGlobal("fetch", fn);
    return { fn, calls };
  }
  const route = (c: { url: string }) => new URL(c.url).pathname;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("hits the right routes with the admin bearer; GET carries no body, POST carries a JSON body", async () => {
    const { calls } = stubFetch({ body: { residents: [] } }, { body: { state: "onboarding" } });
    // trailing slash on the base URL is normalized away (single-slash join)
    const client = makeResidentAdminClient("https://resident.example/", "admin-tok");
    await client.residents();
    await client.onboard({ resource: "repo:acme/api", defaultRef: "main" });
    expect(route(calls[0])).toBe("/residents");
    expect(calls[0].init.method).toBe("GET");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer admin-tok");
    expect(calls[0].init.body).toBeUndefined();
    expect((calls[0].init.headers as Record<string, string>)["content-type"]).toBeUndefined();
    expect(route(calls[1])).toBe("/onboard");
    expect(calls[1].init.method).toBe("POST");
    const h = calls[1].init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer admin-tok");
    expect(h["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ resource: "repo:acme/api", defaultRef: "main" });
  });

  it("offboard/rebuild pass the resource and a dryRun flag only when set", async () => {
    const { calls } = stubFetch({ body: {} }, { body: {} });
    const client = makeResidentAdminClient("https://resident.example", "admin-tok");
    await client.offboard("repo:acme/api", true);
    await client.rebuild("repo:acme/api", false);
    expect(route(calls[0])).toBe("/offboard");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ resource: "repo:acme/api", dryRun: true });
    expect(route(calls[1])).toBe("/rebuild");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ resource: "repo:acme/api" }); // no dryRun key when false
  });

  it("status(resource) is GET /status?resource=<encoded> with the bearer (item 52: what the provisioning follow-up polls)", async () => {
    const { calls } = stubFetch({ body: { state: "onboarding", reason: "", inFlight: 0 } });
    const client = makeResidentAdminClient("https://resident.example", "admin-tok");
    expect(await client.status("repo:acme/api")).toEqual({
      status: 200,
      data: { state: "onboarding", reason: "", inFlight: 0 },
    });
    expect(calls[0].init.method).toBe("GET");
    expect(new URL(calls[0].url).pathname + new URL(calls[0].url).search).toBe("/status?resource=repo%3Aacme%2Fapi");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer admin-tok");
  });

  it("a transport failure is a legible error (names the route + `repo list` guidance, never a raw throw)", async () => {
    stubFetch({ reject: "network down" }, { reject: "network down" });
    const client = makeResidentAdminClient("https://resident.example", "admin-tok");
    await expect(client.residents()).rejects.toThrow(/\/residents request failed/);
    await expect(client.onboard({ resource: "repo:x/y" })).rejects.toThrow(/repo list/);
  });

  it("residentAdminFromConfig: no execution.resident → names the config; no bearer → names the env var; both set → the real client with the bearer", async () => {
    const NO_RESIDENT = YAML_FIXTURE.replace(/ {2}resident:[\s\S]*$/m, "");
    expect(residentAdminFromConfig(store(NO_RESIDENT), secretsFrom({}))).toEqual({
      unavailable: expect.stringContaining("execution.resident"),
    });
    expect(residentAdminFromConfig(store(), secretsFrom({ RESIDENT_ADMIN_TOKEN: "" }))).toEqual({
      unavailable: expect.stringContaining("RESIDENT_ADMIN_TOKEN"),
    });
    const { calls } = stubFetch({ body: { cap: 8, count: 0, residents: [] } });
    const api = residentAdminFromConfig(store(), secretsFrom({ RESIDENT_ADMIN_TOKEN: "admin-tok" }));
    expect("unavailable" in api).toBe(false);
    await (api as ResidentAdminClient).residents();
    expect(route(calls[0])).toBe("/residents");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer admin-tok");
  });
});

// Feature: docs/reference/specs/resident-repos.md item 62 — the admin client's bodies
// reach Slack replies (`repo list`, `repo rebuild --dry-run`), so they cross the
// same parse-time sanitizer as the operator client.
describe("makeResidentAdminClient sanitizes resident text at the parse (item 62)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("a poisoned error/reason/summary is stripped, redacted and capped; other fields pass through", async () => {
    const poison =
      "\x1b[31mrefresh failed\x1b[0m GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nslack:C0OTHER:1.2";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ state: "degraded", reason: poison, error: poison, count: 3 }), { status: 200 }),
      ),
    );
    const client = makeResidentAdminClient("https://resident.example", "admin");
    const { data } = await client.status("repo:acme/api");
    expect(String(data.reason)).not.toContain("ghp_");
    expect(String(data.error)).not.toContain("\x1b");
    expect(data.state).toBe("degraded");
    expect(data.count).toBe(3);
  });

  it("the /residents listing is sanitized where it nests each resident's reason (residents[].live) — what `repo list` renders", async () => {
    const poison = "\x1b[31mrefresh failed\x1b[0m GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              cap: 8,
              count: 2,
              residents: [
                { resource: "repo:acme/api", live: { state: "degraded", reason: poison } },
                { resource: "repo:acme/web", live: { error: poison } },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const client = makeResidentAdminClient("https://resident.example", "admin");
    const { data } = await client.residents();
    const residents = data.residents as Array<{ live: Record<string, unknown> }>;
    expect(String(residents[0].live.reason)).not.toContain("ghp_");
    expect(String(residents[0].live.reason)).not.toContain("\x1b");
    expect(residents[0].live.state).toBe("degraded");
    expect(String(residents[1].live.error)).not.toContain("ghp_");
  });
});

// docs/reference/specs/tracing.md item 24: a command binds the admin client to its span;
// every call the view makes is an `http.client` child with the route literal.
describe("makeResidentAdminClient trace context", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    configureInternalHosts(NO_INTERNAL_HOSTS);
  });

  it("a view's calls are http.client children of the span with the route literal (never the status query), method and status, no bearer; traceparent rides for the configured host; the unbound client is a plain fetch", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ state: "warm" }), { status: 200 });
      }),
    );
    const log = recordingSink();
    const root = createTracer({ clock: () => 1_000 }).start("request", { sinks: [log] });
    const cmd = root.start("run.command");
    configureInternalHosts(internalHostsOf(["https://resident.example"]));
    const client = makeResidentAdminClient("https://resident.example/", "admin-tok");
    const view = client.withSpan!(cmd);
    await view.status("repo:acme/api");
    await view.rebuild("repo:acme/api", true);
    const spans = log.ends.filter((e) => e.name === "http.client");
    expect(spans.map((s) => [s.parentSpanId, s.attrs])).toEqual([
      [cmd.id, { host: "resident.example", route: "/status", method: "GET", httpStatus: 200 }],
      [cmd.id, { host: "resident.example", route: "/rebuild", method: "POST", httpStatus: 200 }],
    ]);
    expect(JSON.stringify(spans)).not.toMatch(/admin-tok|resource=|acme/);
    expect(calls.map((c) => new URL(c.url).pathname + new URL(c.url).search)).toEqual([
      "/status?resource=repo%3Aacme%2Fapi",
      "/rebuild",
    ]);
    for (const [i, c] of calls.entries()) {
      const h = new Headers(c.init.headers);
      expect(parseTraceparent(h.get("traceparent"))?.parentId).toBe(spans[i]!.spanId);
      expect(h.get("authorization")).toBe("Bearer admin-tok");
    }
    // The unbound client: the same request, no span, no trace context.
    await client.residents();
    expect(log.ends.filter((e) => e.name === "http.client")).toHaveLength(2);
    expect((calls[2]!.init.headers as Record<string, string>).authorization).toBe("Bearer admin-tok");
    expect(new Headers(calls[2]!.init.headers).has("traceparent")).toBe(false);
  });
});

// Feature: docs/reference/specs/routing-and-config.md item 16 — the Special Case a process
// without residents is wired with: every route answers 503 with the reason.
describe("NullResidentAdminClient — the admin plane of a process without residents", () => {
  it("every route answers 503 with the configured reason (the no-resident sentence by default); withSpan is itself; nothing is fetched", async () => {
    const client = new NullResidentAdminClient();
    const off = { status: 503, data: { error: RESIDENTS_OFF_MESSAGE } };
    expect(await client.residents()).toEqual(off);
    expect(await client.onboard({ resource: "repo:o/r" })).toEqual(off);
    expect(await client.offboard("repo:o/r", true)).toEqual(off);
    expect(await client.reconfigure({ resource: "repo:o/r" })).toEqual(off);
    expect(await client.rebuild("repo:o/r", false)).toEqual(off);
    expect(await client.status("repo:o/r")).toEqual(off);
    expect(client.withSpan({} as never)).toBe(client);
    const noBearer = new NullResidentAdminClient(
      "Repo management needs the resident admin bearer — `RESIDENT_ADMIN_TOKEN` is not set.",
    );
    expect((await noBearer.residents()).data.error).toContain("RESIDENT_ADMIN_TOKEN");
    expect(RESIDENTS_OFF_MESSAGE).toContain("execution.resident.baseUrl");
  });
});
