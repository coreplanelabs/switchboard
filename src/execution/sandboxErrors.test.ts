import { describe, expect, it } from "vitest";
import {
  isContainerStarting,
  isFleetBusyError,
  thrownShape,
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
