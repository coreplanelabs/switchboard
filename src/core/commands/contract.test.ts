import { describe, expect, it } from "vitest";
import { CLI_ACTOR } from "../authz/actor.js";
import { CHAT_OPEN_ACTIONS } from "../authz/grants.js";
import { CommandRegistry, bindCommands, renderText, type Caller } from "../commandRegistry.js";
import { CONTRACT_HEADING, CONTRACT_SECTION_HEADINGS, DEFAULT_CONTRACT_MAX_CHARS } from "../ship/contract.js";
import { callerWith } from "../testing/callers.js";
import { contractRender, registerContractCommands, repoRootOfPlan, type ContractCommandDeps } from "./contract.js";

// Feature: docs/reference/specs/agent-ship.md item 13 — `contract render`: the
// registry command that renders a unit's contract by hand until the plan
// runner exists, so a person can paste the block into a coding prompt and
// post the rendered length as the receipt. What it decides: where the plan's
// specs and rules are read from (the repository root the plan path implies),
// which rules file wins (AGENTS.md, else CLAUDE.md, else none), and how a
// missing plan or unit is refused. The rendering itself is the contract
// module's (contract.test.ts).

const PLAN = `# Fixture plan

## Implementation Units

### U16. The child contract

- **Goal**: A coding child never starts from a free-text task alone.
- **Files**: \`src/core/ship/contract.ts\`; \`docs/reference/specs/agent-ship.md\` item 4.
- **Approach**: build the object, render it under fixed headings.
- **Test scenarios**: a contract renders under the fixed headings.
- **Verification**: \`npm test\` green.

### U17. Handoffs as data

- **Goal**: A child's deviation reaches the board.
`;

const SHIP_SPEC = `# Agent: ship

## Behavior

4. **Round 0 = the PR gate end to end.** The coding child implements, pushes, and submits.

## Validation criteria

| Criterion | Proof |
|---|---|
| Round 0 opens the PR (item 4) | \`[unit]\` \`src/core/dispatcher.test.ts::agent:ship (pipeline)::LGTM round 1…\` |
`;

const cli: Caller = { kind: "cli", id: CLI_ACTOR.id, actor: CLI_ACTOR };

function bound(files: Record<string, string>) {
  const reads: string[] = [];
  const registry = new CommandRegistry<ContractCommandDeps>({ audit: () => {} });
  registerContractCommands(registry);
  const commands = bindCommands(registry, {
    contract: {
      readFile: async (path) => {
        reads.push(path);
        return files[path];
      },
    },
  });
  return { commands, reads };
}

const FILES = {
  "/repo/docs/plans/fixture-plan.md": PLAN,
  "/repo/docs/reference/specs/agent-ship.md": SHIP_SPEC,
  "/repo/AGENTS.md": "# Agents\n\nRun only what the Commands table names.",
  "/repo/CLAUDE.md": "See AGENTS.md.",
};

describe("contract.render", () => {
  it("renders the unit's contract from the plan, the specs it names and the rules file at the root the plan path implies; the JSON carries the measured length", async () => {
    const { commands, reads } = bound(FILES);
    const res = await commands.invoke(
      "contract.render",
      { options: { plan: "/repo/docs/plans/fixture-plan.md", unit: "U16" } },
      cli,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    const v = res.value as {
      unit: { id: string; title: string };
      specRows: Array<{ spec: string; item: number; found: boolean; validationRows: number }>;
      agentRules: string | null;
      chars: number;
      maxChars: number;
      dropped: string[];
      overBudget: boolean;
      text: string;
    };
    expect(v.unit).toEqual({ id: "U16", title: "The child contract" });
    expect(v.specRows).toEqual([{ spec: "agent-ship.md", item: 4, found: true, validationRows: 1 }]);
    expect(v.agentRules).toBe("AGENTS.md");
    expect(v.maxChars).toBe(DEFAULT_CONTRACT_MAX_CHARS);
    expect(v.dropped).toEqual([]);
    expect(v.overBudget).toBe(false);
    expect(v.chars).toBe(v.text.length);
    expect(v.text.startsWith(`${CONTRACT_HEADING}\n`)).toBe(true);
    expect(v.text).toContain(`${CONTRACT_SECTION_HEADINGS.unit} U16 — The child contract`);
    expect(v.text).toContain("4. **Round 0 = the PR gate end to end.**");
    expect(v.text).toContain("Run only what the Commands table names.");
    // the specs and the rules were read under the plan's repository root; CLAUDE.md was never needed
    expect(reads).toEqual([
      "/repo/docs/plans/fixture-plan.md",
      "/repo/docs/reference/specs/agent-ship.md",
      "/repo/AGENTS.md",
    ]);
    // the text projection is the block, then the receipt line a person posts
    const text = renderText(commands.get("contract.render")!, res.value);
    expect(text.startsWith(v.text)).toBe(true);
    expect(text.endsWith(`\n\n(${v.chars} characters; budget ${v.maxChars}; dropped: none)`)).toBe(true);
  });

  it("CLAUDE.md stands in when there is no AGENTS.md; neither → no rules, said in the block", async () => {
    const { "/repo/AGENTS.md": _agents, ...withoutAgents } = FILES;
    const claude = bound(withoutAgents);
    const a = await claude.commands.invoke(
      "contract.render",
      { options: { plan: "/repo/docs/plans/fixture-plan.md", unit: "U16" } },
      cli,
    );
    if (!a.ok) throw new Error(a.message);
    expect((a.value as { agentRules: string | null }).agentRules).toBe("CLAUDE.md");
    expect((a.value as { text: string }).text).toContain("Source: CLAUDE.md\n\nSee AGENTS.md.");
    const { "/repo/CLAUDE.md": _claude, ...none } = withoutAgents;
    const bare = bound(none);
    const b = await bare.commands.invoke(
      "contract.render",
      { options: { plan: "/repo/docs/plans/fixture-plan.md", unit: "U16" } },
      cli,
    );
    if (!b.ok) throw new Error(b.message);
    expect((b.value as { agentRules: string | null }).agentRules).toBeNull();
    expect((b.value as { text: string }).text).toContain("(none — the repository has neither AGENTS.md nor CLAUDE.md)");
  });

  it("`--root` overrides the implied root; `--branch`/`--onto` name the first instruction; `--max-chars` is the budget and the receipt line says what was dropped", async () => {
    const { commands, reads } = bound({
      "/elsewhere/plan.md": PLAN,
      "/repo/docs/reference/specs/agent-ship.md": SHIP_SPEC,
      "/repo/AGENTS.md": "rules",
    });
    const res = await commands.invoke(
      "contract.render",
      {
        options: {
          plan: "/elsewhere/plan.md",
          unit: "U16",
          root: "/repo",
          branch: "plan/fixture/u16-the-child-contract",
          onto: "main",
          maxChars: 10,
        },
      },
      cli,
    );
    if (!res.ok) throw new Error(res.message);
    const v = res.value as { text: string; dropped: string[]; overBudget: boolean; maxChars: number; chars: number };
    expect(reads).toContain("/repo/docs/reference/specs/agent-ship.md");
    expect(v.text).toContain("Rebase `plan/fixture/u16-the-child-contract` onto `main`");
    expect(v.maxChars).toBe(10);
    expect(v.dropped).toEqual(["approach", "agentRules", "specText", "specRows"]);
    expect(v.overBudget).toBe(true);
    expect(renderText(commands.get("contract.render")!, res.value)).toContain(
      `(${v.chars} characters; budget 10; dropped: approach, agentRules, specText, specRows — still over the budget)`,
    );
  });

  it("a spec the unit names that is not there is rendered as not found, never an error", async () => {
    const { "/repo/docs/reference/specs/agent-ship.md": _spec, ...noSpec } = FILES;
    const { commands } = bound(noSpec);
    const res = await commands.invoke(
      "contract.render",
      { options: { plan: "/repo/docs/plans/fixture-plan.md", unit: "U16" } },
      cli,
    );
    if (!res.ok) throw new Error(res.message);
    const v = res.value as { specRows: Array<{ found: boolean }>; text: string };
    expect(v.specRows).toEqual([{ spec: "agent-ship.md", item: 4, found: false, validationRows: 0 }]);
    expect(v.text).toContain("(not found: no spec agent-ship.md was readable)");
  });

  it("a missing plan is not_found naming the path; an unknown unit is invalid_input naming the plan's units; a malformed unit id is refused by the schema", async () => {
    const { commands } = bound(FILES);
    const missing = await commands.invoke(
      "contract.render",
      { options: { plan: "/repo/docs/plans/nope.md", unit: "U16" } },
      cli,
    );
    expect(missing).toMatchObject({ ok: false, error: "not_found", decidedBy: "handler" });
    if (missing.ok) throw new Error("unreachable");
    expect(missing.message).toBe("plan not found: /repo/docs/plans/nope.md");
    const unknown = await commands.invoke(
      "contract.render",
      { options: { plan: "/repo/docs/plans/fixture-plan.md", unit: "U99" } },
      cli,
    );
    expect(unknown).toMatchObject({ ok: false, error: "invalid_input", decidedBy: "handler" });
    if (unknown.ok) throw new Error("unreachable");
    expect(unknown.message).toBe("the plan has no unit U99 (its units: U16, U17)");
    const malformed = await commands.invoke(
      "contract.render",
      { options: { plan: "/repo/docs/plans/fixture-plan.md", unit: "sixteen" } },
      cli,
    );
    expect(malformed).toMatchObject({ ok: false, error: "invalid_input", decidedBy: "registry" });
    if (malformed.ok) throw new Error("unreachable");
    expect(malformed.message).toContain("unit:");
    expect(malformed.message).not.toContain("sixteen");
  });

  it("is CLI-only (it reads host paths), a `contract:read` read that no chat baseline holds", async () => {
    expect(contractRender).toMatchObject({
      id: "contract.render",
      action: "contract:read",
      effect: "read",
      surfaces: { chat: false, mcp: false, http: false },
    });
    expect(CHAT_OPEN_ACTIONS).not.toContain("contract:read");
    const { commands } = bound(FILES);
    const chat: Caller = callerWith("chat", "slack:UX", [...CHAT_OPEN_ACTIONS, "contract:read"]);
    const res = await commands.invoke(
      "contract.render",
      { options: { plan: "/repo/docs/plans/fixture-plan.md", unit: "U16" } },
      chat,
    );
    expect(res).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("repoRootOfPlan — where the plan's specs and rules are read from", () => {
  it("a plan under `docs/plans/` implies the repository root above it; any other path implies its own directory", () => {
    expect(repoRootOfPlan("/repo/docs/plans/fixture-plan.md")).toBe("/repo");
    expect(repoRootOfPlan("docs/plans/fixture-plan.md")).toBe(".");
    expect(repoRootOfPlan("/elsewhere/plan.md")).toBe("/elsewhere");
    expect(repoRootOfPlan("plan.md")).toBe(".");
  });
});
