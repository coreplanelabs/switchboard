import { describe, expect, it } from "vitest";
import { ContainerPortLostError, containerRollResponse, isContainerRollStartError } from "./containerStart.ts";

describe("container start — a roll that takes the container away is retryable, not a 500", () => {
  it("recognizes the runtime's no-instance error, however it is wrapped", () => {
    const message = "There is no container instance that can be provided to this Durable Object, try again later";
    expect(isContainerRollStartError(new Error(message))).toBe(true);
    expect(isContainerRollStartError(new Error(message.toLowerCase()))).toBe(true);
    expect(isContainerRollStartError(message)).toBe(true);
    expect(isContainerRollStartError(new Error(message, { cause: new Error("upstream") }))).toBe(true);
  });

  it("recognizes the runtime replacing the container with a new version mid-start", () => {
    expect(
      isContainerRollStartError(new Error("Runtime signalled the container to exit due to a new version rollout: 0")),
    ).toBe(true);
  });

  it("recognizes verified port loss and preserves its original TCP cause", () => {
    const cause = new Error("Network connection lost.");
    const error = new ContainerPortLostError(cause);
    expect(isContainerRollStartError(error)).toBe(true);
    expect(error.cause).toBe(cause);
  });

  it("does not infer port loss from ambiguous TCP or hook-only messages", () => {
    for (const message of [
      "Network connection lost.",
      "The container is not listening",
      "Container crashed while checking for ports, did you start the container and setup the entrypoint correctly?",
      "Container stopped while waiting for a port",
    ]) {
      expect(isContainerRollStartError(new Error(message))).toBe(false);
      expect(isContainerRollStartError(message)).toBe(false);
    }
  });

  it("leaves every other start failure alone, so real errors still surface", () => {
    expect(isContainerRollStartError(new Error("Container did not start after 120000ms"))).toBe(false);
    expect(isContainerRollStartError(new Error("Error proxying request to container: boom"))).toBe(false);
    expect(isContainerRollStartError(new Error("boom"))).toBe(false);
    expect(isContainerRollStartError(undefined)).toBe(false);
    expect(isContainerRollStartError(null)).toBe(false);
  });

  it("answers temporary unavailability with a retry hint", () => {
    const res = containerRollResponse();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
  });
});
