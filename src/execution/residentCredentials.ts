/** The per-exec credential-refresh decision of the resident Worker
 *  (deploy/cloudflare-resident/worker.ts `execThreadImpl`), kept pure and
 *  dependency-free so it is unit-testable from src/ and imported across
 *  packages by the Worker (like residentDetach/shellQuote) — the tested code
 *  IS the shipped code.
 *
 *  Background (KTD12): attach writes a 1-hour GitHub App installation token
 *  into `<worktree>/.git/github-credentials` and points git's `store` helper
 *  at it. Nothing used to refresh it during a run, so a push more than ~60
 *  minutes after attach got 401 — and git's `store` helper ERASES a rejected
 *  credential from its file, leaving the agent staring at an empty file. The
 *  Worker now asks this function before every writable `/exec` and re-mints
 *  (cached per slug) + rewrites the file when it says so. */

/** Re-mint this long after the file was written: comfortably before the
 *  60-minute token expiry, and past `mintRepoScopedToken`'s own cache window
 *  (it re-mints within 5 minutes of expiry), so a refreshed file always
 *  carries a token with real life left in it. */
export const CREDENTIAL_REFRESH_AFTER_MS = 45 * 60_000;

export type CredentialRefreshReason =
  /** Written longer than `CREDENTIAL_REFRESH_AFTER_MS` ago, or the write time is unknown. */
  | "stale"
  /** The file exists with zero bytes — git's `store` helper erased a rejected token. */
  | "empty"
  /** No file at all (never written on this tree, or removed). */
  | "missing";

export function shouldRefreshThreadCredentials(input: {
  /** When the binding's credential file was last written; null when the
   *  binding predates the field (treated as stale — the safe assumption). */
  writtenAtMs: number | null;
  nowMs: number;
  /** Size of `<worktree>/.git/github-credentials`; null when the file is absent. */
  fileBytes: number | null;
  /** Read-only bindings (item 50) never carry credentials — never refresh. */
  readonly: boolean;
}): { refresh: boolean; reason: CredentialRefreshReason | null } {
  const { writtenAtMs, nowMs, fileBytes, readonly } = input;
  if (readonly) return { refresh: false, reason: null };
  if (fileBytes === null) return { refresh: true, reason: "missing" };
  if (fileBytes === 0) return { refresh: true, reason: "empty" };
  if (writtenAtMs === null || nowMs - writtenAtMs > CREDENTIAL_REFRESH_AFTER_MS) return { refresh: true, reason: "stale" };
  return { refresh: false, reason: null };
}
