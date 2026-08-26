import { truncate, type Executor } from "./executor.js";

// Remote execution against a resident repo environment — the always-warm
// per-repo service behind the resident Worker (deploy/cloudflare-resident/).
// Unlike the per-thread sandbox Worker, every route POSTs a JSON body carrying
// {resource, threadKey} (never thread/env headers — the resident ignores
// x-env-* by design), and per-thread state is a git worktree bound to a sticky
// ref inside the resident, not a whole sandbox.
//
// U4 route contracts this client implements:
//   /attach {resource, threadKey, refHint?} → 200 attach result
//     | 409 {needs:"ref"} (thread has no ref binding — ask the user)
//     | 400 unknown-ref/pattern | 404 not onboarded | 503 mirror-busy | 429 pool
//   /exec {resource, threadKey, command} → streamed HTTP 200: whitespace
//     heartbeats then ONE JSON document {stdout, stderr, exitCode, truncated};
//     post-validation failures arrive IN-BODY as {error, needs?, exitCode:127}
//     — parse the body, never trust the status.
//   /read {resource, threadKey, path} → {content, truncated} | 409 needs-attach
//   /write {resource, threadKey, path, content} → {ok, bytes} | same errors
//
// needs:"attach" means the worktree was evicted or the container disk was
// recycled; the binding survives in the resident's storage, so one re-attach
// recreates the tree on the same ref — this client auto-re-attaches ONCE and
// retries, then fails legibly.

export interface ResidentExecutorOptions {
  /** Base URL of the resident Worker. */
  baseUrl: string;
  /** Operator bearer (RESIDENT_OPERATOR_TOKEN secret). */
  token: string;
  /** Resource id, e.g. "repo:jshttp/vary". */
  resource: string;
  threadKey: string;
  /** Ref for a first attach; an existing thread binding always wins over it. */
  refHint?: string;
}

/** Result of a /status probe: a definite lifecycle answer, or an unreachable
 *  marker. `transport: true` means the failure was network-level (fetch threw
 *  or timed out) — the only kind the factory's negative cache may store. */
export type ResidentStatusProbe =
  | { kind: "status"; state: string; reason: string }
  | { kind: "unreachable"; error: string; transport: boolean };

export class ResidentExecutor implements Executor {
  constructor(private opts: ResidentExecutorOptions) {}

  /** Attach-on-open: bind (or reuse) the thread's worktree before the first
   *  tool call, so needs-ref / not-onboarded surface at selection time as
   *  legible errors instead of mid-run tool failures. */
  static async open(opts: ResidentExecutorOptions): Promise<ResidentExecutor> {
    const ex = new ResidentExecutor(opts);
    await ex.attach();
    return ex;
  }

  /** One operator-scope GET /status, bounded by timeoutMs. Never throws. */
  static async probeStatus(
    baseUrl: string,
    token: string,
    resource: string,
    timeoutMs: number,
  ): Promise<ResidentStatusProbe> {
    const url = `${baseUrl.replace(/\/$/, "")}/status?resource=${encodeURIComponent(resource)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // network failure or probe timeout — not-warm, and negative-cacheable
      return { kind: "unreachable", error: err instanceof Error ? err.message : String(err), transport: true };
    }
    if (res.status === 404) {
      // a definite answer (resource not onboarded), never a service failure
      return { kind: "status", state: "not-onboarded", reason: "" };
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { kind: "unreachable", error: `probe HTTP ${res.status}: ${String(data.error ?? "")}`, transport: false };
    }
    return { kind: "status", state: String(data.state ?? "unknown"), reason: String(data.reason ?? "") };
  }

  /** POST one route; resource + threadKey ride in every body. Reads the FULL
   *  body as text before parsing: /exec streams heartbeat whitespace and then
   *  exactly one JSON document, always over HTTP 200. */
  private async call(
    route: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.token}`,
        },
        body: JSON.stringify({ resource: this.opts.resource, threadKey: this.opts.threadKey, ...body }),
      });
    } catch (err) {
      // Network-level failure: the command may still be running (or have run)
      // in the resident — never blind-retry a possibly side-effectful call.
      throw new Error(
        `resident worker ${route} request failed (${err instanceof Error ? err.message : String(err)}). ` +
          "The operation may still have run in the resident; re-check its effects before re-running it.",
      );
    }
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text.trim() || "{}") as Record<string, unknown>;
    } catch {
      // non-JSON body (edge error page); the caller surfaces the HTTP status
    }
    return { status: res.status, data };
  }

  /** Bind/reuse this thread's worktree. Legible errors for every named
   *  refusal the service can answer with. */
  async attach(): Promise<void> {
    const body: Record<string, unknown> = {};
    if (this.opts.refHint) body.refHint = this.opts.refHint;
    const { status, data } = await this.call("/attach", body);
    if (status === 200) return;
    const err = String(data.error ?? `HTTP ${status}`);
    if (status === 409 && data.needs === "ref") {
      throw new Error(
        `the ${this.opts.resource} resident needs a branch for this thread: no ref is bound yet. ` +
          `Name the branch to work on (e.g. "on main") and try again.`,
      );
    }
    if (status === 404) {
      throw new Error(`resident attach: ${this.opts.resource} is not onboarded (${err})`);
    }
    throw new Error(`resident attach failed for ${this.opts.resource}: ${err}`);
  }

  /** Run a route; on needs:"attach" (evicted/recycled worktree, in-body for
   *  /exec, 409 for /read //write) re-attach ONCE and retry, then fail legibly. */
  private async opWithReattach(
    route: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    let r = await this.call(route, body);
    if (r.data.needs === "attach") {
      await this.attach();
      r = await this.call(route, body);
      if (r.data.needs === "attach") {
        throw new Error(
          `resident ${route}: worktree still unavailable after a re-attach (${String(r.data.error ?? "")}) — ` +
            "the resident may be mid-restore; try again shortly.",
        );
      }
    }
    return r;
  }

  async exec(command: string): Promise<string> {
    const { status, data } = await this.opWithReattach("/exec", { command });
    if (typeof data.error === "string" && data.error) {
      // post-validation failure (exitCode 127 shape) — legible, never retried
      throw new Error(`resident /exec: ${data.error}`);
    }
    if (status !== 200) throw new Error(`resident /exec HTTP ${status}`);
    const parts = [data.stdout, data.stderr].filter(Boolean).join("\n--- stderr ---\n");
    const exitCode = Number(data.exitCode ?? 0);
    if (exitCode !== 0) return truncate(`exit ${exitCode}:\n${parts}`);
    return truncate(parts || "(no output)");
  }

  async readFile(path: string): Promise<string> {
    const { status, data } = await this.opWithReattach("/read", { path });
    if (status !== 200) throw new Error(`resident /read: ${String(data.error ?? `HTTP ${status}`)}`);
    return truncate(String(data.content ?? ""));
  }

  async writeFile(path: string, content: string): Promise<string> {
    const { status, data } = await this.opWithReattach("/write", { path, content });
    if (status !== 200) throw new Error(`resident /write: ${String(data.error ?? `HTTP ${status}`)}`);
    return `Wrote ${path}`;
  }
}
