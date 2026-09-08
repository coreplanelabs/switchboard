import { describe, expect, it } from "vitest";
import {
  isContainerStarting,
  isFleetBusyError,
  legacyContainerError,
  thrownShape,
  thrownText,
  FLEET_BUSY_BACKOFF_MS,
  FLEET_BUSY_REASON,
  FLEET_BUSY_WAIT_MAX_MS,
  fleetBusyAnswer,
  fleetBusyExecAnswer,
  fleetBusyExhaustedMessage,
  isFleetBusy,
} from "./sandboxErrors.js";
import { BASH_TIMEOUT_MS } from "./bashTimeout.js";

// Feature: features/execution.md item 14 — a full sandbox fleet is capacity,
// not a dead sandbox. 2026-09-07: the #525 review aborted in 33 s on
// `Failed to create session: 503` (thirteen cold runs in 45 min had exhausted
// max_instances 10); the runner read the two identical in-body errors as a
// wedged sandbox and failed fast.

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

// Feature: features/execution.md item 14 — on 0.12.x the SDK throws a typed
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

// Feature: features/execution.md item 4 — a booting container is the one
// failure the Worker still retries itself: nothing ran.
describe("isContainerStarting", () => {
  it("recognizes the 0.12.x boot-time answer and nothing else", () => {
    expect(isContainerStarting(new Error("Container is starting. Please retry in a moment."))).toBe(true);
    expect(isContainerStarting({ message: "Container is starting. Please retry in a moment" })).toBe(true);
    expect(isContainerStarting(new Error("Container is starting the wrong way"))).toBe(false);
    expect(isContainerStarting(new Error("no Container instance available"))).toBe(false);
  });
});

// Feature: features/execution.md items 3 and 6 — a failure text is never
// empty. 2026-09-07 (#569): during the 0.4.0 Worker+image rollout a new
// thread's Durable Object was placed on a container still running the 0.3.7
// image; the 0.12.9 client turned its `{error}` 400 body into a `SandboxError`
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

// Feature: features/execution.md items 6 and 9 — the legacy-container shape a
// 0.12.x client produces against a 0.3.x server: `SandboxError` (the base
// class, not a typed subclass), an empty message, no code. Matched INSIDE the
// Durable Object, where the prototype and the `code` getter are intact, so
// `instanceof Error` plus the name is the whole test.
describe("legacyContainerError", () => {
  // Mirrors 0.12.9's `SandboxError`: `message` comes from the body's
  // `message` (absent → ""), `code` from the body's `code`, and the raw body
  // is kept as `errorResponse`.
  const sandboxError = (body: Record<string, unknown>) => {
    const err = new Error(typeof body.message === "string" ? body.message : "");
    err.name = "SandboxError";
    if (body.code !== undefined) Object.assign(err, { code: body.code });
    Object.assign(err, { errorResponse: body });
    return err;
  };
  const LEGACY_BODY = { error: "Session ID and command are required" };

  it("matches a SandboxError built from a 0.3.7 {error} body — empty message, no code, the old server's text in errorResponse.error", () => {
    expect(legacyContainerError(sandboxError(LEGACY_BODY))).toBe(true);
    expect(legacyContainerError(sandboxError({ error: "Session 'x' not found" }))).toBe(true);
  });

  it("is NOT a SandboxError with a message or a code (every 0.12.x body has both), one whose body has no error text, a plain Error, or a non-Error", () => {
    expect(legacyContainerError(sandboxError({ error: "x", message: "Session 'x' not found" }))).toBe(false);
    expect(legacyContainerError(sandboxError({ error: "x", code: "INTERNAL_ERROR" }))).toBe(false);
    expect(legacyContainerError(sandboxError({}))).toBe(false);
    expect(legacyContainerError(sandboxError({ error: "" }))).toBe(false);
    const noBody = new Error("");
    noBody.name = "SandboxError";
    expect(legacyContainerError(noBody)).toBe(false);
    expect(legacyContainerError(new Error(""))).toBe(false);
    expect(legacyContainerError({ name: "SandboxError", message: "" })).toBe(false);
    expect(legacyContainerError(undefined)).toBe(false);
    expect(legacyContainerError("")).toBe(false);
  });
});
