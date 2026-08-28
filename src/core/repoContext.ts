import { resolveGithubToken } from "../execution/githubApp.js";
import { validRef } from "./repoCommands.js";

// Repo/ref resolution for resident environments (U7, KD7/KTD11): the
// dispatcher resolves the target repo and ref BEFORE the model turn, from
// explicit signals only. Extraction sources in priority order:
//   1. the CURRENT message — an `owner/name` slug, a github.com repo/PR URL
//      (Slack markup `<url|label>` unwrapped), or `owner/name#N` PR shorthand
//   2. the thread's previously-established repo, derived from history on every
//      message like `lastThreadDirectives` (restart-safe, never stored)
//   3. none → {} → the per-thread executor path (AE4: total input contract).
//
// Ref extraction is deliberately conservative (KTD6: ref binding is
// explicit-or-ask-once, never a silent guess): explicit forms only —
// "on branch X" / `branch:X`, "on X" where X is a well-known default branch
// or slash-shaped, a /tree/<ref> URL, or a PR's head ref. When in doubt the
// ref stays undefined and attach either reuses the resident's sticky binding
// or answers needs-ref (the dispatcher then asks ONE clarifying question).
//
// PR head refs are resolved via the GitHub REST API authenticated with
// resolveGithubToken() — NEVER a `gh` shell-out (no host gh credential in
// prod; AGENTS.md invariant 5). Unauthenticated works for public repos; any
// fetch failure degrades gracefully to repo-only.

export interface RepoContext {
  repo?: string;
  ref?: string;
  /** PR number, set when the CURRENT message references a PR of the resolved
   *  repo (URL or `owner/name#N`). Independent of ref binding — known from the
   *  reference itself, so it survives a failed/cross-fork head-ref fetch. Lets
   *  the dispatcher post a review back to the PR by default (issue #69). */
  pr?: number;
}

// GitHub owner: alphanumeric + hyphens, no leading/trailing hyphen, ≤39.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
// Repo name: word chars, dots, hyphens (GitHub's charset).
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
// Ref candidates are validated with validRef (the resident's strict ref
// pattern, shared with repoCommands.ts) so a hostile or malformed phrase
// never becomes a refHint.
const WELL_KNOWN_REFS = new Set(["main", "master", "develop", "trunk"]);

/** Slack link markup `<url>` / `<url|label>` → the bare url. */
function unwrapSlack(text: string): string {
  return text.replace(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/g, " $1 ");
}

/** Strip wrapping punctuation a token picks up in prose ("vary:", "(api)"). */
function stripPunct(token: string): string {
  return token.replace(/^[("'`<[{*]+/, "").replace(/[)"'`>\]}.,;:!?*]+$/, "");
}

/** "owner/name" (optionally with a ".git" suffix) → lowercase slug, or undefined. */
function slugOf(token: string): string | undefined {
  const parts = token.replace(/\.git$/i, "").split("/");
  if (parts.length !== 2) return undefined;
  const [owner, name] = parts;
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name) || /^\.+$/.test(name)) return undefined;
  return `${owner}/${name}`.toLowerCase();
}

interface Signals {
  /** definite repo: URL form or a bare slug token not in ref position */
  repo?: string;
  /** definite ref: keyword phrasing, well-known "on X", /tree/<ref> */
  ref?: string;
  /** PR reference; the head ref needs one REST call */
  pr?: { repo: string; number: number };
  /** ambiguous "on <owner/name-shaped>" token (slug or slashy branch) —
   *  original case kept; resolved against repo presence by the caller */
  onSlug?: string;
}

/** Pure, sync signal extraction from one message text (no network). */
function extractSignals(rawText: string): Signals {
  const text = unwrapSlack(rawText);
  const out: Signals = {};

  // PR URL → repo + PR number (head ref resolved later, via REST)
  const prUrl = /https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)\/pull\/(\d+)/i.exec(text);
  if (prUrl) {
    const slug = slugOf(`${stripPunct(prUrl[1])}/${stripPunct(prUrl[2])}`);
    if (slug) out.pr = { repo: slug, number: Number(prUrl[3]) };
  }

  // Explicit branch keyword: "on [the] branch X" or "branch:X" / "branch=X"
  const kw =
    /(?:^|\s)on\s+(?:the\s+)?branch\s+(\S+)/i.exec(text) ?? /(?:^|\s)branch[:=](\S+)/i.exec(text);
  if (kw) out.ref = validRef(stripPunct(kw[1]));

  // Repo URL with an explicit /tree/<ref>
  const treeUrl = /https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)\/tree\/([^\s?#]+)/i.exec(text);
  if (treeUrl) {
    const slug = slugOf(`${stripPunct(treeUrl[1])}/${stripPunct(treeUrl[2])}`);
    if (slug) {
      out.repo ??= slug;
      out.ref ??= validRef(stripPunct(treeUrl[3]));
    }
  }

  // Plain repo URL (also matches the repo prefix of PR/tree URLs — same slug)
  const repoUrl = /https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(text);
  if (repoUrl && !out.repo) {
    const slug = slugOf(`${stripPunct(repoUrl[1])}/${stripPunct(repoUrl[2])}`);
    if (slug) out.repo = slug;
  }

  // Token scan: bare `owner/name` slugs, `owner/name#N` PR shorthand, and
  // "on X" ref phrasing. A token in ref position (after "on"/"branch") is
  // never taken as a repo; an `owner/name`-shaped one there is ambiguous and
  // recorded separately (the caller resolves it against repo presence).
  const tokens = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = stripPunct(tokens[i]);
    if (!t || t.includes("://") || t.toLowerCase().startsWith("github.com/")) continue;
    const prev = i > 0 ? stripPunct(tokens[i - 1]).toLowerCase() : "";
    if (prev === "branch") continue; // keyword form, handled above
    if (prev === "on") {
      if (!out.ref && WELL_KNOWN_REFS.has(t)) out.ref = t;
      else if (!out.onSlug && slugOf(t) && validRef(t)) out.onSlug = t;
      else if (!out.ref && t.includes("/") && !slugOf(t)) out.ref = validRef(t);
      continue;
    }
    const prShort = /^([^/#\s]+)\/([^/#\s]+)#(\d+)$/.exec(t);
    if (prShort) {
      const slug = slugOf(`${prShort[1]}/${prShort[2]}`);
      if (slug && !out.pr) out.pr = { repo: slug, number: Number(prShort[3]) };
      continue;
    }
    if (!out.repo) {
      const slug = slugOf(t);
      if (slug) out.repo = slug;
    }
  }

  return out;
}

/** repoFromThread is a pure function of the history array, and one dispatch
 *  can scan the same array more than once (op recognition + repo resolution)
 *  — memoize per array reference so the second call reuses the scan. */
const repoFromThreadCache = new WeakMap<Array<{ role: string; text: string }>, string | undefined>();

/**
 * The repo this thread already established: last user turn with an explicit
 * repo signal wins (like `lastThreadDirectives` — derived from history on
 * every message, never stored, restart-safe). Sync and network-free: a PR URL
 * in history contributes its repo part only, never a fetch.
 */
export function repoFromThread(history: Array<{ role: string; text: string }>): string | undefined {
  if (repoFromThreadCache.has(history)) return repoFromThreadCache.get(history);
  let repo: string | undefined;
  for (const h of history) {
    if (h.role !== "user") continue;
    const s = extractSignals(h.text);
    const explicit = s.repo ?? s.pr?.repo;
    if (explicit) repo = explicit;
    else if (!repo && s.onSlug) repo = slugOf(s.onSlug);
  }
  repoFromThreadCache.set(history, repo);
  return repo;
}

/**
 * The production repo/ref resolver — the default behind the dispatcher's
 * `CoreDeps.resolveRepoContext` seam. No repo signal anywhere → {} (the
 * per-thread path, no resident probe).
 */
export async function resolveRepoContext(
  msg: { text: string },
  history: Array<{ role: string; text: string }> = [],
): Promise<RepoContext> {
  const s = extractSignals(msg.text);
  let repo = s.repo ?? s.pr?.repo ?? repoFromThread(history);
  let ref = s.ref;

  // "on <owner/name-shaped>": a ref when a repo is independently established
  // (current message or thread), otherwise a repo mention.
  if (s.onSlug) {
    if (repo && !ref) ref = s.onSlug;
    else if (!repo) repo = slugOf(s.onSlug);
  }

  // PR head ref — one REST call, only when nothing more explicit bound a ref
  // and the PR belongs to the resolved repo. Failure degrades to repo-only.
  if (!ref && s.pr && repo === s.pr.repo) {
    ref = await prHeadRef(s.pr).catch(() => undefined);
  }

  const out: RepoContext = {};
  if (repo) out.repo = repo;
  if (ref) out.ref = ref;
  // PR number for the deterministic review post-step: only when the current
  // message named a PR of the resolved repo. Not inherited from thread history
  // (a stale PR must never receive a later review), and set regardless of
  // whether the head-ref fetch succeeded.
  if (repo && s.pr && repo === s.pr.repo) out.pr = s.pr.number;
  return out;
}

/** GET /repos/{owner}/{repo}/pulls/{n} → head.ref. Cross-fork heads are NOT
 *  returned (they don't resolve in the resident's mirror). Never throws to
 *  the caller's happy path — callers .catch() to degrade. */
async function prHeadRef(pr: { repo: string; number: number }): Promise<string | undefined> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "switchboard",
  };
  const token = await resolveGithubToken().catch(() => null);
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${pr.repo}/pulls/${pr.number}`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => ({}))) as {
    head?: { ref?: string; repo?: { full_name?: string } };
  };
  const headRepo = data.head?.repo?.full_name?.toLowerCase();
  // Require a POSITIVE same-repo match: a null head.repo (deleted fork) must
  // not bind the base repo's ref to a fork PR. Dropping the `headRepo &&`
  // short-circuit makes a missing/mismatched head repo return undefined.
  if (!data.head?.ref || headRepo !== pr.repo) return undefined;
  return validRef(data.head.ref);
}
