/** Diagnostic evidence from the admission counter. Completeness describes
 * capture coverage, never health, authority, cleanup or historical UID reuse. */
export interface WorkloadAuditSource {
  kind: "reservation" | "operator" | "binding" | "native-operation" | "process" | "uid-allocation";
  user?: string;
  threadKey?: string;
  runId?: string;
  ownerGen?: string;
  ownerFence?: number;
  state?: string;
  category?: string;
  reason?: string;
  canonicalKind?: string;
  canonicalRevision?: number;
  canonicalStatus?: string;
  canonicalObservedAt?: string;
  registeredAt?: string;
  deadlineAt?: number;
  lastAttachAt?: string;
  key?: string;
  recordHash?: string;
  closed?: boolean;
  pendingAttempts?: number;
  processes?: { id: string; pid: number; startedAt: string }[];
}

export interface WorkloadAuditCapture {
  asOf: string;
  sources: Map<string, WorkloadAuditSource[]>;
  owners?: Set<string>;
  nativeRecords: Map<string, unknown>;
  complete: boolean;
  processes: WorkloadAudit["processes"];
  issues: string[];
  uidHistory?: { issued: number | null; complete: boolean };
}

export interface WorkloadAudit {
  schema: 1;
  resource: string;
  residentId: string;
  build: { commit: string; builtAt?: string };
  asOf: string;
  finishedAt: string;
  incarnation: string;
  boot: { id: string | null; observation: "cached" | "unknown" };
  consistency: "best-effort";
  workloadLimit: number;
  used: number | null;
  complete: boolean;
  ownersOmitted: number;
  sourcesOmitted: number;
  detailsOmitted: number;
  processes: "not-observed" | "identities-only" | "runtime-inactive" | "unavailable";
  issues: string[];
  uidHistory: { issued: number | null; complete: boolean };
  owners: { key: string; sources: WorkloadAuditSource[] }[];
}
