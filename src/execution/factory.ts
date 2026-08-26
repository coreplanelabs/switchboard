import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { AgentDef } from "../agents/registry.js";
import { LocalExecutor, type Executor } from "./executor.js";
import { E2BExecutor } from "./e2b.js";
import { CloudflareSandboxExecutor } from "./cloudflareSandbox.js";
import { resolveGithubToken } from "./githubApp.js";

export interface ExecutionConfig {
  /**
   * "local" (default): run tools on the bot host.
   * "e2b": per-thread E2B micro-VM.
   * "cloudflare": per-thread Cloudflare Sandbox via the proxy Worker
   *   (deploy/cloudflare-sandbox/).
   */
  type?: "local" | "e2b" | "cloudflare";
  /** env var holding the sandbox provider API key/token (e2b, cloudflare) */
  apiKeyEnv?: string;
  /** sandbox idle lifetime in minutes (e2b only, default 30) */
  timeoutMinutes?: number;
  /** base URL of the sandbox proxy Worker (cloudflare only) */
  url?: string;
}

export interface ExecutorFactoryOptions {
  execution?: ExecutionConfig;
  workspaceDir: string; // local mode: base dir for per-thread workspaces
  dataDir: string; // e2b mode: where the thread->sandbox map is persisted
}

/** What executor selection knows about the run it is provisioning for.
 *  The agent's resource declarations drive whether anything is provisioned at
 *  all; repo/ref carry resident-repo inference once later units supply it. */
export interface ExecutorContext {
  threadKey: string;
  /** the resolved agent (never mutated here) */
  agent: AgentDef;
  /** inferred target repo, e.g. "org/name" — reserved, not yet populated */
  repo?: string;
  /** inferred git ref within `repo` — reserved, not yet populated */
  ref?: string;
}

export async function makeExecutor(opts: ExecutorFactoryOptions, ctx: ExecutorContext): Promise<Executor> {
  // Agents declare the resources they need (KD2). No repo declared → nothing
  // to provision: no workspace dir, no sandbox created or reconnected, no
  // credential required. The general agent (toolset "none") lands here.
  if (ctx.agent.resources?.repo !== "required") {
    return new NullExecutor(ctx.agent.name);
  }

  const { threadKey } = ctx;
  const type = opts.execution?.type ?? "local";

  if (type === "local") {
    const safe = threadKey.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const dir = resolve(opts.workspaceDir, safe);
    mkdirSync(dir, { recursive: true });
    return new LocalExecutor(dir);
  }

  if (type === "e2b") {
    const apiKeyEnv = opts.execution?.apiKeyEnv ?? "E2B_API_KEY";
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) throw new Error(`execution.type is "e2b" but ${apiKeyEnv} is not set`);
    const envs = await githubEnvs();
    return E2BExecutor.open({
      apiKey,
      threadKey,
      timeoutMs: (opts.execution?.timeoutMinutes ?? 30) * 60_000,
      statePath: resolve(opts.dataDir, "sandboxes.json"),
      envs,
      repo: ctx.repo,
      ref: ctx.ref,
    });
  }

  if (type === "cloudflare") {
    if (!opts.execution?.url) {
      throw new Error(`execution.type is "cloudflare" but execution.url is not set`);
    }
    const apiKeyEnv = opts.execution.apiKeyEnv ?? "SANDBOX_TOKEN";
    const token = process.env[apiKeyEnv];
    if (!token) throw new Error(`execution.type is "cloudflare" but ${apiKeyEnv} is not set`);
    const envs = await githubEnvs();
    return new CloudflareSandboxExecutor({
      url: opts.execution.url,
      token,
      threadKey,
      envs,
      repo: ctx.repo,
      ref: ctx.ref,
    });
  }

  throw new Error(`Unknown execution.type "${type}" (valid: local, e2b, cloudflare)`);
}

/** Executor for agents that declare no repo resource. Provisions nothing; a
 *  tool call reaching it is a wiring bug (an agent with tools but no declared
 *  resources) and surfaces as a legible tool error, not a crash. */
class NullExecutor implements Executor {
  constructor(private agentName: string) {}

  private fail(): never {
    throw new Error(
      `Agent "${this.agentName}" declares no repo resource, so it has no execution workspace. ` +
        `Declare resources: { repo: "required" } on the agent if its tools need one.`,
    );
  }

  async exec(): Promise<string> {
    this.fail();
  }
  async readFile(): Promise<string> {
    this.fail();
  }
  async writeFile(): Promise<string> {
    this.fail();
  }
}

/** GitHub credential for the sandbox env: freshly-minted App installation
 *  token when a GitHub App is configured, else static GH_TOKEN, else none. */
async function githubEnvs(): Promise<Record<string, string>> {
  const token = await resolveGithubToken();
  return token ? { GH_TOKEN: token } : {};
}
