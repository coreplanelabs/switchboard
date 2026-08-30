import { describe, expect, it, vi } from "vitest";
import { CommandRegistry, bindCommands, renderText, type Caller, type CommandInvoker } from "../commandRegistry.js";
import type { ResidentAdminClient, ResidentAdminResponse } from "../repoCommands.js";
import { registerRepoCommands, repoList, type RepoCommandDeps } from "./repo.js";

// Feature: features/resident-repos.md (item 32) / features/command-registry.md
// (migration, R13/AE12): `repo.list` as a registry command — the live resident
// registry view, open in chat as ever, `repo:read` for machine callers; the
// JSON is the resident Worker's `/residents` body and the text is the exact
// pre-migration `repo list` reply (golden strings captured from the legacy
// handler before it was removed).

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

function client(residents: ResidentAdminResponse | (() => Promise<ResidentAdminResponse>) = ok(TWO_RESIDENTS)): ResidentAdminClient {
  const never = vi.fn(async () => ok({}, 500));
  return { onboard: never, offboard: never, reconfigure: never, rebuild: never, residents: vi.fn(typeof residents === "function" ? residents : async () => residents) };
}

function bind(admin: RepoCommandDeps["repo"]["admin"]): CommandInvoker {
  const registry = new CommandRegistry<RepoCommandDeps>({ audit: () => {} });
  registerRepoCommands(registry);
  return bindCommands(registry, { repo: { admin } });
}

const chat = (userId: string): Caller => ({ kind: "chat", id: userId, scopes: new Set(), chatGate: (gate) => gate === "open" });
const mcp = (...scopes: string[]): Caller => ({ kind: "mcp", id: "mcp:alice", scopes: new Set(scopes) });

const render = (commands: CommandInvoker, res: Awaited<ReturnType<CommandInvoker["invoke"]>>) => {
  if (!res.ok) throw new Error(res.message);
  return renderText(commands.get("repo.list")!, res.value);
};

describe("repo.list", () => {
  it("stays open to any chat caller, reads the live registry each call, and renders the exact pre-migration reply", async () => {
    const c = client();
    const commands = bind(() => c);
    const res = await commands.invoke("repo.list", {}, chat("slack:URANDOM"));
    expect(res.ok).toBe(true);
    expect(res.ok && res.value).toEqual(TWO_RESIDENTS);
    expect(render(commands, res)).toBe(
      "*Resident repos* (2/6):\n• `jshttp/vary` — *warm* · ref `master` · sha `01234567` · refreshed 2026-01-01T00:00:00.000Z\n• `acme/api` — *degraded* (alarm-missed) · ref `main`",
    );
    await commands.invoke("repo.list", {}, chat("slack:URANDOM"));
    expect(c.residents).toHaveBeenCalledTimes(2);
  });

  it("an empty registry and an active test override keep their wording", async () => {
    const empty = bind(() => client(ok({ cap: 6, count: 0, residents: [] })));
    expect(render(empty, await empty.invoke("repo.list", {}, chat("slack:U1")))).toBe("No repos onboarded (0/6). Onboard one with `repo onboard <owner/name>`.");

    const overridden = bind(() =>
      client(
        ok({
          cap: 2,
          capDefault: 6,
          testOverrides: { cap: 2, floorS: 600, floorDefaultS: 3600, setAt: "2026-08-29T23:00:00.000Z", build: "gc51" },
          count: 1,
          residents: [{ resource: "repo:acme/api", defaultRef: "main", live: { state: "warm" } }],
        }),
      ),
    );
    const reply = render(overridden, await overridden.invoke("repo.list", {}, chat("slack:U1")));
    expect(reply).toContain("(1/2)");
    expect(reply).toContain("⚠️ test overrides active (set 2026-08-29T23:00:00.000Z): cap 2 (default 6), LRU floor 600s (default 3600s)");
  });

  it("no resident configured, a non-200 route answer, and a transport failure are `unavailable` with the legacy text", async () => {
    const unconfigured = bind(() => ({ unavailable: "Resident repo environments aren't configured — set `execution.resident.baseUrl` in config.yaml." }));
    expect(await unconfigured.invoke("repo.list", {}, chat("slack:U1"))).toMatchObject({ ok: false, error: "unavailable", status: 503, message: expect.stringContaining("execution.resident") });

    const failing = bind(() => client(ok({ error: "registry unavailable" }, 503)));
    expect(await failing.invoke("repo.list", {}, chat("slack:U1"))).toMatchObject({ ok: false, error: "unavailable", message: "repo list failed (HTTP 503): registry unavailable" });

    const down = bind(() =>
      client(async () => {
        throw new Error("resident admin /residents request failed (fetch failed). The operation may still have run in the resident; check `repo list` before re-running it.");
      }),
    );
    expect(await down.invoke("repo.list", {}, chat("slack:U1"))).toMatchObject({ ok: false, error: "unavailable", message: expect.stringContaining("/residents request failed") });
  });

  it("machine callers need repo:read (AE12): dispatch-only and runs:read tokens are refused, repo:read passes", async () => {
    const commands = bind(() => client());
    expect(await commands.invoke("repo.list", {}, mcp("dispatch"))).toMatchObject({ ok: false, error: "unauthorized", status: 403 });
    expect(await commands.invoke("repo.list", {}, mcp("runs:read"))).toMatchObject({ ok: false, error: "unauthorized" });
    expect((await commands.invoke("repo.list", {}, mcp("repo:read"))).ok).toBe(true);
    expect(repoList).toMatchObject({ scope: "repo:read", chatGate: "open", effect: "read" });
  });
});
