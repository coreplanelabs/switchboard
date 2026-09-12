// The pr-review module's OWN input contract (docs/reference/specs/reading-diff.md item 12).
//
// This folder is deliberately self-contained — no imports from the app's lib/,
// pages/, or the runs domain — so the whole module can be lifted into another
// product as-is. Consumers adapt THEIR data (for Switchboard: run
// events — see ../../lib/prReviewCollector.ts) into these shapes; the module
// never knows where they came from.

/** The pull request the review is about. Everything optional: the panel
 *  renders whatever is known and omits the rest. */
export interface PrRef {
  /** `owner/name`. Link-building validates the shape; an odd value renders as text only. */
  repo?: string;
  number?: number;
  /** The PR head the artifacts were produced at (7–40 hex). */
  headSha?: string;
  /** The base branch the diffs are against. */
  baseRef?: string;
}

/** One reading diff of the change — the full `git diff`, or an abridged
 *  "reading diff" from a model-backed producer (meat.dev today). */
export interface ReadingDiff {
  poweredBy: "git" | "meat";
  /** What the diff is against (a branch name, or `HEAD` for the default). */
  baseRef: string;
  /** Unified diff text (possibly abridged — not necessarily applicable). */
  diff: string;
  truncated: boolean;
  /** The producer's one-line summary of the change (abridged diffs only). */
  summary?: string;
}

/** The PR's description as the panel renders it — the host projects its own
 *  description object (submitted or parsed from the PR body) onto this: the
 *  title names the panel, the prose fills the Description tab. */
export interface PrDescriptionData {
  /** The PR's title: the header's text. */
  title: string;
  tldr?: string;
  /** The "What & why" prose, when the host could separate it from the body. */
  whatWhy?: string;
  /** `submitted`: the typed object the PR was opened from; `parsed`: read back
   *  from the PR body, possibly short of sections. */
  origin: "submitted" | "parsed";
  /** Nothing missing or malformed. */
  complete: boolean;
  /** The body was cut before it was read. */
  truncated: boolean;
}

/** Everything the panel renders. */
export interface PrReviewData {
  pr: PrRef;
  readingDiffs: ReadingDiff[];
  /** The PR's description when the host knows it; the header names the PR
   *  by its title then, and the Description tab carries its prose. */
  description?: PrDescriptionData;
}

/** The abridging of the full diff, when the host can ask for one: `absent`
 *  offers the button, `running` shows the wait, `failed` names the reason and
 *  offers a retry; `done` renders nothing — the abridged diff has arrived in
 *  `readingDiffs` by then and its tab takes over. The host owns the request
 *  and the polling; the panel only renders the state and calls `start`. */
export type AbridgeState =
  { state: "absent" } | { state: "running" } | { state: "done" } | { state: "failed"; reason: string };

export interface AbridgeControl {
  readonly state: AbridgeState;
  /** Start the abridging — or retry it after a failure. */
  start(): void;
}

/** The header's title text: the PR's own title, else its reference. */
export function panelTitle(data: Pick<PrReviewData, "pr" | "description">): string {
  if (data.description?.title) return data.description.title;
  if (data.pr.repo && data.pr.number !== undefined) return `${data.pr.repo}#${data.pr.number}`;
  return data.pr.repo ?? "PR review";
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** A git sha as the module accepts it (7–40 hex). Exported for adapters — the
 *  import direction (host → module) respects the module boundary. */
export const SHA_RE = /^[0-9a-f]{7,40}$/;

/** GitHub links for the PR, built only from values whose shape is verified —
 *  a link is never assembled from text that could smuggle a path. */
export function prLinks(pr: PrRef): { pr?: string; files?: string; commit?: string } {
  if (!pr.repo || !REPO_RE.test(pr.repo)) return {};
  const base = `https://github.com/${pr.repo}`;
  const out: { pr?: string; files?: string; commit?: string } = {};
  if (pr.number !== undefined && Number.isInteger(pr.number) && pr.number > 0) {
    out.pr = `${base}/pull/${pr.number}`;
    out.files = `${base}/pull/${pr.number}/files`;
  }
  if (pr.headSha && SHA_RE.test(pr.headSha)) {
    out.commit =
      pr.number !== undefined && out.pr
        ? `${base}/pull/${pr.number}/commits/${pr.headSha}`
        : `${base}/commit/${pr.headSha}`;
  }
  return out;
}

/** The diff a reader should see first: the abridged one when a producer made
 *  it, else the full diff, else null. */
export function preferredDiff(diffs: readonly ReadingDiff[]): ReadingDiff | null {
  return diffs.find((d) => d.poweredBy === "meat") ?? diffs.find((d) => d.poweredBy === "git") ?? null;
}

/** What a producer's label means, for the reader who cannot name it (a tooltip). */
export function poweredByExplanation(poweredBy: ReadingDiff["poweredBy"]): string {
  return poweredBy === "meat"
    ? "An abridged reading of the change: a model dropped what a reviewer need not read (style, imports, boilerplate) and kept the concepts"
    : "The complete change, base…head, as git reports it";
}

/** What `truncated` means: the recorded diff stops at `chars` characters. */
export function truncatedExplanation(chars: number): string {
  return `The recorded diff was cut at ${chars.toLocaleString("en-US")} characters; open the full diff on GitHub for the rest`;
}

/** Reader-facing label per producer. */
export function poweredByLabel(poweredBy: ReadingDiff["poweredBy"]): string {
  return poweredBy === "meat" ? "reading diff · meat" : "full diff · git";
}

/** The muted line under a description that is less than the whole: read back
 *  from the PR body and short of the house shape, or cut before it was read.
 *  Nothing for a submitted or complete one. */
export function descriptionNote(
  description: Pick<PrDescriptionData, "origin" | "complete" | "truncated">,
): string | undefined {
  const parts: string[] = [];
  if (description.origin === "parsed" && !description.complete) parts.push("read back from the PR body");
  if (description.truncated) parts.push("the body was cut before it was read");
  return parts.length > 0 ? parts.join("; ") : undefined;
}
