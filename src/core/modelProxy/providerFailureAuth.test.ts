import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  authenticateProxyUnknownTerminal,
  proxyUnknownTerminalIsAuthenticated,
  authenticateProxyTurnBudgetExhausted,
  readProxyTurnBudgetExhausted,
  proxyProviderFailureIsAuthenticated,
} from "./providerFailureAuth.js";

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomBytes: (size: number) => Buffer.alloc(size, 7),
}));

// Feature: docs/reference/specs/harness-pi.md item 6 — diagnostics are signed
// evidence, never provider causes or permission to retry a model call.
describe("unknown terminal authentication", () => {
  it("binds local turn-cap evidence to exact run and counts without provider authority", () => {
    const signed = authenticateProxyTurnBudgetExhausted({ runId: "run-1", turns: 150, maxTurns: 150 });
    expect(readProxyTurnBudgetExhausted(`403 ${JSON.stringify({ error: signed })}`, "run-1")).toMatchObject({
      runId: "run-1",
      turns: 150,
      maxTurns: 150,
    });
    expect(readProxyTurnBudgetExhausted(JSON.stringify(signed), "another-run")).toBeUndefined();
    expect(readProxyTurnBudgetExhausted(JSON.stringify(signed), undefined)).toBeUndefined();
    for (const changed of [
      { ...signed, turns: 151 },
      { ...signed, maxTurns: 151 },
      { ...signed, maxTurns: 149 },
      { ...signed, runId: "another-run" },
      { ...signed, message: "private text" },
    ])
      expect(readProxyTurnBudgetExhausted(JSON.stringify(changed), changed.runId)).toBeUndefined();
    expect(readProxyTurnBudgetExhausted(JSON.stringify([signed, signed]), "run-1")).toBeUndefined();
    expect(proxyProviderFailureIsAuthenticated(JSON.stringify(signed))).toBe(false);
    expect(proxyUnknownTerminalIsAuthenticated(JSON.stringify(signed))).toBe(false);
    expect(() => authenticateProxyTurnBudgetExhausted({ runId: "run-1", turns: 149, maxTurns: 150 })).toThrow(
      "Invalid local turn budget evidence",
    );
    expect(() => authenticateProxyTurnBudgetExhausted({ runId: "run-1", turns: NaN, maxTurns: 150 })).toThrow(
      "Invalid local turn budget evidence",
    );
  });
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
