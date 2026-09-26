/** The model's API reads must stay inside the repository the run owns. REST
 * has a path to check; GraphQL is admitted only in a narrow repository-rooted
 * shape. Unknown query syntax fails closed instead of reaching GitHub. */

export function scopedRestRead(path: string, boundRepo: string): boolean {
  const match = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/|$)/.exec(path);
  return match !== null && `${match[1]}/${match[2]}`.toLowerCase() === boundRepo.toLowerCase();
}

type Token = { kind: "name" | "string" | "number" | "punct"; value: string };

function tokensOf(source: string): Token[] | undefined {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const whitespace = /^[\s,]+/.exec(rest);
    if (whitespace) {
      index += whitespace[0].length;
      continue;
    }
    if (rest.startsWith("#")) {
      index += rest.indexOf("\n") < 0 ? rest.length : rest.indexOf("\n");
      continue;
    }
    if (rest.startsWith('"""')) return undefined;
    if (rest.startsWith('"')) {
      const raw = /^"(?:[^"\\\r\n]|\\.)*"/.exec(rest)?.[0];
      if (!raw) return undefined;
      try {
        tokens.push({ kind: "string", value: JSON.parse(raw) as string });
      } catch {
        return undefined;
      }
      index += raw.length;
    } else {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)?.[0];
      if (name) {
        tokens.push({ kind: "name", value: name });
        index += name.length;
      } else {
        const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest)?.[0];
        if (number) {
          tokens.push({ kind: "number", value: number });
          index += number.length;
        } else {
          const first = rest[0];
          const punct = rest.startsWith("...") ? "..." : first && "!$():=@[]{}|&".includes(first) ? first : undefined;
          if (!punct) return undefined;
          tokens.push({ kind: "punct", value: punct });
          index += punct.length;
        }
      }
    }
    if (tokens.length > 8192) return undefined;
  }
  return tokens;
}

function pastBalanced(tokens: Token[], start: number, open: string, close: string): number | undefined {
  if (tokens[start]?.kind !== "punct" || tokens[start]?.value !== open) return undefined;
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i]?.kind !== "punct") continue;
    if (tokens[i]?.value === open) depth++;
    if (tokens[i]?.value === close && --depth === 0) return i + 1;
  }
  return undefined;
}

function argument(tokens: Token[], index: number, variables: Record<string, unknown>): [string, number] | undefined {
  const token = tokens[index];
  if (token?.kind === "string") return [token.value, index + 1];
  if (token?.value !== "$" || tokens[index + 1]?.kind !== "name") return undefined;
  const value = variables[tokens[index + 1]!.value];
  return typeof value === "string" ? [value, index + 2] : undefined;
}

// The fields needed by ordinary `gh pr view` and `gh issue view` from a
// repository root. An unknown edge is refused even if GitHub would permit it.
const BOUND_FIELDS = new Set([
  "__typename",
  "additions",
  "assignees",
  "author",
  "authorAssociation",
  "authorEmail",
  "autoMergeRequest",
  "baseRefName",
  "blockedBy",
  "blocking",
  "body",
  "checkSuite",
  "color",
  "comments",
  "commit",
  "commitBody",
  "commitHeadline",
  "commits",
  "completed",
  "completedAt",
  "conclusion",
  "content",
  "context",
  "contexts",
  "createdAt",
  "databaseId",
  "deletions",
  "description",
  "detailsUrl",
  "dueOn",
  "enabledAt",
  "enabledBy",
  "endCursor",
  "hasIssuesEnabled",
  "hasNextPage",
  "headRefName",
  "headRepository",
  "headRepositoryOwner",
  "id",
  "includesCreatedEdit",
  "isCrossRepository",
  "isDraft",
  "isMinimized",
  "issueOrPullRequest",
  "issueType",
  "labels",
  "login",
  "maintainerCanModify",
  "mergeMethod",
  "mergeable",
  "milestone",
  "minimizedReason",
  "name",
  "nameWithOwner",
  "nodes",
  "number",
  "oid",
  "organization",
  "owner",
  "pageInfo",
  "parent",
  "percentCompleted",
  "pullRequest",
  "reactionGroups",
  "repository",
  "requestedReviewer",
  "resourcePath",
  "reviewRequests",
  "reviews",
  "slug",
  "startedAt",
  "state",
  "stateReason",
  "status",
  "statusCheckRollup",
  "subIssues",
  "subIssuesSummary",
  "submittedAt",
  "targetUrl",
  "title",
  "total",
  "totalCount",
  "url",
  "users",
  "viewerDidAuthor",
  "workflow",
  "workflowRun",
]);
const GLOBAL_LOOKUPS = new Set(["repository", "repositoryOwner", "organization", "enterprise", "user"]);
const FOREIGN_OBJECTS = new Set([
  "repository",
  "headRepository",
  "headRepositoryOwner",
  "baseRepository",
  "parent",
  "templateRepository",
  "headRef",
  "baseRef",
  "owner",
  "organization",
  "author",
  "actor",
  "commit",
  "enabledBy",
  "requestedReviewer",
  "subIssues",
  "blockedBy",
  "blocking",
]);
const METADATA_FIELDS = new Set([
  "__typename",
  "id",
  "login",
  "name",
  "nameWithOwner",
  "slug",
  "url",
  "resourcePath",
  "avatarUrl",
  "isPrivate",
  "isFork",
  "isArchived",
  "owner",
  "organization",
  "target",
  "oid",
  "abbreviatedOid",
  "prefix",
  "defaultBranchRef",
  "number",
  "title",
  "state",
  "repository",
  "nodes",
  "totalCount",
  "statusCheckRollup",
  "contexts",
  "pageInfo",
  "hasNextPage",
  "endCursor",
  "checkSuite",
  "workflowRun",
  "workflow",
  "status",
  "conclusion",
  "startedAt",
  "completedAt",
  "detailsUrl",
  "context",
  "targetUrl",
  "createdAt",
  "description",
]);
const METADATA_TYPES = new Set([
  "User",
  "Organization",
  "Team",
  "Bot",
  "Mannequin",
  "Repository",
  "Commit",
  "CheckRun",
  "StatusContext",
]);

function metadataOnly(tokens: Token[], start: number): boolean {
  const end = pastBalanced(tokens, start, "{", "}");
  if (end === undefined) return false;
  for (let i = start + 1; i < end - 1; i++) {
    const token = tokens[i];
    if (token?.value === "(") return false;
    if (token?.value === "..." && tokens[i + 1]?.value !== "on") return false;
    if (token?.kind !== "name") continue;
    if (tokens[i + 1]?.value === ":") continue; // alias; check its field next
    if (METADATA_FIELDS.has(token.value)) continue;
    if (tokens[i - 1]?.value === "on" && METADATA_TYPES.has(token.value)) continue;
    if (token.value === "on" && tokens[i - 1]?.value === "...") continue;
    return false;
  }
  return true;
}

function scopedSelection(tokens: Token[], start: number): number | undefined {
  const end = pastBalanced(tokens, start, "{", "}");
  if (end === undefined) return undefined;
  for (let i = start + 1; i < end - 1; i++) {
    if (tokens[i]?.value === "(") {
      const after = pastBalanced(tokens, i, "(", ")");
      if (after === undefined) return undefined;
      i = after - 1;
      continue;
    }
    if (tokens[i]?.kind !== "name") continue;
    if (tokens[i + 1]?.value === ":") continue; // alias; check its field next
    if (tokens[i - 1]?.value === "..." || tokens[i]?.value === "on" || tokens[i - 1]?.value === "on") continue; // fragment spread or inline type; its selection is checked below
    if (!BOUND_FIELDS.has(tokens[i]!.value)) return undefined;
    // `PullRequest.repository` and `Team.organization` describe objects
    // reached from the bound repo. Lookup fields with arguments can select
    // unrelated objects, including `RepositoryOwner.repository(name:)`.
    if (GLOBAL_LOOKUPS.has(tokens[i]!.value) && tokens[i + 1]?.value === "(") return undefined;
    // A bound PR or issue can point at a foreign object. Its identifying
    // metadata is useful to `gh`; its content remains outside this run.
    if (FOREIGN_OBJECTS.has(tokens[i]!.value)) {
      let child = i + 1;
      if (tokens[child]?.value === "(") {
        const after = pastBalanced(tokens, child, "(", ")");
        if (after === undefined) return undefined;
        child = after;
      }
      if (!metadataOnly(tokens, child)) return undefined;
    }
  }
  return end;
}

/** One read query rooted in `repository(owner, name)`. Fragments may describe
 * fields below that root, but Query fragments and global traversal fields are
 * refused. GitHub still validates the GraphQL grammar after this scope check. */
export function scopedGraphqlRead(body: Buffer, boundRepo: string): boolean {
  let request: unknown;
  try {
    request = JSON.parse(body.toString("utf8"));
  } catch {
    return false;
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) return false;
  const { query, variables } = request as { query?: unknown; variables?: unknown };
  if (typeof query !== "string") return false;
  if (variables !== undefined && (variables === null || typeof variables !== "object" || Array.isArray(variables)))
    return false;
  const values = (variables ?? {}) as Record<string, unknown>;
  const tokens = tokensOf(query);
  if (!tokens?.length) return false;
  let i = 0;
  if (tokens[i]?.value === "query") {
    i++;
    if (tokens[i]?.kind === "name") i++;
    if (tokens[i]?.value === "(") {
      const after = pastBalanced(tokens, i, "(", ")");
      if (after === undefined) return false;
      i = after;
    }
  }
  if (tokens[i++]?.value !== "{") return false;
  if (tokens[i]?.kind !== "name") return false;
  if (tokens[i + 1]?.value === ":") i += 2; // a root alias cannot change the operation
  if (tokens[i++]?.value !== "repository" || tokens[i++]?.value !== "(") return false;
  const args = new Map<string, string>();
  while (tokens[i]?.value !== ")") {
    const key = tokens[i++];
    if (key?.kind !== "name" || tokens[i++]?.value !== ":" || args.has(key.value)) return false;
    const parsed = argument(tokens, i, values);
    if (!parsed) return false;
    args.set(key.value, parsed[0]);
    i = parsed[1];
    if (i >= tokens.length) return false;
  }
  i++;
  const [owner, name] = boundRepo.split("/");
  if (
    args.size !== 2 ||
    args.get("owner")?.toLowerCase() !== owner?.toLowerCase() ||
    args.get("name")?.toLowerCase() !== name?.toLowerCase()
  )
    return false;
  const afterRoot = scopedSelection(tokens, i);
  if (afterRoot === undefined || tokens[afterRoot]?.value !== "}") return false;
  i = afterRoot + 1;
  while (i < tokens.length) {
    if (tokens[i++]?.value !== "fragment" || tokens[i++]?.kind !== "name" || tokens[i++]?.value !== "on") return false;
    const type = tokens[i++];
    if (type?.kind !== "name" || type.value === "Query") return false;
    const afterFragment = scopedSelection(tokens, i);
    if (afterFragment === undefined) return false;
    i = afterFragment;
  }
  return true;
}
