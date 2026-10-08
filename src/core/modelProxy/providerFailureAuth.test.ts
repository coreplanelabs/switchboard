import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  authenticateProxyUnknownTerminal,
  proxyUnknownTerminalIsAuthenticated,
  authenticateProxyTurnBudgetExhausted,
  readProxyTurnBudgetExhausted,
  readProxyUnknownTerminal,
  proxyProviderFailureIsAuthenticated,
} from "./providerFailureAuth.js";

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomBytes: (size: number) => Buffer.alloc(size, 7),
}));

// Feature: docs/reference/specs/harness-pi.md item 6 — diagnostics are signed
// evidence, never provider causes or permission to retry a model call.
describe("unknown terminal authentication", () => {
  it("binds closed phase and kind pairs without provider or turn authority", () => {
    for (const phase of ["admission", "request_validation", "response_validation"] as const) {
      for (const kind of [
        "aborted",
        "capacity",
        "worker-error",
        "worker-exit",
        "protocol",
        "frame-bytes",
        "stream-bytes",
        "fields",
        "output-bytes",
        "graph",
        "ipc-bytes",
        "storage",
      ] as const) {
        const signed = authenticateProxyUnknownTerminal("consumer_rejected", { phase, kind });
        expect(readProxyUnknownTerminal(JSON.stringify(signed))).toEqual({
          type: "model_terminal_unknown",
          reason: "consumer_rejected",
          rejection: { phase, kind },
        });
        expect(proxyProviderFailureIsAuthenticated(signed)).toBe(false);
        expect(readProxyTurnBudgetExhausted(signed, "run-unparsed")).toBeUndefined();
      }
    }
    const signed = authenticateProxyUnknownTerminal("consumer_rejected", { phase: "sdk_consume", kind: "rejected" });
    expect(readProxyUnknownTerminal(signed)).toEqual({
      type: "model_terminal_unknown",
      reason: "consumer_rejected",
      rejection: { phase: "sdk_consume", kind: "rejected" },
    });
  });

  it("rejects tampered, malformed and foreign observations while preserving legacy markers", () => {
    const signed = authenticateProxyUnknownTerminal("consumer_rejected", { phase: "admission", kind: "aborted" });
    const legacy = authenticateProxyUnknownTerminal("consumer_rejected");
    expect(readProxyUnknownTerminal(legacy)).toEqual({ type: "model_terminal_unknown", reason: "consumer_rejected" });
    expect(readProxyUnknownTerminal(signed)).toEqual({
      type: "model_terminal_unknown",
      reason: "consumer_rejected",
      rejection: { phase: "admission", kind: "aborted" },
    });
    const accessor = Object.defineProperty({ kind: "aborted" }, "phase", {
      get: () => {
        throw new Error("private getter");
      },
    });
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error("private proxy");
        },
      },
    );
    for (const rejection of [
      undefined,
      null,
      [],
      "private diagnostic",
      { phase: "admission" },
      { phase: "private phase", kind: "aborted" },
      { phase: "admission", kind: "private cause" },
      { phase: "sdk_consume", kind: "aborted" },
      { phase: "admission", kind: "rejected" },
      { phase: "response_validation", kind: "aborted" },
      { phase: "admission", kind: "capacity" },
      { phase: "admission", kind: "aborted", body: "private response" },
      accessor,
      proxy,
    ])
      expect(readProxyUnknownTerminal({ ...signed, rejection })).toBeUndefined();
    expect(readProxyUnknownTerminal({ ...legacy, rejection: { phase: "admission", kind: "aborted" } })).toBeUndefined();
    expect(readProxyUnknownTerminal([signed, legacy])).toBeUndefined();
    expect(readProxyUnknownTerminal({ ...signed, _switchboard_proxy_auth: "v1.foreign.foreign" })).toBeUndefined();
    expect(() => authenticateProxyUnknownTerminal("malformed_json", { phase: "admission", kind: "aborted" })).toThrow(
      "Unknown terminal diagnostic rejection",
    );
    expect(() =>
      authenticateProxyUnknownTerminal("consumer_rejected", { phase: "sdk_consume", kind: "aborted" } as never),
    ).toThrow("Unknown terminal diagnostic rejection");
  });

  it("authenticates a pre-body JSON refusal as local unknown without provider or turn-debit authority", () => {
    const error = authenticateProxyUnknownTerminal("consumer_rejected");
    const body = `403 ${JSON.stringify({ error })}`;
    expect(readProxyUnknownTerminal(body)).toEqual({ type: "model_terminal_unknown", reason: "consumer_rejected" });
    expect(proxyProviderFailureIsAuthenticated(body)).toBe(false);
    expect(readProxyTurnBudgetExhausted(body, "run-unparsed")).toBeUndefined();
    expect(
      readProxyUnknownTerminal(
        JSON.stringify({
          error: { ...error, type: "turn_budget_exhausted", turns: 1, maxTurns: 1, runId: "run-unparsed" },
        }),
      ),
    ).toBeUndefined();
  });

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
