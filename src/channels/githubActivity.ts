import { prepareSourceEvent, sourceSnapshot, type SourceEvent } from "../core/runLedger/sourceEvents.js";
import { sourceHash } from "../core/references/receipts.js";

/** Configuration already selected by the authenticated receiver. */
export interface GithubActivitySource {
  host: string;
  appId: number;
  installationId: number;
  repositoryId: number;
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

/** Pure conversion after signature and configured-source checks. This does
 * not authenticate, select a task, write an inbox or acknowledge a delivery. */
export async function normalizeGithubActivity(
  source: GithubActivitySource,
  headers: { event?: string; delivery?: string },
  payload: unknown,
): Promise<GithubActivityResult> {
  const { host, appId, installationId, repositoryId } = source;
  const { event, delivery } = headers;
  const refused = (reason: Extract<GithubActivityResult, { kind: "refused" }>["reason"]): GithubActivityResult => ({
    kind: "refused",
    reason,
  });
  if (!sourceHost(host) || !id(appId) || !id(installationId) || !id(repositoryId)) return refused("invalid-source");
  if (
    ![
      "issue_comment",
      "pull_request_review_comment",
      "pull_request_review",
      "commit_comment",
      "pull_request",
      "pull_request_review_thread",
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
    event === "pull_request"
      ? ["opened", "edited", "reopened", "closed", "synchronize", "converted_to_draft", "ready_for_review"]
      : event === "pull_request_review_thread"
        ? ["resolved", "unresolved"]
        : event === "commit_comment"
          ? ["created"]
          : event === "pull_request_review"
            ? ["submitted", "edited", "dismissed"]
            : ["created", "edited", "deleted"];
  if (typeof payload.action !== "string") return refused("invalid-payload");
  if (!actions.includes(payload.action)) return { kind: "ignored", reason: "action" };
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
      const prepared = await prepareSourceEvent({
        version: 1,
        sourceId: `github:${host}:app:${appId}:installation:${installationId}`,
        deliveryId: delivery,
        objectId: `github:${host}:repository:${repositoryId}:${surface}:${objectId}`,
        changeId: await sourceHash(revision),
        kind,
        ...(author ? { authorId: `github:${host}:user:${author.id}` } : {}),
        payload: {
          version: 1,
          repository: { id: repositoryId, fullName },
          ...(pullNumber !== undefined ? { pullNumber } : {}),
          activity,
          native,
        },
      });
      return prepared ? { kind: "normalized", event: prepared.event } : refused("invalid-event");
    } catch {
      return refused("invalid-event");
    }
  };
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
    },
    { surface, state, item },
    pullNumber,
  );
}
