/** A current GitHub read, independent of the run's recorded diff. */
export interface PrChecksSnapshot {
  repo: string;
  number: number;
  headSha: string;
  checkedSha: string;
  state: string;
  checkedAt: number;
  checks: PrCheck[];
  warnings: string[];
}

export interface PrCheck {
  id: string;
  name: string;
  status: "pending" | "in_progress" | "success" | "failure" | "neutral" | "skipped" | "cancelled" | "expected";
  required: boolean;
  description?: string;
  url?: string;
  provider?: string;
  icon?: string;
}

export interface PrChecksSource {
  read(repo: string, number: number): Promise<PrChecksSnapshot>;
}

/** Expected upstream refusal; its message is safe for the command surface. */
export class PrChecksUnavailable extends Error {}
