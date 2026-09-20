import { describe, expect, it } from "vitest";
import {
  filePlaneFinding,
  findingResearchRequest,
  mergePlaneFindings,
  PLANE_FINDING_LABEL,
  PLANE_FINDING_TIMELINE_CAP,
  planeFindingIssueTitle,
  planeFindingKey,
  type PlaneFinding,
  type PlaneIssueRef,
  type PlaneIssueTracker,
} from "./findings.js";

// Feature: docs/decisions/0064 "Endings and the watches": a finding is filed
// when no move applies — carried
// with the watch and the timeline, deduplicated by watch and subject, filed by
// a research-tier run through the path `friction propose` uses.

const finding = (over: Partial<PlaneFinding> = {}): PlaneFinding => ({
  watch: "orphaned_child",
  subject: "run-a",
  timeline: [{ at: 1_000, what: "the run sealed with a pushed branch and no pull request" }],
  firstAt: 1_000,
  lastAt: 1_000,
  ...over,
});

describe("mergePlaneFindings — two findings on one subject are one (record 0064)", () => {
  it("a new watch#subject pair appends; the same pair merges the timelines in time order and widens first/last", () => {
    const first = mergePlaneFindings([], finding());
    expect(first).toHaveLength(1);
    const second = mergePlaneFindings(
      first,
      finding({ timeline: [{ at: 3_000, what: "still no pull request" }], firstAt: 3_000, lastAt: 3_000 }),
    );
    expect(second).toHaveLength(1);
    expect(second[0]!.timeline.map((e) => e.at)).toEqual([1_000, 3_000]);
    expect(second[0]!.firstAt).toBe(1_000);
    expect(second[0]!.lastAt).toBe(3_000);
    // A different subject is a different finding.
    const third = mergePlaneFindings(second, finding({ subject: "run-b" }));
    expect(third).toHaveLength(2);
    expect(planeFindingKey(third[1]!)).toBe("orphaned_child#run-b");
  });

  it("a timeline is bounded: past the cap the newest events are kept", () => {
    const long = finding({
      timeline: Array.from({ length: PLANE_FINDING_TIMELINE_CAP + 10 }, (_, i) => ({ at: i, what: `e${i}` })),
    });
    const merged = mergePlaneFindings([finding()], long);
    expect(merged[0]!.timeline).toHaveLength(PLANE_FINDING_TIMELINE_CAP);
    // The newest events stand: the oldest of the 61 merged events are dropped.
    expect(merged[0]!.timeline[0]!.what).toBe("e11");
    expect(merged[0]!.timeline.at(-1)!.at).toBe(1_000);
  });
});

describe("the research dispatch and the filing path (record 0064)", () => {
  it("the research request names the watch and subject in the bot's words and fences the timeline as untrusted data", () => {
    const text = findingResearchRequest(finding());
    expect(text).toContain("`orphaned_child` watch fired for `run-a`");
    expect(text).toContain("<<<UNTRUSTED");
    expect(text).toContain("UNTRUSTED>>>");
    expect(text).toContain("the run sealed with a pushed branch and no pull request");
  });

  it("filePlaneFinding files through the tracker seam under the plane's label; an open issue with the finding's title is a duplicate, filed once", async () => {
    const created: Array<{ repo: string; title: string; body: string; labels: string[] }> = [];
    let open: PlaneIssueRef[] = [];
    const tracker: PlaneIssueTracker = {
      listOpen: (_repo, label) => {
        expect(label).toBe(PLANE_FINDING_LABEL);
        return Promise.resolve(open);
      },
      create: (repo, issue) => {
        created.push({ repo, ...issue });
        const ref = { number: 41, url: "https://github.com/acme/api/issues/41", title: issue.title, body: issue.body };
        open = [...open, ref];
        return Promise.resolve(ref);
      },
    };
    const f = finding();
    const filed = await filePlaneFinding(f, "the report", { tracker, repo: "acme/api" });
    expect(filed.kind).toBe("filed");
    expect(created).toHaveLength(1);
    expect(created[0]!.title).toBe(planeFindingIssueTitle(f));
    expect(created[0]!.body).toContain("the report");
    expect(created[0]!.body).toContain("## Timeline");
    expect(created[0]!.labels).toEqual([PLANE_FINDING_LABEL]);
    const again = await filePlaneFinding(f, "the report, again", { tracker, repo: "acme/api" });
    expect(again.kind).toBe("duplicate");
    expect(created).toHaveLength(1);
  });
});
