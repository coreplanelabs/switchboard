import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_EXPIRY_MARGIN_MS,
  CREDENTIAL_REFRESH_AFTER_MS,
  shouldRefreshThreadCredentials,
} from "./residentCredentials.js";
import { BASH_TIMEOUT_MAX_MS } from "./bashTimeout.js";

const now = 1_700_000_000_000;
// A binding written with a token that still has ~55 minutes of life: the
// default "healthy" case for the expiry-driven path.
const fresh = {
  writtenAtMs: now - 60_000,
  tokenExpiresAtMs: now + 55 * 60_000,
  nowMs: now,
  fileBytes: 60,
  readonly: false,
};

describe("shouldRefreshThreadCredentials (the per-attach token must outlive a long run)", () => {
  it("the expiry margin covers the longest single exec (BASH_TIMEOUT_MAX_MS + slack)", () => {
    expect(CREDENTIAL_EXPIRY_MARGIN_MS).toBeGreaterThanOrEqual(BASH_TIMEOUT_MAX_MS);
    expect(CREDENTIAL_EXPIRY_MARGIN_MS).toBeLessThan(60 * 60_000);
    expect(CREDENTIAL_REFRESH_AFTER_MS).toBe(45 * 60_000);
    expect(CREDENTIAL_REFRESH_AFTER_MS).toBeLessThan(60 * 60_000);
  });

  it("a fresh, non-empty file with a long-lived token needs nothing", () => {
    expect(shouldRefreshThreadCredentials(fresh)).toEqual({ refresh: false, reason: null });
  });

  it("missing file (never written, or erased) → missing, whatever the token's expiry", () => {
    expect(shouldRefreshThreadCredentials({ ...fresh, fileBytes: null })).toEqual({ refresh: true, reason: "missing" });
  });

  it("empty file — git's store helper erased the rejected credential → empty, before the expiry check", () => {
    expect(shouldRefreshThreadCredentials({ ...fresh, fileBytes: 0 })).toEqual({ refresh: true, reason: "empty" });
  });

  describe("expiry-driven refresh: the token's own life, not the file's age", () => {
    it("a near-expiry token (3 min left) refreshes with reason expiring, though the file was just written", () => {
      expect(
        shouldRefreshThreadCredentials({ ...fresh, writtenAtMs: now, tokenExpiresAtMs: now + 3 * 60_000 }),
      ).toEqual({ refresh: true, reason: "expiring" });
    });

    it("a token with 50 min left does not refresh, even on an old file", () => {
      expect(
        shouldRefreshThreadCredentials({
          ...fresh,
          writtenAtMs: now - 50 * 60_000,
          tokenExpiresAtMs: now + 50 * 60_000,
        }),
      ).toEqual({ refresh: false, reason: null });
    });

    it("exactly at the margin is still fresh; one ms past it is expiring", () => {
      expect(shouldRefreshThreadCredentials({ ...fresh, tokenExpiresAtMs: now + CREDENTIAL_EXPIRY_MARGIN_MS })).toEqual(
        { refresh: false, reason: null },
      );
      expect(
        shouldRefreshThreadCredentials({ ...fresh, tokenExpiresAtMs: now + CREDENTIAL_EXPIRY_MARGIN_MS - 1 }),
      ).toEqual({ refresh: true, reason: "expiring" });
    });

    it("an already-expired token is expiring, not empty (the file still has bytes)", () => {
      expect(shouldRefreshThreadCredentials({ ...fresh, tokenExpiresAtMs: now - 60_000 })).toEqual({
        refresh: true,
        reason: "expiring",
      });
    });
  });

  describe("old bindings that predate tokenExpiresAtMs fall back to the file-age stale rule", () => {
    it("a null token expiry with a recently written file needs nothing", () => {
      expect(shouldRefreshThreadCredentials({ ...fresh, tokenExpiresAtMs: null })).toEqual({
        refresh: false,
        reason: null,
      });
    });

    it("written more than CREDENTIAL_REFRESH_AFTER_MS ago with no token expiry → stale", () => {
      expect(
        shouldRefreshThreadCredentials({
          ...fresh,
          tokenExpiresAtMs: null,
          writtenAtMs: now - CREDENTIAL_REFRESH_AFTER_MS - 1,
        }),
      ).toEqual({ refresh: true, reason: "stale" });
      expect(
        shouldRefreshThreadCredentials({
          ...fresh,
          tokenExpiresAtMs: null,
          writtenAtMs: now - CREDENTIAL_REFRESH_AFTER_MS,
        }),
      ).toEqual({ refresh: false, reason: null });
    });

    it("an unknown write time and unknown expiry is treated as stale", () => {
      expect(shouldRefreshThreadCredentials({ ...fresh, tokenExpiresAtMs: null, writtenAtMs: null })).toEqual({
        refresh: true,
        reason: "stale",
      });
    });

    it("a missing tokenExpiresAtMs field (undefined) behaves like null — file-age fallback", () => {
      const { tokenExpiresAtMs: _drop, ...noExpiry } = fresh;
      expect(shouldRefreshThreadCredentials(noExpiry)).toEqual({ refresh: false, reason: null });
      expect(
        shouldRefreshThreadCredentials({ ...noExpiry, writtenAtMs: now - CREDENTIAL_REFRESH_AFTER_MS - 1 }),
      ).toEqual({ refresh: true, reason: "stale" });
    });
  });

  it("missing beats empty beats the expiry/stale check when several apply", () => {
    expect(shouldRefreshThreadCredentials({ ...fresh, fileBytes: null, tokenExpiresAtMs: now + 3 * 60_000 })).toEqual({
      refresh: true,
      reason: "missing",
    });
    expect(shouldRefreshThreadCredentials({ ...fresh, fileBytes: 0, tokenExpiresAtMs: now + 3 * 60_000 })).toEqual({
      refresh: true,
      reason: "empty",
    });
  });

  it("read-only bindings never get credentials, whatever the file or token says (item 50)", () => {
    for (const input of [
      { ...fresh, readonly: true, fileBytes: null },
      { ...fresh, readonly: true, fileBytes: 0 },
      { ...fresh, readonly: true, tokenExpiresAtMs: now - 60_000 },
      { ...fresh, readonly: true, tokenExpiresAtMs: null, writtenAtMs: null },
    ]) {
      expect(shouldRefreshThreadCredentials(input)).toEqual({ refresh: false, reason: null });
    }
  });
});
