import { redactAndCap } from "./redact.js";

export interface StateWriteException {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  remote?: boolean;
  retryable?: boolean;
  overloaded?: boolean;
  cause?: StateWriteException;
}

/** Operator diagnosis. None of these facts acknowledge a state mutation. */
export type StateWriteFailure =
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

function exceptionCode(value: unknown): string | undefined {
  const code = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) && redactAndCap(code, 64) === code
    ? code
    : undefined;
}

export function exceptionOf(value: unknown, depth = 0): StateWriteException | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) => !["name", "message", "stack", "code", "remote", "retryable", "overloaded", "cause"].includes(key),
    )
  )
    return;
  if (typeof v.name !== "string" || v.name.length > 80 || typeof v.message !== "string" || v.message.length > 513)
    return;
  if (v.stack !== undefined && (typeof v.stack !== "string" || v.stack.length > 1025)) return;
  if (v.code !== undefined && (typeof v.code !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(v.code))) return;
  for (const flag of ["remote", "retryable", "overloaded"])
    if (v[flag] !== undefined && typeof v[flag] !== "boolean") return;
  const cause = v.cause === undefined ? undefined : exceptionOf(v.cause, depth + 1);
  if (v.cause !== undefined && !cause) return;
  const { code, ...details } = v;
  const safeCode = exceptionCode(code);
  return Object.freeze({
    ...details,
    ...(safeCode ? { code: safeCode } : {}),
    name: redactAndCap(v.name, 79),
    message: redactAndCap(v.message, 512),
    ...(typeof v.stack === "string" ? { stack: redactAndCap(v.stack, 1024) } : {}),
    ...(cause ? { cause } : {}),
  }) as unknown as StateWriteException;
}

export function captureException(error: unknown, depth = 0): StateWriteException {
  const e = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const code = exceptionCode(e?.code);
  return {
    name: redactAndCap(typeof e?.name === "string" ? e.name : "ThrownValue", 79),
    message: redactAndCap(typeof e?.message === "string" ? e.message : String(error), 512),
    ...(typeof e?.stack === "string" ? { stack: redactAndCap(e.stack, 1024) } : {}),
    ...(code ? { code } : {}),
    ...Object.fromEntries(
      ["remote", "retryable", "overloaded"].filter((key) => typeof e?.[key] === "boolean").map((key) => [key, e![key]]),
    ),
    ...(e?.cause !== undefined && depth < 2 ? { cause: captureException(e.cause, depth + 1) } : {}),
  };
}

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
