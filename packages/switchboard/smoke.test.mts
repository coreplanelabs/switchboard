import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Feature: docs/reference/specs/packaging.md items 3–4 — the package works
// once installed from its tarball, the way `npx <the package>` will run it:
// `npm pack` the workspace, install the tarball into an empty
// directory, run the installed `switchboard` there. Needs `npm run build` first
// (the package's `verify` runs it); installs from the local npm cache when it
// can, the registry otherwise.

const PACKAGE_DIR = import.meta.dirname;
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");
const facts = JSON.parse(readFileSync(join(REPO_ROOT, "project.json"), "utf8")) as { npmPackage: string };

let tmp: string;
let bin: string;
let packed: { filename: string; files: string[] };

/** Run the installed CLI in `cwd`; never throws — the caller reads the status. */
function switchboard(cwd: string, ...args: string[]) {
  const r = spawnSync(bin, args, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  expect(
    existsSync(join(PACKAGE_DIR, "dist", "cli.js")),
    "dist/cli.js is missing — run `npm run build -w packages/switchboard` first",
  ).toBe(true);
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "swb-pack-")));
  const out = execFileSync(
    "npm",
    ["pack", "--workspace", "packages/switchboard", "--pack-destination", tmp, "--json", "--silent"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  const [entry] = JSON.parse(out) as { filename: string; files: { path: string }[] }[];
  packed = { filename: entry.filename, files: entry.files.map((f) => f.path).sort() };
  const install = join(tmp, "install");
  mkdirSync(install);
  writeFileSync(join(install, "package.json"), '{ "name": "smoke", "private": true }\n');
  execFileSync(
    "npm",
    ["install", "--prefer-offline", "--no-audit", "--no-fund", "--loglevel=error", join(tmp, packed.filename)],
    { cwd: install, encoding: "utf8", stdio: "pipe" },
  );
  bin = join(install, "node_modules", ".bin", "switchboard");
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("the tarball", () => {
  it("is the package's name and version, and carries the bundle, the assets, the manifest, the README and the license — no source, no tests, nothing an operator wrote", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as { version: string };
    expect(packed.filename).toBe(`${facts.npmPackage.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`);
    expect(packed.files).toEqual(
      expect.arrayContaining([
        "package.json",
        "README.md",
        "LICENSE",
        "dist/cli.js",
        "dist/assets/project.json",
        "dist/assets/.env.example",
        "dist/assets/config/config.example.yaml",
        "dist/assets/deploy/profile.example.json",
        "dist/assets/deploy/secrets.manifest.json",
        "dist/assets/deploy/cloudflare/wrangler.template.jsonc",
        "dist/assets/deploy/cloudflare/worker.ts",
        "dist/assets/deploy/cloudflare/package.json",
        "dist/assets/deploy/cloudflare-resident/Dockerfile",
        "dist/assets/Dockerfile",
      ]),
    );
    for (const f of packed.files) {
      expect(f, "only the manifest, README, LICENSE and dist/ ship").toMatch(
        /^(package\.json|README\.md|LICENSE|dist\/)/,
      );
      expect(f).not.toMatch(/\.test\.|vitest\.config|\/wrangler\.jsonc$|\/profile\.json$|agent-env|\.env$/);
    }
  });
});

describe("the installed CLI", () => {
  it("`npx switchboard --help` prints the catalogue under the bin's own name, never the checkout's spelling", () => {
    const r = spawnSync("npx", ["switchboard", "--help"], { cwd: join(tmp, "install"), encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("usage: switchboard <group> <verb>");
    expect(r.stdout).toContain("switchboard init [--option value…]");
    expect(r.stdout).toContain("setup init");
    expect(r.stdout).not.toContain("npx tsx");
  });

  it("`init --dry-run` in an empty directory plans .env and config/config.yaml from the shipped examples, masks the key, and leaks no path of the package or the repository", () => {
    const work = join(tmp, "work");
    mkdirSync(work);
    const r = switchboard(work, "init", "--dry-run", "--organization", "acme", "--anthropic-key", "sk-test");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("would write:");
    expect(r.stdout).toContain("  .env                  (mode 600)");
    expect(r.stdout).toContain("  config/config.yaml");
    expect(r.stdout).toContain("providers: anthropic");
    expect(r.stdout).toContain("ANTHROPIC_API_KEY=••••••••");
    expect(r.stdout).toContain("organization: acme");
    // The next commands are the package's own ask and the bot from the image — never the checkout's `npm run cli`.
    expect(r.stdout).toContain(`  npx ${facts.npmPackage} ask "what can you do?"`);
    expect(r.stdout).toContain("# the bot, from the published image");
    expect(r.stdout).not.toContain("npm run cli");
    expect(r.stdout).not.toContain("sk-test");
    for (const leak of [REPO_ROOT, tmp, "dist/assets", "node_modules"]) expect(r.stdout).not.toContain(leak);
    expect(existsSync(join(work, ".env"))).toBe(false);
  });

  it("`init` with --cloudflare refuses outside a checkout, naming it — the deploy still starts from a clone", () => {
    const work = join(tmp, "work-cf");
    mkdirSync(work);
    const r = switchboard(
      work,
      "init",
      "--organization",
      "acme",
      "--anthropic-key",
      "sk-test",
      "--cloudflare",
      "0123456789abcdef0123456789abcdef",
      "--zone",
      "example.com",
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("error (unavailable)");
    expect(r.stderr).toContain("run init from the root of a checkout");
    expect(existsSync(join(work, ".env"))).toBe(false);
  });

  it("`deploy plan` reads the shipped example profile and Worker templates and says the plan is the example's", () => {
    const r = switchboard(join(tmp, "work"), "deploy", "plan");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("deploy/profile.example.json");
    expect(r.stdout).toContain("memory");
    expect(r.stdout).toContain("bot");
  });
});
