import { EXEC_INFRA_REASONS, type ExecInfraReason } from "./execResult.js";

/** Closed facts about one failed remote request. No command, path, body or error text. */
export interface ExecFailureDiagnostic {
  version: 1;
  backend: "resident" | "sandbox";
  route: string;
  phase: "send" | "body" | "answer";
  requestId: string;
  reason: ExecInfraReason;
  httpStatus?: number;
  answerStatus?: number;
  transient?: boolean;
  cause?: "request" | "policy" | "system";
  origin?: "resident";
  commandOutcome?: "unknown";
}

const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ROUTE = /^\/[a-z][a-z-]{0,39}$/;
const STATUS = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599;

export function execFailureDiagnosticFrom(value: unknown): ExecFailureDiagnostic | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
    const fields = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(fields);
    const allowed = [
      "version",
      "backend",
      "route",
      "phase",
      "requestId",
      "reason",
      "httpStatus",
      "answerStatus",
      "transient",
      "cause",
      "origin",
      "commandOutcome",
    ];
    if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) return;
    if (keys.some((key) => !("value" in fields[key as string]!))) return;
    const row = Object.fromEntries(keys.map((key) => [key, fields[key as string]!.value]));
    if (
      row.version !== 1 ||
      !["resident", "sandbox"].includes(row.backend) ||
      typeof row.route !== "string" ||
      !ROUTE.test(row.route) ||
      !["send", "body", "answer"].includes(row.phase) ||
      typeof row.requestId !== "string" ||
      !REQUEST_ID.test(row.requestId) ||
      !EXEC_INFRA_REASONS.includes(row.reason) ||
      (row.httpStatus !== undefined && !STATUS(row.httpStatus)) ||
      (row.answerStatus !== undefined && !STATUS(row.answerStatus)) ||
      (row.transient !== undefined && typeof row.transient !== "boolean") ||
      (row.cause !== undefined && !["request", "policy", "system"].includes(row.cause)) ||
      (row.origin !== undefined && row.origin !== "resident") ||
      (row.commandOutcome !== undefined && row.commandOutcome !== "unknown")
    )
      return;
    return row as unknown as ExecFailureDiagnostic;
  } catch {
    return;
  }
}

/** Keep diagnostics inert when an error or a wrapper has an accessor or extra data. */
export function execFailureDiagnosticOf(error: unknown): ExecFailureDiagnostic | undefined {
  const seen = new Set<unknown>();
  try {
    for (let depth = 0; depth < 4 && error instanceof Error && !seen.has(error); depth++) {
      seen.add(error);
      const diagnostic = execFailureDiagnosticFrom(
        Object.getOwnPropertyDescriptor(error, "execFailureDiagnostic")?.value,
      );
      if (diagnostic) return diagnostic;
      error = Object.getOwnPropertyDescriptor(error, "cause")?.value;
    }
  } catch {
    return;
  }
}

export function attachExecFailureDiagnostic(error: Error, value: ExecFailureDiagnostic): void {
  const diagnostic = execFailureDiagnosticFrom(value);
  if (!diagnostic) return;
  try {
    Object.defineProperty(error, "execFailureDiagnostic", { value: diagnostic, enumerable: true });
  } catch {
    // Observation failure must not replace the execution failure.
  }
}
