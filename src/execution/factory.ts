import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { LocalExecutor, type Executor } from "./executor.js";
import { E2BExecutor } from "./e2b.js";

export interface ExecutionConfig {
  /** "local" (default): run tools on the bot host. "e2b": per-thread micro-VM. */
  type?: "local" | "e2b";
  /** env var holding the sandbox provider API key (e2b only) */
  apiKeyEnv?: string;
  /** sandbox idle lifetime in minutes (e2b only, default 30) */
  timeoutMinutes?: number;
}

export interface ExecutorFactoryOptions {
  execution?: ExecutionConfig;
  workspaceDir: string; // local mode: base dir for per-thread workspaces
  dataDir: string; // e2b mode: where the thread->sandbox map is persisted
}

export async function makeExecutor(
  opts: ExecutorFactoryOptions,
  threadKey: string,
): Promise<Executor> {
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
    const envs: Record<string, string> = {};
    if (process.env.GH_TOKEN) envs.GH_TOKEN = process.env.GH_TOKEN;
    return E2BExecutor.open({
      apiKey,
      threadKey,
      timeoutMs: (opts.execution?.timeoutMinutes ?? 30) * 60_000,
      statePath: resolve(opts.dataDir, "sandboxes.json"),
      envs,
    });
  }

  throw new Error(`Unknown execution.type "${type}" (valid: local, e2b)`);
}
