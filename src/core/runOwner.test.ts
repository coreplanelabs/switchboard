// Feature: features/tracing.md — the one discriminator for a command run.
import { describe, expect, it } from "vitest";
import { COMMAND_RUN_AGENT, runOwnerOf } from "./runOwner.js";

describe("runOwnerOf", () => {
  it("names the command owner for a command run's agent and the agent owner for everything else", () => {
    expect(runOwnerOf(COMMAND_RUN_AGENT)).toBe("command");
    expect(runOwnerOf("coding")).toBe("agent");
    expect(runOwnerOf(undefined)).toBe("agent");
    expect(runOwnerOf(null)).toBe("agent");
  });
});
