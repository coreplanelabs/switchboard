import { z } from "zod";
import { registerRunsCommands, type RunsCommandDeps } from "../core/commands/runs.js";
import { createRunsService } from "../core/runsService.js";
import { InMemoryRunStore } from "../core/runStore.js";
import { withCommandConfirmation } from "../core/commandConfirmations.js";
import { resolveChatActor } from "../core/authz/actor.js";
import type { Caller } from "../core/commandRegistry.js";
import { principalOf } from "../core/authz/authorize.js";
import { InMemoryPersonalTokenStore, digestBearer } from "../mcp/personalTokens.js";
import { createCommandHttpHandler } from "./commandHttp.js";
import { registerMergeCommands, type MergeCommandDeps, type MergeDoorService } from "../core/commands/merge.js";
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
import { tokenVerifier } from "./dashboardAuth.js";
import type { AccessIdentity } from "./accessAuth.js";

const APPROVAL_PROTOCOL_VERSION = "2026-07-28";
const FORM_META = {
  [PROTOCOL_VERSION_META_KEY]: APPROVAL_PROTOCOL_VERSION,
  [CLIENT_INFO_META_KEY]: { name: "personal-client", version: "1" },
  [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
};
const URL_META = { ...FORM_META, [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { url: {} } } };

// Feature: docs/reference/specs/mcp-ingress.md — delegated authority and human approval.
describe("MCP approval parity", () => {
  function fixture(person: Grants = ALL_GRANTS, browser = false, persistent = false, merge?: MergeDoorService) {
    let removed = 0;
    let now = 10_000;
    let personGrants = person;
    let connectionGrants: Grants = ALL_GRANTS;
    const registry = new CommandRegistry<MergeCommandDeps & RunsCommandDeps>({
      audit: () => {},
      confirmationClass: () => "destructive",
    });
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
    if (merge) registerMergeCommands(registry);
    const stopRuns = new RunRegistry();
    registerRunsCommands(registry);
    const runs = createRunsService({ registry: stopRuns, store: new InMemoryRunStore() });
    const commands = bindCommands(registry, {
      runs: async () => runs,
      ...(merge ? { merge: { service: async () => merge } } : {}),
    });
    const grantsFor = (id: string) =>
      id === "mcp:device" || id === "mcp:other-device" || id === "mcp:personal:device"
        ? connectionGrants
        : id === "slack:UALICE" || id === "access:alice" || id === "access:device"
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
    const call = (
      name = "repo_offboard",
      args: unknown = {},
      token = "tok",
      modern?: Record<string, unknown>,
      authorization = `Bearer ${token}`,
    ) =>
      handleMcpRequest(
        {
          method: "POST",
          headers: {
            authorization,
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
      origin: string | null = "https://bot.example",
      identity?: AccessIdentity,
    ) => {
      async function* chunks() {
        yield Buffer.from(action ? `action=${action}` : "");
      }
      const req = Object.assign(chunks(), {
        url: `/settings/approve?id=${id}`,
        method: action ? "POST" : "GET",
        headers: {
          ...(origin === null ? {} : { origin }),
          "sec-fetch-site": "same-origin",
          "content-type": "application/x-www-form-urlencoded",
        },
      });
      let status = 0;
      let text = "";
      let headers: Record<string, string> = {};
      const res = {
        writeHead: (s: number, h: Record<string, string>) => {
          status = s;
          headers = h;
        },
        end: (s: string) => {
          text = s;
        },
      };
      createMcpApprovalView(deps, options)(req as never, res as never, identity ?? { sub: "signed-in", email });
      await vi.waitFor(() => expect(status).not.toBe(0));
      return { status, text, headers };
    };
    const offeredId = async (name = "repo_offboard", args: Record<string, unknown> = {}) => {
      const result = await call(name, args, "tok", { _meta: FORM_META });
      expect(result.body).toMatchObject({ result: { inputRequests: { approval: { params: { mode: "form" } } } } });
      return (result.body as { result: { requestState: string } }).result.requestState;
    };
    return {
      dir,
      stopRuns,
      setConnectionGrants: (grants: Grants) => {
        connectionGrants = grants;
      },
      commandRegistry: registry,
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
  it("a verified requester stops only their own review through MCP form consent without runs:write", async () => {
    const f = fixture(NO_GRANTS);
    f.setConnectionGrants({ ...NO_GRANTS, actions: new Set(["dispatch"]) });
    const own = f.stopRuns.create("review", {
      userId: "slack:UALICE",
      channelId: "slack:D1",
      threadKey: "slack:D1:1",
      channelVisibility: "dm",
    });
    const foreign = f.stopRuns.create("review", {
      userId: "slack:UBOB",
      channelId: "slack:D2",
      threadKey: "slack:D2:2",
      channelVisibility: "dm",
    });
    const args = { id: own.id, mode: "hard" };
    const requestState = await f.offeredId("runs_stop", args);
    expect(own.control.hardSignal.aborted).toBe(false);
    const consent = {
      _meta: FORM_META,
      requestState,
      inputResponses: { approval: { action: "accept", content: { decision: "approve" } } },
    };
    expect((await f.call("runs_stop", { ...args, id: foreign.id }, "tok", consent)).body).toMatchObject({
      error: { code: -32001 },
    });
    expect((await f.call("runs_stop", args, "other", consent)).body).toMatchObject({ error: { code: -32001 } });
    const result = await f.call("runs_stop", args, "tok", consent);
    expect(result.body).toMatchObject({ result: { content: [{ text: expect.stringContaining("state: stopping") }] } });
    expect(own.control.requested).toBe("hard");
    expect(own.control.hardSignal.aborted).toBe(true);
    expect(f.stopRuns.getById(own.id)).toMatchObject({ finished: false });
    expect(foreign.control.hardSignal.aborted).toBe(false);
    expect((await f.call("runs_stop", args, "tok", consent)).body).toMatchObject({ error: { code: -32001 } });
    const deniedState = await f.offeredId("runs_stop", { ...args, id: foreign.id });
    expect(
      (await f.call("runs_stop", { ...args, id: foreign.id }, "tok", { ...consent, requestState: deniedState })).body,
    ).toMatchObject({ result: { content: [{ text: "⚠️ `runs stop`: no run found" }] } });
    expect(foreign.control.hardSignal.aborted).toBe(false);
  });

  it("MCP self cancellation refuses unlinked, read-only and spoofed callers and rechecks consent authority", async () => {
    const f = fixture(NO_GRANTS);
    const target = f.stopRuns.create("review", {
      userId: "slack:UALICE",
      channelId: "slack:D1",
      threadKey: "slack:D1:1",
      channelVisibility: "dm",
    });
    const args = { id: target.id, mode: "hard" };
    f.setConnectionGrants({ ...NO_GRANTS, actions: new Set(["runs:read"]) });
    expect((await f.call("runs_stop", args, "tok", { _meta: FORM_META })).body).toMatchObject({
      error: { code: -32001 },
    });
    f.setConnectionGrants({ ...NO_GRANTS, actions: new Set(["dispatch"]) });
    const linkedLookup = f.options.personByEmail;
    f.options.personByEmail = async () => undefined;
    expect(
      (await f.call("runs_stop", { ...args, userId: "slack:UALICE" }, "tok", { _meta: FORM_META })).body,
    ).toMatchObject({ error: { code: -32001 } });
    f.options.personByEmail = linkedLookup;
    const requestState = await f.offeredId("runs_stop", args);
    f.readOnly();
    expect(
      (
        await f.call("runs_stop", args, "tok", {
          _meta: FORM_META,
          requestState,
          inputResponses: { approval: { action: "accept", content: { decision: "approve" } } },
        })
      ).body,
    ).toMatchObject({ result: { content: [{ text: "🚫 `runs stop` is restricted. Ask an admin." }] } });
    expect(target.control.hardSignal.aborted).toBe(false);
  });

  it("MCP owner stop preserves confirmation, monotonic repeats and terminal conflict", async () => {
    const f = fixture(NO_GRANTS);
    f.setConnectionGrants({ ...NO_GRANTS, actions: new Set(["dispatch"]) });
    const target = f.stopRuns.create("review", {
      userId: "slack:UALICE",
      channelId: "slack:D1",
      threadKey: "slack:D1:1",
      channelVisibility: "dm",
    });
    const args = { id: target.id, mode: "hard" };
    expect((await f.call("runs_stop", args)).body).toMatchObject({ error: { code: -32004 } });
    expect(target.control.hardSignal.aborted).toBe(false);
    const declined = await f.offeredId("runs_stop", args);
    expect(
      (
        await f.call("runs_stop", args, "tok", {
          _meta: FORM_META,
          requestState: declined,
          inputResponses: { approval: { action: "decline" } },
        })
      ).body,
    ).toMatchObject({ result: { content: [{ text: "Cancelled; nothing ran" }] } });
    expect(target.control.hardSignal.aborted).toBe(false);
    for (const mode of ["hard", "soft"]) {
      const input = { ...args, mode };
      const requestState = await f.offeredId("runs_stop", input);
      const result = await f.call("runs_stop", input, "tok", {
        _meta: FORM_META,
        requestState,
        inputResponses: { approval: { action: "accept", content: { decision: "approve" } } },
      });
      expect(result.body).toMatchObject({
        result: { content: [{ text: expect.stringContaining("state: stopping") }] },
      });
      expect(target.control.requested).toBe("hard");
    }
    f.stopRuns.finish(target.id, "stopped_hard");
    const requestState = await f.offeredId("runs_stop", args);
    expect(
      (
        await f.call("runs_stop", args, "tok", {
          _meta: FORM_META,
          requestState,
          inputResponses: { approval: { action: "accept", content: { decision: "approve" } } },
        })
      ).body,
    ).toMatchObject({ result: { content: [{ text: "⚠️ `runs stop`: the run already finished" }] } });
    expect(f.stopRuns.getById(target.id)).toMatchObject({ finished: true, status: "stopped_hard" });
  });

  it.each(["merge", "enqueue"] as const)(
    "a browser-approved MCP %s uses the linked person's GitHub binding",
    async (action) => {
      const head = "a".repeat(40);
      const writes: unknown[] = [];
      const door: MergeDoorService = {
        githubLogin: async (userId) => (userId === "slack:UALICE" ? "alice-dev" : undefined),
        facts: async () => ({ state: "open", headSha: head, headRef: "feature", title: "fix(core): keep the result" }),
        checks: async () => ({ total: 1, pending: [], failed: [] }),
        reviews: async () => [{ state: "APPROVED", commitId: head }],
        merge: async (pr, options) => {
          writes.push({ pr, options });
          return { ok: true, sha: "b".repeat(40) };
        },
        enqueue: async (pr, options) => {
          writes.push({ pr, options });
          return { ok: true };
        },
      };
      const f = fixture(ALL_GRANTS, true, false, door);
      const id = await f.offeredId(`pulls_${action}`, { pr: "acme/api#42" });
      expect(writes).toEqual([]);
      expect((await f.browserCall(id, "approve")).status).toBe(200);
      const result = await f.call("approval_resume", { id });
      expect(result.body).toMatchObject({
        result: { content: [{ text: expect.stringContaining("alice-dev (slack:UALICE)") }] },
      });
      expect(writes).toEqual([
        {
          pr: { repo: "acme/api", number: 42 },
          options:
            action === "merge"
              ? { sha: head, title: "fix(core): keep the result", mergedBy: "alice-dev" }
              : { sha: head },
        },
      ]);
      expect(f.deps.runRegistry!.getById("approval-run")).toMatchObject({
        userId: "slack:UALICE",
        authenticatedAs: "mcp:device",
        status: "completed",
      });
      expect((await f.call("approval_resume", { id })).body).toMatchObject({ error: { code: -32003 } });
      expect(writes).toHaveLength(1);
    },
  );

  it("client form confirmation executes the saved action once without a browser", async () => {
    const f = fixture(ALL_GRANTS, false);
    const _meta = {
      [PROTOCOL_VERSION_META_KEY]: APPROVAL_PROTOCOL_VERSION,
      [CLIENT_INFO_META_KEY]: { name: "personal-client", version: "1" },
      [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
    };
    const first = await f.call("repo_offboard", {}, "tok", { _meta });
    expect(first.body).toMatchObject({
      result: {
        inputRequests: {
          approval: {
            method: "elicitation/create",
            params: { mode: "form", requestedSchema: { required: ["decision"] } },
          },
        },
      },
    });
    expect(JSON.stringify(first.body)).not.toContain("https://bot.example");
    expect(f.removed()).toBe(0);
    const requestState = (first.body as { result: { requestState: string } }).result.requestState;
    const approved = await f.call("repo_offboard", {}, "tok", {
      _meta,
      requestState,
      inputResponses: { approval: { action: "accept", content: { decision: "approve" } } },
    });
    expect(approved.body).toMatchObject({ result: { content: [{ text: expect.stringContaining("removed: 1") }] } });
    expect(f.removed()).toBe(1);
    expect(
      (
        await f.call("repo_offboard", {}, "tok", {
          _meta,
          requestState,
          inputResponses: { approval: { action: "accept", content: { decision: "approve" } } },
        })
      ).body,
    ).toMatchObject({ error: { code: -32001 } });
    expect(f.removed()).toBe(1);
  });

  it("URL elicitation reuses browser consent and resumes the saved action once", async () => {
    const f = fixture(ALL_GRANTS, true);
    const first = await f.call("repo_offboard", {}, "tok", { _meta: URL_META });
    expect(first.body).toMatchObject({ result: { inputRequests: { approval: { params: { mode: "url" } } } } });
    const id = (first.body as { result: { requestState: string } }).result.requestState;
    expect(first.body).toMatchObject({
      result: { inputRequests: { approval: { params: { url: `https://bot.example/settings/approve?id=${id}` } } } },
    });
    const opened = await f.call("repo_offboard", {}, "tok", {
      _meta: URL_META,
      requestState: id,
      inputResponses: { approval: { action: "accept" } },
    });
    expect(opened.body).toMatchObject({ result: { requestState: id } });
    expect(f.removed()).toBe(0);
    expect((await f.browserCall(id, "approve")).status).toBe(200);
    expect(f.removed()).toBe(0);
    expect((await f.call("approval_resume", { id }, "tok", { _meta: URL_META })).body).toMatchObject({
      result: { content: [{ text: expect.stringContaining("removed: 1") }] },
    });
    expect((await f.call("approval_resume", { id })).body).toMatchObject({ error: { code: -32003 } });
    expect(f.removed()).toBe(1);
  });

  it("a client without elicitation receives the same saved browser link until consent", async () => {
    const f = fixture(ALL_GRANTS, true, true);
    const first = await f.call();
    expect(first.body).toMatchObject({
      result: { content: [{ text: expect.stringContaining("https://bot.example/settings/approve?id=") }] },
    });
    const text = (first.body as { result: { content: { text: string }[] } }).result.content[0]!.text;
    const id = /\/settings\/approve\?id=([A-Za-z0-9_-]+)/.exec(text)![1]!;
    const pending = await f.call("approval_resume", { id });
    expect(pending.body).toEqual(first.body);
    expect(f.removed()).toBe(0);
    expect((await f.browserCall(id, "approve")).status).toBe(200);
    f.restart();
    await Promise.all([f.call("approval_resume", { id }), f.call("approval_resume", { id })]);
    f.restart();
    expect((await f.call("approval_resume", { id })).body).toMatchObject({ error: { code: -32003 } });
    expect(f.removed()).toBe(1);
  });

  it("SSO browser consent binds the same subject and person without replacing the native credential", async () => {
    const f = fixture(ALL_GRANTS, true);
    f.options.sso = {
      mode: "access",
      describe: () => "test SSO",
      verify: async ({ headers }) =>
        headers.authorization === "Bearer native-oauth"
          ? { ok: true, identity: { sub: "alice", email: "alice@example.com" } }
          : { ok: false, status: 401, body: "unauthorized" },
    };
    const first = await f.call("repo_offboard", {}, "native-oauth", { _meta: URL_META });
    expect(first.body).toMatchObject({ result: { inputRequests: { approval: { params: { mode: "url" } } } } });
    const id = (first.body as { result: { requestState: string } }).result.requestState;
    expect(
      (await f.browserCall(id, "approve", undefined, undefined, { sub: "other", email: "alice@example.com" })).status,
    ).toBe(403);
    expect(
      (await f.browserCall(id, "approve", undefined, undefined, { sub: "alice", email: "bob@example.com" })).status,
    ).toBe(404);
    expect(
      (await f.browserCall(id, "approve", undefined, undefined, { sub: "alice", email: "alice@example.com" })).status,
    ).toBe(200);
    expect(f.removed()).toBe(0);
    expect((await f.browserCall(id, "approve", undefined, undefined, { sub: "", commonName: "machine" })).status).toBe(
      404,
    );
    expect((await f.call("approval_resume", { id }, "different-oauth")).status).toBe(401);
    expect((await f.call("approval_resume", { id }, "native-oauth", { _meta: URL_META })).body).toMatchObject({
      result: { content: [{ text: expect.stringContaining("removed: 1") }] },
    });
    expect(f.removed()).toBe(1);
  });

  it("SSO browser consent cannot execute after the original credential or permission is revoked", async () => {
    const f = fixture(ALL_GRANTS, true);
    const verifier = tokenVerifier({ token: "native-oauth", env: "DASHBOARD_TOKEN", subject: "alice" });
    f.options.sso = verifier;
    const first = await f.call("repo_offboard", {}, "native-oauth", { _meta: URL_META });
    expect(first.body).toMatchObject({ result: { inputRequests: { approval: { params: { mode: "url" } } } } });
    const id = (first.body as { result: { requestState: string } }).result.requestState;
    expect(
      (await f.browserCall(id, "approve", undefined, undefined, { sub: "alice", email: "alice@example.com" })).status,
    ).toBe(200);
    f.options.sso = tokenVerifier({ token: "replacement", env: "DASHBOARD_TOKEN", subject: "alice" });
    expect((await f.call("approval_resume", { id }, "native-oauth")).status).toBe(401);
    expect((await f.call("approval_resume", { id }, "replacement")).body).toMatchObject({ error: { code: -32003 } });
    f.options.sso = {
      ...verifier,
      verify: async () => {
        throw new Error("identity provider unavailable");
      },
    };
    expect((await f.call("approval_resume", { id }, "native-oauth")).status).toBe(503);
    f.options.sso = verifier;
    f.revoke();
    expect((await f.call("approval_resume", { id }, "native-oauth")).body).toMatchObject({
      result: { content: [{ text: expect.stringContaining("restricted") }] },
    });
    expect(f.removed()).toBe(0);
  });

  it("a browser-bound offer cannot switch to form consent or change its saved arguments", async () => {
    const f = fixture(ALL_GRANTS, true);
    const first = await f.call("repo_offboard", {}, "tok", { _meta: URL_META });
    expect(first.body).toMatchObject({ result: { inputRequests: { approval: { params: { mode: "url" } } } } });
    const id = (first.body as { result: { requestState: string } }).result.requestState;
    const consent = {
      _meta: FORM_META,
      requestState: id,
      inputResponses: { approval: { action: "accept", content: { decision: "approve" } } },
    };
    expect((await f.call("repo_offboard", {}, "tok", consent)).body).toMatchObject({
      result: { content: [{ text: expect.stringContaining("https://bot.example/settings/approve?id=") }] },
    });
    expect((await f.call("repo_offboard", { target: "other" }, "tok", consent)).body).toMatchObject({
      error: { code: -32001 },
    });
    expect(f.removed()).toBe(0);
    expect((await f.browserCall(id, "approve")).status).toBe(200);
    expect((await f.call("approval_resume", { id }, "tok", { _meta: FORM_META })).body).toMatchObject({
      result: { content: [{ text: expect.stringContaining("removed: 1") }] },
    });
    expect(f.removed()).toBe(1);
  });

  it("personal browser consent retains token revocation and refuses an unusable browser URL", async () => {
    const f = fixture(ALL_GRANTS, true);
    const token = "e".repeat(64);
    const store = new InMemoryPersonalTokenStore();
    const row = {
      digest: digestBearer(token),
      subject: "personal:device",
      email: "alice@example.com",
      userId: "access:device",
      createdAt: 1,
    };
    await store.put(row);
    f.options.personalTokens = store;
    f.options.publicBaseUrl = "http://remote.example";
    expect((await f.call("repo_offboard", {}, token)).body).toMatchObject({ error: { code: -32004 } });
    expect(f.removed()).toBe(0);
    f.options.publicBaseUrl = "https://bot.example";
    const first = await f.call("repo_offboard", {}, token, { _meta: URL_META });
    expect(first.body).toMatchObject({ result: { inputRequests: { approval: { params: { mode: "url" } } } } });
    const id = (first.body as { result: { requestState: string } }).result.requestState;
    await store.delete(row.digest, row.subject);
    const browserIdentity = { sub: "device", email: "alice@example.com" };
    expect((await f.browserCall(id, "approve", undefined, undefined, browserIdentity)).status).toBe(403);
    await store.put(row);
    expect((await f.browserCall(id, "approve", undefined, undefined, browserIdentity)).status).toBe(200);
    await store.delete(row.digest, row.subject);
    expect((await f.call("approval_resume", { id }, token)).status).toBe(401);
    expect(f.removed()).toBe(0);
  });

  it("SSO form confirmation stays bound to its authenticated connection and executes once", async () => {
    const f = fixture();
    const verifier = (token: string) => tokenVerifier({ token, env: "DASHBOARD_TOKEN", subject: "alice" });
    f.options.sso = verifier("sso-token");
    const first = await f.call("repo_offboard", {}, "sso-token", { _meta: FORM_META });
    expect(first.body).toMatchObject({ result: { inputRequests: { approval: { params: { mode: "form" } } } } });
    expect(f.removed()).toBe(0);
    const requestState = (first.body as { result: { requestState: string } }).result.requestState;
    const consent = {
      _meta: FORM_META,
      requestState,
      inputResponses: { approval: { action: "accept", content: { decision: "approve" } } },
    };
    f.options.sso = verifier("other-session");
    expect((await f.call("repo_offboard", {}, "other-session", consent)).body).toMatchObject({
      error: { code: -32001 },
    });
    expect(f.removed()).toBe(0);
    expect((await f.call("repo_offboard", {}, "sso-token", consent)).status).toBe(401);
    expect(f.removed()).toBe(0);
    f.options.sso = verifier("sso-token");
    expect((await f.call("repo_offboard", {}, "sso-token", consent)).body).toMatchObject({
      result: { content: [{ text: expect.stringContaining("removed: 1") }] },
    });
    expect(f.removed()).toBe(1);
    expect((await f.call("repo_offboard", {}, "sso-token", consent)).body).toMatchObject({ error: { code: -32001 } });
    expect(f.removed()).toBe(1);
  });

  it.each(["bearer sso-token", "Bearer  sso-token", "Bearer sso-token "])(
    "SSO confirmation normalizes the same credential across header spelling %s",
    async (authorization) => {
      const f = fixture();
      f.options.sso = tokenVerifier({ token: "sso-token", env: "DASHBOARD_TOKEN", subject: "alice" });
      const first = await f.call("repo_offboard", {}, "sso-token", { _meta: FORM_META }, authorization);
      expect(first.body).toMatchObject({ result: { inputRequests: { approval: { params: { mode: "form" } } } } });
      const requestState = (first.body as { result: { requestState: string } }).result.requestState;
      const accepted = await f.call("repo_offboard", {}, "sso-token", {
        _meta: FORM_META,
        requestState,
        inputResponses: { approval: { action: "accept", content: { decision: "approve" } } },
      });
      expect(accepted.body).toMatchObject({ result: { content: [{ text: expect.stringContaining("removed: 1") }] } });
      expect(f.removed()).toBe(1);
    },
  );

  it.each(["bearer", "Bearer ", "Bearer"])(
    "personal confirmation retains stored identity across scheme %s beside SSO",
    async (scheme) => {
      const f = fixture();
      const token = "d".repeat(64);
      const store = new InMemoryPersonalTokenStore();
      await store.put({
        digest: digestBearer(token),
        subject: "personal:device",
        email: "alice@example.com",
        userId: "access:device",
        createdAt: 1,
      });
      f.options.personalTokens = store;
      f.options.sso = tokenVerifier({ token, env: "DASHBOARD_TOKEN", subject: "alice" });
      const first = await f.call("repo_offboard", {}, token, { _meta: FORM_META }, `${scheme} ${token}`);
      expect(first.body).toMatchObject({ result: { inputRequests: { approval: { params: { mode: "form" } } } } });
      const requestState = (first.body as { result: { requestState: string } }).result.requestState;
      expect(await f.deps.confirmations!.get?.(requestState)).toMatchObject({
        message: {
          userId: "access:device",
          authenticatedAs: "mcp:personal:device",
          approvalConnection: { credentialId: "mcp:personal:device" },
        },
      });
      const accepted = await f.call("repo_offboard", {}, token, {
        _meta: FORM_META,
        requestState,
        inputResponses: { approval: { action: "accept", content: { decision: "approve" } } },
      });
      expect(accepted.body).toMatchObject({ result: { content: [{ text: expect.stringContaining("removed: 1") }] } });
      expect(f.removed()).toBe(1);
    },
  );

  it("regenerated forms retain the frozen implicit repository and execute that repository", async () => {
    const f = fixture();
    let currentRepo = "acme/api";
    const swept: string[] = [];
    f.commandRegistry.register({
      id: "memory.sweep",
      action: "memory:write",
      effect: "write",
      describe: "Sweep repository memory",
      options: z.object({ scope: z.literal("repo") }),
      annotations: { destructive: true },
      handler: async ({ caller }) => {
        swept.push((await caller.origin?.repo?.())!);
        return { swept };
      },
    });
    f.options.dispatch = async (_deps, msg, io) => {
      const caller: Caller = {
        kind: "mcp",
        id: "mcp:device",
        actor: resolveChatActor(msg, f.options.grantsFor!),
        origin: { channelId: msg.channelId, threadKey: msg.threadKey, repo: async () => currentRepo },
      };
      await withCommandConfirmation({ message: msg, io, store: f.deps.confirmations }, () =>
        f.options.commands!.invoke("memory.sweep", { options: { scope: "repo" } }, caller),
      );
    };
    const args = { text: "sweep this repository's memory" };
    const first = await f.call("dispatch", args, "tok", { _meta: FORM_META });
    const id = (first.body as { result: { requestState: string } }).result.requestState;
    expect(JSON.stringify(first.body)).toContain("Repository: acme/api");
    currentRepo = "acme/other";
    const continuation = await f.call("approval_resume", { id }, "tok", { _meta: FORM_META });
    expect(JSON.stringify(continuation.body)).toContain("Repository: acme/api");
    const invalid = await f.call("dispatch", args, "tok", {
      _meta: FORM_META,
      requestState: id,
      inputResponses: { approval: { action: "accept" } },
    });
    expect(JSON.stringify(invalid.body)).toContain("Repository: acme/api");
    await f.call("approval_resume", { id }, "tok", {
      _meta: FORM_META,
      requestState: id,
      inputResponses: { approval: { action: "accept", content: { decision: "approve" } } },
    });
    expect(swept).toEqual(["acme/api"]);
  });

  it("URL-only and unsupported clients do not mint ordinary approval or execute", async () => {
    const f = fixture(ALL_GRANTS, false);
    expect(
      (
        await f.call("repo_offboard", {}, "tok", {
          _meta: { ...FORM_META, [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { url: {} } } },
        })
      ).body,
    ).toMatchObject({ error: { code: -32004 } });
    expect((await f.call()).body).toMatchObject({ error: { code: -32004 } });
    expect((await f.call("repo_reconfigure")).body).toMatchObject({
      result: { content: [{ text: 'repo.reconfigure: ok\n{"saved":"configuration"}' }] },
    });
    expect(f.removed()).toBe(0);
    expect(await f.deps.confirmations!.pendingByThread("mcp:default:default")).toBeUndefined();
  });

  it("bare acceptance, changed targets and extra form fields cannot approve an offered action", async () => {
    const f = fixture(ALL_GRANTS, false);
    const id = await f.offeredId();
    for (const content of [undefined, { decision: "approve", target: "other" }, { confirm: true }]) {
      const res = await f.call("repo_offboard", {}, "tok", {
        _meta: FORM_META,
        requestState: id,
        inputResponses: { approval: { action: "accept", ...(content ? { content } : {}) } },
      });
      expect(res.body).toMatchObject({ result: { resultType: "input_required", requestState: id } });
      expect(f.removed()).toBe(0);
    }
    expect(
      (
        await f.call("repo_offboard", { target: "other" }, "tok", {
          _meta: FORM_META,
          requestState: id,
          inputResponses: { approval: { action: "accept", content: { decision: "approve" } } },
        })
      ).body,
    ).toMatchObject({ error: { code: -32001 } });
    const approved = await f.call("repo_offboard", {}, "tok", {
      _meta: FORM_META,
      requestState: id,
      inputResponses: { approval: { action: "accept", content: { decision: "approve" } } },
    });
    expect(approved.body).toMatchObject({ result: { content: [{ text: expect.stringContaining("removed: 1") }] } });
    expect(f.removed()).toBe(1);
  });

  it("a declined SDK elicitation cancels the saved action without browser approval or effects", async () => {
    const f = fixture(ALL_GRANTS, true);
    const envelope = {
      [PROTOCOL_VERSION_META_KEY]: APPROVAL_PROTOCOL_VERSION,
      [CLIENT_INFO_META_KEY]: { name: "test-client", version: "1" },
      [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
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
  it("form response cannot exceed revoked user or credential policy and races execute once", async () => {
    const response = { action: "accept", content: { decision: "approve" } };
    for (const revoke of ["user", "credential"] as const) {
      const f = fixture();
      const id = await f.offeredId();
      if (revoke === "user") f.revoke();
      else f.readOnly();
      const result = await f.call("repo_offboard", {}, "tok", {
        _meta: FORM_META,
        requestState: id,
        inputResponses: { approval: response },
      });
      expect(JSON.stringify(result.body)).toContain("🚫");
      expect(f.removed()).toBe(0);
    }
    const f = fixture();
    const id = await f.offeredId();
    await Promise.all(
      [1, 2].map(() =>
        f.call("repo_offboard", {}, "tok", {
          _meta: FORM_META,
          requestState: id,
          inputResponses: { approval: response },
        }),
      ),
    );
    expect(f.removed()).toBe(1);
  });

  it("an older state service cannot mislabel client consent as browser approval", async () => {
    const f = fixture();
    const id = await f.offeredId();
    const store = f.deps.confirmations as InMemoryConfirmationStore;
    const approve = store.approve.bind(store);
    store.approve = async (savedId, ids, connection) => {
      const out = await approve(savedId, ids, connection);
      if (out.ok) {
        delete out.row.approvedBy;
        delete store.rows.get(savedId)!.approvedBy;
      }
      return out;
    };
    const result = await f.call("repo_offboard", {}, "tok", {
      _meta: FORM_META,
      requestState: id,
      inputResponses: { approval: { action: "accept", content: { decision: "approve" } } },
    });
    expect(result.body).toMatchObject({ error: { code: -32004 } });
    expect((await f.call("approval_resume", { id })).body).toMatchObject({ error: { code: -32004 } });
    expect(f.removed()).toBe(0);
  });

  it("preapproved exact consent survives restart and runs directly without another elicitation", async () => {
    const f = fixture(ALL_GRANTS, false, true);
    const id = await f.offeredId();
    expect(await f.deps.confirmations!.approve!(id, ["slack:UALICE"], digestBearer("tok"), "mcp-form")).toMatchObject({
      ok: true,
      row: { approvedBy: "mcp-form" },
    });
    f.restart();
    const result = await f.call("approval_resume", { id });
    expect(result.body).toMatchObject({ result: { content: [{ text: expect.stringContaining("removed: 1") }] } });
    expect(JSON.stringify(result.body)).not.toContain("input_required");
    expect(f.removed()).toBe(1);
    expect((await f.call("approval_resume", { id })).body).toMatchObject({ error: { code: -32003 } });
  });

  it("a saved continuation asks in the client and cancellation never executes", async () => {
    const f = fixture(ALL_GRANTS, false);
    const id = await f.offeredId();
    expect((await f.call("approval_resume", { id }, "tok", { _meta: FORM_META })).body).toMatchObject({
      result: { requestState: id, inputRequests: { approval: { params: { mode: "form" } } } },
    });
    const result = await f.call("approval_resume", { id }, "tok", {
      _meta: FORM_META,
      requestState: id,
      inputResponses: { approval: { action: "accept", content: { decision: "cancel" } } },
    });
    expect(result.body).toMatchObject({ result: { content: [{ text: "Cancelled; nothing ran" }] } });
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
  it("the rendered approval form preserves its origin and approves the saved action once", async () => {
    const f = fixture(ALL_GRANTS, true);
    const id = await f.offeredId();
    const page = await f.browserCall(id);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Confirm saved action");
    // Fetch serializes a navigation POST's Origin as null under no-referrer.
    // Model that browser boundary from the policy the actual page returned.
    const browserOrigin = page.headers["referrer-policy"] === "no-referrer" ? "null" : "https://bot.example";
    const approved = await f.browserCall(id, "approve", "alice@example.com", browserOrigin);
    expect(approved.status).toBe(200);
    expect(approved.text).toContain("Approved. Return to your MCP client to complete the saved action once.");
    expect(f.removed()).toBe(0);
    expect((await f.call("approval_resume", { id })).body).toHaveProperty("result");
    expect(f.removed()).toBe(1);
    expect((await f.call("approval_resume", { id })).body).toMatchObject({ error: { code: -32003 } });
    expect(f.removed()).toBe(1);
  });
  it.each(["https://foreign.example", "null", "not-an-origin", null])(
    "browser approval refuses a foreign, opaque, malformed or missing origin: %s",
    async (origin) => {
      const f = fixture(ALL_GRANTS, true);
      const id = await f.offeredId();
      const denied = await f.browserCall(id, "approve", "alice@example.com", origin);
      expect(denied.status).toBe(403);
      expect(denied.text).toContain("This form must be submitted from Switchboard.");
      expect((await f.call("approval_resume", { id })).body).toMatchObject({
        error: { code: -32004 },
      });
      expect(f.removed()).toBe(0);
    },
  );
  it.each(["approve&runId=foreign", "approve&csrf=wrong"])(
    "browser approval cannot add arguments to its saved action: %s",
    async (action) => {
      const f = fixture(ALL_GRANTS, true);
      const id = await f.offeredId();
      expect((await f.browserCall(id, action)).status).toBe(400);
      expect((await f.call("approval_resume", { id })).body).toMatchObject({
        error: { code: -32004 },
      });
      expect(f.removed()).toBe(0);
    },
  );
  it("the supported MCP entry completes the browser-approved saved action once and records its outcome", async () => {
    const f = fixture(ALL_GRANTS, true);
    const id = await f.offeredId();
    expect((await f.call("approval_resume", { id })).body).toMatchObject({
      error: { code: -32004 },
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
  it("a verified Access-only personal MCP account cancels its own run without accepting forged account prefixes", async () => {
    const f = fixture(NO_GRANTS);
    f.setConnectionGrants({ ...NO_GRANTS, actions: new Set(["dispatch"]) });
    const token = "c".repeat(64);
    const store = new InMemoryPersonalTokenStore();
    await store.put({
      digest: digestBearer(token),
      subject: "personal:device",
      userId: "access:device",
      email: "account@example.com",
      createdAt: 1,
    });
    f.options.auth = { tokens: { forged: { subject: "access:device" } } };
    f.options.personalTokens = store;
    f.options.personByEmail = undefined;
    const originalLookup = f.options.grantsFor!;
    f.options.grantsFor = (id) =>
      id === "mcp:access:device" ? { ...NO_GRANTS, actions: new Set(["dispatch"]) } : originalLookup(id);
    const own = f.stopRuns.create("review", {
      userId: "access:device",
      channelId: "mcp:default",
      threadKey: "mcp:default:own",
      channelVisibility: "machine",
    });
    const foreign = f.stopRuns.create("review", {
      userId: "access:other",
      channelId: "mcp:default",
      threadKey: "mcp:default:other",
      channelVisibility: "machine",
    });
    const args = { id: own.id, mode: "hard" };
    expect(
      (await f.call("runs_stop", { ...args, userId: "access:device" }, "forged", { _meta: FORM_META })).body,
    ).toMatchObject({ error: { code: -32001 } });
    const first = await f.call("runs_stop", args, token, { _meta: FORM_META });
    expect(first.body).toMatchObject({ result: { inputRequests: { approval: { params: { mode: "form" } } } } });
    expect(own.control.hardSignal.aborted).toBe(false);
    const requestState = (first.body as { result: { requestState: string } }).result.requestState;
    const approve = {
      _meta: FORM_META,
      requestState,
      inputResponses: { approval: { action: "accept", content: { decision: "approve" } } },
    };
    expect((await f.call("runs_stop", args, token, approve)).body).toMatchObject({
      result: { content: [{ text: expect.stringContaining("state: stopping") }] },
    });
    expect(own.control.hardSignal.aborted).toBe(true);
    const input = { id: foreign.id, mode: "hard" };
    const foreignOffer = await f.call("runs_stop", input, token, { _meta: FORM_META });
    const foreignState = (foreignOffer.body as { result: { requestState: string } }).result.requestState;
    expect((await f.call("runs_stop", input, token, { ...approve, requestState: foreignState })).body).toMatchObject({
      result: { content: [{ text: "⚠️ `runs stop`: no run found" }] },
    });
    expect(foreign.control.hardSignal.aborted).toBe(false);
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
    const offered = await f.call("runs_stop", { id: live.id, mode: "hard" }, "tok", { _meta: FORM_META });
    const id = (offered.body as { result: { requestState: string } }).result.requestState;
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
