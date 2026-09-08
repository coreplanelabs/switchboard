/** The per-exec credential-refresh decision of the resident Worker
 *  (deploy/cloudflare-resident/worker.ts `execThreadImpl`), kept pure and
 *  dependency-free so it is unit-testable from src/ and imported across
 *  packages by the Worker (like residentDetach/shellQuote) — the tested code
 *  IS the shipped code.
 *
 *  Background: attach writes a 1-hour GitHub App installation token
 *  into `<worktree>/.git/github-credentials` and points git's `store` helper
 *  at it. Nothing used to refresh it during a run, so a push more than ~60
 *  minutes after attach got 401 — and git's `store` helper ERASES a rejected
 *  credential from its file, leaving the agent staring at an empty file. The
 *  Worker now asks this function before every writable `/exec` and re-mints
 *  (cached per slug) + rewrites the file when it says so.
 *
 *  The refresh is driven by the TOKEN'S OWN EXPIRY, not the file's age.
 *  `mintRepoScopedToken` caches per repository slug, so a token minted for an
 *  earlier thread — with only a few minutes of life left — could be written
 *  for a brand-new attach and, keyed on file age alone, read "fresh" for ~45
 *  minutes while every writable exec in between ran on a dead token (the first
 *  git write 401s, `store` blanks the file, and only the NEXT exec refreshed).
 *  Now the binding records the token's `expiresAtMs`, and this predicate
 *  refreshes once the token is within `CREDENTIAL_EXPIRY_MARGIN_MS` of expiry
 *  — so a writable exec never starts on a token that cannot outlive it. */

import { BASH_TIMEOUT_MAX_MS } from "./bashTimeout.js";

/** Backstop for bindings that predate `tokenExpiresAtMs`: re-mint
 *  this long after the file was written when the token's real expiry is
 *  unknown — comfortably before the 60-minute token expiry. New bindings carry
 *  the expiry and take the margin path below instead. */
export const CREDENTIAL_REFRESH_AFTER_MS = 45 * 60_000;

/** Refresh once the token is within this much of expiry, so a writable exec
 *  never starts on a token that cannot outlive the command it is about to run.
 *  Sized like the sandbox's per-command credential margin: the longest
 *  single exec is `BASH_TIMEOUT_MAX_MS` (20 min), plus slack for the mint +
 *  file write and clock skew ⇒ 25 min. This is also `mintRepoScopedToken`'s
 *  cache serve threshold, so the cache and this predicate agree: a token the
 *  cache would still hand out is a token this predicate would not refresh. */
export const CREDENTIAL_EXPIRY_MARGIN_MS = BASH_TIMEOUT_MAX_MS + 5 * 60_000;

export type CredentialRefreshReason =
  /** The token is within `CREDENTIAL_EXPIRY_MARGIN_MS` of its expiry (or past it). */
  | "expiring"
  /** No token expiry recorded (binding predates the field) and the file is
   *  older than `CREDENTIAL_REFRESH_AFTER_MS`, or its write time is unknown. */
  | "stale"
  /** The file exists with zero bytes — git's `store` helper erased a rejected token. */
  | "empty"
  /** No file at all (never written on this tree, or removed). */
  | "missing";

export function shouldRefreshThreadCredentials(input: {
  /** When the binding's credential file was last written; null when the
   *  binding predates the field. Only consulted on the file-age backstop. */
  writtenAtMs: number | null;
  /** When the written token expires (epoch ms); null/undefined when the
   *  binding predates the field — then the file-age backstop applies. */
  tokenExpiresAtMs?: number | null;
  nowMs: number;
  /** Size of `<worktree>/.git/github-credentials`; null when the file is absent. */
  fileBytes: number | null;
  /** Read-only bindings (item 50) never carry credentials — never refresh. */
  readonly: boolean;
}): { refresh: boolean; reason: CredentialRefreshReason | null } {
  const { writtenAtMs, tokenExpiresAtMs, nowMs, fileBytes, readonly } = input;
  if (readonly) return { refresh: false, reason: null };
  if (fileBytes === null) return { refresh: true, reason: "missing" };
  if (fileBytes === 0) return { refresh: true, reason: "empty" };
  // Known expiry: drive the refresh off the token's own life, not the
  // file's age. Replaces the file-age heuristic for any binding that records it.
  if (tokenExpiresAtMs != null) {
    if (nowMs > tokenExpiresAtMs - CREDENTIAL_EXPIRY_MARGIN_MS) return { refresh: true, reason: "expiring" };
    return { refresh: false, reason: null };
  }
  // Backstop for a binding written before the expiry was recorded: fall back to
  // file age so an old binding still refreshes.
  if (writtenAtMs === null || nowMs - writtenAtMs > CREDENTIAL_REFRESH_AFTER_MS)
    return { refresh: true, reason: "stale" };
  return { refresh: false, reason: null };
}
