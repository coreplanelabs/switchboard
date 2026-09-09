import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// vitest.config.ts at the root is the one test entry for the workspace: every
// package whose tests vitest 5 can run is a project there, so `npx vitest run
// <filter>` from the root finds a test wherever it lives, and CI shards the
// union. The memory Worker is the documented exception (its tests run inside
// workerd on @cloudflare/vitest-pool-workers, which pins vitest 4); so is the
// npm package, whose tests need the package BUILT — the smoke test packs and
// installs it — which its own `verify` does first and the root shards never
// would. A new workspace with a `test` script must join the projects list, or
// one of these two lists with its reason, or this fails.

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(new URL(p, `file://${root}`), "utf8");
const rootPkg = JSON.parse(read("package.json")) as { workspaces: string[] };

const WORKERD_ONLY = ["deploy/cloudflare-memory"];
/** Workspaces whose tests presuppose their own build: run by their `verify` (build first) and CI's `package` job, never by the root shards. */
const NEEDS_OWN_BUILD = ["packages/switchboard"];

interface Project {
  test?: { name?: string; include?: string[] };
}
type ProjectEntry = string | Project;

// The config sits above src/ (tsc's rootDir), so it is imported by URL rather
// than by a path the compiler would try to include in the build.
const configUrl = new URL("vitest.config.ts", `file://${root}`).href;
async function loadConfig(): Promise<{ projects: ProjectEntry[] }> {
  const mod = (await import(configUrl)) as { default: { test: { projects: ProjectEntry[] } } };
  return mod.default.test;
}

describe("the root vitest config", () => {
  it("lists the bot's own tests as the `bot` project", async () => {
    const { projects } = await loadConfig();
    const bot = projects.find((p): p is Project => typeof p !== "string" && p.test?.name === "bot");
    expect(bot?.test?.include).toEqual(["src/**/*.test.ts"]);
  });

  it("every project config it names exists", async () => {
    const { projects } = await loadConfig();
    const paths = projects.filter((p): p is string => typeof p === "string");
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(existsSync(new URL(p, `file://${root}`)), `missing project config ${p}`).toBe(true);
  });

  it("every workspace with a `test` script is a project, except the workerd-only ones and the ones whose tests need their own build", async () => {
    const { projects } = await loadConfig();
    const paths = projects.filter((p): p is string => typeof p === "string");
    for (const ws of rootPkg.workspaces) {
      const pkg = JSON.parse(read(`${ws}/package.json`)) as { scripts?: Record<string, string> };
      if (!pkg.scripts?.test) continue;
      const listed = paths.some((p) => p.startsWith(`./${ws}/`));
      if (WORKERD_ONLY.includes(ws)) {
        expect(listed, `${ws} runs on vitest 4 inside workerd and cannot be a vitest 5 project`).toBe(false);
      } else if (NEEDS_OWN_BUILD.includes(ws)) {
        expect(listed, `${ws}'s tests need its build, which the root shards never run`).toBe(false);
      } else {
        expect(listed, `${ws} has tests but is not a project in vitest.config.ts`).toBe(true);
      }
    }
  });

  it("the workerd-only exception still runs its own vitest", () => {
    for (const ws of WORKERD_ONLY) {
      const pkg = JSON.parse(read(`${ws}/package.json`)) as { scripts?: Record<string, string> };
      expect(pkg.scripts?.test).toBe("vitest run");
    }
  });

  it("a workspace whose tests need its build runs them from its own `verify`, after the build, and CI runs that verify", () => {
    const ci = read(".github/workflows/ci.yml");
    for (const ws of NEEDS_OWN_BUILD) {
      const pkg = JSON.parse(read(`${ws}/package.json`)) as { scripts?: Record<string, string> };
      expect(pkg.scripts?.test).toBe("vitest run");
      const verify = pkg.scripts?.verify ?? "";
      expect(verify.indexOf("npm run build"), `${ws}: verify must build before it tests`).toBeGreaterThanOrEqual(0);
      expect(verify.indexOf("npm run build")).toBeLessThan(verify.indexOf("npm test"));
      expect(ci).toContain(`npm run verify -w ${ws}`);
    }
  });
});
