import { oneLine, redactAndCap } from "../../core/redact.js";

function safeMessage(value: string): string {
  return redactAndCap(
    oneLine(value)
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "«redacted-url»")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "«redacted-email»"),
    200,
  );
}

/** Only observed SDK fields and one bounded message can enter Slack failure logs. */
export function describeSlackFailure(error: unknown): string {
  const row = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const code = typeof row?.code === "string" && /^slack_webapi_[a-z0-9_]{1,60}$/.test(row.code) ? row.code : undefined;
  if (code) {
    const status = row?.statusCode;
    const retryAfter = row?.retryAfter;
    const data = row?.data;
    const platformCode =
      data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).error : undefined;
    return [
      code,
      ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
        ? [`HTTP ${status}`]
        : []),
      ...(typeof retryAfter === "number" && Number.isInteger(retryAfter) && retryAfter >= 0 && retryAfter <= 604_800
        ? [`retry after ${retryAfter}s`]
        : []),
      ...(typeof platformCode === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(platformCode)
        ? [`Slack code ${platformCode}`]
        : []),
    ].join("; ");
  }
  if (error instanceof Error) {
    const kind =
      error instanceof TypeError
        ? "TypeError"
        : error instanceof RangeError
          ? "RangeError"
          : error instanceof SyntaxError
            ? "SyntaxError"
            : "Error";
    const message = safeMessage(error.message);
    return message ? `${kind}: ${message}` : kind;
  }
  if (typeof error === "string") {
    const message = safeMessage(error);
    return message ? `Slack failure: ${message}` : "Slack failure";
  }
  return "Slack failure";
}
