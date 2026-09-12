import { describe, expect, it } from "vitest";
import { GUARDS, renderContract } from "../ship/contract.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { composeChild, contractFor, TASK_UNIT, type BriefReaders, type ChildRunFacts } from "./briefs.js";

// Feature: docs/reference/specs/http-ingress.md item 9 — a coordinator's spawn
// names a brief in ids and the bot composes the child's turn: the unit's
// contract from the plan at the base ref for round 0, the review turn with the
// prior round's findings and dispositions, the fix turn with the findings —
// what the in-process pipeline's rounds are told, from what the bot holds.

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
      return files[path];
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
      readRepoFile: async (path) => files[path],
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

  it("a task-string unit: the task is the ship request's text with the directive and the repository stripped, as a plan of one unit; an unreadable request falls back to naming the thread", async () => {
    const taskUnit: CoordinatorUnit = {
      ...unit,
      unit: TASK_UNIT,
      slug: TASK_UNIT,
      branch: "ship/fix-the-login-abc123",
    };
    const taskInstance: CoordinatorInstance = { ...instance, plan: undefined, branch: taskUnit.branch };
    const { r, reads } = readers();
    const contract = await contractFor(taskInstance, taskUnit, r);
    expect(reads).toEqual([]);
    expect(contract.unit).toEqual({
      id: TASK_UNIT,
      title: "fix the login redirect",
      section: "fix the login redirect",
      bullets: {},
    });
    expect(contract.specRows).toEqual([]);
    expect(contract.rebase).toEqual({ branch: taskUnit.branch, onto: "main" });
    const blind = await contractFor(taskInstance, taskUnit, { ...r, readShipRequest: async () => undefined });
    expect(blind.unit.section).toBe("Implement the task this thread's ship request describes.");
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
    expect(child.fixRound).toBeUndefined();
    expect(renderContract(child.contract!, {}).text).toContain("### Unit U10 — Warm the cache on wake");

    const taskUnit: CoordinatorUnit = { ...unit, unit: TASK_UNIT, branch: "ship/fix-abc" };
    const task = await composeChild(
      { kind: "contract", unit: TASK_UNIT, rebase: { branch: "ship/fix-abc", onto: "main" } },
      { ...instance, plan: undefined },
      taskUnit,
      r,
    );
    expect(task.prompt).toBe("fix the login redirect");
    expect(task.contract?.unit.id).toBe(TASK_UNIT);
  });

  it("a review brief is a review child on the pull request: round one's turn names the head; a re-review carries the prior review run's findings and the fix run's dispositions from their records, and the same contract", async () => {
    const { r } = readers({
      runs: {
        "run-r1": { findings: [FINDING], finalReply: "Changes requested: one nit." },
        "run-f1": { dispositions: [{ findingId: "F1", disposition: "declined", note: "the loop is exclusive" }] },
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
    expect(first.prompt.startsWith("https://github.com/acme/api/pull/7\n\n")).toBe(true);
    expect(first.prompt).toContain(`Review pull request acme/api#7 at head \`${"a".repeat(40)}\``);
    expect(first.contract?.unit.id).toBe("U10");
    const second = await composeChild(
      {
        kind: "review",
        unit: "U10",
        pr: 7,
        headSha: "b".repeat(40),
        round: 2,
        prior: { reviewRunId: "run-r1", fixRunId: "run-f1" },
      },
      instance,
      unit,
      r,
    );
    expect(second.prompt).toContain("Re-review pull request acme/api#7");
    expect(second.prompt).toContain("[minor] F1 src/a.ts:3 — off by one");
    expect(second.prompt).toContain("F1: declined — the loop is exclusive");
  });

  it("a fix brief is a coding child on the unit's branch with the review run's findings and final words as its turn, answering exactly those finding ids; a review run the history lacks throws by name", async () => {
    const { r } = readers({ runs: { "run-r1": { findings: [FINDING], finalReply: "Changes requested: one nit." } } });
    const fix = await composeChild({ kind: "fix", unit: "U10", pr: 7, reviewRunId: "run-r1" }, instance, unit, r);
    expect(fix.preset).toBe("coding");
    expect(fix.ref).toBe(unit.branch);
    expect(fix.fixRound).toEqual({ findingIds: ["F1"] });
    expect(fix.prompt).toContain("The review of acme/api#7 requested changes.");
    expect(fix.prompt).toContain("[minor] F1 src/a.ts:3 — off by one");
    expect(fix.prompt).toContain("Review:\nChanges requested: one nit.");
    expect(fix.contract).toBeUndefined();
    await expect(
      composeChild({ kind: "fix", unit: "U10", pr: 7, reviewRunId: "run-gone" }, instance, unit, r),
    ).rejects.toThrow(/run run-gone is not in the run history/);
  });
});
