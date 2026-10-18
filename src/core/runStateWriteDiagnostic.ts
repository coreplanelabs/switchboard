import {
  captureException,
  exceptionOf,
  type ExceptionDiagnostic as StateWriteException,
} from "./exceptionDiagnostic.js";

export { captureException, exceptionOf } from "./exceptionDiagnostic.js";
export type { ExceptionDiagnostic as StateWriteException } from "./exceptionDiagnostic.js";

const appendRejectionReasons = ["append_events_not_array", "append_seq_invalid", "append_event_too_large"] as const;
export type AppendRejectionReason = (typeof appendRejectionReasons)[number];

/** Operator diagnosis. None of these facts acknowledge a state mutation. */
export type StateWriteFailure =
  | { stage: "request"; errorKind: "rejection"; reason: AppendRejectionReason }
  | {
      stage: "promotion-preflight" | "state-read" | "state-rpc" | "request";
      errorKind: "syntax" | "type" | "error" | "non-error";
      exception?: StateWriteException;
      attempts?: number;
    }
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

/** HTTP headers are ASCII even when an exception contains Unicode. */
export function stateWriteDiagnosticHeader(diagnostic: StateWriteDiagnostic): string {
  const encode = (value: StateWriteDiagnostic) =>
    JSON.stringify(value).replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const encoded = encode(diagnostic);
  if (encoded.length <= 16384 || !("exception" in diagnostic.failure) || !diagnostic.failure.exception) return encoded;
  // Operator logs retain the stacks; the bounded ASCII header still carries
  // every exception's message, code and flags when Unicode expands its bytes.
  const withoutStacks = ({ stack: _stack, cause, ...rest }: StateWriteException): StateWriteException => ({
    ...rest,
    ...(cause ? { cause: withoutStacks(cause) } : {}),
  });
  return encode({
    ...diagnostic,
    failure: { ...diagnostic.failure, exception: withoutStacks(diagnostic.failure.exception) },
  });
}

export function stateWriteFailureOf(value: unknown): StateWriteFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    v.stage === "request" &&
    v.errorKind === "rejection" &&
    Object.keys(v).length === 3 &&
    typeof v.reason === "string" &&
    appendRejectionReasons.includes(v.reason as AppendRejectionReason)
  )
    return { stage: "request", errorKind: "rejection", reason: v.reason as AppendRejectionReason };
  if (
    typeof v.stage === "string" &&
    ["promotion-preflight", "state-read", "state-rpc", "request"].includes(v.stage) &&
    Object.keys(v).every((key) => ["stage", "errorKind", "exception", "attempts"].includes(key)) &&
    typeof v.errorKind === "string" &&
    ["syntax", "type", "error", "non-error"].includes(v.errorKind)
  ) {
    const exception = v.exception === undefined ? undefined : exceptionOf(v.exception);
    if (v.exception !== undefined && !exception) return;
    if (
      v.attempts !== undefined &&
      (!Number.isInteger(v.attempts) || (v.attempts as number) < 1 || (v.attempts as number) > 3)
    )
      return;
    return {
      stage: v.stage as Extract<StateWriteFailure, { errorKind: string }>["stage"],
      errorKind: v.errorKind as "syntax" | "type" | "error" | "non-error",
      ...(exception ? { exception } : {}),
      ...(v.attempts !== undefined ? { attempts: v.attempts as number } : {}),
    };
  }
  if (
    v.stage === "acknowledgment" &&
    Object.keys(v).length === 2 &&
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
  if (!header || header.length > 16384) return;
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

export function stateWriteException(
  stage: "promotion-preflight" | "state-read" | "state-rpc" | "request",
  error: unknown,
  attempts?: number,
): StateWriteFailure {
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
    exception: captureException(error),
    ...(attempts !== undefined ? { attempts } : {}),
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
