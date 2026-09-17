import { execFile } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { OperationResult, Operations, OpName } from "../core/operations.js";
import { BASH_TIMEOUT_MS, bashTimeoutNote, clampBashTimeout } from "./bashTimeout.js";
import { MAX_READ_BYTES, tooLargeMessage } from "./binaryRead.js";
import type { Span } from "../core/trace/types.js";
import { systemClock } from "../core/trace/clock.js";
import type { PushedBranch } from "./residentRebind.js";
import type { LeftBehind } from "./residentCleanliness.js";
import { publicEnv } from "../secrets.js";

// The timeout policy (default/floor/ceiling + clamp) lives in bashTimeout.ts
// so the deploy Workers can bundle it; re-exported here for the many callers
// that know the Executor seam, not the policy module.
export { BASH_TIMEOUT_MS, BASH_TIMEOUT_MAX_MS, EXEC_CALL_MARGIN_MS, clampBashTimeout } from "./bashTimeout.js";

// The Executor is the seam between agents and where their commands actually
// run. Tools never touch the filesystem or spawn processes directly — they
// call an Executor, which is either the local host (dev/CLI) or a remote
// per-thread sandbox (production).

/** The caller's span — the tool call's `exec.*` span — so an executor's own
 *  outbound calls become its `http.client` children (docs/reference/specs/tracing.md item
 *  21). Absent from a caller with no trace: the call is then a plain fetch. */
export interface ExecTraceOptions {
  span?: Span;
}

/** What a release tells the workspace's owner beside the trace: the branches
 *  the run pushed and the pull requests they head (docs/reference/specs/
 *  resident-repos.md item 16a) — read off the run's own `pr_opened` events,
 *  so the resident's thread remembers its own branches past the tree a clean
 *  release removes. Absent, or empty, when the run pushed nothing. */
export interface ReleaseOptions extends ExecTraceOptions {
  pushed?: readonly PushedBranch[];
}

export interface Executor {
  /** Run a shell command; returns combined output (never throws on non-zero
   *  exit). `opts.signal` is a hard run stop: an implementation that can
   *  cancel the underlying command does so and returns/throws promptly; one that
   *  cannot simply ignores it — the runner stops waiting on it either way. */
  exec(command: string, opts?: ExecOptions): Promise<string>;
  /** Read a file, path relative to the execution workspace. */
  readFile(path: string, opts?: ExecTraceOptions): Promise<string>;
  /** Write a file (creating parent dirs), path relative to the workspace. */
  writeFile(path: string, content: string, opts?: ExecTraceOptions): Promise<string>;
  /** Optional: read a file as bytes — a screenshot, a PDF the run produced —
   *  whole, up to `MAX_READ_BYTES` (src/execution/binaryRead.ts); a larger file
   *  throws by name, since a binary cannot be truncated the way `readFile`'s
   *  text is. Absent on an executor whose transport has no byte path: a tool
   *  that needs it then says so instead of decoding a text view. */
  readBytes?(path: string, opts?: ExecTraceOptions): Promise<Uint8Array>;
  /** Optional: give back whatever the run held for this thread once it ends
   *  (a resident's pool user + worktree). A run starts from a clean tree, so
   *  nothing in the workspace outlives the run either way: "if-idle" — the
   *  run's normal end — keeps the workspace only while a command is still in
   *  flight in it, and answers what the release discarded; "always" — a
   *  read-only agent, a hard stop — ends what is in flight and releases now.
   *  Best-effort: implementations report, never throw. */
  release?(mode: ReleaseMode, opts?: ReleaseOptions): Promise<ReleaseResult>;
  /** Optional: bring the workspace to `sha` — the PR head that moved while a
   *  review ran (agent-review.md item 12) — fetching as needed, and answer the
   *  commit the workspace is now at (which may differ if the ref moved again).
   *  Absent on executors whose workspace the model manages itself (a sandbox
   *  clone): the dispatcher then tells the model to check the commit out. */
  moveTo?(sha: string, opts?: ExecTraceOptions): Promise<{ sha: string }>;
}

export interface ExecOptions extends ExecTraceOptions {
  /** Aborted when the run is hard-stopped; cancel the command if you can. */
  signal?: AbortSignal;
  /** Extra environment for this one command, handed to the process by the
   *  executor's own env channel — the remote Workers' per-exec `env` option,
   *  the local child's environment — and never onto the command text
   *  (docs/reference/specs/harness-pi.md item 4: the pi harness hands the run
   *  bearer this way). Locally the child then gets the PUBLIC environment plus
   *  these, never the host's secrets; absent → the command runs as it always did. */
  env?: Record<string, string>;
  /** Per-call command budget in ms (the bash tool's `timeoutMs`), already
   *  clamped to [1s, BASH_TIMEOUT_MAX_MS] by the tool layer; implementations
   *  re-clamp defensively (`clampBashTimeout`). Absent → BASH_TIMEOUT_MS, the
   *  exact pre-timeoutMs behavior. */
  timeoutMs?: number;
}

/** The per-call deadline for a remote route, joined with an optional hard-stop
 *  signal: whichever fires first aborts the fetch — and, because the
 *  same signal is what `fetch` hands the response body, the body read too.
 *  A plain timer rather than `AbortSignal.timeout`: Node runs that one on an
 *  internal timer that neither fake timers nor a test can observe, so a
 *  deadline built on it could never be proven to fire. The timer is
 *  unref'd (it never holds the process open) and dropped as soon as the
 *  hard stop wins the race. */
export function execDeadline(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const deadline = new AbortController();
  const onStop = () => clearTimeout(timer);
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onStop);
    deadline.abort(new DOMException(`the ${Math.round(timeoutMs / 1000)}s call deadline passed`, "TimeoutError"));
  }, timeoutMs);
  timer.unref?.();
  if (!signal) return deadline.signal;
  signal.addEventListener("abort", onStop, { once: true });
  return AbortSignal.any([deadline.signal, signal]);
}

export type ReleaseMode = "always" | "if-idle";
export interface ReleaseResult {
  released: boolean;
  /** Why the workspace was kept (or why release failed) — for the log line. */
  reason?: string;
  /** What the released workspace still held — uncommitted changes, unpushed
   *  commits — now gone with it (docs/reference/specs/resident-repos.md item
   *  16a); for the log line. Absent when nothing was left, or the workspace's
   *  owner could not measure it. */
  leftBehind?: LeftBehind;
}

/** An exec-INFRASTRUCTURE failure: the sandbox/exec transport itself failed —
 *  unreachable, an HTTP error, an in-body worker error (the sandbox's
 *  "Command execution failed" / exitCode 127 signal), or a worktree that stays
 *  unrecoverable after re-attach. This is categorically different from a normal
 *  nonzero command exit, which every Executor returns as ordinary output text
 *  and NEVER as a throw. Remote executors throw this (not a bare `Error`) for
 *  infra failures so a caller can tell a wedged sandbox from a command the
 *  agent should keep handling — the pi harness's container operations and the
 *  relayed tools read it as a failure of the operation, named. Extends
 *  `Error`, so `err.message`/`instanceof Error` callers are unaffected. */
export class ExecInfraError extends Error {
  readonly infra = true as const;
  constructor(
    message: string,
    /** Why, as a type the harness's one more command waits on (`EXEC_INFRA_WAITABLE`), never the prose. */
    readonly reason: ExecInfraReason,
  ) {
    super(message);
    this.name = "ExecInfraError";
  }
}

/** Why an executor's infra failure happened, typed at the one place that knows
 *  — the executor building the error — so the harness's one more command
 *  (docs/reference/specs/harness.md item 6) decides by the type, never by the
 *  prose: a wording no test copied from the executor cannot match a regex it
 *  was written to fit. `transport-lost`: the request to the Worker failed on
 *  its transport (a network failure, the connection dropped). `deadline-passed`:
 *  the call's or the send's deadline passed with no answer. `empty-failure`:
 *  the Worker's failure shape with its text missing (the rollout's
 *  previous-image answer, execution.md item 3). `worker-unavailable`: an HTTP
 *  5xx from the Worker — the isolate rolling under a deploy, the resident
 *  mid-restore or its mirror mutex held by a refresh — unless the body names a
 *  refusal (the resident client's `residentAnswerReason`). Those four a wait
 *  can clear (`EXEC_INFRA_WAITABLE`). `answered`: the Worker answered a
 *  failure by name in its body on a status that is not a 5xx — the resident
 *  forwarding the SDK's words ("The container is not running", "Peer closed
 *  WebSocket"), the sandbox's "Command execution failed" — whose meaning is in
 *  the words, so the seam reads the container-down ones and waits on nothing
 *  else. `refused`: a refusal no wait clears — an HTTP 4xx, a worktree still
 *  gone after the one re-attach, the deploy-storm streak guard, a strike after
 *  the wake wait, the resident `down` or the resource unregistered behind a
 *  5xx — judged at once by the type, whatever its words. `aborted`: the run's
 *  own stop aborted the request; nothing is wrong with the Worker and nothing
 *  waits. */
export const EXEC_INFRA_REASONS = [
  "transport-lost",
  "deadline-passed",
  "empty-failure",
  "worker-unavailable",
  "answered",
  "refused",
  "aborted",
] as const;
export type ExecInfraReason = (typeof EXEC_INFRA_REASONS)[number];

/** The reasons a wait can clear: the failure reached no Worker, or reached one that could not serve yet. */
export const EXEC_INFRA_WAITABLE: ReadonlySet<ExecInfraReason> = new Set<ExecInfraReason>([
  "transport-lost",
  "deadline-passed",
  "empty-failure",
  "worker-unavailable",
]);

/** Whether a wait may clear this infra failure (`EXEC_INFRA_WAITABLE`). */
export function infraMayClear(err: ExecInfraError): boolean {
  return EXEC_INFRA_WAITABLE.has(err.reason);
}

/** The reason for an HTTP status the Worker answered: a 5xx is the Worker
 *  unavailable (a wait may clear it), anything else a refusal. */
export function infraReasonOfStatus(status: number): ExecInfraReason {
  return status >= 500 && status <= 599 ? "worker-unavailable" : "refused";
}

/** The reason for a request that failed before or while the Worker answered:
 *  the run's own stop when its signal has fired (`aborted` — the fetch rejects
 *  with the stop's reason, whatever its name, so the signal decides before the
 *  error does), else the deadline's own abort (`execDeadline`'s `TimeoutError`)
 *  or the transport. */
export function infraReasonOfRequestFailure(err: unknown, signal?: AbortSignal): ExecInfraReason {
  if (signal?.aborted) return "aborted";
  return err instanceof Error && err.name === "TimeoutError" ? "deadline-passed" : "transport-lost";
}

/** The one sentence every resident or sandbox client says for a request that
 *  failed on its transport, hit its deadline or was aborted, before or while
 *  the other side answered: `subject` is who asked (`resident worker`,
 *  `sandbox worker`, `resident admin`), `host` is where the operation may have
 *  run (`resident`, `sandbox`), `recheck` how the caller looks before it
 *  re-runs anything. The tests that assert the harness waits on this failure
 *  build their fixtures from it — never a retyped copy, never wordings
 *  drifting apart. */
export function requestFailedSentence(
  subject: string,
  host: "resident" | "sandbox",
  route: string,
  err: unknown,
  recheck: string,
): string {
  return (
    `${subject} ${route} request failed (${err instanceof Error ? err.message : String(err)}). ` +
    `The operation may still have run, or still be running, in the ${host}; ${recheck} before re-running it.`
  );
}

/** The two remote executors' request-failed words: the Worker's name as the
 *  subject, the Worker as the host, the effects to re-check. */
export function requestFailedMessage(worker: "resident" | "sandbox", route: string, err: unknown): string {
  return requestFailedSentence(`${worker} worker`, worker, route, err, "re-check its effects");
}

/** An exec-CAPACITY failure: the sandbox fleet had no free instance for this
 *  thread within the executor's bounded wait (docs/reference/specs/execution.md item 14).
 *  Nothing ran and nothing is broken — the fleet's `max_instances` is reached
 *  — so this is deliberately NOT an `ExecInfraError`: a caller that reads
 *  infra failures as a dead sandbox must not read this one so. `extends
 *  Error` so message/`instanceof Error` callers are unaffected. */
export class ExecCapacityError extends Error {
  readonly capacity = true as const;
  constructor(message: string) {
    super(message);
    this.name = "ExecCapacityError";
  }
}

/** The container under a live run was replaced — the executor's one typed word
 *  for it, whatever the resident said (docs/reference/specs/resident-repos.md
 *  items 65, 43 and 27): the container exited inside a rollout and the
 *  executor waited for the wake and re-attached before the command ran
 *  (`waitedMs` the wait, `message` the fresh worktree's ref and sha); or a
 *  deploy swapped the runtime under a command in flight (`runtime-replaced`),
 *  or the preflight found the container disk recycled (`worktree-missing`) —
 *  then thrown at once, no wait (`waitedMs` 0) and no recovery first,
 *  `message` the resident's own words. Deliberately NOT an `ExecInfraError`:
 *  a replacement is not a dead sandbox. The command was never re-issued. The
 *  pi harness reads it as the container replaced under the run (harness-pi.md
 *  item 16): pi ran inside the old container and is gone with it, so the call
 *  in flight is settled with the restart note, the run ends `interrupted` and
 *  its request is dispatched again as a new run. */
export class ExecSandboxRestartedError extends Error {
  readonly restarted = true as const;
  constructor(
    message: string,
    readonly waitedMs: number,
  ) {
    super(message);
    this.name = "ExecSandboxRestartedError";
  }
}

/** The resident's own Durable Object reset under a command in flight (a Worker
 *  deploy) while the container kept running (docs/reference/specs/resident-repos.md
 *  item 43; the resident's `reason:"control-reset"`): the command's outcome is
 *  unknown but the container and every process the run holds in it are
 *  unchanged. Deliberately NOT an `ExecInfraError` (not a dead sandbox) and NOT
 *  an `ExecSandboxRestartedError` (not a replacement, so never the replaced
 *  verdict): the harness re-sends an idempotent op and resolves a write by
 *  pi's echo (harness-pi.md item 16), and never orphans a live pi. */
export class ExecControlResetError extends Error {
  readonly controlReset = true as const;
  constructor(message: string) {
    super(message);
    this.name = "ExecControlResetError";
  }
}

const MAX_OUTPUT = 120_000;

export function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n...[truncated ${s.length - MAX_OUTPUT} chars]` : s;
}

/** Runs everything on the local host inside a confined workspace directory. */
export class LocalExecutor implements Executor {
  constructor(private workspaceDir: string) {}

  private confine(p: string): string {
    const abs = resolve(this.workspaceDir, p);
    if (abs !== this.workspaceDir && !abs.startsWith(this.workspaceDir + "/")) {
      throw new Error(`Path escapes workspace: ${p}`);
    }
    return abs;
  }

  async exec(command: string, opts?: ExecOptions): Promise<string> {
    const timeoutMs = clampBashTimeout(opts?.timeoutMs);
    const r = await runBash(command, this.workspaceDir, opts?.signal, timeoutMs, opts?.env);
    const parts = [r.stdout, r.stderr].filter(Boolean).join("\n--- stderr ---\n");
    if (r.timedOut) {
      // Name the limit that fired (not a generic abort) so the model can
      // self-correct: 124 is the exit code coreutils `timeout` uses too.
      return truncate(`exit 124: ${bashTimeoutNote(timeoutMs)}\n${parts}`);
    }
    if (r.error) {
      return truncate(`exit ${r.error.code ?? "error"}: ${r.error.message}\n${parts}`);
    }
    return truncate(parts || "(no output)");
  }

  async readFile(path: string): Promise<string> {
    return truncate(readFileSync(this.confine(path), "utf8"));
  }

  /** The size is checked on the open handle and the bytes read from the same
   *  handle, so a file that grows between the two calls cannot slip past the cap. */
  async readBytes(path: string): Promise<Uint8Array> {
    const fd = openSync(this.confine(path), "r");
    try {
      const size = fstatSync(fd).size;
      if (size > MAX_READ_BYTES) throw new Error(tooLargeMessage(path, size));
      return new Uint8Array(readFileSync(fd));
    } finally {
      closeSync(fd);
    }
  }

  async writeFile(path: string, content: string): Promise<string> {
    const abs = this.confine(path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return `Wrote ${path}`;
  }
}

/** The bot side of a remote base64 read (src/execution/binaryRead.ts): the
 *  Worker's `/read` answer decoded to bytes. An answer without
 *  `encoding: "base64"` is a Worker that predates binary reads — it ignored
 *  the request and sent the file as text — named as such (the fix is a
 *  redeploy), never decoded as if it were base64; a `tooLarge` answer is the
 *  cap's one message. The bytes must be exactly `size`, the Worker's own
 *  measurement of the file before the read: a stream cut in transit (the
 *  sandbox SDK truncates a command's output past a limit its typings do not
 *  name) is refused as `read-inconsistent`, never handed on as the file, and an
 *  answer without a size predates the verified read. All plain errors: the
 *  model's file or the fleet's rollout, never a sick Worker. */
export function decodeBase64Read(
  answer: { content?: unknown; encoding?: unknown; tooLarge?: unknown; size?: unknown },
  at: { where: string; path: string },
): Uint8Array {
  if (answer.encoding !== "base64") {
    throw new Error(
      `${at.where}: the Worker answered a text read to a request for bytes — it predates binary reads; redeploy it`,
    );
  }
  if (answer.tooLarge === true) throw new Error(tooLargeMessage(at.path));
  if (typeof answer.size !== "number") {
    throw new Error(
      `${at.where}: the Worker answered without the file's size — it predates the verified read; redeploy it`,
    );
  }
  const bytes = new Uint8Array(Buffer.from(typeof answer.content === "string" ? answer.content : "", "base64"));
  if (bytes.byteLength !== answer.size) {
    throw new Error(
      `${at.where}: read-inconsistent — ${at.path} is ${answer.size} bytes but ${bytes.byteLength} arrived; nothing was handed on`,
    );
  }
  return bytes;
}

/** Dev-only deterministic ops against the thread's LOCAL workspace directory
 *  — the second Operations implementation (≥2-implementations invariant,
 *  docs/decisions/0001-seams-with-two-implementations.md) and the CLI-testable one. Honest about its limits: there is no
 *  onboard-time command table and no refs locally, so ops run fixed Node
 *  conventions (test → `npm test`, build → `npm run build --if-present`,
 *  status → workspace existence) against the workspace AS IT STANDS, and a
 *  requested ref is reported as ignored rather than silently dropped. A
 *  failing command is a RESULT (ok:false), never an error path. */
export class LocalOperations implements Operations {
  constructor(private workspaceDir: string) {}

  async run(op: OpName, req: { repo: string; ref?: string }): Promise<OperationResult> {
    const refNote = req.ref ? ` — ref \`${req.ref}\` ignored (local mode has no refs)` : "";
    // Local mode has no onboard-time repo binding, so "for <repo>" is a claim
    // about intent, not a verified checkout — disclose that the workspace was
    // not verified to hold req.repo, mirroring the ref-not-verified note.
    const repoNote = ` — workspace not verified to hold ${req.repo} (local mode)`;
    const exists = existsSync(this.workspaceDir);
    if (op === "status") {
      return {
        kind: "result",
        ok: exists,
        summary: exists
          ? `status: local workspace for ${req.repo} exists at ${this.workspaceDir} (dev-only — no resident lifecycle locally)${repoNote}`
          : `status: no local workspace at ${this.workspaceDir} yet (dev-only — no resident lifecycle locally)`,
      };
    }
    if (!exists) {
      return {
        kind: "result",
        ok: false,
        summary: `${op} failed: no local workspace at ${this.workspaceDir} — nothing checked out yet${refNote}`,
      };
    }
    const command = op === "test" ? "npm test" : "npm run build --if-present";
    const r = await runLocalCommand(command, this.workspaceDir);
    return {
      kind: "result",
      ok: r.exitCode === 0,
      summary:
        `${op} (\`${command}\`) ${r.exitCode === 0 ? "passed" : `failed (exit ${r.exitCode})`} ` +
        `in the local workspace for ${req.repo}${repoNote}${refNote}`,
      ...(r.output ? { output: truncate(r.output) } : {}),
    };
  }
}

async function runLocalCommand(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  const r = await runBash(command, cwd);
  const output = [r.stdout, r.stderr].filter(Boolean).join("\n--- stderr ---\n");
  const code = r.error ? (r.error.code ?? 1) : 0;
  return { exitCode: typeof code === "number" ? code : 1, output };
}

/** Shared bash spawn-and-collect (`bash -c` under the given budget — the
 *  standard 5-minute one unless the caller passes a clamped per-call value —
 *  and the standard buffer). `error` is null on a clean zero-exit run;
 *  otherwise it carries execFile's raw code (number exit code, string errno,
 *  or undefined when signal-killed) and message — each caller formats its own
 *  result. `timedOut` is true only for the budget's own kill: the child died
 *  from execFile's timeout signal (signal-killed, no error code) at or after
 *  the deadline — a hard-stop abort, a maxBuffer kill
 *  (ERR_CHILD_PROCESS_STDIO_MAXBUFFER), and ordinary nonzero exits all keep it
 *  false. An optional AbortSignal (hard run stop) kills the child; that
 *  surfaces as an `error` like any other abnormal exit — never a throw. */
function runBash(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs: number = BASH_TIMEOUT_MS,
  env?: Record<string, string>,
): Promise<{
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: { code?: number | string; message: string } | null;
}> {
  const started = systemClock();
  return new Promise((res) => {
    execFile(
      "bash",
      ["-c", command],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        ...(signal ? { signal } : {}),
        // A caller's env replaces the inherited one: the public variables plus
        // the caller's, so a command that asked for an environment of its own
        // never sees the host's secrets. Without one, inherited as always.
        ...(env ? { env: { ...publicEnv(), ...env } } : {}),
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; signal?: string | null }) | null;
        res({
          stdout,
          stderr,
          timedOut:
            e != null &&
            // Node marks ITS OWN kill (the `timeout` option) with killed=true;
            // an external SIGKILL (OOM killer) after the budget elapsed leaves
            // killed=false and must not masquerade as `exit 124: …timeout`.
            (e as { killed?: boolean }).killed === true &&
            e.signal != null &&
            e.code == null &&
            !(signal?.aborted ?? false) &&
            systemClock() - started >= timeoutMs,
          error: e ? { code: e.code, message: e.message } : null,
        });
      },
    );
  });
}
