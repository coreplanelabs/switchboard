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
