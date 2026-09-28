/** The pure expiry decision retained for the optional legacy sandbox
 *  credential refresher. The production executor factory does not supply
 *  that credential source: model workspaces use a revocable Git-door run
 *  bearer, and the resident never refreshes a model-visible App token.
 *  The resident imports only the expiry margin for its root-owned mirror
 *  credential cache. */

import { BASH_TIMEOUT_MAX_MS } from "./bashTimeout.js";

/** Legacy refresher backstop when the stored token's expiry is unknown. */
export const CREDENTIAL_REFRESH_AFTER_MS = 45 * 60_000;

/** Legacy refresh and root-mirror cache margin: the longest exec is
 *  `BASH_TIMEOUT_MAX_MS` (20 min), plus five minutes for mint and clock skew. */
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
