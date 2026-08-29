import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../config.js";
import {
  handleRepoCommand,
  makeResidentAdminClient,
  parseRepoCommand,
  type ResidentAdminClient,
  type ResidentAdminResponse,
} from "./repoCommands.js";

// Feature: features/resident-repos.md — U8 repo-management chat commands:
// `repo onboard/offboard/reconfigure/rebuild/list` in the config-command
// family. All but `list` are gated by canManageRepos (KTD9 fail-closed);
// destructive commands accept --dry-run and render the resident's itemized
// plan; parsing is key="value" tokens with sensible Node defaults.

const YAML_FIXTURE = `
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
permissions:
  admins: ["slack:UADMIN"]
execution:
  type: local
  resident:
    baseUrl: https://resident.example
`;

function store(yaml: string = YAML_FIXTURE): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-repocmd-"));
  const cfg = join(dir, "config.yaml");
  writeFileSync(cfg, yaml);
  return new ConfigStore(cfg, join(dir, "overrides.json"));
}

const ok = (data: Record<string, unknown>, status = 200): ResidentAdminResponse => ({ status, data });

/** Mock admin client capturing calls; every route answers a canned success. */
function mockClient(overrides: Partial<Record<keyof ResidentAdminClient, ResidentAdminResponse>> = {}) {
  const client: ResidentAdminClient = {
    onboard: vi.fn(async () => overrides.onboard ?? ok({ resource: "repo:acme/api", state: "onboarding" }, 202)),
    offboard: vi.fn(async () => overrides.offboard ?? ok({
      resource: "repo:acme/api",
      registryRemoved: true,
      schedulesCancelled: true,
      containerStopped: true,
      storageCleared: true,
      backupObjectsDeleted: 4,
      r2ObjectsDeleted: 0,
      errors: [],
    })),
    reconfigure: vi.fn(async () => overrides.reconfigure ?? ok({ resource: "repo:acme/api", record: {} })),
    rebuild: vi.fn(async () => overrides.rebuild ?? ok({
      resource: "repo:acme/api",
      dryRun: false,
      from: { state: "down", reason: "r2-restore-failed: x" },
      discards: { snapshot: { createdAt: "2026-08-26T00:00:00Z", mirrorBackupId: "m1", checkoutBackupId: "c1" }, backupObjects: 4 },
      reprovision: { defaultRef: "master", provisioningTimeoutMs: 300000 },
      keeps: { registryRecord: true, threadBindings: 2 },
      backupObjectsDeleted: 4,
      state: "onboarding",
    }, 202)),
    residents: vi.fn(async () => overrides.residents ?? ok({
      cap: 8,
      count: 1,
      residents: [
        {
          resource: "repo:jshttp/vary",
          defaultRef: "master",
          commands: { test: "npm test", build: "npm pack --dry-run", install: "npm install --no-audit --no-fund" },
          live: { state: "warm", reason: "", sha: "1220b9c4a123", lastRefreshAt: "2026-08-26T12:00:00Z" },
        },
      ],
    })),
  };
  return client;
}

const msg = (text: string, user = "slack:UADMIN") => ({
  channelId: "slack:CX",
  userId: user,
  threadKey: "slack:CX:1.0",
  text,
});

describe("repo command recognition", () => {
  it("non-repo text and prose starting with 'repo' pass through as null", async () => {
    const s = store();
    const c = mockClient();
    expect(await handleRepoCommand(s, msg("hello there"), c)).toBeNull();
    expect(await handleRepoCommand(s, msg("repo onboarding is done how?"), c)).toBeNull();
    expect(await handleRepoCommand(s, msg("repository list please"), c)).toBeNull();
  });
});

// U6: `repo test` / `repo build` extend the verb whitelist as OPERATOR-level
// deterministic ops (KTD8) — parsed here so every op has a deterministic
// invocation, but EXECUTED by the dispatcher fast-path, never by
// handleRepoCommand, and never gated by canManageRepos.
describe("deterministic op verbs (U6: repo test / repo build)", () => {
  it("parseRepoCommand recognizes `repo test <owner/name> <ref>`", () => {
    expect(parseRepoCommand("repo test acme/api main")).toEqual({ verb: "test", slug: "acme/api", ref: "main" });
  });

  it("parseRepoCommand recognizes `repo build <owner/name>` without a ref", () => {
    expect(parseRepoCommand("repo build Acme/API")).toEqual({ verb: "build", slug: "acme/api" });
  });

  it("a hostile ref (shell metacharacters) is a NAMED parse error, never a command", () => {
    for (const text of ["repo test acme/api main;rm", "repo test acme/api `whoami`", "repo build acme/api $(id)"]) {
      const cmd = parseRepoCommand(text);
      expect(cmd).not.toBeNull();
      expect(cmd && "error" in cmd ? cmd.error : "").toMatch(/ref/i);
    }
  });

  it("extra tokens are refused naming the accepted shape", () => {
    const cmd = parseRepoCommand("repo test acme/api main extra");
    expect(cmd && "error" in cmd ? cmd.error : "").toMatch(/<owner\/name> \[<ref>\]/);
  });

  it("a missing slug is refused like every other repo verb", () => {
    const cmd = parseRepoCommand("repo test");
    expect(cmd && "error" in cmd ? cmd.error : "").toContain("owner/name");
  });

  it("handleRepoCommand passes valid op commands through as null (dispatcher-owned), with NO canManageRepos gate and no client call", async () => {
    const s = store();
    const c = mockClient();
    // non-admin user: an op verb must NOT hit the fail-closed admin gate
    expect(await handleRepoCommand(s, msg("repo test acme/api main", "slack:URANDOM"), c)).toBeNull();
    expect(await handleRepoCommand(s, msg("repo build acme/api", "slack:URANDOM"), c)).toBeNull();
    for (const fn of Object.values(c)) expect(fn).not.toHaveBeenCalled();
  });

  it("handleRepoCommand still replies the named error for malformed op commands", async () => {
    const s = store();
    const c = mockClient();
    const reply = await handleRepoCommand(s, msg("repo test acme/api main;rm", "slack:URANDOM"), c);
    expect(reply).toMatch(/ref/i);
    for (const fn of Object.values(c)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("KTD9 fail-closed gate", () => {
  it("non-admin `repo onboard` → refusal naming the admins; no client call", async () => {
    const s = store();
    const c = mockClient();
    const reply = await handleRepoCommand(s, msg("repo onboard acme/api", "slack:URANDOM"), c);
    expect(reply).toContain("🚫");
    expect(reply).toContain("<@slack:UADMIN>");
    expect(c.onboard).not.toHaveBeenCalled();
  });

  it("non-admin offboard/reconfigure/rebuild are refused the same way", async () => {
    const s = store();
    const c = mockClient();
    for (const text of ["repo offboard acme/api", "repo reconfigure acme/api ref=main", "repo rebuild acme/api"]) {
      const reply = await handleRepoCommand(s, msg(text, "slack:URANDOM"), c);
      expect(reply).toContain("🚫");
    }
    expect(c.offboard).not.toHaveBeenCalled();
    expect(c.reconfigure).not.toHaveBeenCalled();
    expect(c.rebuild).not.toHaveBeenCalled();
  });

  it("`repo list` stays open to non-admins", async () => {
    const s = store();
    const c = mockClient();
    const reply = await handleRepoCommand(s, msg("repo list", "slack:URANDOM"), c);
    expect(c.residents).toHaveBeenCalledTimes(1);
    expect(reply).toContain("jshttp/vary");
    expect(reply).toContain("warm");
  });

  it("a permissions.repoManagement member may manage repos", async () => {
    const s = store(YAML_FIXTURE.replace('admins: ["slack:UADMIN"]', 'admins: ["slack:UADMIN"]\n  repoManagement: ["slack:UDEV"]'));
    const c = mockClient();
    const reply = await handleRepoCommand(s, msg("repo onboard acme/api", "slack:UDEV"), c);
    expect(reply).not.toContain("🚫");
    expect(c.onboard).toHaveBeenCalledTimes(1);
  });
});

describe("onboard parsing", () => {
  it("bare onboard uses sensible Node defaults and ref=main; slug is lowercased", async () => {
    const s = store();
    const c = mockClient();
    const reply = await handleRepoCommand(s, msg("repo onboard Acme/API"), c);
    expect(c.onboard).toHaveBeenCalledWith({
      resource: "repo:acme/api",
      commands: {
        install: "npm install --no-audit --no-fund",
        build: "npm run build --if-present",
        test: "npm test",
      },
      defaultRef: "main",
    });
    expect(reply).toContain("acme/api");
    expect(reply).toContain("onboarding");
  });

  it('key="value" overrides and ref= are honored', async () => {
    const s = store();
    const c = mockClient();
    await handleRepoCommand(
      s,
      msg('repo onboard acme/api ref=develop test="npm run test:unit" build="make build" install="pnpm install"'),
      c,
    );
    expect(c.onboard).toHaveBeenCalledWith({
      resource: "repo:acme/api",
      commands: { install: "pnpm install", build: "make build", test: "npm run test:unit" },
      defaultRef: "develop",
    });
  });

  it("smart quotes (Slack autoformat) are normalized", async () => {
    const s = store();
    const c = mockClient();
    await handleRepoCommand(s, msg("repo onboard acme/api test=“npm run check”"), c);
    const body = vi.mocked(c.onboard).mock.calls[0][0] as { commands: Record<string, string> };
    expect(body.commands.test).toBe("npm run check");
  });

  it("an invalid slug is rejected naming the expected form; no client call", async () => {
    const s = store();
    const c = mockClient();
    const reply = await handleRepoCommand(s, msg("repo onboard not-a-slug"), c);
    expect(reply).toContain("owner/name");
    expect(c.onboard).not.toHaveBeenCalled();
  });

  it("a hostile ref is rejected before any client call", async () => {
    const s = store();
    const c = mockClient();
    const reply = await handleRepoCommand(s, msg("repo onboard acme/api ref=../evil"), c);
    expect(reply).toMatch(/ref/i);
    expect(c.onboard).not.toHaveBeenCalled();
  });

  it("an unknown key is rejected naming the valid ones", async () => {
    const s = store();
    const c = mockClient();
    const reply = await handleRepoCommand(s, msg('repo onboard acme/api foo="bar"'), c);
    expect(reply).toMatch(/test|build|install|ref/);
    expect(c.onboard).not.toHaveBeenCalled();
  });

  it("a resident-side error (e.g. cap reached) is relayed verbatim", async () => {
    const s = store();
    const c = mockClient({ onboard: ok({ error: "resident cap reached (8/8); offboard a resident first" }, 429) });
    const reply = await handleRepoCommand(s, msg("repo onboard acme/api"), c);
    expect(reply).toContain("resident cap reached");
    expect(reply).toContain("429");
  });

  it("`repo list` names an active test override (cap/floor lowered for live checks) so nobody mistakes it for the real cap", async () => {
    const s = store();
    const c = mockClient({
      residents: ok({
        cap: 2,
        capDefault: 6,
        testOverrides: { cap: 2, floorS: 600, floorDefaultS: 3600, setAt: "2026-08-29T23:00:00.000Z", build: "gc51" },
        count: 1,
        residents: [{ resource: "repo:acme/api", defaultRef: "main", live: { state: "warm" } }],
      }),
    });
    const reply = await handleRepoCommand(s, msg("repo list"), c);
    expect(reply).toContain("(1/2)");
    expect(reply).toContain("⚠️ test overrides active");
    expect(reply).toContain("cap 2 (default 6)");
    expect(reply).toContain("LRU floor 600s (default 3600s)");
    expect(reply).toContain("2026-08-29T23:00:00.000Z");
  });

  it("`repo list` without an override carries no warning", async () => {
    const s = store();
    const c = mockClient({
      residents: ok({ cap: 6, capDefault: 6, count: 1, residents: [{ resource: "repo:acme/api", defaultRef: "main", live: { state: "warm" } }] }),
    });
    const reply = await handleRepoCommand(s, msg("repo list"), c);
    expect(reply).not.toContain("test overrides");
  });

  it("`--evict-coldest` opts the onboard into LRU eviction (#50): the body carries evictColdest:true", async () => {
    const s = store();
    const c = mockClient();
    await handleRepoCommand(s, msg("repo onboard acme/api --evict-coldest ref=develop"), c);
    expect(c.onboard).toHaveBeenCalledWith(expect.objectContaining({ resource: "repo:acme/api", defaultRef: "develop", evictColdest: true }));
  });

  it("an onboard that evicted a resident says which one and when it was last used", async () => {
    const s = store();
    const c = mockClient({
      onboard: ok(
        {
          resource: "repo:acme/api",
          state: "onboarding",
          evicted: { resource: "repo:jshttp/fresh", lastActivityAt: "2026-08-27T10:00:00.000Z", backupObjectsDeleted: 4, errors: [] },
        },
        202,
      ),
    });
    const reply = await handleRepoCommand(s, msg("repo onboard acme/api --evict-coldest"), c);
    expect(reply).toContain("acme/api");
    expect(reply).toMatch(/evicted `jshttp\/fresh`.*last used 2026-08-27T10:00:00.000Z/);
  });

  it("an over-cap onboard with no eligible resident relays the per-resident reasons", async () => {
    const s = store();
    const c = mockClient({
      onboard: ok(
        {
          error: "resident cap reached (8/8); offboard a resident first, or onboard with evictColdest:true to make room; evictColdest found no eligible resident",
          rejected: [
            { resource: "repo:a/hot", why: "active 12m ago (floor 60m)" },
            { resource: "repo:b/busy", why: "2 live worktree(s)" },
          ],
        },
        429,
      ),
    });
    const reply = await handleRepoCommand(s, msg("repo onboard acme/api --evict-coldest"), c);
    expect(reply).toContain("no eligible resident");
    expect(reply).toContain("`a/hot` — active 12m ago (floor 60m)");
    expect(reply).toContain("`b/busy` — 2 live worktree(s)");
  });

  it("`--evict-coldest` is an onboard-only flag; reconfigure refuses it by name", async () => {
    const s = store();
    const c = mockClient();
    const reply = await handleRepoCommand(s, msg("repo reconfigure acme/api --evict-coldest"), c);
    expect(reply).toContain("--evict-coldest");
    expect(reply).toContain("repo onboard");
    expect(c.reconfigure).not.toHaveBeenCalled();
  });

  it("an onboard warning field (App unconfigured) surfaces in the reply", async () => {
    const s = store();
    const c = mockClient({
      onboard: ok(
        { resource: "repo:acme/api", state: "onboarding", warning: "github-app-not-configured: installation membership was NOT verified" },
        202,
      ),
    });
    const reply = await handleRepoCommand(s, msg("repo onboard acme/api"), c);
    expect(reply).toContain("github-app-not-configured");
  });
});

describe("offboard + rebuild (--dry-run)", () => {
  it("offboard --dry-run calls the client with dryRun and renders the itemized plan", async () => {
    const s = store();
    const c = mockClient({
      offboard: ok({
        resource: "repo:acme/api",
        dryRun: true,
        wouldRemove: {
          registryRecord: true,
          schedules: 2,
          snapshotBackupIds: ["m1", "c1"],
          backupObjects: 4,
          r2Objects: 0,
          threadBindings: 3,
          container: "warm",
        },
      }),
    });
    const reply = await handleRepoCommand(s, msg("repo offboard acme/api --dry-run"), c);
    expect(c.offboard).toHaveBeenCalledWith("repo:acme/api", true);
    expect(reply).toContain("Dry run");
    expect(reply).toContain("4 snapshot backup object");
    expect(reply).toContain("3 thread binding");
    expect(reply).toContain("Nothing was changed");
  });

  it("real offboard calls with dryRun=false and renders the teardown result", async () => {
    const s = store();
    const c = mockClient();
    const reply = await handleRepoCommand(s, msg("repo offboard acme/api"), c);
    expect(c.offboard).toHaveBeenCalledWith("repo:acme/api", false);
    expect(reply).toContain("Offboarded");
    expect(reply).toContain("4");
  });

  it("rebuild --dry-run renders discards + reprovision plan without executing", async () => {
    const s = store();
    const c = mockClient({
      rebuild: ok({
        resource: "repo:acme/api",
        dryRun: true,
        from: { state: "warm", reason: "" },
        discards: { snapshot: { createdAt: "2026-08-26T00:00:00Z", mirrorBackupId: "m1", checkoutBackupId: "c1" }, backupObjects: 4 },
        reprovision: { defaultRef: "master", provisioningTimeoutMs: 300000 },
        keeps: { registryRecord: true, threadBindings: 2 },
      }),
    });
    const reply = await handleRepoCommand(s, msg("repo rebuild acme/api --dry-run"), c);
    expect(c.rebuild).toHaveBeenCalledWith("repo:acme/api", true);
    expect(reply).toContain("Dry run");
    expect(reply).toContain("master");
    expect(reply).toContain("Nothing was changed");
  });

  it("real rebuild reports the down→onboarding transition", async () => {
    const s = store();
    const c = mockClient();
    const reply = await handleRepoCommand(s, msg("repo rebuild acme/api"), c);
    expect(c.rebuild).toHaveBeenCalledWith("repo:acme/api", false);
    expect(reply).toContain("onboarding");
  });

  it("an unknown flag is rejected", async () => {
    const s = store();
    const c = mockClient();
    const reply = await handleRepoCommand(s, msg("repo offboard acme/api --force"), c);
    expect(reply).toContain("--dry-run");
    expect(c.offboard).not.toHaveBeenCalled();
  });
});

describe("reconfigure", () => {
  it("merges command overrides onto the current table (resident replaces whole tables)", async () => {
    const s = store();
    const c = mockClient({
      residents: ok({
        cap: 8,
        count: 1,
        residents: [
          {
            resource: "repo:acme/api",
            defaultRef: "main",
            commands: { test: "old-test", build: "old-build", install: "old-install" },
            live: { state: "warm", reason: "" },
          },
        ],
      }),
    });
    await handleRepoCommand(s, msg('repo reconfigure acme/api test="new-test"'), c);
    expect(c.reconfigure).toHaveBeenCalledWith({
      resource: "repo:acme/api",
      commands: { test: "new-test", build: "old-build", install: "old-install" },
    });
  });

  it("ref-only reconfigure sends defaultRef without touching commands", async () => {
    const s = store();
    const c = mockClient();
    await handleRepoCommand(s, msg("repo reconfigure acme/api ref=develop"), c);
    expect(c.reconfigure).toHaveBeenCalledWith({ resource: "repo:acme/api", defaultRef: "develop" });
    expect(c.residents).not.toHaveBeenCalled();
  });

  it("reconfigure with nothing to change is a usage error", async () => {
    const s = store();
    const c = mockClient();
    const reply = await handleRepoCommand(s, msg("repo reconfigure acme/api"), c);
    expect(reply).toMatch(/nothing to (re)?configure/i);
    expect(c.reconfigure).not.toHaveBeenCalled();
  });
});

describe("configuration preconditions", () => {
  it("without execution.resident (and no injected client) the reply names the missing config", async () => {
    const NO_RESIDENT = YAML_FIXTURE.replace(/  resident:[\s\S]*$/m, "");
    const s = store(NO_RESIDENT);
    const reply = await handleRepoCommand(s, msg("repo list"));
    expect(reply).toContain("execution.resident");
  });
});

// Coverage gap (testing P1): the REAL fetch-based admin client is never
// constructed — every test above injects a hand-written mock. These exercise
// makeResidentAdminClient directly (routes/headers/body over a mocked fetch)
// AND the default-client wiring in handleRepoCommand, including the
// admin-token-env-unset branch.
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

    // GET /residents — bearer, no body, no content-type
    expect(route(calls[0])).toBe("/residents");
    expect(calls[0].init.method).toBe("GET");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer admin-tok");
    expect(calls[0].init.body).toBeUndefined();
    expect((calls[0].init.headers as Record<string, string>)["content-type"]).toBeUndefined();

    // POST /onboard — bearer + content-type + the JSON body verbatim
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

  it("a transport failure is a legible error (names the route + `repo list` guidance, never a raw throw)", async () => {
    stubFetch({ reject: "network down" }, { reject: "network down" });
    const client = makeResidentAdminClient("https://resident.example", "admin-tok");
    await expect(client.residents()).rejects.toThrow(/\/residents request failed/);
    await expect(client.onboard({ resource: "repo:x/y" })).rejects.toThrow(/repo list/);
  });

  it("the default-client path (no injected client) errors legibly when the admin token env is unset", async () => {
    vi.stubEnv("RESIDENT_ADMIN_TOKEN", ""); // unset → repo-management commands must name the missing bearer
    const s = store(); // execution.resident.baseUrl configured
    const reply = await handleRepoCommand(s, msg("repo onboard acme/api", "slack:UADMIN"));
    expect(reply).toContain("RESIDENT_ADMIN_TOKEN");
    expect(reply).toMatch(/not set/i);
  });

  it("the default-client path constructs the real client and hits /residents when the admin token IS set", async () => {
    vi.stubEnv("RESIDENT_ADMIN_TOKEN", "admin-tok");
    const { calls } = stubFetch({ body: { cap: 8, count: 0, residents: [] } });
    const s = store();
    const reply = await handleRepoCommand(s, msg("repo list", "slack:URANDOM"));
    expect(route(calls[0])).toBe("/residents");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer admin-tok");
    expect(reply).toContain("No repos onboarded");
  });
});
