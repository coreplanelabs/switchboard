// The repository facts the operator's projection carries (issue 2043; record
// 0069's execution table): what a plain-words docs ask names. Production
// refused three "record NNNN"/"plan …" asks in one hour as "privileged
// administrative updates to control plane records" — an authority the model
// invented, because nothing told it a decision record or a plan is a markdown
// file under docs/ that a ship unit edits like any other file. The block is
// RENDERED from this index — the docs directories AGENTS.md points at, held to
// the repository's own tree by this module's test — never prose written by
// hand at the prompt site: a new documented directory is one row here, and the
// renderer says the same sentence about each. The index is Switchboard's own
// docs layout, and the block rides every operator prompt — a request naming a
// repo without these directories is still told they exist there; the misroute
// costs one ship run finding no such file, and a per-repo index belongs with
// the repository briefs when that unit lands.

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
