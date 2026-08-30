import { describe, expect, it } from "vitest";
import { CommandRegistry, bindCommands, renderText, UNTRUSTED_OPEN, type Caller, type CommandInvoker } from "../commandRegistry.js";
import { InMemoryMemoryStore } from "../memory/stores.js";
import type { MemoryConfig, MemoryRecord, MemoryStore } from "../memory/types.js";
import { MEMORY_OFF_MESSAGE, registerMemoryCommands, scopeKeyOfMemoryId, type MemoryCommandDeps } from "./memory.js";

// Feature: features/memory.md §24–26 (#278, #293, #253) / features/command-registry.md
// (phase 4b): `memory list` / `memory forget` as registry commands — deterministic
// (no model turn), caller-scoped on every surface: a caller manages its OWN
// scope freely, the shared scopes (org, repo, channel) are admin-gated
// (fail-closed like repo management), and another user's scope is unreachable.

const NOW = 1_700_000_000_000;
function rec(over: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: "mem:org:coreplanelabs:0",
    scopeKey: "org:coreplanelabs",
    kind: "fact",
    text: "the deploy command is npm run deploy",
    keywords: ["deploy"],
    sourceThreadKey: "slack:C1:1.0",
    createdAt: NOW,
    useCount: 0,
    status: "active",
    ...over,
  };
}
// Built fresh per store: `forget` mutates records in place.
const ORG = () => rec({});
const MINE = () => rec({ id: "mem:user:slack:U1:0", scopeKey: "user:slack:U1", text: "this user likes TL;DR lines", keywords: ["tldr"] });
const THEIRS = () => rec({ id: "mem:user:slack:U2:0", scopeKey: "user:slack:U2", text: "that user likes bullet points" });
const REPO = () => rec({ id: "mem:repo:acme/api:0", scopeKey: "repo:acme/api", text: "tests need FOO=1", keywords: ["foo"] });
const CHAN = () => rec({ id: "mem:channel:slack:C1:0", scopeKey: "channel:slack:C1", text: "this channel is about billing", keywords: ["billing"] });

const ON: MemoryConfig = { enabled: true };
const seeded = () => new InMemoryMemoryStore([ORG(), MINE(), THEIRS(), REPO(), CHAN()], { now: () => NOW });

function bind(store: MemoryStore | undefined = seeded(), cfg: MemoryConfig | undefined | "on" = "on"): CommandInvoker {
  const registry = new CommandRegistry<MemoryCommandDeps>({ audit: () => {} });
  registerMemoryCommands(registry);
  return bindCommands(registry, { memory: { config: () => (cfg === "on" ? ON : cfg), store } });
}

/** A Slack person in channel C1; `admin` passes the repo-management gate; `repo` binds the thread's repo lazily. */
const chat = (userId: string, opts: { admin?: boolean; repo?: string; channelId?: string } = {}): Caller => ({
  kind: "chat",
  id: userId,
  scopes: new Set(),
  chatGate: (gate) => gate === "open" || (gate === "repoManager" && opts.admin === true),
  origin: { channelId: opts.channelId ?? "slack:C1", threadKey: "slack:C1:1.0", repo: async () => opts.repo },
});
const cli: Caller = { kind: "cli", id: "cli:local", scopes: "all" };
const mcp = (...scopes: string[]): Caller => ({ kind: "mcp", id: "mcp:alice", scopes: new Set(scopes) });

async function list(commands: CommandInvoker, caller: Caller, input: { args?: string[]; options?: Record<string, unknown> } = {}) {
  const res = await commands.invoke("memory.list", input, caller);
  if (!res.ok) throw new Error(`${res.error}: ${res.message}`);
  return { value: res.value as { scopes: Array<{ key: string; records: Array<{ id: string; text: string }> }>; missing?: string[] }, text: renderText(commands.get("memory.list")!, res.value) };
}

describe("memory.list", () => {
  it("memory disabled → `unavailable` with the legacy sentence, the store untouched", async () => {
    const store = seeded();
    store.list = async () => {
      throw new Error("must not be called");
    };
    expect(await bind(store, { enabled: false }).invoke("memory.list", {}, chat("slack:U1"))).toMatchObject({ ok: false, error: "unavailable", message: MEMORY_OFF_MESSAGE });
    expect(await bind(store, {} as MemoryConfig).invoke("memory.forget", { args: ["mem:user:slack:U1:0"] }, chat("slack:U1"))).toMatchObject({ ok: false, error: "unavailable" });
  });

  it("shows the caller's own scope, this repo's, this channel's, and the org scope with ids — never another user's", async () => {
    const { value, text } = await list(bind(), chat("slack:U1", { repo: "acme/api" }));
    expect(value.scopes.map((s) => s.key)).toEqual(["user:slack:U1", "repo:acme/api", "channel:slack:C1", "org:coreplanelabs"]);
    expect(text).toContain("*your records* (`user:slack:U1`)\n• `mem:user:slack:U1:0` [fact, 2023-11-14] this user likes TL;DR lines (source: `slack:C1:1.0`)");
    expect(text).toContain("*this repo's records* (`repo:acme/api`)");
    expect(text).toContain("*this channel's records* (`channel:slack:C1`)");
    expect(text).toContain("*shared org records* (`org:coreplanelabs`)\n• `mem:org:coreplanelabs:0`");
    expect(text).not.toContain("U2");
    expect(text).not.toContain("bullet points");
  });

  it("--scope narrows to one scope; an empty scope says so; the repo scope is skipped silently under `all` and named under `--scope repo`", async () => {
    const commands = bind();
    expect((await list(commands, chat("slack:U1"), { options: { scope: "me" } })).text).toBe("*your records* (`user:slack:U1`)\n• `mem:user:slack:U1:0` [fact, 2023-11-14] this user likes TL;DR lines (source: `slack:C1:1.0`)");
    expect((await list(commands, chat("slack:U1"), { options: { scope: "org" } })).text).toMatch(/^\*shared org records\*/);
    expect((await list(commands, chat("slack:U1", { channelId: "slack:C9" }), { options: { scope: "channel" } })).text).toBe("*this channel's records* (`channel:slack:C9`): no active records.");
    const all = await list(commands, chat("slack:U1"));
    expect(all.value.scopes.map((s) => s.key)).toEqual(["user:slack:U1", "channel:slack:C1", "org:coreplanelabs"]);
    expect(all.value.missing).toBeUndefined();
    const repo = await list(commands, chat("slack:U1"), { options: { scope: "repo" } });
    expect(repo.value.scopes).toEqual([]);
    expect(repo.text).toBe("*this repo's records*: no repo is bound here — name one (`--repo owner/name`, or ask in a repo thread).");
    expect((await list(commands, chat("slack:U1"), { options: { scope: "repo", repo: "acme/api" } })).value.scopes.map((s) => s.key)).toEqual(["repo:acme/api"]);
    expect(await commands.invoke("memory.list", { options: { scope: "everyone" } }, chat("slack:U1"))).toMatchObject({ ok: false, error: "invalid_input", message: 'scope: expected one of "me", "org", "repo", "channel", "all"' });
  });

  it("a query filters every listed scope and --limit is passed through and capped; a full page says there may be more", async () => {
    const store = seeded();
    const seen: Array<[string, number, string | undefined]> = [];
    const inner = store.list.bind(store);
    store.list = async (key, limit, query) => {
      seen.push([key, limit, query]);
      return inner(key, limit, query);
    };
    const commands = bind(store);
    const { text } = await list(commands, chat("slack:U1"), { args: ["deploy"], options: { limit: "1" } });
    expect(seen).toEqual([
      ["user:slack:U1", 1, "deploy"],
      ["channel:slack:C1", 1, "deploy"],
      ["org:coreplanelabs", 1, "deploy"],
    ]);
    expect(text).toContain("*shared org records* (`org:coreplanelabs`) matching `deploy`\n• `mem:org:coreplanelabs:0`");
    expect(text).toContain("_(limit 1 reached — there may be more; narrow with words or raise `--limit`, max 50)_");
    expect(text).toContain("*your records* (`user:slack:U1`) matching `deploy`: no active records.");
    expect(await commands.invoke("memory.list", { options: { limit: "51" } }, chat("slack:U1"))).toMatchObject({ ok: false, error: "invalid_input", message: "limit: expected number <= 50" });
    expect(await commands.invoke("memory.list", { options: { limit: "0" } }, chat("slack:U1"))).toMatchObject({ ok: false, error: "invalid_input" });
  });

  it("machine surfaces are caller-scoped too (`user:mcp:alice`, `user:cli:local`) and receive record text wrapped as untrusted; a `memory:read` scope is required", async () => {
    const store = seeded();
    await store.write("user:mcp:alice", [{ kind: "fact", text: "alice's own note", keywords: ["alice"], sourceThreadKey: "mcp:alice:1" }]);
    const commands = bind(store);
    expect(await commands.invoke("memory.list", {}, mcp("dispatch"))).toMatchObject({ ok: false, error: "unauthorized" });
    const { value } = await list(commands, mcp("memory:read"));
    expect(value.scopes.map((s) => s.key)).toEqual(["user:mcp:alice", "org:coreplanelabs"]);
    for (const s of value.scopes) for (const r of s.records) expect(r.text).toContain(UNTRUSTED_OPEN);
    expect(JSON.stringify(value)).not.toContain("U1:0");
    const fromCli = await list(commands, cli);
    expect(fromCli.value.scopes.map((s) => s.key)).toEqual(["user:cli:local", "org:coreplanelabs"]);
  });

  it("a store failure is `unavailable` with its message, never a 500", async () => {
    const store = seeded();
    store.list = async () => {
      throw new Error("memory worker 503");
    };
    expect(await bind(store).invoke("memory.list", {}, chat("slack:U1"))).toMatchObject({ ok: false, error: "unavailable", message: "memory worker 503" });
  });
});

describe("memory.forget", () => {
  it("a user can forget a record in their OWN scope; the reply and the JSON name the id and scope", async () => {
    const store = seeded();
    const commands = bind(store);
    const res = await commands.invoke("memory.forget", { args: ["mem:user:slack:U1:0"] }, chat("slack:U1"));
    expect(res).toMatchObject({ ok: true, value: { id: "mem:user:slack:U1:0", scope: "user:slack:U1", forgotten: true } });
    expect(renderText(commands.get("memory.forget")!, res.ok ? res.value : null)).toBe("🧹 Forgot `mem:user:slack:U1:0` (`user:slack:U1`). It no longer influences any run; the row is kept for provenance.");
    expect(await store.list("user:slack:U1", 10)).toEqual([]);
  });

  it("forgetting a SHARED record (org, repo, channel) is admin-gated (fail-closed): refused with a reason for a plain user, allowed for an admin and for the CLI", async () => {
    for (const id of ["mem:org:coreplanelabs:0", "mem:repo:acme/api:0", "mem:channel:slack:C1:0"]) {
      const store = seeded();
      const commands = bind(store);
      const refused = await commands.invoke("memory.forget", { args: [id] }, chat("slack:U1"));
      expect(refused, id).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "handler", message: expect.stringContaining("repo-management rights") });
      expect(await store.list(scopeKeyOfMemoryId(id)!, 10), id).toHaveLength(1);
      expect((await commands.invoke("memory.forget", { args: [id] }, chat("slack:UADMIN", { admin: true }))).ok, id).toBe(true);
    }
    const store = seeded();
    expect((await bind(store).invoke("memory.forget", { args: ["mem:org:coreplanelabs:0"] }, cli)).ok).toBe(true);
  });

  it("another user's scope is unreachable — even for an admin, even with memory:write", async () => {
    const commands = bind();
    for (const caller of [chat("slack:U1"), chat("slack:UADMIN", { admin: true }), mcp("memory:write")]) {
      const res = await commands.invoke("memory.forget", { args: ["mem:user:slack:U2:0"] }, caller);
      expect(res, caller.id).toMatchObject({ ok: false, error: "unauthorized", message: expect.stringContaining("another user's scope") });
    }
  });

  it("an id that is not a memory id is `invalid_input` naming the format; one that names nothing active is `not_found`; nothing is changed", async () => {
    const commands = bind();
    expect(await commands.invoke("memory.forget", { args: ["nope"] }, chat("slack:U1"))).toMatchObject({ ok: false, error: "invalid_input", message: "id: expected a memory id like mem:<scope>:<n> (see `memory list`)" });
    expect(await commands.invoke("memory.forget", { args: ["mem:user:slack:U1:99"] }, chat("slack:U1"))).toMatchObject({ ok: false, error: "not_found", message: "Nothing to forget: no active record `mem:user:slack:U1:99` in `user:slack:U1`." });
  });

  it("machine callers need memory:write; a store failure is `unavailable`", async () => {
    const store = seeded();
    expect(await bind(store).invoke("memory.forget", { args: ["mem:user:mcp:alice:0"] }, mcp("memory:read"))).toMatchObject({ ok: false, error: "unauthorized" });
    store.forget = async () => {
      throw new Error("memory worker down");
    };
    expect(await bind(store).invoke("memory.forget", { args: ["mem:user:slack:U1:0"] }, chat("slack:U1"))).toMatchObject({ ok: false, error: "unavailable", message: "memory worker down" });
  });
});
