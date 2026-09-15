#!/bin/sh
# PID 1 of the cold sandbox: keeps the container alive across a crash of the
# SDK's container server (/container-server/sandbox). That server calls
# process.exit(1) on any uncaught exception, and as the base image's
# ENTRYPOINT it was PID 1 — so one uncaught error ended the whole container:
# /workspace gone, a detached pi with it, every later /exec a 500 until the
# platform noticed. Started here as a child instead, the server's exit is a
# restart a second later; the disk, the detached processes and the Durable
# Object's view of a running container all survive, and the SDK recreates its
# session on the next command (docs/reference/specs/execution.md item 21).
#
# A stop from the platform is SIGTERM to PID 1: forwarded to the server, and
# nothing starts again — a stop that lands during the pause between two
# starts, or before the new pid is known, still ends here — and the server's
# own exit status becomes this script's. A terminal's INT is forwarded as
# TERM too: a child started with `&` by a non-interactive shell ignores INT
# (POSIX), so INT itself would stop nothing. A server that cannot stay up —
# QUICK_EXIT_LIMIT exits in a row, each within QUICK_EXIT_SECS of starting —
# ends the container with the last status instead of looping forever.
# src/deploy/sandboxRuntimeSupervisor.test.ts holds the shape and drives it.
set -u
RUNTIME=${SANDBOX_RUNTIME:-/container-server/sandbox}
QUICK_EXIT_SECS=10
QUICK_EXIT_LIMIT=5
pid=
stopping=
quick=0
code=0

on_signal() {
  stopping=1
  if [ -n "$pid" ]; then kill -TERM "$pid" 2>/dev/null; fi
}
trap on_signal TERM INT

while :; do
  started=$(date +%s)
  "$RUNTIME" "$@" &
  pid=$!
  # A stop that landed between the start and this line found no pid to
  # forward to; the server it missed gets it here.
  if [ -n "$stopping" ]; then kill -TERM "$pid" 2>/dev/null; fi
  wait "$pid"
  code=$?
  # A trapped signal ends `wait` early (status > 128) while the server still
  # runs; wait again until it is really gone, so the status is its own.
  while kill -0 "$pid" 2>/dev/null; do
    wait "$pid"
    code=$?
  done
  pid=
  if [ -n "$stopping" ]; then exit "$code"; fi
  if [ $(( $(date +%s) - started )) -lt "$QUICK_EXIT_SECS" ]; then
    quick=$((quick + 1))
  else
    quick=0
  fi
  if [ "$quick" -ge "$QUICK_EXIT_LIMIT" ]; then
    echo "sandbox-runtime-supervisor: the runtime exited with status $code, $quick times in a row within ${QUICK_EXIT_SECS}s of starting; giving up" >&2
    exit "$code"
  fi
  echo "sandbox-runtime-supervisor: the runtime exited with status $code; starting it again" >&2
  sleep 1
  # A stop that landed during the pause: the last status is the answer, and
  # nothing starts again.
  if [ -n "$stopping" ]; then exit "$code"; fi
done
