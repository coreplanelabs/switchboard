// The plane's findings (docs/decisions/0064, "Endings and the watches"): a
// finding is filed when no move applies
// — it carries the watch's name and the timeline of events that fired it, and
// two findings on one watch and subject are ONE, their timelines merged. The
// plane itself calls no model: the bot dispatches a research-tier run over the
// timeline inside the untrusted fence (`findingResearchRequest`) and files the
// answer through the path `friction propose` uses (`filePlaneFinding`, the
// same `IssueTracker` seam). The dedupe half is node-free, like `decide.ts`.

import { wrapUntrusted } from "../untrusted.js";

/** The tracker seam, structurally the `IssueTracker` of
 *  `src/execution/githubIssues.ts` (the friction proposer's) — declared here
 *  so this module stays node-free like `decide.ts` and imports nothing the
 *  Worker's build cannot carry. */
export interface PlaneIssueRef {
  number: number;
  url: string;
  title: string;
  body: string;
}

export interface PlaneIssueTracker {
  listOpen(repo: string, label: string): Promise<PlaneIssueRef[]>;
  create(repo: string, issue: { title: string; body: string; labels: string[] }): Promise<PlaneIssueRef>;
}

/** One event on a finding's timeline: when, and what the watch saw — words
 *  the bot recorded, never a model's. */
export interface PlaneFindingEvent {
  at: number;
  what: string;
}

/** A finding: the watch, its subject (the run, pull request or instance the
 *  watch fired about) and the timeline. Deduplicated by watch and subject —
 *  `planeFindingKey` — so the same incident observed twice is one finding. */
export interface PlaneFinding {
  watch: string;
  subject: string;
  timeline: PlaneFindingEvent[];
  firstAt: number;
  lastAt: number;
}

export function planeFindingKey(f: Pick<PlaneFinding, "watch" | "subject">): string {
  return `${f.watch}#${f.subject}`;
}

/** A timeline is bounded: a watch that fires forever grows one finding, not
 *  unbounded storage — the newest events are kept. */
export const PLANE_FINDING_TIMELINE_CAP = 50;

/** Fold one observation into the set: a finding already standing for the same
 *  watch and subject absorbs the timeline (two findings on one subject are
 *  one); a new pair appends. Pure — the object commits the returned set. */
export function mergePlaneFindings(existing: readonly PlaneFinding[], incoming: PlaneFinding): PlaneFinding[] {
  const key = planeFindingKey(incoming);
  const standing = existing.find((f) => planeFindingKey(f) === key);
  if (!standing) return [...existing, { ...incoming, timeline: incoming.timeline.slice(-PLANE_FINDING_TIMELINE_CAP) }];
  const timeline = [...standing.timeline, ...incoming.timeline]
    .sort((a, b) => a.at - b.at)
    .slice(-PLANE_FINDING_TIMELINE_CAP);
  const merged: PlaneFinding = {
    ...standing,
    timeline,
    firstAt: Math.min(standing.firstAt, incoming.firstAt),
    lastAt: Math.max(standing.lastAt, incoming.lastAt),
  };
  return existing.map((f) => (planeFindingKey(f) === key ? merged : f));
}

/** The request text for the research-tier run the bot dispatches over a
 *  finding (record 0064): the watch and subject are the bot's own words; the
 *  timeline — recorded run output, GitHub words, whatever the watch saw — is
 *  data inside the untrusted fence, never instructions. */
export function findingResearchRequest(finding: PlaneFinding): string {
  const timeline = finding.timeline.map((e) => `${new Date(e.at).toISOString()} — ${e.what}`).join("\n");
  return [
    `The orchestration plane's \`${finding.watch}\` watch fired for \`${finding.subject}\` and no mechanical move applied.`,
    `Investigate the timeline below and write up what happened, why the watch fired, and what change would prevent it — a report to file as an issue, nothing executed.`,
    wrapUntrusted(timeline),
  ].join("\n\n");
}

/** The issue title a finding files under — also the dedupe key on the tracker:
 *  an open issue with this exact title is the same finding, not filed twice. */
export function planeFindingIssueTitle(finding: Pick<PlaneFinding, "watch" | "subject">): string {
  return `plane finding: ${finding.watch} — ${finding.subject}`;
}

export const PLANE_FINDING_LABEL = "switchboard-plane";

export type FiledPlaneFinding = { kind: "filed"; issue: PlaneIssueRef } | { kind: "duplicate"; issue: PlaneIssueRef };

/** File one finding's write-up through the path `friction propose` uses — the
 *  `IssueTracker` seam over the repository's open issues: an open issue with
 *  the finding's title is a duplicate (the tracker-side half of the dedupe),
 *  else the report is created under the plane's label. The body is the
 *  research run's answer with the timeline appended as data. */
export async function filePlaneFinding(
  finding: PlaneFinding,
  report: string,
  opts: { tracker: PlaneIssueTracker; repo: string; label?: string },
): Promise<FiledPlaneFinding> {
  const label = opts.label ?? PLANE_FINDING_LABEL;
  const title = planeFindingIssueTitle(finding);
  const open = await opts.tracker.listOpen(opts.repo, label);
  const existing = open.find((i) => i.title === title);
  if (existing) return { kind: "duplicate", issue: existing };
  const timeline = finding.timeline.map((e) => `- ${new Date(e.at).toISOString()} — ${e.what}`).join("\n");
  return {
    kind: "filed",
    issue: await opts.tracker.create(opts.repo, {
      title,
      body: `${report}\n\n## Timeline\n\n${timeline}`,
      labels: [label],
    }),
  };
}
