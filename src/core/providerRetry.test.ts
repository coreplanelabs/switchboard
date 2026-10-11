// Feature: docs/reference/specs/model-proxy.md item 12a — bounded recovery.
import { describe, expect, it } from "vitest";
import { ProviderFailure } from "./provider.js";
import { providerRetryDelay } from "./providerRetry.js";

describe("provider retry policy", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const rate = (header: string) =>
    new ProviderFailure("rate-limited", { diagnostic: { headers: { "retry-after": header } } });
  it("honors seconds and HTTP-date advice without multiplying retries", () => {
    expect(providerRetryDelay(rate("30"), 0, now, () => 0)).toBe(30000);
    expect(providerRetryDelay(rate("Thu, 01 Jan 2026 00:00:30 GMT"), 1, now, () => 0)).toBe(30000);
    expect(providerRetryDelay(rate("30"), 2, now, () => 0)).toBeUndefined();
  });
  it("uses bounded jitter for temporary errors and rejects advice beyond the wait budget", () => {
    expect(providerRetryDelay(new ProviderFailure("transient"), 0, now, () => 0.5)).toBe(5500);
    expect(providerRetryDelay(new ProviderFailure("transient"), 1, now, () => 0.5)).toBe(16500);
    expect(providerRetryDelay(rate("120"), 0, now, () => 0)).toBeUndefined();
  });
  it("rejects external-action errors and falls back safely for invalid or past advice", () => {
    for (const cause of [
      "credit-or-quota-exhausted",
      "key-absent",
      "key-invalid",
      "model-unknown",
      "request-rejected",
      "permanent",
    ] as const)
      expect(providerRetryDelay(new ProviderFailure(cause), 0, now, () => 0)).toBeUndefined();
    expect(providerRetryDelay(rate("bad"), 0, now, () => 0)).toBe(5000);
    expect(providerRetryDelay(rate("Wed, 31 Dec 2025 23:59:59 GMT"), 0, now, () => 0)).toBe(5000);
  });
});
