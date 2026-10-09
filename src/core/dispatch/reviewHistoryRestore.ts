import type { ChatMessage } from "../chatMessage.js";
import { isContextDependencies, type ContextDependencies } from "../references/contextDependencies.js";
import { sourceHash } from "../references/receipts.js";
import {
  isReviewHistoryReadReceipt,
  isSourceResultReceipt,
  withSourceResults,
  type ReviewHistoryReadReceipt,
} from "../references/sourceResultContext.js";
import { outstandingReviewFindings, type ReviewHistoryContext } from "../reviewHistory.js";
import type { ToolContext } from "../../tools/runnableTool.js";
import { githubPullGetTool } from "../../tools/github.js";
import { recordedGithubRead } from "./executionGithubContext.js";
import type { PullFeedback } from "../../execution/githubApi.js";

export interface RecordedReviewHistory {
  read: ReviewHistoryReadReceipt;
  snapshot?: ReviewHistoryContext["snapshot"];
  progress?: ReviewHistoryContext["progress"];
}

/** Replay only original controller receipts and recorded result bytes. No external reads. */
export async function reconstructRecordedReviewHistory(input: {
  runId: string;
  target: ReviewHistoryContext["target"];
  messages: readonly ChatMessage[];
  receipts: unknown;
  context: ContextDependencies | undefined;
}): Promise<RecordedReviewHistory | undefined> {
  if (
    !isContextDependencies(input.context) ||
    input.context.status !== "known" ||
    (!input.context.githubRepos?.includes(input.target.repo.toLowerCase()) && !input.context.executionGithub?.length) ||
    !Array.isArray(input.receipts)
  )
    return undefined;
  const receipts = input.receipts.filter(isSourceResultReceipt).filter((r) => r.runId === input.runId);
  const calls = new Map<string, boolean>();
  const pending = new Set<string>();
  let frame: { read: ReviewHistoryReadReceipt; chunks: string[] } | undefined;
  try {
    for (const message of input.messages) {
      const proved = await withSourceResults(message, message.sourceResults);
      for (const part of message.content) {
        if (part.type === "tool_use" && message.role === "assistant") {
          if (calls.has(part.id)) return undefined;
          const args = part.input as Record<string, unknown> | undefined;
          const bound =
            part.name === "github_pull_get" &&
            args &&
            typeof args.repo === "string" &&
            args.repo
              .trim()
              .replace(/\.git$/i, "")
              .toLowerCase() === input.target.repo.toLowerCase() &&
            Number(args.number) === input.target.number &&
            args.includeReviewHistory === true;
          calls.set(part.id, !!bound);
          if (bound) pending.add(part.id);
          continue;
        }
        if (part.type !== "tool_result" || message.role !== "user" || !calls.get(part.toolUseId)) continue;
        pending.delete(part.toolUseId);
        const receipt = proved.sourceResults?.find(
          (r) => r.callId === part.toolUseId && receipts.some((saved) => JSON.stringify(saved) === JSON.stringify(r)),
        );
        if (
          receipt?.version === 2 &&
          (!input.context.executionGithub?.some(
            (ref) =>
              ref.runId === receipt.runId &&
              ref.callId === receipt.callId &&
              ref.resultHash === receipt.resultHash &&
              ref.admissionHash === receipt.admissionHash,
          ) ||
            !(await recordedGithubRead(input.messages, receipt)))
        )
          return undefined;
        const read = receipt?.reviewHistory;
        if (
          part.isError ||
          typeof part.content !== "string" ||
          !read ||
          read.repo !== input.target.repo.toLowerCase() ||
          read.number !== input.target.number ||
          part.content.length < read.payload.offset + read.payload.length
        ) {
          frame = undefined;
          continue;
        }
        const chunk = part.content.slice(read.payload.offset, read.payload.offset + read.payload.length);
        if ((await sourceHash(chunk)) !== read.payload.hash) return undefined;
        if (read.page === 1) frame = { read, chunks: [] };
        if (
          !frame ||
          frame.chunks.length !== read.page - 1 ||
          frame.read.head !== read.head ||
          frame.read.fingerprint !== read.fingerprint ||
          frame.read.pages !== read.pages ||
          frame.read.pageSize !== read.pageSize
        )
          return undefined;
        frame.read = read;
        frame.chunks.push(chunk);
      }
    }
    if (!frame || pending.size) return undefined;
    const read = structuredClone(frame.read);
    if (read.page < read.pages)
      return {
        read,
        progress: { head: read.head, fingerprint: read.fingerprint, nextPage: read.page + 1, pageSize: read.pageSize },
      };
    const document = frame.chunks.join("");
    if ((await sourceHash(`${read.pageSize}\n${document}`)) !== read.fingerprint) return undefined;
    const saved = JSON.parse(document) as PullFeedback & { outstandingFindings?: unknown };
    if (!saved || !Array.isArray(saved.reviews) || !Array.isArray(saved.comments)) return undefined;
    const findings = outstandingReviewFindings(saved.reviews);
    if (JSON.stringify(findings) !== JSON.stringify(saved.outstandingFindings)) return undefined;
    return { read, snapshot: { head: read.head, findings } };
  } catch {
    return undefined;
  }
}

/** A new controlled read validates freshness. It never supplies yesterday's replayed state. */
export async function revalidateRecordedReviewHistory(
  recorded: RecordedReviewHistory,
  ctx: ToolContext,
  executionValidated = false,
): Promise<boolean> {
  const before = recorded.read;
  if (
    !ctx.github ||
    ctx.reviewHistory?.target.repo.toLowerCase() !== before.repo ||
    ctx.reviewHistory.target.number !== before.number ||
    (ctx.reviewHistory.requiredHead !== undefined && ctx.reviewHistory.requiredHead !== before.head)
  )
    return false;
  try {
    const readable = await ctx.github.readableRepos?.([before.repo]);
    if (!readable?.some((repo) => repo.fullName.toLowerCase() === before.repo) && !executionValidated) return false;
    const fresh: ReviewHistoryContext = {
      target: { repo: before.repo, number: before.number },
      pageSize: before.pageSize,
    };
    await githubPullGetTool.run({ ...fresh.target, includeReviewHistory: true }, { ...ctx, reviewHistory: fresh });
    const current = fresh.lastRead;
    if (
      !isReviewHistoryReadReceipt(current) ||
      current.head !== before.head ||
      current.fingerprint !== before.fingerprint ||
      current.pages !== before.pages ||
      current.pageSize !== before.pageSize
    )
      return false;
    // The branch may move while GitHub history is fetched. The publication guard still rechecks later.
    const final = await ctx.github.api.getPullRequest(before.repo, before.number);
    return final.head.sha === before.head;
  } catch {
    return false;
  }
}
