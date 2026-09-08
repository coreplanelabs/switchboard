import { describe, expect, it } from "vitest";
import {
  CommandRegistry,
  bindCommands,
  renderText,
  UNTRUSTED_OPEN,
  type Caller,
  type CommandInvoker,
} from "../commandRegistry.js";
import { callerWith } from "../testing/callers.js";
import { InMemoryMemoryStore } from "../memory/stores.js";
import type { MemoryConfig, MemoryRecord, MemoryStore } from "../memory/types.js";
import { MEMORY_OFF_MESSAGE, registerMemoryCommands, scopeKeyOfMemoryId, type MemoryCommandDeps } from "./memory.js";

// Feature: docs/reference/specs/memory.md §24–26 / docs/reference/specs/command-registry.md
// (phase 4b): `memory list` / `memory forget` as registry commands — deterministic
// (no model turn), caller-scoped on every surface: a caller manages its OWN
// scope freely, the shared scopes (org, repo, channel) are admin-gated
// (fail-closed like repo management), and another user's scope is unreachable.

const NOW = Date.UTC(2023, 10, 14);
/** The day `renderRecord` prints for a record created at NOW. */
const NOW_DAY = new Date(NOW).toISOString().slice(0, 10);
function rec(over: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: "mem:org:acme:0",
    scopeKey: "org:acme",
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
const MINE = () =>
  rec({
    id: "mem:user:slack:UALICE:0",
    scopeKey: "user:slack:UALICE",
    text: "this user likes TL;DR lines",
    keywords: ["tldr"],
  });
const THEIRS = () =>
  rec({ id: "mem:user:slack:UBOB:0", scopeKey: "user:slack:UBOB", text: "that user likes bullet points" });
const REPO = () =>
  rec({ id: "mem:repo:acme/api:0", scopeKey: "repo:acme/api", text: "tests need FOO=1", keywords: ["foo"] });
const CHAN = () =>
  rec({
    id: "mem:channel:slack:C1:0",
    scopeKey: "channel:slack:C1",
    text: "this channel is about billing",
    keywords: ["billing"],
  });

const ON: MemoryConfig = { enabled: true };
const seeded = () => new InMemoryMemoryStore([ORG(), MINE(), THEIRS(), REPO(), CHAN()], { now: () => NOW });

function bind(store: MemoryStore | undefined = seeded(), cfg: MemoryConfig | undefined | "on" = "on"): CommandInvoker {
  const registry = new CommandRegistry<MemoryCommandDeps>({ audit: () => {} });
  registerMemoryCommands(registry);
  return bindCommands(registry, {
    memory: { config: async () => (cfg === "on" ? ON : cfg), organization: async () => "acme", store },
  });
}

/** A Slack person in channel C1; `admin` passes the repo-management gate; `repo` binds the thread's repo lazily. */
const chat = (userId: string, opts: { admin?: boolean; repo?: string; channelId?: string } = {}): Caller =>
  callerWith("chat", userId, opts.admin ? "all" : { actions: new Set(["memory:read", "memory:write"]) }, {
    origin: { channelId: opts.channelId ?? "slack:C1", threadKey: "slack:C1:1.0", repo: async () => opts.repo },
  });
const cli: Caller = callerWith("cli", "cli:local", "all");
const mcp = (...actions: string[]): Caller => callerWith("mcp", "mcp:alice", actions);

async function list(
  commands: CommandInvoker,
  caller: Caller,
  input: { args?: string[]; options?: Record<string, unknown> } = {},
) {
  const res = await commands.invoke("memory.list", input, caller);
  if (!res.ok) throw new Error(`${res.error}: ${res.message}`);
  return {
    value: res.value as {
      scopes: Array<{ key: string; records: Array<{ id: string; text: string }> }>;
      missing?: string[];
    },
    text: renderText(commands.get("memory.list")!, res.value),
  };
}

describe("memory.list", () => {
  it("memory disabled → `unavailable` with the legacy sentence, the store untouched", async () => {
    const store = seeded();
    store.list = async () => {
      throw new Error("must not be called");
    };
    expect(await bind(store, { enabled: false }).invoke("memory.list", {}, chat("slack:UALICE"))).toMatchObject({
      ok: false,
      error: "unavailable",
      message: MEMORY_OFF_MESSAGE,
    });
    expect(
      await bind(store, {} as MemoryConfig).invoke(
        "memory.forget",
        { args: ["mem:user:slack:UALICE:0"] },
        chat("slack:UALICE"),
      ),
    ).toMatchObject({ ok: false, error: "unavailable" });
  });

  it("shows the caller's own scope, this repo's, this channel's, and the org scope with ids — never another user's", async () => {
    const { value, text } = await list(bind(), chat("slack:UALICE", { repo: "acme/api" }));
    expect(value.scopes.map((s) => s.key)).toEqual([
      "user:slack:UALICE",
      "repo:acme/api",
      "channel:slack:C1",
      "org:acme",
    ]);
    expect(text).toContain(
      `*your records* (\`user:slack:UALICE\`)\n• \`mem:user:slack:UALICE:0\` [fact, ${NOW_DAY}] this user likes TL;DR lines (source: \`slack:C1:1.0\`)`,
    );
    expect(text).toContain("*this repo's records* (`repo:acme/api`)");
    expect(text).toContain("*this channel's records* (`channel:slack:C1`)");
    expect(text).toContain("*shared org records* (`org:acme`)\n• `mem:org:acme:0`");
    expect(text).not.toContain("UBOB");
    expect(text).not.toContain("bullet points");
  });

  it("--scope narrows to one scope; an empty scope says so; the repo scope is skipped silently under `all` and named under `--scope repo`", async () => {
    const commands = bind();
    expect((await list(commands, chat("slack:UALICE"), { options: { scope: "me" } })).text).toBe(
      `*your records* (\`user:slack:UALICE\`)\n• \`mem:user:slack:UALICE:0\` [fact, ${NOW_DAY}] this user likes TL;DR lines (source: \`slack:C1:1.0\`)`,
    );
    expect((await list(commands, chat("slack:UALICE"), { options: { scope: "org" } })).text).toMatch(
      /^\*shared org records\*/,
    );
    expect(
      (await list(commands, chat("slack:UALICE", { channelId: "slack:C9" }), { options: { scope: "channel" } })).text,
    ).toBe("*this channel's records* (`channel:slack:C9`): no active records.");
    const all = await list(commands, chat("slack:UALICE"));
    expect(all.value.scopes.map((s) => s.key)).toEqual(["user:slack:UALICE", "channel:slack:C1", "org:acme"]);
    expect(all.value.missing).toBeUndefined();
    const repo = await list(commands, chat("slack:UALICE"), { options: { scope: "repo" } });
    expect(repo.value.scopes).toEqual([]);
    expect(repo.text).toBe(
      "*this repo's records*: no repo is bound here — name one (`--repo owner/name`, or ask in a repo thread).",
    );
    expect(
      (await list(commands, chat("slack:UALICE"), { options: { scope: "repo", repo: "acme/api" } })).value.scopes.map(
        (s) => s.key,
      ),
    ).toEqual(["repo:acme/api"]);
    expect(
      await commands.invoke("memory.list", { options: { scope: "everyone" } }, chat("slack:UALICE")),
    ).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: 'scope: expected one of "me", "org", "repo", "channel", "all"',
    });
  });

  // `memory list org deploy` — the documented "scope word first" chat
  // syntax. A leading bare scope word is consumed as --scope when --scope is
  // absent; with --scope given it stays an ordinary filter word.
  it("consumes a leading bare scope word from the query when --scope is absent", async () => {
    const commands = bind();
    const narrowed = await list(commands, chat("slack:UALICE"), { args: ["org deploy"] });
    expect(narrowed.value.scopes.map((s) => s.key)).toEqual(["org:acme"]);
    expect(narrowed.text).toContain("matching `deploy`");
    expect(narrowed.text).not.toContain("matching `org deploy`");
    const alone = await list(commands, chat("slack:UALICE"), { args: ["me"] });
    expect(alone.value.scopes.map((s) => s.key)).toEqual(["user:slack:UALICE"]);
    expect(alone.text).not.toContain("matching");
    const explicitAll = await list(commands, chat("slack:UALICE"), { args: ["all"] });
    expect(explicitAll.value.scopes.map((s) => s.key)).toEqual(["user:slack:UALICE", "channel:slack:C1", "org:acme"]);
  });

  it("a leading scope word stays a filter word when --scope IS given; a non-scope first word is never consumed", async () => {
    const commands = bind();
    const kept = await list(commands, chat("slack:UALICE"), { args: ["org deploy"], options: { scope: "all" } });
    expect(kept.value.scopes.map((s) => s.key)).toEqual(["user:slack:UALICE", "channel:slack:C1", "org:acme"]);
    expect(kept.text).toContain("matching `org deploy`");
    const plain = await list(commands, chat("slack:UALICE"), { args: ["deploy"] });
    expect(plain.value.scopes.map((s) => s.key)).toEqual(["user:slack:UALICE", "channel:slack:C1", "org:acme"]);
    expect(plain.text).toContain("matching `deploy`");
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
    const { text } = await list(commands, chat("slack:UALICE"), { args: ["deploy"], options: { limit: "1" } });
    expect(seen).toEqual([
      ["user:slack:UALICE", 1, "deploy"],
      ["channel:slack:C1", 1, "deploy"],
      ["org:acme", 1, "deploy"],
    ]);
    expect(text).toContain("*shared org records* (`org:acme`) matching `deploy`\n• `mem:org:acme:0`");
    expect(text).toContain("_(limit 1 reached — there may be more; narrow with words or raise `--limit`, max 50)_");
    expect(text).toContain("*your records* (`user:slack:UALICE`) matching `deploy`: no active records.");
    expect(await commands.invoke("memory.list", { options: { limit: "51" } }, chat("slack:UALICE"))).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: "limit: expected number <= 50",
    });
    expect(await commands.invoke("memory.list", { options: { limit: "0" } }, chat("slack:UALICE"))).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
  });

  it("machine surfaces are caller-scoped too (`user:mcp:alice`, `user:cli:local`) and receive record text wrapped as untrusted; a `memory:read` scope is required", async () => {
    const store = seeded();
    await store.write("user:mcp:alice", [
      { kind: "fact", text: "alice's own note", keywords: ["alice"], sourceThreadKey: "mcp:alice:1" },
    ]);
    const commands = bind(store);
    expect(await commands.invoke("memory.list", {}, mcp("dispatch"))).toMatchObject({
      ok: false,
      error: "unauthorized",
    });
    const { value } = await list(commands, mcp("memory:read"));
    expect(value.scopes.map((s) => s.key)).toEqual(["user:mcp:alice", "org:acme"]);
    for (const s of value.scopes) for (const r of s.records) expect(r.text).toContain(UNTRUSTED_OPEN);
    expect(JSON.stringify(value)).not.toMatch(/U(ALICE|BOB):0/);
    const fromCli = await list(commands, cli);
    expect(fromCli.value.scopes.map((s) => s.key)).toEqual(["user:cli:local", "org:acme"]);
  });

  it("a store failure is `unavailable` with its message, never a 500", async () => {
    const store = seeded();
    store.list = async () => {
      throw new Error("memory worker 503");
    };
    expect(await bind(store).invoke("memory.list", {}, chat("slack:UALICE"))).toMatchObject({
      ok: false,
      error: "unavailable",
      message: "memory worker 503",
    });
  });
});

describe("memory.forget", () => {
  it("a user can forget a record in their OWN scope; the reply and the JSON name the id and scope", async () => {
    const store = seeded();
    const commands = bind(store);
    const res = await commands.invoke("memory.forget", { args: ["mem:user:slack:UALICE:0"] }, chat("slack:UALICE"));
    expect(res).toMatchObject({
      ok: true,
      value: { id: "mem:user:slack:UALICE:0", scope: "user:slack:UALICE", forgotten: true },
    });
    expect(renderText(commands.get("memory.forget")!, res.ok ? res.value : null)).toBe(
      "🧹 Forgot `mem:user:slack:UALICE:0` (`user:slack:UALICE`). It no longer influences any run; the row is kept for provenance.",
    );
    expect(await store.list("user:slack:UALICE", 10)).toEqual([]);
  });

  it("forgetting a SHARED record (org, repo, channel) is admin-gated (fail-closed): refused with a reason for a plain user, allowed for an admin and for the CLI", async () => {
    for (const id of ["mem:org:acme:0", "mem:repo:acme/api:0", "mem:channel:slack:C1:0"]) {
      const store = seeded();
      const commands = bind(store);
      const refused = await commands.invoke("memory.forget", { args: [id] }, chat("slack:UALICE"));
      expect(refused, id).toMatchObject({
        ok: false,
        error: "unauthorized",
        decidedBy: "handler",
        message: expect.stringContaining("repo-management rights"),
      });
      expect(await store.list(scopeKeyOfMemoryId(id)!, 10), id).toHaveLength(1);
      expect(
        (await commands.invoke("memory.forget", { args: [id] }, chat("slack:UADMIN", { admin: true }))).ok,
        id,
      ).toBe(true);
    }
    const store = seeded();
    expect((await bind(store).invoke("memory.forget", { args: ["mem:org:acme:0"] }, cli)).ok).toBe(true);
  });

  it("another user's scope is unreachable — even for an admin, even with memory:write", async () => {
    const commands = bind();
    for (const caller of [chat("slack:UALICE"), chat("slack:UADMIN", { admin: true }), mcp("memory:write")]) {
      const res = await commands.invoke("memory.forget", { args: ["mem:user:slack:UBOB:0"] }, caller);
      expect(res, caller.id).toMatchObject({
        ok: false,
        error: "unauthorized",
        message: expect.stringContaining("another user's scope"),
      });
    }
  });

  it("an id that is not a memory id is `invalid_input` naming the format; one that names nothing active is `not_found`; nothing is changed", async () => {
    const commands = bind();
    expect(await commands.invoke("memory.forget", { args: ["nope"] }, chat("slack:UALICE"))).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: "id: expected a memory id like mem:<scope>:<n> (see `memory list`)",
    });
    expect(
      await commands.invoke("memory.forget", { args: ["mem:user:slack:UALICE:99"] }, chat("slack:UALICE")),
    ).toMatchObject({
      ok: false,
      error: "not_found",
      message: "Nothing to forget: no active record `mem:user:slack:UALICE:99` in `user:slack:UALICE`.",
    });
  });

  it("machine callers need memory:write; a store failure is `unavailable`", async () => {
    const store = seeded();
    expect(
      await bind(store).invoke("memory.forget", { args: ["mem:user:mcp:alice:0"] }, mcp("memory:read")),
    ).toMatchObject({ ok: false, error: "unauthorized" });
    store.forget = async () => {
      throw new Error("memory worker down");
    };
    expect(
      await bind(store).invoke("memory.forget", { args: ["mem:user:slack:UALICE:0"] }, chat("slack:UALICE")),
    ).toMatchObject({ ok: false, error: "unavailable", message: "memory worker down" });
  });
});
