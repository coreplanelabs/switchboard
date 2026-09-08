import { describe, expect, it } from "vitest";
import { analyzeRunFriction, type FrictionFinding } from "./runFriction.js";
import type { RunEvent } from "./runEvents.js";
import {
  clusterFriction,
  commandSignature,
  dedupeProposals,
  findProposalKey,
  installSignature,
  normalizeCommand,
  patternSignature,
  proposalMarker,
  proposeImprovements,
  type FrictionRunRecord,
} from "./frictionProposals.js";

// Feature: features/self-improvement.md — the PURE half of the friction
// proposer (#84, Area 7b second piece): cluster the per-run diagnoses the
// analyzer (#105) already produces into recurring cross-run patterns, rank
// them, render each as an issue proposal with its evidence and a concrete
// suggested fix, and dedupe against proposals that are already open.

// ---- fixtures ---------------------------------------------------------------

let t = 0;
const at = (ms: number) => (t += ms);
const call = (summary: string, tool = "bash"): RunEvent => ({ type: "tool_call", tool, summary, at: at(10) });
const result = (ok: boolean, summary: string, ms: number, tool = "bash"): RunEvent => ({
  type: "tool_result",
  tool,
  ok,
  summary,
  at: at(ms),
});

/** A run that hits the recurring pattern: a pnpm install that fails on an
 *  outdated lockfile, then a retry without the flag. */
function lockfileRun(runId: string, finishedAt: number, extra: RunEvent[] = []): FrictionRunRecord {
  t = 0;
  const events: RunEvent[] = [
    call("$ git clone https://github.com/o/r.git"),
    result(true, "Cloning into 'r'...", 8_000),
    call("$ pnpm install --frozen-lockfile"),
    result(false, "ERR_PNPM_OUTDATED_LOCKFILE", 45_000),
    call("$ pnpm install"),
    result(true, "done", 60_000),
    ...extra,
  ];
  return {
    runId,
    label: `coding · o/r · "fix ${runId}"`,
    agent: "coding",
    finishedAt,
    diagnosis: analyzeRunFriction(events),
  };
}

/** A clean run: nothing to cluster. */
function cleanRun(runId: string, finishedAt: number): FrictionRunRecord {
  t = 0;
  const events: RunEvent[] = [call("$ ls"), result(true, "src", 200), call("$ npm test"), result(true, "ok", 5_000)];
  return { runId, agent: "review", finishedAt, diagnosis: analyzeRunFriction(events) };
}

/** A run whose only friction is a one-off failure (must NOT become a pattern). */
function oneOffRun(runId: string, finishedAt: number): FrictionRunRecord {
  t = 0;
  const events: RunEvent[] = [call("$ cat missing.txt"), result(false, "cat: missing.txt: No such file", 100)];
  return { runId, agent: "review", finishedAt, diagnosis: analyzeRunFriction(events) };
}

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 28);

// ---- signatures -------------------------------------------------------------

describe("normalizeCommand", () => {
  it("strips the `$ ` prefix and the result tail, collapses whitespace", () => {
    expect(normalizeCommand("$ pnpm   install --frozen-lockfile → ERR_PNPM_OUTDATED_LOCKFILE")).toBe(
      "pnpm install --frozen-lockfile",
    );
  });

  it("blanks volatile tokens (numbers, hashes, urls) so per-run variation clusters together", () => {
    expect(normalizeCommand("$ git checkout 9bcdb44e1f2a && sleep 12 && curl https://x.test/a/b?c=1")).toBe(
      "git checkout <sha> && sleep <n> && curl <url>",
    );
    expect(normalizeCommand("$ git checkout 455120bdead")).toBe(normalizeCommand("$ git checkout 33dc4d4cafe"));
  });

  it("caps the length so a huge script does not become the key", () => {
    expect(normalizeCommand(`$ echo ${"x".repeat(500)}`).length).toBeLessThanOrEqual(120);
  });
});

describe("commandSignature", () => {
  it("reduces a chained shell command to its meaningful program+subcommand tokens, dropping cd/echo/pipes/redirections", () => {
    expect(commandSignature('$ cd /tmp/ws/repo && git checkout -q main && npm test 2>&1 | grep -E "Test Files"')).toBe(
      "git checkout, npm test",
    );
    expect(
      commandSignature("$ cd ~/switchboard && node --version && npx vitest run src/a.test.ts 2>&1 | tail -8"),
    ).toBe("node, npx vitest");
    expect(commandSignature('$ echo hi; (npm test 2>&1 | tail -15); echo "=== done ==="')).toBe("npm test");
    expect(commandSignature("$ FOO=1 sudo apt-get install -y jq >/dev/null")).toBe("apt-get install");
  });

  it("is the SAME for the two ways real runs chained the same install (the cross-run case)", () => {
    const a = commandSignature(
      "$ cd /tmp/ws/repo && npm ci --silent 2>&1 | tail -2 && npm run typecheck 2>&1 | tail -3 && npm test 2>&1 | tail -8",
    );
    const b = commandSignature(
      "$ cd ~/switchboard && npm ci --silent >/dev/null 2>&1; (npm test 2>&1 | tail -15); npm run typecheck 2>&1 | tail -5",
    );
    expect(a).toBe("npm ci, npm run typecheck, npm test");
    expect(b).toBe("npm ci, npm test, npm run typecheck");
    // Order differs, so the tool-level signature differs — but the INSTALL
    // signature (what setup_install keys on) is identical:
    expect(installSignature(a === b ? "" : "$ cd /tmp/ws/repo && npm ci --silent 2>&1 | tail -2 && npm test")).toBe(
      "npm ci",
    );
    expect(installSignature("$ cd ~/switchboard && npm ci --silent >/dev/null 2>&1; (npm test 2>&1 | tail -15)")).toBe(
      "npm ci",
    );
  });

  it("treats a lone `&` (backgrounding) as a separator too, without breaking `&&`", () => {
    expect(commandSignature("$ npm run dev & sleep 3 && npm test")).toBe("npm run dev, npm test");
  });

  it("caps the number of segments and normalizes volatile tokens", () => {
    expect(commandSignature("$ a && b && c && d && e && f")).toBe("a, b, c, d");
    expect(commandSignature("$ git checkout 9bcdb44e1f2a && sleep 12 && make build")).toBe("git checkout, make build");
    expect(commandSignature("$ git checkout 9bcdb44e1f2a && make build")).toBe(
      commandSignature("$ git checkout 33dc4d4cafe && make build"),
    );
  });
});

describe("installSignature", () => {
  it("keeps the install segment's meaningful flags and drops quiet/noise flags, urls, paths", () => {
    expect(installSignature("$ pnpm install --frozen-lockfile → ERR")).toBe("pnpm install --frozen-lockfile");
    expect(installSignature("$ cd x && npm install --no-audit --no-fund >/dev/null 2>&1; npx tsc")).toBe("npm install");
    expect(installSignature("$ git clone https://github.com/o/r.git")).toBe("git clone");
    expect(installSignature("$ python3 -m pip install -r requirements.txt")).toBe("pip install");
    expect(installSignature("$ npm test")).toBeUndefined(); // not an install
  });
});

describe("patternSignature", () => {
  const f = (over: Partial<FrictionFinding>): FrictionFinding => ({
    category: "failed_tool",
    severity: "medium",
    summary: "",
    eventIndex: 0,
    ...over,
  });

  it("keys tool findings by category + normalized command, dropping the analyzer's label prefixes", () => {
    expect(
      patternSignature(
        f({ category: "setup_install", summary: "install failed: $ pnpm install --frozen-lockfile → ERR" }),
      ),
    ).toBe("setup_install:pnpm install --frozen-lockfile");
    expect(
      patternSignature(f({ category: "setup_install", summary: "slow install: $ pnpm install --frozen-lockfile" })),
    ).toBe("setup_install:pnpm install --frozen-lockfile");
    expect(patternSignature(f({ category: "slow_tool", summary: "took 46s: $ npm test" }))).toBe("slow_tool:npm test");
    // A slow think is a property of the agent/model, not of the command it
    // eventually issued — one key, so the pattern clusters across runs.
    expect(
      patternSignature(f({ category: "slow_model_turn", summary: "model turn took 3m 42s before: $ grep -n foo src" })),
    ).toBe("slow_model_turn:model_turn");
    expect(patternSignature(f({ category: "retry", summary: "retried after failure: $ npm test" }))).toBe(
      "retry:npm test",
    );
    expect(
      patternSignature(f({ category: "failed_tool", summary: "$ npm test → sh: vitest: command not found" })),
    ).toBe("failed_tool:npm test");
  });

  it("keys an unknown-tool failure (tool misuse) by the tool name", () => {
    expect(patternSignature(f({ category: "failed_tool", tool: "gh_api", summary: "gh_api → unknown tool" }))).toBe(
      "failed_tool:unknown tool gh_api",
    );
  });

  it("keys note findings by their kind, not their free text", () => {
    expect(patternSignature(f({ category: "budget_hit", summary: "budget hit (time): ~0s left, wrapping up" }))).toBe(
      "budget_hit:time",
    );
    expect(patternSignature(f({ category: "budget_hit", summary: "budget hit (turns): 40 turns used" }))).toBe(
      "budget_hit:turns",
    );
    expect(patternSignature(f({ category: "wrap_up", summary: "~3 min left — signaling wrap-up" }))).toBe(
      "wrap_up:wrap_up",
    );
    expect(patternSignature(f({ category: "infra_failure", summary: "sandbox dead: exec transport closed" }))).toBe(
      "infra_failure:sandbox_dead",
    );
    expect(
      patternSignature(
        f({ category: "infra_failure", summary: "no result for tool call (run ended mid-tool): $ npm test" }),
      ),
    ).toBe("infra_failure:mid-tool npm test");
    expect(
      patternSignature(
        f({ category: "infra_failure", summary: "exec infrastructure failed during $ npm ci → ECONNRESET" }),
      ),
    ).toBe("infra_failure:npm ci");
  });

  it("clusters the SAME install chained differently across real runs (the case the first real capture exposed)", () => {
    const a = f({
      category: "setup_install",
      summary:
        "slow install: $ cd /tmp/ws/repo && npm ci --silent 2>&1 | tail -2 && npm run typecheck 2>&1 | tail -3 && npm test 2>&1 | tail -8",
    });
    const b = f({
      category: "setup_install",
      summary:
        'slow install: $ cd ~/switchboard && npm ci --silent >/dev/null 2>&1; (npm test 2>&1 | tail -15); echo "=== bot typecheck ==="',
    });
    expect(patternSignature(a)).toBe("setup_install:npm ci");
    expect(patternSignature(b)).toBe("setup_install:npm ci");
    const c = f({
      category: "slow_tool",
      summary:
        'took 37s: $ cd /tmp/ws/repo && git checkout -q main && npm test 2>&1 | grep -E "Test Files" ; git checkout -q feat/x && npm test 2>&1 | grep -E "Test Files"',
    });
    expect(patternSignature(c)).toBe("slow_tool:git checkout, npm test");
  });
});

// ---- clustering -------------------------------------------------------------

describe("clusterFriction", () => {
  it("returns no patterns for no records or for clean runs", () => {
    expect(clusterFriction([])).toEqual([]);
    expect(clusterFriction([cleanRun("a", T0), cleanRun("b", T0 + DAY)])).toEqual([]);
  });

  it("clusters the same finding across DISTINCT runs and ignores one-offs (minRuns default 2)", () => {
    const records = [lockfileRun("r1", T0), oneOffRun("r2", T0 + 1), lockfileRun("r3", T0 + 2), cleanRun("r4", T0 + 3)];
    const patterns = clusterFriction(records);
    const keys = patterns.map((p) => p.key);
    expect(keys).toContain("setup_install:pnpm install --frozen-lockfile");
    expect(keys).toContain("setup_install:pnpm install"); // the follow-up install (a different command, so not an analyzer `retry`)
    expect(keys).not.toContain("failed_tool:cat missing.txt"); // seen in one run only
    const top = patterns.find((p) => p.key === "setup_install:pnpm install --frozen-lockfile")!;
    expect(top.runIds).toEqual(["r1", "r3"]);
    expect(top.occurrences).toBe(2);
    expect(top.severity).toBe("high");
    expect(top.durationMs).toBe(90_000);
  });

  it("counts a finding repeated within ONE run as one run (recurrence means across runs)", () => {
    t = 0;
    const events: RunEvent[] = [
      call("$ npm test"),
      result(false, "fail", 100),
      call("$ npm test"),
      result(false, "fail", 100),
      call("$ npm test"),
      result(false, "fail", 100),
    ];
    const rec: FrictionRunRecord = { runId: "solo", finishedAt: T0, diagnosis: analyzeRunFriction(events) };
    expect(clusterFriction([rec])).toEqual([]);
    const two = clusterFriction([rec, { ...rec, runId: "solo-2" }]);
    const failed = two.find((p) => p.key === "failed_tool:npm test")!;
    expect(failed.runIds).toEqual(["solo", "solo-2"]);
    expect(failed.occurrences).toBe(6);
  });

  it("ranks by distinct runs, then peak severity, then attributed time", () => {
    // 3 runs share a cheap failure; 2 runs share the lockfile run's three patterns.
    const cheap = (id: string, ms: number): FrictionRunRecord => {
      t = 0;
      return {
        runId: id,
        finishedAt: T0 + ms,
        diagnosis: analyzeRunFriction([call("$ false"), result(false, "exit 1", 50)]),
      };
    };
    const patterns = clusterFriction([
      lockfileRun("a", T0),
      lockfileRun("b", T0 + 1),
      cheap("c", 2),
      cheap("d", 3),
      cheap("e", 4),
    ]);
    expect(patterns.map((p) => p.key)).toEqual([
      "failed_tool:false", // 3 runs beats 2, however cheap
      "setup_install:pnpm install --frozen-lockfile", // high (a FAILED install) beats a slower medium
      "setup_install:pnpm install", // medium slow install, 2m total
      "setup_install:git clone", // low, 16s
    ]);
  });

  it("honors minRuns", () => {
    const records = [lockfileRun("r1", T0), lockfileRun("r3", T0 + 2)];
    expect(clusterFriction(records, { minRuns: 3 })).toEqual([]);
    expect(clusterFriction(records, { minRuns: 1 }).some((p) => p.key.startsWith("setup_install:git clone"))).toBe(
      true,
    );
  });

  it("keeps the most recent examples first, capped, each anchored to its run", () => {
    const records = Array.from({ length: 8 }, (_, i) => lockfileRun(`r${i}`, T0 + i * DAY));
    const p = clusterFriction(records).find((x) => x.key === "setup_install:pnpm install --frozen-lockfile")!;
    expect(p.runIds).toHaveLength(8);
    expect(p.examples.length).toBeLessThanOrEqual(5);
    expect(p.examples[0].runId).toBe("r7");
    expect(p.examples[0].label).toContain("r7");
    expect(p.examples[0].summary).toContain("pnpm install --frozen-lockfile");
    expect(p.examples[0].durationMs).toBe(45_000);
  });

  it("detects cross-run duration outliers as a long_run pattern per agent (the cost-spike proxy)", () => {
    const withRun = (id: string, agent: string, runMs: number): FrictionRunRecord => {
      t = 0;
      const rec = cleanRun(id, T0);
      rec.agent = agent;
      rec.diagnosis = { ...rec.diagnosis, hasTimings: true, runMs };
      return rec;
    };
    const minute = 60_000;
    const records = [
      withRun("a", "coding", 5 * minute),
      withRun("b", "coding", 6 * minute),
      withRun("c", "coding", 5 * minute),
      withRun("d", "coding", 40 * minute),
      withRun("e", "coding", 45 * minute),
      withRun("f", "review", 4 * minute),
    ];
    const p = clusterFriction(records).find((x) => x.kind === "long_run")!;
    expect(p).toBeDefined();
    expect(p.key).toBe("long_run:coding");
    expect(p.runIds).toEqual(["d", "e"]);
    expect(p.durationMs).toBe(85 * minute);
    expect(p.examples[0].summary).toMatch(/run took 45m 00s/);
  });

  it("does not flag long runs when every run is long (no outlier) or when only one is", () => {
    const withRun = (id: string, runMs: number): FrictionRunRecord => {
      const rec = cleanRun(id, T0);
      rec.diagnosis = { ...rec.diagnosis, hasTimings: true, runMs };
      return rec;
    };
    const minute = 60_000;
    expect(clusterFriction([withRun("a", 40 * minute), withRun("b", 42 * minute), withRun("c", 41 * minute)])).toEqual(
      [],
    );
    expect(clusterFriction([withRun("a", 2 * minute), withRun("b", 2 * minute), withRun("c", 60 * minute)])).toEqual(
      [],
    );
  });

  it("is deterministic and does not mutate its input", () => {
    const records = [lockfileRun("r1", T0), lockfileRun("r3", T0 + 2)];
    const snapshot = JSON.parse(JSON.stringify(records));
    const a = clusterFriction(records);
    const b = clusterFriction(records);
    expect(a).toEqual(b);
    expect(records).toEqual(snapshot);
  });
});

// ---- proposals --------------------------------------------------------------

describe("proposeImprovements", () => {
  const records = [lockfileRun("r1", T0), oneOffRun("r2", T0 + 1), lockfileRun("r3", T0 + 2), cleanRun("r4", T0 + 3)];
  const patterns = clusterFriction(records);

  it("emits at most `top` proposals, in pattern rank order, each carrying its dedupe marker", () => {
    const proposals = proposeImprovements(patterns, { top: 1, runsAnalyzed: records.length });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].key).toBe(patterns[0].key);
    expect(proposals[0].body).toContain(proposalMarker(patterns[0].key));
    expect(findProposalKey(proposals[0].body)).toBe(patterns[0].key);
  });

  it("renders the evidence: pattern stats, the affected runs, and a concrete suggested fix", () => {
    const [p] = proposeImprovements(patterns, { top: 1, runsAnalyzed: records.length, label: "self-improvement" });
    expect(p.title).toMatch(/^\[friction\] /);
    expect(p.title).toContain("pnpm install --frozen-lockfile");
    expect(p.title.length).toBeLessThanOrEqual(120);
    expect(p.labels).toEqual(["self-improvement"]);
    expect(p.body).toContain("2 of 4 runs");
    expect(p.body).toContain("1m 30s");
    expect(p.body).toContain("`r1`");
    expect(p.body).toContain("`r3`");
    expect(p.body).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
    expect(p.body).toContain("## Suggested fix");
    expect(p.body).toMatch(/lockfile/i); // the setup_install template speaks to the failing install
    expect(p.body).toContain("#84");
  });

  it("has a fix template for every pattern kind", () => {
    const kinds = [
      "slow_tool",
      "slow_model_turn",
      "failed_tool",
      "retry",
      "setup_install",
      "wrap_up",
      "budget_hit",
      "infra_failure",
      "long_run",
    ] as const;
    for (const kind of kinds) {
      const [p] = proposeImprovements(
        [
          {
            key: `${kind}:x`,
            kind,
            signature: "x",
            runIds: ["a", "b"],
            occurrences: 2,
            durationMs: 0,
            severity: "medium",
            examples: [{ runId: "a", finishedAt: T0, summary: "x", severity: "medium" }],
          },
        ],
        { top: 1, runsAnalyzed: 2 },
      );
      expect(p.body, kind).toMatch(/## Suggested fix\n\n\S/);
    }
  });

  it("redacts nothing new but never throws on odd summaries", () => {
    expect(() => proposeImprovements(patterns, { top: 5, runsAnalyzed: 0 })).not.toThrow();
  });
});

// ---- dedupe -----------------------------------------------------------------

describe("dedupeProposals", () => {
  const records = [lockfileRun("r1", T0), lockfileRun("r3", T0 + 2)];
  const proposals = proposeImprovements(clusterFriction(records), { top: 3, runsAnalyzed: 2 });

  it("matches an open issue by its marker, not its title, and keeps the rest fresh", () => {
    const open = [
      {
        number: 7,
        url: "https://github.com/o/r/issues/7",
        title: "totally different title",
        body: `hello\n${proposalMarker(proposals[0].key)}\n`,
      },
      { number: 8, url: "https://github.com/o/r/issues/8", title: proposals[1].title, body: "no marker here" },
    ];
    const { fresh, duplicates } = dedupeProposals(proposals, open);
    expect(duplicates).toEqual([{ proposal: proposals[0], issue: open[0] }]);
    expect(fresh.map((p) => p.key)).toEqual(proposals.slice(1).map((p) => p.key));
  });

  it("with nothing open, everything is fresh", () => {
    expect(dedupeProposals(proposals, []).fresh).toEqual(proposals);
  });

  it("findProposalKey ignores bodies without a marker and tolerates whitespace", () => {
    expect(findProposalKey("plain body")).toBeUndefined();
    expect(findProposalKey("x\n<!--   switchboard-friction-pattern:  retry:npm test   -->\ny")).toBe("retry:npm test");
  });
});
