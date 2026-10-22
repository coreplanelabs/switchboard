import { normalizeGithubInstallationActivity } from "./githubInstallationActivity.js";
import {
  prepareSourceEvent,
  sourceEventRecordOf,
  sourceSnapshot,
  type SourceEvent,
} from "../core/runLedger/sourceEvents.js";
import { sourceHash } from "../core/references/receipts.js";
import { githubPullSourceContextOf } from "../execution/githubReadSource.js";

/** Configuration already selected by the authenticated receiver. */
export interface GithubActivitySource {
  host: string;
  appId: number;
  installationId: number;
  /** Required for repository activity; installation facts have no repository. */
  repositoryId?: number;
}

export type GithubActivityResult =
  | { kind: "normalized"; event: SourceEvent }
  | { kind: "ignored"; reason: "event" | "action" | "not-pull-request" }
  | { kind: "refused"; reason: "invalid-source" | "source-mismatch" | "invalid-payload" | "invalid-event" };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const optionalId = (value: unknown) => (value === undefined || value === null ? null : id(value) ? value : undefined);
const optionalText = (value: unknown) =>
  value === undefined || value === null ? null : text(value) ? value : undefined;
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
function authorOf(value: unknown) {
  if (value === null) return null;
  if (!object(value) || !id(value.id) || !text(value.login) || !text(value.type)) return undefined;
  return { id: value.id, login: value.login, type: value.type };
}
function branchOf(value: unknown) {
  if (!object(value) || !sha(value.sha) || !text(value.ref)) return undefined;
  if (value.repo !== null && (!object(value.repo) || !id(value.repo.id))) return undefined;
  return { repositoryId: value.repo === null ? null : value.repo.id, ref: value.ref, sha: value.sha };
}

function sourceHost(host: string): boolean {
  try {
    const url = new URL(`https://${host}`);
    return url.host === host && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function sourceUrl(value: unknown, host: string): value is string {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.host === host && !url.username && !url.password;
  } catch {
    return false;
  }
}

export type GithubActivityTaskMatch =
  | { kind: "candidate"; relation: "pull-request" | "ref" | "head-commit" | "repository" | "installation" }
  | { kind: "unrelated" }
  | { kind: "held"; reason: "invalid-record" | "invalid-task" | "unsupported-relationship" | "identity-conflict" };

/** Match data from this adapter only. The caller must load canonical records
 * and check the original owner, audience, current access and relevance. This
 * neither authenticates a supplied receipt nor selects a delivery target. */
export async function githubActivityTaskMatch(value: unknown, taskValue: unknown): Promise<GithubActivityTaskMatch> {
  const held = (reason: Extract<GithubActivityTaskMatch, { kind: "held" }>["reason"]): GithubActivityTaskMatch => ({
    kind: "held",
    reason,
  });
  let captured: unknown;
  try {
    captured = sourceSnapshot({ record: value, task: taskValue ?? null });
  } catch {
    return held("invalid-record");
  }
  if (!object(captured)) return held("invalid-record");
  const task = githubPullSourceContextOf(captured.task);
  if (!task) return held("invalid-task");
  const record = await sourceEventRecordOf(captured.record);
  if (!record) return held("invalid-record");
  const event = record.event;
  if (event.version !== 2 || event.kind === "request") return held("unsupported-relationship");
  const { host, appId, installationId } = task.source;
  if (event.sourceId !== `github:${host}:app:${appId}:installation:${installationId}`) return { kind: "unrelated" };
  const data = event.payload;
  const facts = event.content.kind === "facts" && object(event.content.facts) ? event.content.facts : undefined;
  // A generic source receipt proves its saved bytes, not that those bytes
  // still agree with the adapter's retained native snapshot.
  const nativeFactMatches = async (nativeEvent: string): Promise<boolean> => {
    const normalized = await normalizeGithubActivity(
      { ...task.source, repositoryId: task.repositoryId },
      { event: nativeEvent, delivery: event.deliveryId },
      object(data) ? data.native : undefined,
    );
    return normalized.kind === "normalized" && (await sourceHash(normalized.event)) === (await sourceHash(event));
  };
  if (facts?.surface === "installation-access") {
    if (
      (facts.event !== "installation" && facts.event !== "installation_repositories") ||
      !(await nativeFactMatches(facts.event))
    )
      return held("identity-conflict");
    // Selection changes can affect the stored installation even when a
    // supplied delta omits this repository. They prove no current access.
    return { kind: "candidate", relation: "installation" };
  }
  const prefix = `github:${host}:repository:`;
  if (!event.objectId.startsWith(prefix)) return held("unsupported-relationship");
  const [repository, surface, ...parts] = event.objectId.slice(prefix.length).split(":");
  const repositoryId = Number(repository);
  if (!id(repositoryId) || String(repositoryId) !== repository) return held("invalid-record");
  if (repositoryId !== task.repositoryId) return { kind: "unrelated" };
  const nativeEvent =
    surface === "ref"
      ? facts?.action
      : surface === undefined || surface === "repository"
        ? "repository"
        : ["check_run", "check_suite", "status"].includes(surface)
          ? surface
          : undefined;
  if (nativeEvent !== undefined) {
    if (!facts || typeof nativeEvent !== "string" || !(await nativeFactMatches(nativeEvent)))
      return held("identity-conflict");
    if (nativeEvent === "repository") return { kind: "candidate", relation: "repository" };
    if (nativeEvent === "push" || nativeEvent === "delete") {
      const ref = facts.ref;
      return ref === `refs/heads/${task.baseRef}` ||
        (task.head.repositoryId === repositoryId && ref === `refs/heads/${task.head.ref}`)
        ? { kind: "candidate", relation: "ref" }
        : held("unsupported-relationship");
    }
    if (nativeEvent === "check_run" || nativeEvent === "check_suite" || nativeEvent === "status") {
      if (
        Array.isArray(facts.pullRequests) &&
        facts.pullRequests.some(
          (pull) => object(pull) && (pull.id === task.pullRequestId) !== (pull.number === task.number),
        )
      )
        return held("identity-conflict");
      // Associations do not establish the checked commit or a fork's source
      // membership. Only the saved repository and exact selected SHA do.
      return task.head.repositoryId === repositoryId && facts.commitSha === task.head.sha
        ? { kind: "candidate", relation: "head-commit" }
        : held("unsupported-relationship");
    }
    return held("unsupported-relationship");
  }
  if (!["conversation", "inline", "review", "pull-request", "thread"].includes(surface ?? ""))
    return held("unsupported-relationship");
  if (!object(data) || data.version !== 1 || !object(data.repository) || !object(data.native) || !id(data.pullNumber))
    return held("invalid-record");
  const native = data.native;
  const pull = surface === "conversation" ? native.issue : native.pull_request;
  if (
    data.repository.id !== repositoryId ||
    !object(native.repository) ||
    native.repository.id !== repositoryId ||
    !object(native.installation) ||
    native.installation.id !== installationId ||
    !object(pull) ||
    pull.number !== data.pullNumber ||
    (surface === "conversation" && !object(pull.pull_request))
  )
    return held("identity-conflict");
  if (
    surface !== "conversation" &&
    pull.id !== undefined &&
    (!id(pull.id) || (pull.id === task.pullRequestId) !== (data.pullNumber === task.number))
  )
    return held("identity-conflict");
  if (data.pullNumber !== task.number) return { kind: "unrelated" };
  const item =
    surface === "pull-request"
      ? pull
      : surface === "thread"
        ? native.thread
        : surface === "review"
          ? native.review
          : native.comment;
  if (!object(item)) return held("identity-conflict");
  const nativeId = surface === "thread" ? item.node_id : item.id;
  if ((surface === "thread" ? !text(nativeId) : !id(nativeId)) || parts.join(":") !== String(nativeId))
    return held("identity-conflict");
  return { kind: "candidate", relation: "pull-request" };
}

/** Pure conversion after signature and configured-source checks. This does
 * not authenticate, select a task, write an inbox or acknowledge a delivery. */
export async function normalizeGithubActivity(
  source: GithubActivitySource,
  headers: { event?: string; delivery?: string },
  payload: unknown,
): Promise<GithubActivityResult> {
  const { host, appId, installationId, repositoryId } = source;
  const { event, delivery } = headers;
  if (event === "installation" || event === "installation_repositories")
    return normalizeGithubInstallationActivity({ host, appId, installationId }, { event, delivery }, payload);
  const refused = (reason: Extract<GithubActivityResult, { kind: "refused" }>["reason"]): GithubActivityResult => ({
    kind: "refused",
    reason,
  });
  if (!sourceHost(host) || !id(appId) || !id(installationId) || !id(repositoryId)) return refused("invalid-source");
  if (
    ![
      "repository",
      "issue_comment",
      "pull_request_review_comment",
      "pull_request_review",
      "commit_comment",
      "pull_request",
      "pull_request_review_thread",
      "check_run",
      "check_suite",
      "status",
      "push",
      "delete",
    ].includes(event ?? "")
  )
    return { kind: "ignored", reason: "event" };
  if (!text(delivery) || !object(payload)) return refused("invalid-payload");
  try {
    payload = sourceSnapshot(payload);
  } catch {
    return refused("invalid-event");
  }
  if (!object(payload)) return refused("invalid-payload");
  const actions =
    event === "check_run"
      ? ["created", "completed", "rerequested", "requested_action"]
      : event === "check_suite"
        ? ["requested", "completed", "rerequested"]
        : event === "pull_request"
          ? ["opened", "edited", "reopened", "closed", "synchronize", "converted_to_draft", "ready_for_review"]
          : event === "pull_request_review_thread"
            ? ["resolved", "unresolved"]
            : event === "commit_comment"
              ? ["created"]
              : event === "pull_request_review"
                ? ["submitted", "edited", "dismissed"]
                : ["created", "edited", "deleted"];
  // Status and ref events have no action field in GitHub's webhook contract.
  if (event !== "status" && event !== "push" && event !== "delete") {
    if (typeof payload.action !== "string") return refused("invalid-payload");
    const allowedActions =
      event === "repository"
        ? [
            "created",
            "deleted",
            "edited",
            "renamed",
            "transferred",
            "archived",
            "unarchived",
            "privatized",
            "publicized",
          ]
        : actions;
    if (!allowedActions.includes(payload.action)) return { kind: "ignored", reason: "action" };
  }
  if (!object(payload.installation) || !object(payload.repository)) return refused("invalid-payload");
  if (payload.installation.id !== installationId || payload.repository.id !== repositoryId)
    return refused("source-mismatch");
  const fullName = payload.repository.full_name;
  if (typeof fullName !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(fullName)) return refused("invalid-payload");
  const native = payload;
  const finish = async (
    surface: string,
    objectId: number | string,
    kind: SourceEvent["kind"],
    author: ReturnType<typeof authorOf>,
    activity: Record<string, unknown>,
    revision: unknown,
    pullNumber?: number,
  ): Promise<GithubActivityResult> => {
    try {
      const { body, state, ...metadata } = activity;
      const prepared = await prepareSourceEvent({
        version: 2,
        sourceId: `github:${host}:app:${appId}:installation:${installationId}`,
        deliveryId: delivery,
        objectId:
          surface === "repository"
            ? `github:${host}:repository:${repositoryId}`
            : `github:${host}:repository:${repositoryId}:${surface}:${objectId}`,
        changeId: await sourceHash(revision),
        kind,
        content:
          kind === "source-fact"
            ? { kind: "facts", facts: activity }
            : {
                kind: "text",
                state: state === "dismissed" ? "withdrawn" : state,
                text: body,
                metadata,
              },
        ...(author ? { authorId: `github:${host}:user:${author.id}` } : {}),
        payload: {
          version: 1,
          repository: { id: repositoryId, fullName },
          ...(pullNumber !== undefined ? { pullNumber } : {}),
          native,
        },
      });
      return prepared ? { kind: "normalized", event: prepared.event } : refused("invalid-event");
    } catch {
      return refused("invalid-event");
    }
  };
  if (event === "push" || event === "delete") {
    const actor = authorOf(payload.sender ?? null);
    if (actor === undefined || !text(payload.ref)) return refused("invalid-payload");
    if (event === "delete" && payload.ref_type !== "branch" && payload.ref_type !== "tag")
      return refused("invalid-payload");
    const ref =
      event === "push" ? payload.ref : `refs/${payload.ref_type === "branch" ? "heads" : "tags"}/${payload.ref}`;
    const match = /^refs\/(heads|tags)\/(.+)$/.exec(ref);
    if (!match || Array.from(ref).some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127))
      return refused("invalid-payload");
    if (
      event === "push" &&
      (!sha(payload.before) ||
        !sha(payload.after) ||
        typeof payload.created !== "boolean" ||
        typeof payload.deleted !== "boolean" ||
        typeof payload.forced !== "boolean" ||
        (payload.created && payload.deleted) ||
        (payload.before === "0".repeat(40)) !== payload.created ||
        (payload.after === "0".repeat(40)) !== payload.deleted ||
        optionalText(payload.base_ref) === undefined)
    )
      return refused("invalid-payload");
    return finish(
      "ref",
      ref,
      "source-fact",
      actor,
      {
        surface: "ref",
        action: event,
        ref,
        refType: match[1] === "heads" ? "branch" : "tag",
        before: event === "push" ? payload.before : null,
        after: event === "push" ? payload.after : null,
        created: event === "push" ? payload.created : null,
        deleted: event === "push" ? payload.deleted : true,
        forced: event === "push" ? payload.forced : null,
        baseRef: event === "push" ? (payload.base_ref ?? null) : null,
        actor,
      },
      { surface: "ref", event, native },
    );
  }
  if (event === "check_run" || event === "check_suite" || event === "status") {
    const actor = authorOf(payload.sender ?? null);
    if (actor === undefined) return refused("invalid-payload");
    if (event === "status") {
      if (
        !id(payload.id) ||
        !sha(payload.sha) ||
        !text(payload.context) ||
        !["pending", "success", "failure", "error"].some((state) => state === payload.state) ||
        (payload.description !== null && typeof payload.description !== "string") ||
        (payload.target_url !== undefined && payload.target_url !== null && typeof payload.target_url !== "string")
      )
        return refused("invalid-payload");
      return finish(
        "status",
        payload.id,
        "source-fact",
        actor,
        {
          surface: "status",
          id: payload.id,
          commitSha: payload.sha,
          context: payload.context,
          state: payload.state,
          description: payload.description,
          targetUrl: payload.target_url ?? null,
          actor,
        },
        payload,
      );
    }
    const check = payload[event];
    if (
      !object(check) ||
      !id(check.id) ||
      !sha(check.head_sha) ||
      (check.status !== null && !text(check.status)) ||
      (check.conclusion !== null && !text(check.conclusion)) ||
      !object(check.app) ||
      !id(check.app.id) ||
      !Array.isArray(check.pull_requests) ||
      (event === "check_run" && (!text(check.name) || !text(check.status))) ||
      (event === "check_suite" && optionalText(check.head_branch) === undefined)
    )
      return refused("invalid-payload");
    const pullRequests: Record<string, unknown>[] = [];
    for (const pull of check.pull_requests) {
      if (!object(pull) || !id(pull.id) || !id(pull.number)) return refused("invalid-payload");
      const head = branchOf(pull.head),
        base = branchOf(pull.base);
      if (!head || !base) return refused("invalid-payload");
      pullRequests.push({ id: pull.id, number: pull.number, head, base });
    }
    // Associations can be empty for forks or name a PR's later head. They
    // are source facts, never a selected PR or current-head assertion.
    return finish(
      event,
      check.id,
      "source-fact",
      actor,
      {
        surface: event,
        id: check.id,
        action: payload.action,
        commitSha: check.head_sha,
        status: check.status,
        conclusion: check.conclusion,
        appId: check.app.id,
        ...(event === "check_run" ? { name: check.name } : { headBranch: check.head_branch ?? null }),
        pullRequests,
        actor,
      },
      { action: payload.action, check, requestedAction: payload.requested_action ?? null },
    );
  }
  if (event === "repository") {
    const repository = native.repository;
    const actor = authorOf(native.sender ?? null);
    if (
      !object(repository) ||
      actor === undefined ||
      typeof repository.private !== "boolean" ||
      typeof repository.archived !== "boolean" ||
      (repository.visibility !== undefined &&
        repository.visibility !== null &&
        typeof repository.visibility !== "string") ||
      (repository.default_branch !== undefined &&
        repository.default_branch !== null &&
        typeof repository.default_branch !== "string") ||
      (payload.action === "archived" && !repository.archived) ||
      (payload.action === "unarchived" && repository.archived) ||
      (payload.action === "privatized" && !repository.private) ||
      (payload.action === "publicized" && repository.private)
    )
      return refused("invalid-payload");
    return finish(
      "repository",
      repositoryId,
      "source-fact",
      actor,
      {
        surface: "repository",
        id: repositoryId,
        action: payload.action,
        private: repository.private,
        archived: repository.archived,
        visibility: repository.visibility ?? null,
        defaultBranch: repository.default_branch ?? null,
        changes: payload.changes ?? null,
        actor,
      },
      { surface: "repository", action: payload.action, repository, changes: payload.changes ?? null },
    );
  }
  const pull = event === "issue_comment" ? payload.issue : payload.pull_request;
  if (event !== "commit_comment" && (!object(pull) || !id(pull.number))) return refused("invalid-payload");
  const pullNumber = object(pull) && id(pull.number) ? pull.number : undefined;
  if (event === "pull_request" || event === "pull_request_review_thread") {
    if (!object(pull) || !sourceUrl(pull.html_url, host)) return refused("invalid-payload");
    const actor = authorOf(payload.sender ?? null);
    if (actor === undefined) return refused("invalid-payload");
    if (event === "pull_request_review_thread") {
      const thread = payload.thread;
      if (!object(thread) || !text(thread.node_id) || !Array.isArray(thread.comments))
        return refused("invalid-payload");
      return finish(
        "thread",
        thread.node_id,
        "source-fact",
        actor,
        { surface: "thread", nodeId: thread.node_id, state: payload.action, url: pull.html_url, actor },
        { surface: "thread", state: payload.action, thread },
        pullNumber,
      );
    }
    const head = branchOf(pull.head),
      base = branchOf(pull.base);
    if (
      !id(pull.id) ||
      payload.number !== pull.number ||
      !text(pull.title) ||
      (pull.body !== null && typeof pull.body !== "string") ||
      (pull.state !== "open" && pull.state !== "closed") ||
      typeof pull.draft !== "boolean" ||
      !head ||
      !base ||
      (pull.merged !== undefined && pull.merged !== null && typeof pull.merged !== "boolean")
    )
      return refused("invalid-payload");
    if (payload.action === "synchronize" && (!sha(payload.before) || !sha(payload.after) || payload.after !== head.sha))
      return refused("invalid-payload");
    return finish(
      "pull-request",
      pull.id,
      "source-fact",
      actor,
      {
        surface: "pull-request",
        id: pull.id,
        action: payload.action,
        state: pull.state,
        url: pull.html_url,
        title: pull.title,
        body: pull.body,
        draft: pull.draft,
        merged: pull.merged ?? null,
        head,
        base,
        before: payload.before ?? null,
        after: payload.after ?? null,
        actor,
      },
      {
        surface: "pull-request",
        action: payload.action,
        pull,
        changes: payload.changes ?? null,
        before: payload.before ?? null,
        after: payload.after ?? null,
      },
      pullNumber,
    );
  }
  if (event === "issue_comment") {
    if (!object(pull)) return refused("invalid-payload");
    if (!Object.hasOwn(pull, "pull_request")) return { kind: "ignored", reason: "not-pull-request" };
    if (!object(pull.pull_request)) return refused("invalid-payload");
  }
  const item = event === "pull_request_review" ? payload.review : payload.comment;
  if (
    !object(item) ||
    !id(item.id) ||
    (item.body !== null && typeof item.body !== "string") ||
    !sourceUrl(item.html_url, host)
  )
    return refused("invalid-payload");
  const author = authorOf(item.user);
  if (author === undefined || (event === "commit_comment" && !sha(item.commit_id))) return refused("invalid-payload");
  const createdAt = optionalText(event === "pull_request_review" ? item.submitted_at : item.created_at);
  const updatedAt = optionalText(item.updated_at);
  const reviewId = optionalId(item.pull_request_review_id);
  const replyToId = optionalId(item.in_reply_to_id);
  if ([createdAt, updatedAt, reviewId, replyToId].some((value) => value === undefined))
    return refused("invalid-payload");
  const surface =
    event === "issue_comment"
      ? "conversation"
      : event === "pull_request_review_comment"
        ? "inline"
        : event === "commit_comment"
          ? "commit"
          : "review";
  const state = payload.action === "deleted" ? "deleted" : payload.action === "dismissed" ? "dismissed" : "present";
  // Hash the native object, not the delivery or a timestamp alone. Same-time
  // edits and changed diff metadata remain distinct source revisions.
  return finish(
    surface,
    item.id,
    "source-evidence",
    author,
    {
      surface,
      id: item.id,
      state,
      body: item.body,
      url: item.html_url,
      author,
      createdAt,
      updatedAt,
      reviewId,
      replyToId,
      ...(event === "commit_comment" ? { commitSha: item.commit_id } : {}),
      ...(event === "pull_request_review"
        ? { reviewState: item.state ?? null, commitSha: item.commit_id ?? null }
        : {}),
      ...(event === "pull_request_review_comment" || event === "commit_comment"
        ? {
            location: {
              path: item.path ?? null,
              commitSha: item.commit_id ?? null,
              originalCommitSha: item.original_commit_id ?? null,
              line: item.line ?? null,
              originalLine: item.original_line ?? null,
              startLine: item.start_line ?? null,
              originalStartLine: item.original_start_line ?? null,
              side: item.side ?? null,
              startSide: item.start_side ?? null,
              position: item.position ?? null,
              subjectType: item.subject_type ?? null,
            },
          }
        : {}),
    },
    { surface, state, item },
    pullNumber,
  );
}
