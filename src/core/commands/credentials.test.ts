import { describe, expect, it, vi } from "vitest";
import { ALL_GRANTS } from "../authz/grants.js";
import type { Actor } from "../authz/types.js";
import { CommandRegistry, type Caller } from "../commandRegistry.js";
import type { RunsService } from "../runsService.js";
import { emptyCredentialInspection } from "../../execution/credentialInspection.js";
import { registerCredentialsCommands, type CredentialsCommandDeps } from "./credentials.js";

const admin: Actor = { kind: "user", id: "slack:operator", grants: ALL_GRANTS };
const input = {
  args: ["run-one"],
  options: { backend: "resident", repo: "example/repo", ref: "canary/test", head: "a".repeat(40) },
};
function setup() {
  const inspect = vi.fn(async () => emptyCredentialInspection());
  const getRun = vi.fn(async () => ({
    ok: true,
    value: {
      id: "run-one",
      repo: "example/repo",
      channelId: "slack:private",
      userId: "slack:owner",
      channelVisibility: "private",
      finished: false,
    },
  }));
  const deps: CredentialsCommandDeps = {
    credentials: { inspect, runs: async () => ({ getRun }) as unknown as RunsService },
  };
  const registry = new CommandRegistry<CredentialsCommandDeps>({ audit: () => {}, logError: () => {} });
  registerCredentialsCommands(registry);
  const invoke = (actor: Actor = admin, request = input) =>
    registry.invoke("credentials.inspect", request, { kind: "chat", id: actor.id, actor } as Caller, deps);
  return { inspect, getRun, invoke, registry, deps };
}

describe("credentials.inspect", () => {
  it("requires a named operator grant and refuses agents even on behalf of an admin", async () => {
    const { invoke, inspect, getRun } = setup();
    const grants = { actions: new Set(["runs:read"]), channels: "all" as const, repos: "all" as const };
    expect((await invoke({ ...admin, grants })).ok).toBe(false);
    expect((await invoke({ ...admin, kind: "agent", id: "agent:coding", onBehalfOf: admin })).ok).toBe(false);
    expect(getRun).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("masks an invisible run and refuses a finished or differently bound run", async () => {
    const { invoke, inspect, getRun } = setup();
    const actor: Actor = {
      ...admin,
      grants: { actions: new Set(["credentials:exec", "runs:read"]), channels: new Set(), repos: new Set() },
    };
    expect(await invoke(actor)).toMatchObject({ ok: false, error: "not_found" });
    expect((await invoke(admin, { ...input, options: { ...input.options, repo: "foreign/repo" } })).ok).toBe(false);
    getRun.mockResolvedValueOnce({
      ok: true,
      value: {
        id: "run-one",
        repo: "example/repo",
        channelId: "slack:private",
        userId: "slack:owner",
        channelVisibility: "private",
        finished: true,
      },
    });
    expect((await invoke()).ok).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("returns counts and booleans only and accepts no command, path, pid, env or bearer", async () => {
    const { invoke, inspect } = setup();
    const result = await invoke();
    expect(result).toMatchObject({ ok: true, value: emptyCredentialInspection() });
    for (const key of ["command", "path", "pid", "env", "bearer"]) {
      expect((await invoke(admin, { ...input, options: { ...input.options, [key]: "synthetic" } })).ok).toBe(false);
    }
    expect(inspect).toHaveBeenCalledOnce();
  });
});
