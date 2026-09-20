// Sandbox proxy Worker: fronts per-thread Cloudflare Sandboxes with a minimal
// authenticated HTTP API the bot's CloudflareSandboxExecutor calls.
//
//   POST /exec   { command, timeoutMs?, env? } -> { stdout, stderr, exitCode, durationMs }
//   POST /read   { path, env? }             -> { content }
//   POST /write  { path, content, env? }    -> { ok: true }
//   GET  /healthz                           -> { ok: true, build: { commit, builtAt? } }
//
// Every request carries:
//   Authorization: Bearer <SANDBOX_TOKEN>   (wrangler secret put SANDBOX_TOKEN)
//   X-Thread-Key: <threadKey>               (one sandbox per conversation thread)
// and the body's optional `env` ({ NAME: value }) is forwarded into the sandbox
// for that one command — in the body, never in headers, because Workers Logs
// record request headers (docs/reference/specs/execution.md item 5).
//
// The Sandbox SDK only runs inside Workers — that's why this proxy exists. The
// Durable Object below does the work (one supervised process per command, the
// file reads and writes) and answers the fetch handler over RPC with plain
// data; the handler authenticates, streams, and names what came back.
import {
  OperationInterruptedError,
  ProcessWaitTimeoutError,
  RPCTransportError,
  RuntimeIdentityInactiveError,
  Sandbox,
  StaleProcessHandleError,
  getSandbox,
  type DirectoryBackup,
  type SandboxCommand,
} from "@cloudflare/sandbox";
import { createExtensionProcessSandbox } from "@cloudflare/sandbox/extensions";
import { BASH_TIMEOUT_MAX_MS, clampBashTimeout } from "../../src/execution/bashTimeout.js";
import {
  base64ByteLength,
  MAX_READ_BYTES,
  parseByteSize,
  readEncodingOf,
  statCommandFor,
  type Base64ReadAnswer,
} from "../../src/execution/binaryRead.js";
import {
  SANDBOX_SLEEP_AFTER,
  isRecycleError,
  recycledMidCommandMessage,
  DETACH_HINT,
  OUTPUT_AFTER_EXIT_MS,
  heldOutputNote,
} from "../../src/execution/sandboxLifecycle.js";
import { envFromRequest } from "../../src/execution/sandboxEnv.js";
import { IdleGuard, type IdleGuardHost } from "../../src/execution/sandboxIdle.js";
import { StartGate, type StartGateHost, type StartingCause } from "../../src/execution/sandboxStart.js";
import {
  RUNTIME_REPLACEMENT_WORDING,
  isRuntimeUnreachableSignal,
  selfAndCauses,
} from "../../src/execution/residentRefresh.js";
import {
  fleetBusyAnswer,
  fleetBusyExecAnswer,
  fleetBusyRefusedLine,
  isFleetBusyError,
  isRuntimeBusyError,
  isRuntimeBusySignal,
  isRuntimeUnreachableError,
  runtimeBusyAnswer,
  runtimeBusyExecAnswer,
  runtimeUnreachableAnswer,
  runtimeUnreachableExecAnswer,
  SandboxRuntimeBusyError,
  SandboxRuntimeUnreachableError,
  sandboxStartingAnswer,
  sandboxStartingExecAnswer,
  thrownShape,
  thrownText,
} from "../../src/execution/sandboxErrors.js";
import { injectedBuildStamp } from "../../src/deploy/buildStamp.js";
import { backupTransferMode } from "../../src/execution/residentBackupTransfer.js";
import {
  judgeRestoreProgress,
  RESTORE_POLL_MS,
  restoreArchivePath,
  type RestoreSample,
} from "../../src/execution/residentRefresh.js";
import {
  extractRestoreScript,
  restoreMountDir,
  unmountAllRestoresScript,
} from "../../src/execution/residentRestoreExtract.js";
import {
  isBackupMissing,
  parseSeed,
  SEED_CHECKOUT_DIR,
  SEED_DEPS_STAGING_DIR,
  SEED_FIXUP_TIMEOUT_MS,
  SEED_MARKER,
  SEED_RESTORE_MAX_MS,
  SEED_ABANDONED_RESTORE_WAIT_MS,
  seedFixupScript,
  seedMarkerText,
  type RestorePhases,
  type SandboxSeed,
  type SeedAnswer,
  type SeedPhases,
  type SeedStep,
} from "../../src/execution/seedPlan.js";
import { shellQuote } from "../../src/execution/shellQuote.js";
import { classifyError } from "../../src/core/trace/classify.js";
import { systemClock } from "../../src/core/trace/clock.js";
import { createTracer } from "../../src/core/trace/tracer.js";
import { startAdoptedRoot, workerLogSink } from "../../src/core/trace/workerTrace.js";
import sandboxPkg from "./package.json" with { type: "json" };

/** The `@cloudflare/sandbox` version this Worker is built against — the pin
 *  `check:sandbox-pair` holds equal to the Dockerfile's image tag, so it is
 *  also the version a container on the CURRENT image runs. */
const SDK_PIN: string = sandboxPkg.dependencies["@cloudflare/sandbox"];

const WORKDIR = "/workspace";

/** How long the SDK waits for the platform to grant a container instance
 *  before its start fails (docs/reference/specs/execution.md item 23). The
 *  SDK's default is 30 s and it retries, so a burst that the platform would
 *  not admit took 63 s to say so; at 10 s (the SDK allows 5 s to 300 s) the
 *  refusal reaches the start gate — and the executor's wait — in seconds. */
const INSTANCE_GET_TIMEOUT_MS = 10_000;

// Default per-command time limit, enforced by coreutils `timeout` inside the
// sandbox. The tuned 280s applies when the body carries no timeoutMs (an older
// bot); a caller-supplied timeoutMs is clamped server-side to the shared
// [1s, 20 min] bounds (clampBashTimeout — never trust the client's number).
// Whatever the effective limit, it must stay BELOW the SDK's own backstops so
// the real exit 124 wins: the per-process `timeout` this Worker launches with
// (the limit plus SDK_BACKSTOP_MARGIN_MS) and the container's
// COMMAND_TIMEOUT_MS (Dockerfile, above the 20-min ceiling).
const EXEC_TIMEOUT_SECS = 280;

/** How far above coreutils `timeout`'s deadline the SDK's own per-process
 *  limit sits: room for `-k 10`'s SIGKILL follow-up and the exit to land, so
 *  the shell-level 124 is always the deadline a command meets first. */
const SDK_BACKSTOP_MARGIN_MS = 40_000;

/** How long the Durable Object waits for the process's output to END past
 *  the command's own deadline before it asks the runtime what became of the
 *  process (docs/reference/specs/execution.md item 24). The runtime ends the
 *  output stream only when every holder of the command's stdout and stderr is
 *  gone; a process that exited while a detached child holds them is answered
 *  with its exit code and a note, a process still running is killed and
 *  answered as the shell-level timeout. The wait is `OUTPUT_AFTER_EXIT_MS`
 *  (20 s), inside the executor's per-send margin, so this answer always
 *  reaches the bot before it gives the command up — the SDK's own limit
 *  (`SDK_BACKSTOP_MARGIN_MS`) stays above it as the last resort. */
const OUTPUT_WAIT_AFTER_DEADLINE_MS = OUTPUT_AFTER_EXIT_MS;

/** The interruption reasons that mean the container's runtime is not the one
 *  the command started on: the process, if it started, is gone with its
 *  output. `transport_disposed` is the Durable Object's own connection going
 *  away and is not one of them. */
const RUNTIME_REPLACED_REASONS = new Set([
  "runtime_replaced",
  "container_stopped",
  "sandbox_destroyed",
  "sandbox_lifetime_changed",
]);

/** The transport losses that mean the same: the control connection's peer
 *  closed (a runtime crash or stop), the socket failed, the upgrade failed. */
const RPC_TRANSPORT_LOSS_KINDS = new Set(["peer_closed", "connection_failed", "upgrade_failed", "session_disposed"]);

/** Did the container's runtime change under the command? Typed first (the
 *  Durable Object sees the SDK's own classes, so `instanceof` holds here), the
 *  SDK's replacement wording second — the same list the resident Worker
 *  classifies its own execs with. */
function isRuntimeReplacement(err: unknown): boolean {
  if (err instanceof StaleProcessHandleError) return true;
  if (err instanceof RuntimeIdentityInactiveError) return true;
  if (err instanceof OperationInterruptedError && RUNTIME_REPLACED_REASONS.has(err.reason)) return true;
  if (err instanceof RPCTransportError && RPC_TRANSPORT_LOSS_KINDS.has(err.kind)) return true;
  for (const link of selfAndCauses(err)) {
    if (RUNTIME_REPLACEMENT_WORDING.test(thrownShape(link).message ?? "")) return true;
  }
  return false;
}

/** Did the container's control port never answer? The SDK's connect abort
 *  (30 s), anywhere in the cause chain. Asked only after `isRuntimeReplacement`. */
function isRuntimeUnreachable(err: unknown): boolean {
  for (const link of selfAndCauses(err)) if (isRuntimeUnreachableSignal(link)) return true;
  return false;
}

/** Did the platform refuse the connect inside its own accept allowance
 *  (docs/reference/specs/execution.md item 28)? The platform's own wording,
 *  anywhere in the cause chain; a plain `Error`, so the wording is all there
 *  is — and its words blame load the platform never measured. Asked only of
 *  a failure met before a process was started. */
function isRuntimeBusy(err: unknown): boolean {
  for (const link of selfAndCauses(err)) if (isRuntimeBusySignal(link)) return true;
  return false;
}

/** A finished command, as `/exec` answers it. `durationMs` is the command's
 *  wall time in the sandbox (docs/reference/specs/tracing.md item 19). */
export interface ExecAnswer {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/** A command the sandbox never answered for, in the dual in-body shape
 *  (docs/reference/specs/execution.md item 3): a new executor throws on `error`, an
 *  older one still renders `exit 127: <stderr>`. `reason` names the machine
 *  token when there is one (`fleet-busy`, `runtime-busy`, `runtime-unreachable`). */
export interface ExecFailure {
  error: string;
  reason?: string;
  /** The thread's Durable Object id, on a `fleet-busy` answer alone — the bot's
   *  ending log names which object the platform refused an instance to. */
  containerId?: string;
  stdout: "";
  stderr: string;
  exitCode: 127;
}

/** A file route's refusal, with the HTTP status the fetch handler answers and,
 *  when the refusal is a named condition the executor waits on (`fleet-busy`,
 *  `runtime-busy`, `runtime-unreachable`), its machine token — the executor
 *  reads the token, never the text, so a refusal without it is a dead sandbox to it. */
interface FileRefusal {
  error: string;
  status: number;
  reason?: string;
}

/** The SDK's own limit on the warm-up command (`true`): generous, since the
 *  SDK's start — an instance grant up to 30 s, the runtime's port up to 90 s
 *  by its defaults — happens inside this one call. The executor's wait for
 *  the `sandbox-starting` token is bounded on its own side. */
const WARM_UP_BACKSTOP_MS = 4 * 60_000;

/** Durable Object storage key of the idle ledger's served-time. */
const IDLE_LEDGER_KEY = "switchboard.idle.lastServedAt";
/** The scheduled-callback name of the idle sweep (a method below). */
const IDLE_SWEEP_CALLBACK = "idleSweep";

export class SwitchboardSandbox extends Sandbox<Env> {
  // The SDK's idle setting (its own default is 10 min), kept so its alarm
  // loop calls `onActivityExpired` on this cadence — but on the 0.13 line that
  // hook is a question to the runtime ("anything still running?"), not a
  // deadline, and the answer kept twenty-five containers awake for 16 hours.
  // The deadline itself is the guard's (docs/reference/specs/execution.md
  // item 22): 5 minutes after the last request this object served, the
  // container is destroyed, whatever runs inside; the shell-level `timeout`
  // stays the one deadline a command can hit (item 2), since a request in
  // flight is service.
  sleepAfter = SANDBOX_SLEEP_AFTER;

  private readonly idle: IdleGuard;
  private readonly gate: StartGate;

  constructor(...args: ConstructorParameters<typeof Sandbox<Env>>) {
    super(...args);
    this.idle = new IdleGuard(this.idleHost());
    this.gate = new StartGate(this.startHost());
    // Every wake, including the one the SDK's own alarm causes on a leaked
    // container: the baseline is read and a sweep armed before any request.
    this.ctx.blockConcurrencyWhile(() => this.idle.wake());
  }

  /** The guard's view of this object: the platform's running flag, the SDK's
   *  schedule table and clean destroy, the platform's kill, and storage. */
  private idleHost(): IdleGuardHost {
    return {
      now: systemClock,
      containerRunning: () => this.ctx.container?.running,
      sweepScheduled: async () => (await this.listSchedules(IDLE_SWEEP_CALLBACK)).length > 0,
      scheduleSweep: async (delayMs) => {
        await this.schedule(Math.ceil(delayMs / 1000), IDLE_SWEEP_CALLBACK);
      },
      destroySandbox: () => this.destroy(),
      killContainer: async () => {
        await this.ctx.container?.destroy();
      },
      loadLastServedAt: () => this.ctx.storage.get<number>(IDLE_LEDGER_KEY),
      saveLastServedAt: (at) => this.ctx.storage.put(IDLE_LEDGER_KEY, at),
      log: (event) => console.log(JSON.stringify({ ...event, thread: this.ctx.id.name ?? this.ctx.id.toString() })),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
  }

  /** The start gate's view of this object (docs/reference/specs/execution.md
   *  item 23): the platform's running flag, and a warm-up that is one trivial
   *  command through the SDK — which does the start (instance grant, image
   *  pull, boot, the runtime's port) and answers when the runtime does. The
   *  warm-up runs inside the idle ledger so the guard sees a request in flight
   *  for as long as the start takes. */
  private startHost(): StartGateHost {
    return {
      now: systemClock,
      containerRunning: () => this.ctx.container?.running,
      warmUp: () =>
        this.idle.served(async () => {
          const proc = await createExtensionProcessSandbox(this).exec(["true"], { timeout: WARM_UP_BACKSTOP_MS });
          await proc.output({ encoding: "utf8", timeout: WARM_UP_BACKSTOP_MS });
        }),
      log: (event) => console.log(JSON.stringify({ ...event, thread: this.ctx.id.name ?? this.ctx.id.toString() })),
    };
  }

  /** The idle sweep, scheduled by the guard through the SDK's schedule table
   *  and re-armed by it while a container is running. */
  async idleSweep(): Promise<void> {
    await this.idle.sweep();
  }

  /** The SDK's activity expiry, answered by the guard's verdict instead of the
   *  runtime's process probes. */
  override async onActivityExpired(): Promise<void> {
    await this.idle.expired();
  }

  /** One command as one supervised process (docs/reference/specs/execution.md
   *  item 4): `timeout -k 10 <secs> bash -c 'mkdir -p /workspace && cd
   *  /workspace && <command>'`, the caller's env on the process alone (item 5),
   *  the SDK's own per-process limit a margin above the shell's. The process
   *  is started and collected here, inside the Durable Object, where the
   *  SDK's error classes are still themselves — so a full fleet, a silent
   *  control port and a runtime replaced under the command are named by type
   *  and answered as data; anything else propagates to the fetch handler. */
  async runCommand(
    command: string,
    execTimeoutSecs: number,
    envVars: Record<string, string>,
  ): Promise<ExecAnswer | ExecFailure> {
    const startedAt = systemClock();
    return this.idle.served(async () => {
      try {
        return await this.gate.through(
          () => this.execute(command, execTimeoutSecs, envVars),
          (cause) => sandboxStartingExecAnswer(cause),
        );
      } catch (err) {
        // The warm-up's own failure, handed on by the gate: a full fleet, a
        // refused connect or a silent control port keeps its name; anything
        // else propagates. Nothing ran — the warm-up is a spawn.
        return this.spawnFailure(err, startedAt);
      }
    });
  }

  /** `runCommand` without the ledger entry: the body, and the internal caller
   *  (`readBase64`'s stat) that is already inside a served request. */
  private async execute(
    command: string,
    execTimeoutSecs: number,
    envVars: Record<string, string>,
  ): Promise<ExecAnswer | ExecFailure> {
    const startedAt = systemClock();
    const full = `mkdir -p ${WORKDIR} && cd ${WORKDIR} && ${command}`;
    const argv: SandboxCommand = ["timeout", "-k", "10", String(execTimeoutSecs), "bash", "-c", full];
    const backstopMs = execTimeoutSecs * 1000 + SDK_BACKSTOP_MARGIN_MS;
    let proc: Awaited<ReturnType<ReturnType<typeof createExtensionProcessSandbox>["exec"]>>;
    try {
      proc = await createExtensionProcessSandbox(this).exec(argv, { env: envVars, timeout: backstopMs });
    } catch (err) {
      // The process was never started: a refused connect is the wait token
      // here and only here (item 28) — the executor re-sends, and
      // nothing runs twice.
      return this.spawnFailure(err, startedAt);
    }
    try {
      const out = await proc.output({
        encoding: "utf8",
        timeout: execTimeoutSecs * 1000 + OUTPUT_WAIT_AFTER_DEADLINE_MS,
      });
      // coreutils `timeout` exits 124 when the deadline killed the command
      // (137 when the follow-up SIGKILL had to); the SDK's own limit, if it
      // ever wins, reports `timedOut`. All three are the one story.
      const timedOut = out.timedOut || out.exitCode === 124 || out.exitCode === 137;
      const notes: string[] = [];
      if (timedOut) notes.push(timeoutNote(execTimeoutSecs));
      // The SDK cut the process's log past its own retention: the output
      // here is a prefix, whatever the executor's caps say.
      if (out.truncated) notes.push("output truncated by the sandbox runtime — the streams above are a prefix");
      return {
        stdout: out.stdout,
        stderr: [out.stderr, ...notes].filter(Boolean).join("\n"),
        exitCode: timedOut ? 124 : out.exitCode,
        durationMs: systemClock() - startedAt,
      };
    } catch (err) {
      if (err instanceof ProcessWaitTimeoutError) {
        // The output never ended inside the command's deadline plus the
        // margin. Two stories, told apart by asking the runtime (item 24):
        // the process EXITED and a detached child holds its output open —
        // the answer is its exit code and the note, the child runs on; or
        // the process is still RUNNING past its own `timeout` — end it, and
        // report the shell-level timeout it exceeded.
        const status = await proc.status().catch(() => null);
        if (status?.state === "exited") {
          return {
            stdout: "",
            stderr: heldOutputNote(status.exit.code),
            exitCode: status.exit.code,
            durationMs: systemClock() - startedAt,
          };
        }
        await proc.kill(9).catch(() => {});
        return {
          stdout: "",
          stderr: `${timeoutNote(execTimeoutSecs)}\n(the process outlived the sandbox's own limit and was killed)`,
          exitCode: 124,
          durationMs: systemClock() - startedAt,
        };
      }
      return this.execFailure(err, startedAt);
    }
  }

  /** The seed (docs/reference/specs/execution.md item 25): the resident's
   *  checkout snapshot — and the deps-store entry for its lockfile key — restored
   *  into this container before the run's first command, then the fix-up
   *  (ownership, origin, the deps view in place, the thread's ref checked out).
   *  Inside the idle ledger and behind the start gate like every route: the
   *  container's start is waited out by the executor, never carried here. */
  async seed(seed: SandboxSeed, envVars: Record<string, string>): Promise<SeedAnswer | WaitAnswer> {
    return this.idle.served(() =>
      this.gate.through(
        () => this.seedNow(seed, envVars),
        (cause) => sandboxStartingAnswer(cause),
      ),
    );
  }

  private async seedNow(seed: SandboxSeed, envVars: Record<string, string>): Promise<SeedAnswer> {
    const t0 = systemClock();
    const from = {
      ref: seed.ref,
      sha: seed.sha,
      checkoutBackupId: seed.checkoutBackupId,
      ...(seed.depsBackupId ? { depsBackupId: seed.depsBackupId } : {}),
    };
    // Presigned only: the container downloads the archive over a URL this
    // object signs. In local-bucket mode the isolate would pump the bytes and
    // a checkout restore runs to gigabytes (resident-repos item 61).
    const transfer = backupTransferMode(this.env as unknown as Record<string, unknown>);
    if (transfer.mode !== "presigned") {
      return {
        seeded: false,
        reason: "seed-unconfigured",
        detail: `presigned R2 transfer needs ${transfer.missing.join(", ")}`,
      };
    }
    // The marker names the seed this container carries — the handle and the
    // ref and head checked out: the same seed again is the run's second
    // request (a retry, a re-attach), and a restore over the live tree would
    // destroy the run's work; a seed naming another ref is a new seed.
    const marker = await this.runRoot(["cat", SEED_MARKER], 30_000);
    if (marker.exitCode === 0 && marker.stdout.trim() === seedMarkerText(seed)) {
      const head = await this.runRoot(["git", "-C", SEED_CHECKOUT_DIR, "rev-parse", "HEAD"], 30_000);
      return {
        seeded: true,
        cached: true,
        slug: seed.slug,
        ref: seed.fetchRef ?? seed.ref,
        sha: head.exitCode === 0 ? head.stdout.trim() : seed.sha,
        from,
        steps: { restore: 0, deps: null, fixup: 0 },
        ms: systemClock() - t0,
      };
    }
    const deadline = t0 + SEED_RESTORE_MAX_MS;
    const steps = { restore: 0, deps: null as number | null, fixup: 0 };
    let step: SeedStep = "restore";
    try {
      // Nothing of an earlier attempt survives: its mounts, a half tree, a
      // marker for another handle.
      await this.runRoot(["sh", "-c", `${unmountAllRestoresScript()}\n${this.seedSweep()}`], 60_000);
      let t = systemClock();
      const checkout = await this.restoreSeedInto(seed.checkoutBackupId, SEED_CHECKOUT_DIR, deadline, "checkout");
      steps.restore = systemClock() - t;
      const phases: SeedPhases = { checkout, deps: null };
      if (seed.depsBackupId) {
        step = "deps";
        t = systemClock();
        phases.deps = await this.restoreSeedInto(seed.depsBackupId, SEED_DEPS_STAGING_DIR, deadline, "deps");
        steps.deps = systemClock() - t;
      }
      step = "fixup";
      t = systemClock();
      const script = seedFixupScript({
        slug: seed.slug,
        ref: seed.ref,
        ...(seed.fetchRef ? { fetchRef: seed.fetchRef } : {}),
        ...(seed.fetchSha ? { fetchSha: seed.fetchSha } : {}),
        checkoutDir: SEED_CHECKOUT_DIR,
        ...(seed.depsBackupId ? { depsDir: SEED_DEPS_STAGING_DIR } : {}),
      });
      // The fix-up's fetch authenticates through the image's credential helper
      // with the exec env's GH_TOKEN — the same channel every command uses.
      const fix = await this.runRoot(["bash", "-c", script], SEED_FIXUP_TIMEOUT_MS, envVars);
      if (fix.exitCode !== 0) throw new Error(`fix-up exited ${fix.exitCode}: ${tail(fix.stderr || fix.stdout)}`);
      steps.fixup = systemClock() - t;
      const sha = fix.stdout.trim().split("\n").at(-1) ?? seed.sha;
      await this.runRoot(
        ["sh", "-c", `printf %s ${shellQuote(seedMarkerText(seed))} > ${shellQuote(SEED_MARKER)}`],
        30_000,
      );
      const ms = systemClock() - t0;
      console.log(
        JSON.stringify({
          event: "sandbox.seeded",
          slug: seed.slug,
          ref: seed.fetchRef ?? seed.ref,
          sha,
          steps,
          phases,
          ms,
        }),
      );
      return {
        seeded: true,
        cached: false,
        slug: seed.slug,
        ref: seed.fetchRef ?? seed.ref,
        sha,
        from,
        steps,
        phases,
        ms,
      };
    } catch (err) {
      const shape = thrownShape(err);
      // A half seed never survives either: the run that follows goes cold
      // and clones into an empty workspace. A restore the verdict gave up on
      // keeps streaming (the SDK's call cannot be cancelled): it is waited
      // for, bounded, before the sweep runs over its directory.
      await this.settlePendingRestores(SEED_ABANDONED_RESTORE_WAIT_MS);
      await this.runRoot(["sh", "-c", `${unmountAllRestoresScript()}\n${this.seedSweep()}`], 60_000).catch(() => {});
      const reason = isBackupMissing(shape) ? "seed-missing" : "seed-failed";
      const detail = `${step}: ${thrownText(shape)}`;
      console.log(
        JSON.stringify({ event: "sandbox.seed-failed", slug: seed.slug, reason, step, detail, ms: systemClock() - t0 }),
      );
      return { seeded: false, reason, detail, step };
    }
  }

  /** Remove what a seed writes: the checkout, the deps staging tree, the marker. */
  private seedSweep(): string {
    return `rm -rf ${shellQuote(SEED_CHECKOUT_DIR)} ${shellQuote(SEED_DEPS_STAGING_DIR)} ${shellQuote(SEED_MARKER)}`;
  }

  /** One presigned restore INTO `targetDir` as a plain directory, the way the
   *  resident does it (resident-repos item 61): the SDK mounts the archive at
   *  a staging sibling, the wait is judged by bytes arriving (the SDK's call
   *  takes no timeout) against the seed's one deadline, then the extract
   *  script puts a real tree in place and the target appears last. */
  private async restoreSeedInto(
    id: string,
    targetDir: string,
    deadlineMs: number,
    what: string,
  ): Promise<RestorePhases> {
    const attempt = crypto.randomUUID().slice(0, 8);
    const mountDir = restoreMountDir(targetDir, attempt);
    const backup: DirectoryBackup = { id, dir: mountDir };
    const startedMs = systemClock();
    const restore = this.restoreBackup(backup);
    // Judged below by bytes; a rejection after the judge gave up is never
    // unhandled, and the promise is remembered until it settles so a failure
    // sweep waits for it (bounded) before touching its directory.
    this.pendingRestores.add(restore);
    restore.then(
      () => this.pendingRestores.delete(restore),
      () => this.pendingRestores.delete(restore),
    );
    const samples: RestoreSample[] = [];
    for (;;) {
      const outcome = await Promise.race([
        restore.then(() => "done" as const),
        new Promise<"tick">((r) => setTimeout(() => r("tick"), RESTORE_POLL_MS)),
      ]);
      if (outcome === "done") break;
      samples.push({ atMs: systemClock(), kiB: await this.duKiB([restoreArchivePath(id), mountDir]) });
      const verdict = judgeRestoreProgress({ startedMs, nowMs: systemClock(), samples, deadlineMs });
      if (verdict.verdict !== "wait") throw new Error(`${what} restore ${verdict.verdict}: ${verdict.detail}`);
    }
    const download = systemClock() - startedMs;
    const extractStartedMs = systemClock();
    const r = await this.runRoot(
      ["sh", "-c", extractRestoreScript({ mountDir, backupId: id, archivePath: restoreArchivePath(id), targetDir })],
      Math.max(60_000, deadlineMs - systemClock()),
    );
    if (r.exitCode !== 0) throw new Error(`${what} extract exited ${r.exitCode}: ${tail(r.stderr || r.stdout)}`);
    const extract = systemClock() - extractStartedMs;
    console.log(
      JSON.stringify({ event: "sandbox.seed-restore", what, id, download, extract, method: r.stdout.trim() }),
    );
    return { download, extract };
  }

  /** Restores this object started that have not settled: what a failure
   *  sweep must not race. */
  private readonly pendingRestores = new Set<Promise<unknown>>();

  /** Wait for every pending restore to settle, at most `maxMs`: a restore the
   *  judge called stalled may still finish, and `rm -rf` under a streaming
   *  extraction leaves debris the next seed's own sweep has to clear. */
  private async settlePendingRestores(maxMs: number): Promise<void> {
    if (this.pendingRestores.size === 0) return;
    const settled = Promise.allSettled([...this.pendingRestores]);
    await Promise.race([settled, new Promise<void>((r) => setTimeout(r, maxMs))]);
  }

  /** `du -sk` over the paths, summed, in KiB; null when nothing could be
   *  measured — including a `du` that did not answer inside its own limit
   *  (a mount mid-restore under load): the judge treats a sample the
   *  container could not take as no evidence either way, never as the
   *  restore's failure. The restore's own promise still reports a runtime
   *  that went away. */
  private async duKiB(paths: string[]): Promise<number | null> {
    let r: { stdout: string; exitCode: number };
    try {
      r = await this.runRoot(["du", "-sk", ...paths], 30_000);
    } catch {
      return null;
    }
    if (r.exitCode === 124) return null;
    let total = 0;
    let seen = false;
    for (const line of r.stdout.split("\n")) {
      const m = /^(\d+)\s/.exec(line);
      if (m) {
        total += Number(m[1]);
        seen = true;
      }
    }
    return seen ? total : null;
  }

  /** One process as root, collected inside this object — the seed's own
   *  commands, outside the /exec shape (no shell-level `timeout`, no WORKDIR). */
  private async runRoot(
    argv: SandboxCommand,
    timeoutMs: number,
    env: Record<string, string> = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = await createExtensionProcessSandbox(this).exec(argv, {
      env,
      timeout: timeoutMs + SDK_BACKSTOP_MARGIN_MS,
    });
    const out = await proc.output({ encoding: "utf8", timeout: timeoutMs + OUTPUT_WAIT_AFTER_DEADLINE_MS });
    return { stdout: out.stdout, stderr: out.stderr, exitCode: out.timedOut ? 124 : out.exitCode };
  }

  /** A failure met BEFORE a process was started — the spawn, or the gate's
   *  warm-up: a container that did not accept the connection is named with
   *  its wait token (docs/reference/specs/execution.md item 28), since
   *  nothing ran and the identical request is safe to re-send. Every other
   *  failure is classified as after a start (`execFailure`). A failure of a
   *  running command's output never comes here: the process exists, and a
   *  re-send would run it again. */
  private spawnFailure(err: unknown, startedAt: number): ExecFailure {
    if (!isFleetBusyError(err) && !isRuntimeReplacement(err) && isRuntimeBusy(err)) {
      return runtimeBusyExecAnswer(this.runtimeBusy(thrownText(thrownShape(err))).message);
    }
    return this.execFailure(err, startedAt);
  }

  /** The named failures, as `/exec` data; anything else is thrown as it came. */
  private execFailure(err: unknown, startedAt: number): ExecFailure {
    const raw = thrownText(thrownShape(err));
    // A full fleet (docs/reference/specs/execution.md item 14): no container
    // instance for this thread, so nothing started — the executor waits. One
    // queryable line per refusal, so a log sweep after a capacity incident
    // can count them without reading cards; the answer carries this object's
    // id so the bot's ending log can name which object the fleet refused.
    if (isFleetBusyError(err)) {
      const container = this.ctx.id.toString();
      console.log(fleetBusyRefusedLine({ thread: this.ctx.id.name ?? container, container, refusal: raw }));
      return fleetBusyExecAnswer(raw, container);
    }
    // The runtime changed under the command (item 9): the process, if it
    // started, is gone with its output. Certain — the SDK said so by type.
    if (isRuntimeReplacement(err)) {
      const msg = recycledMidCommandMessage(systemClock() - startedAt, raw, true);
      return { error: msg, stdout: "", stderr: msg, exitCode: 127 };
    }
    // The control port never answered (item 9): nothing ran.
    if (isRuntimeUnreachable(err)) return runtimeUnreachableExecAnswer(this.runtimeUnreachable(raw).message);
    throw err;
  }

  /** The typed, named error for a silent control port, with this container's
   *  facts — thrown across the RPC boundary to the fetch handler on the file
   *  routes, where it is matched by name. */
  private runtimeUnreachable(cause: string): SandboxRuntimeUnreachableError {
    return new SandboxRuntimeUnreachableError({
      containerId: this.ctx.id.toString(),
      running: this.ctx.container?.running,
      sdkVersion: SDK_PIN,
      cause,
    });
  }

  /** The typed, named error for a container that did not accept the
   *  connection (item 28), with this container's id — thrown across the RPC
   *  boundary to the fetch handler on the file routes, matched by name. */
  private runtimeBusy(cause: string): SandboxRuntimeBusyError {
    return new SandboxRuntimeBusyError({ containerId: this.ctx.id.toString(), cause });
  }

  /** A file operation with its runtime failures named for the fetch handler:
   *  a refused connect (item 28) and a silent control port (item 9) become
   *  the typed errors; a missing file is the refusal the route answers 404.
   *  The SDK's other errors propagate. A file operation that met either
   *  never reached the runtime, so the executor's re-send does nothing twice. */
  private async fileOp<T>(op: () => Promise<T>): Promise<T | FileRefusal> {
    try {
      return await op();
    } catch (err) {
      const shape = thrownShape(err);
      if (shape.name === "FileNotFoundError") return { error: `read-failed: ${thrownText(shape)}`, status: 404 };
      if (!isRuntimeReplacement(err) && isRuntimeBusy(err)) throw this.runtimeBusy(thrownText(shape));
      if (!isRuntimeReplacement(err) && isRuntimeUnreachable(err)) throw this.runtimeUnreachable(thrownText(shape));
      throw err;
    }
  }

  /** A file route's answer while the container starts: HTTP 503 with the
   *  token, like a full fleet's. */
  private startingRefusal(cause: StartingCause): FileRefusal {
    const { error, reason } = sandboxStartingAnswer(cause);
    return { error, status: 503, reason };
  }

  async readText(path: string): Promise<{ content: string } | FileRefusal> {
    return this.idle.served(() =>
      this.gate.through(
        () => this.fileOp(async () => ({ content: (await this.readFile(path, { encoding: "utf-8" })).content })),
        (cause) => this.startingRefusal(cause),
      ),
    );
  }

  /** `encoding: "base64"` (src/execution/binaryRead.ts): the size first, from
   *  `stat`, so the cap is judged before any read and the client can hold the
   *  decoded bytes to it — an SDK read that came back short would otherwise
   *  pass as the file. A file over the cap is refused by name inside a 200. */
  async readBase64(path: string): Promise<Base64ReadAnswer | FileRefusal> {
    return this.idle.served(() =>
      this.gate.through(
        () => this.readBase64Now(path),
        (cause) => this.startingRefusal(cause),
      ),
    );
  }

  private async readBase64Now(path: string): Promise<Base64ReadAnswer | FileRefusal> {
    const stat = await this.execute(statCommandFor(path), 60, {});
    if ("error" in stat) {
      // The stat's own named failure — a full fleet, a silent control port —
      // is the read's, token included, so the executor waits as it would
      // have for the text read.
      return stat.reason ? { error: stat.error, status: 503, reason: stat.reason } : { error: stat.error, status: 500 };
    }
    if (stat.exitCode !== 0) return { error: `read-failed: ${(stat.stderr || stat.stdout).trim()}`, status: 404 };
    const size = parseByteSize(stat.stdout);
    if (size === null) return { error: `read-failed: stat answered ${JSON.stringify(stat.stdout)}`, status: 500 };
    if (size > MAX_READ_BYTES) return { encoding: "base64", tooLarge: true } satisfies Base64ReadAnswer;
    return this.fileOp(async () => {
      const content = (await this.readFile(path, { encoding: "base64" })).content;
      const got = base64ByteLength(content);
      // 409, not 5xx: the client retries a 5xx over 30 s, and a short read is
      // answered by the caller re-reading, not by waiting.
      if (got !== size) {
        return { error: `read-inconsistent: ${path} is ${size} bytes but the read returned ${got}`, status: 409 };
      }
      return { encoding: "base64", content, size } satisfies Base64ReadAnswer;
    });
  }

  async write(path: string, content: string): Promise<{ ok: true } | FileRefusal> {
    return this.idle.served(() =>
      this.gate.through(
        () =>
          this.fileOp(async () => {
            await this.writeFile(path, content);
            return { ok: true as const };
          }),
        (cause) => this.startingRefusal(cause),
      ),
    );
  }
}

/** The last part of a step's output, for a failure's detail. */
function tail(text: string): string {
  return text.trim().slice(-400);
}

/** The stderr line an exit 124 carries: the limit, the knob, and the way to
 *  outlive a command (`setsid -f`: every /exec runs under `timeout … bash -c`,
 *  whose process group is reaped when the command returns, so a plain
 *  background job dies with it — and with the wrapper's stdio redirected, so
 *  the command's output ends when the command does, item 24). */
function timeoutNote(execTimeoutSecs: number): string {
  return (
    `command timed out in the sandbox after ${execTimeoutSecs}s (pass the bash tool's timeoutMs for longer commands, max ${BASH_TIMEOUT_MAX_MS} ms); ` +
    `re-run as smaller/faster steps, or start it detached with \`${DETACH_HINT}\` and poll the log on later calls`
  );
}

interface Env {
  Sandbox: DurableObjectNamespace<SwitchboardSandbox>;
  SANDBOX_TOKEN: string;
  // The seed (docs/reference/specs/execution.md item 25): the resident's cache
  // bucket and the four values the SDK's presigned restore reads — rendered
  // only when the profile has a resident (wrangler.template.jsonc), the keys
  // provisioned by `deploy secrets sandbox`. Any absent → `seed-unconfigured`:
  // a gigabyte restore never goes through the isolate (resident-repos item 61).
  BACKUP_BUCKET?: R2Bucket;
  CLOUDFLARE_ACCOUNT_ID?: string;
  BACKUP_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

/** The commit this bundle was built from, injected by the deploy
 *  (`deploy/bin/build-stamp.mjs`) and answered on GET /healthz as `build`. */
const BUILD = injectedBuildStamp();

// The Worker's own spans (docs/reference/specs/tracing.md item 22): one `sandbox.exec`
// root per command, joining the bot's trace (the bearer checked out before the
// header is read).
const tracer = createTracer({ clock: systemClock });
const traceSinks = [workerLogSink((line) => console.log(line))];

function execRoot(startedAt: number, traceparent: string | undefined) {
  return startAdoptedRoot(tracer, "sandbox.exec", { sinks: traceSinks, startedAt, traceparent });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = request.headers.get("authorization");
    if (!env.SANDBOX_TOKEN || auth !== `Bearer ${env.SANDBOX_TOKEN}`) {
      return json({ error: "unauthorized" }, 401);
    }
    // Build identity, behind the SAME bearer as everything else: this Worker
    // authenticates every request and gains no unauthenticated surface for a
    // stamp (docs/reference/specs/execution.md item 13). It needs no thread, so it answers
    // before the X-Thread-Key check — and it is the one GET here.
    if (request.method === "GET" && new URL(request.url).pathname === "/healthz") {
      // `backupTransfer` says whether a seed can run here (presigned) or not (local).
      return json({
        ok: true,
        build: BUILD,
        backupTransfer: backupTransferMode(env as unknown as Record<string, unknown>).mode,
      });
    }
    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    const threadKey = request.headers.get("x-thread-key");
    if (!threadKey) return json({ error: "missing X-Thread-Key" }, 400);

    // One sandbox per thread; the DO name is the thread key. The stub's own
    // methods (`runCommand`, `readText`, …) are what the routes call — the
    // work happens in the Durable Object, the data comes back over RPC.
    const sandbox = getSandbox(env.Sandbox, threadKey, {
      containerTimeouts: {
        // A refused instance grant is learned in seconds, not after the SDK's
        // 30 s default and its retries (63 s to "no container instance" under
        // a burst, docs/reference/specs/execution.md item 23): the gate turns
        // it into the wait token and the executor re-sends. A grant that is
        // merely slow is re-asked on the next send, which finds it made.
        instanceGetTimeoutMS: INSTANCE_GET_TIMEOUT_MS,
      },
    });

    const url = new URL(request.url);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    // Optional env passthrough (e.g. GH_TOKEN), read from the BODY's `env`
    // (docs/reference/specs/execution.md item 5). It then rides in the SDK's per-process
    // `env` option, which the runtime applies to that one command and
    // nothing else. Body, never headers: Workers Logs record this
    // invocation's request headers and redact them by a name heuristic only —
    // a receipt probe's per-variable env header was once logged in clear.
    // Bodies are not recorded.
    const envVars = envFromRequest({ body });

    try {
      switch (url.pathname) {
        case "/exec": {
          // Per-call budget (docs/reference/specs/execution.md item 11): a numeric
          // timeoutMs in the body is clamped server-side to the shared
          // [1s, 20 min] bounds; absent (an older bot) → the tuned 280s
          // default this Worker has always used.
          const requested = body.timeoutMs;
          const execTimeoutSecs =
            typeof requested === "number" && Number.isFinite(requested)
              ? Math.ceil(clampBashTimeout(requested) / 1000)
              : EXEC_TIMEOUT_SECS;
          return streamExec(
            () => sandbox.runCommand(String(body.command ?? ""), execTimeoutSecs, envVars),
            request.headers.get("traceparent") ?? undefined,
          );
        }
        case "/seed": {
          // The seed (docs/reference/specs/execution.md item 25): the resident's
          // snapshot restored into this thread's sandbox before the run's first
          // command. Streamed like /exec — a restore takes minutes — and every
          // outcome is named in the body, so the executor never reads a seed
          // that did not happen as a dead sandbox.
          const parsed = parseSeed(body.seed);
          if (!parsed.ok) return json({ error: parsed.error }, 400);
          return streamSeed(() => sandbox.seed(parsed.seed, envVars), request.headers.get("traceparent") ?? undefined);
        }
        case "/read": {
          const encoding = readEncodingOf(body);
          if (typeof encoding !== "string") return json({ error: encoding.error }, 400);
          const path = abs(String(body.path ?? ""));
          const answer = encoding === "base64" ? await sandbox.readBase64(path) : await sandbox.readText(path);
          return "status" in answer ? refused(answer) : json(answer);
        }
        case "/write": {
          const answer = await sandbox.write(abs(String(body.path ?? "")), String(body.content ?? ""));
          return "status" in answer ? refused(answer) : json(answer);
        }
        default:
          return json({ error: "unknown route" }, 404);
      }
    } catch (err) {
      // Never an empty text (item 3): a message-less SDK error is named as such.
      const msg = thrownText(thrownShape(err));
      // Nothing answered at the container's control port (item 9): the file
      // op never reached a runtime, so a 503 the executor's transport retry
      // re-sends, with the named reason and the container in the text.
      if (isRuntimeUnreachableError(err)) return json(runtimeUnreachableAnswer(msg), 503);
      // The container did not accept the connection (item 28): the file op
      // never reached it either — a 503 with the wait token.
      if (isRuntimeBusyError(err)) return json(runtimeBusyAnswer(msg), 503);
      // A full fleet (docs/reference/specs/execution.md item 14): no container
      // instance for this thread's Durable Object, so the file op never
      // started — re-sending is safe by construction. Named so the executor
      // waits instead of reading it as a dead sandbox; 503 because that is
      // what it is. One queryable line per refusal (the same event as the
      // exec path's), the object's id computed from the thread key it is
      // named by, since the error crossed the RPC boundary without it.
      if (isFleetBusyError(err)) {
        const container = env.Sandbox.idFromName(threadKey).toString();
        console.log(fleetBusyRefusedLine({ thread: threadKey, container, refusal: msg, route: url.pathname }));
        return json(fleetBusyAnswer(msg, container), 503);
      }
      return json({ error: msg }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/** Execute a command and stream the response: immediate headers, a whitespace
 *  heartbeat every 15s while the command runs, then one JSON document. A long
 *  command otherwise holds a byteless HTTP request open for minutes, and some
 *  hop between the bot and this Worker silently drops idle connections
 *  (measured live: undici gives up 300s after sending a request that has
 *  received no headers). Heartbeats are pure whitespace, which is legal
 *  around a JSON document — the executor's res.json() on the full body parses
 *  unchanged. All outcomes arrive in-body with HTTP 200 (headers are long
 *  gone by the time the result is known): a completed command as {stdout,
 *  stderr, exitCode}, a sandbox-enforced timeout as exit 124, and any other
 *  failure as {error} (docs/reference/specs/execution.md item 3). */
/** HTTP 200 at once, a whitespace heartbeat every 15 s, then exactly one JSON
 *  document (docs/reference/specs/execution.md item 3): the shape every long
 *  route shares, so no hop ever sees an idle connection. `settle` turns the
 *  run's outcome — an answer, or a throw — into that one document. */
function heartbeatJson(
  run: () => Promise<object>,
  settle: { answered: (answer: object) => object; threw: (err: unknown) => object },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const beat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode("\n"));
        } catch {
          clearInterval(beat); // client went away; the promise still settles
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
      run().then(
        (answer) => finish(settle.answered(answer)),
        (err: unknown) => finish(settle.threw(err)),
      );
    },
  });
  return new Response(stream, { headers: { "content-type": "application/json" } });
}

function streamExec(run: () => Promise<ExecAnswer | ExecFailure>, traceparent: string | undefined): Response {
  const startedAt = systemClock();
  return heartbeatJson(run, {
    answered: (a) => {
      const answer = a as ExecAnswer | ExecFailure;
      if ("error" in answer) {
        // A command the sandbox never answered for, named by the Durable
        // Object: an infra failure, classified, no message on the span.
        const root = execRoot(startedAt, traceparent);
        root.fail(classifyError(new Error("sandbox exec failed"), { kind: "infra" }));
        root.end("error");
        return answer;
      }
      // The command as the Worker's own root (docs/reference/specs/tracing.md item 22).
      execRoot(startedAt, traceparent).end(answer.exitCode === 0 ? "ok" : "error", {
        exitCode: answer.exitCode,
        ...(answer.exitCode === 124 ? { timedOut: true } : {}),
      });
      return answer;
    },
    threw: (err) => {
      // The Durable Object threw: a failure its own classification did
      // not name, seen here after the RPC boundary (name and message kept,
      // prototype dropped), so the shared classifiers read the shape.
      const root = execRoot(startedAt, traceparent);
      root.fail(classifyError(new Error("sandbox exec failed"), { kind: "infra" }));
      root.end("error");
      const shape = thrownShape(err);
      const raw = thrownText(shape);
      if (isRuntimeUnreachableError(err)) return runtimeUnreachableExecAnswer(raw);
      if (isRuntimeBusyError(err)) return runtimeBusyExecAnswer(raw);
      if (isFleetBusyError(err)) return fleetBusyExecAnswer(raw);
      // A recycle the Durable Object did not catch by type: by name, or
      // a recycle-shaped text minutes into the attempt (item 9).
      const certain = shape.name !== undefined && isRecycleError({ name: shape.name });
      const msg = recycledMidCommandMessage(systemClock() - startedAt, raw, certain);
      return { error: msg, stdout: "", stderr: msg, exitCode: 127 } satisfies ExecFailure;
    },
  });
}

/** `POST /seed`'s answer over the same heartbeat stream, as its own
 *  `sandbox.seed` root. A start or a full fleet met at the warm-up keeps its
 *  wait token (items 14, 23); a silent control port its name (item 9); any
 *  other throw is a `seed-failed` with the text — never a dead sandbox. */
function streamSeed(run: () => Promise<SeedAnswer | WaitAnswer>, traceparent: string | undefined): Response {
  const startedAt = systemClock();
  const root = () => startAdoptedRoot(tracer, "sandbox.seed", { sinks: traceSinks, startedAt, traceparent });
  return heartbeatJson(run, {
    answered: (a) => {
      const answer = a as SeedAnswer | WaitAnswer;
      if ("seeded" in answer)
        root().end(answer.seeded ? "ok" : "error", { outcome: answer.seeded ? "seeded" : answer.reason });
      return answer;
    },
    threw: (err) => {
      const r = root();
      r.fail(classifyError(new Error("sandbox seed failed"), { kind: "infra" }));
      r.end("error");
      const raw = thrownText(thrownShape(err));
      if (isRuntimeUnreachableError(err)) return runtimeUnreachableAnswer(raw);
      if (isFleetBusyError(err)) return fleetBusyAnswer(raw);
      return { seeded: false, reason: "seed-failed", detail: raw } satisfies SeedAnswer;
    },
  });
}

/** A route's answer while the container starts or the fleet is full: the
 *  text and the machine token the executor waits on. */
type WaitAnswer = ReturnType<typeof sandboxStartingAnswer> | ReturnType<typeof fleetBusyAnswer>;

/** A file route's refusal as the fetch handler answers it: the text, and the
 *  machine token when the Durable Object named one — the executor matches
 *  `reason`, not the text (docs/reference/specs/execution.md items 9 and 14). */
function refused(r: FileRefusal): Response {
  return json(r.reason ? { error: r.error, reason: r.reason } : { error: r.error }, r.status);
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
