// The host half of the image copy (`deploy images`, and `deploy all` in
// `registry` mode): what this machine does that the plan cannot. The plan —
// which images the account registry already holds, which to copy — is pure
// (src/deploy/images.ts) and the commands (src/core/commands/deploy.ts) reach
// these three operations through `deps.deploy.images`, so their tests run over
// fakes and this file is the one that touches a process and the network.
//
// The registry is READ with wrangler (`containers images list --json`), run in
// the bot Worker's directory as the operator root resolves it
// (src/deploy/operatorRoot.ts: the tree in a checkout, the work area from the
// published package — materialised and installed first, so the pinned wrangler
// is there to run) with CLOUDFLARE_ACCOUNT_ID SET to the profile's account. The
// deploy steps strip that variable because it would override the account the
// rendered wrangler.jsonc pins; this is an account-level call that needs no
// Worker config at all — `deploy plan` probes the registry from a root that has
// rendered nothing — so the profile supplies the account the same way.
//
// The copy itself never touches a process: it is the HTTPS transfer of
// src/deploy/registryTransferHost.ts, under a credential minted once per
// account from CLOUDFLARE_API_TOKEN — the one thing the copy needs that the
// rest of the deploy does not, refused by name when it is absent or when the
// token lacks Containers Edit.

import { ensureWorkAreaOnHost, OPERATOR_ROOT } from "./host.js";
import { parseRegistryListing, type ImageCopy, type RegistryImage } from "./images.js";
import { workPath, type OperatorRoot } from "./operatorRoot.js";
import { lastErrorLines, WORKER_DIRS } from "./plan.js";
import {
  mintRegistryCredential,
  transferImage,
  type RegistryCredential,
  type TransferIO,
  type TransferOutcome,
} from "./registryTransferHost.js";
import { run } from "./run.js";
import { parseWranglerJson, type Read } from "./sandboxLiveGate.js";
import type { WorkAreaOutcome } from "./workArea.js";

/** The environment variable the copy's credential is minted from. */
export const API_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";

/** What the commands need from the host. */
export interface ImagesHostIO {
  /** `wrangler containers images list --json` on the account: what its registry holds, or why it could not be read. */
  registry(account: string): Promise<Read<RegistryImage[]>>;
  /** Can this host push into the account's registry? Mints (and keeps, for the copies) a push+pull credential from
   *  CLOUDFLARE_API_TOKEN; the problem names the missing variable or the missing token permission. */
  credential(account: string): Promise<{ ok: true } | { ok: false; problem: string }>;
  /** Copy one image into the account's registry over HTTPS, under the minted credential. */
  copy(copy: ImageCopy, account: string): Promise<TransferOutcome>;
}

/** The spawn the registry read runs through — injectable so a test hands it a fake. */
export type Spawn = typeof run;

/** The two network calls the copy makes — injectable so a test hands it a fake. */
export interface Transfer {
  mint: typeof mintRegistryCredential;
  transfer: typeof transferImage;
}

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

/** Pure: the read of the account registry. */
export function registryCommand(account: string, at: Pick<OperatorRoot, "workArea"> = OPERATOR_ROOT): HostCommand {
  return {
    cmd: "npx",
    args: ["wrangler", "containers", "images", "list", "--json"],
    cwd: wranglerDir(at),
    set: { CLOUDFLARE_ACCOUNT_ID: account },
  };
}

/** Pure: why the copy cannot start without the token. */
export function apiTokenMissingProblem(): string {
  return `${API_TOKEN_ENV} is not set — copying images into the account registry mints a registry credential from it (a Cloudflare API token with Containers Edit)`;
}

export interface ImagesHostOptions {
  spawn?: Spawn;
  transfer?: Transfer;
  /** The transfer's own I/O (endpoints, part size, fetch) — the tests' fake registry. */
  transferIO?: TransferIO;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
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
  const transfer = options.transfer ?? { mint: mintRegistryCredential, transfer: transferImage };
  const env = options.env ?? process.env;
  const transferIO: TransferIO = { ...(options.transferIO ?? {}), ...(options.log ? { log: options.log } : {}) };
  // One credential per account for the life of this host: minted by the pre-check, spent by the copies.
  const credentials = new Map<string, RegistryCredential>();
  const credential = async (
    account: string,
  ): Promise<{ ok: true; credential: RegistryCredential } | { ok: false; problem: string }> => {
    const held = credentials.get(account);
    if (held) return { ok: true, credential: held };
    const token = env[API_TOKEN_ENV];
    if (!token) return { ok: false, problem: apiTokenMissingProblem() };
    const minted = await transfer.mint(account, token, transferIO);
    if (minted.ok) credentials.set(account, minted.credential);
    return minted;
  };
  return {
    registry: async (account) => {
      const workArea = await ready();
      if (!workArea.ok) return { error: workArea.problem };
      const command = registryCommand(account, at);
      const said = command.args.join(" ");
      const r = await spawn(command.cmd, command.args, { cwd: command.cwd, set: command.set });
      if (r.code !== 0) return { error: `${said} failed: ${lastErrorLines(r.output) || `exit ${r.code}, no output`}` };
      const listing = parseRegistryListing(parseWranglerJson(r.output));
      return listing === undefined ? { error: `${said}: no image listing in the output` } : { value: listing };
    },
    credential: async (account) => {
      const r = await credential(account);
      return r.ok ? { ok: true } : r;
    },
    copy: async (copy, account) => {
      const r = await credential(account);
      if (!r.ok) return r;
      return transfer.transfer(copy, account, r.credential, transferIO);
    },
  };
}
