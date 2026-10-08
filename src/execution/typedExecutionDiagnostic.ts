import { isWaitReason, type WaitReason } from "./sandboxErrors.js";

export const HARNESS_EXECUTION_OPERATIONS = [
  "write",
  "start",
  "send",
  "request_observation",
  "request_control",
  "input",
  "http_observation",
  "http_control",
  "alive",
  "identity",
  "log",
  "tail",
  "kill",
  "remove",
] as const;
export type ExecutionDiagnosticContext =
  | { caller: "executor"; operation: "unclassified" }
  | { caller: "check"; operation: "metadata" | "command" }
  | { caller: "harness"; operation: (typeof HARNESS_EXECUTION_OPERATIONS)[number] };
/** An observation of one refused send, never command outcome or retry authority. */
export type TypedExecutionDiagnostic = ExecutionDiagnosticContext & {
  version: 1;
  phase: "pre_execution_busy";
  route: "exec";
  reason: WaitReason;
  responseClass: "success" | "service_unavailable";
};

export function executionDiagnosticContextFrom(value: unknown): ExecutionDiagnosticContext | undefined {
  try {
    if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(fields).length !== 2 ||
      !fields.caller ||
      !fields.operation ||
      !("value" in fields.caller) ||
      !("value" in fields.operation)
    )
      return;
    const caller = fields.caller.value,
      operation = fields.operation.value;
    const valid =
      caller === "executor"
        ? operation === "unclassified"
        : caller === "check"
          ? ["metadata", "command"].includes(operation)
          : caller === "harness" && HARNESS_EXECUTION_OPERATIONS.includes(operation);
    return valid ? ({ caller, operation } as ExecutionDiagnosticContext) : undefined;
  } catch {
    return;
  }
}

/** Read only own data fields. Extra fields, accessors and foreign shapes grant
 * no observation; diagnostic decoding must not disturb the original error. */
export function typedExecutionDiagnosticFrom(value: unknown): TypedExecutionDiagnostic | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
    const fields = Object.getOwnPropertyDescriptors(value);
    const keys = ["version", "phase", "route", "reason", "responseClass", "caller", "operation"];
    if (
      Reflect.ownKeys(fields).length !== keys.length ||
      keys.some((key) => !fields[key] || !("value" in fields[key]!))
    )
      return;
    const data = Object.fromEntries(keys.map((key) => [key, fields[key]!.value]));
    if (
      data.version !== 1 ||
      data.phase !== "pre_execution_busy" ||
      data.route !== "exec" ||
      !isWaitReason(data.reason) ||
      !["success", "service_unavailable"].includes(data.responseClass)
    )
      return;
    const context = executionDiagnosticContextFrom({ caller: data.caller, operation: data.operation });
    return context ? (data as TypedExecutionDiagnostic) : undefined;
  } catch {
    return;
  }
}

/** Preserve the original exception and its cause chain; inspect bounded own
 * data only, including when an error crosses a module's import boundary. */
export function typedExecutionDiagnosticOf(error: unknown): TypedExecutionDiagnostic | undefined {
  const seen = new Set<unknown>();
  try {
    for (let depth = 0; depth < 4 && error instanceof Error && !seen.has(error); depth++) {
      seen.add(error);
      const name = Object.getOwnPropertyDescriptor(error, "name")?.value;
      const value = Object.getOwnPropertyDescriptor(error, "executionDiagnostic")?.value;
      if (name === "ExecCapacityError") {
        const diagnostic = typedExecutionDiagnosticFrom(value);
        if (diagnostic) return diagnostic;
      }
      error = Object.getOwnPropertyDescriptor(error, "cause")?.value;
    }
  } catch {
    return;
  }
}
