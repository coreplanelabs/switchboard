import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// CI is a thin caller of the repository's own scripts. Every check a job runs
// is an `npm run <script>` a contributor or an agent can run locally with the
// same result, and nothing lives only in workflow YAML. This test is the rule:
// a `run:` step that is not `npm ci` or `npm run …` fails here before it can
// land, and every action is pinned to a commit so what CI executes is what was
// reviewed. `verify` at the root is the whole gate; the jobs split it by area
// for parallelism, and each script they name must exist.

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(new URL(p, `file://${root}`), "utf8");

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  steps: Step[];
  "runs-on": string;
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const ci = parse(read(".github/workflows/ci.yml")) as Workflow;
const rootPkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; workspaces: string[] };

const NPM_STEP = /^npm (ci( --[a-z-]+(=[^\s]+)?)*|run [a-z:-]+( -w [^\s]+)*( --[a-z-]+)*)$/;

function runLines(step: Step): string[] {
  return (step.run ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

describe("ci.yml runs only the repository's own scripts", () => {
  const jobs = Object.entries(ci.jobs);

  it("has jobs", () => {
    expect(jobs.length).toBeGreaterThan(3);
  });

  it.each(jobs)("job %s: every run step is `npm ci` or `npm run <script>`", (_name, job) => {
    for (const step of job.steps) {
      for (const line of runLines(step)) {
        expect(line, `step runs a bespoke command: ${line}`).toMatch(NPM_STEP);
      }
    }
  });

  it.each(jobs)("job %s: every `npm run` names a script that exists in the package it runs in", (_name, job) => {
    for (const step of job.steps) {
      for (const line of runLines(step)) {
        const m = /^npm run ([a-z:-]+)((?: -w [^\s]+)*)/.exec(line);
        if (!m) continue;
        const script = m[1];
        const workspaces = m[2]
          .split(/\s+-w\s+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (workspaces.length === 0) {
          expect(rootPkg.scripts, `root has no script "${script}"`).toHaveProperty(script);
        } else {
          for (const ws of workspaces) {
            const pkg = JSON.parse(read(`${ws}/package.json`)) as { scripts: Record<string, string> };
            expect(pkg.scripts, `${ws} has no script "${script}"`).toHaveProperty(script);
          }
        }
      }
    }
  });

  it.each(jobs)("job %s: every action is pinned to a full commit sha", (_name, job) => {
    for (const step of job.steps) {
      if (!step.uses) continue;
      expect(step.uses, `unpinned action: ${step.uses}`).toMatch(/@[0-9a-f]{40}( #.*)?$/);
    }
  });

  it("every npm cache keys on the single root lockfile, and Node comes from .nvmrc", () => {
    let cachingJobs = 0;
    for (const [, job] of jobs) {
      for (const step of job.steps) {
        if (!step.uses?.startsWith("actions/setup-node@")) continue;
        expect(step.with?.["node-version-file"], "setup-node must read the version from .nvmrc").toBe(".nvmrc");
        if (step.with?.cache === "npm") {
          cachingJobs++;
          expect(step.with?.["cache-dependency-path"], "an npm cache must key on package-lock.json alone").toBe("package-lock.json");
        }
      }
    }
    expect(cachingJobs).toBeGreaterThan(0);
  });

  it("runs on pull requests, pushes to main, and the merge queue", () => {
    expect(ci.on).toHaveProperty("pull_request");
    expect(ci.on).toHaveProperty("push");
    expect(ci.on).toHaveProperty("merge_group");
  });
});

describe("the verify scripts", () => {
  it("`verify` at the root fans out to the root checks and every workspace's own `verify`", () => {
    expect(rootPkg.scripts.verify).toContain("npm run verify:root");
    expect(rootPkg.scripts.verify).toContain("npm run verify --workspaces --if-present");
  });

  it("every workspace declares a `verify` script", () => {
    for (const ws of rootPkg.workspaces) {
      const pkg = JSON.parse(read(`${ws}/package.json`)) as { scripts?: Record<string, string> };
      expect(pkg.scripts?.verify, `${ws} has no verify script`).toBeTruthy();
    }
  });

  it("`verify:root` chains only scripts that exist", () => {
    const parts = rootPkg.scripts["verify:root"].split("&&").map((s) => s.trim());
    for (const part of parts) {
      const m = /^npm (run ([a-z:-]+)|test)$/.exec(part);
      expect(m, `verify:root has a non-script segment: ${part}`).not.toBeNull();
      if (m && m[2]) expect(rootPkg.scripts).toHaveProperty(m[2]);
    }
  });
});
