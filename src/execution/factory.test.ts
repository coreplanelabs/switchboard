import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENTS } from "../agents/registry.js";
import { CloudflareSandboxExecutor } from "./cloudflareSandbox.js";
import { LocalExecutor } from "./executor.js";
import { makeExecutor, type ExecutorFactoryOptions } from "./factory.js";

// Feature: features/execution.md — per-agent executor provisioning: agents
// declare the resources they need (AgentDef.resources); an agent that declares
// no repo gets a null executor and no sandbox/workspace is ever provisioned.

function dirs(): Pick<ExecutorFactoryOptions, "workspaceDir" | "dataDir"> {
  const dir = mkdtempSync(join(tmpdir(), "swb-factory-"));
  return { workspaceDir: join(dir, "workspaces"), dataDir: join(dir, "data") };
}

const ctx = (agentName: string) => ({ threadKey: "slack:CX:1.0", agent: AGENTS[agentName] });

describe("makeExecutor per-agent provisioning", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("an agent declaring no repo gets a null executor with cloudflare configured (no sandbox call, no token needed)", async () => {
    // Missing credential + poisoned fetch: any attempt to touch the Cloudflare
    // path would throw or call the network. Neither may happen for general.
    vi.stubEnv("SANDBOX_TOKEN", "");
    const fetchSpy = vi.fn(() => {
      throw new Error("unexpected network call");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const ex = await makeExecutor(
      { execution: { type: "cloudflare", url: "https://sandbox.example" }, ...dirs() },
      ctx("general"),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    // Tools reaching a resource-less agent's executor is a config bug — it
    // must surface legibly, not crash or provision anything.
    await expect(ex.exec("echo hi")).rejects.toThrow(/no repo resource/);
  });

  it("an agent declaring no repo gets a null executor with e2b configured (no API key needed)", async () => {
    vi.stubEnv("E2B_API_KEY", "");
    const ex = await makeExecutor({ execution: { type: "e2b" }, ...dirs() }, ctx("general"));
    await expect(ex.readFile("x")).rejects.toThrow(/no repo resource/);
  });

  it("an agent declaring no repo creates no workspace directory in local mode", async () => {
    const d = dirs();
    await makeExecutor({ ...d }, ctx("general"));
    expect(existsSync(d.workspaceDir)).toBe(false);
  });

  it("a repo-requiring agent gets a LocalExecutor with a per-thread workspace (local)", async () => {
    const d = dirs();
    const ex = await makeExecutor({ ...d }, ctx("coding"));
    expect(ex).toBeInstanceOf(LocalExecutor);
    expect(existsSync(join(d.workspaceDir, "slack_CX_1.0"))).toBe(true);
  });

  it("a repo-requiring agent gets the Cloudflare backend when configured", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", ""); // keep githubEnvs off the network
    const ex = await makeExecutor(
      { execution: { type: "cloudflare", url: "https://sandbox.example" }, ...dirs() },
      ctx("review"),
    );
    expect(ex).toBeInstanceOf(CloudflareSandboxExecutor);
  });

  it("a repo-requiring agent with e2b configured but no API key still fails legibly", async () => {
    vi.stubEnv("E2B_API_KEY", "");
    await expect(makeExecutor({ execution: { type: "e2b" }, ...dirs() }, ctx("coding"))).rejects.toThrow(
      /E2B_API_KEY is not set/,
    );
  });
});
