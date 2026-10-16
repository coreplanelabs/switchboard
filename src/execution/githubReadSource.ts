/** Native facts from one GitHub PR read. This snapshot is neither current
 * access proof nor an execution or delivery target. */
export interface GithubPullSourceContext {
  version: 1;
  source: { host: "github.com"; appId: number; installationId: number };
  repositoryId: number;
  pullRequestId: number;
  number: number;
  head: { repositoryId: number | null; ref: string; sha: string };
  baseRef: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const closed = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;

/** Unknown legacy identity stays absent. Consumers must recheck the canonical
 * context, orchestrator owner and current source access before matching. */
export function githubPullSourceContextOf(value: unknown): GithubPullSourceContext | undefined {
  if (
    !object(value) ||
    !closed(value, ["version", "source", "repositoryId", "pullRequestId", "number", "head", "baseRef"])
  )
    return;
  const { source, head } = value;
  if (
    value.version !== 1 ||
    !id(value.repositoryId) ||
    !id(value.pullRequestId) ||
    !id(value.number) ||
    !text(value.baseRef) ||
    !object(source) ||
    !closed(source, ["host", "appId", "installationId"]) ||
    source.host !== "github.com" ||
    !id(source.appId) ||
    !id(source.installationId) ||
    !object(head) ||
    !closed(head, ["repositoryId", "ref", "sha"]) ||
    !(head.repositoryId === null || id(head.repositoryId)) ||
    !text(head.ref) ||
    typeof head.sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(head.sha)
  )
    return;
  return {
    version: 1,
    source: { host: "github.com", appId: source.appId, installationId: source.installationId },
    repositoryId: value.repositoryId,
    pullRequestId: value.pullRequestId,
    number: value.number,
    head: { repositoryId: head.repositoryId, ref: head.ref, sha: head.sha },
    baseRef: value.baseRef,
  };
}

/** Validate a trusted writer's snapshot before the existing run metadata save. */
export function githubSourceContextForTask(
  value: unknown,
  number: number | undefined,
): GithubPullSourceContext | undefined {
  if (value === undefined) return;
  const context = githubPullSourceContextOf(value);
  if (!context || context.number !== number) throw new Error("GitHub source context does not match the resolved task.");
  return context;
}
