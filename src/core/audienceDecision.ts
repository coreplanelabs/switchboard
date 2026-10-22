import { githubAccessDiagnosticOf, type GithubAccessDiagnostic } from "./references/githubAccessDiagnostic.js";
import type { SpanAttrs } from "./trace/attrs.js";

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
/** Closed condition names survive terminal cleanup without copying source bytes. */
export const CONTEXT_REFUSAL_CHECKS = [
  "context_invalid",
  "context_unknown",
  "context_changed",
  "context_validation_exception",
  "source_input_access_unproved",
  "worker_audience_unproved",
  "execution_consumer_missing",
  "execution_owner_missing",
  "execution_generation_mismatch",
  "execution_agent_mismatch",
  "execution_requester_mismatch",
  "execution_channel_mismatch",
  "execution_thread_mismatch",
  "execution_authentication_mismatch",
  "execution_relay_mismatch",
  "execution_admission_mismatch",
  "execution_session_missing",
  "execution_session_incomplete",
  "execution_receipt_owner_mismatch",
  "execution_receipt_admission_mismatch",
  "execution_receipt_missing",
  "execution_call_result_unproved",
  "execution_github_access_unproved",
  "execution_owner_changed",
  "unit_status_unproved",
  "memory_scope_denied",
  "github_repository_unproved",
  "origin_record_missing",
  "origin_access_denied",
  "origin_identity_mismatch",
  "origin_checkpoint_missing",
  "origin_checkpoint_binding_mismatch",
  "origin_checkpoint_invalid",
  "origin_worker_binding_mismatch",
  "origin_worker_owner_mismatch",
  "origin_worker_audience_unproved",
  "origin_destination_unproved",
  "origin_visibility_unavailable",
  "origin_requester_mismatch",
  "mcp_record_unproved",
  "mcp_agent_missing",
  "mcp_state_unproved",
  "mcp_audience_unproved",
] as const;
export type ContextRefusalCheck = (typeof CONTEXT_REFUSAL_CHECKS)[number];
export type AudienceCheck =
  | { ok: true }
  | { ok: false; code: AudienceRefusalCode; check?: ContextRefusalCheck; githubAccess?: GithubAccessDiagnostic };
export type AudienceStage = "prompt" | "followup" | "recovery" | "answer-event" | "reply";
export interface AudienceRefusalReceipt {
  version: 1;
  causeAt: AudienceStage;
  withheldAt?: "prompt" | "answer-event" | "reply";
  code: AudienceRefusalCode;
  check?: ContextRefusalCheck;
  githubAccess?: GithubAccessDiagnostic;
}
export interface AudienceTrace {
  refusal?: AudienceRefusalReceipt;
}

/** Copy only a closed, exact shape across storage and diagnostic boundaries. */
export function audienceRefusalOf(value: unknown): AudienceRefusalReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const githubAccess = githubAccessDiagnosticOf(v.githubAccess);
  if (
    Object.keys(v).some(
      (key) => !["version", "causeAt", "withheldAt", "code", "check", "githubAccess"].includes(key),
    ) ||
    v.version !== 1 ||
    !["prompt", "followup", "recovery", "answer-event", "reply"].includes(v.causeAt as string) ||
    !(AUDIENCE_REFUSAL_CODES as readonly unknown[]).includes(v.code) ||
    (v.check !== undefined && !(CONTEXT_REFUSAL_CHECKS as readonly unknown[]).includes(v.check)) ||
    (v.githubAccess !== undefined && (!githubAccess || v.check !== "execution_github_access_unproved")) ||
    (v.withheldAt !== undefined && !["prompt", "answer-event", "reply"].includes(v.withheldAt as string))
  )
    return undefined;
  return {
    version: 1,
    causeAt: v.causeAt as AudienceStage,
    code: v.code as AudienceRefusalCode,
    ...(v.check !== undefined ? { check: v.check as ContextRefusalCheck } : {}),
    ...(githubAccess ? { githubAccess } : {}),
    ...(v.withheldAt !== undefined ? { withheldAt: v.withheldAt as AudienceRefusalReceipt["withheldAt"] } : {}),
  };
}

/** Keep the first cause; a later successful check cannot restore discarded text. */
export function noteAudienceRefusal(
  trace: AudienceTrace,
  code: AudienceRefusalCode,
  causeAt: AudienceStage,
  withheldAt?: AudienceRefusalReceipt["withheldAt"],
  check?: ContextRefusalCheck,
  githubAccess?: GithubAccessDiagnostic,
): AudienceRefusalReceipt {
  const diagnostic = check === "execution_github_access_unproved" ? githubAccessDiagnosticOf(githubAccess) : undefined;
  trace.refusal ??= {
    version: 1,
    causeAt,
    code,
    ...(check !== undefined ? { check } : {}),
    ...(diagnostic ? { githubAccess: diagnostic } : {}),
  };
  if (withheldAt !== undefined && trace.refusal.withheldAt === undefined)
    trace.refusal = { ...trace.refusal, withheldAt };
  return trace.refusal;
}

/** Trace and terminal receipts project the same closed facts. */
export function audienceCheckAttrs(check: AudienceCheck): SpanAttrs {
  const diagnostic =
    !check.ok && check.check === "execution_github_access_unproved"
      ? githubAccessDiagnosticOf(check.githubAccess)
      : undefined;
  return {
    outcome: check.ok ? "allowed" : (check.check ?? check.code),
    ...(diagnostic
      ? {
          githubStage: diagnostic.stage,
          githubReason: diagnostic.reason,
          githubTool: diagnostic.tool,
          githubOperation: diagnostic.operation,
          sourceCallHash: diagnostic.sourceCallHash,
          ...(diagnostic.httpStatus !== undefined ? { httpStatus: diagnostic.httpStatus } : {}),
          ...(diagnostic.requestId ? { githubRequestId: diagnostic.requestId } : {}),
          ...(diagnostic.route ? { route: diagnostic.route } : {}),
          ...(diagnostic.rateLimitRemaining !== undefined
            ? { githubRateLimitRemaining: diagnostic.rateLimitRemaining }
            : {}),
          ...(diagnostic.rateLimitResetEpochSeconds !== undefined
            ? { githubRateLimitResetEpochSeconds: diagnostic.rateLimitResetEpochSeconds }
            : {}),
          ...(diagnostic.rateLimitResource ? { githubRateLimitResource: diagnostic.rateLimitResource } : {}),
          ...(diagnostic.retryAfterSeconds !== undefined
            ? { githubRetryAfterSeconds: diagnostic.retryAfterSeconds }
            : {}),
          ...(diagnostic.responseReason ? { githubResponseReason: diagnostic.responseReason } : {}),
          ...(diagnostic.responseMessage ? { githubResponseMessage: diagnostic.responseMessage } : {}),
        }
      : {}),
  };
}

/** Copy is a projection of the typed decision, never its authority. */
export function audienceRefusalText(code: AudienceRefusalCode): string {
  switch (code) {
    case "recovered-provenance-unproved":
      return "This run restarted, so I can't safely reuse its private source details. A new message with the source in your direct Slack chat with Switchboard, outside this thread, starts a fresh check.";
    case "slack-source-unverified":
    case "source-check-timeout":
      return "I couldn't verify the Slack source, so I did not use its earlier details. A Switchboard operator can check source access.";
    case "direct-address-unproved":
    case "direct-address-mismatch":
    case "direct-audience-denied":
    case "direct-audience-unavailable":
    case "followup-indirect":
    case "followup-requester-mismatch":
    case "followup-address-unproved":
    case "followup-address-mismatch":
    case "followup-unverified":
      return "I couldn't verify who can read this private conversation, so I withheld the answer. A Switchboard operator can check conversation access.";
    case "mcp-audience-unproved":
      return "This private source can be used only in a direct Slack message between you and Switchboard. I did not share its details here.";
    case "mcp-check-unavailable":
    case "github-check-unavailable":
    case "plane-check-unavailable":
    case "thread-work-check-unavailable":
      return "I couldn't verify this source's sharing permissions, so I withheld its details. A Switchboard operator can check source access.";
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
      return "I couldn't verify that the earlier source details are still safe to share here, so I withheld them. A Switchboard operator can check the source and conversation access.";
  }
}
