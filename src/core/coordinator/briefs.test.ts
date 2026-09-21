import { describe, expect, it } from "vitest";
import { GUARDS, parsePlanUnit, PLAN_MAX_CHARS, renderContract } from "../ship/contract.js";
import type { Brief } from "../ship/coordinator.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { composeChild, contractFor, type BriefReaders, type ChildRunFacts } from "./briefs.js";

// Feature: docs/reference/specs/http-ingress.md item 9 — a coordinator's spawn
// names a brief in ids and the bot composes the child's turn: the unit's
// contract from the plan at the base ref for round 0, the review turn with the
// prior round's findings and the coding run's dispositions, the findings step's
// message from the review run's record: what a round of the ship pipeline is
// told, from what the bot holds. No brief composes a `fix` child (agent-ship
// item 7): the findings are a message into the unit thread, whose coding
// session continues.

const PLAN = `# Fixture program - Plan

## Implementation Units

### U10. Warm the cache on wake

- **Goal**: A wake never starts cold.
- **Dependencies**: none.
- **Files**: \`src/execution/wake.ts\`; \`docs/reference/specs/resident-repos.md\` item 3.
- **Test scenarios**:
  - a cold wake restores from the archive.

### U11. Retire the alarm

- **Goal**: No lifecycle timer exists.
- **Dependencies**: U10.
`;
const SPEC = `# Resident repos

## Behavior

1. **One.** Text one.
3. **Three.** The wake restores.

## Validation criteria

| Criterion | Proof |
|---|---|
| 3: a cold wake restores | \`[unit]\` \`src/execution/wake.test.ts::restores\` |
`;

const instance: CoordinatorInstance = {
  id: "plan-fixture",
  kind: "ship",
  userId: "slack:UALICE",
  channelId: "slack:C1",
  threadKey: "slack:C1:1.0",
  repo: "acme/api",
  branch: "plan/fixture/u10-warm-the-cache-on-wake",
  base: "main",
  createdAt: 1_000,
  plan: { id: "fixture", path: "docs/plans/fixture.md" },
};
const unit: CoordinatorUnit = {
  instanceId: instance.id,
  unit: "U10",
  slug: "u10-warm-the-cache-on-wake",
  title: "Warm the cache on wake",
  branch: instance.branch,
  dependsOn: [],
  issue: 42,
  rounds: [],
};
const FINDING = { id: "F1", severity: "minor" as const, file: "src/a.ts", line: 3, title: "off by one" };

function readers(
  over: Partial<BriefReaders> & { runs?: Record<string, ChildRunFacts>; files?: Record<string, string> } = {},
) {
  const files: Record<string, string> = {
    "docs/plans/fixture.md": PLAN,
    "docs/reference/specs/resident-repos.md": SPEC,
    "AGENTS.md": "# Rules\n\nBe kind.",
    ...over.files,
  };
  const reads: string[] = [];
  const r: BriefReaders = {
    readRepoFile: async (path) => {
      reads.push(path);
      return files[path] === undefined ? undefined : { content: files[path], truncated: false };
    },
    readRunFacts: async (runId) => over.runs?.[runId],
    readShipRequest: async () => "agent:ship in acme/api: fix the login redirect",
    ...over,
  };
  return { r, reads };
}

describe("contractFor — the unit's contract from the repository at the base ref", () => {
  it("a plan unit: the plan, exactly the specs the unit names and the rules file are read at the base; the contract carries the unit, the resolved rows, the rules, the rebase onto the base and the board issue", async () => {
    const { r, reads } = readers();
    const contract = await contractFor(instance, unit, r);
    expect(reads).toEqual(["docs/plans/fixture.md", "docs/reference/specs/resident-repos.md", "AGENTS.md"]);
    expect(contract.unit.id).toBe("U10");
    expect(contract.specRows).toEqual([
      {
        spec: "resident-repos.md",
        item: 3,
        specRead: true,
        text: "3. **Three.** The wake restores.",
        validation: [
          { criterion: "3: a cold wake restores", proof: "`[unit]` `src/execution/wake.test.ts::restores`" },
        ],
      },
    ]);
    expect(contract.agentRules).toEqual({ file: "AGENTS.md", text: "# Rules\n\nBe kind." });
    expect(contract.rebase).toEqual({ branch: instance.branch, onto: "main" });
    expect(contract.issue).toEqual({ repo: "acme/api", number: 42 });
    expect(contract.guards).toBe(GUARDS);
  });

  it("CLAUDE.md is read when AGENTS.md is not there; neither leaves the rules absent; an unreadable plan throws naming it", async () => {
    /** Readers over the given files alone. */
    const over = (files: Record<string, string>): BriefReaders => ({
      readRepoFile: async (path) =>
        files[path] === undefined ? undefined : { content: files[path], truncated: false },
      readRunFacts: async () => undefined,
      readShipRequest: async () => undefined,
    });
    const specs = { "docs/plans/fixture.md": PLAN, "docs/reference/specs/resident-repos.md": SPEC };
    const withClaude = await contractFor(instance, unit, over({ ...specs, "CLAUDE.md": "# Claude rules" }));
    expect(withClaude.agentRules).toEqual({ file: "CLAUDE.md", text: "# Claude rules" });
    const none = await contractFor(instance, unit, over(specs));
    expect(none.agentRules).toBeUndefined();
    await expect(contractFor(instance, unit, over({}))).rejects.toThrow(
      /docs\/plans\/fixture\.md is not readable at main in acme\/api/,
    );
  });

  it("the plan is asked for whole, up to PLAN_MAX_CHARS, and a plan the read still cut is refused by name — a unit briefed from a clipped plan would be briefed short", async () => {
    const asked: Array<{ path: string; maxChars?: number }> = [];
    const cut: BriefReaders = {
      readRepoFile: async (path, opts) => {
        asked.push({ path, ...(opts?.maxChars !== undefined ? { maxChars: opts.maxChars } : {}) });
        if (path === "docs/plans/fixture.md") return { content: PLAN.slice(0, 40), truncated: true };
        return undefined;
      },
      readRunFacts: async () => undefined,
      readShipRequest: async () => undefined,
    };
    await expect(contractFor(instance, unit, cut)).rejects.toThrow(
      /docs\/plans\/fixture\.md is longer than 2,000,000 characters at main in acme\/api; a unit read from a cut plan could be briefed short, so none is/,
    );
    expect(asked).toEqual([{ path: "docs/plans/fixture.md", maxChars: PLAN_MAX_CHARS }]);
  });

  it("a generated instance (a `plan` with no `path`): the section is the request text read from the ship run's record with the directive and the repository stripped, no spec rows and every guard — no `agent:ship` turn in the thread needed; an unreadable record falls back to naming the thread", async () => {
    const genUnit: CoordinatorUnit = {
      ...unit,
      unit: "U1",
      slug: "u1",
      branch: "plan/fix-the-login-abc123/u1",
    };
    const genInstance: CoordinatorInstance = {
      ...instance,
      plan: { id: "fix-the-login-abc123" },
      branch: genUnit.branch,
      runId: "run-ship",
    };
    const { r, reads } = readers();
    const contract = await contractFor(genInstance, genUnit, r);
    // The request text comes from the run record's reader, never a thread scan;
    // the rules file is still read at the base ref.
    expect(reads).toEqual(["AGENTS.md"]);
    expect(contract.unit).toMatchObject({ id: "U1", title: "fix the login redirect" });
    expect(contract.unit.section).toBe("### U1. fix the login redirect\n\nfix the login redirect");
    expect(contract.specRows).toEqual([]);
    expect(contract.guards).toBe(GUARDS);
    expect(contract.rebase).toEqual({ branch: genUnit.branch, onto: "main" });
    const blind = await contractFor(genInstance, genUnit, { ...r, readShipRequest: async () => undefined });
    expect(blind.unit.section).toContain("Implement the task this thread's ship request describes.");
    // A request that reads as a markdown heading (shipUnitText leaves the text
    // on one line, so a leading `##` is the case) is the request's own text:
    // the unit is built, never parsed back, so the section keeps it whole where
    // the plan parser would end the section at that line.
    const headed = await contractFor(genInstance, genUnit, {
      ...r,
      readShipRequest: async () => "agent:ship in acme/api: ## Acceptance: the redirect lands on /home",
    });
    expect(headed.unit.title).toBe("## Acceptance: the redirect lands on /home");
    expect(headed.unit.section).toBe(
      `### ${genUnit.unit}. ## Acceptance: the redirect lands on /home\n\n## Acceptance: the redirect lands on /home`,
    );
    expect(parsePlanUnit(headed.unit.section, genUnit.unit)!.section).not.toContain("\n\n## Acceptance");
    expect(headed.specRows).toEqual([]);
    // The request's urls reach the child: a Slack `<url|label>` link is the bare
    // url in the section, never the label Slack elides, never stripped — the
    // entry probe's text (shipTaskText) is not the unit's.
    const linked = await contractFor(genInstance, genUnit, {
      ...r,
      readShipRequest: async () =>
        "agent:ship in acme/api: point the redirect at <https://calendar.acme.test/TrrMBAg7|calendar.acme.test/…> (the booking page)",
    });
    expect(linked.unit.section).toBe(
      `### ${genUnit.unit}. point the redirect at https://calendar.acme.test/TrrMBAg7 (the booking page)\n\npoint the redirect at https://calendar.acme.test/TrrMBAg7 (the booking page)`,
    );
  });

  it("a resume's section names the pull request, not the request text", async () => {
    const resumeUnit: CoordinatorUnit = {
      ...unit,
      unit: "U1",
      slug: "u1",
      branch: "feat/wake-cache",
      resume: { pr: 7, url: "https://github.com/acme/api/pull/7" },
    };
    const genInstance: CoordinatorInstance = { ...instance, plan: { id: "x-abc123" }, branch: resumeUnit.branch };
    const { r } = readers();
    const contract = await contractFor(genInstance, resumeUnit, r);
    expect(contract.unit.section).toContain("Resume the review loop of https://github.com/acme/api/pull/7");
    expect(contract.unit.section).not.toContain("fix the login redirect");
  });
});

describe("composeChild — the child a brief names", () => {
  it("a contract brief is a coding child on the unit's branch whose prompt names the unit and whose contract is the unit's; a task unit's prompt is the task itself", async () => {
    const { r } = readers();
    const child = await composeChild(
      { kind: "contract", unit: "U10", rebase: { branch: unit.branch, onto: "main" } },
      instance,
      unit,
      r,
    );
    expect(child.preset).toBe("coding");
    expect(child.ref).toBe(unit.branch);
    expect(child.prompt).toContain("Implement unit U10 — Warm the cache on wake — of docs/plans/fixture.md");
    expect(child.contract?.unit.id).toBe("U10");
    expect(renderContract(child.contract!, {}).text).toContain("### Unit U10 — Warm the cache on wake");

    // A generated unit's prompt is the request text itself — keyed on the
    // instance's mark (`plan` without a `path`), not on a unit name.
    const genUnit: CoordinatorUnit = { ...unit, unit: "U1", slug: "u1", branch: "plan/fix-abc123/u1" };
    const task = await composeChild(
      { kind: "contract", unit: "U1", rebase: { branch: genUnit.branch, onto: "main" } },
      { ...instance, plan: { id: "fix-abc123" } },
      genUnit,
      r,
    );
    expect(task.prompt).toBe("fix the login redirect");
    expect(task.contract?.unit.id).toBe("U1");
    // The prompt keeps the request's urls, a Slack-labelled link as its bare url.
    const linked = await composeChild(
      { kind: "contract", unit: genUnit.unit, rebase: { branch: genUnit.branch, onto: "main" } },
      { ...instance, plan: { id: "fix-abc123" } },
      genUnit,
      {
        ...r,
        readShipRequest: async () =>
          "agent:ship in acme/api: point the redirect at <https://calendar.acme.test/TrrMBAg7|calendar.acme.test/…>",
      },
    );
    expect(linked.prompt).toBe("point the redirect at https://calendar.acme.test/TrrMBAg7");
  });

  it("a contract brief with a continuation prefaces the unit's request with the segment, the branch and sha to continue from, and the previous run's write-up and handoff — the contract itself unchanged (decision 0046)", async () => {
    const { r } = readers({
      runs: {
        "run-c0": {
          finalReply: "Budget reached: the parser is pushed, the tests are next.",
          handoff: {
            deviations: [{ from: "one parser", to: "two", why: "the grammar forked" }],
            followUps: [{ what: "tests", where: "src/parser.test.ts" }],
            unproven: [{ criterion: "round-trip", why: "no fixture yet" }],
          },
        },
      },
    });
    const child = await composeChild(
      {
        kind: "contract",
        unit: "U10",
        rebase: { branch: unit.branch, onto: "main" },
        continue: {
          segment: 2,
          from: "a".repeat(40),
          previousRunId: "run-c0",
          texts: ["Ada: please keep the parser API", "Lin: and preserve the old fixture"],
        },
      },
      instance,
      unit,
      r,
    );
    expect(child.prompt).toContain(
      `Segment 2 of this unit: the previous segment ended at its lease with the unit unfinished. Continue from \`${unit.branch}\` at \`aaaaaaa\` as it stands`,
    );
    expect(child.prompt).toContain(
      "The previous segment's write-up:\nBudget reached: the parser is pushed, the tests are next.",
    );
    expect(child.prompt).toContain("follow-ups still open:\n- tests (src/parser.test.ts)");
    expect(child.prompt).toContain("Deviations it recorded:\n- one parser → two: the grammar forked");
    expect(child.prompt).toContain("Unproven:\n- round-trip: no fixture yet");
    expect(child.prompt).toContain(
      "The replies that woke this segment, in arrival order:\nAda: please keep the parser API\n\nLin: and preserve the old fixture",
    );
    expect(child.prompt.indexOf("follow-ups still open")).toBeLessThan(child.prompt.indexOf("Ada: please"));
    expect(child.prompt).toContain("Implement unit U10 — Warm the cache on wake — of docs/plans/fixture.md");
    expect(child.prompt.indexOf("Segment 2")).toBeLessThan(child.prompt.indexOf("Implement unit U10"));
    expect(child.contract?.unit.id).toBe("U10");

    // No previous run in the history: the preface still names the segment and the branch, and nothing is invented.
    const bare = await composeChild(
      { kind: "contract", unit: "U10", rebase: { branch: unit.branch, onto: "main" }, continue: { segment: 3 } },
      instance,
      unit,
      r,
    );
    expect(bare.prompt).toContain(
      `Segment 3 of this unit: the previous segment ended at its lease with the unit unfinished. Continue from \`${unit.branch}\` as it stands`,
    );
    expect(bare.prompt).not.toContain("write-up");
    expect(bare.prompt).not.toContain("replies that woke");
  });

  it("a review brief is a review child on the pull request: round one's turn names the head; a re-review carries the prior review run's findings and the coding run's dispositions from their records, matched to the review's ids with an id it never issued dropped and noted, and the same contract", async () => {
    const { r } = readers({
      runs: {
        "run-r1": { findings: [FINDING], finalReply: "Changes requested: one nit." },
        "run-f1": {
          dispositions: [
            { findingId: "F1", disposition: "declined", note: "the loop is exclusive" },
            { findingId: "F9", disposition: "fixed", note: "no such finding" },
          ],
        },
      },
    });
    const first = await composeChild(
      { kind: "review", unit: "U10", pr: 7, headSha: "a".repeat(40), round: 1 },
      instance,
      unit,
      r,
    );
    expect(first.preset).toBe("review");
    expect(first.ref).toBeUndefined();
    // The instance's severity to address rides as the child's directive
    // (agent-review item 5a): the default when the instance carries none.
    expect(first.prompt.startsWith("https://github.com/acme/api/pull/7 severity:minor\n\n")).toBe(true);
    expect(first.prompt).toContain(`Review pull request acme/api#7 at head \`${"a".repeat(40)}\``);
    expect(first.contract?.unit.id).toBe("U10");
    const held = await composeChild(
      { kind: "review", unit: "U10", pr: 7, headSha: "a".repeat(40), round: 1 },
      { ...instance, addressSeverity: "major", addressSeveritySource: "user" },
      unit,
      r,
    );
    expect(held.prompt.startsWith("https://github.com/acme/api/pull/7 severity:major\n\n")).toBe(true);
    const second = await composeChild(
      {
        kind: "review",
        unit: "U10",
        pr: 7,
        headSha: "b".repeat(40),
        round: 2,
        prior: { reviewRunId: "run-r1", codingRunId: "run-f1" },
      },
      instance,
      unit,
      r,
    );
    expect(second.prompt).toContain("Re-review pull request acme/api#7");
    expect(second.prompt).toContain("[minor] F1 src/a.ts:3 — off by one");
    expect(second.prompt).toContain("F1: declined — the loop is exclusive");
    expect(second.prompt).not.toContain("F9: fixed");
    expect(second.prompt).toContain("Dispositions naming no finding of the previous round (dropped): F9");
  });

  it("a findings brief is the review's findings as a message into the unit thread: a coding child on the unit's branch whose text carries every finding verbatim, the review's final words and the ask (a disposition per finding, the description resubmitted, the branch pushed, never a merge or an approve), with no contract and no finding-id tag; a review run the history lacks throws by name; no `fix` brief composes", async () => {
    const { r } = readers({ runs: { "run-r1": { findings: [FINDING], finalReply: "Changes requested: one nit." } } });
    const findings = await composeChild(
      { kind: "findings", unit: "U10", pr: 7, reviewRunId: "run-r1" },
      instance,
      unit,
      r,
    );
    expect(findings.preset).toBe("coding");
    expect(findings.ref).toBe(unit.branch);
    expect(findings.prompt).toContain("The review of acme/api#7 requested changes.");
    expect(findings.prompt).toContain("[minor] F1 src/a.ts:3 — off by one");
    expect(findings.prompt).toContain("submit_dispositions");
    expect(findings.prompt).toContain("submit_pr_description");
    expect(findings.prompt).toContain("Never merge and never approve.");
    expect(findings.prompt.endsWith("Review:\nChanges requested: one nit.")).toBe(true);
    expect(findings.contract).toBeUndefined();
    expect(Object.keys(findings).sort()).toEqual(["preset", "prompt", "ref"]);
    // A review that listed no structured findings is addressed by its prose, said so.
    const prose = readers({ runs: { "run-r1": { findings: [], finalReply: "Please tighten the tests." } } });
    const byProse = await composeChild(
      { kind: "findings", unit: "U10", pr: 7, reviewRunId: "run-r1" },
      instance,
      unit,
      prose.r,
    );
    expect(byProse.prompt).toContain("Findings:\n(the review listed no structured findings, address its prose)");
    await expect(
      composeChild({ kind: "findings", unit: "U10", pr: 7, reviewRunId: "run-gone" }, instance, unit, r),
    ).rejects.toThrow(/run run-gone is not in the run history/);
    await expect(
      composeChild({ kind: "fix", unit: "U10", pr: 7, reviewRunId: "run-r1" } as unknown as Brief, instance, unit, r),
    ).rejects.toThrow(/brief kind/);
  });
});
