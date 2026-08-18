import { truncate, type Executor } from "./executor.js";

// Remote execution in a Cloudflare Sandbox, via the authenticated proxy Worker
// in deploy/cloudflare-sandbox/ (the Sandbox SDK only runs inside Workers).
// One sandbox per thread — the Worker keys the Durable Object on X-Thread-Key,
// so reconnection is implicit and there is no local state file to maintain.
// Expired/slept sandboxes lose disk; repos re-clone on the next request.

export interface CloudflareSandboxOptions {
  /** Base URL of the deployed proxy Worker. */
  url: string;
  /** Bearer token shared with the Worker (SANDBOX_TOKEN secret). */
  token: string;
  threadKey: string;
  /** env vars forwarded into the sandbox (e.g. GH_TOKEN) */
  envs: Record<string, string>;
}

export class CloudflareSandboxExecutor implements Executor {
  constructor(private opts: CloudflareSandboxOptions) {}

  private async call(route: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.opts.token}`,
      "x-thread-key": this.opts.threadKey,
    };
    for (const [k, v] of Object.entries(this.opts.envs)) headers[`x-env-${k}`] = v;

    // Sandbox cold starts can 5xx on a thread's first command — retry briefly.
    const delays = [0, 3000, 6000, 12000];
    let lastErr = "";
    for (const delay of delays) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const res = await fetch(`${this.opts.url.replace(/\/$/, "")}${route}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) return data;
      lastErr = `sandbox worker ${route} HTTP ${res.status}: ${String(data.error ?? "")}`;
      if (res.status < 500) break; // 4xx is not retryable
    }
    throw new Error(lastErr);
  }

  async exec(command: string): Promise<string> {
    const r = await this.call("/exec", { command });
    const parts = [r.stdout, r.stderr].filter(Boolean).join("\n--- stderr ---\n");
    const exitCode = Number(r.exitCode ?? 0);
    if (exitCode !== 0) return truncate(`exit ${exitCode}:\n${parts}`);
    return truncate(parts || "(no output)");
  }

  async readFile(path: string): Promise<string> {
    const r = await this.call("/read", { path });
    return truncate(String(r.content ?? ""));
  }

  async writeFile(path: string, content: string): Promise<string> {
    await this.call("/write", { path, content });
    return `Wrote ${path}`;
  }
}
