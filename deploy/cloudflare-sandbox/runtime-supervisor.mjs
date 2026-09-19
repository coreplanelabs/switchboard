#!/usr/bin/env node
// The cold sandbox's process supervisor, run by tini (PID 1): keeps the
// container alive across a crash of the SDK's container server
// (/container-server/sandbox). That server calls process.exit(1) on any
// uncaught exception, and the base image runs it as tini's one child — so one
// uncaught error ended the whole container: /workspace gone, a detached pi
// with it, every later /exec a failure until the platform noticed. Started
// here as a child instead, the server's exit is a restart a second later; the
// disk, the detached processes and the Durable Object's view of a running
// container all survive, and the next command starts a fresh process on the
// new server (docs/reference/specs/execution.md item 21).
//
// A stop from the platform is SIGTERM, which tini forwards here: forwarded to
// the server, and nothing starts again — a stop that lands during the pause
// between two starts still ends here — and the server's own exit status
// becomes this process's (the shell convention, 128 + the signal's number,
// when a signal ended it). A terminal's INT is forwarded as TERM too: one
// stop path, whatever the signal. A server that cannot stay up —
// QUICK_EXIT_LIMIT exits in a row, each within QUICK_EXIT_SECS of starting —
// ends the container with the last status instead of looping forever.
//
// Dependency-free Node ESM on the Node the image ships; `supervise` takes its
// process factory, clock, sleep and signal source as arguments, so
// src/deploy/sandboxRuntimeSupervisor.test.ts drives it with a fake child and
// a fake clock — no real process anywhere in the tests.
import { spawn as nodeSpawn } from "node:child_process";
import { constants } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as sleepFor } from "node:timers/promises";

/** The SDK's container server, unless SANDBOX_RUNTIME names another. */
export const DEFAULT_RUNTIME = "/container-server/sandbox";
/** An exit within this many seconds of starting counts as a quick exit. */
export const QUICK_EXIT_SECS = 10;
/** This many quick exits in a row end the supervisor with the last status. */
export const QUICK_EXIT_LIMIT = 5;
/** The pause between an exit and the next start. */
export const RESTART_PAUSE_MS = 1_000;

/** One child's end as a shell would report it: its own exit code; 128 plus
 *  the signal's number when a signal ended it; 127 when it never started. */
export function endCode(code, signal) {
  if (typeof code === "number") return code;
  if (signal) return 128 + (constants.signals[signal] ?? 0);
  return 127;
}

/**
 * Start the runtime and start it again whenever it exits, until a stop signal
 * or the quick-exit limit ends the loop; resolves with the exit status the
 * whole process should carry. Every effect is an injected dependency:
 * `spawn(runtime, args)` returns the child (a `kill(signal)` method and
 * `exit`/`error` events are all it needs), `now()` is the clock in
 * milliseconds, `sleep(ms)` the pause, `log(line)` the stderr line, and
 * `signals` the emitter whose SIGTERM/SIGINT mean stop.
 */
export async function supervise({ runtime, args, spawn, now, sleep, log, signals }) {
  let child;
  let stopping = false;
  let quick = 0;
  let code;
  const stop = () => {
    stopping = true;
    // Always TERM, whichever signal the stop arrived as: the server has one
    // shutdown path and a terminal's INT should take it too.
    if (child) child.kill("SIGTERM");
  };
  signals.on("SIGTERM", stop);
  signals.on("SIGINT", stop);
  try {
    for (;;) {
      const started = now();
      child = spawn(runtime, args);
      const ended = new Promise((resolve) => {
        child.once("exit", (c, s) => resolve(endCode(c, s)));
        // A runtime that cannot start (the path is wrong) never emits `exit`;
        // 127 is what a shell would say, and the quick-exit limit ends the loop.
        child.once("error", () => resolve(endCode(null, null)));
      });
      // A stop that landed before this start found no child to forward to;
      // the one it missed gets it here.
      if (stopping) child.kill("SIGTERM");
      code = await ended;
      child = undefined;
      if (stopping) return code;
      quick = now() - started < QUICK_EXIT_SECS * 1000 ? quick + 1 : 0;
      if (quick >= QUICK_EXIT_LIMIT) {
        log(
          `sandbox-runtime-supervisor: the runtime exited with status ${code}, ` +
            `${quick} times in a row within ${QUICK_EXIT_SECS}s of starting; giving up`,
        );
        return code;
      }
      log(`sandbox-runtime-supervisor: the runtime exited with status ${code}; starting it again`);
      await sleep(RESTART_PAUSE_MS);
      // A stop that landed during the pause: the last status is the answer,
      // and nothing starts again.
      if (stopping) return code;
    }
  } finally {
    signals.removeListener("SIGTERM", stop);
    signals.removeListener("SIGINT", stop);
  }
}

// Run only when executed directly (tini runs this file), not when imported by
// the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await supervise({
    runtime: process.env.SANDBOX_RUNTIME || DEFAULT_RUNTIME,
    args: process.argv.slice(2),
    spawn: (runtime, args) => nodeSpawn(runtime, args, { stdio: "inherit" }),
    now: () => Date.now(),
    sleep: sleepFor,
    log: (line) => process.stderr.write(line + "\n"),
    signals: process,
  });
  process.exit(code);
}
