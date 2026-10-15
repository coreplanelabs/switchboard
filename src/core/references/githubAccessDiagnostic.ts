/** Closed diagnostic facts, shared with record readers; never source content. */
export const GITHUB_ACCESS_TOOLS = [
  "unknown",
  "github_repos",
  "github_file",
  "github_tree",
  "github_search_code",
  "github_issue_list",
  "github_issue_get",
  "github_pull_get",
  "github_actions_run",
  "github_actions_job_log",
] as const;
export const GITHUB_ACCESS_STAGES = ["tool-family", "catalog", "repository", "contents", "tool-read"] as const;
export const GITHUB_ACCESS_REASONS = [
  "unsupported-tool",
  "repository-missing",
  "public-result-changed",
  "no-api-call",
  "credential-missing",
  "credential-failed",
  "http",
  "api",
  "timeout",
  "transport",
  "decode",
  "unknown",
] as const;
export const GITHUB_ACCESS_OPERATIONS = [
  "none",
  "listRepos",
  "isPublicRepo",
  "readFile",
  "listTree",
  "searchCode",
  "listIssues",
  "getIssue",
  "getPullRequest",
  "getPullRequestFeedback",
  "getActionsRun",
  "getActionsJob",
  "getActionsJobLog",
] as const;
export const GITHUB_ACCESS_ROUTES = [
  "installation_repos",
  "repository",
  "repository_user_permission",
  "contents",
  "contents_raw",
  "search_code",
  "issues",
  "issue",
  "issue_comments",
  "pull",
  "pull_reviews",
  "pull_review_comments",
  "head_ref",
  "compare",
  "actions_run",
  "actions_run_jobs",
  "actions_job",
  "actions_job_logs",
  "actions_job_logs_blob",
] as const;
export interface GithubAccessDiagnostic {
  tool: (typeof GITHUB_ACCESS_TOOLS)[number];
  stage: (typeof GITHUB_ACCESS_STAGES)[number];
  reason: (typeof GITHUB_ACCESS_REASONS)[number];
  operation: (typeof GITHUB_ACCESS_OPERATIONS)[number];
  sourceCallHash: string;
  httpStatus?: number;
  requestId?: string;
  route?: (typeof GITHUB_ACCESS_ROUTES)[number];
}

export function githubAccessDiagnosticOf(value: unknown): GithubAccessDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) =>
        !["tool", "stage", "reason", "operation", "sourceCallHash", "httpStatus", "requestId", "route"].includes(key),
    ) ||
    !(GITHUB_ACCESS_TOOLS as readonly unknown[]).includes(v.tool) ||
    !(GITHUB_ACCESS_STAGES as readonly unknown[]).includes(v.stage) ||
    !(GITHUB_ACCESS_REASONS as readonly unknown[]).includes(v.reason) ||
    !(GITHUB_ACCESS_OPERATIONS as readonly unknown[]).includes(v.operation) ||
    (v.route !== undefined && !(GITHUB_ACCESS_ROUTES as readonly unknown[]).includes(v.route)) ||
    typeof v.sourceCallHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.sourceCallHash) ||
    (v.httpStatus !== undefined &&
      (typeof v.httpStatus !== "number" ||
        !Number.isInteger(v.httpStatus) ||
        v.httpStatus < 100 ||
        v.httpStatus > 599)) ||
    (v.requestId !== undefined && (typeof v.requestId !== "string" || !/^[0-9A-Fa-f:]{1,64}$/.test(v.requestId)))
  )
    return undefined;
  return {
    tool: v.tool as GithubAccessDiagnostic["tool"],
    stage: v.stage as GithubAccessDiagnostic["stage"],
    reason: v.reason as GithubAccessDiagnostic["reason"],
    operation: v.operation as GithubAccessDiagnostic["operation"],
    sourceCallHash: v.sourceCallHash,
    ...(v.httpStatus !== undefined ? { httpStatus: v.httpStatus as number } : {}),
    ...(v.requestId !== undefined ? { requestId: v.requestId as string } : {}),
    ...(v.route !== undefined ? { route: v.route as GithubAccessDiagnostic["route"] } : {}),
  };
}
