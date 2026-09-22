import { describe, expect, it } from "vitest";
import { classifyRoundChecks, suspectedFlake, type CheckRunDetail } from "./checkFindings.js";
import { checkFinding } from "./coordinator.js";

// Feature: docs/reference/specs/agent-ship.md item 9; docs/decisions/0055-….md,
// "The round verdict" — the flake rule. The bot's checks step classifies each
// failed check run at the reviewed head: a test timeout or runner stall on a
// shard whose test files the pull request's changed paths never touch is a
// suspected flake, re-run once by the machine before it becomes a finding.
// The judgement is conservative: anything unprovable is a real failure.

const run = (over: Partial<CheckRunDetail>): CheckRunDetail => ({
  name: "test 2 of 4",
  status: "completed",
  conclusion: "failure",
  url: "https://github.com/acme/api/actions/runs/9/job/1",
  ...over,
});

describe("suspectedFlake — a timeout/stall on a shard the changed paths never touch", () => {
  const CHANGED = ["docs/how-to/operate.md", "src/core/budgets.ts"];

  it("a timed_out conclusion whose output names only untouched test files is a suspect", () => {
    expect(
      suspectedFlake(
        { conclusion: "timed_out", output: "Test timed out in src/core/runLedger/sessionLog.test.ts" },
        CHANGED,
      ),
    ).toBe(true);
  });

  it("a stall in the output's words counts like the conclusion", () => {
    expect(
      suspectedFlake(
        { conclusion: "failure", output: "runner stalled: no output received in src/web/cards.test.ts" },
        CHANGED,
      ),
    ).toBe(true);
  });

  it("a shard whose named test files the changed paths touch is a real failure", () => {
    expect(
      suspectedFlake({ conclusion: "timed_out", output: "timeout in src/core/budgets.test.ts" }, [
        "src/core/budgets.test.ts",
      ]),
    ).toBe(false);
  });

  it("unprovable reads as real: no timeout marker, no named test files, or unknown changed paths", () => {
    expect(suspectedFlake({ conclusion: "failure", output: "3 assertions failed in src/a.test.ts" }, CHANGED)).toBe(
      false,
    );
    expect(suspectedFlake({ conclusion: "timed_out", output: "the job was cancelled" }, CHANGED)).toBe(false);
    expect(suspectedFlake({ conclusion: "timed_out", output: "timeout in src/a.test.ts" }, undefined)).toBe(false);
  });
});

describe("classifyRoundChecks — the merge door's reading joined with the classifier's", () => {
  it("splits total, pending and failed, marking the suspects; success, skipped and neutral are green", () => {
    const out = classifyRoundChecks(
      [
        run({ name: "ci / bot", conclusion: "success" }),
        run({ name: "ci / web", status: "in_progress", conclusion: undefined }),
        run({ name: "lint", conclusion: "skipped" }),
        run({ name: "ci / docs", conclusion: "neutral" }),
        run({ name: "test 2 of 4", conclusion: "timed_out", output: "timed out in src/x/y.test.ts" }),
        run({ name: "title", conclusion: "failure", output: "the title is not the changelog line" }),
      ],
      ["docs/reference/specs/agent-ship.md"],
    );
    expect(out.total).toBe(6);
    expect(out.pending).toEqual(["ci / web"]);
    expect(out.failed).toEqual([
      {
        name: "test 2 of 4",
        conclusion: "timed_out",
        url: "https://github.com/acme/api/actions/runs/9/job/1",
        flakeSuspect: true,
      },
      { name: "title", conclusion: "failure", url: "https://github.com/acme/api/actions/runs/9/job/1" },
    ]);
  });

  it("classifies ownership before output: a required external operator check blocks, while required repository CI and its deployment-shaped output stay child-owned", () => {
    const productionImpact =
      "Every production default now resolves through the openai provider block, but the deployed Switchboard bot Worker holds 22 secrets and no OPENAI_API_KEY. Run deploy secrets bot --only OPENAI_API_KEY, then re-run this check.";
    const out = classifyRoundChecks(
      [
        run({ name: "production impact", app: "external-impact", output: productionImpact }),
        run({ name: "ci / bot", app: "depot", output: "Typecheck failed in src/core/ship/coordinator.ts" }),
        run({
          name: "ci / workers",
          app: "depot",
          output: "FAIL deploy/cloudflare-memory/sessionLog.test.ts > persists the report",
        }),
      ],
      ["src/core/ship/coordinator.ts"],
      ["production impact", "ci / bot", "ci / workers"],
    );

    expect(out.failed).toEqual([
      {
        name: "production impact",
        conclusion: "failure",
        url: "https://github.com/acme/api/actions/runs/9/job/1",
        output: productionImpact,
        operatorPrecondition: true,
      },
      {
        name: "ci / bot",
        conclusion: "failure",
        url: "https://github.com/acme/api/actions/runs/9/job/1",
      },
      {
        name: "ci / workers",
        conclusion: "failure",
        url: "https://github.com/acme/api/actions/runs/9/job/1",
      },
    ]);
  });

  it("requires both an external owner and an operator instruction, never a bare deployment keyword", () => {
    const out = classifyRoundChecks(
      [
        run({ name: "policy", app: "external-policy", output: "Production policy failed" }),
        run({
          name: "impact path",
          app: "external-impact",
          output: "Failure in deploy/cloudflare-memory/sessionLog.test.ts",
        }),
        run({ name: "impact script", app: "external-impact", output: "deploy:check failed" }),
        run({ name: "missing key", app: "external-impact", output: "No OPENAI_API_KEY is deployed" }),
        run({ name: "secret instruction", app: "external-impact", output: "Set OPENAI_API_KEY on the bot." }),
        run({ name: "config instruction", app: "external-impact", output: "Push the config, then re-run." }),
        run({
          name: "production impact",
          app: "external-impact",
          output: "No OPENAI_API_KEY is deployed. Run deploy secrets bot --only OPENAI_API_KEY, then re-run.",
        }),
      ],
      [],
    );

    expect(out.failed.slice(0, 4).every((failure) => failure.operatorPrecondition !== true)).toBe(true);
    expect(out.failed.slice(4)).toMatchObject([
      { name: "secret instruction", operatorPrecondition: true },
      { name: "config instruction", operatorPrecondition: true },
      { name: "production impact", operatorPrecondition: true },
    ]);
  });

  it("recognizes operator imperatives in Markdown lists and after prose prefaces", () => {
    const out = classifyRoundChecks(
      [
        run({
          name: "listed secret instruction",
          app: "external-impact",
          output: "- Run deploy secrets bot --only OPENAI_API_KEY",
        }),
        run({
          name: "prefaced secret instruction",
          app: "external-impact",
          output: "To fix this, run deploy secrets bot --only OPENAI_API_KEY",
        }),
      ],
      [],
    );

    expect(out.failed).toMatchObject([
      { name: "listed secret instruction", operatorPrecondition: true },
      { name: "prefaced secret instruction", operatorPrecondition: true },
    ]);
  });

  it("carries every required context beside the unreported subset, so an unrelated check cannot hide an empty required-check launch", () => {
    expect(
      classifyRoundChecks([run({ name: "pr title", conclusion: "success" })], [], ["ci / bot", "ci / workers"]),
    ).toMatchObject({
      total: 1,
      required: ["ci / bot", "ci / workers"],
      expected: ["ci / bot", "ci / workers"],
    });
    expect(
      classifyRoundChecks([run({ name: "ci / bot", conclusion: "success" })], [], ["ci / bot", "ci / workers"]),
    ).toMatchObject({ required: ["ci / bot", "ci / workers"], expected: ["ci / workers"] });
  });

  it("checkFinding renders a failure as a finding row like a reviewer's: id check:<name>, severity blocking, the conclusion and URL", () => {
    expect(checkFinding({ name: "ci / bot", conclusion: "failure", url: "https://x/1" })).toEqual({
      id: "check:ci / bot",
      severity: "blocking",
      file: "ci / bot",
      title: "CI check failed (failure) — https://x/1",
      check: true,
    });
    expect(checkFinding({ name: "ci / bot", conclusion: "timed_out" }).title).toBe("CI check failed (timed_out)");
  });
});
