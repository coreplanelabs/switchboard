import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { baseForEvent, fixtureRegistrationOnly, planForDiff, planForPaths } from "../scripts/ci-plan.mjs";

describe("selective CI", () => {
  it("runs the docs build, but no runtime or package build, for a docs page", () => {
    expect(planForPaths(["docs/how-to/example.md"])).toEqual({
      botChecks: ["check:consistency"],
      botTests: false,
      web: false,
      docs: true,
      package: false,
      workers: ["none"],
      images: ["none"],
    });
  });

  it("runs repository lint for code in every workspace", () => {
    for (const path of [
      "web/src/pages/HomePage.vue",
      "deploy/cloudflare-resident/worker.ts",
      "docs/.vitepress/theme/LandingPage.vue",
      "packages/switchboard/build.mts",
    ]) {
      expect(planForPaths([path]).botChecks, path).toContain("lint");
    }
  });

  it("runs root tests when other workspaces change files those tests inspect", () => {
    for (const path of [
      "web/src/pages/HomePage.vue",
      "deploy/cloudflare-resident/worker.ts",
      "deploy/cloudflare-resident/Dockerfile",
      "docs/.vitepress/og.mjs",
      "skills/pr-description/SKILL.md",
      "packages/switchboard/build.mts",
      "project.json",
    ]) {
      expect(planForPaths([path]).botTests, path).toBe(true);
    }
  });

  it("checks formatting when its ignore rules change", () => {
    expect(planForPaths([".prettierignore"]).botChecks).toContain("format:check");
  });

  it("selects the changed Worker and its image without building unrelated Workers", () => {
    const plan = planForPaths(["deploy/cloudflare-resident/Dockerfile"]);
    expect(plan.workers).toEqual(["deploy/cloudflare-resident"]);
    expect(plan.images).toEqual(["deploy/cloudflare-resident"]);
    expect(plan.package).toBe(true);
    expect(plan.web).toBe(false);
  });

  it("selects the isolated acceptance workspace without the none sentinel", () => {
    expect(planForPaths(["deploy/cloudflare-acceptance-source/worker.ts"]).workers).toEqual([
      "deploy/cloudflare-acceptance-source",
    ]);
    expect(
      planForPaths(["deploy/cloudflare-acceptance-source/worker.ts", "deploy/cloudflare-resident/worker.ts"]).workers,
    ).toEqual(["deploy/cloudflare-resident", "deploy/cloudflare-acceptance-source"]);
    expect(planForPaths(["scripts/ci-plan.mjs", "deploy/cloudflare-acceptance-source/worker.ts"]).workers).toEqual([
      "deploy/cloudflare",
      "deploy/cloudflare-memory",
      "deploy/cloudflare-resident",
      "deploy/cloudflare-sandbox",
      "deploy/cloudflare-acceptance-source",
    ]);
  });

  it("keeps fixture-only root workspace registration out of production images", () => {
    const rootOnly = planForPaths(["package.json", "package-lock.json"], { fixtureRegistrationOnly: true });
    expect(rootOnly.workers).toEqual(["deploy/cloudflare-acceptance-source"]);
    expect(rootOnly.images).toEqual(["none"]);
    const paths = ["package.json", "package-lock.json", "deploy/cloudflare-acceptance-source/worker.ts"];
    const fixture = planForPaths(paths, { fixtureRegistrationOnly: true });
    expect(fixture.workers).toEqual(["deploy/cloudflare-acceptance-source"]);
    expect(fixture.images).toEqual(["none"]);
    expect(planForPaths(paths).images).toContain("deploy/cloudflare");
    const mixed = planForPaths([...paths, "deploy/cloudflare-resident/worker.ts"], {
      fixtureRegistrationOnly: true,
    });
    expect(mixed.workers).toEqual(["deploy/cloudflare-resident", "deploy/cloudflare-acceptance-source"]);
    expect(mixed.images).toEqual(["deploy/cloudflare-resident"]);
  });

  it("recognizes root-only fixture registration in the actual diff planner", () => {
    const beforePackage = JSON.stringify({ name: "switchboard", workspaces: ["web"] });
    const afterPackage = JSON.stringify({
      name: "switchboard",
      workspaces: ["web", "deploy/cloudflare-acceptance-source"],
    });
    const beforeLock = JSON.stringify({ packages: { "": { workspaces: ["web"] } } });
    const afterLock = JSON.stringify({
      packages: {
        "": { workspaces: ["web", "deploy/cloudflare-acceptance-source"] },
        "deploy/cloudflare-acceptance-source": { name: "switchboard-controlled-acceptance-source" },
        "node_modules/switchboard-controlled-acceptance-source": {
          resolved: "deploy/cloudflare-acceptance-source",
          link: true,
        },
      },
    });
    const plan = planForDiff(["package.json", "package-lock.json"], beforePackage, afterPackage, beforeLock, afterLock);
    expect(plan.workers).toEqual(["deploy/cloudflare-acceptance-source"]);
    expect(plan.images).toEqual(["none"]);
  });

  it("recognizes only the exact fixture workspace and lockfile link", () => {
    const root = { name: "switchboard", workspaces: ["web"] };
    const registered = { ...root, workspaces: ["web", "deploy/cloudflare-acceptance-source"] };
    const lock = { packages: { "": { workspaces: ["web"] }, web: { name: "web" } } };
    const linked = {
      packages: {
        "": { workspaces: ["web", "deploy/cloudflare-acceptance-source"] },
        web: { name: "web" },
        "deploy/cloudflare-acceptance-source": { name: "switchboard-controlled-acceptance-source" },
        "node_modules/switchboard-controlled-acceptance-source": {
          resolved: "deploy/cloudflare-acceptance-source",
          link: true,
        },
      },
    };
    const inputs = [
      JSON.stringify(root),
      JSON.stringify(registered),
      JSON.stringify(lock),
      JSON.stringify(linked),
    ] as const;
    expect(fixtureRegistrationOnly(...inputs)).toBe(true);
    expect(
      fixtureRegistrationOnly(
        inputs[0],
        JSON.stringify({ ...registered, scripts: { deploy: "changed" } }),
        inputs[2],
        inputs[3],
      ),
    ).toBe(false);
    expect(fixtureRegistrationOnly(inputs[0], inputs[1], inputs[2], JSON.stringify({ ...linked, extra: true }))).toBe(
      false,
    );
  });

  it("follows shared source imports without checking unrelated Workers", () => {
    expect(planForPaths(["src/deploy/liveGate.ts"]).workers).toContain("deploy/cloudflare");
    const auth = planForPaths(["src/channels/dashboardAuth.ts"]);
    expect(auth.workers).toEqual(["none"]);
    expect(auth.web).toBe(false);
  });

  it("selects the web build and artifacts that include it", () => {
    const plan = planForPaths(["web/src/pages/HomePage.vue"]);
    expect(plan.web).toBe(true);
    expect(plan.package).toBe(true);
    expect(plan.images).toContain("deploy/cloudflare");
    expect(plan.workers).toEqual(["none"]);
  });

  it("selects the package for shipped inputs and its tests", () => {
    for (const path of ["packages/switchboard/build.mts", "packages/switchboard/smoke.test.mts", "README.md"]) {
      expect(planForPaths([path]).package).toBe(true);
    }
    expect(planForPaths(["packages/switchboard/smoke.test.mts"]).images).toEqual(["none"]);
  });

  it("runs every leg for unknown paths and shared dependency changes", () => {
    for (const path of ["new-surface/file.ts", "package-lock.json", ".depot/workflows/ci.yml", "scripts/ci-plan.mjs"]) {
      const plan = planForPaths([path]);
      expect(plan.botChecks).toHaveLength(5);
      expect(plan.botTests && plan.web && plan.docs && plan.package).toBe(true);
      expect(plan.workers).toHaveLength(4);
      expect(plan.images).toHaveLength(3);
    }
  });

  it("uses the complete push range, the merge queue base and the PR base", () => {
    expect(baseForEvent("push", { before: "a".repeat(40) })).toBe("a".repeat(40));
    expect(baseForEvent("merge_group", { merge_group: { base_sha: "b".repeat(40) } })).toBe("b".repeat(40));
    expect(baseForEvent("pull_request", { pull_request: { base: { sha: "c".repeat(40) } } })).toBe("c".repeat(40));
    expect(baseForEvent("workflow_dispatch", {})).toBeUndefined();
    expect(baseForEvent("push", { before: "0".repeat(40) })).toBeUndefined();
  });

  it("accepts a local base override without starting every leg", () => {
    const script = fileURLToPath(new URL("../scripts/ci-plan.mjs", import.meta.url));
    const output = execFileSync(process.execPath, [script, "--base", "HEAD"], { encoding: "utf8" });
    expect(output).toContain("0 changed path(s) against HEAD");
    expect(output).toContain('"workers":["none"]');
  });

  it("writes job outputs from the event base even without an event file", () => {
    const script = fileURLToPath(new URL("../scripts/ci-plan.mjs", import.meta.url));
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dir = mkdtempSync(join(tmpdir(), "switchboard-ci-plan-"));
    try {
      const output = join(dir, "outputs");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GITHUB_EVENT_NAME: "push",
        CI_BASE_SHA: head,
        GITHUB_OUTPUT: output,
      };
      delete env.GITHUB_EVENT_PATH;
      const log = execFileSync(process.execPath, [script], { encoding: "utf8", env });
      expect(log).toContain(`0 changed path(s) against ${head}`);
      expect(readFileSync(output, "utf8")).toContain('workers=["none"]\n');
      expect(readFileSync(output, "utf8")).toContain("bot_tests=false\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
