import { OPERATOR_READ_TOOLS, OPERATOR_READS_MAX } from "./operatorReadTools.js";

export const CANDIDATE_SMOKE_DIAGNOSTIC_SCOPE = "candidate-smoke-v1";
const ARGUMENT_KEY_MAX_CHARS = 4096;
type Helper = (typeof OPERATOR_READ_TOOLS)[keyof typeof OPERATOR_READ_TOOLS];
export type SmokeReadResult =
  "reply" | "metadata_only" | "reader_unavailable" | "not_found" | "invalid_arguments" | "read_error" | "unknown";
type Argument = { kind: "group"; ordinal: number } | { kind: "untracked"; reason: "invalid" | "limit" };
export interface CandidateSmokeDiagnostic {
  version: 1;
  scope: typeof CANDIDATE_SMOKE_DIAGNOSTIC_SCOPE;
  reads: { helper: Helper; argument: Argument; result: SmokeReadResult }[];
  lastCommand?: { category: "read" | "write" | "unknown" };
  incomplete?: true;
}
const helpers = new Set<string>(Object.values(OPERATOR_READ_TOOLS));
const results = new Set<unknown>([
  "reply",
  "metadata_only",
  "reader_unavailable",
  "not_found",
  "invalid_arguments",
  "read_error",
  "unknown",
]);

/** Comparison keys remain bounded and local to this call. Only closed facts
 * and equality ordinals leave it. Equality is exact decoded input, not a
 * repository alias or action/fulfillment proof. */
export class CandidateSmokeDiagnosticCollector {
  private readonly keys = new Map<string, number>();
  private readonly reads: CandidateSmokeDiagnostic["reads"] = [];
  private lastCommand?: CandidateSmokeDiagnostic["lastCommand"];
  private incomplete = false;

  read(helper: unknown, decoded: unknown, result: unknown): void {
    this.begin(helper, decoded)?.(result);
  }
  begin(helper: unknown, decoded: unknown): ((result: unknown) => void) | undefined {
    if (typeof helper !== "string" || !helpers.has(helper) || this.reads.length >= OPERATOR_READS_MAX) {
      this.incomplete = true;
      return;
    }
    const argument = this.argument(helper, decoded);
    if (argument.kind === "untracked") this.incomplete = true;
    const read: CandidateSmokeDiagnostic["reads"][number] = {
      helper: helper as Helper,
      argument,
      result: "unknown",
    };
    this.reads.push(read);
    return (result) => {
      if (!results.has(result)) this.incomplete = true;
      read.result = results.has(result) ? (result as SmokeReadResult) : "unknown";
    };
  }
  command(category: unknown): void {
    this.lastCommand = { category: category === "read" || category === "write" ? category : "unknown" };
  }
  snapshot(): CandidateSmokeDiagnostic {
    return {
      version: 1,
      scope: CANDIDATE_SMOKE_DIAGNOSTIC_SCOPE,
      reads: this.reads.map((read) => ({ ...read, argument: { ...read.argument } })),
      ...(this.lastCommand ? { lastCommand: { ...this.lastCommand } } : {}),
      ...(this.incomplete || this.reads.some((read) => read.result === "unknown") ? { incomplete: true } : {}),
    };
  }
  private argument(helper: string, decoded: unknown): Argument {
    try {
      if (
        !decoded ||
        typeof decoded !== "object" ||
        Array.isArray(decoded) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(decoded))
      )
        return { kind: "untracked", reason: "invalid" };
      const field =
        helper === OPERATOR_READ_TOOLS.repositoryBrief
          ? "repo"
          : helper === OPERATOR_READ_TOOLS.providerModels
            ? "filter"
            : undefined;
      if (Reflect.ownKeys(decoded).some((key) => key !== field)) return { kind: "untracked", reason: "invalid" };
      const descriptor = field ? Object.getOwnPropertyDescriptor(decoded, field) : undefined;
      if (descriptor && !("value" in descriptor)) return { kind: "untracked", reason: "invalid" };
      const value: unknown = descriptor?.value;
      if (
        (field === "repo" && (typeof value !== "string" || !value)) ||
        (value !== undefined && typeof value !== "string")
      )
        return { kind: "untracked", reason: "invalid" };
      if (typeof value === "string" && value.length > ARGUMENT_KEY_MAX_CHARS)
        return { kind: "untracked", reason: "limit" };
      const key = JSON.stringify([helper, field ? { [field]: value } : {}]);
      if (key.length > ARGUMENT_KEY_MAX_CHARS) return { kind: "untracked", reason: "limit" };
      const ordinal = this.keys.get(key) ?? this.keys.size + 1;
      this.keys.set(key, ordinal);
      return { kind: "group", ordinal };
    } catch {
      return { kind: "untracked", reason: "invalid" };
    }
  }
}

export function candidateSmokeDiagnostic(scope: unknown): CandidateSmokeDiagnosticCollector | undefined {
  return scope === CANDIDATE_SMOKE_DIAGNOSTIC_SCOPE ? new CandidateSmokeDiagnosticCollector() : undefined;
}
