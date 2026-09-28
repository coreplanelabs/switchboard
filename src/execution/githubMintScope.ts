/** Permissions for the trusted Git door's receive-pack operation. GitHub
 * also requires Workflows when a pushed commit edits .github/workflows. */
export const DOOR_PUSH_PERMISSIONS = {
  contents: "write",
  workflows: "write",
  metadata: "read",
} as const;

/** The resident's root-owned token only clones/fetches its mirror and reads
 * pull request state for worktree reclamation. */
export const RESIDENT_MIRROR_PERMISSIONS = {
  contents: "read",
  pull_requests: "read",
  metadata: "read",
} as const;

type Permission = "read" | "write";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Check GitHub's effective scope before a token enters either cache. GitHub
 * may omit its implicit Metadata read grant from the response. Errors contain
 * only a fixed reason; they never serialize a response or bearer. */
export function verifyGithubMintScope(
  response: unknown,
  repo: string,
  requested: Readonly<Record<string, Permission>>,
): void {
  if (!record(response) || !record(response.permissions)) throw new Error("GitHub token scope mismatch");
  const actual = response.permissions;
  if (
    Object.entries(actual).some(([name, value]) => requested[name] !== value) ||
    Object.keys(requested).some((name) => !(name in actual) && !(name === "metadata" && requested[name] === "read"))
  ) {
    throw new Error("GitHub token scope mismatch");
  }
  if (
    response.repository_selection !== "selected" ||
    !Array.isArray(response.repositories) ||
    response.repositories.length !== 1 ||
    !record(response.repositories[0]) ||
    typeof response.repositories[0].full_name !== "string" ||
    response.repositories[0].full_name.toLowerCase() !== repo.toLowerCase()
  ) {
    throw new Error("GitHub token scope mismatch");
  }
}
