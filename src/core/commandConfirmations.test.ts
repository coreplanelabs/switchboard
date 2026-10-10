import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CommandRegistry, type Caller } from "./commandRegistry.js";
import { CLI_ACTOR, resolveActor } from "./authz/actor.js";
import { ALL_GRANTS } from "./authz/grants.js";
import { NO_GRANTS } from "./authz/types.js";
import { InMemoryConfirmationStore } from "./confirmations.js";
import { withCommandConfirmation, withConsumedCommand } from "./commandConfirmations.js";

// Feature: docs/reference/specs/command-registry.md — one approval gate before every handler.
describe("shared command confirmation gate", () => {
  function fixture(kind: Caller["kind"] = "mcp") {
    const remaining = new Set(["acme/api", "acme/other"]);
    const commands = new CommandRegistry({ audit: () => {}, confirmationClass: () => "destructive" });
    commands.register({
      id: "repo.offboard",
      action: "repo:write",
      effect: "write",
      args: [{ name: "repo", schema: z.string(), describe: "Repository" }],
      annotations: { destructive: true, confirmation: "always" },
      describe: "Remove a repository",
      handler: async ({ args }) => {
        remaining.delete(args.repo as string);
        return { remaining: [...remaining] };
      },
    });
    const caller: Caller = {
      kind,
      id: `${kind}:one`,
      actor: kind === "cli" ? CLI_ACTOR : { kind: "service", id: `${kind}:one`, grants: ALL_GRANTS },
    };
    const message = {
      userId: caller.actor.id,
      channelId: `${kind}:ops`,
      threadKey: `${kind}:ops:one`,
      text: "Remove acme/api",
    };
    const store = new InMemoryConfirmationStore();
    const context = { message, store, io: { offer: async () => "Approve the saved action; nothing ran." } };
    const invoke = (repo = "acme/api") => commands.invoke("repo.offboard", { args: [repo] }, caller, {});
    return { commands, caller, context, store, remaining: () => [...remaining], invoke };
  }
  for (const kind of ["chat", "mcp", "access", "cli"] as const) {
    it(`${kind} reaches the same required-confirmation gate and executes the exact consumed action once`, async () => {
      const f = fixture(kind);
      const offered = await withCommandConfirmation(f.context, () => f.invoke());
      expect(offered).toMatchObject({ ok: false, error: "conflict", confirmation: { line: "repo offboard acme/api" } });
      expect(f.remaining()).toEqual(["acme/api", "acme/other"]);
      if (offered.ok || !offered.confirmation) throw new Error("Expected an offer");
      const consumed = await f.store.consume(offered.confirmation.id, [f.caller.actor.id]);
      if (!consumed.ok || consumed.row.kind !== "run") throw new Error("Expected consumption");
      await withConsumedCommand(consumed.row, async () => {
        expect(await f.invoke()).toEqual({ ok: true, value: { remaining: ["acme/other"] } });
        expect(await f.invoke()).toMatchObject({ ok: false, error: "unauthorized" });
      });
      expect(f.remaining()).toEqual(["acme/other"]);
      expect(await f.store.consume(offered.confirmation.id, [f.caller.actor.id])).toEqual({
        ok: false,
        refused: "used",
      });
    });
  }
  it("HTTP cron consent is limited to declared schedule actions and never grants permission", async () => {
    const commands = new CommandRegistry();
    const filed: string[] = [];
    for (const [id, action] of [
      ["friction.propose", "friction:write"],
      ["repo.remove", "repo:write"],
      ["friction.confirm", "friction:write"],
    ] as const) {
      commands.register({
        id: id!,
        action: action!,
        effect: "write",
        describe: "Write",
        annotations: { destructive: true, ...(id === "friction.confirm" ? { confirmation: "always" as const } : {}) },
        handler: async () => {
          filed.push(id!);
          return { saved: id };
        },
      });
    }
    const actor = resolveActor({ surface: "http", subjectId: "cron" }, () => ALL_GRANTS);
    const caller: Caller = { kind: "chat", id: actor.id, actor };
    expect(await commands.invoke("friction.propose", {}, caller, {})).toEqual({
      ok: true,
      value: { saved: "friction.propose" },
    });
    expect(await commands.invoke("repo.remove", {}, caller, {})).toMatchObject({ ok: false, error: "unavailable" });
    const other = resolveActor({ surface: "http", subjectId: "other" }, () => ALL_GRANTS);
    expect(await commands.invoke("friction.propose", {}, { ...caller, id: other.id, actor: other }, {})).toMatchObject({
      ok: false,
      error: "unavailable",
    });
    const revoked = resolveActor({ surface: "http", subjectId: "cron" }, () => NO_GRANTS);
    expect(await commands.invoke("friction.propose", {}, { ...caller, actor: revoked }, {})).toMatchObject({
      ok: false,
      error: "unauthorized",
    });
    expect(filed).toEqual(["friction.propose"]);
    expect(await commands.invoke("friction.confirm", {}, caller, {})).toMatchObject({
      ok: false,
      error: "unavailable",
    });
    expect(filed).toEqual(["friction.propose"]);
  });

  it("missing display support cannot execute, and caller-supplied confirm arguments cannot create consent", async () => {
    const f = fixture();
    expect(await f.invoke()).toMatchObject({ ok: false, error: "unavailable" });
    expect(
      await f.commands.invoke("repo.offboard", { args: ["acme/api"], options: { confirm: true } }, f.caller, {}),
    ).toMatchObject({ ok: false, error: "invalid_input" });
    expect(f.remaining()).toEqual(["acme/api", "acme/other"]);
  });
  it("a consumed approval cannot change its target, arguments or identity", async () => {
    const f = fixture();
    const offered = await withCommandConfirmation(f.context, () => f.invoke());
    if (offered.ok || !offered.confirmation) throw new Error("Expected an offer");
    const consumed = await f.store.consume(offered.confirmation.id, [f.caller.actor.id]);
    if (!consumed.ok || consumed.row.kind !== "run") throw new Error("Expected consumption");
    expect(await withConsumedCommand(consumed.row, () => f.invoke("acme/other"))).toMatchObject({
      ok: false,
      error: "unauthorized",
    });
    const other = { ...f.caller, id: "mcp:other", actor: { ...f.caller.actor, id: "mcp:other" } };
    expect(
      await withConsumedCommand(consumed.row, () =>
        f.commands.invoke("repo.offboard", { args: ["acme/api"] }, other, {}),
      ),
    ).toMatchObject({ ok: false, error: "unauthorized" });
    expect(f.remaining()).toEqual(["acme/api", "acme/other"]);
  });
  it("a declined role cannot use a consumed approval, even if it had standing operator consent", async () => {
    const f = fixture();
    const offered = await withCommandConfirmation(f.context, () => f.invoke());
    if (offered.ok || !offered.confirmation) throw new Error("Expected an offer");
    const consumed = await f.store.consume(offered.confirmation.id, [f.caller.actor.id]);
    if (!consumed.ok || consumed.row.kind !== "run") throw new Error("Expected consumption");
    f.caller.actor = { ...f.caller.actor, grants: NO_GRANTS, standingConsent: "all" };
    expect(await withConsumedCommand(consumed.row, () => f.invoke())).toMatchObject({
      ok: false,
      error: "unauthorized",
    });
    expect(f.remaining()).toEqual(["acme/api", "acme/other"]);
  });
  it("approval freezes repository context even when the conversation default changes", async () => {
    let repo = "acme/api";
    const visited: string[] = [];
    const commands = new CommandRegistry({ audit: () => {} });
    commands.register({
      id: "memory.forget",
      action: "memory:write",
      effect: "write",
      describe: "Forget repository memory",
      annotations: { destructive: true, confirmation: "always" },
      handler: async ({ caller }) => {
        visited.push((await caller.origin?.repo?.()) ?? "none");
        return { forgotten: true };
      },
    });
    const caller: Caller = {
      kind: "chat",
      id: "slack:one",
      actor: { kind: "user", id: "slack:one", grants: ALL_GRANTS },
      origin: { channelId: "slack:ops", threadKey: "slack:ops:one", repo: async () => repo },
    };
    const store = new InMemoryConfirmationStore();
    const offered = await withCommandConfirmation(
      {
        store,
        message: { userId: caller.id, channelId: "slack:ops", threadKey: "slack:ops:one", text: "forget repo memory" },
        io: { offer: async () => {} },
      },
      () => commands.invoke("memory.forget", {}, caller, {}),
    );
    expect(visited).toEqual([]);
    if (offered.ok || !offered.confirmation) throw new Error("Expected an offer");
    const consumed = await store.consume(offered.confirmation.id, [caller.id]);
    if (!consumed.ok || consumed.row.kind !== "run") throw new Error("Expected consumption");
    repo = "acme/other";
    expect(await withConsumedCommand(consumed.row, () => commands.invoke("memory.forget", {}, caller, {}))).toEqual({
      ok: true,
      value: { forgotten: true },
    });
    expect(visited).toEqual(["acme/api"]);
  });
  it("saved command input supports schema transforms and refuses a changed default", async () => {
    const seen: unknown[] = [];
    let mode = "safe";
    const commands = new CommandRegistry({ audit: () => {} });
    commands.register({
      id: "demo.write",
      action: "config:write",
      effect: "write",
      describe: "Write values",
      options: z.object({
        agents: z.string().transform((value) => value.split(",")),
        mode: z.string().default(() => mode),
      }),
      annotations: { destructive: true, confirmation: "always" },
      handler: async ({ options }) => {
        seen.push(options);
        return { saved: true };
      },
    });
    const caller: Caller = {
      kind: "mcp",
      id: "mcp:one",
      actor: { kind: "service", id: "mcp:one", grants: ALL_GRANTS },
    };
    const store = new InMemoryConfirmationStore();
    const context = {
      store,
      message: { userId: caller.id, channelId: "mcp:ops", threadKey: "mcp:ops:one", text: "write agents" },
      io: { offer: async () => {} },
    };
    const input = { options: { agents: "coding,review" } };
    const offered = await withCommandConfirmation(context, () => commands.invoke("demo.write", input, caller, {}));
    if (offered.ok || !offered.confirmation) throw new Error("Expected an offer");
    const claimed = await store.consume(offered.confirmation.id, [caller.id]);
    if (!claimed.ok || claimed.row.kind !== "run") throw new Error("Expected consumption");
    const claimedRow = claimed.row;
    expect(
      await withConsumedCommand(claimedRow, () => commands.invoke("demo.write", claimedRow.input, caller, {})),
    ).toEqual({ ok: true, value: { saved: true } });
    expect(seen).toEqual([{ agents: ["coding", "review"], mode: "safe" }]);
    const second = await withCommandConfirmation(context, () => commands.invoke("demo.write", input, caller, {}));
    if (second.ok || !second.confirmation) throw new Error("Expected another offer");
    const next = await store.consume(second.confirmation.id, [caller.id]);
    if (!next.ok || next.row.kind !== "run") throw new Error("Expected consumption");
    const nextRow = next.row;
    mode = "wide";
    expect(
      await withConsumedCommand(nextRow, () => commands.invoke("demo.write", nextRow.input, caller, {})),
    ).toMatchObject({ ok: false, error: "unauthorized" });
    expect(seen).toHaveLength(1);
  });
  it("saved machine approval does not invent a conversation origin on replay", async () => {
    const f = fixture("mcp");
    f.commands.register({
      id: "repo.link",
      action: "repo:write",
      effect: "write",
      describe: "Link a repository",
      annotations: { destructive: true, confirmation: "always" },
      handler: async ({ caller }) => ({ kind: caller.kind, origin: caller.origin?.channelId ?? null }),
    });
    const offered = await withCommandConfirmation(f.context, () => f.commands.invoke("repo.link", {}, f.caller, {}));
    if (offered.ok || !offered.confirmation) throw new Error("Expected an offer");
    const claimed = await f.store.consume(offered.confirmation.id, [f.caller.id]);
    if (!claimed.ok || claimed.row.kind !== "run") throw new Error("Expected consumption");
    const replay = {
      ...f.caller,
      kind: "chat" as const,
      origin: { channelId: f.context.message.channelId, threadKey: f.context.message.threadKey },
    };
    expect(await withConsumedCommand(claimed.row, () => f.commands.invoke("repo.link", {}, replay, {}))).toEqual({
      ok: true,
      value: { kind: "mcp", origin: null },
    });
  });
});
