import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../config.js";
import { bindConversationRead } from "./conversationRead.js";

function fixture(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "swb-reader-binding-"));
  const path = join(dir, "config.yaml");
  writeFileSync(
    path,
    `organization: acme
providers:
  anthropic: { type: anthropic, apiKeyEnv: ANTHROPIC_API_KEY }
defaults: { agent: general, models: { general: anthropic/model } }
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
restrict: { agents: [research] }
`,
  );
  return {
    deps: { config: new ConfigStore(path, join(dir, "overrides.json")) },
    message: { text, userId: "slack:UADMIN", channelId: "mcp:default", threadKey: "mcp:default:one" },
  };
}

describe("conversation read binding", () => {
  it("reuses the permitted preset projection and preserves a narrower child request", async () => {
    const { deps, message } = fixture("agent:orchestrator budget:20 effort:high research storage");
    const request = {
      preset: "research",
      prompt: "Explain storage.",
      budget: 5,
      effort: "low" as const,
      model: "anthropic/model",
    };
    expect(await bindConversationRead(deps, message, request)).toEqual({
      kind: "bound",
      request: {
        preset: "research",
        prompt: "Explain storage.",
        budget: 5,
        effort: "low",
        model: "anthropic/model",
      },
    });
    expect(
      await bindConversationRead(
        deps,
        { ...message, userId: "slack:UOTHER" },
        { preset: "research", prompt: "Explain storage." },
      ),
    ).toMatchObject({ kind: "refused" });
  });

  it("retains the authored PR identifier in the child request and the typed target", async () => {
    const url = "https://github.com/acme/api/pull/7";
    const { deps, message } = fixture(`agent:orchestrator review ${url}`);
    expect(
      await bindConversationRead(
        deps,
        message,
        { preset: "review", repo: "ACME/API", prompt: "Review carefully." },
        { number: 7, source: "request", quote: url },
      ),
    ).toEqual({
      kind: "bound",
      request: { preset: "review", repo: "acme/api", prompt: `Review carefully.\n\nSelected pull request: ${url}` },
      target: { repo: "acme/api", prTarget: { number: 7, source: "request", quote: url } },
    });
  });

  it.each([
    undefined,
    { number: 8, source: "request", quote: "https://github.com/acme/api/pull/8" },
    { number: 8, source: "request", quote: "https://github.com/acme/api/pull/7" },
    { number: 7, source: "thread", quote: "https://github.com/acme/api/pull/7" },
  ])("holds a review without valid current-request target evidence: %j", async (target) => {
    const { deps, message } = fixture("agent:orchestrator review https://github.com/acme/api/pull/7");
    expect(
      await bindConversationRead(
        deps,
        message,
        { preset: "review", repo: "acme/api", prompt: "Review carefully." },
        target,
      ),
    ).toMatchObject({ kind: "refused" });
  });
});
