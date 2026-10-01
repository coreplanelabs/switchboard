/** Structural diagnostics only. These values never grant source or reply access. */
export const AUDIENCE_REFUSAL_CODES = [
  "direct-address-unproved",
  "direct-address-mismatch",
  "direct-audience-denied",
  "direct-audience-unavailable",
  "followup-indirect",
  "followup-requester-mismatch",
  "followup-address-unproved",
  "followup-address-mismatch",
  "followup-unverified",
  "recovered-provenance-unproved",
  "saved-context-unproved",
  "parent-context-unproved",
  "artifact-context-unproved",
  "history-author-unproved",
  "requester-or-channel-mismatch",
  "mcp-audience-unproved",
  "mcp-source-changed",
  "mcp-check-unavailable",
  "github-identity-unproved",
  "github-access-lost",
  "github-check-unavailable",
  "plane-identity-unproved",
  "plane-row-no-longer-visible",
  "plane-check-unavailable",
  "thread-work-snapshot-changed",
  "thread-work-check-unavailable",
  "slack-source-unverified",
  "source-check-timeout",
] as const;
export type AudienceRefusalCode = (typeof AUDIENCE_REFUSAL_CODES)[number];
export type AudienceCheck = { ok: true } | { ok: false; code: AudienceRefusalCode };
export type AudienceStage = "prompt" | "followup" | "recovery" | "answer-event" | "reply";
export interface AudienceRefusalReceipt {
  version: 1;
  causeAt: AudienceStage;
  withheldAt?: "prompt" | "answer-event" | "reply";
  code: AudienceRefusalCode;
}
export interface AudienceTrace {
  refusal?: AudienceRefusalReceipt;
}

/** Copy only a closed, exact shape across storage and diagnostic boundaries. */
export function audienceRefusalOf(value: unknown): AudienceRefusalReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((key) => !["version", "causeAt", "withheldAt", "code"].includes(key)) ||
    v.version !== 1 ||
    !["prompt", "followup", "recovery", "answer-event", "reply"].includes(v.causeAt as string) ||
    !(AUDIENCE_REFUSAL_CODES as readonly unknown[]).includes(v.code) ||
    (v.withheldAt !== undefined && !["prompt", "answer-event", "reply"].includes(v.withheldAt as string))
  )
    return undefined;
  return {
    version: 1,
    causeAt: v.causeAt as AudienceStage,
    code: v.code as AudienceRefusalCode,
    ...(v.withheldAt !== undefined ? { withheldAt: v.withheldAt as AudienceRefusalReceipt["withheldAt"] } : {}),
  };
}

/** Keep the first cause; a later successful check cannot restore discarded text. */
export function noteAudienceRefusal(
  trace: AudienceTrace,
  code: AudienceRefusalCode,
  causeAt: AudienceStage,
  withheldAt?: AudienceRefusalReceipt["withheldAt"],
): AudienceRefusalReceipt {
  trace.refusal ??= { version: 1, causeAt, code };
  if (withheldAt !== undefined && trace.refusal.withheldAt === undefined)
    trace.refusal = { ...trace.refusal, withheldAt };
  return trace.refusal;
}

/** Copy is a projection of the typed decision, never its authority. */
export function audienceRefusalText(code: AudienceRefusalCode): string {
  switch (code) {
    case "recovered-provenance-unproved":
      return "This run restarted, so please ask again in a private DM.";
    case "slack-source-unverified":
    case "source-check-timeout":
      return "I need to check the Slack source again before using earlier details. Please start a new DM message with the source.";
    case "direct-address-unproved":
    case "direct-address-mismatch":
    case "direct-audience-denied":
    case "direct-audience-unavailable":
    case "followup-indirect":
    case "followup-requester-mismatch":
    case "followup-address-unproved":
    case "followup-address-mismatch":
    case "followup-unverified":
      return "I can no longer verify this private conversation, so I can't share that answer here.";
    case "mcp-audience-unproved":
      return "I can read this private source only in your one-person Slack DM. Please ask me there.";
    case "mcp-check-unavailable":
    case "github-check-unavailable":
    case "plane-check-unavailable":
    case "thread-work-check-unavailable":
      return "I can't verify this source's sharing permissions right now. Please ask me to check it again.";
    case "saved-context-unproved":
    case "parent-context-unproved":
    case "artifact-context-unproved":
    case "history-author-unproved":
    case "requester-or-channel-mismatch":
    case "mcp-source-changed":
    case "github-identity-unproved":
    case "github-access-lost":
    case "plane-identity-unproved":
    case "plane-row-no-longer-visible":
    case "thread-work-snapshot-changed":
      return "I can't safely use earlier source data in this conversation. Please ask me to check the source again.";
  }
}
