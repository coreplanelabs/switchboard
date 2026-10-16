import { describe, expect, it } from "vitest";
import { CommandRegistry, bindCommands } from "../core/commandRegistry.js";
import { registerSteerCommands, type SteerCommandDeps } from "../core/commands/steer.js";
import { ALL_GRANTS } from "../core/authz/grants.js";
import { NO_GRANTS, type Grants } from "../core/authz/types.js";
import type { CoreDeps } from "../core/dispatcher.js";
import type { PersonalTokenApprovalPin } from "../core/personalToken.js";
import { digestBearer, InMemoryPersonalTokenStore } from "../mcp/personalTokens.js";
import { connectionIdentity } from "./mcpApproval.js";
import { handleMcpRequest, type McpOptions } from "./mcp.js";

const approved = {
  version: 1 as const,
  issuer: "https://access.test",
  audience: "application",
  organization: "installation",
  subject: "alice",
};
const bearer = "a".repeat(64);
async function fixture() {
  const store = new InMemoryPersonalTokenStore();
  await store.put({
    digest: digestBearer(bearer),
    subject: "personal:alice",
    email: "unused@example.test",
    userId: "access:alice",
    createdAt: 1,
    approval: approved,
  });
  let pin: PersonalTokenApprovalPin | undefined = approved;
  const grants = new Map<string, Grants>([
    ["mcp:personal:alice", ALL_GRANTS],
    ["access:alice", ALL_GRANTS],
  ]);
  const calls: { run: string; actor: string; user?: string }[] = [];
  const registry = new CommandRegistry<SteerCommandDeps>({ audit: () => {} });
  registerSteerCommands(registry);
  const commands = bindCommands(registry, {
    steer: {
      send: async (run, _words, input) => {
        calls.push({ run, actor: input.actor.id, user: input.actor.asUser?.id });
        return "folded";
      },
    },
  });
  const deps = {
    config: { config: {}, grantsFor: (id: string) => grants.get(id) ?? NO_GRANTS },
  } as unknown as CoreDeps;
  const options: McpOptions = { auth: { tokens: {} }, personalTokens: store, commands, personalApprovalPin: () => pin };
  const call = () =>
    handleMcpRequest(
      {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "steer_run", arguments: { id: "existing-run", words: "Continue" } },
        }),
      },
      deps,
      options,
    );
  return {
    store,
    options,
    calls,
    grants,
    call,
    setPin: (value: PersonalTokenApprovalPin | undefined) => {
      pin = value;
    },
  };
}
describe("personal MCP current realm", () => {
  it("executes a typed tool only for the current approved realm and both current principals", async () => {
    const s = await fixture();
    expect((await s.call()).body).toMatchObject({
      result: { content: [{ text: expect.stringContaining("steer.run: ok") }] },
    });
    expect(s.calls).toEqual([{ run: "existing-run", actor: "mcp:personal:alice", user: "access:alice" }]);
    for (const pin of [
      undefined,
      { ...approved, issuer: "https://other.test" },
      { ...approved, audience: "other-app" },
      { ...approved, organization: "other-org" },
    ]) {
      s.setPin(pin);
      expect((await s.call()).status).toBe(401);
    }
    s.setPin(approved);
    for (const actor of ["mcp:personal:alice", "access:alice"]) {
      s.grants.set(actor, NO_GRANTS);
      expect((await s.call()).body).toMatchObject({ error: { data: { code: "unauthorized" } } });
      s.grants.set(actor, ALL_GRANTS);
    }
    expect(s.calls).toEqual([{ run: "existing-run", actor: "mcp:personal:alice", user: "access:alice" }]);
  });
  it("rechecks the current pin after credential lookup and refuses revoked or legacy personal metadata", async () => {
    const s = await fixture();
    expect(await connectionIdentity(digestBearer(bearer), s.options)).toEqual({
      subject: "personal:alice",
      email: "unused@example.test",
      verifiedUserId: "access:alice",
    });
    const get = s.store.get.bind(s.store);
    s.store.get = async (digest) => {
      const token = await get(digest);
      s.setPin({ ...approved, audience: "changed" });
      return token;
    };
    expect(await connectionIdentity(digestBearer(bearer), s.options)).toBeUndefined();
    s.store.get = async (digest) => {
      const token = await get(digest);
      return token ? { ...token, digest: "b".repeat(64) } : null;
    };
    s.setPin(approved);
    expect(await connectionIdentity(digestBearer(bearer), s.options)).toBeUndefined();
    s.store.get = get;
    s.setPin(approved);
    await s.store.delete(digestBearer(bearer), "personal:alice");
    expect((await s.call()).status).toBe(401);
    await s.store.put({
      digest: digestBearer(bearer),
      subject: "personal:alice",
      email: "unused@example.test",
      userId: "access:alice",
      createdAt: 1,
    });
    expect((await s.call()).status).toBe(401);
    const legacy = { ...s.options, personalApprovalPin: undefined };
    expect(await connectionIdentity(digestBearer(bearer), legacy)).toEqual({
      subject: "personal:alice",
      email: "unused@example.test",
      verifiedUserId: "access:alice",
    });
    expect(s.calls).toEqual([]);
  });
});
