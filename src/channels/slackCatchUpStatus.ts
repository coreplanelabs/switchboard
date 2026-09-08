// Catch-up observability (features/slack-channel.md item 7). Without it the
// reconnect catch-up can be a silent no-op indefinitely: a bot token that
// lacks `channels:read`/`groups:read` gets `missing_scope` from
// `users.conversations`, the runner logs one line to container stdout — which
// is not queryable off-box — and returns. Nothing else shows it. This module
// is the ONE place the last outcome and the token's missing scopes are kept so
// `GET /healthz` (src/channels/health.ts) can report them and the deploy
// preflight can warn.
//
// In-process and live-only, on purpose: this is a diagnostic of THIS process's
// last scan, not state anything rebuilds from. A restart starts empty (the
// next `connected` fills it within seconds), so invariant 6 — no in-memory
// state a restart loses SILENTLY — holds: an empty record after a restart is
// the truth, not a loss.

/** Bot-token scopes the Slack adapter needs to work as designed. Mirrors the
 *  README's install list minus the `im:*` set (DMs are off in the recommended
 *  rollout). `channels:read`/`groups:read` are what the catch-up's channel
 *  listing needs; without them the scan cannot start. */
export const REQUIRED_BOT_SCOPES: readonly string[] = [
  "app_mentions:read",
  "chat:write",
  "channels:history",
  "groups:history",
  "files:read",
  "files:write", // long command output attached as a snippet (ChannelIO.attach); without it the adapter falls back to chunked messages
  "reactions:write",
  "channels:read",
  "groups:read",
  "users:read",
];

/** What `/healthz` shows. Every field is optional: absent until the first scan
 *  (or, for `missingScopes`, absent when nothing is missing or unknown). */
export interface CatchUpStatus {
  /** ISO instant the last scan finished. */
  lastRunAt?: string;
  /** Channels listed by the last scan. */
  channels?: number;
  /** Missed messages re-dispatched by the last scan. */
  missed?: number;
  /** Channels whose scan failed and were skipped (per-channel failures; the scan itself completed). */
  skippedChannels?: number;
  /** Why the last scan could not run at all (e.g. `missing_scope` from the channel listing). Absent after a clean scan. */
  error?: string;
  /** Required bot scopes the token does not carry, per the startup check. Absent when none. */
  missingScopes?: string[];
}

/** One scan's outcome, as the runner reports it. */
export interface CatchUpOutcome {
  /** Epoch ms the scan finished. */
  at: number;
  channels: number;
  missed: number;
  skippedChannels: number;
  error?: string;
}

let status: CatchUpStatus = {};

export function recordCatchUpOutcome(outcome: CatchUpOutcome): void {
  const { missingScopes } = status;
  status = {
    lastRunAt: new Date(outcome.at).toISOString(),
    channels: outcome.channels,
    missed: outcome.missed,
    skippedChannels: outcome.skippedChannels,
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    ...(missingScopes ? { missingScopes } : {}),
  };
}

export function recordMissingScopes(missing: readonly string[]): void {
  if (missing.length === 0) {
    delete status.missingScopes;
    return;
  }
  status = { ...status, missingScopes: [...missing] };
}

/** A copy — callers never mutate the record. */
export function getCatchUpStatus(): CatchUpStatus {
  return { ...status, ...(status.missingScopes ? { missingScopes: [...status.missingScopes] } : {}) };
}

/** Tests only. */
export function resetCatchUpStatus(): void {
  status = {};
}

/** Pure: which required scopes the token lacks, in required order. `granted`
 *  is `response_metadata.scopes` from any `@slack/web-api` result (an array),
 *  or the comma-separated `x-oauth-scopes` header form. An unknown grant
 *  (no metadata) cannot be judged and reports nothing missing — the check is
 *  advisory, and a false alarm would be worse than silence here. */
export function missingBotScopes(
  granted: readonly string[] | string | undefined,
  required: readonly string[] = REQUIRED_BOT_SCOPES,
): string[] {
  if (granted === undefined) return [];
  const have = new Set(
    (typeof granted === "string" ? granted.split(",") : granted).map((s) => s.trim()).filter(Boolean),
  );
  return required.filter((s) => !have.has(s));
}
