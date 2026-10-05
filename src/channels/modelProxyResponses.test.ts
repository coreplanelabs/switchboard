import { describe, expect, it } from "vitest";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import type { Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { PiBridge } from "../core/harness/pi/bridge.js";
import { ResponsesFailureBoundary } from "./modelProxyResponses.js";

// Feature: docs/reference/specs/harness-pi.md item 6 — the real pi adapter
// preserves signed structural diagnostics without copying provider payloads.
describe("Responses unknown terminal diagnostics", () => {
  it("carries structural reasons through the real pi adapter without provider prose or replay", async () => {
    const model: Model<"openai-responses"> = {
      id: "test",
      name: "test",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://proxy.test/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 1000,
    };
    for (const [data, reason] of [
      ["private invalid JSON", "malformed_json"],
      [
        'private invalid JSON\n\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"private later transient"}}}',
        "malformed_json",
      ],
      ["null", "consumer_rejected"],
      [
        JSON.stringify({
          type: "response.failed",
          response: { status: "failed", error: { code: "unknown", message: "private provider response" } },
        }),
        "unverified_terminal",
      ],
    ] as const) {
      const boundary = new ResponsesFailureBoundary({ model: "test" });
      let calls = 0;
      const message = await stream(model, normalizeContext({ messages: [] }), {
        apiKey: "test",
        maxRetries: 0,
        fetch: (async () => {
          calls++;
          const body = new Response(`data: ${data}\n\n`).body!.pipeThrough(boundary.transform());
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }) as typeof fetch,
      }).result();
      const bridge = new PiBridge({ emit: () => {}, clock: () => 0 });
      const result = bridge.observe({ type: "message_end", message });
      expect(result.terminalFailure).toMatchObject({
        kind: "unknown",
        diagnostic: { source: "proxy", reason, errorMessage: "present", contentParts: 0 },
      });
      expect(result.providerFailure).toBeUndefined();
      expect(result.message).toBeUndefined();
      expect(message.errorMessage).not.toContain("private");
      expect(boundary.failure).toBeUndefined();
      expect(calls).toBe(1);
    }
  });
});
