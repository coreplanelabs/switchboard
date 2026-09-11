import { systemClock } from "./trace/clock.js";

// Delivery indicators: what the run history and the pull requests' own facts
// say about how work reaches `main`, per week and per unit (a board issue),
// with nothing written anywhere. The four leading indicators the published
// accounts of agent-run development name, in this repository's terms:
//
//   issue → merge    from a unit's board issue (or the pull request's own
//                    opening when none is linked) to its merge;
//   first-pass CI    the first head's `pull_request` runs all green at their
//                    first attempt — a retry, or any red, fails it;
//   review rounds    the review agent's verdicts on the pull request; a FIX
//                    round is a verdict that followed a push since the previous
//                    one (a re-verdict with no push is a disposition round);
//   no-human-edit    the share of the review agent's findings on pull requests
//                    where every push after the first verdict was an agent's —
//                    a bot login, or a commit carrying an agent co-author (the
//                    maintainer's own agent pushes under the maintainer's login,
//                    so the login alone would call every one of those human).
//
// Plus the plain counts: pull requests merged, agent-authored ones, findings by
// severity (blocking ones caught), and the agent run time the history keys to a
// pull request. `buildDeliveryReport` is pure and does every bit of arithmetic,
// so the indicators are unit-tested against a recorded trunk pass; a
// `DeliverySource` (src/execution/githubDelivery.ts, or the in-memory one) only
// fetches and maps. Nothing here knows a platform SDK (AGENTS.md invariant 1).

// ---- facts (what a source assembles) ----------------------------------------------------

export type FindingSeverity = "blocking" | "major" | "minor" | "nit" | "fyi";
export const FINDING_SEVERITIES: readonly FindingSeverity[] = ["blocking", "major", "minor", "nit", "fyi"];

export interface ReviewFact {
  /** The GitHub login that posted the review. */
  author: string;
  state: "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
  /** ISO 8601. */
  submittedAt: string;
  body: string;
  /** The head the review was attached to, when GitHub reported one. */
  headSha?: string;
}

export interface PushFact {
  /** Who pushed: a login for a force-push, the committer's name for a plain commit. */
  actor: string;
  /** ISO 8601. */
  at: string;
  kind: "commit" | "force";
  /** The `Co-Authored-By:` names on the commits the push carried (a force-push: the pull request's commits). */
  coauthors: string[];
}

export interface CiRunFact {
  name?: string;
  headSha: string;
  /** The workflow's trigger (`pull_request`, `push`, `pull_request_review`, …). */
  trigger: string;
  /** GitHub's conclusion; null while running or when none was recorded. */
  conclusion: string | null;
  /** 1 on the first attempt; a rerun raises it. */
  attempt: number;
  /** ISO 8601. */
  createdAt: string;
}

export interface LinkedIssueFact {
  number: number;
  title?: string;
  /** ISO 8601. */
  createdAt: string;
}

export interface PullRequestFacts {
  number: number;
  title: string;
  author: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601 — every fact here is a MERGED pull request. */
  mergedAt: string;
  /** The head CI first ran on; absent when nothing recorded a head. */
  firstHeadSha?: string;
  ci: CiRunFact[];
  reviews: ReviewFact[];
  pushes: PushFact[];
  /** The board issue the pull request closes or names as its unit, when one is linked. */
  issue?: LinkedIssueFact;
}

/** A finished run from the history, keyed to a pull request when its label named one. */
export interface RunFact {
  agent?: string;
  startedAt: number;
  finishedAt: number;
  status: string;
  pr?: number;
}

/** Who counts as the review agent and as an agent pusher/author. */
export interface DeliveryIdentities {
  /** Logins whose reviews are verdicts — the review agent's App identity, plus config. */
  reviewers: string[];
  /** Logins that are agents beyond the `[bot]` suffix rule. */
  agentLogins: string[];
  /** Names a `Co-Authored-By:` trailer may carry for an agent-made commit (matched case-insensitively). */
  agentCoauthors: string[];
}

/** UTC calendar days, inclusive; `weeks` is how many Monday-start weeks the range spans. */
export interface DeliveryRange {
  since: string;
  until: string;
  weeks: number;
}

export interface DeliveryInput {
  repo: string;
  range: DeliveryRange;
  prs: PullRequestFacts[];
  runs?: RunFact[];
  identities?: Partial<DeliveryIdentities>;
  /** The source stopped before the range's end — the newest pull requests only. */
  truncated?: boolean;
}

// ---- report (what the view and the command render) ---------------------------------------

export interface FindingCounts {
  total: number;
  blocking: number;
  major: number;
  minor: number;
  nit: number;
  fyi: number;
  /** Findings on pull requests whose every post-verdict push was an agent's. */
  noHumanEdit: number;
  /** `noHumanEdit / total`; null with no findings. */
  noHumanEditShare: number | null;
}

export interface DeliveryIndicators {
  prsMerged: number;
  agentAuthoredPrs: number;
  leadTimeHours: { median: number | null; mean: number | null };
  firstPassCi: { passed: number; known: number; share: number | null };
  reviewRounds: { verdicts: number; fixRounds: number; reviewed: number; perPr: number | null };
  findings: FindingCounts;
  agentRuns: { count: number; minutes: number };
}

export interface PullRequestRow {
  number: number;
  title: string;
  author: string;
  agentAuthored: boolean;
  createdAt: string;
  mergedAt: string;
  /** The Monday (UTC date) of the week the pull request merged in. */
  week: string;
  issue?: LinkedIssueFact;
  leadTimeHours: number;
  /** null: no CI fact to judge (no first head, or nothing `pull_request`-triggered on it). */
  firstPassCi: boolean | null;
  reviewRounds: number;
  fixRounds: number;
  approved: boolean;
  findings: Record<FindingSeverity, number>;
  /** null: no verdict, so nothing to resolve. */
  humanEdit: boolean | null;
  agentRuns: { count: number; minutes: number };
}

export interface WeekRow extends DeliveryIndicators {
  /** The Monday (UTC date) the week starts on. */
  week: string;
  /** The Sunday (UTC date) it ends on. */
  until: string;
  prs: number[];
}

export interface UnitRow extends DeliveryIndicators {
  /** The board issue, or null for the pull requests no issue claims. */
  issue: number | null;
  title: string;
  issueCreatedAt?: string;
  prs: number[];
}

export interface DeliveryReport {
  repo: string;
  range: DeliveryRange;
  weeks: WeekRow[];
  units: UnitRow[];
  prs: PullRequestRow[];
  totals: DeliveryIndicators;
  identities: DeliveryIdentities;
  truncated: boolean;
}

// ---- the arithmetic ---------------------------------------------------------------------

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Add `n` calendar days to a UTC date (`YYYY-MM-DD`). */
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday (UTC date) of the week an instant falls in. */
export function weekStartOf(iso: string): string {
  const day = iso.slice(0, 10);
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

/** The review agent's finding lines, by severity: `- [blocking] F1 path — title`
 *  (any list marker or none; `blocker` is the same severity). Prose that
 *  repeats a finding (`**F1 (blocking)**`) is not a second finding. */
export function parseFindings(body: string): FindingSeverity[] {
  const out: FindingSeverity[] = [];
  for (const line of body.split("\n")) {
    const m = /^\s*(?:[-*•]\s*)?\[(blocking|blocker|major|minor|nit|fyi)\]/i.exec(line);
    if (!m) continue;
    const s = m[1].toLowerCase();
    out.push(s === "blocker" ? "blocking" : (s as FindingSeverity));
  }
  return out;
}

const emptyCounts = (): Record<FindingSeverity, number> => ({ blocking: 0, major: 0, minor: 0, nit: 0, fyi: 0 });

function isAgentLogin(login: string, identities: DeliveryIdentities): boolean {
  return login.endsWith("[bot]") || identities.agentLogins.includes(login);
}

/** The `Co-Authored-By:` trailer values of a commit message, as written. */
export function coauthorsOf(message: string): string[] {
  const out: string[] = [];
  for (const line of message.split("\n")) {
    const m = /^\s*co-authored-by:\s*(.+?)\s*$/i.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** A co-author is an agent when it is a bot login or carries one of the configured agent names. */
function isAgentCoauthor(who: string, identities: DeliveryIdentities): boolean {
  const lower = who.toLowerCase();
  return lower.includes("[bot]") || identities.agentCoauthors.some((n) => n !== "" && lower.includes(n.toLowerCase()));
}

/** A push is an agent's when a bot (or configured agent) login made it, or a commit it carried names an agent co-author. */
function isAgentPush(p: PushFact, identities: DeliveryIdentities): boolean {
  return isAgentLogin(p.actor, identities) || p.coauthors.some((c) => isAgentCoauthor(c, identities));
}

/** The triggers of a pull request's OWN checks. A `push`-triggered run on the
 *  branch may test an intermediate head or run other workflows, so it is not
 *  judged — a repository whose CI runs only on push reports first-pass CI as
 *  unknown, never as green. The fetcher picks the first head by the same set. */
export const CI_TRIGGERS: ReadonlySet<string> = new Set(["pull_request", "pull_request_target"]);
/** Conclusions that say something about the code; a skipped or cancelled run says nothing. */
const CI_DECISIVE: ReadonlySet<string> = new Set([
  "success",
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
]);

/** True: every decisive `pull_request` run on the first head succeeded at its
 *  first attempt. False: any red one, or any rerun. Null: nothing to judge. */
function firstPassCiOf(pr: PullRequestFacts): boolean | null {
  if (!pr.firstHeadSha) return null;
  const runs = pr.ci.filter(
    (r) =>
      r.headSha === pr.firstHeadSha &&
      CI_TRIGGERS.has(r.trigger) &&
      r.conclusion !== null &&
      CI_DECISIVE.has(r.conclusion),
  );
  if (runs.length === 0) return null;
  return runs.every((r) => r.conclusion === "success" && r.attempt <= 1);
}

const byTime = <T extends { at: string }>(a: T, b: T): number => Date.parse(a.at) - Date.parse(b.at);

function pullRequestRow(
  pr: PullRequestFacts,
  runs: readonly RunFact[],
  identities: DeliveryIdentities,
): PullRequestRow {
  const verdicts = pr.reviews
    .filter((r) => identities.reviewers.includes(r.author))
    .map((r) => ({ ...r, at: r.submittedAt }))
    .sort(byTime);
  const pushes = [...pr.pushes].sort(byTime);
  let fixRounds = 0;
  for (let i = 1; i < verdicts.length; i++) {
    const prev = Date.parse(verdicts[i - 1].at);
    const cur = Date.parse(verdicts[i].at);
    if (pushes.some((p) => Date.parse(p.at) > prev && Date.parse(p.at) <= cur)) fixRounds++;
  }
  const approved = verdicts.some((v) => v.state === "approved" || /^\s*LGTM\b/i.test(v.body));
  const findings = emptyCounts();
  for (const v of verdicts) for (const s of parseFindings(v.body)) findings[s]++;
  const firstVerdictAt = verdicts.length > 0 ? Date.parse(verdicts[0].at) : undefined;
  const humanEdit =
    firstVerdictAt === undefined
      ? null
      : pushes.some((p) => Date.parse(p.at) > firstVerdictAt && !isAgentPush(p, identities));
  const mine = runs.filter((r) => r.pr === pr.number);
  const from = pr.issue?.createdAt ?? pr.createdAt;
  return {
    number: pr.number,
    title: pr.title,
    author: pr.author,
    agentAuthored: isAgentLogin(pr.author, identities),
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    week: weekStartOf(pr.mergedAt),
    ...(pr.issue ? { issue: pr.issue } : {}),
    leadTimeHours: (Date.parse(pr.mergedAt) - Date.parse(from)) / HOUR_MS,
    firstPassCi: firstPassCiOf(pr),
    reviewRounds: verdicts.length,
    fixRounds,
    approved,
    findings,
    humanEdit,
    agentRuns: {
      count: mine.length,
      minutes: mine.reduce((s, r) => s + Math.max(0, r.finishedAt - r.startedAt), 0) / 60_000,
    },
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The indicators over a set of pull request rows — a week, a unit, the whole range. */
export function indicatorsOf(rows: readonly PullRequestRow[]): DeliveryIndicators {
  const lead = rows.map((r) => r.leadTimeHours);
  const ciKnown = rows.filter((r) => r.firstPassCi !== null);
  const ciPassed = ciKnown.filter((r) => r.firstPassCi === true);
  const reviewed = rows.filter((r) => r.reviewRounds > 0);
  const verdicts = rows.reduce((s, r) => s + r.reviewRounds, 0);
  const findings: FindingCounts = { ...emptyCounts(), total: 0, noHumanEdit: 0, noHumanEditShare: null };
  for (const r of rows) {
    let onPr = 0;
    for (const s of FINDING_SEVERITIES) {
      findings[s] += r.findings[s];
      onPr += r.findings[s];
    }
    findings.total += onPr;
    if (r.humanEdit === false) findings.noHumanEdit += onPr;
  }
  findings.noHumanEditShare = findings.total > 0 ? findings.noHumanEdit / findings.total : null;
  return {
    prsMerged: rows.length,
    agentAuthoredPrs: rows.filter((r) => r.agentAuthored).length,
    leadTimeHours: {
      median: median(lead),
      mean: lead.length > 0 ? lead.reduce((s, v) => s + v, 0) / lead.length : null,
    },
    firstPassCi: {
      passed: ciPassed.length,
      known: ciKnown.length,
      share: ciKnown.length > 0 ? ciPassed.length / ciKnown.length : null,
    },
    reviewRounds: {
      verdicts,
      fixRounds: rows.reduce((s, r) => s + r.fixRounds, 0),
      reviewed: reviewed.length,
      perPr: reviewed.length > 0 ? verdicts / reviewed.length : null,
    },
    findings,
    agentRuns: {
      count: rows.reduce((s, r) => s + r.agentRuns.count, 0),
      minutes: rows.reduce((s, r) => s + r.agentRuns.minutes, 0),
    },
  };
}

export const EMPTY_IDENTITIES: Readonly<DeliveryIdentities> = Object.freeze({
  reviewers: [],
  agentLogins: [],
  agentCoauthors: [],
});

/** Every Monday from the week of `since` to the week of `until`, in order. */
export function weeksOf(range: DeliveryRange): string[] {
  const out: string[] = [];
  const last = weekStartOf(range.until);
  for (let w = weekStartOf(range.since); w <= last; w = addDays(w, 7)) out.push(w);
  return out;
}

/** The whole report: pure, deterministic, every number derived from the facts. */
export function buildDeliveryReport(input: DeliveryInput): DeliveryReport {
  const identities: DeliveryIdentities = { ...EMPTY_IDENTITIES, ...input.identities };
  const sinceMs = Date.parse(`${input.range.since}T00:00:00Z`);
  const untilMs = Date.parse(`${input.range.until}T00:00:00Z`) + DAY_MS;
  const runs = input.runs ?? [];
  const prs = input.prs
    .filter((pr) => {
      const merged = Date.parse(pr.mergedAt);
      return merged >= sinceMs && merged < untilMs;
    })
    .sort((a, b) => a.number - b.number)
    .map((pr) => pullRequestRow(pr, runs, identities));
  const weeks: WeekRow[] = weeksOf(input.range).map((week) => {
    const rows = prs.filter((p) => p.week === week);
    return { week, until: addDays(week, 6), prs: rows.map((p) => p.number), ...indicatorsOf(rows) };
  });
  const byIssue = new Map<number | null, PullRequestRow[]>();
  for (const p of prs) {
    const key = p.issue?.number ?? null;
    byIssue.set(key, [...(byIssue.get(key) ?? []), p]);
  }
  const units: UnitRow[] = [...byIssue.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([issue, rows]) => {
      const first = rows.find((r) => r.issue !== undefined)?.issue;
      return {
        issue,
        title: issue === null ? "(no issue)" : (first?.title ?? `issue ${issue}`),
        ...(first?.createdAt ? { issueCreatedAt: first.createdAt } : {}),
        prs: rows.map((p) => p.number),
        ...indicatorsOf(rows),
      };
    });
  return {
    repo: input.repo,
    range: input.range,
    weeks,
    units,
    prs,
    totals: indicatorsOf(prs),
    identities,
    truncated: input.truncated === true,
  };
}

// ---- range ------------------------------------------------------------------------------

export const DEFAULT_WEEKS = 4;
export const MAX_WEEKS = 26;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `--weeks n` counts back from the current week's Monday (default 4, clamped
 *  1..26); `--since YYYY-MM-DD` names the first day instead. Garbage → the
 *  default; a start after today is today. The range ends today, UTC. */
export function resolveDeliveryRange(
  opts: { since?: string; weeks?: number },
  now: Date = new Date(systemClock()),
): DeliveryRange {
  const until = now.toISOString().slice(0, 10);
  const untilWeek = weekStartOf(until);
  if (opts.since !== undefined && ISO_DAY.test(opts.since) && Number.isFinite(Date.parse(`${opts.since}T00:00:00Z`))) {
    const since = opts.since > until ? until : opts.since;
    const weeks = Math.round((Date.parse(untilWeek) - Date.parse(weekStartOf(since))) / (7 * DAY_MS)) + 1;
    return { since, until, weeks };
  }
  const weeks =
    opts.weeks !== undefined && Number.isFinite(opts.weeks)
      ? Math.min(MAX_WEEKS, Math.max(1, Math.floor(opts.weeks)))
      : DEFAULT_WEEKS;
  return { since: addDays(untilWeek, -7 * (weeks - 1)), until, weeks };
}

// ---- runs (what the history adds) -------------------------------------------------------

/** The pull request a run's label names (`…/pull/42`), when it names one. */
export function pullRequestOfRun(label: string | undefined): number | undefined {
  const m = label === undefined ? null : /\/pull\/(\d+)\b/.exec(label);
  return m ? Number(m[1]) : undefined;
}

/** Finished runs of `repo` from a listing, as run facts. */
export function runFactsOf(
  rows: ReadonlyArray<{
    repo?: string;
    agent?: string;
    label?: string;
    startedAt: number;
    finishedAt?: number;
    finished: boolean;
    status?: string;
  }>,
  repo: string,
): RunFact[] {
  const out: RunFact[] = [];
  for (const r of rows) {
    if (r.repo !== repo || !r.finished || r.finishedAt === undefined) continue;
    const pr = pullRequestOfRun(r.label);
    out.push({
      ...(r.agent !== undefined ? { agent: r.agent } : {}),
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      status: r.status ?? "completed",
      ...(pr !== undefined ? { pr } : {}),
    });
  }
  return out;
}

// ---- text rendering (the command's chat and CLI shape) ----------------------------------

const pct = (share: number | null): string => (share === null ? "—" : `${Math.round(share * 100)}%`);
const hours = (h: number | null, digits = 1): string => (h === null ? "—" : `${h.toFixed(digits)} h`);

function indicatorLines(x: DeliveryIndicators): string[] {
  const f = x.findings;
  const severities = FINDING_SEVERITIES.filter((s) => f[s] > 0)
    .map((s) => `${f[s]} ${s}`)
    .join(", ");
  return [
    `issue → merge: median ${hours(x.leadTimeHours.median)} · mean ${hours(x.leadTimeHours.mean)}`,
    `first-pass CI: ${x.firstPassCi.passed}/${x.firstPassCi.known} (${pct(x.firstPassCi.share)})`,
    `review rounds: ${x.reviewRounds.perPr === null ? "—" : `${x.reviewRounds.perPr.toFixed(2)} per PR`} (${x.reviewRounds.verdicts} verdicts, ${x.reviewRounds.fixRounds} fix rounds)`,
    `findings: ${f.total}${severities ? ` (${severities})` : ""} · ${pct(f.noHumanEditShare)} resolved with no human edit`,
    `agent runs: ${x.agentRuns.count} · ${x.agentRuns.minutes.toFixed(1)} min`,
  ];
}

/** One block per week, then the units — single-spaced lines, so chat carries them as they are. */
export function renderDeliveryReport(report: DeliveryReport): string {
  const lines: string[] = [
    `${report.repo} · ${report.range.since} → ${report.range.until} · ${report.range.weeks} week${report.range.weeks === 1 ? "" : "s"}`,
  ];
  if (report.truncated) lines.push("(the newest pull requests only — the fetch stopped before the range's start)");
  for (const w of report.weeks) {
    if (w.prsMerged === 0) {
      lines.push("", `Week of ${w.week}: nothing merged`);
      continue;
    }
    lines.push(
      "",
      `Week of ${w.week}: ${w.prsMerged} merged (${w.agentAuthoredPrs} agent-authored)`,
      ...indicatorLines(w),
    );
  }
  if (report.weeks.length > 1 && report.totals.prsMerged > 0) {
    lines.push(
      "",
      `Range: ${report.totals.prsMerged} merged (${report.totals.agentAuthoredPrs} agent-authored)`,
      ...indicatorLines(report.totals),
    );
  }
  if (report.units.length > 0) {
    lines.push("", "Units:");
    for (const u of report.units) {
      const prs = `${u.prs.length === 1 ? "PR" : "PRs"} ${u.prs.join(", ")}`;
      const who = u.issue === null ? "(no issue)" : `${u.issue} ${u.title}`;
      const facts = [
        hours(u.leadTimeHours.median),
        `${u.reviewRounds.verdicts} round${u.reviewRounds.verdicts === 1 ? "" : "s"}`,
        ...(u.findings.blocking > 0 ? [`${u.findings.blocking} blocking`] : []),
      ];
      lines.push(`• ${who} — ${prs} · ${facts.join(" · ")}`);
    }
  }
  return lines.join("\n");
}

// ---- config -----------------------------------------------------------------------------

export interface DeliveryConfig {
  /** `owner/name` repositories the page serves; the first is the default. */
  repos: string[];
  /** Logins whose reviews are verdicts, beside the process's own App identity. */
  reviewers: string[];
  /** Logins that are agents beyond the `[bot]` suffix. */
  agentLogins: string[];
  /** Co-author names an agent-made commit carries. */
  agentCoauthors: string[];
}

/** `owner/name`: two path segments of word characters, dots and dashes, neither of them dots alone. */
const REPO_SLUG = /^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/;

function stringList(raw: unknown, what: string, valid: (s: string) => boolean = () => true): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((s) => typeof s === "string" && s !== "" && valid(s)))
    throw new Error(`${what} must be a list of ${what.endsWith("repos") ? "owner/name repositories" : "names"}`);
  return raw as string[];
}

/** Validates the `delivery:` config block. Absent → undefined (no default repository). */
export function parseDeliveryConfig(raw: unknown): DeliveryConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("delivery: must be a mapping");
  const r = raw as Record<string, unknown>;
  return {
    repos: stringList(r.repos, "delivery.repos", (s) => REPO_SLUG.test(s)),
    reviewers: stringList(r.reviewers, "delivery.reviewers"),
    agentLogins: stringList(r.agentLogins, "delivery.agentLogins"),
    agentCoauthors: stringList(r.agentCoauthors, "delivery.agentCoauthors"),
  };
}

// ---- source and service seams -----------------------------------------------------------

export interface DeliveryFetch {
  prs: PullRequestFacts[];
  /** The source stopped before the range's start (a page cap); the newest are in. */
  truncated: boolean;
}

/** Where the pull requests' facts come from: GitHub in production, memory in tests. */
export interface DeliverySource {
  fetchPullRequests(repo: string, range: DeliveryRange): Promise<DeliveryFetch>;
}

/** The second implementation (AGENTS.md invariant 2) and the test double: a map of repo → facts. */
export class InMemoryDeliverySource implements DeliverySource {
  readonly calls: Array<{ repo: string; range: DeliveryRange }> = [];
  constructor(private readonly byRepo: Readonly<Record<string, PullRequestFacts[]>> = {}) {}
  fetchPullRequests(repo: string, range: DeliveryRange): Promise<DeliveryFetch> {
    this.calls.push({ repo, range });
    return Promise.resolve({ prs: this.byRepo[repo] ?? [], truncated: false });
  }
}

export interface DeliveryReportOptions {
  since?: string;
  weeks?: number;
  /** The caller's finished runs of the repository over the resolved range — what the history adds. */
  runs?: (range: DeliveryRange) => Promise<RunFact[]>;
}

export interface DeliveryService {
  /** Why no report can be made at all (no GitHub credential), or undefined when one can. */
  unavailable(): string | undefined;
  /** The configured repositories; the first is the page's default. */
  repos(): string[];
  /** Live read for one repository over the resolved range; throws on upstream failure. */
  report(repo: string, opts: DeliveryReportOptions): Promise<DeliveryReport>;
}

/** Why there is no delivery page: the process has no GitHub credential. */
export const DELIVERY_OFF_MESSAGE =
  "Delivery indicators aren't available — this process has no GitHub credential (the GitHub App triple or GH_TOKEN); set one, then name repositories under delivery.repos.";

/** The service of a process without GitHub (a Null Object, routing-and-config item 16). */
export class NullDeliveryService implements DeliveryService {
  unavailable(): string {
    return DELIVERY_OFF_MESSAGE;
  }
  repos(): string[] {
    return [];
  }
  report(_repo: string, _opts: DeliveryReportOptions): Promise<DeliveryReport> {
    return Promise.reject(new Error(DELIVERY_OFF_MESSAGE));
  }
}

export interface DeliveryServiceOptions {
  /** The process's identities to merge under the config's — the App login the review agent posts as. */
  identities?: () => Promise<Partial<DeliveryIdentities>>;
  now?: () => Date;
}

export function createDeliveryService(
  cfg: DeliveryConfig | undefined,
  source: DeliverySource,
  opts: DeliveryServiceOptions = {},
): DeliveryService {
  const now = opts.now ?? (() => new Date(systemClock()));
  return {
    unavailable: () => undefined,
    repos: () => [...(cfg?.repos ?? [])],
    async report(repo, o) {
      if (!REPO_SLUG.test(repo)) throw new Error(`repository must be owner/name, got ${JSON.stringify(repo)}`);
      const range = resolveDeliveryRange({ since: o.since, weeks: o.weeks }, now());
      const [fetched, process, runs] = await Promise.all([
        source.fetchPullRequests(repo, range),
        opts.identities?.() ?? Promise.resolve<Partial<DeliveryIdentities>>({}),
        o.runs?.(range) ?? Promise.resolve<RunFact[]>([]),
      ]);
      const identities: DeliveryIdentities = {
        reviewers: [...new Set([...(cfg?.reviewers ?? []), ...(process.reviewers ?? [])])],
        agentLogins: [...new Set([...(cfg?.agentLogins ?? []), ...(process.agentLogins ?? [])])],
        agentCoauthors: [...new Set([...(cfg?.agentCoauthors ?? []), ...(process.agentCoauthors ?? [])])],
      };
      return buildDeliveryReport({
        repo,
        range,
        prs: fetched.prs,
        runs,
        identities,
        truncated: fetched.truncated,
      });
    },
  };
}
