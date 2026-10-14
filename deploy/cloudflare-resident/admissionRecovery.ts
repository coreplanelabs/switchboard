/** A recovery request reads the resident again while the fleet is fenced.
 * Any unreadable owner, active lifecycle, or pool-user process keeps the
 * targeted permit. External evidence that the original request ended is
 * required separately; this check never infers that from a ticket's age. */
export function recoveryViewsAreIdle(views: readonly unknown[]): boolean {
  return views.every((view) => {
    if (!view || typeof view !== "object") return false;
    const row = view as Record<string, unknown>;
    return (
      ["warm", "degraded", "down"].includes(String(row.state)) &&
      row.executingRuns === 0 &&
      row.unknownRuns === 0 &&
      row.activeProcesses === 0
    );
  });
}

/** Require a link to an operator-verified request-end receipt. A URL alone
 * cannot prove the request ended; the operator checks the linked record. */
export function recoveryEvidenceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 16 || trimmed.length > 1000) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export interface AdmissionRecoveryQuote {
  startedAt: number;
  recordSha256: string;
}

export function recoveryQuote(startedAt: unknown, recordSha256: unknown): AdmissionRecoveryQuote | null {
  return Number.isSafeInteger(startedAt) &&
    Number(startedAt) >= 0 &&
    typeof recordSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(recordSha256)
    ? { startedAt: Number(startedAt), recordSha256 }
    : null;
}

/** Hash every field of the flat stored permit. Unsupported or corrupt data
 * stays held; a digest identifies a record, never proves request ending. */
export async function admissionRecordHash(value: unknown): Promise<string | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, "startedAt") || !Number.isSafeInteger(record.startedAt) || Number(record.startedAt) < 0)
    return null;
  if (record.schema !== undefined && record.schema !== 1) return null;
  if (
    record.requestHash !== undefined &&
    (typeof record.requestHash !== "string" || !/^[0-9a-f]{64}$/.test(record.requestHash))
  )
    return null;
  const entries = Object.keys(record)
    .sort()
    .map((key) => [key, record[key]] as const);
  if (
    entries.some(
      ([, item]) =>
        item !== null &&
        typeof item !== "string" &&
        typeof item !== "boolean" &&
        !(typeof item === "number" && Number.isFinite(item)),
    )
  )
    return null;
  const serialized = JSON.stringify(Object.fromEntries(entries));
  if (serialized.length > 4096) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
