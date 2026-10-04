import { describe, expect, it } from "vitest";
import { isNoContainerInstanceError, noContainerInstanceResponse } from "./containerStart.ts";

describe("container start — a roll with no instance is retryable, not a 500", () => {
  it("recognizes the runtime's no-instance error, however it is wrapped", () => {
    const message = "There is no container instance that can be provided to this Durable Object, try again later";
    expect(isNoContainerInstanceError(new Error(message))).toBe(true);
    expect(isNoContainerInstanceError(new Error(message.toLowerCase()))).toBe(true);
    expect(isNoContainerInstanceError(message)).toBe(true);
    expect(isNoContainerInstanceError(new Error(message, { cause: new Error("upstream") }))).toBe(true);
  });

  it("leaves every other start failure alone, so real errors still surface", () => {
    expect(isNoContainerInstanceError(new Error("Container did not start after 120000ms"))).toBe(false);
    expect(
      isNoContainerInstanceError(new Error("Runtime signalled the container to exit due to a new version rollout: 0")),
    ).toBe(false);
    expect(isNoContainerInstanceError(new Error("boom"))).toBe(false);
    expect(isNoContainerInstanceError(undefined)).toBe(false);
    expect(isNoContainerInstanceError(null)).toBe(false);
  });

  it("answers 503 with Retry-After, the status a webhook sender redelivers on", () => {
    const res = noContainerInstanceResponse();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
  });
});
