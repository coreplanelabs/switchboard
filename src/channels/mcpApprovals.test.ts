import { principalOf } from "../core/authz/authorize.js";
import { InMemoryPersonalTokenStore, digestBearer } from "../mcp/personalTokens.js";
import { createCommandHttpHandler } from "./commandHttp.js";
import { buildCoreCommands } from "../core/commandCatalogue.js";
import { secretsFrom } from "../secrets.js";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../config.js";
import { CommandRegistry, bindCommands } from "../core/commandRegistry.js";
import { ALL_GRANTS } from "../core/authz/grants.js";
import { NO_GRANTS, type Grants } from "../core/authz/types.js";
import { InMemoryConfirmationStore, FileConfirmationStore } from "../core/confirmations.js";
import type { CoreDeps } from "../core/dispatcher.js";
import { RunRegistry } from "../core/runRegistry.js";
import { NullRunHistoryWriter } from "../core/runHistoryWriter.js";
import { handleMcpRequest, type McpOptions } from "./mcp.js";
import { createMcpApprovalView } from "./mcpApprovalView.js";

const APPROVAL_PROTOCOL_VERSION = "2026-07-28";

// Feature: docs/reference/specs/mcp-ingress.md — delegated authority and human approval.
describe("MCP approval parity", () => {
  function fixture(person: Grants = ALL_GRANTS, browser = false, persistent = false) {
    let removed = 0;
    let now = 10_000;
    let personGrants = person;
    let connectionGrants: Grants = ALL_GRANTS;
    const registry = new CommandRegistry({ audit: () => {}, confirmationClass: () => "destructive" });
    registry.register({
      id: "repo.offboard",
      action: "repo:write",
      effect: "write",
      annotations: { destructive: true },
      describe: "Remove the registered repository",
      handler: async () => ({ removed: ++removed }),
    });
    registry.register({
      id: "repo.reconfigure",
      action: "repo:write",
      effect: "write",
      annotations: { destructive: false },
      describe: "Update the repository configuration",
      handler: async () => ({ saved: "configuration" }),
    });
    const commands = bindCommands(registry, {});
    const grantsFor = (id: string) =>
      id === "mcp:device" || id === "mcp:other-device"
        ? connectionGrants
        : id === "slack:UALICE"
          ? personGrants
          : NO_GRANTS;
    const dir = mkdtempSync(join(tmpdir(), "swb-mcp-approval-"));
    writeFileSync(
      join(dir, "config.yaml"),
      `organization: acme\nproviders:\n  anthropic:\n    type: anthropic\n    apiKeyEnv: ANTHROPIC_API_KEY\ndefaults:\n  boundary:\n    confirm: destructive\n  agent: general\n  models:\n    general: anthropic/general-model\n    coding: anthropic/coding-model\n`,
    );
    const config = new ConfigStore(join(dir, "config.yaml"), join(dir, "overrides.json"));
    config.grantsFor = grantsFor;
    const createStore = () =>
      persistent
        ? new FileConfirmationStore(join(dir, "confirmations.json"), { clock: () => now })
        : new InMemoryConfirmationStore({ clock: () => now });
    const deps = {
      config,
      commands,
      confirmations: createStore(),
      runRegistry: new RunRegistry({ genId: () => "approval-run" }),
      runHistoryWriter: new NullRunHistoryWriter(),
      clock: () => now,
    } as unknown as CoreDeps;
    const options: McpOptions = {
      auth: {
        tokens: {
          tok: { subject: "device", email: "alice@example.com" },
          other: { subject: "other-device", email: "alice@example.com" },
        },
      },
      commands,
      grantsFor,
      personByEmail: async (email) => (email === "alice@example.com" ? { id: "slack:UALICE" } : { id: "slack:UBOB" }),
      publicBaseUrl: "https://bot.example",
      approvalsEnabled: browser,
    };
    const call = (name = "repo_offboard", args: unknown = {}, token = "tok", modern?: Record<string, unknown>) =>
      handleMcpRequest(
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            ...(modern
              ? { "mcp-protocol-version": APPROVAL_PROTOCOL_VERSION, "mcp-method": "tools/call", "mcp-name": name }
              : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args, ...(modern ?? {}) },
          }),
        },
        deps,
        options,
      );
    const browserCall = async (
      id: string,
      action?: string,
      email = "alice@example.com",
      origin = "https://bot.example",
    ) => {
      async function* chunks() {
        yield Buffer.from(action ? `action=${action}` : "");
      }
      const req = Object.assign(chunks(), {
        url: `/settings/approve?id=${id}`,
        method: action ? "POST" : "GET",
        headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
      });
      let status = 0;
      let text = "";
      const res = {
        writeHead: (s: number) => {
          status = s;
        },
        end: (s: string) => {
          text = s;
        },
      };
      createMcpApprovalView(deps, options)(req as never, res as never, { sub: "signed-in", email });
      await vi.waitFor(() => expect(status).not.toBe(0));
      return { status, text };
    };
    const offeredId = async () => {
      const result = await call();
      expect(result.body).toMatchObject({
        result: {
          structuredContent: { approval: { url: expect.stringContaining("https://bot.example/settings/approve?id=") } },
        },
      });
      return (result.body as { result: { structuredContent: { approval: { id: string } } } }).result.structuredContent
        .approval.id;
    };
    return {
      dir,
      deps,
      options,
      call,
      browserCall,
      offeredId,
      removed: () => removed,
      revoke: () => {
        personGrants = NO_GRANTS;
      },
      readOnly: () => {
        connectionGrants = { ...NO_GRANTS, actions: new Set(["repo:read"]) };
      },
      expire: () => {
        now += 600_000;
      },
      restart: () => {
        deps.confirmations = createStore();
      },
    };
  }
  it("the official SDK URL elicitation cannot execute on an auto-accepted response without browser consent", async () => {
    const f = fixture(ALL_GRANTS, true);
    const envelope = {
      [PROTOCOL_VERSION_META_KEY]: APPROVAL_PROTOCOL_VERSION,
      [CLIENT_INFO_META_KEY]: { name: "test-client", version: "1" },
      [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { url: {} } },
    };
    const first = await f.call("repo_offboard", {}, "tok", { _meta: envelope });
    expect(first.body).toMatchObject({
      result: {
        inputRequests: {
          approval: {
            method: "elicitation/create",
            params: { mode: "url", url: expect.stringContaining("https://bot.example/settings/approve?id=") },
          },
        },
      },
    });
    const id = (first.body as { result: { requestState: string } }).result.requestState;
    const accepted = await f.call("repo_offboard", {}, "tok", {
      _meta: envelope,
      requestState: id,
      inputResponses: { approval: { action: "accept" } },
    });
    expect(accepted.body).toMatchObject({
      result: { content: [{ text: "Browser approval is still required; nothing ran." }] },
    });
    expect(f.removed()).toBe(0);
    expect(
      (await f.call("repo_offboard", { target: "other" }, "tok", { _meta: envelope, requestState: id })).body,
    ).toMatchObject({ error: { code: -32001 } });
    expect((await f.browserCall(id, "approve")).status).toBe(200);
    expect(
      (
        await f.call("repo_offboard", {}, "tok", {
          _meta: envelope,
          requestState: id,
          inputResponses: { approval: { action: "accept" } },
        })
      ).body,
    ).toHaveProperty("result");
    expect(f.removed()).toBe(1);
  });
  it("a declined SDK elicitation cancels the saved action without browser approval or effects", async () => {
    const f = fixture(ALL_GRANTS, true);
    const envelope = {
      [PROTOCOL_VERSION_META_KEY]: APPROVAL_PROTOCOL_VERSION,
      [CLIENT_INFO_META_KEY]: { name: "test-client", version: "1" },
      [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { url: {} } },
    };
    const first = await f.call("repo_offboard", {}, "tok", { _meta: envelope });
    const id = (first.body as { result: { requestState: string } }).result.requestState;
    expect(
      (
        await f.call("repo_offboard", {}, "tok", {
          _meta: envelope,
          requestState: id,
          inputResponses: { approval: { action: "decline" } },
        })
      ).body,
    ).toMatchObject({ result: { content: [{ text: "Cancelled; nothing ran" }] } });
    expect((await f.call("approval_resume", { id })).body).toMatchObject({ error: { code: -32003 } });
    expect(f.removed()).toBe(0);
  });
  it("an ordinary person's direct MCP settings change updates that person's scope, while a read-only client cannot write", async () => {
    const f = fixture(NO_GRANTS);
    const commands = buildCoreCommands(f.deps.config, null, {
      registry: f.deps.runRegistry!,
      secrets: secretsFrom({}),
      dataDir: f.dir,
      warn: () => {},
      audit: () => {},
    });
    f.deps.commands = commands;
    f.options.commands = commands;
    expect((await f.call("config_set", { scope: "me", agent: "general" })).body).toHaveProperty("result");
    expect(f.deps.config.scopes("mcp:default", "slack:UALICE").user?.agent).toBe("general");
    expect(f.deps.config.scopes("mcp:default", "mcp:device").user?.agent).toBeUndefined();
    f.readOnly();
    expect((await f.call("config_set", { scope: "me", agent: "review" })).body).toMatchObject({
      error: { code: -32001 },
    });
    expect(f.deps.config.scopes("mcp:default", "slack:UALICE").user?.agent).toBe("general");
  });
  it("a direct HTTP offer uses the same signed-in browser and atomic core execution", async () => {
    const f = fixture(ALL_GRANTS, true);
    const original = f.options.grantsFor!;
    const grantsFor = (id: string) => (id === "access:signed-in" ? ALL_GRANTS : original(id));
    f.options.grantsFor = grantsFor;
    f.deps.config.grantsFor = grantsFor;
    const handler = createCommandHttpHandler(f.options.commands!, {
      grantsFor,
      personByEmail: f.options.personByEmail,
      core: f.deps,
      publicBaseUrl: "https://bot.example",
      browserApprovals: true,
    });
    async function* chunks() {
      yield Buffer.from("{}");
    }
    const req = Object.assign(chunks(), {
      url: "/api/repo.offboard",
      method: "POST",
      headers: { origin: "https://bot.example", "content-type": "application/json", "sec-fetch-site": "same-origin" },
    });
    let status = 0;
    let body = "";
    const res = {
      writeHead: (value: number) => {
        status = value;
      },
      end: (value: string) => {
        body = value;
      },
    };
    await handler(req as never, res as never, { sub: "signed-in", email: "alice@example.com" });
    expect(status).toBe(409);
    expect(JSON.parse(body)).toMatchObject({ error: "confirmation_required", confirmation: { line: "repo offboard" } });
    expect(f.removed()).toBe(0);
    const id = JSON.parse(body).confirmation.id as string;
    const confirmed = await f.browserCall(id, "approve");
    expect(confirmed.status).toBe(200);
    expect(confirmed.text).toContain("removed: 1");
    expect(f.removed()).toBe(1);
    expect((await f.browserCall(id, "approve")).status).toBe(404);
    expect(f.removed()).toBe(1);
  });
  it("a linked administrator credential cannot exceed the person's revoked permissions", async () => {
    const f = fixture(NO_GRANTS);
    expect((await f.call()).body).toMatchObject({ error: { code: -32001 } });
    expect(f.removed()).toBe(0);
  });
  it("an unavailable verified identity cannot fall back to broader credential permissions", async () => {
    const f = fixture();
    f.options.personByEmail = async () => undefined;
    expect((await f.call("repo_reconfigure")).body).toMatchObject({ error: { code: -32001 } });
    expect(f.removed()).toBe(0);
  });
  it("a destructive direct command requires independently verified approval", async () => {
    const f = fixture();
    expect((await f.call()).body).toMatchObject({ error: { code: -32004 } });
    expect(f.removed()).toBe(0);
  });
  it("a routine write uses the same bounded permissions without another click", async () => {
    const f = fixture();
    expect((await f.call("repo_reconfigure")).body).toMatchObject({
      result: { content: [{ text: 'repo.reconfigure: ok\n{"saved":"configuration"}' }] },
    });
    f.readOnly();
    expect((await f.call("repo_reconfigure")).body).toMatchObject({ error: { code: -32001 } });
  });
  it("the supported MCP entry completes the browser-approved saved action once and records its outcome", async () => {
    const f = fixture(ALL_GRANTS, true);
    const id = await f.offeredId();
    expect((await f.call("approval_resume", { id })).body).toMatchObject({
      result: { content: [{ text: "Browser approval is still required; nothing ran." }] },
    });
    expect(f.removed()).toBe(0);
    expect((await f.browserCall(id, "approve")).status).toBe(200);
    const result = await f.call("approval_resume", { id });
    expect(result.body).toMatchObject({ result: { content: [{ text: expect.stringContaining("removed: 1") }] } });
    expect(f.removed()).toBe(1);
    expect(f.deps.runRegistry!.getById("approval-run")).toMatchObject({
      agent: "command",
      status: "completed",
      userId: "slack:UALICE",
      authenticatedAs: "mcp:device",
    });
    expect((await f.call("approval_resume", { id })).body).toMatchObject({ error: { code: -32003 } });
    expect(f.removed()).toBe(1);
  });
  it("wrong user, wrong connection and modified resume arguments cannot approve or execute the saved action", async () => {
    const f = fixture(ALL_GRANTS, true);
    const id = await f.offeredId();
    expect((await f.browserCall(id, "approve", "bob@example.com")).status).toBe(404);
    expect((await f.call("approval_resume", { id }, "other")).body).toMatchObject({ error: { code: -32003 } });
    expect((await f.call("approval_resume", { id, target: "elsewhere" })).body).toMatchObject({
      error: { code: -32602 },
    });
    expect((await f.browserCall(id, "approve", "alice@example.com", "https://evil.example")).status).toBe(403);
    expect(f.removed()).toBe(0);
    expect((await f.browserCall(id, "approve")).status).toBe(200);
    expect((await f.call("approval_resume", { id })).body).toHaveProperty("result");
    expect(f.removed()).toBe(1);
  });
  it("permission revocation after approval prevents execution at the shared command door", async () => {
    const f = fixture(ALL_GRANTS, true);
    const id = await f.offeredId();
    expect((await f.browserCall(id, "approve")).status).toBe(200);
    f.revoke();
    expect((await f.call("approval_resume", { id })).body).toMatchObject({
      result: { content: [{ text: expect.stringContaining("restricted") }] },
    });
    expect(f.removed()).toBe(0);
  });
  it("cancelled and expired offers cannot execute and concurrent confirmation cannot duplicate effects", async () => {
    const f = fixture(ALL_GRANTS, true);
    const cancelled = await f.offeredId();
    expect((await f.browserCall(cancelled, "cancel")).status).toBe(200);
    expect((await f.call("approval_resume", { id: cancelled })).body).toMatchObject({ error: { code: -32003 } });
    const expired = await f.offeredId();
    f.expire();
    expect((await f.browserCall(expired, "approve")).status).toBe(410);
    expect(f.removed()).toBe(0);
    const id = await f.offeredId();
    expect((await f.browserCall(id, "approve")).status).toBe(200);
    await Promise.all([f.call("approval_resume", { id }), f.call("approval_resume", { id })]);
    expect(f.removed()).toBe(1);
    expect((await f.call("approval_resume", { id })).body).toMatchObject({ error: { code: -32003 } });
  });
  it("approval survives a store restart and a lost response never makes its retry execute again", async () => {
    const f = fixture(ALL_GRANTS, true, true);
    const id = await f.offeredId();
    expect((await f.browserCall(id, "approve")).status).toBe(200);
    f.restart();
    await f.call("approval_resume", { id }); // The client loses this result.
    f.restart();
    expect((await f.call("approval_resume", { id })).body).toMatchObject({ error: { code: -32003 } });
    expect(f.removed()).toBe(1);
  });
  it("independent direct requests retain their own offers instead of replacing the default thread's action", async () => {
    const f = fixture(ALL_GRANTS, true);
    const first = await f.offeredId();
    const second = await f.offeredId();
    expect(first).not.toBe(second);
    expect((await f.browserCall(first, "approve")).status).toBe(200);
    await f.call("approval_resume", { id: first });
    expect(f.removed()).toBe(1);
    await f.call("approval_cancel", { id: second });
    await f.call("approval_resume", { id: second });
    expect(f.removed()).toBe(1);
  });
  it("a legacy personal connection without Slack still reads as its verified Access user", async () => {
    const f = fixture();
    const token = "b".repeat(64);
    const store = new InMemoryPersonalTokenStore();
    await store.put({
      digest: digestBearer(token),
      subject: "personal:old-user",
      email: "old@example.com",
      createdAt: 1,
    });
    f.options.auth = { tokens: {} };
    f.options.personalTokens = store;
    f.options.personByEmail = undefined;
    f.options.grantsFor = () => ALL_GRANTS;
    const commands = new CommandRegistry({ audit: () => {} });
    commands.register({
      id: "config.show",
      action: "config:read",
      effect: "read",
      describe: "Read own config",
      handler: async ({ caller }) => ({ user: principalOf(caller.actor).id }),
    });
    f.options.commands = bindCommands(commands, {});
    const result = await f.call("config_show", {}, token);
    expect(result.body).toMatchObject({
      result: { content: [{ type: "text", text: 'config.show: ok\n{"user":"access:old-user"}' }] },
    });
    await store.delete(digestBearer(token), "personal:old-user");
    expect((await f.call("config_show", {}, token)).status).toBe(401);
  });
  it("an approved MCP stop retains the original credential and surface in its stored actor", async () => {
    const f = fixture(ALL_GRANTS, true);
    const registry = new RunRegistry();
    const live = registry.create("live run", {
      agent: "general",
      channelId: "mcp:default",
      userId: "slack:UALICE",
      threadKey: "mcp:default:target",
    });
    f.deps.runRegistry = registry;
    f.options.commands = buildCoreCommands(f.deps.config, null, {
      registry,
      dataDir: f.dir,
      secrets: secretsFrom({}),
      warn() {},
      audit() {},
    });
    f.deps.commands = f.options.commands;
    const offered = await f.call("runs_stop", { id: live.id, mode: "hard" });
    const id = (offered.body as { result: { structuredContent: { approval: { id: string } } } }).result
      .structuredContent.approval.id;
    expect(
      registry
        .snapshot(live.id, live.token)
        ?.events.some((event) => event.type === "run_note" && event.kind === "stop_requested"),
    ).toBe(false);
    expect((await f.browserCall(id, "approve")).status).toBe(200);
    await f.call("approval_resume", { id });
    const note = registry
      .snapshot(live.id, live.token)
      ?.events.find((event) => event.type === "run_note" && event.kind === "stop_requested");
    expect(note).toMatchObject({ actor: { kind: "mcp", id: "mcp:device" } });
  });
});
