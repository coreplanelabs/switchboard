import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// CI is a thin caller of the repository's own scripts. Every check a job runs
// is an `npm run <script>` a contributor or an agent can run locally with the
// same result, and nothing lives only in workflow YAML. This test is the rule:
// a `run:` step that is not `npm ci` or `npm run …` fails here before it can
// land, and every action is pinned to a commit so what CI executes is what was
// reviewed. `verify` at the root is the whole gate; the jobs split it by area
// — and, since the fan-out, by check and by test shard — for parallelism, and
// each script they name must exist in the package it runs in.
//
// The branch ruleset requires status checks by NAME. A fan-out (a matrix job)
// cannot be that name, so each required name that fans out is a gate job:
// `needs:` the legs, `if: always()`, `npm run ci:gate` over the `needs`
// context. The tests below hold the gate to that shape — a gate that only runs
// on success would be skipped (and so never red) when a leg fails.

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(new URL(p, `file://${root}`), "utf8");

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  name?: string;
  steps: Step[];
  "runs-on": string;
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
  strategy?: { matrix?: Record<string, unknown[]> };
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}

// The workflows that gate a pull request. pr-title.yml is separate from ci.yml
// only because it must re-run when the title is edited (see its header); it is
// held to the same rule.
const GATE_WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/pr-title.yml"];
const ci = parse(read(".github/workflows/ci.yml")) as Workflow;
const rootPkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; workspaces: string[] };

/** The status checks `main-ci-required` requires (AGENTS.md); each must be a job's name. */
const REQUIRED_CHECKS = ["bot", "web", "docs", "workers", "image"];

// `npm test -- --shard=i/N` is the one argument a step may pass through: it
// selects a slice of the same suite, it adds nothing.
const NPM_STEP = /^npm (ci( --[a-z-]+(=[^\s]+)?)*|run [a-z:-]+( -w [^\s]+)*( --[a-z-]+)*|test( -- --shard=\d+\/\d+)?)$/;

/** Every concrete line a step runs: `${{ matrix.<key> }}` expands to each value
 *  of the job's matrix (so a matrix step is checked once per leg) and
 *  `${{ strategy.job-total }}` to the number of legs. */
function runLines(step: Step, job: Job): string[] {
  const matrix = job.strategy?.matrix ?? {};
  const legs = Object.values(matrix).reduce((n, values) => n * values.length, 1);
  const lines = (step.run ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => l.replaceAll("${{ strategy.job-total }}", String(legs)));
  return lines.flatMap((line) => expandMatrix(line, matrix));
}

function expandMatrix(line: string, matrix: Record<string, unknown[]>): string[] {
  const m = /\$\{\{ matrix\.([a-z-]+) \}\}/.exec(line);
  if (!m) return [line];
  const values = matrix[m[1]];
  if (!values) throw new Error(`${line} names matrix.${m[1]}, which the job's matrix does not define`);
  return values.flatMap((v) => expandMatrix(line.replace(m[0], String(v)), matrix));
}

const needsOf = (job: Job): string[] => (Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : []);
const isGate = (job: Job) => job.steps.some((s) => s.run?.trim() === "npm run ci:gate");

describe("the gate workflows run only the repository's own scripts", () => {
  const jobs = GATE_WORKFLOWS.flatMap((file) =>
    Object.entries((parse(read(file)) as Workflow).jobs).map(([name, job]) => [`${file} → ${name}`, job] as const),
  );

  it("has jobs", () => {
    expect(jobs.length).toBeGreaterThan(3);
  });

  it.each(jobs)("job %s: every run step is `npm ci`, `npm run <script>`, or `npm test`", (_name, job) => {
    for (const step of job.steps) {
      for (const line of runLines(step, job)) {
        expect(line, `step runs a bespoke command: ${line}`).toMatch(NPM_STEP);
      }
    }
  });

  it.each(jobs)("job %s: every `npm run` names a script that exists in the package it runs in", (_name, job) => {
    for (const step of job.steps) {
      for (const line of runLines(step, job)) {
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
          expect(step.with?.["cache-dependency-path"], "an npm cache must key on package-lock.json alone").toBe(
            "package-lock.json",
          );
        }
      }
    }
    expect(cachingJobs).toBeGreaterThan(0);
  });

  it("ci.yml runs on pull requests, pushes to main, and the merge queue", () => {
    expect(ci.on).toHaveProperty("pull_request");
    expect(ci.on).toHaveProperty("push");
    expect(ci.on).toHaveProperty("merge_group");
  });

  it("pr-title.yml re-runs when a title is edited and is present in the merge queue", () => {
    const wf = parse(read(".github/workflows/pr-title.yml")) as Workflow & {
      on: { pull_request: { types: string[] } };
    };
    // A required status must exist for the queue's merge group too, or the
    // queue waits forever on an "expected" check that never reports.
    expect(wf.on).toHaveProperty("merge_group");
    expect(wf.on.pull_request.types).toEqual(expect.arrayContaining(["opened", "edited", "synchronize", "reopened"]));
    // The job name is the identifier the branch ruleset requires.
    expect(Object.keys(wf.jobs)).toEqual(["title"]);
  });
});

describe("the required status checks and their gates", () => {
  const jobs = Object.values(ci.jobs);

  it.each(REQUIRED_CHECKS)("a job is named `%s` — the ruleset waits on that name", (check) => {
    const named = jobs.filter((j) => j.name === check);
    expect(named, `no job is named ${check}`).toHaveLength(1);
    expect(named[0].strategy?.matrix, `${check} is a matrix, so its check names would carry the leg`).toBeUndefined();
  });

  const gates = Object.entries(ci.jobs).filter(([, job]) => isGate(job));

  it("the fan-outs end in gates: bot, image and workers", () => {
    expect(gates.map(([, j]) => j.name).sort()).toEqual(["bot", "image", "workers"]);
  });

  it.each(gates)(
    "gate %s: needs existing jobs, runs even when a leg failed, and judges the needs context",
    (_id, job) => {
      const needs = needsOf(job);
      expect(needs.length).toBeGreaterThan(0);
      for (const id of needs) expect(ci.jobs, `gate needs unknown job ${id}`).toHaveProperty(id);
      // `if: always()` is what makes a failed leg turn the gate RED instead of
      // leaving it skipped — a skipped required check never reports.
      expect(job.if).toMatch(/always\(\)/);
      expect(job.env?.NEEDS).toBe("${{ toJSON(needs) }}");
    },
  );

  it.each(gates)("gate %s: stands for every leg the ruleset used to require in one job", (_id, job) => {
    // Each needed job is a fan-out or a single job that runs real scripts; the
    // gate itself runs nothing but ci:gate (no work hides behind a green gate).
    const runSteps = job.steps.filter((s) => s.run);
    expect(runSteps.map((s) => s.run?.trim())).toEqual(["npm run ci:gate"]);
    for (const id of needsOf(job)) {
      const leg = ci.jobs[id];
      expect(
        leg.steps.some((s) => /^npm (run |test)/.test(s.run?.trim() ?? "")),
        `${id} runs no script`,
      ).toBe(true);
    }
  });
});

describe("the test shards", () => {
  const SHARD_STEP = "npm test -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}";
  const shards = Object.entries(ci.jobs).filter(([, job]) => job.steps.some((s) => s.run?.includes("--shard=")));

  it("one job shards the vitest suite", () => {
    expect(shards).toHaveLength(1);
  });

  it("the shard index comes from the matrix and the count from the matrix length — N lives in one place", () => {
    const [, job] = shards[0];
    expect(job.steps.map((s) => s.run?.trim()).filter((r) => r?.includes("--shard="))).toEqual([SHARD_STEP]);
    const legs = job.strategy?.matrix?.shard ?? [];
    expect(legs.length).toBeGreaterThan(1);
    expect(legs).toEqual(legs.map((_, i) => i + 1)); // 1..N, each file in exactly one shard
    expect(Object.keys(job.strategy?.matrix ?? {})).toEqual(["shard"]); // job-total IS the shard count
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

  it.each(["verify:root", "check:consistency"])("`%s` chains only scripts that exist", (name) => {
    const parts = rootPkg.scripts[name].split("&&").map((s) => s.trim());
    for (const part of parts) {
      const m = /^npm (run ([a-z:-]+)|test)$/.exec(part);
      expect(m, `${name} has a non-script segment: ${part}`).not.toBeNull();
      if (m && m[2]) expect(rootPkg.scripts).toHaveProperty(m[2]);
    }
  });

  it("CI's bot legs together run exactly what `verify:root` runs locally", () => {
    // The fan-out is a split of verify:root, never a subset of it or a superset
    // with checks that only CI runs.
    const local = rootPkg.scripts["verify:root"]
      .split("&&")
      .map((s) =>
        s
          .trim()
          .replace(/^npm run /, "")
          .replace(/^npm test$/, "test"),
      )
      .sort();
    const gate = Object.values(ci.jobs).find((j) => j.name === "bot")!;
    const ran: string[] = [];
    for (const id of needsOf(gate)) {
      const leg = ci.jobs[id];
      for (const step of leg.steps) {
        for (const line of runLines(step, leg)) {
          const m = /^npm (?:run ([a-z:-]+)|(test))/.exec(line);
          if (m) ran.push(m[1] ?? m[2]);
        }
      }
    }
    expect([...new Set(ran)].sort()).toEqual(local);
  });
});

describe("the image check builds every image the deploy builds", () => {
  // 2026-09-08, release 1.2.0: the resident's Dockerfile gained a RUN whose
  // last command exited 1, and the first build of that image was the production
  // deploy — CI's `check:image` built the bot image alone. The rule: an image
  // is whatever a Worker's wrangler template points `image` at, and every such
  // Worker builds it with its own `check:image` (from the context wrangler
  // uses) and has one leg of the fan-out under the `image` gate. The set is
  // DERIVED from the templates, so a new Worker with an image fails here until
  // it has both — and a Worker without an image must not claim the script, or
  // the root `check:image` (every workspace's, `--if-present`) would run it.
  const workerDirs = readdirSync(new URL("deploy", `file://${root}`), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(new URL(`deploy/${d.name}/package.json`, `file://${root}`)))
    .map((d) => `deploy/${d.name}`);
  const scriptsOf = (dir: string) =>
    (JSON.parse(read(`${dir}/package.json`)) as { scripts?: Record<string, string> }).scripts ?? {};

  /** The Workers whose wrangler template names an image, with the Dockerfile's
   *  directory — what wrangler builds — relative to the Worker's directory. */
  const images = workerDirs.flatMap((dir) => {
    const template = `${dir}/wrangler.template.jsonc`;
    if (!existsSync(new URL(template, `file://${root}`))) return [];
    const m = /"image":\s*"([^"]+)"/.exec(read(template));
    if (!m) return [];
    const dockerfile = path.normalize(path.join(dir, m[1]));
    const context = path.relative(dir, path.dirname(dockerfile)) || ".";
    return [{ dir, context, dockerfile }];
  });
  const withoutImage = workerDirs.filter((dir) => !images.some((i) => i.dir === dir));

  it("finds the Workers with an image: the bot (the root Dockerfile), the resident and the sandbox", () => {
    expect(images.map((i) => `${i.dir} ← ${i.context}`).sort()).toEqual([
      "deploy/cloudflare ← ../..",
      "deploy/cloudflare-resident ← .",
      "deploy/cloudflare-sandbox ← .",
    ]);
    for (const i of images) expect(existsSync(new URL(i.dockerfile, `file://${root}`)), i.dockerfile).toBe(true);
    expect(withoutImage).toEqual(["deploy/cloudflare-docs", "deploy/cloudflare-memory"]);
  });

  it.each(images)(
    "$dir: `check:image` builds the Dockerfile wrangler deploys, from the same context",
    ({ dir, context }) => {
      expect(scriptsOf(dir)["check:image"]).toBe(`docker build --quiet ${context}`);
    },
  );

  it.each(withoutImage)("$0 has no image and no `check:image`", (dir) => {
    expect(scriptsOf(dir)).not.toHaveProperty("check:image");
  });

  it("the root `check:image` runs every workspace's own — the local command is the whole CI check", () => {
    expect(rootPkg.scripts["check:image"]).toBe("npm run check:image --workspaces --if-present");
  });

  it("the `image` gate fans out to one leg per image, and nothing else builds an image", () => {
    const gate = Object.values(ci.jobs).find((j) => j.name === "image")!;
    expect(isGate(gate)).toBe(true);
    const built: string[] = [];
    for (const id of needsOf(gate)) {
      const leg = ci.jobs[id];
      expect(leg.strategy?.matrix?.worker, `${id} is not a matrix over the Workers`).toBeDefined();
      for (const step of leg.steps) {
        for (const line of runLines(step, leg)) {
          const m = /^npm run check:image -w (\S+)$/.exec(line);
          if (m) built.push(m[1]);
        }
      }
    }
    expect(built.sort()).toEqual(images.map((i) => i.dir).sort());
    // No job outside the fan-out builds an image: the gate is the one place.
    const elsewhere = Object.entries(ci.jobs)
      .filter(([id]) => !needsOf(gate).includes(id))
      .flatMap(([, job]) => job.steps.flatMap((s) => runLines(s, job)))
      .filter((line) => /check:image/.test(line));
    expect(elsewhere).toEqual([]);
  });
});
