import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FLEET_BUSY_LOG_PREFIX,
  FLEET_BUSY_REFUSED_EVENT,
  FLEET_BUSY_RUN_ENDED_EVENT,
  fleetBusyRefusedLine,
  fleetBusyRunEndedLine,
  isFleetBusyError,
  thrownShape,
  thrownText,
  FLEET_BUSY_BACKOFF_MS,
  FLEET_BUSY_REASON,
  FLEET_BUSY_WAIT_MAX_MS,
  fleetBusyAnswer,
  fleetBusyExecAnswer,
  fleetBusyExhaustedMessage,
  isFleetBusy,
  isRuntimeUnreachableError,
  RUNTIME_BUSY_BACKOFF_MS,
  RUNTIME_BUSY_ERROR_NAME,
  RUNTIME_BUSY_EXPLANATION,
  RUNTIME_BUSY_REASON,
  RUNTIME_BUSY_WAIT_MAX_MS,
  RUNTIME_UNREACHABLE_ERROR_NAME,
  RUNTIME_UNREACHABLE_REASON,
  isRuntimeBusyError,
  isRuntimeBusySignal,
  runtimeBusyAnswer,
  runtimeBusyExecAnswer,
  runtimeBusyExhaustedMessage,
  runtimeBusyMessage,
  SandboxRuntimeBusyError,
  runtimeUnreachableAnswer,
  runtimeUnreachableExecAnswer,
  runtimeUnreachableMessage,
  SANDBOX_START_BACKOFF_MS,
  SANDBOX_START_WAIT_MAX_MS,
  SANDBOX_STARTING_REASON,
  SandboxRuntimeUnreachableError,
  isWaitReason,
  sandboxStartingAnswer,
  sandboxStartingExecAnswer,
  startWaitExhaustedMessage,
} from "./sandboxErrors.js";
import { BASH_TIMEOUT_MS } from "./bashTimeout.js";
import { ExecCapacityError, ExecInfraError } from "./executor.js";

// Feature: docs/reference/specs/execution.md item 14 — a full sandbox fleet is capacity,
// not a dead sandbox. When concurrent cold runs exhaust max_instances the
// 0.3.x client throws `Failed to create session: 503`; read as an ordinary
// in-body error, two identical ones in a row look like a wedged sandbox and
// the runner fails fast.

describe("isFleetBusy", () => {
  it("recognizes the SDK 0.3.x client's unparsed 503 from createSession", () => {
    expect(isFleetBusy("Failed to create session: 503")).toBe(true);
    // a client that appends the status text is the same condition
    expect(isFleetBusy("Failed to create session: 503 Service Unavailable")).toBe(true);
  });

  it("recognizes the platform's raw no-instance message", () => {
    expect(
      isFleetBusy(
        "There is no container instance that can be provided to this durable object — all instances are in use",
      ),
    ).toBe(true);
    expect(isFleetBusy("There is no Container instance available at this time. Please try again later.")).toBe(true);
  });

  it("recognizes the newer SDKs' CONTAINER_UNAVAILABLE code", () => {
    expect(isFleetBusy('{"code":"CONTAINER_UNAVAILABLE","message":"…"}')).toBe(true);
  });

  it("recognizes the platform's start-rate limit — a burst of fresh threads refused as too many containers per second — as capacity, not a failure", () => {
    expect(isFleetBusy("You are requesting too many containers per second")).toBe(true);
    expect(
      isFleetBusyError({
        name: "Error",
        message: "Failed to start: You are requesting too many containers per second",
      }),
    ).toBe(true);
  });

  it("recognizes the platform's max_instances wording on the 0.13 line — the text that ended two reviews in under a minute each", () => {
    expect(
      isFleetBusy(
        "Maximum number of running container instances exceeded. Try again later, or try configuring a higher value for max_instances",
      ),
    ).toBe(true);
    // the same text after the Worker's own prefix, as the executor sees it in-body
    expect(
      isFleetBusyError({
        name: "Error",
        message: "Maximum number of running container instances exceeded. Try again later",
      }),
    ).toBe(true);
  });

  it("is NOT a stale session, a wedged sandbox, or arbitrary text", () => {
    expect(isFleetBusy("Session 'abc' not found")).toBe(false);
    expect(isFleetBusy("Command execution failed")).toBe(false);
    expect(isFleetBusy("Failed to read file")).toBe(false);
    expect(isFleetBusy("Failed to create session: 500")).toBe(false);
    expect(isFleetBusy("")).toBe(false);
    expect(isFleetBusy("503 Service Unavailable from a repo's own server")).toBe(false);
  });
});

describe("the fleet-busy answer shapes the Worker sends", () => {
  it("names the reason and the explanation, and keeps the SDK's own message as the cause", () => {
    const a = fleetBusyAnswer("Failed to create session: 503");
    expect(a.reason).toBe(FLEET_BUSY_REASON);
    expect(FLEET_BUSY_REASON).toBe("fleet-busy");
    expect(a.error).toMatch(/^fleet-busy: /);
    expect(a.error).toContain("max_instances");
    expect(a.error).toContain("Failed to create session: 503");
  });

  it("the /exec shape carries the dual in-body failure form (error + exit 127 + stderr) like every other exec failure", () => {
    const a = fleetBusyExecAnswer("Failed to create session: 503");
    expect(a).toEqual({ error: a.error, reason: "fleet-busy", stdout: "", stderr: a.error, exitCode: 127 });
    expect(a.error).toMatch(/^fleet-busy: /);
  });

  it("both shapes carry the Durable Object id when the Worker passes it, and omit the key when it does not", () => {
    expect(fleetBusyAnswer("cause", "do-abc").containerId).toBe("do-abc");
    expect(fleetBusyExecAnswer("cause", "do-abc").containerId).toBe("do-abc");
    expect("containerId" in fleetBusyAnswer("cause")).toBe(false);
    expect("containerId" in fleetBusyExecAnswer("cause")).toBe(false);
  });
});

// Feature: docs/reference/specs/execution.md item 14 — a run the full fleet
// ended is one queryable log line on each side, under one stable prefix; every
// other ending logs none. The card and the run record are unchanged.
describe("the fleet-busy ending log lines", () => {
  const facts = {
    refusal: "fleet-busy: no free per-thread sandbox (no container instance that can be provided)",
    waitedMs: 70_000,
    containerId: "do-abc",
  };

  it("the bot's run-ended line carries the run id, the thread, the Durable Object id, the platform's refusal text and the wait spent", () => {
    const err = new ExecCapacityError(fleetBusyExhaustedMessage(70_000), facts);
    const line = fleetBusyRunEndedLine("run-1", "slack:C1:42", err);
    expect(line).not.toBeNull();
    expect(JSON.parse(line as string)).toEqual({
      event: FLEET_BUSY_RUN_ENDED_EVENT,
      run: "run-1",
      thread: "slack:C1:42",
      container: "do-abc",
      refusal: facts.refusal,
      waitedMs: 70_000,
    });
  });

  it("an older Worker's answer without the container id still logs, without the key; an unregistered run logs without the run key", () => {
    const err = new ExecCapacityError(fleetBusyExhaustedMessage(70_000), { refusal: "r", waitedMs: 70_000 });
    const parsed = JSON.parse(fleetBusyRunEndedLine(undefined, "slack:C1:42", err) as string) as Record<
      string,
      unknown
    >;
    expect(parsed.event).toBe(FLEET_BUSY_RUN_ENDED_EVENT);
    expect("container" in parsed).toBe(false);
    expect("run" in parsed).toBe(false);
  });

  it("matches the error by name across an import boundary — a name-and-facts shape logs like the class itself", () => {
    const shaped = Object.assign(new Error("sandbox fleet busy"), { name: "ExecCapacityError", fleetBusy: facts });
    expect(fleetBusyRunEndedLine("run-1", "t", shaped)).not.toBeNull();
  });

  it("a run that ends any other way emits none: a plain error, an infra failure, a capacity ending that is not the fleet's", () => {
    expect(fleetBusyRunEndedLine("run-1", "t", new Error("boom"))).toBeNull();
    expect(
      fleetBusyRunEndedLine("run-1", "t", new ExecInfraError("sandbox worker /exec: down", "answered")),
    ).toBeNull();
    expect(fleetBusyRunEndedLine("run-1", "t", new ExecCapacityError(startWaitExhaustedMessage(600_000)))).toBeNull();
    expect(fleetBusyRunEndedLine("run-1", "t", "fleet busy")).toBeNull();
    expect(fleetBusyRunEndedLine("run-1", "t", null)).toBeNull();
  });

  it("the Worker's refused line names the event, the thread, the container, the refusal and the route when there is one", () => {
    const line = fleetBusyRefusedLine({ thread: "slack:C1:42", container: "do-abc", refusal: "raw", route: "/read" });
    expect(JSON.parse(line)).toEqual({
      event: FLEET_BUSY_REFUSED_EVENT,
      thread: "slack:C1:42",
      container: "do-abc",
      refusal: "raw",
      route: "/read",
    });
  });

  it("both events share the stable prefix a log query selects", () => {
    expect(FLEET_BUSY_REFUSED_EVENT.startsWith(`${FLEET_BUSY_LOG_PREFIX}.`)).toBe(true);
    expect(FLEET_BUSY_RUN_ENDED_EVENT.startsWith(`${FLEET_BUSY_LOG_PREFIX}.`)).toBe(true);
  });

  it("the bot's ending site is the dispatcher's catch-all — the one place every failing run passes — wired once (static)", () => {
    const dispatcher = readFileSync(resolve(import.meta.dirname, "../core/dispatcher.ts"), "utf8");
    expect(dispatcher.match(/fleetBusyRunEndedLine\(/g)).toHaveLength(1); // exactly one call site
    expect(dispatcher).toMatch(/fleetBusyRunEndedLine\(registered\?\.id, msg\.threadKey, err\)/);
  });
});

// Feature: docs/reference/specs/execution.md item 23 — a container still
// starting is named, not waited for inside the first command's deadline.
describe("the sandbox-starting answer shapes the Worker sends", () => {
  it("names the reason, the explanation and the start's phase as the cause; the exec shape is the dual in-body form", () => {
    const a = sandboxStartingAnswer("container not running; starting it");
    expect(a.reason).toBe(SANDBOX_STARTING_REASON);
    expect(SANDBOX_STARTING_REASON).toBe("sandbox-starting");
    expect(a.error).toMatch(/^sandbox-starting: /);
    expect(a.error).toContain("nothing ran yet");
    expect(a.error).toContain("(container not running; starting it)");
    const e = sandboxStartingExecAnswer("container starting");
    expect(e).toEqual({ error: e.error, reason: "sandbox-starting", stdout: "", stderr: e.error, exitCode: 127 });
  });

  it("the three wait tokens are the only reasons the executor re-sends on; anything else is an ordinary failure", () => {
    expect(isWaitReason("fleet-busy")).toBe(true);
    expect(isWaitReason("sandbox-starting")).toBe(true);
    expect(isWaitReason("runtime-busy")).toBe(true);
    expect(isWaitReason("runtime-unreachable")).toBe(false);
    expect(isWaitReason(undefined)).toBe(false);
    expect(isWaitReason("")).toBe(false);
  });

  it("the start budget covers the platform's own start allowances with room, and its poll is denser than the fleet wait's", () => {
    // ten minutes: a midday burst granted containers 2.5–5 min late and two threads died at five
    expect(SANDBOX_START_WAIT_MAX_MS).toBe(10 * 60_000);
    expect(SANDBOX_START_WAIT_MAX_MS).toBeGreaterThan(30_000 + 90_000); // instance grant + port ready, the SDK's defaults
    expect(SANDBOX_START_BACKOFF_MS).toEqual([5_000, 10_000, 15_000]);
    expect(startWaitExhaustedMessage(300_000)).toBe(
      "this is a bug: the thread's sandbox did not finish starting within 300s, and no automatic start wait remained",
    );
  });
});

describe("the executor's bounded wait", () => {
  it("caps at 5 minutes — the default bash budget, so a default command never waits past its own limit", () => {
    expect(FLEET_BUSY_WAIT_MAX_MS).toBe(5 * 60_000);
    expect(FLEET_BUSY_WAIT_MAX_MS).toBe(BASH_TIMEOUT_MS);
  });

  it("backs off 10 s, 20 s, then 30 s forever", () => {
    expect(FLEET_BUSY_BACKOFF_MS).toEqual([10_000, 20_000, 30_000]);
  });

  it("the exhausted message names the wait in seconds and the knob (max_instances)", () => {
    expect(fleetBusyExhaustedMessage(300_000)).toBe(
      "this is a bug: the sandbox fleet had no free per-thread sandbox after waiting 300s (the fleet's max_instances is reached), and no automatic queue remained",
    );
    expect(fleetBusyExhaustedMessage(60_000)).toContain("after waiting 60s");
  });
});

// Feature: docs/reference/specs/execution.md item 14 — on 0.12.x the SDK throws a typed
// `ContainerUnavailableError`; after the Durable Object RPC boundary only its
// name/message survive, so classification takes the name (or code) first and
// the text second. `thrownShape` is the one place that reads a thrown value.
describe("isFleetBusyError / thrownShape", () => {
  it("takes the 0.12.x typed error by name, whatever its text", () => {
    const err = Object.assign(new Error("There is no Container instance available at this time."), {
      name: "ContainerUnavailableError",
    });
    expect(isFleetBusyError(err)).toBe(true);
    expect(isFleetBusyError({ name: "ContainerUnavailableError", message: "anything" })).toBe(true);
  });

  it("takes the error code when a client surfaces it, and falls back to the recognized texts", () => {
    expect(isFleetBusyError({ name: "Error", code: "CONTAINER_UNAVAILABLE", message: "…" })).toBe(true);
    expect(isFleetBusyError(new Error("Failed to create session: 503"))).toBe(true);
    expect(isFleetBusyError("no container instance that can be provided to this durable object")).toBe(true);
  });

  it("is NOT a recycle, a stale session, or an unrelated failure", () => {
    expect(
      isFleetBusyError({ name: "SessionTerminatedError", message: "Session 'x' shell exited (exit code: 143)" }),
    ).toBe(false);
    expect(isFleetBusyError(new Error("Session 'x' not found"))).toBe(false);
    expect(isFleetBusyError(new Error("fetch failed"))).toBe(false);
    expect(isFleetBusyError(undefined)).toBe(false);
  });

  it("thrownShape reads an Error, a plain object, and a string the same way", () => {
    expect(thrownShape(Object.assign(new Error("m"), { name: "N", code: "C" }))).toEqual({
      name: "N",
      code: "C",
      message: "m",
    });
    expect(thrownShape({ name: "N", message: "m" })).toEqual({ name: "N", code: undefined, message: "m" });
    expect(thrownShape("plain")).toEqual({ message: "plain" });
  });
});

// Feature: docs/reference/specs/execution.md items 3 and 6 — a failure text is never
// empty. During a Worker+image rollout a new thread's Durable Object can be
// placed on a container still running the previous 0.3.x image; the 0.12.x
// client turns its `{error}` 400 body into a `SandboxError`
// whose message was `""`, the Worker's `shape.message ?? String(err)` kept the
// empty string, and seven commands rendered as silent `exit 127`s.
describe("thrownText", () => {
  it("returns the SDK's message verbatim (trimmed) when it has one", () => {
    expect(thrownText({ name: "SandboxError", message: "Session 'x' not found" })).toBe("Session 'x' not found");
    expect(thrownText({ message: "  fetch failed \n" })).toBe("fetch failed");
  });

  it("a message-less error names the error name and code and says a rollout may be in progress", () => {
    const text = thrownText({ name: "SandboxError", code: "INTERNAL_ERROR", message: "" });
    expect(text).toBe(
      "sandbox exec failed with no message from the SDK (SandboxError, code INTERNAL_ERROR); the container may still be running a previous image while a Worker/image rollout is in progress — retry in a minute",
    );
    // the incident's exact shape: name, no code, empty message
    expect(thrownText({ name: "SandboxError", code: undefined, message: "" })).toContain("(SandboxError);");
  });

  it("a whitespace-only message counts as empty", () => {
    expect(thrownText({ name: "Error", message: "  \n\t" })).toMatch(
      /^sandbox exec failed with no message from the SDK \(Error\)/,
    );
  });

  it("no name at all still yields a non-empty text that says so", () => {
    const text = thrownText({});
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("(no error name)");
    expect(thrownText({ message: undefined })).toContain("(no error name)");
  });
});

// Feature: docs/reference/specs/execution.md item 9 — a runtime that did not
// answer is named, with the container. The SDK's connect to the container's
// control port aborts after 30 s with a bare `The operation was aborted`; the
// Durable Object carries the token, the container id, the SDK pin and the
// platform's running flag instead.
describe("the runtime-unreachable message and error", () => {
  const facts = {
    containerId: "3708bca6db4a",
    running: true,
    sdkVersion: "0.13.0-next.751.1",
    cause: "The operation was aborted",
  };

  it("starts with the token and names the container, the SDK pin, the platform's flag and the cause", () => {
    const m = runtimeUnreachableMessage(facts);
    expect(m.startsWith("runtime-unreachable: ")).toBe(true);
    expect(m).toContain("container 3708bca6db4a");
    expect(m).toContain("sandbox SDK 0.13.0-next.751.1");
    expect(m).toContain("reports the container running");
    expect(m).toContain("(The operation was aborted)");
    expect(m).toContain("/workspace is intact");
    expect(m).toContain("nothing ran");
  });

  it("says when the platform reports the container stopped, or nothing, and when the cause is empty", () => {
    expect(runtimeUnreachableMessage({ ...facts, running: false })).toContain("reports the container stopped");
    expect(runtimeUnreachableMessage({ ...facts, running: undefined })).toContain("a state it did not report");
    expect(runtimeUnreachableMessage({ ...facts, cause: "  " })).toContain("(no detail from the SDK)");
  });

  it("the typed error carries the name and the token, and is recognized by either after the RPC boundary", () => {
    const err = new SandboxRuntimeUnreachableError(facts);
    expect(err.name).toBe(RUNTIME_UNREACHABLE_ERROR_NAME);
    expect(err.reason).toBe("runtime-unreachable");
    expect(isRuntimeUnreachableError(err)).toBe(true);
    // Across the boundary: a plain object with the name, or with the message only.
    expect(isRuntimeUnreachableError({ name: RUNTIME_UNREACHABLE_ERROR_NAME, message: "" })).toBe(true);
    expect(isRuntimeUnreachableError(new Error(err.message))).toBe(true);
    expect(isRuntimeUnreachableError("runtime-unreachable: the sandbox container's runtime did not answer")).toBe(true);
  });

  it("is NOT a fleet-busy, a recycle, a stale session or an unrelated failure", () => {
    expect(isRuntimeUnreachableError(new Error("HTTP error! status: 500"))).toBe(false);
    expect(
      isRuntimeUnreachableError({ name: "ContainerUnavailableError", message: "no container instance available" }),
    ).toBe(false);
    expect(
      isRuntimeUnreachableError({ name: "SessionTerminatedError", message: "Session 'x' shell exited (exit code: 1)" }),
    ).toBe(false);
    expect(isRuntimeUnreachableError(new Error("Session 'x' not found"))).toBe(false);
    expect(isFleetBusyError(new SandboxRuntimeUnreachableError(facts))).toBe(false);
  });
});

describe("the runtime-unreachable answer shapes the Worker sends", () => {
  const message = runtimeUnreachableMessage({ containerId: "c1", running: true, sdkVersion: "0.13.0", cause: "x" });

  it("the /read and /write shape carries the reason and the text as the error", () => {
    expect(runtimeUnreachableAnswer(message)).toEqual({ error: message, reason: RUNTIME_UNREACHABLE_REASON });
    expect(RUNTIME_UNREACHABLE_REASON).toBe("runtime-unreachable");
  });

  it("the /exec shape is the dual in-body failure form (error + exit 127 + stderr) plus the reason", () => {
    expect(runtimeUnreachableExecAnswer(message)).toEqual({
      error: message,
      reason: "runtime-unreachable",
      stdout: "",
      stderr: message,
      exitCode: 127,
    });
  });
});

// Feature: docs/reference/specs/execution.md item 28 — a container that did not
// accept the connection is a wait, not a dead sandbox: the platform's accept
// refusal met before a process was started is named with a token the executor
// re-sends on. The token names the refusal, never its cause: the platform's
// words blame load, and an idle container has met them live.
describe("the runtime-busy signal, message and error", () => {
  const PLATFORM =
    "Container is taking too long to accept the connection; the application could be overwhelmed with load";

  it("recognizes the platform's accept refusal by its wording, as a plain Error or a bare shape, and nothing else", () => {
    expect(isRuntimeBusySignal(new Error(PLATFORM))).toBe(true);
    expect(isRuntimeBusySignal({ message: PLATFORM })).toBe(true);
    expect(isRuntimeBusySignal(new Error("The operation was aborted"))).toBe(false);
    expect(isRuntimeBusySignal(new Error("no container instance available"))).toBe(false);
    expect(isRuntimeBusySignal(new Error("Session 'x' shell exited (exit code: 1)"))).toBe(false);
    expect(isRuntimeBusySignal("Container is taking too long to accept the connection")).toBe(false);
    expect(isRuntimeBusySignal(null)).toBe(false);
  });

  it("the message starts with the token, says nothing ran and the request is re-sent, and names the container and the platform's words", () => {
    const m = runtimeBusyMessage({ containerId: "3708bca6db4a", cause: PLATFORM });
    expect(m.startsWith("runtime-busy: ")).toBe(true);
    expect(m).toContain("nothing ran");
    expect(m).toContain("re-sent");
    expect(m).toContain("container 3708bca6db4a");
    expect(m).toContain(PLATFORM);
    expect(runtimeBusyMessage({ containerId: "c", cause: "  " })).toContain("no detail from the platform");
  });

  it("the typed error carries the name and the token, and is recognized by either after the RPC boundary", () => {
    const err = new SandboxRuntimeBusyError({ containerId: "c1", cause: PLATFORM });
    expect(err.name).toBe(RUNTIME_BUSY_ERROR_NAME);
    expect(err.reason).toBe("runtime-busy");
    expect(isRuntimeBusyError(err)).toBe(true);
    expect(isRuntimeBusyError({ name: RUNTIME_BUSY_ERROR_NAME, message: "" })).toBe(true);
    expect(isRuntimeBusyError(new Error(err.message))).toBe(true);
    expect(isRuntimeBusyError("runtime-busy: the thread's sandbox container is running but did not accept")).toBe(true);
  });

  it("is NOT a fleet-busy, a runtime-unreachable, a recycle or the platform's bare words — the Worker names it, the executor reads the token", () => {
    expect(isRuntimeBusyError(new Error(PLATFORM))).toBe(false);
    expect(isRuntimeBusyError(new Error("runtime-unreachable: the sandbox container's runtime did not answer"))).toBe(
      false,
    );
    expect(isRuntimeBusyError({ name: "ContainerUnavailableError", message: "no container instance available" })).toBe(
      false,
    );
    expect(
      isRuntimeBusyError({ name: "SessionTerminatedError", message: "Session 'x' shell exited (exit code: 1)" }),
    ).toBe(false);
    const err = new SandboxRuntimeBusyError({ containerId: "c1", cause: PLATFORM });
    expect(isFleetBusyError(err)).toBe(false);
    expect(isRuntimeUnreachableError(err)).toBe(false);
  });

  it("the wait is bounded like the fleet's and polls denser than the start's; the exhausted message names the wait and the refusal, never a cause", () => {
    expect(RUNTIME_BUSY_WAIT_MAX_MS).toBe(5 * 60_000);
    expect(RUNTIME_BUSY_BACKOFF_MS).toEqual([3_000, 5_000, 10_000]);
    expect(RUNTIME_BUSY_BACKOFF_MS[0]).toBeLessThan(SANDBOX_START_BACKOFF_MS[0]);
    expect(runtimeBusyExhaustedMessage(60_000)).toBe(
      "sandbox busy — the thread's container did not accept a connection within 60s (the platform refused every connect of the wait; a command saturating its cores is one cause, an idle container has met it too); retry",
    );
  });

  // Seen live on an idle container (a review thread running `sed` and `grep`,
  // the connection accepted 0.9 s before and 0.8 s after the refused one): the
  // words the model and the operator read must not assert what loads the
  // container, nor tell them to wait for a command that is not running.
  it("neither the explanation nor the exhausted message asserts a cause the platform never proved", () => {
    for (const text of [RUNTIME_BUSY_EXPLANATION, runtimeBusyExhaustedMessage(60_000)]) {
      expect(text).not.toMatch(/loaded|every core|wait for it to finish|overwhelmed/i);
      expect(text).toMatch(/did not accept/);
    }
    expect(RUNTIME_BUSY_EXPLANATION).toContain("nothing ran");
  });
});

describe("the runtime-busy answer shapes the Worker sends", () => {
  const message = runtimeBusyMessage({ containerId: "c1", cause: "x" });

  it("the /read and /write shape carries the reason and the text as the error", () => {
    expect(runtimeBusyAnswer(message)).toEqual({ error: message, reason: RUNTIME_BUSY_REASON });
    expect(RUNTIME_BUSY_REASON).toBe("runtime-busy");
  });

  it("the /exec shape is the dual in-body failure form (error + exit 127 + stderr) plus the reason", () => {
    expect(runtimeBusyExecAnswer(message)).toEqual({
      error: message,
      reason: "runtime-busy",
      stdout: "",
      stderr: message,
      exitCode: 127,
    });
  });
});
