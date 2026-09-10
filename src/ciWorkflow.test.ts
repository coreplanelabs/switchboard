import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { DOCKERFILES, IMAGE_KINDS, VERSION, type ImageKind } from "./deploy/images.js";
import { WORKER_DIRS } from "./deploy/plan.js";

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
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
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
const REQUIRED_CHECKS = ["bot", "web", "docs", "workers", "image", "package"];

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

describe("the auto-approve workflow names no installation", () => {
  // The workflow that turns a review App's `LGTM:` verdict into an approval
  // is a working workflow for an installation that opts in and an inert
  // template for everyone else: which App it trusts comes from two repository
  // variables, and the job does not run while either is unset. The file
  // itself carries no bot login and no numeric user id — those are the
  // installation's, and this test is what keeps them out.
  const file = ".github/workflows/auto-approve-review-lgtm.yml";
  const text = read(file);
  const workflow = parse(text) as Workflow & { permissions?: unknown };

  it("parses, with an empty top-level permissions block and one job", () => {
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs)).toHaveLength(1);
  });

  it("the job runs only when both repository variables are set and match the reviewer", () => {
    const [job] = Object.values(workflow.jobs);
    expect(job.if).toContain("vars.REVIEW_BOT_LOGIN != ''");
    expect(job.if).toContain("vars.REVIEW_BOT_ID != ''");
    expect(job.if).toContain("github.event.review.user.login == vars.REVIEW_BOT_LOGIN");
    expect(job.if).toContain("format('{0}', github.event.review.user.id) == vars.REVIEW_BOT_ID");
    expect(job.if).toContain("startsWith(github.event.review.body, 'LGTM:')");
  });

  it("carries no bot login literal and no numeric user id", () => {
    expect(text).not.toMatch(/\[bot\]/);
    expect(text).not.toMatch(/\b\d{6,}\b/);
  });
});

describe("the release publishes the bot image", () => {
  // Every release pushes the three images — the bot's from the root Dockerfile,
  // the resident's and the sandbox's from their Worker directories — to GitHub
  // Container Registry with build provenance and an SBOM (release-and-deploy.md
  // item 21), one matrix leg each. The job runs only on a release, under the
  // least permission that can push a package — granted to that job, never to the
  // workflow, whose other jobs act as the release App — and names each image
  // from the repository plus the Worker's suffix, so a fork publishes under its
  // own owner without editing the file and project.json's `images` (held to the
  // same rule by check:project-facts) are the names it pushes.
  const file = ".github/workflows/release-please.yml";
  const text = read(file);
  const workflow = parse(text) as Workflow & { permissions?: Record<string, string> };
  const publish = Object.entries(workflow.jobs).filter(([, job]) =>
    job.steps?.some((s) => s.uses?.startsWith("docker/build-push-action@")),
  );
  const [id, job] = publish[0] ?? [];
  const step = (prefix: string) => job.steps.find((s) => s.uses?.startsWith(prefix));
  const facts = JSON.parse(read("project.json")) as { repository: string; images: Record<ImageKind, string> };
  const matrix = (job.strategy?.matrix?.image ?? []) as { name: string; context: string; suffix: string }[];

  it("one job builds and pushes, gated on release-please reporting a release", () => {
    expect(publish.map(([id]) => id)).toEqual(["publish-image"]);
    expect(needsOf(job)).toEqual(["release-please"]);
    expect(job.if).toBe("needs.release-please.outputs.release_created == 'true'");
  });

  it("one leg per image, each from the context its `check:image` builds, named `ghcr.io/<repository>` plus the suffix project.json records — no leg fails the others", () => {
    expect(job.strategy).toMatchObject({ "fail-fast": false });
    expect(matrix.map((m) => m.name)).toEqual([...IMAGE_KINDS]);
    for (const leg of matrix) {
      const kind = leg.name as ImageKind;
      // The Dockerfile's directory, repo-relative — the context `image-each` builds it from.
      expect(leg.context).toBe(path.normalize(path.join(WORKER_DIRS[kind], path.dirname(DOCKERFILES[kind]))));
      const repository = new URL(facts.repository).pathname.toLowerCase();
      expect(`ghcr.io${repository}${leg.suffix}`).toBe(facts.images[kind]);
    }
  });

  it("`packages: write` and the attestation scopes are the job's alone; the workflow stays read-only", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect((job as Job & { permissions?: Record<string, string> }).permissions).toEqual({
      contents: "read",
      packages: "write",
      "id-token": "write",
      attestations: "write",
    });
    for (const [otherId, other] of Object.entries(workflow.jobs)) {
      if (otherId === id) continue;
      const perms = (other as Job & { permissions?: Record<string, string> }).permissions ?? {};
      expect(perms, `${otherId} may write packages`).not.toHaveProperty("packages");
    }
  });

  it("builds each leg's Dockerfile from its matrix context with provenance and an SBOM, and pushes", () => {
    const build = step("docker/build-push-action@")!;
    expect(build.with?.context).toBe("${{ matrix.image.context }}");
    expect(build.with?.push).toBe(true);
    expect(build.with?.provenance).toBe("mode=max");
    expect(build.with?.sbom).toBe(true);
    expect(build.with).not.toHaveProperty("file"); // the context's own Dockerfile, the one wrangler (and compose) build
  });

  it("the bot's leg writes build.json from the release commit between the checkout and the build — the stamp /healthz serves and the live gate compares; the Worker legs stamp at deploy time", () => {
    const stamp = job.steps.find((s) => s.run?.trim() === "node deploy/cloudflare/write-build.mjs");
    expect(stamp, "no step runs deploy/cloudflare/write-build.mjs").toBeDefined();
    expect(stamp!.if).toBe("matrix.image.name == 'bot'");
    expect((stamp as Step & { env?: Record<string, string> }).env).toEqual({
      SWITCHBOARD_BUILD_COMMIT: "${{ github.sha }}",
    });
    const at = (s: Step) => job.steps.indexOf(s);
    expect(at(stamp!)).toBeGreaterThan(at(step("actions/checkout@")!));
    expect(at(stamp!)).toBeLessThan(at(step("docker/build-push-action@")!));
  });

  it("names each image from the repository, lowercased, plus the leg's suffix — never from a literal owner", () => {
    // Outside comments, `ghcr.io/` appears only followed by the lowercased repository variable and the suffix.
    const code = text
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    const names = [...code.matchAll(/ghcr\.io\/([^\s"']+)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toBe("${GITHUB_REPOSITORY,,}${SUFFIX}");
    const build = step("docker/build-push-action@")!;
    const tags = String(build.with?.tags)
      .split("\n")
      .filter((t) => t.trim());
    expect(tags).toEqual([
      "${{ steps.image.outputs.name }}:${{ steps.image.outputs.version }}",
      "${{ steps.image.outputs.name }}:latest",
    ]);
    // The version tag is the release tag without its `v`, from release-please's output; the suffix is the leg's.
    const name = job.steps.find((s) => (s as Step & { id?: string }).id === "image")!;
    expect(name.run).toContain("version=${TAG#v}");
    expect((name as Step & { env?: Record<string, string> }).env).toEqual({
      TAG: "${{ needs.release-please.outputs.tag_name }}",
      SUFFIX: "${{ matrix.image.suffix }}",
    });
  });

  it("logs in to ghcr.io with GITHUB_TOKEN and attests the pushed digest into the registry", () => {
    const login = step("docker/login-action@")!;
    expect(login.with?.registry).toBe("ghcr.io");
    expect(login.with?.password).toBe("${{ secrets.GITHUB_TOKEN }}");
    const attest = step("actions/attest-build-provenance@")!;
    expect(attest.with?.["subject-name"]).toBe("${{ steps.image.outputs.name }}");
    expect(attest.with?.["subject-digest"]).toBe("${{ steps.build.outputs.digest }}");
    expect(attest.with?.["push-to-registry"]).toBe(true);
  });

  it("retries the attestation once, on the same pushed digest, never rebuilding — a success on the first never runs the retry — and neither step asks for a storage record", () => {
    // The images are not reproducible: a re-run of the leg pushes a different digest and leaves an unattested
    // orphan, so the retry is a second attest step against `steps.build.outputs.digest` in the same job.
    const attests = job.steps.filter((s) => s.uses?.startsWith("actions/attest-build-provenance@")) as (Step & {
      id?: string;
      "continue-on-error"?: boolean;
    })[];
    expect(attests).toHaveLength(2);
    const [first, retry] = attests;
    expect(first.id).toBe("attest");
    expect(first["continue-on-error"]).toBe(true);
    expect(first.if).toBeUndefined();
    expect(retry.id).toBe("attest-retry");
    expect(retry.if).toBe("steps.attest.outcome == 'failure'");
    expect(retry["continue-on-error"]).toBeUndefined();
    expect(retry.uses).toBe(first.uses);
    expect(retry.with).toEqual(first.with);
    for (const a of attests) {
      expect(a.with?.["subject-digest"]).toBe("${{ steps.build.outputs.digest }}");
      // The storage record needs a permission the job does not grant and buys nothing the registry copy does not.
      expect(a.with?.["create-storage-record"]).toBe(false);
    }
    // One build per leg, and the retry follows the first attempt directly.
    expect(job.steps.filter((s) => s.uses?.startsWith("docker/build-push-action@"))).toHaveLength(1);
    expect(job.steps.indexOf(retry)).toBe(job.steps.indexOf(first) + 1);
    // The steps are the same for every leg: nothing in them names a matrix value, so each image gets the retry.
    for (const leg of matrix) {
      expect(leg.name).toBeTruthy();
      for (const a of attests) expect(JSON.stringify(a.with)).not.toContain("matrix.");
    }
    const said = job.steps.find((s) => s.if === "always() && steps.attest.outcome == 'failure'")!;
    expect(said.run).toContain("::warning");
    expect(said.run).toContain("steps.attest-retry.outcome");
  });

  it("every action in the workflow is pinned to a full commit sha", () => {
    for (const j of Object.values(workflow.jobs)) {
      for (const s of j.steps ?? []) {
        if (!s.uses || s.uses.startsWith("./")) continue;
        expect(s.uses, `unpinned action: ${s.uses}`).toMatch(/@[0-9a-f]{40}( #.*)?$/);
      }
    }
  });
});

describe("the release publishes the npm package", () => {
  // The same release publishes the CLI to npm under `npmPackage`
  // (docs/reference/specs/packaging.md item 5): gated on release-please
  // reporting a release like the image job, `id-token: write` for npm's trusted
  // publishing (the run's OIDC identity is the credential — no token, nothing
  // expires) and nothing more, the package built by its own script, and
  // `--provenance` only while the repository is public.
  const file = ".github/workflows/release-please.yml";
  const workflow = parse(read(file)) as Workflow & { permissions?: Record<string, string> };
  const PUBLISH_LINE =
    "npm publish --workspace packages/switchboard --access public ${{ github.event.repository.private == false && '--provenance' || '' }}";
  const publish = Object.entries(workflow.jobs).filter(([, job]) =>
    job.steps?.some((s) => /^npm publish\b/.test(s.run?.trim() ?? "")),
  );
  const [, job] = publish[0] ?? [];
  const runs = () => job.steps.map((s) => s.run?.trim()).filter((r): r is string => !!r);

  it("one job publishes, gated on release-please reporting a release AND the owner's switch — the repository variable SWITCHBOARD_PUBLISH_NPM set to 'true'", () => {
    expect(publish.map(([id]) => id)).toEqual(["publish-npm"]);
    expect(needsOf(job)).toEqual(["release-please"]);
    expect(job.if).toBe(
      "needs.release-please.outputs.release_created == 'true' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) && vars.SWITCHBOARD_PUBLISH_NPM == 'true'",
    );
  });

  it("nothing else in any workflow runs `npm publish`, and a release with the switch off says so in one line", () => {
    // Every `run:` of every job of every workflow, as YAML sees it: a command line that starts
    // with `npm publish` (a prose mention in a notice or a comment is not a command).
    const dir = new URL(".github/workflows/", `file://${root}`);
    const commands = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .flatMap((f) =>
        Object.entries((parse(read(`.github/workflows/${f}`)) as Workflow).jobs ?? {}).flatMap(([id, j]) =>
          (j.steps ?? []).flatMap((s) =>
            (s.run ?? "")
              .split("\n")
              .filter((line) => /^\s*npm publish\b/.test(line))
              .map((line) => ({ f, id, line: line.trim() })),
          ),
        ),
      );
    expect(commands).toEqual([
      {
        f: "release-please.yml",
        id: "publish-npm",
        line: PUBLISH_LINE,
      },
    ]);
    const off = workflow.jobs["release-please"].steps.find((s) => s.name === "npm publish is off")!;
    // The notice fires when EITHER switch is off: the variable, or a release cut off the default branch.
    expect(off.if).toContain("vars.SWITCHBOARD_PUBLISH_NPM != 'true'");
    expect(off.if).toContain("github.ref != format('refs/heads/{0}', github.event.repository.default_branch)");
    expect(off.if).toContain("release_created");
    expect(off.run).toContain("${{ github.ref_name }}");
    expect(off.run).toContain("::notice");
    expect(off.run).toContain("SWITCHBOARD_PUBLISH_NPM");
  });

  it("holds `contents: read` and `id-token: write` alone — provenance needs the OIDC token, nothing else is granted", () => {
    expect((job as Job & { permissions?: Record<string, string> }).permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
  });

  it("upgrades npm to a trusted-publishing release, installs from the lockfile, builds the package with its own script, and publishes it public — with provenance only while the repository is public", () => {
    expect(runs()).toEqual([
      "npm install -g npm@11.19.1",
      "npm ci",
      "npm run build -w packages/switchboard",
      PUBLISH_LINE,
    ]);
    // npm signs provenance for public sources alone: the flag is an expression on the repository's visibility.
    expect(PUBLISH_LINE).toContain("${{ github.event.repository.private == false && '--provenance' || '' }}");
    // Node from .nvmrc; no registry-url — setup-node would write an .npmrc naming an auth token this job does not have.
    const setup = job.steps.find((s) => s.uses?.startsWith("actions/setup-node@"))!;
    expect(setup.with?.["node-version-file"]).toBe(".nvmrc");
    expect(setup.with?.["registry-url"]).toBeUndefined();
    const step = job.steps.find((s) => /^npm publish\b/.test(s.run?.trim() ?? "")) as Step & {
      env?: Record<string, string>;
    };
    expect(step.env).toBeUndefined();
  });

  it("no npm token anywhere: trusted publishing means no workflow names one", () => {
    const dir = new URL(".github/workflows/", `file://${root}`);
    for (const f of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)))
      expect(read(`.github/workflows/${f}`), f).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });
});

describe("the image check builds every image the deploy builds", () => {
  // A Dockerfile RUN whose last command exits non-zero fails only when the
  // image is built, and if CI builds the bot image alone the first build of any
  // other Worker's image is the production deploy. The rule: a Worker with an
  // image is one whose wrangler template renders `{{image}}` — in `build` mode
  // the Dockerfile `DOCKERFILES` names for it (src/deploy/images.ts), the one
  // wrangler builds — and every such Worker builds it with its own
  // `check:image` (from the context wrangler uses) and has one leg of the
  // fan-out under the `image` gate. The set is DERIVED from the templates, so a
  // new Worker with an image fails here until it has both — and a Worker
  // without an image must not claim the script, or the root `check:image`
  // (every workspace's, `--if-present`) would run it.
  const workerDirs = readdirSync(new URL("deploy", `file://${root}`), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(new URL(`deploy/${d.name}/package.json`, `file://${root}`)))
    .map((d) => `deploy/${d.name}`);
  const scriptsOf = (dir: string) =>
    (JSON.parse(read(`${dir}/package.json`)) as { scripts?: Record<string, string> }).scripts ?? {};

  /** The Workers whose wrangler template renders an image, with the Dockerfile's
   *  directory — what wrangler builds in `build` mode — relative to the Worker's directory. */
  const images = workerDirs.flatMap((dir) => {
    const template = `${dir}/wrangler.template.jsonc`;
    if (!existsSync(new URL(template, `file://${root}`))) return [];
    if (!/"image":\s*"\{\{image\}\}"/.test(read(template))) return [];
    const kind = (Object.keys(WORKER_DIRS) as ImageKind[]).find((k) => WORKER_DIRS[k] === dir);
    if (kind === undefined || !(IMAGE_KINDS as readonly string[]).includes(kind))
      throw new Error(`${template} renders {{image}} but ${dir} is not one of IMAGE_KINDS`);
    const dockerfile = path.normalize(path.join(dir, DOCKERFILES[kind]));
    const context = path.relative(dir, path.dirname(dockerfile)) || ".";
    return [{ dir, context, dockerfile }];
  });
  const withoutImage = workerDirs.filter((dir) => !images.some((i) => i.dir === dir));

  it("finds the Workers with an image: the bot (the root Dockerfile), the resident and the sandbox — every IMAGE_KIND, and no other", () => {
    expect(images.map((i) => `${i.dir} ← ${i.context}`).sort()).toEqual([
      "deploy/cloudflare ← ../..",
      "deploy/cloudflare-resident ← .",
      "deploy/cloudflare-sandbox ← .",
    ]);
    expect(images.map((i) => i.dir).sort()).toEqual(IMAGE_KINDS.map((k) => WORKER_DIRS[k]).sort());
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

describe("the production deploy is one reusable workflow", () => {
  // deploy-production.yml is called three ways — by release-please.yml when a
  // release is cut, by a maintainer's dispatch from main, and by an operator's
  // own repository (release-and-deploy.md item 27) — and runs the registry's
  // `deploy images` / `deploy plan` / `deploy all` through one command word,
  // `$CLI`: the checked-out tree's CLI (`checkout`, this repository's release)
  // or the published package at one version (`package`, an operator with no
  // checkout of this repository). These tests hold the two modes apart —
  // nothing of this repository is fetched or `npm`-run in `package` mode, and
  // `checkout` mode runs the commands it ran before the workflow was reusable
  // plus the one mode-safe copy — and hold the copy to its place and its switch.
  const file = ".github/workflows/deploy-production.yml";
  const text = read(file);
  interface DeployStep extends Step {
    id?: string;
    env?: Record<string, string>;
  }
  interface Trigger {
    inputs: Record<string, { type: string; default: unknown; description: string }>;
    secrets?: Record<string, { required: boolean }>;
  }
  const workflow = parse(text) as Workflow & {
    on: { workflow_call: Trigger; workflow_dispatch: Trigger };
    permissions?: Record<string, string>;
  };
  const job = workflow.jobs.deploy as Job & { permissions?: Record<string, string> };
  const steps = job.steps as DeployStep[];
  const facts = JSON.parse(read("project.json")) as { npmPackage: string };
  const cliPkg = JSON.parse(read("packages/switchboard/package.json")) as { engines: { node: string } };

  /** The step's `if` decides which mode it runs in; a step without one runs in both. */
  const modeOf = (s: Step): "checkout" | "package" | "both" =>
    s.if?.includes("inputs.cli != 'package'")
      ? "checkout"
      : s.if?.includes("inputs.cli == 'package'")
        ? "package"
        : "both";
  const checkoutSteps = steps.filter((s) => modeOf(s) !== "package");
  const packageSteps = steps.filter((s) => modeOf(s) !== "checkout");
  const lines = (s: Step) => runLines(s, job);
  /** A line that runs something (not an `echo` or a test of a variable). */
  const isCommand = (line: string) => !/^(echo |if \[|\*\)|[a-z|"]+\) echo )/.test(line);
  const cliStep = steps.find((s) => s.id === "cli")!;
  const cliValues = [...(cliStep.run ?? "").matchAll(/echo "cli=([^"]+)" >> "\$GITHUB_OUTPUT"/g)].map((m) => m[1]);
  const checkouts = steps.filter((s) => s.uses?.startsWith("actions/checkout@"));

  it("is callable with the inputs a caller needs, each defaulting to this repository's own call", () => {
    const inputs = workflow.on.workflow_call.inputs;
    expect(Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.default]))).toEqual({
      targets: "affected",
      force: false,
      profile: "",
      cli: "checkout",
      version: "",
      "copy-images": "auto",
    });
    // A dispatch keeps the two operator-facing choices it always had; the rest default as above.
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(["targets", "force"]);
    for (const k of ["targets", "force"]) expect(workflow.on.workflow_dispatch.inputs[k]).toEqual(inputs[k]);
  });

  it("declares every secret by name so another repository can pass them, none required — `secrets: inherit` still works", () => {
    const secrets = workflow.on.workflow_call.secrets!;
    expect(Object.keys(secrets).sort()).toEqual([
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_DEPLOY_TOKEN",
      "CONFIG_REPO_APP_CLIENT_ID",
      "CONFIG_REPO_APP_PRIVATE_KEY",
      "MEMORY_TOKEN",
      "RESIDENT_READ_TOKEN",
      "SANDBOX_TOKEN",
    ]);
    for (const [name, s] of Object.entries(secrets)) expect(s.required, `${name} must be optional`).toBe(false);
    // The App that reads a `github://` profile is handed in as the two secrets — from nowhere else.
    expect(job.env).not.toHaveProperty("LOAD_APP_FROM_VAULT");
    const mint = job.steps.find((s) => s.uses?.startsWith("actions/create-github-app-token@"))!;
    expect(mint.if).toBe("vars.CONFIG_REPO_NAME != ''");
    expect(mint.with?.["client-id"]).toBe("${{ secrets.CONFIG_REPO_APP_CLIENT_ID }}");
    expect(mint.with?.["private-key"]).toBe("${{ secrets.CONFIG_REPO_APP_PRIVATE_KEY }}");
  });

  it("no workflow reaches into a vault: no 1Password action, no `op://` reference, no OP_SERVICE_ACCOUNT_TOKEN — an org secret scoped to private repositories vanished the day the repository went public", () => {
    const dir = new URL(".github/workflows/", `file://${root}`);
    for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
      const text = read(`.github/workflows/${f}`);
      const code = text
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"))
        .join("\n");
      expect(code, `${f} names the vault token`).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
      expect(code, `${f} loads from 1Password`).not.toContain("1password/");
      expect(code, `${f} carries an op:// reference`).not.toMatch(/op:\/\/[A-Za-z]/);
      // Every App token is minted from the two repository secrets, never from an env the run filled.
      const wf = parse(text) as Workflow;
      for (const j of Object.values(wf.jobs ?? {})) {
        for (const s of j.steps ?? []) {
          if (!s.uses?.startsWith("actions/create-github-app-token@")) continue;
          expect(s.with?.["client-id"], `${f}: an App minted from something other than the secret`).toBe(
            "${{ secrets.CONFIG_REPO_APP_CLIENT_ID }}",
          );
          expect(s.with?.["private-key"]).toBe("${{ secrets.CONFIG_REPO_APP_PRIVATE_KEY }}");
        }
      }
    }
  });

  it("the profile is the `profile` input, else the calling repository's variable", () => {
    expect(job.env?.SWITCHBOARD_DEPLOY_PROFILE).toBe("${{ inputs.profile || vars.SWITCHBOARD_DEPLOY_PROFILE }}");
  });

  it("one command word: the checkout's CLI, or the published package at an explicit version — never `latest`", () => {
    expect(cliValues).toEqual(["npm run --silent cli --", `npx --yes ${facts.npmPackage}@$v`]);
    // The version: the input, else the caller's tag without its `v`; anything else refuses before a checkout.
    expect(cliStep.run).toContain('v="${REF_NAME#v}"');
    expect(cliStep.run).toContain('[ "$REF_TYPE" = "tag" ]');
    expect(cliStep.run).not.toMatch(/latest/);
    expect(cliStep.env).toMatchObject({
      MODE: "${{ inputs.cli }}",
      VERSION: "${{ inputs.version }}",
      REF_TYPE: "${{ github.ref_type }}",
      REF_NAME: "${{ github.ref_name }}",
    });
    // Every deploy command in every step goes through it.
    for (const s of steps) {
      for (const line of lines(s).filter(isCommand)) {
        if (/\bdeploy (plan|all|images)\b/.test(line)) {
          expect(line, `a deploy command not routed through $CLI: ${line}`).toMatch(/\$CLI deploy /);
          expect(s.env?.CLI).toBe("${{ steps.cli.outputs.cli }}");
        }
      }
    }
    for (const c of checkouts) expect(steps.indexOf(cliStep)).toBeLessThan(steps.indexOf(c));
    // The version is judged by the release-tag rule the CLI holds (src/deploy/images.ts `VERSION`), in shell.
    const shell = VERSION.source.replaceAll("\\d", "[0-9]").replaceAll("(?:", "(");
    expect(cliStep.run).toContain(`[[ "$v" =~ ${shell} ]]`);
    expect(cliStep.run).not.toMatch(/\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*\)/);
  });

  it("a `github://` profile with CONFIG_REPO_NAME set and no App credentials is refused by name before the mint", () => {
    expect(job.env?.HAS_APP_CREDENTIALS).toBe("${{ secrets.CONFIG_REPO_APP_CLIENT_ID != '' }}");
    const refusal = steps.find((s) => s.name === "the configuration repository needs the App")!;
    expect(refusal.if).toBe("vars.CONFIG_REPO_NAME != '' && env.HAS_APP_CREDENTIALS != 'true'");
    expect(refusal.run).toContain("::error::");
    expect(refusal.run).toContain("CONFIG_REPO_NAME");
    expect(refusal.run).toContain("CONFIG_REPO_APP_CLIENT_ID");
    expect(refusal.run).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
    expect(refusal.run).toContain("exit 1");
    const mint = steps.find((s) => s.uses?.startsWith("actions/create-github-app-token@"))!;
    expect(steps.indexOf(refusal)).toBeLessThan(steps.indexOf(mint));
  });

  it("`package` mode fetches nothing of this repository and runs no npm script of it", () => {
    // Every checkout is the CALLING repository (no `repository:`, no `ref:`). The checkout-mode one is the tree
    // `deploy all` deploys and needs the history `--affected` diffs against; the package-mode one exists only for a
    // profile that is a path inside the calling repository, and is shallow — there is no tree to judge.
    expect(checkouts).toHaveLength(2);
    const [tree, profileOnly] = checkouts;
    for (const c of checkouts) {
      expect(c.with ?? {}).not.toHaveProperty("repository");
      expect(c.with ?? {}).not.toHaveProperty("ref");
    }
    expect(tree.if).toBe("inputs.cli != 'package'");
    expect(tree.with).toEqual({ "fetch-depth": 0, "fetch-tags": true });
    expect(profileOnly.if).toBe(
      "inputs.cli == 'package' && !(startsWith(env.SWITCHBOARD_DEPLOY_PROFILE, 'github://') || startsWith(env.SWITCHBOARD_DEPLOY_PROFILE, 'op://'))",
    );
    expect(profileOnly.with ?? {}).not.toHaveProperty("fetch-depth");
    expect(profileOnly.with ?? {}).not.toHaveProperty("fetch-tags");
    for (const s of packageSteps) {
      if (s === profileOnly) continue;
      for (const line of lines(s))
        expect(line, `${s.name ?? s.uses} runs npm in package mode: ${line}`).not.toMatch(/^npm\b/);
      expect(s.run ?? "", `${s.name} reads the tree in package mode`).not.toMatch(/\bgit\b/);
    }
    // Node comes from the CLI's own `engines`, not from a `.nvmrc` there is no checkout of; no lockfile, no cache.
    const setup = steps.filter((s) => s.uses?.startsWith("actions/setup-node@"));
    expect(setup.map(modeOf)).toEqual(["checkout", "package"]);
    expect(setup[0].with).toEqual({ "node-version-file": ".nvmrc", cache: "npm" });
    const minimum = /^>=(\d+)$/.exec(cliPkg.engines.node)![1];
    expect(setup[1].with).toEqual({ "node-version": Number(minimum) });
    // The main-only guard guards a tree; a published version has none.
    const guard = steps.find((s) => s.name === "only from main")!;
    expect(guard.if).toBe("inputs.cli != 'package' && github.ref != 'refs/heads/main'");
  });

  it("`checkout` mode runs the commands it ran before the workflow was reusable, in order, plus the one copy the profile answers", () => {
    const [checkoutCli] = cliValues;
    const rendered = checkoutSteps.flatMap((s) =>
      lines(s)
        .filter(isCommand)
        .map((l) => l.replaceAll("$CLI", checkoutCli)),
    );
    expect(rendered.filter((l) => /^(npm|git)\b|npm run --silent cli/.test(l))).toEqual([
      "npm ci",
      "npm run --silent cli -- deploy images",
      'npm run --silent cli -- deploy plan $ARGS --allow-branch --json > "$RUNNER_TEMP/plan.json"',
      'npm run --silent cli -- deploy plan $ARGS --allow-branch | tee "$RUNNER_TEMP/plan.txt"',
      "git status --porcelain",
      "npm run --silent cli -- deploy all $ARGS --allow-branch",
      'if ! npm run --silent cli -- deploy plan --allow-branch --json > "$RUNNER_TEMP/fleet.json" 2> "$RUNNER_TEMP/fleet.err"; then',
    ]);
    expect(checkoutSteps.filter((s) => s.run).map((s) => s.name)).toEqual([
      "only from main",
      "the CLI",
      undefined, // npm ci
      "the configuration repository needs the App",
      "the credentials this run has",
      "the selection",
      "copy the release's images into the account registry",
      "plan",
      "the tree is the commit",
      "deploy",
      "what is live",
    ]);
  });

  it("`deploy images` runs before the plan — a pre-warm; `deploy all` would copy the same images itself — unless `copy-images` is `never`", () => {
    const copy = steps.find((s) => /deploy images/.test(s.run ?? ""))!;
    expect(copy.if).toBe("inputs.copy-images != 'never'");
    expect(lines(copy)).toEqual(["$CLI deploy images"]);
    expect(steps.indexOf(copy)).toBeLessThan(steps.findIndex((s) => s.name === "plan"));
    expect(steps.indexOf(copy)).toBeGreaterThan(steps.indexOf(cliStep));
    // The value is validated before anything runs, and a dispatch (no such input) behaves as `auto`.
    expect(cliStep.run).toContain('auto|never|"") ;;');
  });

  it("keeps its shape: one job, `contents: read` at both levels, `environment: production`, the one concurrency group, every action pinned", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["deploy"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job).toMatchObject({
      environment: "production",
      concurrency: { group: "deploy-production", "cancel-in-progress": false },
    });
    // The parser drops the comment, so the pin AND its version note are read from the text.
    const uses = text.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
    expect(uses.length).toBe(steps.filter((s) => s.uses).length);
    for (const l of uses) expect(l.trim(), `unpinned action: ${l.trim()}`).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  it("this repository's own call passes `targets` alone and inherits its secrets — its rendered inputs are the defaults", () => {
    const release = parse(read(".github/workflows/release-please.yml")) as {
      jobs: Record<string, { uses?: string; with?: Record<string, unknown>; secrets?: string }>;
    };
    const call = release.jobs.deploy;
    expect(call.uses).toBe("./.github/workflows/deploy-production.yml");
    expect(call.with).toEqual({ targets: "affected" });
    expect(call.secrets).toBe("inherit");
  });
});
