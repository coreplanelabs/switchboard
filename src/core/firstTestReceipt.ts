import type { ExecResult } from "../execution/execResult.js";

/** Admission facts come from the trusted attach and saved policy, never model text. */
export interface FirstTestCheckout {
  repo: string;
  ref: string;
  head: string;
  workspace: string;
  backend: string;
  container: string;
  dependencyKey: string;
}
export interface FirstTestOwner {
  runId: string;
  requester: string;
  threadKey: string;
  unit: string;
}
export type RefusalCode =
  | "seed_identity_unverifiable"
  | "unsupported_backend"
  | "binding_mismatch"
  | "dependencies_missing"
  | "tool_missing"
  | "preflight_failed"
  | "budget_exhausted";
export interface FirstTestReceipt {
  version: 1;
  operationId: string;
  owner: FirstTestOwner;
  checkout: FirstTestCheckout;
  policyVersion: string;
  commandHash: string;
  requirementHash: string;
  workspaceHash: string;
  startedAt: number;
  completedAt?: number;
  refusedAttempts?: {
    count: number;
    first: { at: number; code: RefusalCode };
    last: { at: number; code: RefusalCode };
  };
  outcome:
    | ({ kind: "completed" } & ExecResult)
    | { kind: "refused"; code: RefusalCode }
    | { kind: "unknown"; code: "execution_pending" | "completion_unknown"; result?: ExecResult };
}
