import { redactAndCap } from "./redact.js";
import { unwrapUntrusted, wrapUntrusted } from "./untrusted.js";
import { cloudflareErrorMessage } from "./cloudflareErrors.js";

export interface ExceptionDiagnostic {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  remote?: boolean;
  retryable?: boolean;
  overloaded?: boolean;
  cause?: ExceptionDiagnostic;
}

function exceptionCode(value: unknown): string | undefined {
  const code = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) && redactAndCap(code, 64) === code
    ? code
    : undefined;
}

function withoutDecoderProse(exception: ExceptionDiagnostic): ExceptionDiagnostic {
  if (exception.name !== "SyntaxError" && !decoderCause(exception.cause)) return exception;
  const { stack: _stack, ...facts } = exception;
  return { ...facts, message: "Stored JSON is unreadable" };
}

function decoderCause(exception: ExceptionDiagnostic | undefined): boolean {
  return exception !== undefined && (exception.name === "SyntaxError" || decoderCause(exception.cause));
}

function exceptionText(value: unknown, cap: number): string | undefined {
  if (typeof value !== "string") return;
  const body = unwrapUntrusted(value, { restoreMarkers: true });
  if (body.length > cap + 1) return;
  const safe = redactAndCap(body, cap);
  return body === value ? safe : wrapUntrusted(safe);
}

export function exceptionOf(value: unknown, depth = 0): ExceptionDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) => !["name", "message", "stack", "code", "remote", "retryable", "overloaded", "cause"].includes(key),
    )
  )
    return;
  const message = exceptionText(v.message, 512),
    stack = v.stack === undefined ? undefined : exceptionText(v.stack, 1024);
  if (typeof v.name !== "string" || v.name.length > 80 || message === undefined) return;
  if (v.stack !== undefined && stack === undefined) return;
  if (v.code !== undefined && (typeof v.code !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(v.code))) return;
  for (const flag of ["remote", "retryable", "overloaded"])
    if (v[flag] !== undefined && typeof v[flag] !== "boolean") return;
  const cause = v.cause === undefined ? undefined : exceptionOf(v.cause, depth + 1);
  if (v.cause !== undefined && !cause) return;
  const { code, ...details } = v;
  const safeCode = exceptionCode(code);
  return Object.freeze(
    withoutDecoderProse({
      ...details,
      ...(safeCode ? { code: safeCode } : {}),
      name: redactAndCap(v.name, 79),
      message,
      ...(stack === undefined ? {} : { stack }),
      ...(cause ? { cause } : {}),
    } as unknown as ExceptionDiagnostic),
  );
}

export function captureException(error: unknown, depth = 0): ExceptionDiagnostic {
  const e = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const code = exceptionCode(e?.code);
  return withoutDecoderProse({
    name: redactAndCap(typeof e?.name === "string" ? e.name : "ThrownValue", 79),
    message: redactAndCap(cloudflareErrorMessage(typeof e?.message === "string" ? e.message : String(error)), 512),
    ...(typeof e?.stack === "string" ? { stack: redactAndCap(e.stack, 1024) } : {}),
    ...(code ? { code } : {}),
    ...Object.fromEntries(
      ["remote", "retryable", "overloaded"].filter((key) => typeof e?.[key] === "boolean").map((key) => [key, e![key]]),
    ),
    ...(e?.cause !== undefined && depth < 2 ? { cause: captureException(e.cause, depth + 1) } : {}),
  });
}
