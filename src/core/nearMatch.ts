// The one deterministic "did you mean" over a list the bot holds
// (docs/decisions/0054-a-refusal-the-person-caused-is-one-question-with-a-best-guess.md):
// a refusal the person's words caused becomes one question carrying the bot's
// best guess, and the guess is computed here, once, with one budget rule —
// never a model call and never a second rule per site.
//
// A candidate is within budget when it shares a prefix of at least three
// characters with the typed name, or when it is within an edit budget of a
// third of the typed name's length (at least one edit, at most two). A unique
// candidate within budget is the guess; two or three are listed and none is
// proposed; none leaves the question without a guess. A typed name that is
// itself a candidate is never a typo — the exact name wins and nothing is
// proposed.

/** What one near-match pass found. `guess` is set only when exactly one
 *  candidate is within budget; `candidates` is set (two or three) when several
 *  are; both unset when none is. `reason` explains a `guess` in words for the
 *  evidence line ("one edit from `acme/infrastructure`"). */
export interface NearMatch {
  guess?: string;
  candidates?: string[];
  reason?: string;
}

/** The shortest prefix two names must share before it counts as a match — one
 *  or two characters match half the world. */
const MIN_PREFIX = 3;

/** The edit budget for a typed name: a third of its length, clamped to one and
 *  two edits (the rule git, Clang and the Rust compiler settled on). */
export function editBudget(typed: string): number {
  return Math.min(2, Math.max(1, Math.floor(typed.length / 3)));
}

/** Levenshtein distance over two strings, the classic dynamic program. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/** How a candidate matched the typed name, or undefined when it did not. The
 *  prefix rule fires in both directions, so the match says which name extends
 *  which — the reason must not read backwards. */
function matchOf(
  typed: string,
  candidate: string,
): { kind: "prefix"; extended: "candidate" | "typed" } | { kind: "edit"; edits: number } | undefined {
  if (typed === candidate) return undefined; // the exact name is not a typo
  if (candidate.startsWith(typed) && typed.length >= MIN_PREFIX) return { kind: "prefix", extended: "candidate" };
  if (typed.startsWith(candidate) && candidate.length >= MIN_PREFIX) return { kind: "prefix", extended: "typed" };
  const edits = editDistance(typed, candidate);
  return edits <= editBudget(typed) ? { kind: "edit", edits } : undefined;
}

/**
 * One pass of the near-match rule over `candidates` for `typed` (both compared
 * case-insensitively; the candidate's own spelling is returned). Pure and
 * deterministic — the same inputs always answer the same way.
 */
export function nearMatch(typed: string, candidates: readonly string[]): NearMatch {
  const needle = typed.toLowerCase();
  // A typed name that IS a candidate is never a typo, whatever else is close.
  if (candidates.some((c) => c.toLowerCase() === needle)) return {};
  const within: Array<{ candidate: string; edits?: number; extended?: "candidate" | "typed" }> = [];
  for (const candidate of candidates) {
    const match = matchOf(needle, candidate.toLowerCase());
    if (match)
      within.push(match.kind === "edit" ? { candidate, edits: match.edits } : { candidate, extended: match.extended });
  }
  if (within.length === 1) {
    const only = within[0];
    return {
      guess: only.candidate,
      reason:
        only.edits !== undefined
          ? `${only.edits === 1 ? "one edit" : "two edits"} from \`${only.candidate}\``
          : only.extended === "candidate"
            ? `\`${only.candidate}\` extends the name`
            : `the name extends \`${only.candidate}\``,
    };
  }
  if (within.length > 1) return { candidates: within.slice(0, 3).map((w) => w.candidate) };
  return {};
}
