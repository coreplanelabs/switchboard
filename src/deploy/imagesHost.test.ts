import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../packageRoot.js";
import {
  API_TOKEN_ENV,
  apiTokenMissingProblem,
  imagesHostIO,
  registryCommand,
  wranglerDir,
  type Spawn,
  type Transfer,
} from "./imagesHost.js";
import { planImageCopies } from "./images.js";
import { OPERATOR_ROOT } from "./host.js";
import { WORKER_DIRS } from "./plan.js";
import { containersEditProblem } from "./registryTransfer.js";
import type { RunResult } from "./run.js";
import { TEST_PROFILE, TEST_PUBLISHED_IMAGES } from "./testing/profile.js";

// Feature: docs/reference/specs/release-and-deploy.md item 26 — the host half of
// the image copy over a fake spawn and a fake transfer: the one wrangler command
// that reads the registry (in which directory, with which environment, in
// either root), the credential minted once per account from CLOUDFLARE_API_TOKEN
// and spent by every copy, and how each failure is reported. Nothing here spawns
// a process or opens a socket.

const ACCOUNT = TEST_PROFILE.account;
const BOT_DIR = join(PACKAGE_ROOT, WORKER_DIRS.bot);
const [COPY, SECOND] = planImageCopies(TEST_PUBLISHED_IMAGES, ACCOUNT, []).copy;
/** A package-mode root: the operator's work area, where the bot Worker's directory is materialised. */
const PACKAGE_AT = { workArea: "/srv/switchboard/.switchboard" };
const ENV = { [API_TOKEN_ENV]: "cf-token" };

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
    return script[`${cmd} ${args.join(" ")}`] ?? { code: 0, output: "" };
  };
  return { spawn, calls };
}

/** A transfer that records its calls: the mint answers as told, the copy lands with a made-up digest. */
function fakeTransfer(
  mint: Awaited<ReturnType<Transfer["mint"]>> = { ok: true, credential: { authorization: "Basic djE6and0" } },
) {
  const mints: { account: string; token: string }[] = [];
  const copies: { source: string; account: string; authorization: string }[] = [];
  const transfer: Transfer = {
    mint: async (account, token) => {
      mints.push({ account, token });
      return mint;
    },
    transfer: async (copy, account, credential) => {
      copies.push({ source: copy.source, account, authorization: credential.authorization });
      return { ok: true, report: { digest: `sha256:${copy.name}`, blobs: 3, uploaded: 2, bytes: 10 } };
    },
  };
  return { transfer, mints, copies };
}

/** A host over the fakes in a checkout, its work area always ready — `readied` counts the asks. */
function host(
  spawn: Spawn,
  transfer: Transfer,
  readied: number[] = [0],
  env: Record<string, string | undefined> = ENV,
) {
  return imagesHostIO({
    spawn,
    transfer,
    env,
    ready: async () => {
      readied[0]++;
      return { ok: true, copied: false, installed: [] };
    },
  });
}

describe("the registry command", () => {
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
});

describe("imagesHostIO", () => {
  it("registry: the work area is readied first, then the parsed listing on success; wrangler's error line on a non-zero exit; a shape that is not a listing is named", async () => {
    const listing = [{ name: "switchboard", tags: ["1.2.3"] }];
    const ok = fakeSpawn({
      "npx wrangler containers images list --json": { code: 0, output: `⛅️ wrangler\n${JSON.stringify(listing)}\n` },
    });
    const readied = [0];
    expect(await host(ok.spawn, fakeTransfer().transfer, readied).registry(ACCOUNT)).toEqual({ value: listing });
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
    expect(await host(denied.spawn, fakeTransfer().transfer).registry(ACCOUNT)).toEqual({
      error: "wrangler containers images list --json failed: ✘ [ERROR] Authentication error [code: 10000]",
    });
    const odd = fakeSpawn({ "npx wrangler containers images list --json": { code: 0, output: '{"not":"a list"}' } });
    expect(await host(odd.spawn, fakeTransfer().transfer).registry(ACCOUNT)).toEqual({
      error: "wrangler containers images list --json: no image listing in the output",
    });
  });

  it("a work area that cannot be readied is the registry's error, and wrangler never runs", async () => {
    const calls = fakeSpawn();
    const io = imagesHostIO({
      spawn: calls.spawn,
      transfer: fakeTransfer().transfer,
      env: ENV,
      ready: async () => ({ ok: false, problem: "nope: no such stamp" }),
    });
    expect(await io.registry(ACCOUNT)).toEqual({ error: "nope: no such stamp" });
    expect(calls.calls).toEqual([]);
  });

  it("credential: minted from CLOUDFLARE_API_TOKEN once per account and spent by every copy; the copies never run a process", async () => {
    const t = fakeTransfer();
    const spawn = fakeSpawn();
    const io = host(spawn.spawn, t.transfer);
    expect(await io.credential(ACCOUNT)).toEqual({ ok: true });
    expect(await io.credential(ACCOUNT)).toEqual({ ok: true });
    expect(await io.copy(COPY, ACCOUNT)).toEqual({
      ok: true,
      report: { digest: "sha256:switchboard", blobs: 3, uploaded: 2, bytes: 10 },
    });
    expect(await io.copy(SECOND, ACCOUNT)).toMatchObject({ ok: true });
    expect(t.mints).toEqual([{ account: ACCOUNT, token: "cf-token" }]);
    expect(t.copies).toEqual([
      { source: COPY.source, account: ACCOUNT, authorization: "Basic djE6and0" },
      { source: SECOND.source, account: ACCOUNT, authorization: "Basic djE6and0" },
    ]);
    expect(spawn.calls).toEqual([]);
    // A copy without the pre-check mints for itself.
    const alone = fakeTransfer();
    expect(await host(spawn.spawn, alone.transfer).copy(COPY, ACCOUNT)).toMatchObject({ ok: true });
    expect(alone.mints).toHaveLength(1);
  });

  it("no CLOUDFLARE_API_TOKEN is refused by name before the API is asked; a token without Containers Edit is the mint's problem, on the pre-check and on a copy alike", async () => {
    const unset = fakeTransfer();
    const io = host(fakeSpawn().spawn, unset.transfer, [0], {});
    expect(await io.credential(ACCOUNT)).toEqual({ ok: false, problem: apiTokenMissingProblem() });
    expect(await io.copy(COPY, ACCOUNT)).toEqual({ ok: false, problem: apiTokenMissingProblem() });
    expect(apiTokenMissingProblem()).toContain("CLOUDFLARE_API_TOKEN is not set");
    expect(apiTokenMissingProblem()).toContain("Containers Edit");
    expect(unset.mints).toEqual([]);
    const forbidden = fakeTransfer({ ok: false, problem: containersEditProblem() });
    const denied = host(fakeSpawn().spawn, forbidden.transfer);
    expect(await denied.credential(ACCOUNT)).toEqual({ ok: false, problem: containersEditProblem() });
    expect(await denied.copy(COPY, ACCOUNT)).toEqual({ ok: false, problem: containersEditProblem() });
    expect(forbidden.copies).toEqual([]);
    // A refused mint is not kept: the next ask tries again.
    expect(forbidden.mints).toHaveLength(2);
  });
});
