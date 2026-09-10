import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../packageRoot.js";
import { copyCommands, IMAGE_PLATFORM, imagesHostIO, registryCommand, wranglerDir, type Spawn } from "./imagesHost.js";
import { planImageCopies } from "./images.js";
import { OPERATOR_ROOT } from "./host.js";
import { WORKER_DIRS } from "./plan.js";
import type { RunResult } from "./run.js";
import { TEST_PROFILE, TEST_PUBLISHED_IMAGES } from "./testing/profile.js";

// Feature: docs/reference/specs/release-and-deploy.md item 26 — the host half of
// `deploy images` over a fake spawn: which commands run, in which directory, with
// which environment, in either root, and how each failure is reported. Nothing
// here spawns a process.

const ACCOUNT = TEST_PROFILE.account;
const BOT_DIR = join(PACKAGE_ROOT, WORKER_DIRS.bot);
const COPY = planImageCopies(TEST_PUBLISHED_IMAGES, ACCOUNT, []).copy[0];
/** A package-mode root: the operator's work area, where the bot Worker's directory is materialised. */
const PACKAGE_AT = { workArea: "/srv/switchboard/.switchboard" };

interface Call {
  cmd: string;
  args: string[];
  cwd: string;
  set?: Record<string, string>;
  unset?: readonly string[];
}

/** A spawn that records every call and answers from a script keyed by `cmd args…`. */
function fakeSpawn(script: Record<string, RunResult> = {}, calls: Call[] = []): { spawn: Spawn; calls: Call[] } {
  const spawn: Spawn = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd, set: opts.set, unset: opts.unset });
    opts.stream?.(`ran ${cmd}\n`);
    return script[`${cmd} ${args.join(" ")}`] ?? { code: 0, output: "" };
  };
  return { spawn, calls };
}

/** A host over the fake spawn in a checkout, its work area always ready — `readied` counts the asks. */
function host(spawn: Spawn, readied: number[] = [0], stream?: (chunk: string) => void) {
  return imagesHostIO({
    spawn,
    stream,
    ready: async () => {
      readied[0]++;
      return { ok: true, copied: false, installed: [] };
    },
  });
}

describe("the commands", () => {
  it("reads the registry with wrangler in the bot Worker's directory — the tree's in a checkout, the work area's from the package — with the profile's account in the environment; no Worker config needed", () => {
    expect(wranglerDir()).toBe(join(OPERATOR_ROOT.workArea, WORKER_DIRS.bot));
    expect(registryCommand(ACCOUNT)).toEqual({
      cmd: "npx",
      args: ["wrangler", "containers", "images", "list", "--json"],
      cwd: wranglerDir(),
      set: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    });
    expect(registryCommand(ACCOUNT, PACKAGE_AT).cwd).toBe("/srv/switchboard/.switchboard/deploy/cloudflare");
  });

  it("copies with docker pull (linux/amd64, what Cloudflare runs), docker tag to the bare name, and wrangler containers push of that name — the push in the resolved bot directory", () => {
    expect(IMAGE_PLATFORM).toBe("linux/amd64");
    expect(copyCommands(COPY, ACCOUNT)).toEqual([
      {
        cmd: "docker",
        args: ["pull", "--platform", "linux/amd64", "ghcr.io/example/switchboard:1.2.3"],
        cwd: PACKAGE_ROOT,
      },
      { cmd: "docker", args: ["tag", "ghcr.io/example/switchboard:1.2.3", "switchboard:1.2.3"], cwd: PACKAGE_ROOT },
      {
        cmd: "npx",
        args: ["wrangler", "containers", "push", "switchboard:1.2.3"],
        cwd: wranglerDir(),
        set: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
      },
    ]);
    expect(copyCommands(COPY, ACCOUNT, PACKAGE_AT)[2].cwd).toBe("/srv/switchboard/.switchboard/deploy/cloudflare");
  });
});

describe("imagesHostIO", () => {
  it("registry: the work area is readied first, then the parsed listing on success; wrangler's error line on a non-zero exit; a shape that is not a listing is named", async () => {
    const listing = [{ name: "switchboard", tags: ["1.2.3"] }];
    const ok = fakeSpawn({
      "npx wrangler containers images list --json": { code: 0, output: `⛅️ wrangler\n${JSON.stringify(listing)}\n` },
    });
    const readied = [0];
    expect(await host(ok.spawn, readied).registry(ACCOUNT)).toEqual({ value: listing });
    expect(readied).toEqual([1]);
    expect(ok.calls).toEqual([
      {
        cmd: "npx",
        args: ["wrangler", "containers", "images", "list", "--json"],
        cwd: BOT_DIR,
        set: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
        unset: undefined,
      },
    ]);
    const denied = fakeSpawn({
      "npx wrangler containers images list --json": {
        code: 1,
        output: "✘ [ERROR] Authentication error [code: 10000]\n",
      },
    });
    expect(await host(denied.spawn).registry(ACCOUNT)).toEqual({
      error: "wrangler containers images list --json failed: ✘ [ERROR] Authentication error [code: 10000]",
    });
    const odd = fakeSpawn({ "npx wrangler containers images list --json": { code: 0, output: '{"not":"a list"}' } });
    expect(await host(odd.spawn).registry(ACCOUNT)).toEqual({
      error: "wrangler containers images list --json: no image listing in the output",
    });
  });

  it("a work area that cannot be readied is the error (registry) or the failure (copy), and wrangler never runs", async () => {
    const calls = fakeSpawn();
    const io = imagesHostIO({ spawn: calls.spawn, ready: async () => ({ ok: false, problem: "nope: no such stamp" }) });
    expect(await io.registry(ACCOUNT)).toEqual({ error: "nope: no such stamp" });
    expect(await io.copy(COPY, ACCOUNT)).toEqual({ code: 1, output: "nope: no such stamp" });
    expect(calls.calls).toEqual([]);
  });

  it("docker: `docker version` exiting 0 is ok; anything else is the problem that names where Docker is", async () => {
    expect(await host(fakeSpawn().spawn).docker()).toEqual({ ok: true });
    const missing = fakeSpawn({
      "docker version --format {{.Server.Version}}": { code: 127, output: "\nspawn docker ENOENT" },
    });
    const r = await host(missing.spawn).docker();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.problem).toContain("docker is not available here (spawn docker ENOENT)");
    expect(r.problem).toContain(".github/workflows/deploy-production.yml");
  });

  it("copy: pull, tag, push in order, output streamed and collected; the first failure stops the rest and names the command that exited", async () => {
    const streamed: string[] = [];
    const ok = fakeSpawn();
    const r = await host(ok.spawn, [0], (c) => streamed.push(c)).copy(COPY, ACCOUNT);
    expect(r.code).toBe(0);
    expect(ok.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`)).toEqual([
      "docker pull --platform linux/amd64 ghcr.io/example/switchboard:1.2.3",
      "docker tag ghcr.io/example/switchboard:1.2.3 switchboard:1.2.3",
      "npx wrangler containers push switchboard:1.2.3",
    ]);
    expect(streamed).toEqual(["ran docker\n", "ran docker\n", "ran npx\n"]);
    const denied = fakeSpawn({
      "docker pull --platform linux/amd64 ghcr.io/example/switchboard:1.2.3": {
        code: 1,
        output: "Error response from daemon: denied\n",
      },
    });
    const failed = await host(denied.spawn).copy(COPY, ACCOUNT);
    expect(failed.code).toBe(1);
    expect(failed.output).toContain("docker pull --platform linux/amd64 ghcr.io/example/switchboard:1.2.3 exited 1");
    expect(failed.output).toContain("Error response from daemon: denied");
    expect(denied.calls).toHaveLength(1);
  });
});
