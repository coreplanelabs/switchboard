import type { ArtifactStore } from "../artifacts/store.js";
import { shellQuote } from "../execution/shellQuote.js";
import {
  publicationReason,
  checkpointKey,
  type PublicationBinding,
  type PublicationSettlement,
} from "./publicationSettlement.js";

export const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;

/** Preserve the actual commit and its objects. A rewritten head may be a
 * sibling of the attach head, so the bundle requires their shared ancestor
 * instead. Only the executor handles bytes or signed URLs. Readback verifies
 * the uploaded object, not merely the PUT response or HEAD size. */
export async function saveCheckpointArtifact(input: {
  run: (command: string) => Promise<string>;
  git: string;
  binding: PublicationBinding;
  source: string;
  store?: ArtifactStore;
  originMatchesBinding: () => Promise<boolean>;
}): Promise<PublicationSettlement["preservation"]> {
  const { run, git, binding, source, store } = input;
  if (!store) return { kind: "unavailable", reason: "private artifact storage is unavailable" };
  const base = binding.baseHeadSha;
  if (
    !base ||
    !/^[a-f0-9]{40}$/.test(base) ||
    !/^[a-f0-9]{40}$/.test(source) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(binding.runId)
  )
    return { kind: "unavailable", reason: "the original checkpoint binding is incomplete" };
  try {
    if (
      (await run(`${git} symbolic-ref --quiet --short HEAD`)).trim() !== binding.branch ||
      (await run(`${git} rev-parse HEAD`)).trim() !== source
    )
      throw new Error("the checkpoint branch or head changed before preservation");
    let prerequisite = base;
    try {
      await run(`${git} merge-base --is-ancestor ${shellQuote(base)} ${shellQuote(source)}`);
    } catch {
      prerequisite = (await run(`${git} merge-base ${shellQuote(base)} ${shellQuote(source)}`)).trim();
      if (!/^[a-f0-9]{40}$/.test(prerequisite)) throw new Error("the checkpoint shared prerequisite is unavailable");
    }
    await run(`${git} merge-base --is-ancestor ${shellQuote(prerequisite)} ${shellQuote(base)}`);
    await run(`${git} merge-base --is-ancestor ${shellQuote(prerequisite)} ${shellQuote(source)}`);
    if (prerequisite !== base) {
      if (!(await input.originMatchesBinding()))
        throw new Error("the checkpoint origin no longer names the bound repository");
      // A local merge base alone is not a durable prerequisite. Fetch the
      // remote's current default head and prove it still carries the object.
      await run(`GIT_TERMINAL_PROMPT=0 ${git} fetch --no-tags origin HEAD`);
      const remoteHead = (await run(`${git} rev-parse --verify FETCH_HEAD^{commit}`)).trim();
      if (!/^[a-f0-9]{40}$/.test(remoteHead)) throw new Error("the remote checkpoint prerequisite is unavailable");
      await run(`${git} merge-base --is-ancestor ${shellQuote(prerequisite)} ${shellQuote(remoteHead)}`);
    }
    const path = `/tmp/ship-checkpoint-${binding.runId}-${source}.bundle`;
    await run(
      `${git} bundle create ${shellQuote(path)} ${shellQuote(`refs/heads/${binding.branch}`)} ${shellQuote(`^${prerequisite}`)}`,
    );
    const size = Number((await run(`wc -c < ${shellQuote(path)}`)).trim());
    const sha256 = /^([a-f0-9]{64})\s/.exec(await run(`sha256sum ${shellQuote(path)}`))?.[1];
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_CHECKPOINT_BYTES || sha256 === undefined)
      throw new Error("the checkpoint size or digest could not be measured");
    const key = checkpointKey(binding, source);
    const contentType = "application/octet-stream";
    const put = await store.presignPut(key, contentType);
    await run(
      `curl -fsS -T ${shellQuote(path)} -H ${shellQuote(`Content-Type: ${contentType}`)} -o /dev/null ${shellQuote(put)}`,
    );
    const stored = await store.head(key);
    if (stored?.size !== size || stored.contentType !== contentType)
      throw new Error("the private store did not confirm the checkpoint size and type");
    const downloaded = `${path}.readback`;
    await run(`curl -fsS -o ${shellQuote(downloaded)} ${shellQuote(await store.presignGet(key))}`);
    const readback = /^([a-f0-9]{64})\s/.exec(await run(`sha256sum ${shellQuote(downloaded)}`))?.[1];
    if (readback !== sha256) throw new Error("the stored checkpoint digest does not match");
    await run(`${git} bundle verify ${shellQuote(downloaded)}`);
    const heads = (await run(`${git} bundle list-heads ${shellQuote(downloaded)}`)).trim().split("\n");
    if (heads.length !== 1 || heads[0] !== `${source} refs/heads/${binding.branch}`)
      throw new Error("the stored checkpoint does not name the bound source and branch");
    // Merge histories can have several excluded boundary commits. Every
    // prerequisite must be reachable from the selected boundary.
    const header = await run(`sed -n '1,/^$/ { p; /^$/q; }' ${shellQuote(downloaded)}`);
    const prerequisites = header.split("\n").filter((line) => line.startsWith("-"));
    if (!prerequisites.some((line) => line.startsWith(`-${prerequisite} `)))
      throw new Error("the stored checkpoint does not require the shared prerequisite");
    for (const line of prerequisites) {
      const headerPrerequisite = /^-([a-f0-9]{40}) /.exec(line)?.[1];
      if (!headerPrerequisite) throw new Error("the stored checkpoint prerequisite is invalid");
      await run(`${git} merge-base --is-ancestor ${shellQuote(headerPrerequisite)} ${shellQuote(prerequisite)}`);
    }
    return { kind: "saved", key, size, sha256 };
  } catch (error) {
    return { kind: "unavailable", reason: publicationReason(String(error instanceof Error ? error.message : error)) };
  }
}
