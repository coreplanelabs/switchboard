import type { RecordProblem } from "../docs/records.js";

export const DECISION_RECORD_ENV = "SWITCHBOARD_DECISION_RECORD";
export const DECISION_RECORD_PATTERN = /^docs\/decisions\/(\d{4})-[^/]+\.md$/;

/** A unit asks for a record only when it asks to write one. Merely discussing
 * records or the reservation mechanism is not a request to create one. The
 * parenthesized procedure phrase is the historical form kept for re-issues. */
export function asksForDecisionRecord(text: string): boolean {
  return (
    /\b(?:write|draft|create|add)\b[^\n]{0,120}\b(?:technical\s+)?decision record\b/i.test(text) ||
    /\brecord\s*\(\s*(?:the\s+)?next free number in docs\/decisions\//i.test(text)
  );
}

const numberOf = (path: string): string | undefined => DECISION_RECORD_PATTERN.exec(path)?.[1];

/** Stable, text-free key persisted beside a direct run's reservation. */
export function decisionRecordTaskKey(...parts: string[]): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(parts.join("\n"))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export interface DecisionRecordCheckContext {
  /** True inside a coding child's harness (`SWITCHBOARD_RUN_ID` is present). */
  child: boolean;
  /** The number the runner passed as `record: NNNN`, when it did. */
  reservation?: string;
}

/** The pull-request rules for newly added decision records. `mainPaths` is the
 * current origin/main tip, deliberately not the branch's merge-base: a number
 * claimed on main after this branch was cut is no longer free. */
export function decisionRecordNumberProblems(
  paths: readonly string[],
  mainPaths: readonly string[],
  context: DecisionRecordCheckContext,
): RecordProblem[] {
  const mainByNumber = new Map<string, string>();
  for (const path of mainPaths) {
    const number = numberOf(path);
    if (number !== undefined && !mainByNumber.has(number)) mainByNumber.set(number, path);
  }
  const mainExact = new Set(mainPaths);
  const added = paths.flatMap((path) => {
    if (mainExact.has(path)) return [];
    const number = numberOf(path);
    return number === undefined ? [] : [{ path, number }];
  });
  const countByNumber = new Map<string, number>();
  for (const row of added) countByNumber.set(row.number, (countByNumber.get(row.number) ?? 0) + 1);

  const problems: RecordProblem[] = [];
  for (const row of added) {
    const onMain = mainByNumber.get(row.number);
    if (onMain !== undefined)
      problems.push({
        path: row.path,
        what: `adds decision record ${row.number} but that number already exists on main (${onMain})`,
      });
    const count = countByNumber.get(row.number) ?? 0;
    if (count > 1)
      problems.push({
        path: row.path,
        what: `adds ${count} decision records with number ${row.number} — a pull request may add at most one record per number`,
      });
    if (context.child && context.reservation === undefined)
      problems.push({
        path: row.path,
        what: `adds decision record ${row.number} but this child has no runner reservation (\`record: NNNN\`)`,
      });
    else if (context.child && row.number !== context.reservation)
      problems.push({
        path: row.path,
        what: `adds decision record ${row.number} but this child's runner reservation is ${context.reservation}`,
      });
  }
  return problems;
}

export type DecisionRecordClaims = (repo: string) => Promise<ReadonlySet<string>>;

/** Serializes allocations per repository inside one runner. GitHub remains the
 * durable claim ledger: every allocation begins from main plus open pull
 * requests, while this map closes the interval before a newly admitted child
 * has opened its pull request. */
export class DecisionRecordAllocator {
  private readonly byTask = new Map<string, string>();
  private readonly claimed = new Map<string, Set<string>>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly claims: DecisionRecordClaims) {}

  async reserve(repo: string, taskKey: string, existing?: string): Promise<string> {
    const cacheKey = `${repo}\n${taskKey}`;
    const prior = existing ?? this.byTask.get(cacheKey);
    if (prior !== undefined) {
      this.byTask.set(cacheKey, prior);
      this.claimedFor(repo).add(prior);
      return prior;
    }

    const previous = this.tails.get(repo) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => tail);
    this.tails.set(repo, queued);
    await previous;
    try {
      const repeated = this.byTask.get(cacheKey);
      if (repeated !== undefined) return repeated;
      const used = new Set(await this.claims(repo));
      for (const number of this.claimedFor(repo)) used.add(number);
      const highest = [...used].reduce((max, value) => (/^\d{4}$/.test(value) ? Math.max(max, Number(value)) : max), 0);
      const number = String(highest + 1).padStart(4, "0");
      this.byTask.set(cacheKey, number);
      this.claimedFor(repo).add(number);
      return number;
    } finally {
      release();
      if (this.tails.get(repo) === queued) this.tails.delete(repo);
    }
  }

  private claimedFor(repo: string): Set<string> {
    let set = this.claimed.get(repo);
    if (set === undefined) {
      set = new Set();
      this.claimed.set(repo, set);
    }
    return set;
  }
}
