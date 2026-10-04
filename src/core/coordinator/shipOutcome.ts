import type { UnitEnding } from "../ship/coordinator.js";

type TerminalKind = Exclude<UnitEnding["kind"], "idle" | "continued" | "merge_ready">;
type FindingsStop = NonNullable<Extract<UnitEnding, { kind: "aborted" }>["findingsStop"]>;

/** Producer facts retained beside the display report. This is a domain result,
 * not permission to recover, publish, or repeat an effect. */
export interface ShipOutcome {
  schemaVersion: 1;
  kind: TerminalKind;
  reviewRounds: number;
  recoveryStop?: "continuation_not_admitted";
  terminalPr?:
    | { state: "closed"; number: number; url: string }
    | { state: "merged"; number: number; url: string; mergeSha: string; headSha?: string };
  findings?: {
    stop?: FindingsStop;
    observedHead?: string;
    remoteHead?: string;
    /** Absent means not recorded, not zero missing outputs. */
    missingOutputCount?: number;
  };
}

export type ShipSettlement =
  { state: "recorded"; outcome: ShipOutcome } | { state: "unverified"; reason: "not_recorded" };

/** Call only after validating the containing unit and its outcome binding. */
export function shipSettlementOf(ending: { outcome?: ShipOutcome }): ShipSettlement {
  return ending.outcome === undefined
    ? { state: "unverified", reason: "not_recorded" }
    : { state: "recorded", outcome: ending.outcome };
}

/** A replay compares facts, independent of JSON property order. Both values
 * have already crossed the strict decoder. */
export function sameShipOutcome(a: ShipOutcome | undefined, b: ShipOutcome | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const fields = (value: ShipOutcome) => [
    value.schemaVersion,
    value.kind,
    value.reviewRounds,
    value.recoveryStop,
    value.terminalPr === undefined
      ? null
      : [
          value.terminalPr.state,
          value.terminalPr.number,
          value.terminalPr.url,
          ...(value.terminalPr.state === "merged" ? [value.terminalPr.mergeSha, value.terminalPr.headSha] : []),
        ],
    value.findings === undefined
      ? null
      : [
          value.findings.stop,
          value.findings.observedHead,
          value.findings.remoteHead,
          value.findings.missingOutputCount,
        ],
  ];
  return JSON.stringify(fields(a)) === JSON.stringify(fields(b));
}

// Exhaustiveness follows the machine's union. A new ending requires a deliberate
// decision here before it can cross persistence as a known outcome.
const KINDS = {
  merged: true,
  closed: true,
  already_landed: true,
  held: true,
  merge_refused: true,
  round_cap: true,
  wall_clock_cap: true,
  review_pending: true,
  stopped: true,
  aborted: true,
  no_verdict: true,
  idle_expired: true,
  transient: true,
  interrupted: true,
  refused: true,
} satisfies Record<TerminalKind, true>;

export function isShipOutcomeKind(value: unknown): value is ShipOutcome["kind"] {
  return typeof value === "string" && Object.hasOwn(KINDS, value);
}

const FINDINGS_STOPS = {
  incomplete_outputs: true,
  unfinished: true,
  missing_remote: true,
  head_mismatch: true,
  remote_unreadable: true,
} satisfies Record<FindingsStop, true>;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const head = (value: unknown) => typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);

/** Strict decoding keeps legacy display strings and unknown future fields
 * from acquiring machine meaning on either side of a restart. */
export function isShipOutcome(value: unknown): value is ShipOutcome {
  if (
    !object(value) ||
    !only(value, ["schemaVersion", "kind", "reviewRounds", "terminalPr", "findings", "recoveryStop"]) ||
    value.schemaVersion !== 1 ||
    !isShipOutcomeKind(value.kind) ||
    !count(value.reviewRounds) ||
    (value.recoveryStop !== undefined &&
      (value.kind !== "aborted" ||
        value.recoveryStop !== "continuation_not_admitted" ||
        value.reviewRounds !== 0 ||
        value.terminalPr !== undefined ||
        value.findings !== undefined))
  )
    return false;
  const pr = value.terminalPr;
  if (pr !== undefined) {
    if (
      !object(pr) ||
      !count(pr.number) ||
      pr.number === 0 ||
      typeof pr.url !== "string" ||
      pr.url.length === 0 ||
      pr.url.length > 2048 ||
      !["aborted", "merged", "closed"].includes(value.kind)
    )
      return false;
    if (pr.state === "closed") {
      if (!only(pr, ["state", "number", "url"]) || value.kind === "merged") return false;
    } else if (pr.state === "merged") {
      if (
        !only(pr, ["state", "number", "url", "mergeSha", "headSha"]) ||
        !head(pr.mergeSha) ||
        (pr.headSha !== undefined && !head(pr.headSha)) ||
        value.kind === "closed"
      )
        return false;
    } else return false;
  } else if (value.kind === "merged" || value.kind === "closed") return false;
  const findings = value.findings;
  if (findings !== undefined) {
    if (
      value.kind !== "aborted" ||
      !object(findings) ||
      !only(findings, ["stop", "observedHead", "remoteHead", "missingOutputCount"]) ||
      Object.keys(findings).length === 0 ||
      (findings.stop !== undefined &&
        (typeof findings.stop !== "string" || !Object.hasOwn(FINDINGS_STOPS, findings.stop))) ||
      (findings.observedHead !== undefined && !head(findings.observedHead)) ||
      (findings.remoteHead !== undefined && !head(findings.remoteHead)) ||
      (findings.missingOutputCount !== undefined && !count(findings.missingOutputCount))
    )
      return false;
  }
  return true;
}

/** Project the state machine at settlement, before any report is rendered.
 * Unknown facts stay absent; no text or inferred success enters this record. */
export function shipOutcomeOf(ending: UnitEnding): ShipOutcome | undefined {
  // Merge readiness also depends on the driver's final PR/check read. Until
  // those facts have a bound projection, the machine kind alone proves none.
  if (ending.kind === "idle" || ending.kind === "continued" || ending.kind === "merge_ready") return undefined;
  const terminal = ending.kind === "aborted" ? ending.terminalPr : undefined;
  const terminalPr: ShipOutcome["terminalPr"] =
    ending.kind === "merged"
      ? { state: "merged", number: ending.pr.number, url: ending.pr.url, mergeSha: ending.sha }
      : ending.kind === "closed"
        ? { state: "closed", number: ending.pr.number, url: ending.pr.url }
        : terminal?.state === "merged"
          ? {
              state: "merged",
              number: terminal.prNumber,
              url: terminal.url,
              mergeSha: terminal.sha,
              ...(terminal.headSha !== undefined ? { headSha: terminal.headSha } : {}),
            }
          : terminal?.state === "closed"
            ? { state: "closed", number: terminal.prNumber, url: terminal.url }
            : undefined;
  const findings =
    ending.kind === "aborted"
      ? {
          ...(ending.findingsStop !== undefined ? { stop: ending.findingsStop } : {}),
          ...(ending.observedHead !== undefined ? { observedHead: ending.observedHead } : {}),
          ...(ending.remoteHead !== undefined ? { remoteHead: ending.remoteHead } : {}),
          ...(ending.missingOutputs !== undefined ? { missingOutputCount: ending.missingOutputs.length } : {}),
        }
      : {};
  const outcome = {
    schemaVersion: 1 as const,
    kind: ending.kind,
    reviewRounds: ending.reviewRounds,
    ...(ending.kind === "aborted" && ending.recoveryStop !== undefined ? { recoveryStop: ending.recoveryStop } : {}),
    ...(terminalPr !== undefined ? { terminalPr } : {}),
    ...(Object.keys(findings).length > 0 ? { findings } : {}),
  };
  if (isShipOutcome(outcome)) return outcome;
  if (ending.kind === "aborted" && ending.recoveryStop !== undefined) throw new Error("invalid recovery outcome");
  return undefined;
}
