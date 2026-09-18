import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The model proxy (docs/reference/specs/model-proxy.md) is three routes on the
// bot's container; the shim's part is to know nothing about them: it answers
// three paths itself and forwards every other path to the container, so a
// model call reaches the bot unread, and it holds the provider keys only to
// hand them into the container's environment. Plain Node, like
// coordinator.test.ts: worker.ts is read as text, never loaded.

const read = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");

describe("the shim forwards the model proxy's paths to the container blind", () => {
  const source = read("worker.ts");

  it("answers three paths itself — the restart, the coordinator's instance create and its status — and hands every other path to the container, so /v1/messages, /v1/chat/completions and /v1/responses reach the bot unread", () => {
    expect(source).toMatch(/pathname === "\/admin\/restart"\s*\?\s*await handleAdminRestart\(/);
    expect(source).toMatch(/pathname === COORDINATOR_INSTANCES_PATH\s*\?\s*await handleCoordinatorInstances\(/);
    expect(source).toMatch(/statusId !== undefined\s*\?\s*await handleCoordinatorInstanceStatus\(/);
    // The container's answer passes through with its length declared (knownLength.ts) — nothing else touches it.
    expect(source).toMatch(/:\s*withLength\(await getContainer\(env\.SWITCHBOARD, INSTANCE\)\.fetch\(forwarded\)\)/);
    // A path the shim's own route table gives no root to is forwarded as it came.
    expect(source).toMatch(
      /if \(route === undefined\) return withLength\(await getContainer\(env\.SWITCHBOARD, INSTANCE\)\.fetch\(inbound\)\);/,
    );
    // Nothing in the shim knows the proxy's paths: no route of its own, no rewrite, no read of a body.
    expect(source).not.toContain("/v1/");
    expect(source).not.toContain("model-proxy");
  });

  it("holds the model keys only to hand them into the container: each appears in the Env type and the forward list alone, never in a header, a URL or a fetch", () => {
    const keyLines = source
      .split("\n")
      .filter((line) => /ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY/.test(line));
    expect(keyLines.length).toBeGreaterThan(0);
    for (const line of keyLines) {
      expect(line).toMatch(
        /^\s+(?:ANTHROPIC_API_KEY: string;|OPENAI_API_KEY\?: string;|OPENROUTER_API_KEY\?: string;|"OPENAI_API_KEY",|"OPENROUTER_API_KEY",|ANTHROPIC_API_KEY: env\.ANTHROPIC_API_KEY,)/,
      );
    }
    // The two optional provider keys the example config's blocks name are both forwarded: a
    // key put on the Worker that the container never sees is `provider_key_missing` at the
    // first model call on that block (the OpenRouter block shipped live without this line).
    expect(source).toContain('"OPENAI_API_KEY",');
    expect(source).toContain('"OPENROUTER_API_KEY",');
    expect(source).not.toMatch(/x-api-key/i);
    expect(source).not.toContain("api.anthropic.com");
    expect(source).not.toContain("ANTHROPIC_API_KEY_ENV");
  });
});
