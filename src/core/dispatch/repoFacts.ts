// Switchboard's source-tree facts, rendered from this index and checked
// against its own docs directories. The operator's read tool scopes these
// facts to Switchboard; another repository needs its own brief before its layout can
// guide a routing decision.

/** One documented docs directory a request names by noun. */
export interface RepoDocFact {
  /** The files, as the repository lays them out. */
  glob: string;
  /** The noun a request uses for one of them. */
  noun: string;
  /** How a request names one file ("record NNNN"). */
  ref: string;
}

/** The docs index: the directories AGENTS.md's "Where things are" points at
 *  whose files people name by noun and number. The test pins each glob's
 *  directory to the repository's own tree, so the index cannot outlive it. */
export const REPO_DOC_INDEX: readonly RepoDocFact[] = [
  { glob: "docs/decisions/*.md", noun: "a decision record", ref: "record NNNN" },
  { glob: "docs/plans/*.md", noun: "a plan", ref: "plan YYYY-MM-DD-NNN" },
];

/** The facts block the operator's prompt carries, one line per index row: the
 *  files are ordinary markdown a ship unit edits — flipping a record's status,
 *  amending a plan — so an ask that names one is a docs write to bind, never
 *  administrative state to refuse. */
export function renderRepoFacts(index: readonly RepoDocFact[] = REPO_DOC_INDEX): string[] {
  return index.map(
    (f) =>
      `- \`${f.glob}\` (${f.noun}; "${f.ref}" names one): a markdown file in the repository that a ship unit edits like any other file — flipping its status or amending it is an ordinary docs change, never administrative state.`,
  );
}
