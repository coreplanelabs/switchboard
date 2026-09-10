// The host half of the image copy (`deploy images`, and `deploy all` / `deploy
// plan` in `registry` mode): what this machine does that the plan cannot. The
// plan — which images the account registry already holds, which to copy — is
// pure (src/deploy/images.ts) and the commands (src/core/commands/deploy.ts)
// reach these three operations through `deps.deploy.images`, so their tests run
// over fakes and this file is the one that touches the network.
//
// Nothing here spawns a process. Both the registry read and the copy are the
// HTTPS calls of src/deploy/registryTransferHost.ts under one credential per
// account, minted from CLOUDFLARE_API_TOKEN — the one thing `registry` mode
// needs that the rest of the deploy does not, refused by name when the variable
// is absent, and with the endpoint named when the token is refused. The
// credential lives 45 minutes and a copy can run long: it is re-minted before
// it gets close to expiry, and once more when the registry answers 401 anyway.

import { systemClock } from "../core/trace/clock.js";
import type { Clock } from "../core/trace/types.js";
import type { ImageCopy, RegistryImage } from "./images.js";
import { CREDENTIAL_MINUTES } from "./registryTransfer.js";
import {
  listAccountRegistry,
  mintRegistryCredential,
  transferImage,
  type RegistryCredential,
  type TransferIO,
  type TransferOutcome,
} from "./registryTransferHost.js";
import type { Read } from "./sandboxLiveGate.js";

/** The environment variable the registry credential is minted from. */
export const API_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";

/** How long before the credential's expiry a fresh one is minted instead: a blob upload may run for
 *  minutes, and one that starts on a credential about to expire would fail mid-stream. */
export const RENEW_BEFORE_MS = 5 * 60_000;

/** What the commands need from the host. */
export interface ImagesHostIO {
  /** What the account's registry holds (`GET /v2/_catalog?tags=true` under the minted credential), or why it could not be read. */
  registry(account: string): Promise<Read<RegistryImage[]>>;
  /** Can this host reach the account's registry? Mints (and keeps, for the reads and copies) a push+pull credential
   *  from CLOUDFLARE_API_TOKEN; the problem names the missing variable, or the endpoint and the token permission. */
  credential(account: string): Promise<{ ok: true } | { ok: false; problem: string }>;
  /** Copy one image into the account's registry over HTTPS, under the minted credential. */
  copy(copy: ImageCopy, account: string): Promise<TransferOutcome>;
}

/** The three network calls the host makes — injectable so a test hands it a fake. */
export interface Transfer {
  mint: typeof mintRegistryCredential;
  list: typeof listAccountRegistry;
  transfer: typeof transferImage;
}

/** Pure: why nothing can start without the token. */
export function apiTokenMissingProblem(): string {
  return `${API_TOKEN_ENV} is not set — reading and copying images in the account registry needs a registry credential minted from it (a Cloudflare API token with Containers Edit)`;
}

export interface ImagesHostOptions {
  transfer?: Transfer;
  /** The transfer's own I/O (endpoints, part size, fetch) — the tests' fake registry. */
  transferIO?: TransferIO;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  /** The clock the credential's age is judged by (default: the system clock). */
  now?: Clock;
}

export function imagesHostIO(options: ImagesHostOptions = {}): ImagesHostIO {
  const transfer = options.transfer ?? {
    mint: mintRegistryCredential,
    list: listAccountRegistry,
    transfer: transferImage,
  };
  const env = options.env ?? process.env;
  const now = options.now ?? systemClock;
  const log = options.log ?? (() => {});
  const transferIO: TransferIO = { ...(options.transferIO ?? {}), ...(options.log ? { log: options.log } : {}) };
  // One credential per account, kept while it is fresh: minted on the first ask, spent by every read and copy,
  // replaced when it nears its expiry or when the registry refuses it.
  const credentials = new Map<string, { credential: RegistryCredential; mintedAt: number }>();
  const credential = async (
    account: string,
    replace = false,
  ): Promise<{ ok: true; credential: RegistryCredential } | { ok: false; problem: string }> => {
    const held = credentials.get(account);
    if (held && !replace && now() - held.mintedAt < CREDENTIAL_MINUTES * 60_000 - RENEW_BEFORE_MS)
      return { ok: true, credential: held.credential };
    const token = env[API_TOKEN_ENV];
    if (!token) return { ok: false, problem: apiTokenMissingProblem() };
    const minted = await transfer.mint(account, token, transferIO);
    if (minted.ok) credentials.set(account, { credential: minted.credential, mintedAt: now() });
    else credentials.delete(account);
    return minted;
  };
  /** Did the registry refuse the credential? The transfer flags a 401 on its failures (`unauthorized: true`). */
  const refusedCredential = (r: unknown): boolean =>
    typeof r === "object" && r !== null && (r as { unauthorized?: true }).unauthorized === true;
  /** Run one registry operation under the credential; a 401 from the registry replaces the credential once. */
  const under = async <T>(
    account: string,
    op: (credential: RegistryCredential) => Promise<T>,
    refusal: (problem: string) => T,
  ): Promise<T> => {
    const first = await credential(account);
    if (!first.ok) return refusal(first.problem);
    const r = await op(first.credential);
    if (!refusedCredential(r)) return r;
    log("[images] the account registry refused the credential (401) — minting a fresh one and trying once more");
    const again = await credential(account, true);
    if (!again.ok) return refusal(again.problem);
    return op(again.credential);
  };
  return {
    registry: (account) =>
      under(
        account,
        (c) => transfer.list(account, c, transferIO),
        (problem) => ({ error: problem }),
      ),
    credential: async (account) => {
      const r = await credential(account);
      return r.ok ? { ok: true } : r;
    },
    copy: (copy, account) =>
      under(
        account,
        (c) => transfer.transfer(copy, account, c, transferIO),
        (problem) => ({ ok: false, problem }),
      ),
  };
}
