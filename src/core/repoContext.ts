import { resolveGithubToken } from "../execution/githubApp.js";
import { validRef } from "./residentAdmin.js";
import type { PrCommitList } from "./headMoved.js";
import { normalizeHead } from "./reviewedHead.js";

// Repo/ref resolution for resident environments (U7, KD7/KTD11): the
// dispatcher resolves the target repo and ref BEFORE the model turn, from
// explicit signals only. Extraction sources in priority order:
//   1. the CURRENT message — an `owner/name` slug, a github.com repo/PR URL
//      (Slack markup `<url|label>` unwrapped), or `owner/name#N` PR shorthand
//   2. the thread's BINDING — the repo (and, for the review post-step, the
//      PR) the thread established earlier — derived from history on every
//      message like `lastThreadDirectives` (restart-safe, never stored)
//   3. none → {} → the per-thread executor path (AE4: total input contract).
//
// Signals have two strengths. STRONG: a github.com URL (repo, PR, /tree), or
// `owner/name#N` shorthand — unambiguously a repository. WEAK: a bare
// `owner/name`-shaped token, which is also the shape of every relative file
// path (`features/memory.md`, `src/core`) and of ordinary prose. A thread
// bound by a strong signal is rebound ONLY by another strong signal; weak
// tokens are consulted only while nothing strong has bound the thread. This
// is what makes the binding deterministic across a thread's life: the PR
// named in the first message stays the target of every re-review until a
// message names a different repo/PR explicitly (PR #167, 2026-08-29: a bare
// `features/memory.md` in a re-review reply rebound the repo, unbound the
// PR, and the LGTM never reached GitHub).
//
// Weak tokens are further guarded two ways (2026-08-29 regressions: prose
// like `reflection/review-post`, `try/catch`, `comment/spec` in a thread
// opened with a bare `in coreplanelabs/switchboard` each sent a review into
// a cold sandbox for a repo that does not exist): (1) a bare token NEVER
// overrides a repo the thread already established, whatever its strength —
// the first binding stays until a STRONG signal replaces it; (2) in a thread
// with no repo yet, a bare token binds only when the injectable resident
// probe (`isResident`) confirms it names an onboarded resource. No probe
// (local/dev, tests) → binds as before: there is no registry to consult.
//
// ADDRESSED repos are the third strength (2026-09-04: a thread bound to
// switchboard by an issue link kept every later `in coreplanelabs/nominal`
// run on the switchboard resident — the bare slug was weak, so it could not
// rebind — and the opening `in nominal` carried no signal at all, so that run
// went cold): a token right after the word `in` names the TARGET of the
// request — `in owner/name` anywhere in the message, or a bare `in name` in
// the DIRECTIVE position only (`agent:coding in nominal, …`: nothing but
// directives or mentions before it — "the crash is in api, see the logs" is
// prose even when a repo is called `api`). Once the registry vets it, it is
// STRONG: it binds a fresh thread and rebinds a bound one, like a URL. The
// vetting is what keeps the #167 guard intact — `in features/memory.md` is
// refused by the probe and changes nothing, and a merely-mentioned onboarded
// slug ("also check acme/web") is still weak. A bare NAME resolves only
// through the registry listing (`residentSlugs`) and only when exactly one
// onboarded repo carries it; unknown or ambiguous names are prose. No probe
// (local/dev) → nothing can be vetted: an addressed slug stays the weak token
// it always was (`in try/catch` is prose too) and names bind nothing. A
// registry that does not ANSWER is not a refusal: when the current message
// addresses a slug and the probe is unreachable, the resolver reports
// `unverifiedRepo` and binds nothing — never a silent fall back to the
// thread's old repo, which is the wrong-repo run this strength exists to end.
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
  /** PR number the review post-step targets (issue #69). Set when the CURRENT
   *  message references a PR of the resolved repo (URL or `owner/name#N`) —
   *  independent of ref binding, known from the reference itself, so it
   *  survives a failed/cross-fork head-ref fetch. Otherwise INHERITED from the
   *  thread (last user turn naming a PR of the resolved repo — the re-review
   *  reply in a PR thread names no PR), but only fail-closed: the PR must be
   *  fetched now, be `open`, and yield a well-formed head SHA; anything else →
   *  no `pr`, Slack-only. */
  pr?: number;
  /** Head commit SHA of that PR at resolution time (from the same REST call as
   *  the head ref). Pins the posted review via `commit_id`, so the org's
   *  auto-approve guard refuses a verdict that predates a newer push. Explicit
   *  PR: set whenever the fetch succeeded — including cross-fork PRs, whose ref
   *  is not bound. Inherited PR: always set (its absence drops the PR). */
  headSha?: string;
  /** Base branch of that PR (from the same REST call), validated as a ref.
   *  Tells the review agent its diff base (features/agent-review.md item 9);
   *  unset when unknown — the agent then uses origin/HEAD. */
  baseRef?: string;
  /** Set when the thread's bound PR was NOT usable for the post-step: it is
   *  closed/merged, or the fetch failed (network, non-2xx, malformed SHA).
   *  Lets the dispatcher say so in the thread instead of a silent Slack-only
   *  verdict. Never set alongside `pr`. */
  prUnpostable?: { number: number; reason: "closed" | "unreachable" };
  /** Set when NO repo could be bound and the reason is that every bare
   *  `owner/name` candidate the resolver consulted (this message's slug, the
   *  thread's weakly-bound repo, an `on <slug>` mention) was refused by the
   *  resident probe — the first refused one, in resolution order (#316). The
   *  dispatcher turns it into a "not onboarded" reply instead of a repo-less
   *  run. Never set alongside `repo`; never set for a thread that already has
   *  a repo (prose slugs there are never even probed — #289; only an
   *  `in <slug>` address costs one probe, refused or not); never set
   *  without a probe (local/dev binds unvetted). */
  rejectedRepo?: string;
  /** Set when NO repo could be bound because a candidate could not be VETTED —
   *  the resident registry did not answer (transport failure, outage window,
   *  a probe that threw) — as opposed to refusing it: the first such
   *  candidate, in resolution order. An explicitly addressed `in <slug>` in
   *  the current message that cannot be vetted sets this even in a bound
   *  thread, instead of falling back to the thread's old repo (the wrong-repo
   *  run of 2026-09-04). The dispatcher turns it into a "could not verify,
   *  try again" reply. Never set alongside `repo`; outranks `rejectedRepo`
   *  when both would apply (a registry that was down cannot have refused). */
  unverifiedRepo?: string;
}

// GitHub owner: alphanumeric + hyphens, no leading/trailing hyphen, ≤39.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
// Repo name: word chars, dots, hyphens (GitHub's charset).
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
// Ref candidates are validated with validRef (the resident's strict ref
// pattern, shared with residentAdmin.ts) so a hostile or malformed phrase
// never becomes a refHint.
const WELL_KNOWN_REFS = new Set(["main", "master", "develop", "trunk"]);
// Code: fenced blocks (```…```, multi-line) and inline spans (`…` on one line) —
// Slack and Markdown both render these as code.
const CODE_SPAN = /```[\s\S]*?```|`[^`\n]*`/g;

/** Slack link markup `<url>` / `<url|label>` → the bare url. Deliberately
 *  case-SENSITIVE, unlike shipTaskText's `gi` twin: unwrapping an
 *  uppercase-scheme labeled link (`<HTTPS://…|label>`) would change what the
 *  signal regexes below bind — see the note in shipPipeline.ts. */
function unwrapSlack(text: string): string {
  return text.replace(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/g, " $1 ");
}

/** Strip wrapping punctuation a token picks up in prose ("vary:", "(api)"). */
function stripPunct(token: string): string {
  return token.replace(/^[("'`<[{*]+/, "").replace(/[)"'`>\]}.,;:!?*]+$/, "");
}

/** A request's lead-in token: an inline directive (`agent:coding`,
 *  `model:anthropic/x`) or a Slack mention (`<@U…>`, `<@U…|name>`) — what may
 *  stand before `in <name>` for the bare name to count as the address. */
function isDirectiveOrMention(token: string): boolean {
  return /^[a-z]+:\S+$/i.test(token) || /^<@[^>\s]+>$/.test(token);
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
  /** true when `repo` came from a URL (a bare slug token is weak — see the
   *  file header). `pr` is always strong. */
  repoStrong?: boolean;
  /** definite ref: keyword phrasing, well-known "on X", /tree/<ref> */
  ref?: string;
  /** PR reference; the head ref needs one REST call */
  pr?: { repo: string; number: number };
  /** ambiguous "on <owner/name-shaped>" token (slug or slashy branch) —
   *  original case kept; resolved against repo presence by the caller */
  onSlug?: string;
  /** The request's addressed target: the first token after the word `in`
   *  (outside code) — a lowercase `owner/name` slug, or a bare lowercase name
   *  the caller resolves through the registry listing. */
  addressed?: Addressed;
}

/** `in <owner/name>` → `{ slug }`; `in <name>` → `{ name }`. */
type Addressed = { slug: string; name?: undefined } | { name: string; slug?: undefined };

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
  const kw = /(?:^|\s)on\s+(?:the\s+)?branch\s+(\S+)/i.exec(text) ?? /(?:^|\s)branch[:=](\S+)/i.exec(text);
  if (kw) out.ref = validRef(stripPunct(kw[1]));

  // Repo URL with an explicit /tree/<ref>
  const treeUrl = /https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)\/tree\/([^\s?#]+)/i.exec(text);
  if (treeUrl) {
    const slug = slugOf(`${stripPunct(treeUrl[1])}/${stripPunct(treeUrl[2])}`);
    if (slug) {
      if (!out.repo) {
        out.repo = slug;
        out.repoStrong = true;
      }
      out.ref ??= validRef(stripPunct(treeUrl[3]));
    }
  }

  // Plain repo URL (also matches the repo prefix of PR/tree URLs — same slug)
  const repoUrl = /https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(text);
  if (repoUrl && !out.repo) {
    const slug = slugOf(`${stripPunct(repoUrl[1])}/${stripPunct(repoUrl[2])}`);
    if (slug) {
      out.repo = slug;
      out.repoStrong = true;
    }
  }

  // Token scan: bare `owner/name` slugs, `owner/name#N` PR shorthand, and
  // "on X" ref phrasing. A token in ref position (after "on"/"branch") is
  // never taken as a repo; an `owner/name`-shaped one there is ambiguous and
  // recorded separately (the caller resolves it against repo presence).
  //
  // A token inside a code span / fenced block (`like/this`) is code or a path
  // being TALKED ABOUT, never a repo switch — it is excluded from the bare-slug
  // branch only (see features/resident-repos.md item 29). Refs (`on \`main\``)
  // and URL/PR forms are unaffected.
  const tokens = text.split(/\s+/).filter(Boolean);
  const inCode = text
    .replace(CODE_SPAN, (m) => m.replace(/\S/g, "\u0000"))
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => tok.includes("\u0000"));
  for (let i = 0; i < tokens.length; i++) {
    const t = stripPunct(tokens[i]);
    if (!t || t.includes("://") || t.toLowerCase().startsWith("github.com/")) continue;
    const prev = i > 0 ? stripPunct(tokens[i - 1]).toLowerCase() : "";
    if (prev === "branch") continue; // keyword form, handled above
    // "in X": the addressed target — a slug anywhere, or a bare name for the
    // registry to resolve when nothing but directives/mentions precede the
    // `in` (the compose position; a bare word deeper in prose is prose).
    // Recorded beside the weak-slug scan below (the slug still lands in
    // `repo` as before); code spans are paths being talked about.
    if (prev === "in" && !inCode[i] && !out.addressed) {
      const slug = slugOf(t);
      if (slug) out.addressed = { slug };
      else if (!t.includes("/") && NAME_RE.test(t) && tokens.slice(0, i - 1).every(isDirectiveOrMention))
        out.addressed = { name: t.toLowerCase() };
    }
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
    if (!out.repo && !inCode[i]) {
      const slug = slugOf(t);
      if (slug) out.repo = slug;
    }
  }

  return out;
}

/** What a thread has established from its user turns — its BINDING: the repo
 *  (last STRONG signal wins; weak signals bind only while no strong one has)
 *  and the last PR referenced. Sync, network-free, and a pure function of the
 *  history array — one dispatch can scan the same array more than once (op
 *  recognition + repo resolution), so memoize per reference. */
interface ThreadSignals {
  repo?: string;
  /** true once a strong signal (URL / `owner/name#N` / a vetted address) bound the repo */
  repoStrong?: boolean;
  /** Last user-turn PR reference (URL or `owner/name#N`), any repo; the
   *  resolver checks it against the resolved repo. */
  pr?: { repo: string; number: number };
  /** Every user turn's binding-relevant signal, in order: a strong repo (URL,
   *  `owner/name#N`) or an address (`in <slug>` / `in <name>`) still to be
   *  vetted. The async resolver walks these from the last one back, vetting
   *  addresses against the registry, so "last strong wins" holds across
   *  URLs and addresses alike. */
  events: ThreadEvent[];
}

type ThreadEvent = { strong: string } | { addressed: Addressed };

/** Sync "is this slug an onboarded resident?" predicate for the history scan
 *  (`repoFromThread`), and its async twin for the resolver. Injected by the
 *  dispatcher from the resident config; absent → weak tokens bind unvetted.
 *  The async probe distinguishes a registry that REFUSED (`false`) from one
 *  that did not ANSWER (`"unreachable"`: transport failure, outage window) —
 *  a throw counts as the latter. */
export type ResidentPredicate = (slug: string) => boolean;
export type ResidentProbe = (slug: string) => Promise<boolean | "unreachable">;
/** The registry listing — every onboarded `owner/name` — for resolving a bare
 *  `in <name>` address. Undefined (or a throw) = no answer: names bind nothing. */
export type ResidentSlugs = () => Promise<string[] | undefined>;

const threadSignalsCache = new WeakMap<Array<{ role: string; text: string }>, ThreadSignals>();

function threadSignals(history: Array<{ role: string; text: string }>, isResident?: ResidentPredicate): ThreadSignals {
  // Only the unvetted scan is memoized: a predicate can change the answer.
  const cached = isResident ? undefined : threadSignalsCache.get(history);
  if (cached) return cached;
  const out: ThreadSignals = { events: [] };
  for (const h of history) {
    if (h.role !== "user") continue;
    const s = extractSignals(h.text);
    let strong = s.pr?.repo ?? (s.repoStrong ? s.repo : undefined);
    if (strong) out.events.push({ strong });
    else if (s.addressed) out.events.push({ addressed: s.addressed });
    // Sync view (repoFromThread): an addressed slug counts strong only when a
    // predicate confirms it — unvetted (no registry) it stays the weak token
    // it always was; a bare name cannot be resolved without the listing and
    // is ignored here.
    if (!strong && s.addressed?.slug && isResident && safePredicate(isResident, s.addressed.slug))
      strong = s.addressed.slug;
    if (strong) {
      out.repo = strong;
      out.repoStrong = true;
    } else if (!out.repo) {
      // Weak signals bind only an UNBOUND thread (first bind wins — a later
      // bare token never overrides), and only when vetted by the probe.
      const weak = s.repo ?? (s.onSlug ? slugOf(s.onSlug) : undefined);
      if (weak && (!isResident || safePredicate(isResident, weak))) out.repo = weak;
    }
    if (s.pr) out.pr = s.pr;
  }
  if (!isResident) threadSignalsCache.set(history, out);
  return out;
}

/** A probe that throws is treated as "not onboarded" (fail-closed): a bare
 *  token must never bind a repo on the strength of an error. */
function safePredicate(isResident: ResidentPredicate, slug: string): boolean {
  try {
    return isResident(slug) === true;
  } catch {
    return false;
  }
}

/** The probe's answer with a throw folded into "unreachable" (the registry did
 *  not answer — never a refusal, never a bind); no probe → true (no registry
 *  to consult → bind as before). */
async function safeProbe(isResident: ResidentProbe | undefined, slug: string): Promise<boolean | "unreachable"> {
  if (!isResident) return true;
  try {
    const answer = await isResident(slug);
    return answer === true || answer === "unreachable" ? answer : false;
  } catch {
    return "unreachable";
  }
}

/**
 * The repo this thread already established (its binding): the last user turn
 * with a STRONG repo signal wins — a URL, `owner/name#N`, or an addressed
 * `in <owner/name>` the predicate confirms (trusted when there is none); a
 * bare slug binds only a thread nothing has bound yet — and, when a predicate
 * is supplied, only if it names an onboarded resident (like
 * `lastThreadDirectives` — derived from history on every message, never
 * stored, restart-safe). A PR URL in history contributes its repo part only,
 * never a fetch. Bare `in <name>` addresses need the registry listing and are
 * resolved only by the async `resolveRepoContext`.
 */
export function repoFromThread(
  history: Array<{ role: string; text: string }>,
  isResident?: ResidentPredicate,
): string | undefined {
  return threadSignals(history, isResident).repo;
}

/**
 * The production repo/ref resolver — the default behind the dispatcher's
 * `CoreDeps.resolveRepoContext` seam. No repo signal anywhere → {} (the
 * per-thread path, no resident probe).
 */
export async function resolveRepoContext(
  msg: { text: string },
  history: Array<{ role: string; text: string }> = [],
  isResident?: ResidentProbe,
  residentSlugs?: ResidentSlugs,
): Promise<RepoContext> {
  const s = extractSignals(msg.text);
  const thread = threadSignals(history);
  // The first bare candidate the probe refused, remembered so the dispatcher
  // can say why nothing was bound (#316) — only meaningful when `repo` stays
  // unset; cleared below the moment anything binds.
  let rejected: string | undefined;
  // The first candidate the registry did not ANSWER for (unreachable) — kept
  // apart from `rejected`: a registry that was down cannot have refused.
  let unverified: string | undefined;
  // One probe per candidate per resolution: an addressed slug is vetted as an
  // address first and may be consulted again as a weak token below (#289's
  // "never probed twice" holds, the registry is not hammered on retries).
  const vetted = new Map<string, Promise<boolean | "unreachable">>();
  const vet = async (cand: string): Promise<boolean> => {
    let p = vetted.get(cand);
    if (!p) {
      p = safeProbe(isResident, cand);
      vetted.set(cand, p);
    }
    const answer = await p;
    if (answer === true) return true;
    if (answer === "unreachable") unverified ??= cand;
    else rejected ??= cand;
    return false;
  };
  // The registry listing, fetched at most once per resolution and only when
  // an address is a bare name; a lister that fails or is absent answers
  // nothing, and a name that is not carried by exactly one onboarded repo is
  // prose.
  let slugsOnce: Promise<string[] | undefined> | undefined;
  const listSlugs = (): Promise<string[] | undefined> => {
    if (!residentSlugs) return Promise.resolve(undefined);
    slugsOnce ??= residentSlugs().catch(() => undefined);
    return slugsOnce;
  };
  const resolveAddressed = async (a: Addressed): Promise<string | undefined> => {
    // Unvetted (no probe), an addressed slug is the weak token it always was —
    // `in try/catch` is ordinary prose, and only the registry can tell.
    if (a.slug !== undefined) return isResident && (await vet(a.slug)) ? a.slug : undefined;
    const matches = ((await listSlugs()) ?? []).filter((slug) => slug.split("/")[1] === a.name);
    return matches.length === 1 ? matches[0] : undefined;
  };
  // Strong signal in this message → it (re)binds: a URL, `owner/name#N`, or an
  // address the registry vets. Else the thread's LAST strong signal, walking
  // its turns backwards and vetting addresses the same way. Else the thread's
  // weak repo, vetted (it was itself a bare token once); only if the thread
  // has no repo at all may this message's bare slug bind — vetted too. A bare
  // slug in this message that is not addressed (a file path, a phrase) is
  // NEVER a repo switch. No probe → unvetted.
  const strongNow =
    s.pr?.repo ??
    (s.repoStrong ? s.repo : undefined) ??
    (s.addressed ? await resolveAddressed(s.addressed) : undefined);
  // An explicitly addressed slug the registry could not be asked about is a
  // stop, not a fall-through: running on the thread's old repo instead would
  // be the wrong-repo run this strength exists to end. Refuse loudly.
  if (strongNow === undefined && s.addressed?.slug !== undefined && unverified === s.addressed.slug) {
    return { unverifiedRepo: s.addressed.slug };
  }
  let repo = strongNow;
  for (let i = thread.events.length - 1; repo === undefined && i >= 0; i--) {
    const ev = thread.events[i];
    repo = "strong" in ev ? ev.strong : await resolveAddressed(ev.addressed);
  }
  if (!repo && thread.repo && (await vet(thread.repo))) repo = thread.repo;
  if (!repo && s.repo && (await vet(s.repo))) repo = s.repo;
  let ref = s.ref;

  // "on <owner/name-shaped>": a ref when a repo is independently established
  // (current message or thread), otherwise a (vetted) repo mention. When the
  // slug IS the established repo, "on <slug>" merely restates it — never a
  // ref (live incident 2026-09-03: "auto-merge is now disabled on
  // coreplanelabs/switchboard" handed ship a repo-shaped base ref).
  if (s.onSlug) {
    if (repo && !ref) {
      if (slugOf(s.onSlug) !== repo) ref = s.onSlug;
    } else if (!repo) {
      const cand = slugOf(s.onSlug);
      if (cand && (await vet(cand))) repo = cand;
    }
  }
  if (repo) {
    rejected = undefined;
    unverified = undefined;
  }

  // PR head — one REST call whenever the CURRENT message names a PR of the
  // resolved repo, regardless of any ref phrasing beside it. The PR is the
  // explicit target: its head branch is the ref, and its head SHA pins the
  // review post (agent-review.md item 8). A prose "on X" in the same message
  // ("re-review: rebuilt on main after #298 landed…", PR #300, 2026-08-30) used
  // to bind `ref` and thereby SKIP this fetch — leaving the head unknown, the
  // resident's worktree stale and the post refused. Now the phrase is only a
  // fallback for when the fetch fails (repo-only otherwise).
  let headSha: string | undefined;
  let baseRef: string | undefined;
  if (s.pr && repo === s.pr.repo) {
    const head = await prHead(s.pr).catch(() => undefined);
    if (head?.ref) ref = head.ref;
    headSha = head?.sha;
    baseRef = head?.base;
  }

  const out: RepoContext = {};
  if (repo) out.repo = repo;
  else if (unverified) out.unverifiedRepo = unverified;
  else if (rejected) out.rejectedRepo = rejected;
  if (ref) out.ref = ref;
  // PR for the deterministic review post-step. Named in the current message →
  // set regardless of whether the head fetch succeeded (the reference itself
  // is the user's instruction). Otherwise inherit the thread's PR — the
  // re-review reply in a PR thread names no PR — but fail-closed: it must
  // belong to the resolved repo, be fetched NOW, be open, and yield a head SHA
  // to pin the review to. A closed/merged PR, a failed fetch, or a malformed
  // SHA all leave `pr` unset (Slack-only) rather than risk posting a verdict
  // to a stale PR or an unpinned verdict that a newer push could inherit. The
  // ref is never rebound from an inherited PR: a thread redirected with
  // "on <branch>" keeps that binding.
  if (repo && s.pr && repo === s.pr.repo) {
    out.pr = s.pr.number;
    if (headSha) out.headSha = headSha;
    if (baseRef) out.baseRef = baseRef;
  } else if (repo && !s.pr) {
    const inherited = thread.pr;
    if (inherited && inherited.repo === repo) {
      const head = await openPrHeadSha(inherited);
      if ("sha" in head) {
        out.pr = inherited.number;
        out.headSha = head.sha;
        if (head.base) out.baseRef = head.base;
      } else {
        out.prUnpostable = { number: inherited.number, reason: head.reason };
      }
    }
  }
  return out;
}

/** The fail-closed contract for an INHERITED PR: its head SHA, only if the PR
 *  is fetched now, is `open`, and the SHA is well-formed; otherwise the reason
 *  it is unusable — `closed` (closed/merged) or `unreachable` (failed fetch,
 *  malformed SHA, unknown state). Never throws. */
async function openPrHeadSha(pr: {
  repo: string;
  number: number;
}): Promise<{ sha: string; base?: string } | { reason: "closed" | "unreachable" }> {
  const head = await prHead(pr).catch(() => undefined);
  if (head?.state === "closed") return { reason: "closed" };
  if (head?.state === "open" && head.sha) return head.base ? { sha: head.sha, base: head.base } : { sha: head.sha };
  return { reason: "unreachable" };
}

/** The PR's head SHA as GitHub reports it NOW (40-hex), or undefined when the
 *  fetch fails or the SHA is malformed. Never throws — the review post-step's
 *  head-moved note (agent-review.md item 10) degrades to silence on unknown. */
export async function currentPrHeadSha(pr: { repo: string; number: number }): Promise<string | undefined> {
  const head = await prHead(pr).catch(() => undefined);
  return head?.sha;
}

/** The commits a PR head carries over its base — `GET /repos/{repo}/compare/{base}...{sha}`
 *  — as the head-moved classifier consumes them (agent-review.md item 12):
 *  the head-side commits oldest first with full messages, the touched files,
 *  and whether GitHub capped the file list (300). Works for a head that a
 *  force-push has since replaced: GitHub keeps serving the commit object by
 *  sha. Never throws; undefined on any failure or malformed answer (the
 *  classifier then has no verdict and the dispatcher falls back to the pinned
 *  post + note). */
export async function prCommitsSince(input: {
  repo: string;
  base: string;
  sha: string;
}): Promise<PrCommitList | undefined> {
  const sha = normalizeHead(input.sha);
  const base = validRef(input.base);
  if (!sha || !base) return undefined;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "switchboard",
  };
  const token = await resolveGithubToken().catch(() => null);
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${input.repo}/compare/${encodeURIComponent(base)}...${sha}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => null)) as {
    commits?: Array<{ sha?: string; commit?: { message?: string } }>;
    files?: Array<{ filename?: string }>;
  } | null;
  if (!data || !Array.isArray(data.commits)) return undefined;
  const commits: PrCommitList["commits"] = [];
  for (const c of data.commits) {
    const csha = normalizeHead(c?.sha);
    if (!csha || typeof c.commit?.message !== "string") return undefined;
    commits.push({ sha: csha, message: c.commit.message });
  }
  const files = Array.isArray(data.files)
    ? data.files.map((f) => f.filename).filter((f): f is string => typeof f === "string")
    : [];
  return { commits, files, filesTruncated: files.length >= COMPARE_FILES_CAP };
}

/** GitHub's compare endpoint lists at most this many files. */
const COMPARE_FILES_CAP = 300;

/** GET /repos/{owner}/{repo}/pulls/{n} → { head.ref, head.sha, state }. Cross-fork
 *  head REFS are NOT returned (they don't resolve in the resident's mirror);
 *  the SHA is, since it only pins the review post. Never throws to the
 *  caller's happy path — callers .catch() to degrade. */
async function prHead(pr: {
  repo: string;
  number: number;
}): Promise<{ ref?: string; sha?: string; base?: string; state?: "open" | "closed" } | undefined> {
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
    state?: string;
    head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
    base?: { ref?: string };
  };
  // Base branch: validated like every ref candidate (never partial garbage).
  const base = typeof data.base?.ref === "string" ? validRef(data.base.ref) : undefined;
  const sha = typeof data.head?.sha === "string" && /^[0-9a-f]{40}$/.test(data.head.sha) ? data.head.sha : undefined;
  const headRepo = data.head?.repo?.full_name?.toLowerCase();
  // Require a POSITIVE same-repo match for the REF: a null head.repo (deleted
  // fork) must not bind the base repo's ref to a fork PR. Dropping the
  // `headRepo &&` short-circuit makes a missing/mismatched head repo leave the
  // ref undefined.
  const ref = data.head?.ref && headRepo === pr.repo ? validRef(data.head.ref) : undefined;
  const state = data.state === "open" || data.state === "closed" ? data.state : undefined;
  return { ref, sha, base, state };
}
