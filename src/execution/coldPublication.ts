import { githubDoorRepositoryPath } from "../channels/githubDoorPaths.js";
import { shellQuote } from "./shellQuote.js";
// Keep the Worker-shared transport independent of the Node-only Executor
// module: structural compatibility is checked at the bot's call site.
export interface ColdPublicationInput {
  repo: string;
  doorOrigin: string;
  branch: string;
  next: string;
  old?: string;
  bearer: string;
}

// The pack crosses only the Worker, never the bot. It is untrusted even when
// the model sandbox's Git claims to have produced it.
// A one-commit snapshot of an established repository can exceed 1 MiB even
// without its historical ancestry. Both the source read and typed import use
// this cap; the controller separately limits inflated object bytes and count.
export const COLD_PACK_MAX_BYTES = 16_777_216;
const PUB_KEYS = ["repo", "doorOrigin", "branch", "next", "old", "bearer"];
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[a-zA-Z0-9_][a-zA-Z0-9_./-]{0,199}$/;

export function coldPublicationInput(body: unknown): ColdPublicationInput | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((key) => !PUB_KEYS.includes(key))) return null;
  if (
    typeof b.repo !== "string" ||
    b.repo.length > 200 ||
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(b.repo) ||
    b.repo.split("/").some((part) => part === "." || part === ".." || part.startsWith("-"))
  )
    return null;
  if (
    typeof b.branch !== "string" ||
    !NAME.test(b.branch) ||
    b.branch.includes("..") ||
    b.branch.includes("@{") ||
    b.branch.endsWith(".lock") ||
    b.branch.endsWith("/") ||
    b.branch.includes("//")
  )
    return null;
  if (typeof b.next !== "string" || !SHA.test(b.next)) return null;
  if (b.old !== undefined && (typeof b.old !== "string" || !SHA.test(b.old))) return null;
  if (typeof b.bearer !== "string" || !/^[A-Za-z0-9._~-]{1,2048}$/.test(b.bearer)) return null;
  if (typeof b.doorOrigin !== "string") return null;
  try {
    const door = new URL(b.doorOrigin);
    if (
      door.protocol !== "https:" ||
      (door.origin !== b.doorOrigin && `${door.origin}/` !== b.doorOrigin) ||
      door.username ||
      door.password ||
      door.pathname !== "/" ||
      door.search ||
      door.hash
    )
      return null;
  } catch {
    return null;
  }
  return b as unknown as ColdPublicationInput;
}

/** The source VM owns Git and this script: its output has no authority until
 * the controller imports and checks the closed graph. Keep historical parents
 * out of the transfer, but include every new commit's complete tree and the
 * leased old tip's tree; a shallow boundary at old is safe only if the Door's
 * exact old-head lease succeeds. New branches (no old tip) export full history. */
export function sourcePublicationPackCommand(
  next: string,
  old: string | undefined,
  path: string,
  root = "/workspace",
  baseFetched = false,
): string {
  if (!SHA.test(next) || (old !== undefined && !SHA.test(old))) throw new Error("invalid publication tip");
  const oldGraph = old
    ? `git -C "$d" merge-base --is-ancestor ${old} ${next} || exit 1
          { ${baseFetched ? "" : `printf '%s\\n' ${old};`}
            git -C "$d" rev-list --objects --no-object-names ${next} ^${old};
            ${
              baseFetched
                ? ""
                : `git -C "$d" rev-list ${next} ^${old} | while read -r commit; do git -C "$d" rev-list --objects --no-object-names "$commit^{tree}"; done;
            git -C "$d" rev-list --objects --no-object-names ${old}^{tree};`
            }
          }`
    : `git -C "$d" rev-list --objects --no-object-names ${next}`;
  return `set -euo pipefail; for g in $(find ${shellQuote(root)} -maxdepth 4 -name .git -print); do d="$(dirname "$g")"; if git -C "$d" cat-file -e ${next}^{commit} 2>/dev/null; then ${oldGraph} | sort -u | git -C "$d" pack-objects --stdout > ${shellQuote(path)}; test "$(stat -c %s ${shellQuote(path)})" -le ${COLD_PACK_MAX_BYTES}; exit 0; fi; done; exit 1`;
}

export function parseColdPublication(body: unknown): { input: ColdPublicationInput; pack: string } | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { pack, ...input } = body as Record<string, unknown>;
  const checked = coldPublicationInput(input);
  if (
    !checked ||
    typeof pack !== "string" ||
    pack.length < 20 ||
    pack.length > Math.ceil(COLD_PACK_MAX_BYTES / 3) * 4 ||
    !/^UEFDSw[A-Za-z0-9+/]*={0,2}$/.test(pack) ||
    pack.length % 4 !== 0
  )
    return null;
  return { input: checked, pack };
}

/** All commands run in a fresh controlled repository. No model path, helper,
 * alternate, URL, or config is read with the effect bearer. Git's strict pack
 * import and fsck must validate the rooted graph before the Door sees a tip. */
export function controllerPublicationPlan(
  input: ColdPublicationInput,
  base?: string,
  baseSource: "branch" | "default" = "branch",
): {
  command: string;
  fetchCommand: string;
  prepareCommand: string;
  pushCommand: string;
  prepareEnv: Record<string, string>;
  env: Record<string, string>;
} {
  const valid = coldPublicationInput({
    repo: input.repo,
    doorOrigin: input.doorOrigin,
    branch: input.branch,
    next: input.next,
    ...(input.old === undefined ? {} : { old: input.old }),
    bearer: input.bearer,
  });
  if (!valid || (base !== undefined && !SHA.test(base))) throw new Error("invalid typed publication request");
  const remote = `${new URL(input.doorOrigin).origin}${githubDoorRepositoryPath(input.repo)}`;
  const ref = `refs/heads/${input.branch}`;
  const dir = "/workspace/publisher";
  const boundary = base ?? input.old;
  const setup = ["set -euo pipefail", "umask 077", "ulimit -f 32768", "ulimit -v 524288"];
  const objectBounds = `git -C ${dir} verify-pack -v ${dir}/.git/objects/pack/*.idx | awk 'NF >= 5 && $2 ~ /^(commit|tree|blob|tag|ofs-delta|ref-delta)$/ { count++; size += $3; if (count > 50000 || size > 134217728) exit 1 } END { if (count == 0) exit 1 }'`;
  const fetchOld = baseSource === "branch" && input.old !== undefined;
  const prepare = [
    `mkdir -p ${dir}`,
    `git -C ${dir} init -q`,
    ...(boundary && !base ? [`printf '%s\\n' ${boundary} > ${dir}/.git/shallow`] : []),
    ...(base ? [`git -C ${dir} cat-file -e ${base}^{commit}`] : []),
    // index-pack's strict connectivity check cannot distinguish promised
    // base blobs from missing new data. Check object integrity here, then
    // let full strict fsck check connectivity against the trusted base pack.
    // The untrusted pack is never marked promisor.
    `timeout -k 5 60 git -C ${dir} index-pack ${base ? "" : "--strict "}--fsck-objects --stdin < /workspace/transfer.pack`,
    objectBounds,
    `git -C ${dir} cat-file -e ${input.next}^{commit}`,
    ...(boundary
      ? [
          `git -C ${dir} cat-file -e ${boundary}^{commit}`,
          // The old tip is hash-pinned and checked by the Door lease; no
          // history preceding it is needed to validate the new graph.
          `git -C ${dir} update-ref refs/heads/base ${boundary}`,
        ]
      : []),
    `git -C ${dir} update-ref refs/heads/candidate ${input.next}`,
    ...(boundary ? [`git -C ${dir} merge-base --is-ancestor ${boundary} ${input.next}`] : []),
    `timeout -k 5 45 git -C ${dir} fsck --full --strict --no-reflogs --no-progress`,
  ];
  // Thin packing reads remote base blobs to build deltas. The trusted partial
  // base deliberately omits those blobs, so keep every delta base in the pack.
  const push = `timeout -k 5 60 git -C ${dir} push --no-thin --force-with-lease=${shellQuote(`${ref}:${input.old ?? ""}`)} -- ${shellQuote(remote)} ${shellQuote(`${input.next}:${ref}`)}`;
  const baseEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/workspace/publisher",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
    GIT_NO_LAZY_FETCH: "1",
  };
  return {
    command: [...setup, ...prepare, push].join("\n"),
    fetchCommand: [
      ...setup,
      "ulimit -f 16384",
      `mkdir -p ${dir}`,
      `git -C ${dir} init -q`,
      `git -C ${dir} config remote.publication-base.url ${shellQuote(remote)}`,
      `git -C ${dir} config remote.publication-base.promisor true`,
      `timeout -k 5 45 git -C ${dir} -c fetch.fsckObjects=true fetch --no-tags --no-recurse-submodules --depth=1 --filter=blob:none -- publication-base ${shellQuote(fetchOld ? ref : "HEAD")}`,
      // Keep only the trusted promise metadata. Removing the remote URL also
      // disables on-demand reads on image Git versions predating NO_LAZY_FETCH.
      `git -C ${dir} config --unset remote.publication-base.url`,
      `test "$(du -sk ${dir}/.git/objects | cut -f1)" -le ${COLD_PACK_MAX_BYTES / 1024}`,
      objectBounds,
      `git -C ${dir} cat-file -e FETCH_HEAD^{commit}`,
      ...(fetchOld ? [`test "$(git -C ${dir} rev-parse FETCH_HEAD)" = ${input.old}`] : []),
      `timeout -k 5 30 git -C ${dir} fsck --full --strict --no-reflogs --no-progress >/dev/null 2>&1`,
      `git -C ${dir} rev-parse FETCH_HEAD`,
    ].join("\n"),
    prepareCommand: [...setup, ...prepare].join("\n"),
    pushCommand: [...setup, push].join("\n"),
    prepareEnv: {
      ...baseEnv,
      GIT_ALLOW_PROTOCOL: "",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "http.followRedirects",
      GIT_CONFIG_VALUE_1: "false",
    },
    env: {
      ...baseEnv,
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: `http.${remote}.extraheader`,
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${input.bearer}`,
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "/dev/null",
      GIT_CONFIG_KEY_2: "http.followRedirects",
      GIT_CONFIG_VALUE_2: "false",
    },
  };
}
