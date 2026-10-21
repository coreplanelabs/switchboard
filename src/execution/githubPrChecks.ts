import { createHash } from "node:crypto";
import { z } from "zod";
import { PrChecksUnavailable, type PrCheck, type PrChecksSnapshot, type PrChecksSource } from "../core/prChecks.js";
import { PR_CHECKS_CACHE_MS, PR_CHECKS_REQUEST_MS, PR_CHECKS_RATE_LIMIT_MS } from "../core/budgets.js";
import { systemClock } from "../core/trace/clock.js";
import { resolveGithubToken } from "./githubApp.js";

const CONTEXT_FIELDS = `totalCount pageInfo { hasNextPage endCursor } nodes {
  __typename
  ... on CheckRun { id name status conclusion detailsUrl title isRequired(pullRequestNumber: $number)
    checkSuite { app { databaseId name logoUrl } workflowRun { event workflow { name } } } }
  ... on StatusContext { id context state description targetUrl isRequired(pullRequestNumber: $number) }
}`;
const QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    headRefOid baseRefOid baseRefName state merged
    baseRef { branchProtectionRule { requiredStatusChecks { context app { databaseId } } } }
    commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100) { ${CONTEXT_FIELDS} } } } } }
    potentialMergeCommit { oid statusCheckRollup { contexts(first: 100) { ${CONTEXT_FIELDS} } } }
  } }
}`;
const PAGE_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $sha: String!, $after: String!) {
  repository(owner: $owner, name: $repo) { object(expression: $sha) { ... on Commit {
    oid statusCheckRollup { contexts(first: 100, after: $after) { ${CONTEXT_FIELDS} } }
  } } }
}`;
const VERIFY_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    headRefOid baseRefOid baseRefName potentialMergeCommit { oid }
  } }
}`;
const nullableText = z.string().nullish();
const app = z.object({ databaseId: z.number(), name: z.string(), logoUrl: nullableText });
const context = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("CheckRun"),
    id: z.string(),
    name: z.string(),
    status: z.string(),
    conclusion: nullableText,
    detailsUrl: nullableText,
    title: nullableText,
    isRequired: z.boolean(),
    checkSuite: z.object({
      app: app.nullable(),
      workflowRun: z.object({ event: z.string(), workflow: z.object({ name: z.string() }) }).nullish(),
    }),
  }),
  z.object({
    __typename: z.literal("StatusContext"),
    id: z.string(),
    context: z.string(),
    state: z.string(),
    description: nullableText,
    targetUrl: nullableText,
    isRequired: z.boolean(),
  }),
]);
const connection = z.object({
  totalCount: z.number(),
  nodes: z.array(context),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: nullableText }),
});
const commit = z.object({
  oid: z.string().regex(/^[0-9a-f]{40}$/),
  statusCheckRollup: z.object({ contexts: connection }).nullable(),
});
const identity = z.object({
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/),
  baseRefOid: z.string(),
  baseRefName: z.string(),
  potentialMergeCommit: z.object({ oid: z.string() }).nullable(),
});
const pull = identity.extend({
  state: z.string(),
  merged: z.boolean(),
  baseRef: z
    .object({
      branchProtectionRule: z
        .object({
          requiredStatusChecks: z
            .array(z.object({ context: z.string(), app: z.object({ databaseId: z.number() }).nullable() }))
            .nullable(),
        })
        .nullable(),
    })
    .nullable(),
  commits: z.object({ nodes: z.array(z.object({ commit })) }),
  potentialMergeCommit: commit.nullable(),
});
type Context = z.infer<typeof context>;
type Requirement = { context: string; appId?: number };
const ERROR = "GitHub checks could not be read.";

function webUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}
// GitHub excludes manual and other non-PR workflow events from PR requirements.
// External apps have no workflowRun and are not subject to this restriction.
function eligible(c: Context): boolean {
  if (c.__typename !== "CheckRun" || !c.checkSuite.workflowRun) return true;
  return [
    "push",
    "pull_request",
    "pull_request_review",
    "pull_request_target",
    "deployment",
    "deployment_status",
  ].includes(c.checkSuite.workflowRun.event);
}
function row(c: Context): PrCheck {
  if (c.__typename === "StatusContext")
    return {
      id: c.id,
      name: c.context,
      required: c.isRequired,
      status: c.state === "SUCCESS" ? "success" : c.state === "ERROR" || c.state === "FAILURE" ? "failure" : "pending",
      ...(c.description ? { description: c.description } : {}),
      ...(webUrl(c.targetUrl) ? { url: webUrl(c.targetUrl) } : {}),
    };
  const workflow = c.checkSuite.workflowRun?.workflow.name;
  const status: PrCheck["status"] =
    c.status !== "COMPLETED"
      ? c.status === "IN_PROGRESS"
        ? "in_progress"
        : "pending"
      : c.conclusion === "SUCCESS"
        ? "success"
        : c.conclusion === "NEUTRAL"
          ? "neutral"
          : c.conclusion === "SKIPPED"
            ? "skipped"
            : c.conclusion === "CANCELLED"
              ? "cancelled"
              : "failure";
  // The job's name remains intact; GitHub puts the workflow before it.
  return {
    id: c.id,
    name: workflow ? `${workflow} / ${c.name}` : c.name,
    status,
    required: c.isRequired && eligible(c),
    ...(c.title ? { description: c.title } : {}),
    ...(webUrl(c.detailsUrl) ? { url: webUrl(c.detailsUrl) } : {}),
    ...(c.checkSuite.app ? { provider: c.checkSuite.app.name } : {}),
    ...(webUrl(c.checkSuite.app?.logoUrl)?.startsWith("https://avatars.githubusercontent.com/")
      ? { icon: webUrl(c.checkSuite.app?.logoUrl) }
      : {}),
  };
}

interface Deps {
  fetch: typeof globalThis.fetch;
  token: () => Promise<string | null>;
  clock: () => number;
}

/** Ephemeral cache only: it limits shared API reads, never owns durable state.
 * Authorization stays in the command and runs before every cache lookup. */
export class GithubPrChecksSource implements PrChecksSource {
  private readonly deps: Deps;
  private readonly cache = new Map<string, { at: number; value: Promise<PrChecksSnapshot> }>();
  private blockedUntil = 0;
  constructor(deps: Partial<Deps> = {}) {
    this.deps = {
      fetch: (...args) => globalThis.fetch(...args),
      token: resolveGithubToken,
      clock: systemClock,
      ...deps,
    };
  }
  read(repo: string, number: number): Promise<PrChecksSnapshot> {
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
      repo.split("/").some((p) => p === "." || p === "..") ||
      !Number.isSafeInteger(number) ||
      number < 1
    )
      return Promise.reject(new Error("Invalid pull request."));
    const key = `${repo}#${number}`;
    const old = this.cache.get(key);
    if (old && this.deps.clock() - old.at < PR_CHECKS_CACHE_MS) return old.value;
    if (this.deps.clock() < this.blockedUntil)
      return Promise.reject(
        new PrChecksUnavailable("GitHub's API rate limit was reached. Checks will refresh after its wait period."),
      );
    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
    const entry = { at: this.deps.clock(), value: this.load(repo, number) };
    this.cache.set(key, entry);
    void entry.value.catch(() => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    return entry.value;
  }
  private async load(repo: string, number: number): Promise<PrChecksSnapshot> {
    const token = await this.deps.token();
    if (!token) throw new PrChecksUnavailable("The bot has no GitHub credential.");
    const headers = {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "switchboard-pr-checks",
    };
    const signal = AbortSignal.timeout(PR_CHECKS_REQUEST_MS);
    const request = async (url: string, init: RequestInit): Promise<Response> => {
      let res: Response;
      try {
        res = await this.deps.fetch(url, init);
      } catch (cause) {
        throw new PrChecksUnavailable(ERROR, { cause });
      }
      if (
        (res.status === 403 || res.status === 429) &&
        (res.status === 429 || res.headers.has("retry-after") || res.headers.get("x-ratelimit-remaining") === "0")
      ) {
        const retry = Number(res.headers.get("retry-after"));
        const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
        this.blockedUntil = Math.max(
          this.deps.clock() + PR_CHECKS_RATE_LIMIT_MS,
          this.deps.clock() + (Number.isFinite(retry) ? retry * 1000 : 0),
          Number.isFinite(reset) ? reset : 0,
        );
        throw new PrChecksUnavailable(
          "GitHub's API rate limit was reached. Checks will refresh after its wait period.",
        );
      }
      return res;
    };
    const [owner, name] = repo.split("/");
    const variables = { owner, repo: name, number };
    const query = async (query: string, extra = {}): Promise<unknown> => {
      const res = await request("https://api.github.com/graphql", {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({ query, variables: { ...variables, ...extra } }),
      });
      if (!res.ok) throw new PrChecksUnavailable(`${ERROR} HTTP ${res.status}.`);
      const answer = z
        .object({ data: z.unknown().optional(), errors: z.array(z.object({ type: z.string().optional() })).optional() })
        .parse(await res.json());
      if (answer.errors?.some((e) => e.type === "RATE_LIMITED")) {
        const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
        this.blockedUntil = Math.max(this.deps.clock() + PR_CHECKS_RATE_LIMIT_MS, Number.isFinite(reset) ? reset : 0);
        throw new PrChecksUnavailable(
          "GitHub's API rate limit was reached. Checks will refresh after its wait period.",
        );
      }
      if (answer.errors?.length) throw new PrChecksUnavailable(ERROR, { cause: answer.errors });
      return answer.data;
    };
    const initial = z.object({ repository: z.object({ pullRequest: pull }) }).parse(await query(QUERY))
      .repository.pullRequest;
    const head = initial.commits.nodes[0]?.commit;
    if (!head || head.oid !== initial.headRefOid) throw new PrChecksUnavailable(ERROR);
    const selected = initial.potentialMergeCommit?.statusCheckRollup?.contexts.totalCount
      ? initial.potentialMergeCommit
      : head;
    let page = selected.statusCheckRollup?.contexts;
    const contexts = [...(page?.nodes ?? [])];
    const cursors = new Set<string>();
    const warnings: string[] = [];
    while (page?.pageInfo.hasNextPage) {
      const after = page.pageInfo.endCursor;
      if (!after || cursors.has(after) || cursors.size >= 10) {
        warnings.push("Some checks could not be loaded.");
        break;
      }
      cursors.add(after);
      const next = z
        .object({ repository: z.object({ object: commit }) })
        .parse(await query(PAGE_QUERY, { sha: selected.oid, after })).repository.object;
      if (next.oid !== selected.oid || !next.statusCheckRollup) throw new PrChecksUnavailable(ERROR);
      page = next.statusCheckRollup.contexts;
      contexts.push(...page.nodes);
    }
    const required: Requirement[] = (initial.baseRef?.branchProtectionRule?.requiredStatusChecks ?? []).map((r) => ({
      context: r.context,
      ...(r.app ? { appId: r.app.databaseId } : {}),
    }));
    for (let pageNumber = 1; pageNumber <= 10; pageNumber++) {
      const res = await request(
        `https://api.github.com/repos/${repo}/rules/branches/${encodeURIComponent(initial.baseRefName)}?per_page=100${pageNumber > 1 ? `&page=${pageNumber}` : ""}`,
        { headers, signal },
      );
      if (!res.ok) {
        warnings.push("Required checks could not be fully read.");
        break;
      }
      const rules = z
        .array(
          z.object({
            type: z.string(),
            parameters: z
              .object({
                required_status_checks: z
                  .array(z.object({ context: z.string(), integration_id: z.number().nullable().optional() }))
                  .optional(),
              })
              .nullish(),
          }),
        )
        .parse(await res.json());
      for (const rule of rules) {
        if (rule.type === "workflows")
          warnings.push("Required workflows may have additional expected checks on GitHub.");
        if (rule.type !== "required_status_checks") continue;
        if (!rule.parameters?.required_status_checks) {
          warnings.push("Required checks could not be fully read.");
          continue;
        }
        for (const r of rule.parameters.required_status_checks)
          required.push({
            context: r.context,
            ...(typeof r.integration_id === "number" && r.integration_id > 0 ? { appId: r.integration_id } : {}),
          });
      }
      if (!res.headers.get("link")?.includes('rel="next"')) break;
      if (pageNumber === 10) warnings.push("Required checks could not be fully read.");
    }
    // Pages and rules can take long enough for a push or base update to land.
    const final = z.object({ repository: z.object({ pullRequest: identity }) }).parse(await query(VERIFY_QUERY))
      .repository.pullRequest;
    if (
      final.headRefOid !== initial.headRefOid ||
      final.baseRefOid !== initial.baseRefOid ||
      final.baseRefName !== initial.baseRefName ||
      final.potentialMergeCommit?.oid !== initial.potentialMergeCommit?.oid
    )
      throw new PrChecksUnavailable("The pull request changed while checks were read. Waiting for its current checks.");
    const unique = [...new Map(contexts.map((c) => [c.id, c])).values()];
    const checks = unique.map(row);
    for (const r of new Map(required.map((r) => [`${r.context}:${r.appId ?? "any"}`, r])).values()) {
      const matches = unique.some(
        (c) =>
          eligible(c) &&
          (c.__typename === "CheckRun" ? c.name : c.context) === r.context &&
          (r.appId === undefined ||
            (c.__typename === "CheckRun" ? c.checkSuite.app?.databaseId === r.appId : c.isRequired)),
      );
      if (!matches)
        checks.push({
          id: `expected:${createHash("sha256")
            .update(JSON.stringify([r.context, r.appId ?? null]))
            .digest("hex")}`,
          name: r.context,
          status: "expected",
          required: true,
          description: "Expected — Waiting for status to be reported",
        });
    }
    return {
      repo,
      number,
      headSha: initial.headRefOid,
      checkedSha: selected.oid,
      state: initial.merged ? "MERGED" : initial.state,
      checkedAt: this.deps.clock(),
      checks,
      warnings: [...new Set(warnings)],
    };
  }
}
