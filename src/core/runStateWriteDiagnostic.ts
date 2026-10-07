/** Refusal-only diagnosis. None of these facts acknowledge a state mutation. */
export type StateWriteFailure =
  | { stage: "promotion-preflight" | "state-rpc"; errorKind: "syntax" | "type" | "error" | "non-error" }
  | {
      stage: "acknowledgment";
      replyShape: "undefined" | "null" | "array" | "other" | "held" | "ok" | "refused" | "object";
    };

export interface StateWriteDiagnostic {
  version: 1;
  requestDigest: string;
  failure: StateWriteFailure;
}
export const STATE_WRITE_DIAGNOSTIC_HEADER = "x-switchboard-state-failure";

export function stateWriteFailureOf(value: unknown): StateWriteFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 2) return;
  if (
    (v.stage === "promotion-preflight" || v.stage === "state-rpc") &&
    typeof v.errorKind === "string" &&
    ["syntax", "type", "error", "non-error"].includes(v.errorKind)
  )
    return { stage: v.stage, errorKind: v.errorKind as "syntax" | "type" | "error" | "non-error" };
  if (
    v.stage === "acknowledgment" &&
    typeof v.replyShape === "string" &&
    ["undefined", "null", "array", "other", "held", "ok", "refused", "object"].includes(v.replyShape)
  )
    return {
      stage: v.stage,
      replyShape: v.replyShape as Extract<StateWriteFailure, { stage: "acknowledgment" }>["replyShape"],
    };
}

export function stateWriteDiagnosticFromHeader(
  header: string | null,
  expectedDigest: string,
): StateWriteFailure | undefined {
  if (!header || header.length > 512) return;
  try {
    const value: unknown = JSON.parse(header);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const v = value as Record<string, unknown>;
    if (
      Object.keys(v).length !== 3 ||
      v.version !== 1 ||
      typeof v.requestDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(v.requestDigest) ||
      v.requestDigest !== expectedDigest
    )
      return;
    return stateWriteFailureOf(v.failure);
  } catch {
    return;
  }
}

export function stateWriteException(stage: "promotion-preflight" | "state-rpc", error: unknown): StateWriteFailure {
  return {
    stage,
    errorKind:
      error instanceof Error
        ? error.name === "SyntaxError"
          ? "syntax"
          : error.name === "TypeError"
            ? "type"
            : "error"
        : "non-error",
  };
}

export function stateWriteReplyShape(
  value: unknown,
): Extract<StateWriteFailure, { stage: "acknowledgment" }>["replyShape"] {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value !== "object") return "other";
  const v = value as Record<string, unknown>;
  return v.kind === "held" ? "held" : v.ok === true ? "ok" : v.ok === false ? "refused" : "object";
}

export class StateWriteBoundaryError extends Error {
  constructor(
    readonly diagnostic: StateWriteDiagnostic,
    cause: unknown,
  ) {
    super("run state mutation outcome unknown", { cause });
  }
}
