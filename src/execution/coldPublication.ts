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

const PACK_CAUSES = [
  "command-refused",
  "unavailable",
  "stream-not-binary",
  "stream-over-limit",
  "stream-unavailable",
  "stream-timeout",
] as const;
const BASE_CAUSES = ["command-refused", "unavailable", "hash-format-refused"] as const;
export type ColdPackResult =
  { kind: "exported"; pack: string } | { kind: "refused"; cause: (typeof PACK_CAUSES)[number] };
export type ColdBaseResult =
  { kind: "fetched"; base: string } | { kind: "refused"; cause: (typeof BASE_CAUSES)[number] };
export type ColdPublicationDiagnostic =
  | {
      step: "requested-graph" | "branch-graph" | "default-graph" | "ancestry-graph" | "ancestor-graph";
      cause: (typeof PACK_CAUSES)[number];
    }
  | { step: "branch-base" | "default-base" | "ancestor-base"; cause: (typeof BASE_CAUSES)[number] }
  | { step: "pack-format"; cause: "invalid" };

/** Refusal provenance is display-only. It never supplies graph, lease or
 * recovery authority, and contains no command output or exception text. */
export function coldPublicationDiagnostics(value: unknown): ColdPublicationDiagnostic[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return null;
  const steps = [
    "requested-graph",
    "branch-base",
    "branch-graph",
    "default-base",
    "default-graph",
    "ancestry-graph",
    "ancestor-base",
    "ancestor-graph",
    "pack-format",
  ];
  let previous = -1;
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join(",") !== "cause,step")
      return null;
    const at = steps.indexOf(row.step);
    if (at <= previous) return null;
    previous = at;
    const causes: readonly string[] =
      row.step === "pack-format" ? ["invalid"] : row.step.endsWith("-base") ? BASE_CAUSES : PACK_CAUSES;
    if (!causes.includes(row.cause)) return null;
  }
  return value as ColdPublicationDiagnostic[];
}

export function coldPublicationBaseResult(exitCode: number, stdout: string): ColdBaseResult {
  if (exitCode !== 0) return { kind: "refused", cause: "command-refused" };
  const base = stdout.trim();
  return SHA.test(base) ? { kind: "fetched", base } : { kind: "refused", cause: "hash-format-refused" };
}

/** The Worker measures decoded bytes independently of the model's stat.
 * Only a complete binary stream reaches the controller's strict Git import. */
export async function readColdPublicationPack(chunks: AsyncIterable<unknown>): Promise<ColdPackResult> {
  let bytes = 0;
  const parts: string[] = [];
  try {
    for await (const chunk of chunks) {
      if (!(chunk instanceof Uint8Array)) return { kind: "refused", cause: "stream-not-binary" };
      if ((bytes += chunk.byteLength) > COLD_PACK_MAX_BYTES) return { kind: "refused", cause: "stream-over-limit" };
      for (let at = 0; at < chunk.length; at += 8192) parts.push(String.fromCharCode(...chunk.subarray(at, at + 8192)));
    }
    return { kind: "exported", pack: btoa(parts.join("")) };
  } catch {
    return { kind: "refused", cause: "stream-unavailable" };
  }
}

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
  ancestryOnly = false,
): string {
  if (!SHA.test(next) || (old !== undefined && !SHA.test(old))) throw new Error("invalid publication tip");
  if (ancestryOnly && !old) throw new Error("ancestry requires an exact old tip");
  const oldGraph = ancestryOnly
    ? `git -C "$d" rev-list --objects --no-object-names --filter=tree:0 ${old} ${next}`
    : old
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
  ancestryCommand: string;
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
  const trustedFetch = (target: string, expected?: string, closure = true, setupFirst = true) =>
    [
      ...(setupFirst ? setup : []),
      "ulimit -f 16384",
      `mkdir -p ${dir}`,
      `git -C ${dir} init -q`,
      `git -C ${dir} config remote.publication-base.url ${shellQuote(remote)}`,
      `git -C ${dir} config remote.publication-base.promisor true`,
      `timeout -k 5 45 git -C ${dir} -c fetch.fsckObjects=true fetch --no-tags --no-recurse-submodules --depth=1 --filter=blob:none -- publication-base ${target}`,
      // Older Git ignores NO_LAZY_FETCH; removing the URL prevents promised
      // objects from triggering another read during graph checks or packing.
      `git -C ${dir} config --unset remote.publication-base.url`,
      `test "$(du -sk ${dir}/.git/objects | cut -f1)" -le ${COLD_PACK_MAX_BYTES / 1024}`,
      objectBounds,
      `git -C ${dir} cat-file -e FETCH_HEAD^{commit}`,
      ...(expected ? [`test "$(git -C ${dir} rev-parse FETCH_HEAD)" = ${expected}`] : []),
      ...(closure
        ? [`timeout -k 5 30 git -C ${dir} fsck --full --strict --no-reflogs --no-progress >/dev/null 2>&1`]
        : []),
      `git -C ${dir} rev-parse FETCH_HEAD`,
    ].join("\n");
  const fetchCommand = trustedFetch(shellQuote(fetchOld ? ref : "HEAD"), fetchOld ? input.old : undefined);
  // The model supplies only ordinary commit objects. Their hashes and parent
  // links must establish a complete path from the trusted exact old tip and
  // candidate to one common cut; an omitted parent above that cut refuses.
  const ancestryCommand = input.old
    ? [
        ...setup,
        `{ ${trustedFetch(shellQuote(ref), input.old, true, false)}; } >/dev/null`,
        `timeout -k 5 60 git -C ${dir} index-pack --fsck-objects --stdin < /workspace/ancestry.pack >/dev/null`,
        objectBounds,
        `git -C ${dir} cat-file -e ${input.old}^{commit}`,
        `git -C ${dir} cat-file -e ${input.next}^{commit}`,
        `if test -f ${dir}/.git/shallow; then cp ${dir}/.git/shallow /workspace/trusted-shallow; else : > /workspace/trusted-shallow; fi`,
        `rm -f ${dir}/.git/shallow`,
        // No-walk parent formatting works on the image's Git even when a
        // historical parent is absent; missing-commit rev-list does not.
        `timeout -k 5 45 git -C ${dir} cat-file --batch-all-objects --batch-check='%(objectname) %(objecttype)' > /workspace/ancestry.objects`,
        `test "$(wc -c < /workspace/ancestry.objects)" -le ${COLD_PACK_MAX_BYTES}`,
        `awk -v old=${input.old} -v candidate=${input.next} 'NF != 2 || length($1) != 40 || $1 ~ /[^0-9a-f]/ || $2 !~ /^(commit|tree|blob|tag)$/ || seen[$1]++ || ++count > 50000 { bad=1; exit 1 } { types[$1]=$2; if ($2 == "commit") print $1 } END { if (bad || types[old] != "commit" || types[candidate] != "commit") exit 1 }' /workspace/ancestry.objects > /workspace/ancestry.commits`,
        `timeout -k 5 45 git -C ${dir} log --no-walk=unsorted --no-decorate --format='%H %P' --stdin < /workspace/ancestry.commits > /workspace/ancestry.parents`,
        `test "$(wc -c < /workspace/ancestry.parents)" -le ${COLD_PACK_MAX_BYTES}`,
        `awk 'NR==FNR { expected[$1]=1; count++; next } !($1 in expected) || seen[$1]++ { bad=1; exit 1 } { actual++; for (i=1;i<=NF;i++) if (length($i) != 40 || $i ~ /[^0-9a-f]/) { bad=1; exit 1 } } END { if (bad || actual != count) exit 1 }' /workspace/ancestry.commits /workspace/ancestry.parents`,
        `awk 'NR==FNR { types[$1]=$2; next } { for (i=2;i<=NF;i++) { if (!($i in types)) cut[$1]=1; else if (types[$i] != "commit") { bad=1; exit 1 } } } END { if (bad) exit 1; for (commit in cut) print commit }' /workspace/ancestry.objects /workspace/ancestry.parents > ${dir}/.git/shallow`,
        `timeout -k 5 45 git -C ${dir} rev-list --parents ${input.old} ${input.next} > /workspace/ancestry.rows`,
        `test "$(wc -c < /workspace/ancestry.rows)" -le ${COLD_PACK_MAX_BYTES}`,
        `awk 'NR==FNR { roots[$1]=1; next } $1 in roots' /workspace/ancestry.rows ${dir}/.git/shallow > /workspace/ancestry.cuts`,
        `mv /workspace/ancestry.cuts ${dir}/.git/shallow`,
        `base="$(git -C ${dir} merge-base --all ${input.old} ${input.next})"`,
        `[[ "$base" =~ ^[0-9a-f]{40}$ ]]`,
        `git -C ${dir} merge-base --is-ancestor "$base" ${input.old}`,
        `git -C ${dir} merge-base --is-ancestor "$base" ${input.next}`,
        `while read -r cut; do git -C ${dir} merge-base --is-ancestor "$cut" "$base" || exit 1; done < ${dir}/.git/shallow`,
        // Keep the old-to-base path traversable for push negotiation. Only
        // unrelated history retains cuts made by the trusted fetches.
        `awk 'NR==FNR { seen[$1]=1; next } !($1 in seen)' /workspace/ancestry.rows /workspace/trusted-shallow >> ${dir}/.git/shallow`,
        `sort -u ${dir}/.git/shallow > /workspace/publication-shallow`,
        `mv /workspace/publication-shallow ${dir}/.git/shallow`,
        // Partial graph import is not a promise. Only the independently fetched
        // repository base can promise the old objects omitted from the final pack.
        trustedFetch('"$base"', '"$base"', false, false),
      ].join("\n")
    : "exit 1";
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
    fetchCommand,
    ancestryCommand,
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
