import { resolveGithubToken } from "./githubApp.js";
import { sourceHash } from "../core/references/receipts.js";
import {
  REVIEW_FEEDBACK_REQUEST_MS,
  REVIEW_FEEDBACK_HOURLY_MS,
  REVIEW_FEEDBACK_READ_MS,
  SECOND_MS,
} from "../core/budgets.js";
import { systemClock } from "../core/trace/clock.js";
import {
  ReviewFeedbackReadError,
  type ReviewFeedbackPublication,
  type ReviewFeedbackSource,
  type ReviewFeedbackVote,
} from "../core/reviewFeedback.js";

const QUERY = `query ReviewFeedback($id: ID!, $after: String) {
  node(id: $id) { ... on PullRequestReview {
    id fullDatabaseId body commit { oid } repository { nameWithOwner } pullRequest { number }
    reactions(first: 100, after: $after) {
      totalCount pageInfo { hasNextPage endCursor }
      nodes { id content user { __typename id } }
    }
  } }
}`;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Trusted bot-side GraphQL reader; installation credentials never enter model tools. */
export class GithubReviewFeedbackSource implements ReviewFeedbackSource {
  constructor(
    private readonly opts: {
      fetch?: typeof fetch;
      token?: (signal: AbortSignal) => Promise<string | null>;
      now?: () => number;
    } = {},
  ) {}
  async read(publication: ReviewFeedbackPublication): Promise<ReviewFeedbackVote[]> {
    const now = this.opts.now ?? systemClock;
    const deadline = now() + REVIEW_FEEDBACK_READ_MS;
    const mintAbort = new AbortController();
    const token = await new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        mintAbort.abort();
        reject(new ReviewFeedbackReadError("unavailable"));
      }, REVIEW_FEEDBACK_READ_MS);
      void Promise.resolve()
        .then(() => (this.opts.token ?? ((signal) => resolveGithubToken("read", undefined, signal)))(mintAbort.signal))
        .then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
    });
    if (!token || !publication.review) throw new ReviewFeedbackReadError("unavailable");
    const votes: ReviewFeedbackVote[] = [],
      seen = new Set<string>(),
      cursors = new Set<string>();
    let after: string | null = null,
      expected: number | undefined;
    for (let page = 0; page < 20; page++) {
      const remaining = deadline - now();
      if (remaining <= 0) throw new ReviewFeedbackReadError("unavailable");
      const res = await (this.opts.fetch ?? fetch)("https://api.github.com/graphql", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(REVIEW_FEEDBACK_REQUEST_MS, remaining)),
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "switchboard",
        },
        body: JSON.stringify({ query: QUERY, variables: { id: publication.review.nodeId, after } }),
      });
      const retryAfter = Number(res.headers.get("retry-after")) * SECOND_MS;
      const retryAt = () => {
        const reset = Number(res.headers.get("x-ratelimit-reset")) * SECOND_MS;
        return retryAfter > 0 ? now() + retryAfter : reset > now() ? reset : now() + REVIEW_FEEDBACK_HOURLY_MS;
      };
      if (
        res.status === 429 ||
        (res.status === 403 && (retryAfter > 0 || res.headers.get("x-ratelimit-remaining") === "0"))
      )
        throw new ReviewFeedbackReadError("unavailable", retryAt());
      if (!res.ok) throw new ReviewFeedbackReadError("unavailable");
      const json: unknown = await res.json();
      if (object(json) && Array.isArray(json.errors) && json.errors.some((e) => object(e) && e.type === "RATE_LIMITED"))
        throw new ReviewFeedbackReadError("unavailable", retryAt());
      if (!object(json) || json.errors !== undefined || !object(json.data) || !object(json.data.node))
        throw new ReviewFeedbackReadError("unavailable");
      const node = json.data.node;
      if (
        node.id !== publication.review.nodeId ||
        String(node.fullDatabaseId) !== publication.review.id ||
        !object(node.commit) ||
        node.commit.oid !== publication.head ||
        !object(node.repository) ||
        typeof node.repository.nameWithOwner !== "string" ||
        node.repository.nameWithOwner.toLowerCase() !== publication.repo.toLowerCase() ||
        !object(node.pullRequest) ||
        node.pullRequest.number !== publication.pr ||
        typeof node.body !== "string"
      )
        throw new ReviewFeedbackReadError("unavailable");
      if ((await sourceHash(node.body)) !== publication.bodyHash) throw new ReviewFeedbackReadError("content_changed");
      const connection = node.reactions;
      if (
        !object(connection) ||
        !Number.isSafeInteger(connection.totalCount) ||
        Number(connection.totalCount) < 0 ||
        !Array.isArray(connection.nodes) ||
        !object(connection.pageInfo) ||
        typeof connection.pageInfo.hasNextPage !== "boolean"
      )
        throw new ReviewFeedbackReadError("unavailable");
      if (expected !== undefined && expected !== connection.totalCount)
        throw new ReviewFeedbackReadError("unavailable");
      expected = Number(connection.totalCount);
      if (expected > 2000) throw new ReviewFeedbackReadError("unavailable");
      for (const item of connection.nodes) {
        if (
          !object(item) ||
          typeof item.id !== "string" ||
          !item.id ||
          item.id.length > 256 ||
          seen.has(item.id) ||
          typeof item.content !== "string"
        )
          throw new ReviewFeedbackReadError("unavailable");
        seen.add(item.id);
        if (item.content !== "THUMBS_UP" && item.content !== "THUMBS_DOWN") continue;
        const actor = item.user;
        const known = object(actor) && typeof actor.id === "string" && actor.id.length > 0 && actor.id.length <= 256;
        votes.push({
          id: item.id,
          ...(known ? { actorId: actor.id as string } : {}),
          actorType:
            known && actor.__typename === "User" ? "User" : known && actor.__typename === "Bot" ? "Bot" : "Unknown",
          content: item.content === "THUMBS_UP" ? "up" : "down",
        });
      }
      if (!connection.pageInfo.hasNextPage) {
        if (seen.size !== expected) throw new ReviewFeedbackReadError("unavailable");
        return votes;
      }
      const cursor = connection.pageInfo.endCursor;
      if (typeof cursor !== "string" || !cursor || cursors.has(cursor))
        throw new ReviewFeedbackReadError("unavailable");
      cursors.add(cursor);
      after = cursor;
    }
    throw new ReviewFeedbackReadError("unavailable");
  }
}
