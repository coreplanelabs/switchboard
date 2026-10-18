import type { GithubCapability } from "../tools/github.js";
import { githubPullSourceContextOf } from "../execution/githubReadSource.js";
import { sourceSnapshot } from "../core/runLedger/sourceEvents.js";
import { githubActivityTaskMatch, type GithubActivityTaskMatch } from "./githubActivity.js";

export type GithubActivityAccess =
  | { kind: "available" }
  | Exclude<GithubActivityTaskMatch, { kind: "candidate" }>
  | { kind: "held"; reason: "access-unproved" };

/** Current adapter access only, never a saved grant or a delivery target.
 * The caller loads the canonical record/task and supplies the existing
 * requester/audience-scoped capability. Call again before each use of source
 * bytes; this does not prove the caller's root, task snapshot or inbox owner. */
export async function githubActivityTaskAccess(
  recordValue: unknown,
  taskValue: unknown,
  capability: Pick<GithubCapability, "api" | "readableRepos"> | undefined,
): Promise<GithubActivityAccess> {
  const held = { kind: "held", reason: "access-unproved" } as const;
  try {
    const captured = sourceSnapshot({ record: recordValue ?? null, task: taskValue ?? null }) as {
      record: unknown;
      task: unknown;
    };
    const task = githubPullSourceContextOf(captured.task);
    const readableRepos = capability?.readableRepos?.bind(capability);
    const listRepos = capability?.api.listRepos.bind(capability.api);
    const getPullRequest = capability?.api.getPullRequest.bind(capability.api);
    const match = await githubActivityTaskMatch(captured.record, captured.task);
    if (match.kind !== "candidate") return match;
    if (!task || !readableRepos || !listRepos || !getPullRequest) return held;
    const sameSource = (value: typeof task.source | undefined) =>
      value?.host === task.source.host &&
      value.appId === task.source.appId &&
      value.installationId === task.source.installationId;
    // Find the current name by native identity. A rename does not let a
    // different repository inherit the old name's source relationship.
    const repositories = structuredClone(await listRepos()).filter((repo) => repo.id === task.repositoryId);
    if (repositories.length !== 1) return held;
    const repository = repositories[0]!;
    if (!sameSource(repository.source)) return held;
    const readable = async () => {
      const current = structuredClone(await readableRepos([repository.fullName]));
      const matches = current.filter((repo) => repo.id === task.repositoryId);
      return (
        matches.length === 1 &&
        matches[0]!.fullName.toLowerCase() === repository.fullName.toLowerCase() &&
        sameSource(matches[0]!.source)
      );
    };
    // App visibility alone is not the original requester's permission.
    if (!(await readable())) return held;
    const pull = structuredClone(await getPullRequest(repository.fullName, task.number));
    const current = githubPullSourceContextOf({
      version: 1,
      source: pull.source,
      repositoryId: pull.base.repositoryId,
      pullRequestId: pull.id,
      number: pull.number,
      head: { repositoryId: pull.head.repositoryId, ref: pull.head.ref, sha: pull.head.sha },
      baseRef: pull.base.ref,
    });
    if (
      !current ||
      !sameSource(current.source) ||
      current.repositoryId !== task.repositoryId ||
      current.pullRequestId !== task.pullRequestId ||
      current.number !== task.number ||
      pull.base.repo.toLowerCase() !== repository.fullName.toLowerCase()
    )
      return held;
    // The PR read can wait. Recheck requester permission and App identity
    // after it; neither the first list nor a successful PR read is enough.
    if (!(await readable())) return held;
    return { kind: "available" };
  } catch {
    // Remote bodies, source names and private errors stay behind the adapter.
    return held;
  }
}
