import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, parseAppConfigText } from "../config.js";
import { configuredAgent, settingsForAgent } from "./agents.js";

// Feature: docs/reference/specs/agent-configuration.md.
const installation = (extra = "") => `
extends: builtin
organization: acme
providers:
  openai:
    wire: openai-responses
    baseUrl: https://api.openai.com/v1
${extra}`;

describe("agent configuration DSL", () => {
  it("extends the shipped DSL and resolves every agent and internal caller explicitly", () => {
    const config = parseAppConfigText(installation());
    for (const name of ["general", "coding", "review", "research", "explore", "conductor", "orchestrator", "memory"])
      expect(settingsForAgent(config, name)).toMatchObject({ model: "openai/gpt-6.1-sol", effort: "high" });
    for (const name of ["operator", "intake"])
      expect(settingsForAgent(config, name)).toMatchObject({ model: "openai/gpt-6-luna", effort: "medium" });
  });

  it("extends named profiles and applies installation, profile and agent settings in order", () => {
    const config = parseAppConfigText(
      installation(`
profiles:
  standard:
    model: openai/installation-model
  reviewer:
    extends: standard
    modelSettings:
      reasoning: { effort: xhigh }
agents:
  review:
    profile: reviewer
    modelSettings:
      reasoning: { effort: low }
  operator:
    profile: standard
`),
    );
    expect(settingsForAgent(config, "coding")).toMatchObject({ model: "openai/installation-model", effort: "high" });
    expect(settingsForAgent(config, "review")).toMatchObject({ model: "openai/installation-model", effort: "low" });
    expect(settingsForAgent(config, "operator")).toMatchObject({ model: "openai/installation-model", effort: "high" });
  });

  it("clears inherited effort explicitly and keeps operator settings independent of General", () => {
    const config = parseAppConfigText(
      installation(`
profiles:
  standard:
    modelSettings: { reasoning: { effort: null } }
agents:
  general: { model: openai/general-only }
`),
    );
    expect(settingsForAgent(config, "coding")).toEqual({ model: "openai/gpt-6.1-sol" });
    expect(settingsForAgent(config, "memory")).toEqual({ model: "openai/gpt-6.1-sol" });
    expect(settingsForAgent(config, "operator")).toEqual({ model: "openai/gpt-6-luna", effort: "medium" });
  });

  it("preserves scoped overrides above the installation DSL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-config-"));
    const path = join(dir, "config.yaml");
    writeFileSync(path, installation());
    const store = new ConfigStore(path, join(dir, "overrides.json"));
    await store.setUserOverride("slack:U", { model: "openai/user-model", effort: "low" });
    expect(store.resolve({ channelId: "slack:C", userId: "slack:U", request: { agent: "coding" } })).toMatchObject({
      modelRef: "openai/user-model",
      effort: "low",
    });
    expect(
      store.resolve({ channelId: "slack:C", userId: "slack:U", request: { agent: "coding", effort: "xhigh" } }),
    ).toMatchObject({ effort: "xhigh" });
  });

  it("uses configured instructions, tools and limits without mutating shipped definitions", () => {
    const config = parseAppConfigText(
      installation(`
agents:
  coding:
    instructions: Inspect the repository and report.
    tools: readonly
    limits: { maxTokens: 12000, maxMinutes: 30 }
  review: { description: Review with installation policy. }
`),
    );
    expect(configuredAgent(config, "coding")).toMatchObject({
      system: "Inspect the repository and report.",
      toolset: "readonly",
      maxTokens: 12000,
      maxMinutes: 30,
      maxTurns: 180,
    });
    expect(configuredAgent(config, "conductor").system).toContain("Review with installation policy.");
    const independent = parseAppConfigText(installation());
    independent.agents!.general!.limits!.maxTokens = 1;
    expect(configuredAgent(parseAppConfigText(installation()), "general").maxTokens).toBe(16000);
    expect(configuredAgent(parseAppConfigText(installation()), "coding")).toMatchObject({
      toolset: "full",
      maxTokens: 64000,
      maxMinutes: 90,
    });
  });

  it("rejects unknown fields, missing profiles, cycles and undeclared providers at load", () => {
    for (const extra of [
      "profiles:\n  bad: { effrot: high }",
      "agents:\n  coding: { profile: absent }",
      "profiles:\n  a: { extends: b }\n  b: { extends: a }\n",
      "profiles:\n  standard: { model: absent/model }",
      "agents:\n  typo: { profile: standard }",
      "agents:\n  review: { limits: { maxMinutes: -1 } }",
      "agents:\n  review: { limits: { maxMinutes: 100 } }",
      "agents:\n  review: { identity: write }",
      "agents:\n  coding: { instructions: builtin:typo }",
      "agents:\n  operator: { tools: full }",
    ])
      expect(() => parseAppConfigText(installation(extra))).toThrow();
  });

  it("rejects mixed DSL and legacy settings rather than silently choosing a writer", () => {
    expect(() => parseAppConfigText(installation("defaults:\n  models: { general: openai/old-model }"))).toThrow(
      /legacy|mix/i,
    );
    expect(() => parseAppConfigText(installation("intake:\n  effort: low"))).toThrow(/legacy|mix/i);
  });

  it("reads existing installation YAML with its original defaults and background fallbacks", () => {
    const config = parseAppConfigText(`organization: acme
providers: { openai: { wire: openai-responses } }
defaults:
  agent: general
  models: { general: openai/old-model }
  efforts: { general: medium, coding: high }
intake: { model: openai/old-fast, effort: low }
`);
    expect(settingsForAgent(config, "operator")).toEqual({ model: "openai/old-model", effort: "medium" });
    expect(settingsForAgent(config, "orchestrator")).toEqual({ model: "openai/old-model" });
    expect(settingsForAgent(config, "intake")).toEqual({ model: "openai/old-fast", effort: "low" });
    expect(settingsForAgent(config, "memory", "openai/run-model")).toEqual({ model: "openai/run-model" });
  });
});
