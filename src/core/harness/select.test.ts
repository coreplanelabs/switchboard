import { describe, expect, it } from "vitest";
import { AGENTS, HARNESSES } from "../../agents/registry.js";
import { effectiveHarness } from "./select.js";

// Feature: docs/reference/specs/harness-pi.md item 1 — which loop drives a
// run is a property of the preset (`AgentDef.harness`, `native` unless
// declared) that a deployment's `harness:` block overrides per preset. Today
// every preset declares native, so a deployment that sets nothing runs exactly
// as before; `harness: { coding: pi }` moves the coding preset alone.

describe("effectiveHarness — the preset's harness, unless the deployment names another", () => {
  it("the two harnesses are native and pi, and every preset in the registry runs native unless a deployment says otherwise", () => {
    expect(HARNESSES).toEqual(["native", "pi"]);
    for (const agent of Object.values(AGENTS)) expect(effectiveHarness(agent, undefined), agent.name).toBe("native");
  });

  it("a deployment's `harness:` block wins for the preset it names and leaves every other preset on its own", () => {
    expect(effectiveHarness(AGENTS.coding, { coding: "pi" })).toBe("pi");
    expect(effectiveHarness(AGENTS.review, { coding: "pi" })).toBe("native");
    expect(effectiveHarness(AGENTS.coding, { coding: "native" })).toBe("native");
    expect(effectiveHarness(AGENTS.coding, {})).toBe("native");
  });

  it("a preset that declares pi runs pi with no block, and a block can pin it back to native", () => {
    const declared = { ...AGENTS.coding, harness: "pi" as const };
    expect(effectiveHarness(declared, undefined)).toBe("pi");
    expect(effectiveHarness(declared, { coding: "native" })).toBe("native");
  });
});
