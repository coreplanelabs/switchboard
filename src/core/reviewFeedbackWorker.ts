import { prepareStorageRequest } from "./storeResponse.js";
import { storageTransport } from "./storageTransport.js";
import type { StorageOperationBody } from "./storageRequestContext.js";
import {
  isReviewFeedbackEntry,
  validFeedbackRange,
  type ReviewFeedbackEntry,
  type ReviewFeedbackClaim,
  type ReviewFeedbackSnapshot,
  type ReviewFeedbackStore,
  type ReviewFeedbackWindow,
} from "./reviewFeedback.js";
import { REVIEW_FEEDBACK_REQUEST_MS } from "./budgets.js";
import { RUN_STORE_KEY } from "./runStoreConstants.js";
import type { StateWorkerBlocks, SecretReader } from "./stateWorkerRef.js";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export class WorkerReviewFeedbackStore implements ReviewFeedbackStore {
  constructor(private readonly opts: { baseUrl: string; token: string; storeKey: string; fetch?: typeof fetch }) {}
  private async post<P extends "list" | "claim" | "complete" | "cooldown", T>(
    path: P,
    body: StorageOperationBody<`/runs/review-feedback/${NoInfer<P>}`>,
    receive: (result: Record<string, unknown>) => Promise<T>,
  ): Promise<T> {
    const operation = `/runs/review-feedback/${path}` as const;
    const payload = { storeKey: this.opts.storeKey, ...body };
    const request = await prepareStorageRequest(operation, payload);
    return storageTransport(
      request,
      {
        url: `${this.opts.baseUrl.replace(/\/$/, "")}${operation}`,
        headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(REVIEW_FEEDBACK_REQUEST_MS),
        timeoutMs: REVIEW_FEEDBACK_REQUEST_MS,
        fetch: this.opts.fetch,
        redirect: "error",
      },
      async (res) => {
        if (!res.ok) throw new Error(`Review feedback store unavailable (HTTP ${res.status})`);
        const value: unknown = await res.json();
        if (!object(value)) throw new Error("Invalid review feedback response");
        return receive(value);
      },
    );
  }
  async list(sinceMs: number, untilMs: number): Promise<ReviewFeedbackWindow> {
    if (!validFeedbackRange(sinceMs, untilMs)) throw new Error("Invalid review feedback range");
    const entries: ReviewFeedbackEntry[] = [],
      cursors = new Set<string>();
    let after: string | undefined;
    let collectionStartedAt: number | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await this.post("list", { sinceMs, untilMs, ...(after ? { after } : {}) }, async (result) => {
        if (
          !Array.isArray(result.entries) ||
          result.entries.length > 200 ||
          !result.entries.every(isReviewFeedbackEntry)
        )
          throw new Error("Invalid review feedback entries");
        if (result.collectionStartedAt !== undefined) {
          if (
            !Number.isSafeInteger(result.collectionStartedAt) ||
            Number(result.collectionStartedAt) <= 0 ||
            (collectionStartedAt !== undefined && collectionStartedAt !== result.collectionStartedAt)
          )
            throw new Error("Invalid review feedback collection start");
        }
        if (result.nextCursor === undefined) return result;
        if (
          typeof result.nextCursor !== "string" ||
          !result.nextCursor ||
          result.nextCursor.length > 512 ||
          cursors.has(result.nextCursor) ||
          result.nextCursor !== result.entries.at(-1)?.publication.runId
        )
          throw new Error("Invalid review feedback cursor");
        return result;
      });
      entries.push(...(result.entries as ReviewFeedbackEntry[]));
      if (result.collectionStartedAt !== undefined) collectionStartedAt = Number(result.collectionStartedAt);
      if (result.nextCursor === undefined) return { entries, ...(collectionStartedAt ? { collectionStartedAt } : {}) };
      cursors.add(result.nextCursor as string);
      after = result.nextCursor as string;
    }
    throw new Error("Review feedback range exceeds the complete read limit");
  }
  async claim(_now: number, limit: number): Promise<ReviewFeedbackClaim[]> {
    return this.post("claim", { limit }, async (result): Promise<ReviewFeedbackClaim[]> => {
      if (
        !Array.isArray(result.claims) ||
        result.claims.length > 20 ||
        !result.claims.every(
          (c) =>
            object(c) &&
            Number.isSafeInteger(c.lease) &&
            Number(c.lease) > 0 &&
            isReviewFeedbackEntry({ publication: c.publication }),
        )
      )
        throw new Error("Invalid review feedback claims");
      return result.claims as unknown as ReviewFeedbackClaim[];
    });
  }
  async complete(claim: ReviewFeedbackClaim, update: ReviewFeedbackSnapshot, _now: number): Promise<boolean> {
    return this.post(
      "complete",
      { runId: claim.publication.runId, lease: claim.lease, update },
      async (result): Promise<boolean> => {
        if (typeof result.ok !== "boolean") throw new Error("Invalid review feedback completion");
        return result.ok;
      },
    );
  }
  async cooldown(untilMs: number): Promise<void> {
    return this.post("cooldown", { untilMs }, async (result): Promise<void> => {
      if (result.ok !== true) throw new Error("Invalid review feedback cooldown");
    });
  }
}

export function buildReviewFeedbackStore(
  config: StateWorkerBlocks,
  secrets: SecretReader,
): ReviewFeedbackStore | undefined {
  const worker = config.runHistory?.worker;
  const token = worker && secrets.named(worker.tokenEnv ?? "MEMORY_TOKEN");
  return worker && token
    ? new WorkerReviewFeedbackStore({ baseUrl: worker.baseUrl, token: token.reveal(), storeKey: RUN_STORE_KEY })
    : undefined;
}
