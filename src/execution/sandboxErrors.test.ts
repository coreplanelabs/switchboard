import { describe, expect, it } from "vitest";
import {
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
  RUNTIME_UNREACHABLE_ERROR_NAME,
  RUNTIME_UNREACHABLE_REASON,
  runtimeUnreachableAnswer,
  runtimeUnreachableExecAnswer,
  runtimeUnreachableMessage,
  SandboxRuntimeUnreachableError,
} from "./sandboxErrors.js";
import { BASH_TIMEOUT_MS } from "./bashTimeout.js";

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
      "sandbox fleet busy — no free per-thread sandbox after waiting 300s (the fleet's max_instances is reached); try again in a few minutes",
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
