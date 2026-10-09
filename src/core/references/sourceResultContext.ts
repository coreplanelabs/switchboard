import { MAX_TOOL_RESULT_CHARS, type ChatMessage, type ContentPart } from "../chatMessage.js";
import { requiresFreshSourceTool } from "../runLedger/sessionLog.js";
import type { TranscriptRow } from "../runLedger/types.js";
import type { ContextDependencies } from "./contextDependencies.js";
import { sourceHash } from "./receipts.js";

/** Controller-written proof for one returned public GitHub result. Access
 * remains the repository dependency, while this receipt binds stored bytes. */
export interface SourceResultReceipt {
  version: 1 | 2;
  runId: string;
  callId: string;
  tool: string;
  repos: readonly string[];
  resultHash: string;
  /** Native page identity and its exact structured payload inside the returned bytes. */
  reviewHistory?: ReviewHistoryReadReceipt;
  /** Same-run execution provenance; current access must be checked separately. */
  admissionHash?: string;
  inputHash?: string;
}

export interface ReviewHistoryReadReceipt {
  repo: string;
  number: number;
  head: string;
  fingerprint: string;
  page: number;
  pages: number;
  pageSize: number;
  payload: { offset: number; length: number; hash: string };
}

export function isReviewHistoryReadReceipt(value: unknown): value is ReviewHistoryReadReceipt {
  if (!value || typeof value !== "object") return false;
  const r = value as ReviewHistoryReadReceipt;
  return (
    Object.keys(r).every((key) =>
      ["repo", "number", "head", "fingerprint", "page", "pages", "pageSize", "payload"].includes(key),
    ) &&
    typeof r.repo === "string" &&
    /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(r.repo) &&
    r.repo.length <= 256 &&
    Number.isSafeInteger(r.number) &&
    r.number > 0 &&
    typeof r.head === "string" &&
    /^[a-f0-9]{40}$/.test(r.head) &&
    typeof r.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(r.fingerprint) &&
    [r.page, r.pages, r.pageSize].every((n) => Number.isSafeInteger(n) && n > 0) &&
    r.page <= r.pages &&
    r.pageSize <= MAX_TOOL_RESULT_CHARS &&
    !!r.payload &&
    typeof r.payload === "object" &&
    Object.keys(r.payload).every((key) => ["offset", "length", "hash"].includes(key)) &&
    Number.isSafeInteger(r.payload.offset) &&
    r.payload.offset >= 0 &&
    Number.isSafeInteger(r.payload.length) &&
    r.payload.length > 0 &&
    r.payload.length <= r.pageSize &&
    r.payload.offset + r.payload.length <= MAX_TOOL_RESULT_CHARS &&
    typeof r.payload.hash === "string" &&
    /^[a-f0-9]{64}$/.test(r.payload.hash)
  );
}
export function isSourceResultReceipt(value: unknown): value is SourceResultReceipt {
  if (!value || typeof value !== "object") return false;
  const r = value as SourceResultReceipt;
  return (
    Object.keys(r).every((key) =>
      [
        "version",
        "runId",
        "callId",
        "tool",
        "repos",
        "resultHash",
        "reviewHistory",
        "admissionHash",
        "inputHash",
      ].includes(key),
    ) &&
    (r.version === 1
      ? r.admissionHash === undefined && r.inputHash === undefined
      : r.version === 2 &&
        typeof r.admissionHash === "string" &&
        /^[a-f0-9]{64}$/.test(r.admissionHash) &&
        typeof r.inputHash === "string" &&
        /^[a-f0-9]{64}$/.test(r.inputHash)) &&
    [r.runId, r.callId, r.tool].every((s) => typeof s === "string" && s.length > 0 && s.length <= 256) &&
    Array.isArray(r.repos) &&
    r.repos.length > 0 &&
    r.repos.length <= 256 &&
    r.repos.every(
      (repo) =>
        typeof repo === "string" &&
        /^[^/\s]+\/[^/\s]+$/.test(repo) &&
        repo === repo.toLowerCase() &&
        repo.length <= 256,
    ) &&
    new Set(r.repos).size === r.repos.length &&
    typeof r.resultHash === "string" &&
    /^[a-f0-9]{64}$/.test(r.resultHash) &&
    (r.reviewHistory === undefined ||
      (r.tool === "github_pull_get" &&
        isReviewHistoryReadReceipt(r.reviewHistory) &&
        r.repos.includes(r.reviewHistory.repo)))
  );
}

/** Hash outside the store's synchronous transaction; its owner and source
 * metadata are still checked inside that transaction. */
export async function verifiedSourceResults(rows: readonly TranscriptRow[]): Promise<ReadonlySet<string>> {
  const verified = new Set<string>();
  await Promise.all(
    rows.map(async (row) => {
      try {
        const stored = JSON.parse(row.json) as { part?: ContentPart; sourceResult?: SourceResultReceipt };
        const receipt = stored.sourceResult;
        if (
          stored.part?.type === "tool_result" &&
          isSourceResultReceipt(receipt) &&
          receipt.callId === stored.part.toolUseId &&
          (await sourceHash(stored.part.content)) === receipt.resultHash
        )
          verified.add(row.json);
      } catch {
        /* A malformed result carries no proof. */
      }
    }),
  );
  return verified;
}

/** Only the controller's saved receipt can annotate freshly mirrored bytes. */
export async function withSourceResults(message: ChatMessage, candidates: unknown): Promise<ChatMessage> {
  const receipts = Array.isArray(candidates) ? candidates.filter(isSourceResultReceipt) : [];
  const accepted: SourceResultReceipt[] = [];
  for (const part of message.content) {
    if (part.type !== "tool_result") continue;
    const hash = await sourceHash(part.content);
    for (const receipt of receipts)
      if (receipt.callId === part.toolUseId && receipt.resultHash === hash) accepted.push(receipt);
  }
  const { sourceResults: _unverified, ...body } = message;
  return { ...body, ...(accepted.length ? { sourceResults: accepted } : {}) };
}

/** A seed was admitted against frozen original evidence. New step results
 * require this writer's action, so an inherited call ID grants no new read.
 * A byte-identical mirror retry adds no newly exposed context. */
export function uncoveredSourceResult(
  existing: readonly TranscriptRow[],
  incoming: readonly TranscriptRow[],
  context: ContextDependencies | undefined,
  writerRunId?: string,
  verified: ReadonlySet<string> = new Set(),
): boolean {
  const calls = new Map<string, string>();
  for (const row of [...existing, ...incoming]) {
    const part = storedPart(row);
    if (part?.type === "tool_use") calls.set(part.id, part.name);
  }
  for (const row of incoming) {
    const part = storedPart(row);
    if (part?.type !== "tool_result") continue;
    if (existing.some((old) => old.idx === row.idx && old.part === row.part && old.json === row.json)) continue;
    if (
      context?.mcp.some(
        (ref) => ref.callIds.includes(part.toolUseId) && (writerRunId === undefined || ref.runId === writerRunId),
      )
    )
      continue;
    const name = calls.get(part.toolUseId);
    const receipt = storedReceipt(row);
    if (
      isSourceResultReceipt(receipt) &&
      verified.has(row.json) &&
      receipt.callId === part.toolUseId &&
      receipt.tool === name &&
      (writerRunId === undefined || receipt.runId === writerRunId) &&
      (receipt.version === 1
        ? receipt.repos.every((repo) => context?.githubRepos?.includes(repo))
        : context?.version === 2 &&
          context.executionGithub?.some(
            (ref) =>
              ref.runId === receipt.runId &&
              ref.callId === receipt.callId &&
              ref.resultHash === receipt.resultHash &&
              ref.admissionHash === receipt.admissionHash,
          ))
    )
      continue;
    if (name === undefined || requiresFreshSourceTool(name)) return true;
  }
  return false;
}

function storedReceipt(row: TranscriptRow): unknown {
  try {
    return (JSON.parse(row.json) as { sourceResult?: unknown }).sourceResult;
  } catch {
    return undefined;
  }
}

function storedPart(row: TranscriptRow): ContentPart | undefined {
  try {
    return (JSON.parse(row.json) as { part?: ContentPart }).part;
  } catch {
    return undefined;
  }
}
