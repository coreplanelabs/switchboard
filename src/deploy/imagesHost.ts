// The host half of `deploy images`: Docker and wrangler on this machine, through
// the same `run()` the deploy runner spawns every step with. The plan — which
// images the account registry already holds, which to copy — is pure
// (src/deploy/images.ts) and the command (src/core/commands/deploy.ts) reaches
// these three operations through `deps.deploy.images`, so its tests run over
// fakes and this file is the one that touches processes.
//
// Every wrangler call runs in the bot Worker's directory as the operator root
// resolves it (src/deploy/operatorRoot.ts: the tree in a checkout, the work
// area from the published package — materialised and installed first, so the
// pinned wrangler is there to run) with CLOUDFLARE_ACCOUNT_ID SET to the
// profile's account. The deploy steps strip that variable because it would
// override the account the rendered wrangler.jsonc pins; these are account-level
// registry calls that need no Worker config at all — `deploy plan` probes the
// registry from a root that has rendered nothing — so the profile supplies the
// account the same way, and a rendered config, when there is one, names the
// same account.

import { PACKAGE_ROOT } from "../packageRoot.js";
import { ensureWorkAreaOnHost, OPERATOR_ROOT } from "./host.js";
import { dockerUnavailableProblem, parseRegistryListing, type ImageCopy, type RegistryImage } from "./images.js";
import { workPath, type OperatorRoot } from "./operatorRoot.js";
import { lastErrorLines, WORKER_DIRS } from "./plan.js";
import { run, type RunResult } from "./run.js";
import { parseWranglerJson, type Read } from "./sandboxLiveGate.js";
import type { WorkAreaOutcome } from "./workArea.js";

/** What the command needs from the host. */
export interface ImagesHostIO {
  /** `wrangler containers images list --json` on the account: what its registry holds, or why it could not be read. */
  registry(account: string): Promise<Read<RegistryImage[]>>;
  /** Can this host pull and push? `docker version` answers; the problem names where Docker is. */
  docker(): Promise<{ ok: true } | { ok: false; problem: string }>;
  /** Copy one image into the account's registry: pull it from where the release published it, tag it
   *  under its bare name, push it with wrangler. The first failing command's exit and output. */
  copy(copy: ImageCopy, account: string): Promise<RunResult>;
}

/** The spawn the host half runs everything through — injectable so a test hands it a fake. */
export type Spawn = typeof run;

/** `docker pull` as Cloudflare runs containers: linux/amd64. A multi-platform manifest would
 *  otherwise resolve to the host's own architecture, and wrangler refuses to push anything else. */
export const IMAGE_PLATFORM = "linux/amd64";

/** One command the host half runs, as argv — the shape a test pins. */
export interface HostCommand {
  cmd: string;
  args: string[];
  cwd: string;
  set?: Record<string, string>;
}

/** The bot Worker's directory as wrangler runs in it — the one Worker every profile has. */
export function wranglerDir(at: Pick<OperatorRoot, "workArea"> = OPERATOR_ROOT): string {
  return workPath(at, WORKER_DIRS.bot);
}

const wrangler = (args: string[], account: string, at: Pick<OperatorRoot, "workArea">): HostCommand => ({
  cmd: "npx",
  args: ["wrangler", ...args],
  cwd: wranglerDir(at),
  set: { CLOUDFLARE_ACCOUNT_ID: account },
});

/** Pure: the read of the account registry. */
export function registryCommand(account: string, at: Pick<OperatorRoot, "workArea"> = OPERATOR_ROOT): HostCommand {
  return wrangler(["containers", "images", "list", "--json"], account, at);
}

/** Pure: the commands `copy` runs, in order. */
export function copyCommands(
  copy: ImageCopy,
  account: string,
  at: Pick<OperatorRoot, "workArea"> = OPERATOR_ROOT,
): HostCommand[] {
  return [
    { cmd: "docker", args: ["pull", "--platform", IMAGE_PLATFORM, copy.source], cwd: PACKAGE_ROOT },
    { cmd: "docker", args: ["tag", copy.source, copy.localTag], cwd: PACKAGE_ROOT },
    wrangler(["containers", "push", copy.localTag], account, at),
  ];
}

export interface ImagesHostOptions {
  spawn?: Spawn;
  stream?: (chunk: string) => void;
  /** The root the wrangler directory resolves under; default: this process's. */
  at?: Pick<OperatorRoot, "workArea">;
  /** Bring the bot Worker's directory to this CLI's version, installed — a no-op in a checkout, the work
   *  area from the package (src/deploy/host.ts `ensureWorkAreaOnHost`). Injectable for the tests. */
  ready?: () => Promise<WorkAreaOutcome>;
}

export function imagesHostIO(options: ImagesHostOptions = {}): ImagesHostIO {
  const spawn = options.spawn ?? run;
  const at = options.at ?? OPERATOR_ROOT;
  const ready = options.ready ?? (() => ensureWorkAreaOnHost([WORKER_DIRS.bot], () => {}));
  const exec = (c: HostCommand, streamed = false) =>
    spawn(c.cmd, c.args, {
      cwd: c.cwd,
      ...(c.set ? { set: c.set } : {}),
      ...(streamed && options.stream ? { stream: options.stream } : {}),
    });
  return {
    registry: async (account) => {
      const workArea = await ready();
      if (!workArea.ok) return { error: workArea.problem };
      const command = registryCommand(account, at);
      const said = command.args.join(" ");
      const r = await exec(command);
      if (r.code !== 0) return { error: `${said} failed: ${lastErrorLines(r.output) || `exit ${r.code}, no output`}` };
      const listing = parseRegistryListing(parseWranglerJson(r.output));
      return listing === undefined ? { error: `${said}: no image listing in the output` } : { value: listing };
    },
    docker: async () => {
      const r = await exec({ cmd: "docker", args: ["version", "--format", "{{.Server.Version}}"], cwd: PACKAGE_ROOT });
      return r.code === 0 ? { ok: true } : { ok: false, problem: dockerUnavailableProblem(lastErrorLines(r.output)) };
    },
    copy: async (copy, account) => {
      const workArea = await ready();
      if (!workArea.ok) return { code: 1, output: workArea.problem };
      let output = "";
      for (const command of copyCommands(copy, account, at)) {
        const r = await exec(command, true);
        output += r.output;
        if (r.code !== 0)
          return { code: r.code, output: `${command.cmd} ${command.args.join(" ")} exited ${r.code}\n${output}` };
      }
      return { code: 0, output };
    },
  };
}
