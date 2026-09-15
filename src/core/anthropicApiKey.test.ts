import { describe, expect, it } from "vitest";
import { secretsFrom } from "../secrets.js";
import { anthropicApiKey } from "./anthropicApiKey.js";

// Feature: docs/reference/specs/reading-diff.md item 6 — the one credential
// getter: the first anthropic provider's `apiKeyEnv`, never a fallback.

describe("anthropicApiKey — the one credential getter", () => {
  const secrets = (env: Record<string, string>) => secretsFrom(env);

  it("reads the first anthropic provider's apiKeyEnv, defaulting to ANTHROPIC_API_KEY, as a Secret named after its variable", () => {
    const k1 = anthropicApiKey(
      { oa: { type: "openai-compatible" }, ant: { type: "anthropic" } },
      secrets({ ANTHROPIC_API_KEY: "k1" }),
    );
    expect(k1?.reveal()).toBe("k1");
    expect(String(k1)).toBe("[secret:ANTHROPIC_API_KEY]"); // never the value by accident
    const k2 = anthropicApiKey(
      { ant: { type: "anthropic", apiKeyEnv: "MY_KEY" } },
      secrets({ MY_KEY: "k2", ANTHROPIC_API_KEY: "x" }),
    );
    expect(k2?.reveal()).toBe("k2");
    expect(k2?.name).toBe("MY_KEY");
  });

  it("is undefined without an anthropic provider, or when its variable is unset or blank — never a fallback", () => {
    expect(
      anthropicApiKey({ oa: { type: "openai-compatible" } }, secrets({ ANTHROPIC_API_KEY: "k1" })),
    ).toBeUndefined();
    expect(
      anthropicApiKey({ ant: { type: "anthropic", apiKeyEnv: "MY_KEY" } }, secrets({ ANTHROPIC_API_KEY: "k1" })),
    ).toBeUndefined();
    expect(anthropicApiKey({ ant: { type: "anthropic" } }, secrets({ ANTHROPIC_API_KEY: "  " }))).toBeUndefined();
  });
});
