// Sandbox proxy Worker: fronts per-thread Cloudflare Sandboxes with a minimal
// authenticated HTTP API the bot's CloudflareSandboxExecutor calls.
//
//   POST /exec   { command }         -> { stdout, stderr, exitCode }
//   POST /read   { path }            -> { content }
//   POST /write  { path, content }   -> { ok: true }
//
// Every request carries:
//   Authorization: Bearer <SANDBOX_TOKEN>   (wrangler secret put SANDBOX_TOKEN)
//   X-Thread-Key: <threadKey>               (one sandbox per conversation thread)
//   X-Env-GH_TOKEN: <token>                 (optional; forwarded into the sandbox env)
//
// The Sandbox SDK only runs inside Workers — that's why this proxy exists.
// Verify method names against https://developers.cloudflare.com/sandbox/ on
// first deploy; the SDK is young and its surface may shift.
import { getSandbox, Sandbox } from "@cloudflare/sandbox";

export class SwitchboardSandbox extends Sandbox {}

interface Env {
  Sandbox: DurableObjectNamespace<SwitchboardSandbox>;
  SANDBOX_TOKEN: string;
}

const WORKDIR = "/workspace";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = request.headers.get("authorization");
    if (!env.SANDBOX_TOKEN || auth !== `Bearer ${env.SANDBOX_TOKEN}`) {
      return json({ error: "unauthorized" }, 401);
    }
    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    const threadKey = request.headers.get("x-thread-key");
    if (!threadKey) return json({ error: "missing X-Thread-Key" }, 400);

    // One sandbox per thread; the DO name is the thread key.
    const sandbox = getSandbox(env.Sandbox, threadKey);

    // Optional env passthrough (e.g. GH_TOKEN) — set on the sandbox process env.
    const envVars: Record<string, string> = {};
    for (const [k, v] of request.headers.entries()) {
      if (k.toLowerCase().startsWith("x-env-")) envVars[k.slice(6).toUpperCase()] = v;
    }

    const url = new URL(request.url);
    const body = (await request.json().catch(() => ({}))) as Record<string, string>;

    // Env injection is inline per command (base64-safe export prefix): the
    // per-exec `env` option is ignored in SDK 0.3.7, and setEnvVars only
    // applies when a session is first created — inline is correct every time
    // and persists nothing in the sandbox beyond the command's lifetime.
    const envPrefix = Object.entries(envVars)
      .map(([k, v]) => `export ${k}="$(echo '${btoa(v)}' | base64 -d)" && `)
      .join("");

    try {
      switch (url.pathname) {
        case "/exec": {
          const result = await sandbox.exec(`${envPrefix}mkdir -p ${WORKDIR} && cd ${WORKDIR} && ${body.command}`);
          return json({
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            exitCode: result.exitCode ?? 0,
          });
        }
        case "/read": {
          const file = await sandbox.readFile(abs(body.path));
          return json({ content: typeof file === "string" ? file : (file?.content ?? "") });
        }
        case "/write": {
          await sandbox.writeFile(abs(body.path), body.content ?? "");
          return json({ ok: true });
        }
        default:
          return json({ error: "unknown route" }, 404);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The container server kills commands at COMMAND_TIMEOUT_MS and rejects
      // with "Command timeout: <full command>". Surface that as a failed
      // command result (shell-style exit 124) instead of a 500: the agent sees
      // what happened and can adapt, and the executor doesn't burn its 5xx
      // retry loop on a non-transient error. The raw message is dropped — it
      // embeds the full command, including the injected GH_TOKEN env prefix.
      if (url.pathname === "/exec" && /command timeout/i.test(msg)) {
        return json({
          stdout: "",
          stderr: "command timed out in the sandbox (COMMAND_TIMEOUT_MS exceeded); re-run as smaller/faster steps or background it with nohup",
          exitCode: 124,
        });
      }
      return json({ error: msg }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

function abs(p: string): string {
  if (!p) throw new Error("missing path");
  const path = p.startsWith("/") ? p : `${WORKDIR}/${p}`;
  if (!path.startsWith(WORKDIR)) throw new Error(`Path escapes workspace: ${p}`);
  return path;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
