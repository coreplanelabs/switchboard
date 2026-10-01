/** Git transport for a runner-owned publication effect. The resident runs this
 * argv as its privileged container user, using its root-owned mirror as the
 * repository. The model's worktree contributes objects only: its config,
 * hooks and shell are never executed with the effect credential. */
import { githubDoorRepositoryPath } from "../channels/githubDoorPaths.js";

export interface ResidentPublicationInput {
  worktreePath: string;
  repo: string;
  doorOrigin: string;
  branch: string;
  next: string;
  old?: string;
  bearer: string;
}

const MIRROR_DIR = "/workspace/mirror";

function safeName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    !value.startsWith("-") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith(".lock") &&
    [...value].every(
      (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || "_./-".includes(c),
    )
  );
}

function sha(value: string): boolean {
  return value.length === 40 && [...value].every((c) => (c >= "0" && c <= "9") || (c >= "a" && c <= "f"));
}

export function residentPublicationCommand(input: ResidentPublicationInput): {
  argv: string[];
  env: Record<string, string>;
} {
  const repoParts = input.repo.split("/");
  if (repoParts.length !== 2 || !repoParts.every((part) => safeName(part) && !part.includes("/")))
    throw new Error("publication repository is invalid");
  if (!safeName(input.branch) || input.branch.startsWith("/") || input.branch.endsWith("/"))
    throw new Error("publication branch is invalid");
  if (!sha(input.next) || (input.old !== undefined && !sha(input.old)))
    throw new Error("publication commit is invalid");
  if (!input.worktreePath.startsWith("/workspace/threads/") || input.worktreePath.includes(".."))
    throw new Error("publication worktree is invalid");
  if (!input.bearer) throw new Error("publication credential is missing");
  let door: URL;
  try {
    door = new URL(input.doorOrigin);
  } catch {
    throw new Error("publication door is invalid");
  }
  if (door.protocol !== "https:" || door.username || door.password || door.pathname !== "/" || door.search || door.hash)
    throw new Error("publication door is invalid");
  const ref = `refs/heads/${input.branch}`;
  const argv = [
    "git",
    "-C",
    MIRROR_DIR,
    "push",
    ...(input.old ? [`--force-with-lease=${ref}:${input.old}`] : []),
    `${door.origin}${githubDoorRepositoryPath(input.repo)}`,
    `${input.next}:${ref}`,
  ];
  const env = {
    GH_ENTERPRISE_TOKEN: input.bearer,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: `${input.worktreePath}/.git/objects`,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: `credential.${door.origin}.helper`,
    GIT_CONFIG_VALUE_1: `!f() { test -n "$GH_ENTERPRISE_TOKEN" || exit 1; printf '%s\\n' 'username=x-access-token' "password=$GH_ENTERPRISE_TOKEN"; }; f`,
    GIT_CONFIG_KEY_2: "core.hooksPath",
    GIT_CONFIG_VALUE_2: "/dev/null",
  };
  return { argv, env };
}
