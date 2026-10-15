import { prepareSourceEvent, sourceSnapshot, type SourceEvent } from "../core/runLedger/sourceEvents.js";
import { sourceHash } from "../core/references/receipts.js";

/** Configuration already selected by the authenticated receiver. */
export interface GithubActivitySource {
  host: string;
  appId: number;
  installationId: number;
  repositoryId: number;
}

export type GithubCommentResult =
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
export async function normalizeGithubComment(
  source: GithubActivitySource,
  headers: { event?: string; delivery?: string },
  payload: unknown,
): Promise<GithubCommentResult> {
  const { host, appId, installationId, repositoryId } = source;
  const { event, delivery } = headers;
  const refused = (reason: Extract<GithubCommentResult, { kind: "refused" }>["reason"]): GithubCommentResult => ({
    kind: "refused",
    reason,
  });
  if (!sourceHost(host) || !id(appId) || !id(installationId) || !id(repositoryId)) return refused("invalid-source");
  if (event !== "issue_comment" && event !== "pull_request_review_comment" && event !== "pull_request_review")
    return { kind: "ignored", reason: "event" };
  if (!text(delivery) || !object(payload)) return refused("invalid-payload");
  try {
    payload = sourceSnapshot(payload);
  } catch {
    return refused("invalid-event");
  }
  if (!object(payload)) return refused("invalid-payload");
  const actions =
    event === "pull_request_review" ? ["submitted", "edited", "dismissed"] : ["created", "edited", "deleted"];
  if (typeof payload.action !== "string") return refused("invalid-payload");
  if (!actions.includes(payload.action)) return { kind: "ignored", reason: "action" };
  if (!object(payload.installation) || !object(payload.repository)) return refused("invalid-payload");
  if (payload.installation.id !== installationId || payload.repository.id !== repositoryId)
    return refused("source-mismatch");
  const fullName = payload.repository.full_name;
  if (typeof fullName !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(fullName)) return refused("invalid-payload");
  const pull = event === "issue_comment" ? payload.issue : payload.pull_request;
  if (!object(pull) || !id(pull.number)) return refused("invalid-payload");
  if (event === "issue_comment") {
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
  const nativeAuthor = item.user;
  if (
    nativeAuthor !== null &&
    (!object(nativeAuthor) || !id(nativeAuthor.id) || !text(nativeAuthor.login) || !text(nativeAuthor.type))
  )
    return refused("invalid-payload");
  const author =
    nativeAuthor === null ? null : { id: nativeAuthor.id, login: nativeAuthor.login, type: nativeAuthor.type };
  const createdAt = optionalText(event === "pull_request_review" ? item.submitted_at : item.created_at);
  const updatedAt = optionalText(item.updated_at);
  const reviewId = optionalId(item.pull_request_review_id);
  const replyToId = optionalId(item.in_reply_to_id);
  if ([createdAt, updatedAt, reviewId, replyToId].some((value) => value === undefined))
    return refused("invalid-payload");
  const surface =
    event === "issue_comment" ? "conversation" : event === "pull_request_review_comment" ? "inline" : "review";
  const state = payload.action === "deleted" ? "deleted" : payload.action === "dismissed" ? "dismissed" : "present";
  // Hash the native object, not the delivery or a timestamp alone. Same-time
  // edits and changed diff metadata remain distinct source revisions.
  let changeId: string;
  try {
    changeId = await sourceHash({ surface, state, item });
  } catch {
    return refused("invalid-event");
  }
  const prepared = await prepareSourceEvent({
    version: 1,
    sourceId: `github:${host}:app:${appId}:installation:${installationId}`,
    deliveryId: delivery,
    objectId: `github:${host}:repository:${repositoryId}:${surface}:${item.id}`,
    changeId,
    kind: "source-evidence",
    ...(author ? { authorId: `github:${host}:user:${author.id}` } : {}),
    payload: {
      version: 1,
      repository: { id: repositoryId, fullName },
      pullNumber: pull.number,
      activity: {
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
      },
      native: payload,
    },
  });
  return prepared ? { kind: "normalized", event: prepared.event } : refused("invalid-event");
}
