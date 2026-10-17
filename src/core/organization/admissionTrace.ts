import type { OrganizationReceipt, OrganizationResult, OrganizationSource } from "./contract.js";
import type { Span, TraceOptions } from "../trace/types.js";
import type { SpanAttrs } from "../trace/attrs.js";
import { classificationOf } from "../trace/classify.js";

const STAGES = [
  "host",
  "installation",
  "native-input",
  "native-proof",
  "source-lookup",
  "replay",
  "source-context",
  "private-epoch",
  "admit-store",
  "reconcile",
  "refresh",
] as const;
const REASONS = [
  "unavailable",
  "exception",
  "refresh-unavailable",
  "native-source-unavailable",
  "catalogue-unavailable",
  "catalogue-changed",
  "policy-observe-unavailable",
  "receiver-unavailable",
  "epoch-exception",
  "epoch-unavailable",
] as const;
const SOURCES = ["browser", "slack", "github", "cli", "http", "mcp"] as const;
const RELATIONS = ["same", "different", "unknown"] as const;
const EXCEPTION_KINDS = ["timeout", "transport", "http", "refused", "infra", "other"] as const;
export type AdmissionExceptionKind = (typeof EXCEPTION_KINDS)[number] | "unclassified-exception";
export type AdmissionRefreshFailure = AdmissionExceptionKind | "unavailable-result";
export type AdmissionStage = (typeof STAGES)[number];
export type AdmissionReason = (typeof REASONS)[number];
export type RequestContextSelection =
  | "selected"
  | "retained_request"
  | "existing_key"
  | "source"
  | "actor"
  | "private_source"
  | "delegation"
  | "continuation"
  | "media"
  | "routing"
  | "target";
export interface AdmissionObservation {
  stage?: AdmissionStage;
  reason?: AdmissionReason;
  receipt?: Pick<OrganizationReceipt, "id">;
  source?: OrganizationSource;
  credentialRelation?: "same" | "different" | "unknown";
  refreshFailure?: AdmissionRefreshFailure;
  exceptionKind?: AdmissionExceptionKind;
  contextSelection?: RequestContextSelection;
}

/** Use only an existing closed classification; exception names and prose are private. */
export function admissionExceptionKindOf(error: unknown): AdmissionExceptionKind {
  try {
    const kind = classificationOf(error)?.kind;
    return EXCEPTION_KINDS.find((value) => value === kind) ?? "unclassified-exception";
  } catch {
    return "unclassified-exception";
  }
}

function setObservation(span: Span | undefined, attrs: SpanAttrs): void {
  try {
    void Promise.resolve(span?.setAttrs(Object.freeze(attrs))).catch(() => {});
  } catch {
    // Observation has no authority over the original operation.
  }
}

/** Call-local observation only. Never pass the request, actor or raw exception. */
export function observeAdmission(trace: TraceOptions | undefined, observation: AdmissionObservation): void {
  try {
    const attrs: SpanAttrs = {
      ...(observation.stage ? { admissionStage: observation.stage } : {}),
      ...(observation.reason ? { admissionReason: observation.reason } : {}),
      ...(observation.receipt ? { receiptObserved: true, organizationReceiptId: observation.receipt.id } : {}),
      ...(observation.source ? { admissionSource: observation.source } : {}),
      ...(observation.credentialRelation ? { credentialRelation: observation.credentialRelation } : {}),
      ...(observation.refreshFailure ? { admissionRefreshFailure: observation.refreshFailure } : {}),
      ...(observation.exceptionKind ? { admissionExceptionKind: observation.exceptionKind } : {}),
      ...(observation.contextSelection ? { requestContextSelection: observation.contextSelection } : {}),
    };
    setObservation(trace?.span, attrs);
  } catch {
    // A failed observer cannot change admission or authorize another attempt.
  }
}

/** The trace identifies this request even when no owner or receipt was observed. */
export function finishAdmission(span: Span, result: OrganizationResult, responseStatus: number) {
  if (result.status === "receipt") observeAdmission({ span }, { receipt: result.receipt });
  let attrs: SpanAttrs = {};
  try {
    attrs = span.record().attrs;
  } catch {
    /* Observation must remain optional. */
  }
  if (responseStatus >= 500 && attrs.admissionReason === undefined)
    observeAdmission({ span }, { reason: "unavailable" });
  if (!span.ended)
    setObservation(span, { outcome: result.status === "receipt" ? result.receipt.status : result.status });
  try {
    span.end(responseStatus >= 500 ? "error" : "ok");
    attrs = span.record().attrs;
  } catch {
    /* Keep the original admission result if tracing fails. */
  }
  const stage = STAGES.find((value) => value === attrs.admissionStage) ?? "host";
  const reason = REASONS.find((value) => value === attrs.admissionReason);
  const source = SOURCES.find((value) => value === attrs.admissionSource);
  const credentialRelation = RELATIONS.find((value) => value === attrs.credentialRelation);
  return {
    traceId: span.traceId,
    stage,
    receiptObserved: result.status === "receipt" || attrs.receiptObserved === true,
    ...(reason ? { reason } : {}),
    ...(source ? { source } : {}),
    ...(credentialRelation ? { credentialRelation } : {}),
  };
}

export function failedAdmission(span: Span, error: unknown): void {
  observeAdmission({ span }, { reason: "exception", exceptionKind: admissionExceptionKindOf(error) });
  setObservation(span, { outcome: "exception" });
  try {
    span.end("error");
  } catch {
    /* Tracing cannot change the unavailable response. */
  }
}
