import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  commentBody,
  FOOTER,
  MARKER,
  summaryBlock,
  parseTargetSelector,
  releaseTargetTable,
} from "../scripts/deploy-targets.mjs";

// The `deploy targets` CI job's two rendered artifacts (docs/reference/specs/release-and-
// deploy.md item 8). The command it wraps (`deploy plan --affected`) has its
// own tests; what matters here is the exact shape the job summary and the
// release PR's sticky comment take, since the comment is found again by its
// first line.

describe("deploy-targets renderings", () => {
  const table = "| Worker | Decision |\n|---|---|\n| bot | deploy |";

  it("titles the job summary for a PR by what its diff would deploy", () => {
    expect(summaryBlock(false, table)).toBe(`## What this PR's diff would deploy\n\n${table}\n`);
  });

  it("titles the job summary for the release PR by what merging it deploys", () => {
    expect(summaryBlock(true, table)).toBe(`## Release deployment preview\n\n${table}\n`);
  });

  it("starts the sticky comment with the marker so the next run can find and replace it", () => {
    const body = commentBody(table);
    expect(body.startsWith(`${MARKER}\n`)).toBe(true);
    expect(MARKER).toBe("<!-- switchboard:deploy-targets -->");
  });

  it("carries the table and the footer that says how it is refreshed and what merging does", () => {
    const body = commentBody(table);
    expect(body).toContain(table);
    expect(body.trimEnd().endsWith(FOOTER)).toBe(true);
    expect(FOOTER).toContain("preview snapshot");
    expect(FOOTER).toContain("gates to pass");
  });
});

describe("release target preview uses the execution selector", () => {
  it.each(["memory,bot", "all", "affected", ""])("captures %s instead of silently using affected", (targets) => {
    const directory = mkdtempSync(join(tmpdir(), "release-preview-"));
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const executable = (name: string, source: string) =>
      writeFileSync(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
    executable(
      "npm",
      `const fs=require('node:fs'); const args=process.argv.slice(2); fs.writeFileSync('arguments.json',JSON.stringify(args)); const names=['memory','bot','resident','sandbox'];const only=args.indexOf('--only');const selected=only>=0?names.filter(n=>args[only+1].split(',').includes(n)):names;console.log(JSON.stringify({profile:{selection:{workers:Object.fromEntries(names.map(n=>[n,{script:'switchboard-'+n}]))}},steps:selected.map(name=>({name,script:'switchboard-'+name})),affected:args.includes('--affected')?{markdown:'4 of 4 Workers: memory, bot, resident, sandbox'}:undefined}));`,
    );
    executable("gh", "process.exit(0)");
    try {
      const result = spawnSync(process.execPath, [resolve("scripts/deploy-targets.mjs")], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RELEASE_PR: "true",
          TARGETS: targets,
          GITHUB_REPOSITORY: "example/service",
          PR: "7",
          GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const args = JSON.parse(readFileSync(join(directory, "arguments.json"), "utf8")) as string[];
      if (targets === "memory,bot") {
        expect(args).toContain("--only");
        expect(args).toContain("memory,bot");
        expect(args).not.toContain("--affected");
        const table = readFileSync(join(directory, "targets.md"), "utf8");
        expect(table).toMatch(/resident[^\n]*skip/);
        expect(table).toMatch(/sandbox[^\n]*skip/);
      } else if (targets === "all") {
        expect(args).not.toContain("--affected");
        expect(args).not.toContain("--only");
      } else expect(args).toContain("--affected");
      const comment = readFileSync(join(directory, "comment.md"), "utf8");
      expect(comment).toContain(`Selector: \`${targets || "affected"}\``);
      expect(comment).toContain("snapshot");
      expect(comment).not.toContain("deploys exactly");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("the release preview receives the same repository override as automatic execution", async () => {
    const { parse } = await import("yaml");
    const workflow = parse(readFileSync(".github/workflows/release-please.yml", "utf8"));
    const step = workflow.jobs["release-pr-deploy-targets"].steps.find(
      (s: { run?: string }) => s.run === "npm run deploy:targets",
    );
    expect(step.env.TARGETS).toBe(workflow.jobs.deploy.with.targets);
  });
});

describe("preview selector parity with captured runtime input", () => {
  it.each([
    "",
    "affected",
    "all",
    "memory,bot",
    "bot,memory",
    "resident,sandbox",
    "memory,memory",
    "unknown",
    "memory --force",
    "bot;echo unsafe",
    "memory,",
    "memory,,bot",
    "all,bot",
    " memory",
  ])("matches actual reusable selection for %s", async (targets) => {
    const { parse } = await import("yaml");
    const workflow = parse(readFileSync(".github/workflows/deploy-production.yml", "utf8"));
    const selection = workflow.jobs.deploy.steps.find((s: { id?: string }) => s.id === "selection");
    const directory = mkdtempSync(join(tmpdir(), "target-parity-"));
    const output = join(directory, "output");
    writeFileSync(output, "");
    try {
      const runtime = spawnSync("bash", ["-e", "-c", selection.run], {
        encoding: "utf8",
        env: { ...process.env, TARGETS: targets, FORCE: "false", GITHUB_OUTPUT: output },
      });
      if (runtime.status !== 0) {
        expect(() => parseTargetSelector(targets)).toThrow();
        expect(readFileSync(output, "utf8")).toBe("");
      } else {
        expect(readFileSync(output, "utf8")).toBe(`args=${parseTargetSelector(targets).args.join(" ")}\n`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("renders only actual planned steps and rejects a contradictory plan", () => {
    const workers = { memory: {}, bot: {}, resident: {}, sandbox: {} };
    const plan = { profile: { selection: { workers } }, steps: [{ name: "memory" }, { name: "bot" }] };
    const table = releaseTargetTable(plan, parseTargetSelector("memory,bot"));
    expect(table).toMatch(/memory[^\n]*deploy/);
    expect(table).toMatch(/bot[^\n]*deploy/);
    expect(table).toMatch(/resident[^\n]*skip/);
    expect(table).toMatch(/sandbox[^\n]*skip/);
    expect(() => releaseTargetTable(plan, parseTargetSelector("all"))).toThrow("disagree");
  });

  it("a later selector edit does not mutate the captured preview", () => {
    const captured = parseTargetSelector("memory,bot");
    const later = parseTargetSelector("all");
    expect(captured.kind).toBe("only");
    expect(later.kind).toBe("all");
    expect(commentBody("table", captured)).toContain("Selector: `memory,bot`");
    expect(commentBody("table", captured)).toContain("later variable edits affect future runs");
  });
});

it("invalid captured release selector stops before plan or comment effects", () => {
  const directory = mkdtempSync(join(tmpdir(), "invalid-release-preview-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  for (const name of ["npm", "gh"])
    writeFileSync(join(bin, name), `#!${process.execPath}\nrequire('node:fs').writeFileSync('effect','unexpected');`, {
      mode: 0o755,
    });
  try {
    const result = spawnSync(process.execPath, [resolve("scripts/deploy-targets.mjs")], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RELEASE_PR: "true",
        TARGETS: "memory --force",
        GITHUB_REPOSITORY: "example/service",
        PR: "7",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("targets must be");
    expect(() => readFileSync(join(directory, "effect"))).toThrow();
    expect(() => readFileSync(join(directory, "comment.md"))).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
