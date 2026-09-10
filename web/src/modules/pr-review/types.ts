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

/** Where a Tour step points: a path and an inclusive 1-based line range on
 *  the new side, plus the head the anchor was rendered at when known. */
export interface TourAnchor {
  path: string;
  from: number;
  to: number;
  /** 7–40 hex. Compared with the reviewed head: a step anchored at another
   *  head may point at lines that have since moved. */
  sha?: string;
}

/** One step of the PR description's Tour, reader-first: what the change is,
 *  the explanation, an optional pointer at what to scrutinize, the code. */
export interface TourStep {
  title: string;
  description: string;
  lookFor?: string;
  anchor: TourAnchor;
}

/** The PR's description as the panel renders it — the host projects its own
 *  description object (submitted or parsed from the PR body) onto this. */
export interface PrDescriptionData {
  /** The PR's title: the header's text. */
  title: string;
  tldr?: string;
  /** The "What & why" prose, when the host could separate it from the body. */
  whatWhy?: string;
  tour: TourStep[];
  /** The touched files the Tour did not cover, one note each. */
  remaining: { path: string; note: string }[];
  /** `submitted`: the typed object the PR was opened from; `parsed`: read back
   *  from the PR body, possibly short of sections. */
  origin: "submitted" | "parsed";
  /** Nothing missing or malformed. */
  complete: boolean;
  /** The body was cut before it was read. */
  truncated: boolean;
  /** The head the description was produced at (7–40 hex). */
  headSha?: string;
}

/** Everything the panel renders. */
export interface PrReviewData {
  pr: PrRef;
  readingDiffs: ReadingDiff[];
  /** The PR's description when the host knows it; the header names the PR
   *  by its title then, and the left column opens on the TL;DR and the Tour. */
  description?: PrDescriptionData;
}

/** The abridging of the full diff, when the host can ask for one: `absent`
 *  offers the button, `running` shows the wait, `failed` names the reason and
 *  offers a retry; `done` renders nothing — the abridged diff has arrived in
 *  `readingDiffs` by then and the tabs take over. The host owns the request
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

/** One file of the PR on GitHub at the reviewed head, the lines selected —
 *  where a Tour step goes when its file lies past the recorded diff's cap.
 *  The same discipline as `prLinks`: a shape-verified repo and head, and a
 *  path of plain segments (none empty, `.` or `..`, no backslash, no control
 *  character), each URL-encoded; anything else is no link. */
export function fileLink(pr: PrRef, anchor: { path: string; from?: number; to?: number }): string | undefined {
  if (!pr.repo || !REPO_RE.test(pr.repo) || !pr.headSha || !SHA_RE.test(pr.headSha)) return undefined;
  const segments = anchor.path.split("/");
  // eslint-disable-next-line no-control-regex -- a control character is what is being refused
  const unsafe = /[\\\u0000-\u001f]/;
  if (segments.some((s) => s === "" || s === "." || s === ".." || unsafe.test(s))) return undefined;
  const path = segments.map(encodeURIComponent).join("/");
  const { from, to } = anchor;
  const lines = from === undefined ? "" : to === undefined || to === from ? `#L${from}` : `#L${from}-L${to}`;
  return `https://github.com/${pr.repo}/blob/${pr.headSha}/${path}${lines}`;
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
