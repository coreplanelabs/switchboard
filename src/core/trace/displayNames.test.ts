// Feature: features/tracing.md — the display names: total over the streamed set, unique, never a raw name.
import { describe, expect, it } from "vitest";
import { DISPLAY_NAMES, displayNameOf, ENUMERATED_SPAN_NAMES, GENERIC_STEP_NAME } from "./displayNames.js";
import { STREAMED_PREFIXES } from "./streamSpans.js";

describe("display names", () => {
  it("every enumerated streamed span has a display name, and no two share one", () => {
    for (const name of ENUMERATED_SPAN_NAMES) {
      expect(typeof DISPLAY_NAMES[name]).toBe("string");
      expect(DISPLAY_NAMES[name].length).toBeGreaterThan(0);
      expect(displayNameOf(name)).toBe(DISPLAY_NAMES[name]);
    }
    const values = Object.values(DISPLAY_NAMES);
    expect(new Set(values).size).toBe(values.length);
  });

  it("no display name is a raw span name (no dotted identifier reaches a surface)", () => {
    for (const value of Object.values(DISPLAY_NAMES)) expect(value).not.toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
  });

  it("prefix families: a tool's own name, an MCP tool's own name, a resident step's label, and the generic fallback", () => {
    expect(displayNameOf("tool.bash")).toBe("bash");
    expect(displayNameOf("tool.read_file")).toBe("read_file");
    expect(displayNameOf("mcp.vanta.list_controls")).toBe("list_controls");
    expect(displayNameOf("dispatch.workspace.attach.install")).toBe("installing dependencies");
    expect(displayNameOf("run.command.test")).toBe("running the tests");
    expect(displayNameOf("dispatch.workspace.attach.mutex_wait")).toBe("waiting for the workspace");
    for (const odd of [
      "tool.",
      "mcp.",
      "mcp",
      "dispatch.workspace.attach.frobnicate",
      "run.command.",
      "not.streamed",
      "",
    ]) {
      expect(displayNameOf(odd)).toBe(GENERIC_STEP_NAME);
    }
    // every streamed prefix family has a rule
    for (const prefix of Object.keys(STREAMED_PREFIXES)) expect(displayNameOf(`${prefix}x`)).not.toBe(`${prefix}x`);
  });
});
