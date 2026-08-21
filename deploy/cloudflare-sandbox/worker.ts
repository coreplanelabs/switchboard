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

export class SwitchboardSandbox extends Sandbox {
  // SDK 0.3.x caches its default ExecutionSession in Durable Object memory
  // (`private defaultSession`), but the session itself lives in the
  // container's memory. When the container restarts under a live DO (image
  // rollout, crash, sleep/wake), every subsequent call fails with
  // "Session '<id>' not found" forever — the SDK never invalidates the cache.
  // Clearing it makes the next call recreate the session on the fresh
  // container. The workspace disk is gone either way; repos re-clone — the
  // same graceful degradation as an expired E2B sandbox.
  resetDefaultSession(): void {
    (this as unknown as { defaultSession: unknown }).defaultSession = null;
  }
}

// Stale-session detection. /exec throws the container's literal
// "Session '<id>' not found". /read and /write cannot: the SDK's file handler
// (container_src/handler/file.ts, createServerErrorResponse) buries that text
// in a `message` field the client discards, and throws only a generic
// "Failed to read file" / "Failed to write file". Treat those as potentially
// stale too — reads are pure and a same-content rewrite is idempotent, so a
// one-shot reset+retry is safe even when the real cause was something else
// (the retry then fails identically and the error propagates).
const STALE_SESSION = /session '[^']*' not found/i;
const STALE_FILE_OP = /^failed to (read|write) file/i;

/** Run a sandbox call; on a (possibly) stale-session error, reset the cached
 *  session and retry once. Safe to retry: the session lookup fails before the
 *  command or file op ever executes. */
async function withSessionRecovery<T>(
  sandbox: { resetDefaultSession(): void | Promise<void> },
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!STALE_SESSION.test(msg) && !STALE_FILE_OP.test(msg)) throw err;
    await sandbox.resetDefaultSession();
    return await fn();
  }
}

interface Env {
  Sandbox: DurableObjectNamespace<SwitchboardSandbox>;
  SANDBOX_TOKEN: string;
}

const WORKDIR = "/workspace";

// Per-command time limit, enforced by coreutils `timeout` inside the sandbox.
// Must stay BELOW the SDK backstop (COMMAND_TIMEOUT_MS in the Dockerfile) so
// the real exit 124 wins, and below undici's 300s client ceilings.
const EXEC_TIMEOUT_SECS = 280;

/** POSIX single-quote escaping so an arbitrary command survives `bash -c`. */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = request.headers.get("authorization");
    if (!env.SANDBOX_TOKEN || auth !== `Bearer ${env.SANDBOX_TOKEN}`) {
      return json({ error: "unauthorized" }, 401);
    }
    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    const threadKey = request.headers.get("x-thread-key");
    if (!threadKey) return json({ error: "missing X-Thread-Key" }, 400);

    // One sandbox per thread; the DO name is the thread key. getSandbox's
    // 0.3.x typing is fixed to the base Sandbox class — cast the stub so the
    // subclass's resetDefaultSession is callable over RPC.
    const sandbox = getSandbox(
      env.Sandbox as unknown as Parameters<typeof getSandbox>[0],
      threadKey,
    ) as unknown as DurableObjectStub<SwitchboardSandbox>;

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
          // Streamed with a whitespace heartbeat. A long command otherwise
          // holds a byteless HTTP request open for minutes, and some hop
          // between the bot and this Worker silently drops idle connections —
          // measured live: the container answered a 290s command at its 280s
          // timeout, but the bot's fetch died without ever seeing the
          // response (undici gives up 300s after sending a request that has
          // received no headers). Headers go out immediately and a heartbeat
          // byte flows every 15s, so no intermediary ever sees an idle
          // connection. Heartbeats are pure whitespace, which is legal around
          // a JSON document — the executor's res.json() on the full body
          // parses unchanged.
          //
          // The time limit is enforced with coreutils `timeout` INSIDE the
          // sandbox, not by the SDK: the SDK's COMMAND_TIMEOUT_MS rejection is
          // useless to callers — its exec handler wraps every failure as a
          // generic "Command execution failed" and buries the real message in
          // a field its client discards (measured live). Shell-level timeout
          // produces a real exit 124 through the normal result path, no error
          // classification needed. SIGKILL follows 10s after TERM for
          // stragglers. COMMAND_TIMEOUT_MS (Dockerfile) sits above this as a
          // pure backstop.
          const full = `${envPrefix}mkdir -p ${WORKDIR} && cd ${WORKDIR} && ${body.command}`;
          return streamExec(
            sandbox,
            `timeout -k 10 ${EXEC_TIMEOUT_SECS} bash -c ${shellQuote(full)}`,
          );
        }
        case "/read": {
          const file = await withSessionRecovery(sandbox, () => sandbox.readFile(abs(body.path)));
          return json({ content: typeof file === "string" ? file : (file?.content ?? "") });
        }
        case "/write": {
          await withSessionRecovery(sandbox, () => sandbox.writeFile(abs(body.path), body.content ?? ""));
          return json({ ok: true });
        }
        default:
          return json({ error: "unknown route" }, 404);
      }
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/** Execute a command and stream the response: immediate headers, a whitespace
 *  heartbeat every 15s while the command runs, then one JSON document. All
 *  outcomes arrive in-body with HTTP 200 (headers are long gone by the time
 *  the result is known): a completed command as {stdout, stderr, exitCode},
 *  a sandbox-enforced timeout as exit 124, and any other failure as {error}. */
function streamExec(
  sandbox: { resetDefaultSession(): void | Promise<void>; exec(command: string): Promise<{ stdout?: string; stderr?: string; exitCode?: number }> },
  command: string,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const beat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode("\n"));
        } catch {
          clearInterval(beat); // client went away; the exec promise still settles
        }
      }, 15_000);
      const finish = (payload: object) => {
        clearInterval(beat);
        try {
          controller.enqueue(encoder.encode(JSON.stringify(payload)));
          controller.close();
        } catch {
          // stream already errored/cancelled — nothing left to deliver to
        }
      };
      withSessionRecovery(sandbox, () => sandbox.exec(command))
        .then((result) => {
          const exitCode = result.exitCode ?? 0;
          // coreutils `timeout` exits 124 when the deadline killed the
          // command (137 when the follow-up SIGKILL had to) — annotate so the
          // agent knows what happened and how to adapt.
          const timedOut = exitCode === 124 || exitCode === 137;
          const note = timedOut
            ? `command timed out in the sandbox after ${EXEC_TIMEOUT_SECS}s; re-run as smaller/faster steps or background it with nohup`
            : "";
          finish({
            stdout: result.stdout ?? "",
            stderr: [result.stderr ?? "", note].filter(Boolean).join("\n"),
            exitCode: timedOut ? 124 : exitCode,
          });
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          // Carry the failure in BOTH shapes so rollout order can't create
          // a silent-success window: a new executor throws on `error`, and
          // an executor that predates in-body errors (only checks exitCode)
          // still renders "exit 127: <message>" instead of "(no output)".
          finish({ error: msg, stdout: "", stderr: msg, exitCode: 127 });
        });
    },
  });
  return new Response(stream, { headers: { "content-type": "application/json" } });
}

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
