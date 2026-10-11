/** Recorded consent is transport-neutral; older browser rows remain readable. */
export type ConfirmationConsentSource = "browser" | "mcp-form";

export function hasConfirmationConsent(row: {
  browserApproved?: unknown;
  approvedBy?: unknown;
  message?: unknown;
}): boolean {
  const binding = (row.message as { approvalConnection?: { mode?: unknown } } | undefined)?.approvalConnection;
  return (
    row.approvedBy === "browser" ||
    row.approvedBy === "mcp-form" ||
    (row.browserApproved === true && binding?.mode !== "form")
  );
}
