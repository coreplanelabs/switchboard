import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { authenticateProxyUnknownTerminal, proxyUnknownTerminalIsAuthenticated } from "./providerFailureAuth.js";

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomBytes: (size: number) => Buffer.alloc(size, 7),
}));

// Feature: docs/reference/specs/harness-pi.md item 6 — diagnostics are signed
// evidence, never provider causes or permission to retry a model call.
describe("unknown terminal authentication", () => {
  it("preserves legacy markers and signs only closed structural reasons", () => {
    const legacy = authenticateProxyUnknownTerminal();
    expect(legacy).not.toHaveProperty("reason");
    const nonce = Buffer.alloc(16, 7).toString("base64url");
    const oldMac = createHmac("sha256", Buffer.alloc(32, 7))
      .update(JSON.stringify(["v1", nonce, "model_terminal_unknown"]))
      .digest("base64url");
    expect(legacy._switchboard_proxy_auth).toBe(`v1.${nonce}.${oldMac}`);
    expect(proxyUnknownTerminalIsAuthenticated(JSON.stringify(legacy))).toBe(true);
    for (const reason of ["malformed_json", "consumer_rejected", "unverified_terminal"] as const) {
      const signed = authenticateProxyUnknownTerminal(reason);
      expect(signed).toHaveProperty("reason", reason);
      expect(proxyUnknownTerminalIsAuthenticated(`SDK prefix ${JSON.stringify(signed)}`)).toBe(true);
      expect(proxyUnknownTerminalIsAuthenticated(JSON.stringify({ ...signed, reason: "private provider prose" }))).toBe(
        false,
      );
      expect(
        proxyUnknownTerminalIsAuthenticated(
          JSON.stringify({ ...signed, reason: reason === "malformed_json" ? "consumer_rejected" : "malformed_json" }),
        ),
      ).toBe(false);
      const { reason: _removed, ...stripped } = signed;
      expect(proxyUnknownTerminalIsAuthenticated(JSON.stringify(stripped))).toBe(false);
    }
    expect(proxyUnknownTerminalIsAuthenticated(JSON.stringify({ ...legacy, reason: "consumer_rejected" }))).toBe(false);
    expect(proxyUnknownTerminalIsAuthenticated(JSON.stringify([legacy, legacy]))).toBe(false);
  });
});
