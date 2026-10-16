import { createTracer } from "../trace/tracer.js";
import { systemClock } from "../trace/clock.js";
import { startProcessRoot, type RequestTraceDeps } from "../requestTrace.js";
import { classificationOf, classifyError } from "../trace/classify.js";
import {
  ORGANIZATION_HISTORY_FAILURE_CODES,
  type OrganizationHistoryFailureCode,
  type OrganizationOwnerStage,
  type OrganizationOwnerFailure,
} from "./contract.js";
export type { OrganizationOwnerFailure, OrganizationOwnerStage } from "./contract.js";

/** Keep the existing refusal text; only this closed code may enter owner logs. */
export function historyFailure(code: OrganizationHistoryFailureCode, message: string): Error {
  return classifyError(new Error(message), { kind: "refused", code });
}

/** Unknown exceptions supply no prose, name, stack or arbitrary peer code. */
export function ownerFailureAt(stage: OrganizationOwnerStage, error: unknown): OrganizationOwnerFailure["failure"] {
  try {
    const classification = classificationOf(error);
    if (classification && ["timeout", "transport", "http", "refused", "infra", "other"].includes(classification.kind)) {
      const code = ORGANIZATION_HISTORY_FAILURE_CODES.find((code) => code === classification.code);
      return { stage, kind: classification.kind, ...(code ? { code } : {}) };
    }
  } catch {
    // Error inspection cannot replace the failure being reported.
  }
  return { stage, kind: "other" };
}

/** Reuse the operator-readable trace ring, including failures before dispatch. */
export function logOwnerFailure(
  deps: Omit<RequestTraceDeps, "tracer"> & { buildCommit: string },
  report: OrganizationOwnerFailure,
): void {
  // Sink failures must not print another exception through the tracer's warning path.
  const tracer = createTracer({ clock: deps.clock ?? systemClock, warn: () => {} });
  const root = startProcessRoot({ ...deps, tracer }, "organization.owner_failure", {
    attrs: {
      runId: report.runId,
      organizationReceiptId: report.receiptId,
      requestDigest: report.requestDigest,
      ownerStage: report.failure.stage,
      ownerBranch: report.branch,
      buildCommit: deps.buildCommit,
      ...(report.firstFailure
        ? {
            firstOwnerStage: report.firstFailure.stage,
            firstOwnerErrorKind: report.firstFailure.kind,
            ...(report.firstFailure.code ? { firstOwnerErrorCode: report.firstFailure.code } : {}),
          }
        : {}),
    },
  });
  root.fail(
    classifyError(new Error(), {
      kind: report.failure.kind,
      ...(report.failure.code ? { code: report.failure.code } : {}),
    }),
  );
  root.end("error");
}
