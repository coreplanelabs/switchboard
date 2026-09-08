// Feature: features/tracing.md — the display names: total over the streamed set, unique, never a raw name.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DISPLAY_NAMES,
  displayNameOf,
  ENUMERATED_SPAN_NAMES,
  GENERIC_STEP_NAME,
  RESIDENT_STEP_NAMES,
} from "./displayNames.js";
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

// The resident Worker names each command it runs (`runOk(argv, "<step>", …)`,
// `gitWithCred(token, argv, "<step>", …)`); the grafted span is
// `dispatch.workspace.attach.<step>` / `run.command.<step>`, and a run page read
// `a Switchboard step` twenty times over one attach until every name here had a
// label. The scan keeps the table honest: a step added to the Worker without
// a label fails, and a label for a step the Worker no longer names is noise.
describe("resident step labels (features/tracing.md item 15)", () => {
  const source = readFileSync(new URL("../../../deploy/cloudflare-resident/worker.ts", import.meta.url), "utf8");
  const named = new Set<string>();
  for (const m of source.matchAll(/(?:runOk|run|gitWithCred|runAs|runStep)\([^)]*"([a-z][a-z0-9_-]{2,30})"/g))
    named.add(m[1]!);

  it("every step name the resident Worker passes to a command runner has a label, under both graft prefixes", () => {
    expect(named.size).toBeGreaterThan(20); // the scan found the call sites
    const unlabeled = [...named].filter((n) => displayNameOf(`dispatch.workspace.attach.${n}`) === GENERIC_STEP_NAME);
    expect(unlabeled).toEqual([]);
    for (const n of named) expect(displayNameOf(`run.command.${n}`)).toBe(RESIDENT_STEP_NAMES[n]);
  });

  it("no label is a raw step name and none is empty", () => {
    for (const [step, label] of Object.entries(RESIDENT_STEP_NAMES)) {
      expect(label.length).toBeGreaterThan(3);
      expect(label).not.toBe(step);
      expect(label).not.toMatch(/[._]/);
    }
  });
});
