import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/** Run the installed CLI in `cwd`; never throws — the caller reads the status. The shell's Cloudflare
 *  credential and account never reach it: a smoke test touches no account, and a `registry`-mode
 *  `deploy plan` reads the account registry only when a token is there. */
function switchboard(cwd: string, ...args: string[]) {
  return switchboardWithEnv(cwd, {}, ...args);
}

/** The same, with environment overrides. The installation is pinned to `cwd` (`SWITCHBOARD_HOME`)
 *  unless the override says otherwise: a smoke test must never write into the developer's real
 *  `~/.switchboard` — the default an empty directory would otherwise resolve to. */
function switchboardWithEnv(cwd: string, over: Record<string, string | undefined>, ...args: string[]) {
  const { CLOUDFLARE_API_TOKEN: _token, CLOUDFLARE_ACCOUNT_ID: _account, ...env } = process.env;
  const r = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    env: { ...env, NO_COLOR: "1", SWITCHBOARD_HOME: cwd, ...over },
  });
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
  it("is the package's name and version, and carries the bin, the bundle, the assets, the manifest, the README and the license — no source, no tests, nothing an operator wrote", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as { version: string };
    expect(packed.filename).toBe(`${facts.npmPackage.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`);
    expect(packed.files).toEqual(
      expect.arrayContaining([
        "package.json",
        "README.md",
        "LICENSE",
        "bin/switchboard.js",
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
        // The dashboard's build, where the bot reads it from the package root — `start` serves it.
        "dist/assets/web/dist/.vite/manifest.json",
      ]),
    );
    expect(packed.files.filter((f) => f.startsWith("dist/assets/web/dist/assets/")).length).toBeGreaterThan(1);
    for (const f of packed.files) {
      expect(f, "only the manifest, README, LICENSE, the bin and dist/ ship").toMatch(
        /^(package\.json|README\.md|LICENSE|bin\/switchboard\.js|dist\/)/,
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
    // The next commands are the package's own ask and start (the bot, no Docker), then the image as the
    // one-line alternative — never the checkout's `npm run cli` or `npm run dev`.
    expect(r.stdout).toContain(`  npx ${facts.npmPackage} ask "what can you do?"`);
    expect(r.stdout).toContain(`  npx ${facts.npmPackage} start\n`);
    expect(r.stdout).toContain("# the same bot from the published image");
    expect(r.stdout).not.toContain("npm run cli");
    expect(r.stdout).not.toContain("npm run dev");
    expect(r.stdout).not.toContain("sk-test");
    for (const leak of [REPO_ROOT, tmp, "dist/assets", "node_modules"]) expect(r.stdout).not.toContain(leak);
    expect(existsSync(join(work, ".env"))).toBe(false);
  });

  it("with nothing to go on, `init` from an empty directory writes the installation into ~/.switchboard and says so; a second empty directory then finds the same installation", () => {
    const home = join(tmp, "home");
    const here = join(tmp, "somewhere-else");
    const there = join(tmp, "somewhere-else-again");
    for (const d of [home, here, there]) mkdirSync(d);
    // HOME is the temp directory's: the real home is never written; SWITCHBOARD_HOME is unset so the default decides.
    const r = switchboardWithEnv(
      here,
      { HOME: home, SWITCHBOARD_HOME: undefined },
      "init",
      "--organization",
      "acme",
      "--anthropic-key",
      "sk-test",
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`wrote to ${join(home, ".switchboard")}:`);
    expect(existsSync(join(home, ".switchboard", ".env"))).toBe(true);
    expect(existsSync(join(home, ".switchboard", "config", "config.yaml"))).toBe(true);
    expect(existsSync(join(here, ".env"))).toBe(false);
    const again = switchboardWithEnv(
      there,
      { HOME: home, SWITCHBOARD_HOME: undefined },
      "init",
      "--dry-run",
      "--organization",
      "acme",
      "--anthropic-key",
      "sk-test",
    );
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain(`would write to ${join(home, ".switchboard")}:`);
  });

  it("`start --help` says what the bot is and what it reads, under the bin's own name; `start` with an argument is the usage error", () => {
    const help = switchboard(join(tmp, "install"), "start", "--help");
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("usage: switchboard start");
    expect(help.stdout).toContain("Socket Mode");
    expect(help.stdout).toContain("SLACK_APP_TOKEN");
    expect(help.stdout).toContain("config/config.yaml");
    expect(help.stdout).not.toContain("npx tsx");
    const extra = switchboard(join(tmp, "install"), "start", "--port", "8080");
    expect(extra.status).toBe(2);
    expect(extra.stderr).toContain("start takes no arguments");
  });

  it("`start` from the installed package boots the bot process: in a directory with no .env it refuses at once naming the missing variable (the process's own rule), exit 1 — no stack, no Docker", () => {
    const work = join(tmp, "work-start");
    mkdirSync(work);
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== "SLACK_BOT_TOKEN" && k !== "SLACK_APP_TOKEN"),
      ),
      SWITCHBOARD_HOME: work,
    };
    const r = spawnSync(bin, ["start"], { cwd: work, encoding: "utf8", env, timeout: 30_000 });
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe("Missing required env var SLACK_BOT_TOKEN");
    expect(r.stdout).toBe("");
  });

  it("`start` with tokens boots ONE bot from the package: the startup log once, the HTTP server on PORT once, the dashboard bundle found beside the bundle — then Slack refuses the fake tokens (exit 1) or, unreachable, the process is drained by SIGINT (exit 0); never a second boot on the same port", async () => {
    const work = join(tmp, "work-start-boot");
    mkdirSync(work);
    const init = switchboard(work, "init", "--organization", "acme", "--anthropic-key", "sk-test");
    expect(init.status, init.stderr).toBe(0);
    const port = 18_000 + (process.pid % 1000);
    const env = {
      ...process.env,
      SLACK_BOT_TOKEN: "xoxb-fake",
      SLACK_APP_TOKEN: "xapp-fake",
      PORT: String(port),
      SWITCHBOARD_HOME: work,
    };
    const child = spawn(bin, ["start"], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
    // The socket handshake decides how the process ends: Slack answers `invalid_auth` and runBot rejects, or the
    // network is unavailable and the web client retries — then SIGINT drains it. Either way, what matters is above.
    const settled = await Promise.race([exited, new Promise<"alive">((r) => setTimeout(() => r("alive"), 15_000))]);
    if (settled === "alive") child.kill("SIGINT");
    const code = await Promise.race([exited, new Promise<"stuck">((r) => setTimeout(() => r("stuck"), 15_000))]);
    if (code === "stuck") child.kill("SIGKILL");
    expect(code, `stdout:\n${stdout}\nstderr:\n${stderr}`).not.toBe("stuck");
    const count = (needle: string) => stdout.split("\n").filter((l) => l.includes(needle)).length;
    expect(count("[build] "), stdout).toBe(1);
    expect(count("[capabilities] "), stdout).toBe(1);
    expect(count(`http server on :${port} (`), stdout).toBe(1);
    expect(stderr).not.toContain("EADDRINUSE");
    expect(stderr).not.toContain("web app manifest not found");
    expect(code === 1 || code === 0, `exit ${code}`).toBe(true);
    if (code === 0) expect(stdout).toContain("[drain] SIGINT");
  });

  it("`deploy plan` in a directory with no profile reads the shipped example profile and Worker templates, says the plan is the example's, and names the directory as the root", () => {
    const work = join(tmp, "work");
    const r = switchboard(work, "deploy", "plan");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Root: ${work} (the published package `);
    expect(r.stdout).toContain("deploy/profile.example.json");
    expect(r.stdout).toContain("memory");
    expect(r.stdout).toContain("bot");
  });

  it("`init --cloudflare` in an empty directory writes the profile there and renders the Worker configs under .switchboard/ — no checkout, no install; `deploy plan` then plans that installation from that directory with no credential and no network, naming no path of the package or the repository", () => {
    const work = join(tmp, "work-cf");
    mkdirSync(work);
    const account = "0123456789abcdef0123456789abcdef";
    const init = switchboard(
      work,
      "init",
      "--organization",
      "acme",
      "--anthropic-key",
      "sk-test",
      "--cloudflare",
      account,
      "--zone",
      "example.com",
    );
    expect(init.status, init.stderr).toBe(0);
    expect(init.stdout).toContain("  deploy/profile.json");
    expect(init.stdout).toContain("Worker configs from deploy/profile.json:");
    expect(init.stdout).toContain("  written   .switchboard/deploy/cloudflare-memory/wrangler.jsonc");
    expect(init.stdout).toContain("  written   .switchboard/deploy/cloudflare/wrangler.jsonc");
    expect(init.stdout).toContain(`  npx ${facts.npmPackage} deploy secrets memory`);
    expect(init.stdout).toContain(`npx ${facts.npmPackage} deploy all`);
    // The operator's directory: the installation's files, and the work area — the shipped tree, stamped, no node_modules yet.
    expect(readdirSync(work).sort()).toEqual([".env", ".switchboard", "config", "deploy"]);
    expect(readdirSync(join(work, "deploy"))).toEqual(["profile.json"]);
    const rendered = readFileSync(join(work, ".switchboard/deploy/cloudflare/wrangler.jsonc"), "utf8");
    expect(rendered).toContain(`"account_id": "${account}"`);
    expect(rendered).toContain('"pattern": "switchboard.example.com"');
    expect(existsSync(join(work, ".switchboard/.materialised.json"))).toBe(true);
    expect(existsSync(join(work, ".switchboard/package-lock.json"))).toBe(true);
    expect(existsSync(join(work, ".switchboard/node_modules"))).toBe(false);
    // Nothing was written into the installed package.
    expect(existsSync(join(tmp, "install/node_modules", facts.npmPackage, "dist/assets/deploy/profile.json"))).toBe(
      false,
    );

    const plan = switchboard(work, "deploy", "plan");
    expect(plan.status, plan.stderr).toBe(0);
    expect(plan.stdout).toContain(`Root: ${work} (the published package `);
    expect(plan.stdout).toContain("Profile: deploy/profile.json;");
    expect(plan.stdout).toContain("materialised under .switchboard/ — no git");
    expect(plan.stdout).toContain("1. memory (switchboard-memory)");
    expect(plan.stdout).toContain("2. bot (switchboard)");
    expect(plan.stdout).toContain("3. resident (switchboard-resident)");
    expect(plan.stdout).toContain("4. sandbox (switchboard-sandbox)");
    // The package's profile deploys the published images; without a token the registry is not read, and the plan says so.
    expect(plan.stdout).toContain("Images: registry (version ");
    expect(plan.stdout).toContain("not probed (CLOUDFLARE_API_TOKEN is not set");
    expect(plan.stdout).not.toContain("origin/main");
    // The installation's own profile, not the shipped example.
    expect(plan.stdout).not.toContain("profile.example.json");
    expect(plan.stdout).not.toContain("(example)");
    for (const leak of [REPO_ROOT, "dist/assets", "node_modules"]) expect(plan.stdout).not.toContain(leak);
  });
});
