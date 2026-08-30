import { describe, expect, it } from "vitest";
import { CREDENTIAL_REFRESH_AFTER_MS, shouldRefreshThreadCredentials } from "./residentCredentials.js";

const now = 1_700_000_000_000;
const fresh = { writtenAtMs: now - 60_000, nowMs: now, fileBytes: 60, readonly: false };

describe("shouldRefreshThreadCredentials (KTD12: the per-attach token must outlive a long run)", () => {
  it("re-mints before the 1-hour installation token expires", () => {
    expect(CREDENTIAL_REFRESH_AFTER_MS).toBe(45 * 60_000);
    expect(CREDENTIAL_REFRESH_AFTER_MS).toBeLessThan(60 * 60_000);
  });

  it("a fresh, non-empty file needs nothing", () => {
    expect(shouldRefreshThreadCredentials(fresh)).toEqual({ refresh: false, reason: null });
  });

  it("missing file (never written, or erased) → missing", () => {
    expect(shouldRefreshThreadCredentials({ ...fresh, fileBytes: null })).toEqual({ refresh: true, reason: "missing" });
  });

  it("empty file — git's store helper erased the rejected credential → empty", () => {
    expect(shouldRefreshThreadCredentials({ ...fresh, fileBytes: 0 })).toEqual({ refresh: true, reason: "empty" });
  });

  it("written more than CREDENTIAL_REFRESH_AFTER_MS ago → stale; exactly at the boundary is still fresh", () => {
    expect(shouldRefreshThreadCredentials({ ...fresh, writtenAtMs: now - CREDENTIAL_REFRESH_AFTER_MS - 1 })).toEqual({
      refresh: true,
      reason: "stale",
    });
    expect(shouldRefreshThreadCredentials({ ...fresh, writtenAtMs: now - CREDENTIAL_REFRESH_AFTER_MS })).toEqual({
      refresh: false,
      reason: null,
    });
  });

  it("an unknown write time (binding predates the field) is treated as stale", () => {
    expect(shouldRefreshThreadCredentials({ ...fresh, writtenAtMs: null })).toEqual({ refresh: true, reason: "stale" });
  });

  it("missing beats empty beats stale when several apply", () => {
    expect(shouldRefreshThreadCredentials({ ...fresh, fileBytes: null, writtenAtMs: null })).toEqual({
      refresh: true,
      reason: "missing",
    });
    expect(shouldRefreshThreadCredentials({ ...fresh, fileBytes: 0, writtenAtMs: null })).toEqual({
      refresh: true,
      reason: "empty",
    });
  });

  it("read-only bindings never get credentials, whatever the file says (item 50)", () => {
    for (const input of [
      { ...fresh, readonly: true, fileBytes: null },
      { ...fresh, readonly: true, fileBytes: 0 },
      { ...fresh, readonly: true, writtenAtMs: null },
    ]) {
      expect(shouldRefreshThreadCredentials(input)).toEqual({ refresh: false, reason: null });
    }
  });
});
