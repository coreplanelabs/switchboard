import { describe, expect, it, vi } from "vitest";
import { CommandRegistry, bindCommands, renderText, type Caller, type CommandInvoker } from "../commandRegistry.js";
import { parseInvocation } from "../commandSurface.js";
import type { OperationResult, Operations } from "../operations.js";
import type { ResidentAdminClient, ResidentAdminResponse } from "../residentAdmin.js";
import { NO_OPS_BACKEND_MESSAGE, SETTLE_MAX_MS, SETTLE_POLL_MS, registerRepoCommands, repoCommands, repoList, settleProvisioning, type RepoCommandDeps } from "./repo.js";
import type { RepoInspector } from "../../execution/githubRepoInspect.js";

// Feature: features/resident-repos.md (items 32, 41) / features/command-registry.md
// (phase 4b): the whole `repo.*` group as registry commands — `repo.list` (open,
// `repo:read`), the mutating verbs `onboard/offboard/reconfigure/rebuild`
// (`repoManager`, `repo:write`), and the deterministic ops `test/build`
// (`agentRun` + canUseRepo, `repo:exec`). Text replies are the pre-migration
// chat replies (golden strings captured from the legacy handlers before they
// were removed); flags are the derived grammar (`--ref`, `--test "…"`).

const ok = (data: Record<string, unknown>, status = 200): ResidentAdminResponse => ({ status, data });

const TWO_RESIDENTS = {
  cap: 6,
  capDefault: 6,
  count: 2,
  residents: [
    { resource: "repo:jshttp/vary", defaultRef: "master", live: { state: "warm", reason: "", sha: "0123456789abcdef", lastRefreshAt: "2026-01-01T00:00:00.000Z" } },
    { resource: "repo:acme/api", defaultRef: "main", live: { state: "degraded", reason: "alarm-missed" } },
  ],
};

/** Mock admin client capturing calls; every route answers a canned success. */
function mockClient(overrides: Partial<Record<keyof ResidentAdminClient, ResidentAdminResponse | (() => Promise<ResidentAdminResponse>)>> = {}): ResidentAdminClient {
  const answer = (key: keyof ResidentAdminClient, fallback: ResidentAdminResponse) => {
    const o = overrides[key];
    return vi.fn(typeof o === "function" ? o : async () => o ?? fallback);
  };
  return {
    onboard: answer("onboard", ok({ resource: "repo:acme/api", state: "onboarding" }, 202)),
    offboard: answer(
      "offboard",
      ok({ resource: "repo:acme/api", registryRemoved: true, schedulesCancelled: true, containerStopped: true, storageCleared: true, backupObjectsDeleted: 4, r2ObjectsDeleted: 0, errors: [] }),
    ),
    reconfigure: answer("reconfigure", ok({ resource: "repo:acme/api", record: {} })),
    rebuild: answer(
      "rebuild",
      ok(
        {
          resource: "repo:acme/api",
          dryRun: false,
          from: { state: "down", reason: "r2-restore-failed: x" },
          discards: { snapshot: { createdAt: "2026-08-26T00:00:00Z", mirrorBackupId: "m1", checkoutBackupId: "c1" }, backupObjects: 4 },
          reprovision: { defaultRef: "master", provisioningTimeoutMs: 300000 },
          keeps: { registryRecord: true, threadBindings: 2 },
          backupObjectsDeleted: 4,
          state: "onboarding",
        },
        202,
      ),
    ),
    residents: answer("residents", ok(TWO_RESIDENTS)),
    status: answer("status", ok({ state: "warm", reason: "", inFlight: 0 })),
  };
}

function fakeOps(result: OperationResult | (() => Promise<OperationResult>)) {
  const calls: Array<{ op: string; req: { repo: string; ref?: string } }> = [];
  const ops: Operations = {
    async run(op, req) {
      calls.push({ op, req });
      return typeof result === "function" ? result() : result;
    },
  };
  return { ops, calls };
}

interface BindOptions {
  admin?: ResidentAdminClient | { unavailable: string };
  ops?: Operations | null;
  canUseRepo?: (callerId: string, slug: string) => boolean;
  inspect?: RepoInspector;
  sleep?: (ms: number) => Promise<void>;
}

function depsOf(opts: BindOptions = {}): RepoCommandDeps {
  const admin = opts.admin ?? mockClient();
  return {
    repo: {
      admin: async () => admin,
      operations: async () => (opts.ops === undefined ? null : opts.ops),
      canUseRepo: async (callerId: string, slug: string) => (opts.canUseRepo ? opts.canUseRepo(callerId, slug) : true),
      ...(opts.inspect ? { inspect: opts.inspect } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    },
  };
}

function bind(opts: BindOptions = {}): CommandInvoker {
  const registry = new CommandRegistry<RepoCommandDeps>({ audit: () => {} });
  registerRepoCommands(registry);
  return bindCommands(registry, depsOf(opts));
}

/** An inspector answering the given root facts for every repo. */
const inspecting =
  (facts: { entries: string[]; packageJson?: { scripts?: Record<string, unknown>; packageManager?: unknown } | null }): RepoInspector =>
  async () => ({ ok: true, facts });
const PNPM_ROOT = { entries: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"], packageJson: { scripts: { test: "turbo test -- run" } } };

/** A chat caller admitted through exactly the given gates (`open` always). */
const chat = (userId: string, gates: Array<"repoManager" | "agentRun"> = []): Caller => ({
  kind: "chat",
  id: userId,
  scopes: new Set(),
  chatGate: (gate) => gate === "open" || gates.includes(gate as "repoManager"),
  origin: { channelId: "slack:CX", threadKey: "slack:CX:1.0" },
});
const admin = chat("slack:UADMIN", ["repoManager", "agentRun"]);
const mcp = (...scopes: string[]): Caller => ({ kind: "mcp", id: "mcp:alice", scopes: new Set(scopes) });

/** Send a chat line through the shared grammar (what the dispatcher does) and render the reply. */
async function say(commands: CommandInvoker, text: string, caller: Caller) {
  const [group, verb, ...rest] = text.split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((t) => t.replace(/^"|"$/g, ""));
  const id = `${group}.${verb}`;
  const bound = parseInvocation(commands.get(id)!, rest);
  if (bound.kind !== "invoke") throw new Error(JSON.stringify(bound));
  const res = await commands.invoke(id, bound.input, caller);
  return { res, text: res.ok ? renderText(commands.get(id)!, res.value) : `${res.error}: ${res.message}` };
}

describe("repo.list", () => {
  it("stays open to any chat caller, reads the live registry each call, and renders the exact pre-migration reply", async () => {
    const c = mockClient();
    const commands = bind({ admin: c });
    const res = await commands.invoke("repo.list", {}, chat("slack:URANDOM"));
    expect(res.ok).toBe(true);
    expect(res.ok && res.value).toEqual(TWO_RESIDENTS);
    expect(renderText(commands.get("repo.list")!, res.ok ? res.value : null)).toBe(
      "*Resident repos* (2/6):\n• `jshttp/vary` — *warm* · ref `master` · sha `01234567` · refreshed 2026-01-01T00:00:00.000Z\n• `acme/api` — *degraded* (alarm-missed) · ref `main`",
    );
    await commands.invoke("repo.list", {}, chat("slack:URANDOM"));
    expect(c.residents).toHaveBeenCalledTimes(2);
  });

  it("an empty registry and an active test override keep their wording", async () => {
    const empty = bind({ admin: mockClient({ residents: ok({ cap: 6, count: 0, residents: [] }) }) });
    expect((await say(empty, "repo list", chat("slack:U1"))).text).toBe("No repos onboarded (0/6). Onboard one with `repo onboard <owner/name>`.");
    const overridden = bind({
      admin: mockClient({
        residents: ok({
          cap: 2,
          capDefault: 6,
          testOverrides: { cap: 2, floorS: 600, floorDefaultS: 3600, setAt: "2026-08-29T23:00:00.000Z", build: "gc51" },
          count: 1,
          residents: [{ resource: "repo:acme/api", defaultRef: "main", live: { state: "warm" } }],
        }),
      }),
    });
    const reply = (await say(overridden, "repo list", chat("slack:U1"))).text;
    expect(reply).toContain("(1/2)");
    expect(reply).toContain("⚠️ test overrides active (set 2026-08-29T23:00:00.000Z): cap 2 (default 6), LRU floor 600s (default 3600s)");
  });

  it("no resident configured, a non-200 route answer, and a transport failure are `unavailable` with the legacy text", async () => {
    const unconfigured = bind({ admin: { unavailable: "Resident repo environments aren't configured — set `execution.resident.baseUrl` in config.yaml." } });
    expect(await unconfigured.invoke("repo.list", {}, chat("slack:U1"))).toMatchObject({ ok: false, error: "unavailable", status: 503, message: expect.stringContaining("execution.resident") });
    const failing = bind({ admin: mockClient({ residents: ok({ error: "registry unavailable" }, 503) }) });
    expect(await failing.invoke("repo.list", {}, chat("slack:U1"))).toMatchObject({ ok: false, error: "unavailable", message: "repo list failed (HTTP 503): registry unavailable" });
    const down = bind({
      admin: mockClient({
        residents: async () => {
          throw new Error("resident admin /residents request failed (fetch failed). The operation may still have run in the resident; check `repo list` before re-running it.");
        },
      }),
    });
    expect(await down.invoke("repo.list", {}, chat("slack:U1"))).toMatchObject({ ok: false, error: "unavailable", message: expect.stringContaining("/residents request failed") });
  });

  it("machine callers need repo:read (AE12): dispatch-only and runs:read tokens are refused, repo:read passes", async () => {
    const commands = bind();
    expect(await commands.invoke("repo.list", {}, mcp("dispatch"))).toMatchObject({ ok: false, error: "unauthorized", status: 403 });
    expect(await commands.invoke("repo.list", {}, mcp("runs:read"))).toMatchObject({ ok: false, error: "unauthorized" });
    expect((await commands.invoke("repo.list", {}, mcp("repo:read"))).ok).toBe(true);
    expect(repoList).toMatchObject({ scope: "repo:read", chatGate: "open", effect: "read" });
  });
});

describe("gates (KTD9 fail-closed) and scopes", () => {
  it("the mutating verbs are `repoManager` + `repo:write`; a plain chat user is refused before any resident call", async () => {
    const c = mockClient();
    const commands = bind({ admin: c });
    for (const text of ["repo onboard acme/api", "repo offboard acme/api", "repo reconfigure acme/api --ref x", "repo rebuild acme/api"]) {
      expect((await say(commands, text, chat("slack:UX"))).res, text).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "registry" });
    }
    for (const fn of [c.onboard, c.offboard, c.reconfigure, c.rebuild]) expect(fn).not.toHaveBeenCalled();
    const byId = Object.fromEntries(repoCommands.map((cmd) => [cmd.id, cmd]));
    for (const id of ["repo.onboard", "repo.offboard", "repo.reconfigure", "repo.rebuild"]) expect(byId[id], id).toMatchObject({ scope: "repo:write", chatGate: "repoManager", effect: "write" });
    expect(byId["repo.test"]).toMatchObject({ scope: "repo:exec", chatGate: "agentRun", effect: "write" });
    expect(byId["repo.build"]).toMatchObject({ scope: "repo:exec", chatGate: "agentRun", effect: "write" });
  });

  it("machine callers: repo:read cannot onboard, repo:write can; repo:write cannot run tests, repo:exec can", async () => {
    const { ops } = fakeOps({ kind: "result", ok: true, summary: "test passed" });
    const commands = bind({ ops });
    expect(await commands.invoke("repo.onboard", { args: ["acme/api"] }, mcp("repo:read"))).toMatchObject({ ok: false, error: "unauthorized" });
    expect((await commands.invoke("repo.onboard", { args: ["acme/api"] }, mcp("repo:write"))).ok).toBe(true);
    expect(await commands.invoke("repo.test", { args: ["acme/api"] }, mcp("repo:write"))).toMatchObject({ ok: false, error: "unauthorized" });
    expect((await commands.invoke("repo.test", { args: ["acme/api"] }, mcp("repo:exec"))).ok).toBe(true);
  });
});

describe("repo onboard", () => {
  it("item 52: the command table is detected from the repo root — a pnpm workspace gets pnpm commands, no build, and the reply explains each choice", async () => {
    const c = mockClient();
    const inspect = vi.fn(inspecting(PNPM_ROOT));
    const { text } = await say(bind({ admin: c, inspect }), "repo onboard Acme/API", admin);
    expect(inspect).toHaveBeenCalledWith("acme/api", "main");
    expect(c.onboard).toHaveBeenCalledWith({
      resource: "repo:acme/api",
      commands: { install: "pnpm install --frozen-lockfile", build: "true", test: "pnpm test" },
      defaultRef: "main",
    });
    expect(text.split("\n")).toEqual([
      "🏗️ Onboarding `acme/api` on `main` — provisioning started (state `onboarding`). I'll report here when it is warm or has failed; `repo list` shows the live state meanwhile.",
      "Toolchain: pnpm (package manager from pnpm-lock.yaml; no build script — build is a no-op)",
      "Commands: install `pnpm install --frozen-lockfile` · build — none (`true`) · test `pnpm test`",
    ]);
  });

  it("item 52: a repo with no root package.json gets NO install and no-op build/test — the resident's table simply lacks `install`", async () => {
    const c = mockClient();
    const { text } = await say(bind({ admin: c, inspect: inspecting({ entries: ["Taskfile.yaml", "terrateam"] }) }), "repo onboard coreplanelabs/infrastructure", admin);
    expect(c.onboard).toHaveBeenCalledWith({ resource: "repo:coreplanelabs/infrastructure", commands: { build: "true", test: "true" }, defaultRef: "main" });
    expect(text).toContain("Toolchain: none (no package.json at the repo root — nothing to install or build; pass --test/--build to set real commands)");
    expect(text).toContain("Commands: install — none · build — none (`true`) · test — none (`true`)");
  });

  it("item 52: the ref is inspected, and explicit flags win per key over the detected table", async () => {
    const c = mockClient();
    const inspect = vi.fn(inspecting(PNPM_ROOT));
    await say(bind({ admin: c, inspect }), 'repo onboard acme/api --ref develop --test "pnpm vitest run"', admin);
    expect(inspect).toHaveBeenCalledWith("acme/api", "develop");
    expect(c.onboard).toHaveBeenCalledWith({ resource: "repo:acme/api", commands: { install: "pnpm install --frozen-lockfile", build: "true", test: "pnpm vitest run" }, defaultRef: "develop" });
  });

  it("item 52: an uninspectable root (no credential, 404, no inspector) falls back to the npm table and SAYS so; ref main; the slug is lowercased", async () => {
    const c = mockClient();
    const { text } = await say(bind({ admin: c, inspect: async () => ({ ok: false, reason: "no GitHub credential configured (GitHub App or GH_TOKEN)" }) }), "repo onboard Acme/API", admin);
    expect(c.onboard).toHaveBeenCalledWith({
      resource: "repo:acme/api",
      commands: { install: "npm install --no-audit --no-fund", build: "npm run build --if-present", test: "npm test" },
      defaultRef: "main",
    });
    expect(text).toContain("🏗️ Onboarding `acme/api` on `main`");
    expect(text).toContain("⚠️ Repo root not inspected (no GitHub credential configured (GitHub App or GH_TOKEN)) — using npm defaults. If the repo is not an npm package, `repo reconfigure` the commands before it fails.");
    expect(text).toContain("Commands: install `npm install --no-audit --no-fund` · build `npm run build --if-present` · test `npm test`");
    const none = await say(bind({ admin: mockClient() }), "repo onboard acme/api", admin);
    expect(none.text).toContain("⚠️ Repo root not inspected (no repo inspector configured) — using npm defaults. If the repo is not an npm package, `repo reconfigure` the commands before it fails.");
  });

  it("item 52: the not-inspected warning names only the keys that actually took an npm default — none when every command was given explicitly", async () => {
    const uninspectable = async () => ({ ok: false as const, reason: "no GitHub credential configured (GitHub App or GH_TOKEN)" });
    const partial = await say(bind({ admin: mockClient(), inspect: uninspectable }), 'repo onboard acme/api --install "make deps"', admin);
    expect(partial.text).toContain("⚠️ Repo root not inspected (no GitHub credential configured (GitHub App or GH_TOKEN)) — using npm defaults for build and test. If the repo is not an npm package, `repo reconfigure` the commands before it fails.");
    const all = await say(bind({ admin: mockClient(), inspect: uninspectable }), 'repo onboard acme/api --install "make deps" --build "make" --test "make check"', admin);
    expect(all.text).toContain("⚠️ Repo root not inspected (no GitHub credential configured (GitHub App or GH_TOKEN)) — every command was given explicitly, so nothing was assumed.");
    expect(all.text).not.toContain("npm defaults");
  });

  it("item 52: an explicit `--build true` renders as the operator's own command, not as a detected no-op", async () => {
    const { text } = await say(bind({ admin: mockClient(), inspect: inspecting(PNPM_ROOT) }), 'repo onboard acme/api --build true --test "pnpm vitest run"', admin);
    expect(text).toContain("Commands: install `pnpm install --frozen-lockfile` · build `true` · test `pnpm vitest run`");
  });

  it("--ref and quoted --test/--build/--install override the defaults (the derived grammar, not key=value)", async () => {
    const c = mockClient();
    await say(bind({ admin: c }), 'repo onboard acme/api --ref develop --test "npm run test:unit" --build "make build" --install "pnpm install"', admin);
    expect(c.onboard).toHaveBeenCalledWith({ resource: "repo:acme/api", commands: { install: "pnpm install", build: "make build", test: "npm run test:unit" }, defaultRef: "develop" });
  });

  it("an invalid slug and a hostile ref are `invalid_input` naming the expectation, never the value; no client call", async () => {
    const c = mockClient();
    const commands = bind({ admin: c });
    const bad = await commands.invoke("repo.onboard", { args: ["not a slug"] }, admin);
    expect(bad).toMatchObject({ ok: false, error: "invalid_input", message: "slug: expected a GitHub owner/name slug" });
    const ref = await commands.invoke("repo.onboard", { args: ["acme/api"], options: { ref: "main;rm -rf /" } }, admin);
    expect(ref).toMatchObject({ ok: false, error: "invalid_input", message: "ref: expected a plausible git branch ref (e.g. main)" });
    expect(JSON.stringify(ref)).not.toContain("rm -rf");
    expect(await commands.invoke("repo.onboard", { args: ["acme/api"], options: { evictColdest: "yes" } }, admin)).toMatchObject({ ok: false, error: "invalid_input" });
    expect(c.onboard).not.toHaveBeenCalled();
  });

  it("a resident-side refusal (cap reached, 429) is `conflict` carrying the status and the resident's words", async () => {
    const commands = bind({ admin: mockClient({ onboard: ok({ error: "resident cap reached (8/8); offboard a resident first" }, 429) }) });
    expect(await commands.invoke("repo.onboard", { args: ["acme/api"] }, admin)).toMatchObject({ ok: false, error: "conflict", status: 409, message: "HTTP 429: resident cap reached (8/8); offboard a resident first" });
  });

  it("--evict-coldest opts the onboard into LRU eviction (#50); an evicting onboard says which resident went", async () => {
    const c = mockClient({
      onboard: ok({ resource: "repo:acme/api", state: "onboarding", evicted: { resource: "repo:jshttp/fresh", lastActivityAt: "2026-08-27T10:00:00.000Z", backupObjectsDeleted: 4, errors: [] } }, 202),
    });
    const { text } = await say(bind({ admin: c }), "repo onboard acme/api --evict-coldest --ref develop", admin);
    expect(c.onboard).toHaveBeenCalledWith(expect.objectContaining({ resource: "repo:acme/api", defaultRef: "develop", evictColdest: true }));
    expect(text).toMatch(/♻️ Made room: evicted `jshttp\/fresh`.*last used 2026-08-27T10:00:00.000Z/);
  });

  it("an over-cap onboard with no eligible resident relays the per-resident reasons", async () => {
    const commands = bind({
      admin: mockClient({
        onboard: ok(
          {
            error: "resident cap reached (8/8); evictColdest found no eligible resident",
            rejected: [
              { resource: "repo:a/hot", why: "active 12m ago (floor 60m)" },
              { resource: "repo:b/busy", why: "2 live worktree(s)" },
            ],
          },
          429,
        ),
      }),
    });
    const res = await commands.invoke("repo.onboard", { args: ["acme/api"], options: { evictColdest: true } }, admin);
    expect(res).toMatchObject({ ok: false, error: "conflict" });
    expect(res.ok ? "" : res.message).toContain("no eligible resident");
    expect(res.ok ? "" : res.message).toContain("• `a/hot` — active 12m ago (floor 60m)\n• `b/busy` — 2 live worktree(s)");
  });

  it("--evict-coldest is an onboard-only flag: reconfigure refuses it as an unknown option", () => {
    const commands = bind();
    expect(parseInvocation(commands.get("repo.reconfigure")!, ["acme/api", "--evict-coldest"])).toMatchObject({ kind: "invalid", code: "invalid_input", error: expect.stringContaining("unknown option --evict-coldest") });
  });

  it("an onboard warning field (App unconfigured) surfaces in the reply", async () => {
    const commands = bind({ admin: mockClient({ onboard: ok({ resource: "repo:acme/api", state: "onboarding", warning: "github-app-not-configured: installation membership was NOT verified" }, 202) }) });
    expect((await say(commands, "repo onboard acme/api", admin)).text).toContain("⚠️ github-app-not-configured");
  });
});

describe("repo offboard / rebuild (--dry-run)", () => {
  it("offboard --dry-run calls the client with dryRun and renders the itemized plan", async () => {
    const c = mockClient({
      offboard: ok({ resource: "repo:acme/api", dryRun: true, wouldRemove: { registryRecord: true, schedules: 2, snapshotBackupIds: ["m1", "c1"], backupObjects: 4, r2Objects: 0, threadBindings: 3, container: "warm" } }),
    });
    const { text } = await say(bind({ admin: c }), "repo offboard acme/api --dry-run", admin);
    expect(c.offboard).toHaveBeenCalledWith("repo:acme/api", true);
    expect(text).toContain("🧪 *Dry run* — offboarding `acme/api` would remove:");
    expect(text).toContain("• 4 snapshot backup object(s) in R2 (ids m1, c1)");
    expect(text).toContain("• 3 thread binding(s) and the container (currently `warm`)");
    expect(text).toContain("Nothing was changed. Run `repo offboard acme/api` to execute.");
  });

  it("real offboard calls with dryRun=false and renders the teardown result", async () => {
    const c = mockClient();
    const { text } = await say(bind({ admin: c }), "repo offboard acme/api", admin);
    expect(c.offboard).toHaveBeenCalledWith("repo:acme/api", false);
    expect(text).toBe("🗑️ Offboarded `acme/api`: registry removed true, schedules cancelled true, container stopped true, storage cleared true, 4 backup object(s) + 0 prefix object(s) deleted from R2.");
  });

  it("rebuild --dry-run renders discards + reprovision plan without executing; a real rebuild reports the transition", async () => {
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
    const dry = (await say(bind({ admin: c }), "repo rebuild acme/api --dry-run", admin)).text;
    expect(c.rebuild).toHaveBeenCalledWith("repo:acme/api", true);
    expect(dry).toContain("🧪 *Dry run* — rebuilding `acme/api` (currently `warm`) would:");
    expect(dry).toContain("• discard the snapshot from 2026-08-26T00:00:00Z (4 backup object(s); ids m1, c1)");
    expect(dry).toContain("• reprovision from scratch on `master` (budget 300000ms)");
    expect(dry).toContain("Nothing was changed. Run `repo rebuild acme/api` to execute.");
    const real = mockClient();
    const { text } = await say(bind({ admin: real }), "repo rebuild acme/api", admin);
    expect(real.rebuild).toHaveBeenCalledWith("repo:acme/api", false);
    expect(text).toBe(
      "🔄 Rebuilding `acme/api`: discarded 4 backup object(s); reprovisioning from scratch on `master` (state `onboarding` — I'll report here when it is warm or has failed; `repo list` shows the live state meanwhile).",
    );
  });

  it("an unknown flag is `invalid_input` naming the flag, never a resident call; a 404 from the resident is `not_found`", async () => {
    const c = mockClient({ rebuild: ok({ error: "unknown resource" }, 404) });
    const commands = bind({ admin: c });
    expect(parseInvocation(commands.get("repo.offboard")!, ["acme/api", "--force"])).toMatchObject({ kind: "invalid", code: "invalid_input", error: expect.stringContaining("unknown option --force") });
    expect(c.offboard).not.toHaveBeenCalled();
    expect(await commands.invoke("repo.rebuild", { args: ["acme/api"] }, admin)).toMatchObject({ ok: false, error: "not_found", message: "HTTP 404: unknown resource" });
  });
});

describe("provisioning follow-up (item 52): repo onboard / repo rebuild settle", () => {
  /** A /status that answers each call from the sequence (the last one repeats). */
  const statusSequence = (...states: Array<Record<string, unknown> | { httpStatus: number; error?: string } | Error>) => {
    let i = 0;
    return vi.fn(async () => {
      const s = states[Math.min(i++, states.length - 1)];
      if (s instanceof Error) throw s;
      if ("httpStatus" in s) return ok({ error: s.error ?? "boom" }, s.httpStatus as number);
      return ok(s);
    });
  };
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
  };

  it("onboard and non-dry rebuild settle; dry-run rebuild, list, offboard, reconfigure do not", () => {
    const commands = bind();
    expect(commands.settles("repo.onboard")).toBe(true);
    expect(commands.settles("repo.rebuild")).toBe(true);
    for (const id of ["repo.list", "repo.offboard", "repo.reconfigure", "repo.test", "repo.build"]) expect(commands.settles(id), id).toBe(false);
  });

  it("warm: polls /status every SETTLE_POLL_MS while `onboarding`, then reports warm as ok", async () => {
    slept.length = 0;
    const status = statusSequence({ state: "onboarding", reason: "", inFlight: 0 }, { state: "onboarding", reason: "", inFlight: 0 }, { state: "warm", reason: "", inFlight: 0 });
    const c = { ...mockClient(), status };
    const commands = bind({ admin: c, sleep, inspect: inspecting(PNPM_ROOT) });
    const res = await commands.invoke("repo.onboard", { args: ["acme/api"] }, admin);
    expect(res.ok).toBe(true);
    const out = await commands.settle("repo.onboard", (res as { value: unknown }).value as never, admin);
    expect(out).toEqual({ ok: true, text: "✅ `acme/api` is warm — provisioned and attach-ready." });
    expect(status).toHaveBeenCalledTimes(3);
    expect(status).toHaveBeenCalledWith("repo:acme/api");
    expect(slept).toEqual([SETTLE_POLL_MS, SETTLE_POLL_MS]);
  });

  it("down: reports the resident's own reason and names the two commands that fix a bad table", async () => {
    const reason = "provision-failed at install: exit 1: npm error code EOVERRIDE";
    const c = { ...mockClient(), status: statusSequence({ state: "down", reason, inFlight: 0 }) };
    const out = await settleProvisioning(depsOf({ admin: c, sleep }), "coreplanelabs/nominal");
    expect(out).toEqual({
      ok: false,
      text: `❌ \`coreplanelabs/nominal\` failed to provision: ${reason}\nFix the command table with \`repo reconfigure coreplanelabs/nominal --install "…" --build "…" --test "…"\`, then \`repo rebuild coreplanelabs/nominal\`.`,
    });
  });

  it("rebuild: a real rebuild settles like onboard; --dry-run has no follow-up", async () => {
    const c = { ...mockClient(), status: statusSequence({ state: "warm", reason: "", inFlight: 0 }) };
    const commands = bind({ admin: c, sleep });
    const real = await commands.invoke("repo.rebuild", { args: ["acme/api"] }, admin);
    expect(await commands.settle("repo.rebuild", (real as { value: unknown }).value as never, admin)).toEqual({ ok: true, text: "✅ `acme/api` is warm — provisioned and attach-ready." });
    const dry = await commands.invoke("repo.rebuild", { args: ["acme/api"], options: { dryRun: true } }, admin);
    expect(await commands.settle("repo.rebuild", (dry as { value: unknown }).value as never, admin)).toBeUndefined();
    expect(c.status).toHaveBeenCalledTimes(1);
  });

  it("every other outcome is a sentence: offboarded mid-provision (404), a non-200, a transport throw, another state, the admin client gone", async () => {
    const deps = (status: ReturnType<typeof statusSequence>) => depsOf({ admin: { ...mockClient(), status }, sleep });
    expect(await settleProvisioning(deps(statusSequence({ httpStatus: 404, error: "not onboarded" })), "acme/api")).toEqual({ ok: false, text: "⚠️ `acme/api` is no longer onboarded — it was offboarded while provisioning." });
    expect(await settleProvisioning(deps(statusSequence({ httpStatus: 500, error: "kaboom" })), "acme/api")).toEqual({ ok: false, text: "⚠️ Lost track of `acme/api`'s provisioning (HTTP 500: kaboom) — check `repo list`." });
    expect(await settleProvisioning(deps(statusSequence(new Error("resident admin /status request failed (fetch failed)"))), "acme/api")).toEqual({
      ok: false,
      text: "⚠️ Lost track of `acme/api`'s provisioning (resident admin /status request failed (fetch failed)) — check `repo list`.",
    });
    expect(await settleProvisioning(deps(statusSequence({ state: "degraded", reason: "alarm-missed", inFlight: 0 })), "acme/api")).toEqual({ ok: true, text: "ℹ️ `acme/api` left `onboarding` and is `degraded` (alarm-missed)." });
    expect(await settleProvisioning(depsOf({ admin: { unavailable: "Repo management needs the resident admin bearer — `RESIDENT_ADMIN_TOKEN` is not set." }, sleep }), "acme/api")).toEqual({
      ok: false,
      text: "⚠️ Cannot follow `acme/api`'s provisioning: Repo management needs the resident admin bearer — `RESIDENT_ADMIN_TOKEN` is not set.",
    });
  });

  it("still onboarding at SETTLE_MAX_MS: reports that, bounded — never a silent drop, never an unbounded poll", async () => {
    slept.length = 0;
    const status = statusSequence({ state: "onboarding", reason: "", inFlight: 0 });
    const out = await settleProvisioning(depsOf({ admin: { ...mockClient(), status }, sleep }), "acme/api");
    expect(out.ok).toBe(false);
    expect(out.text).toBe("⏳ `acme/api` is still onboarding after 12 min — provisioning is slow or stuck; `repo list` shows the live state, and the resident watchdog marks a stuck onboard `down` at its deadline.");
    expect(status).toHaveBeenCalledTimes(SETTLE_MAX_MS / SETTLE_POLL_MS + 1);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(SETTLE_MAX_MS);
  });
});

describe("repo reconfigure", () => {
  it("merges command overrides onto the current table (the resident replaces whole tables)", async () => {
    const c = mockClient({
      residents: ok({ cap: 8, count: 1, residents: [{ resource: "repo:acme/api", defaultRef: "main", commands: { test: "old-test", build: "old-build", install: "old-install" }, live: { state: "warm", reason: "" } }] }),
    });
    const { text } = await say(bind({ admin: c }), 'repo reconfigure acme/api --test "new-test"', admin);
    expect(c.reconfigure).toHaveBeenCalledWith({ resource: "repo:acme/api", commands: { test: "new-test", build: "old-build", install: "old-install" } });
    expect(text).toBe("🔧 Reconfigured `acme/api`: test → `new-test`. Takes effect on the next refresh/attach.");
  });

  it("a ref-only reconfigure sends defaultRef without reading or touching the command table", async () => {
    const c = mockClient();
    const { text } = await say(bind({ admin: c }), "repo reconfigure acme/api --ref develop", admin);
    expect(c.reconfigure).toHaveBeenCalledWith({ resource: "repo:acme/api", defaultRef: "develop" });
    expect(c.residents).not.toHaveBeenCalled();
    expect(text).toContain("ref → `develop`");
  });

  it("nothing to change is `invalid_input`; a repo that is not onboarded is `not_found` naming the onboard command", async () => {
    const c = mockClient({ residents: ok({ cap: 8, count: 0, residents: [] }) });
    const commands = bind({ admin: c });
    expect(await commands.invoke("repo.reconfigure", { args: ["acme/api"] }, admin)).toMatchObject({ ok: false, error: "invalid_input", message: expect.stringMatching(/nothing to reconfigure/) });
    expect(await commands.invoke("repo.reconfigure", { args: ["acme/api"], options: { test: "x" } }, admin)).toMatchObject({ ok: false, error: "not_found", message: "`acme/api` is not onboarded — `repo onboard acme/api` first." });
    expect(c.reconfigure).not.toHaveBeenCalled();
  });
});

describe("repo test / repo build (deterministic ops, U6/KTD8)", () => {
  const OK_RESULT: OperationResult = { kind: "result", ok: true, summary: "test passed on repo:acme/api @ main (abc12345) in 3s", output: "1 passing" };

  it("runs the named op with the slug + ref and renders ✅ summary + fenced output; a failing run is ❌, a result not an error", async () => {
    const { ops, calls } = fakeOps(OK_RESULT);
    const commands = bind({ ops });
    const { res, text } = await say(commands, "repo test acme/api main", admin);
    expect(calls).toEqual([{ op: "test", req: { repo: "acme/api", ref: "main" } }]);
    expect(res.ok && res.value).toEqual({ op: "test", repo: "acme/api", ref: "main", ok: true, summary: OK_RESULT.summary, output: "1 passing" });
    expect(text).toBe(`✅ ${OK_RESULT.summary}\n\`\`\`\n1 passing\n\`\`\``);
    const failing = bind({ ops: fakeOps({ kind: "result", ok: false, summary: "test failed (exit 1)", output: "1 failing" }).ops });
    expect((await say(failing, "repo build acme/api", admin)).text).toBe("❌ test failed (exit 1)\n```\n1 failing\n```");
  });

  it("the chat gate is `agentRun` (canRunAgent coding): a user without coding access is refused by the registry, the op never runs", async () => {
    const { ops, calls } = fakeOps(OK_RESULT);
    expect(await bind({ ops }).invoke("repo.test", { args: ["acme/api", "main"] }, chat("slack:UX"))).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "registry" });
    expect(calls).toHaveLength(0);
  });

  it("the per-repo allowlist (KD7) is the handler's refusal, naming the repo; the op never runs", async () => {
    const { ops, calls } = fakeOps(OK_RESULT);
    const res = await bind({ ops, canUseRepo: (_u, slug) => slug !== "acme/api" }).invoke("repo.test", { args: ["acme/api"] }, admin);
    expect(res).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "handler", message: "You're not on the allowlist for the `acme/api` repo environment." });
    expect(calls).toHaveLength(0);
  });

  it("a hostile ref is `invalid_input` naming the argument before any backend; a bad slug likewise", async () => {
    const { ops, calls } = fakeOps(OK_RESULT);
    const commands = bind({ ops });
    expect(await commands.invoke("repo.test", { args: ["acme/api", "main;rm"] }, admin)).toMatchObject({ ok: false, error: "invalid_input", message: "ref: expected a plausible git branch ref (e.g. main)" });
    expect(await commands.invoke("repo.build", { args: ["nope"] }, admin)).toMatchObject({ ok: false, error: "invalid_input", message: "slug: expected a GitHub owner/name slug" });
    expect(calls).toHaveLength(0);
  });

  it("no backend → `unavailable` naming the config; a policy refusal → `conflict` with the reason; not onboarded → `not_found` pointing at onboard; a backend error or throw → `unavailable`", async () => {
    expect(await bind({ ops: null }).invoke("repo.test", { args: ["acme/api"] }, admin)).toMatchObject({ ok: false, error: "unavailable", message: NO_OPS_BACKEND_MESSAGE });
    const refused = fakeOps({ kind: "refused", reason: 'op-refused: the "test" command-table entry is marked effects: mutating' }).ops;
    expect(await bind({ ops: refused }).invoke("repo.test", { args: ["acme/api"] }, admin)).toMatchObject({ ok: false, error: "conflict", message: expect.stringContaining("mutating") });
    const notOnboarded = fakeOps({ kind: "not-onboarded" }).ops;
    expect(await bind({ ops: notOnboarded }).invoke("repo.test", { args: ["acme/api"] }, admin)).toMatchObject({
      ok: false,
      error: "not_found",
      message: "`acme/api` is not onboarded as a resident, so `repo test` has nothing to run against — `repo onboard acme/api` first, or ask the coding agent directly.",
    });
    const errored = fakeOps({ kind: "error", message: "resident /op request failed (timeout)" }).ops;
    expect(await bind({ ops: errored }).invoke("repo.test", { args: ["acme/api"] }, admin)).toMatchObject({ ok: false, error: "unavailable", message: "resident /op request failed (timeout)" });
    const throwing = fakeOps(async () => {
      throw new Error("backend exploded");
    }).ops;
    expect(await bind({ ops: throwing }).invoke("repo.test", { args: ["acme/api"] }, admin)).toMatchObject({ ok: false, error: "unavailable", message: "backend exploded" });
  });

  it("output is clipped to its tail so the failure's last lines survive", async () => {
    const long = `${"x".repeat(4000)}\nTHE END`;
    const commands = bind({ ops: fakeOps({ kind: "result", ok: false, summary: "test failed", output: long }).ops });
    const { text } = await say(commands, "repo test acme/api", admin);
    expect(text).toContain("…");
    expect(text).toContain("THE END");
    expect(text.length).toBeLessThan(3200);
  });
});
