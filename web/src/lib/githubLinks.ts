// GitHub links for the run page's REVIEW/CODING row, built only from values
// whose shape is verified — a link is never assembled from text that could
// smuggle a path or a scheme. Every builder answers `undefined` for an odd
// value, and the caller renders the fact as plain text instead.
//
// Deliberately a copy of the pr-review module's discipline, not an import from
// it: that module stays free of the runs domain and the page stays free of the
// module, so either can move on its own.

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
/** A git branch name as GitHub accepts one in a URL: `git check-ref-format`'s
 *  rules for the parts that matter here — word characters, dots, slashes and
 *  dashes; no leading dash or dot, no `..`, `//`, `@{`, no `.lock` ending, no
 *  trailing dot or slash. */
const REF_RE = /^(?![.-])(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)(?!.*[./]$)[\w][\w./-]*$/;

export function githubRepoUrl(repo: string | undefined): string | undefined {
  return repo && REPO_RE.test(repo) ? `https://github.com/${repo}` : undefined;
}

export function githubPrUrl(repo: string | undefined, number: number | undefined): string | undefined {
  const base = githubRepoUrl(repo);
  if (!base || number === undefined || !Number.isInteger(number) || number <= 0) return undefined;
  return `${base}/pull/${number}`;
}

/** The branch on GitHub: each path segment URL-encoded, the slashes kept. */
export function githubTreeUrl(repo: string | undefined, ref: string | undefined): string | undefined {
  const base = githubRepoUrl(repo);
  if (!base || !ref || !REF_RE.test(ref)) return undefined;
  return `${base}/tree/${ref.split("/").map(encodeURIComponent).join("/")}`;
}

export function githubCommitUrl(repo: string | undefined, sha: string | undefined): string | undefined {
  const base = githubRepoUrl(repo);
  if (!base || !sha || !SHA_RE.test(sha)) return undefined;
  return `${base}/commit/${sha}`;
}

/** The seven characters a sha is known by. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
