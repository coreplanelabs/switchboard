import { isRunProfile } from "../../config/profile.js";
import type { LiveRunMeta } from "../runLedger/types.js";
import { sourceHash } from "../references/receipts.js";
import { GITHUB_READ_TOOLS, type GithubCapability } from "../../tools/github.js";
import type { ChatMessage } from "../chatMessage.js";
import {
  isSourceResultReceipt,
  withSourceResults,
  type SourceResultReceipt,
} from "../references/sourceResultContext.js";

/** Hash only acknowledged execution identity, never display or remaining-time projections. */
export async function executionAdmissionHash(meta: LiveRunMeta): Promise<string | undefined> {
  if (
    !meta.agent ||
    meta.agent === "orchestrator" ||
    !isRunProfile(meta.profile) ||
    meta.profile.identity !== "read" ||
    meta.readonly !== true ||
    !meta.userId ||
    !meta.channelId ||
    !meta.threadKey ||
    !meta.repo ||
    !meta.pr
  )
    return undefined;
  return sourceHash({
    userId: meta.userId,
    channelId: meta.channelId,
    threadKey: meta.threadKey,
    authenticatedAs: meta.authenticatedAs,
    postedBy: meta.postedBy,
    agent: meta.agent,
    profile: {
      machine: meta.profile.machine,
      identity: meta.profile.identity,
      minutes: meta.profile.minutes,
      boundedBy: meta.profile.boundedBy,
    },
    operationTarget: meta.operationTarget,
    repo: meta.repo,
    pr: meta.pr,
    ref: meta.ref,
    baseRef: meta.baseRef,
    headSha: meta.headSha,
  });
}

export async function recordedGithubRead(
  messages: readonly ChatMessage[],
  receipt: SourceResultReceipt,
): Promise<Record<string, unknown> | undefined> {
  let input: Record<string, unknown> | undefined;
  let delivered = 0;
  for (const message of messages) {
    for (const part of message.content)
      if (message.role === "assistant" && part.type === "tool_use" && part.id === receipt.callId) {
        if (
          part.name !== receipt.tool ||
          input !== undefined ||
          !part.input ||
          typeof part.input !== "object" ||
          Array.isArray(part.input)
        )
          return undefined;
        input = part.input as Record<string, unknown>;
      }
    if (message.role !== "user") continue;
    const proved = await withSourceResults(message, message.sourceResults);
    if (
      input &&
      proved.sourceResults?.some((r) => isSourceResultReceipt(r) && JSON.stringify(r) === JSON.stringify(receipt))
    )
      delivered++;
  }
  return input && delivered === 1 && (receipt.version === 1 || (await sourceHash(input)) === receipt.inputHash)
    ? input
    : undefined;
}

/** The original declared read family must succeed now; a catalog alone grants no other family. */
export async function currentGithubReadCapability(
  receipt: SourceResultReceipt,
  input: Record<string, unknown>,
  github: GithubCapability,
  agentName: string,
): Promise<boolean> {
  const tool = GITHUB_READ_TOOLS.find((tool) => tool.name === receipt.tool);
  if (!tool) return false;
  let called = 0,
    failed = false;
  const api = new Proxy(github.api, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        called++;
        try {
          return await value.apply(target, args);
        } catch (error) {
          failed = true;
          throw error;
        }
      };
    },
  });
  try {
    const current = await github.api.listRepos();
    if (receipt.repos.some((repo) => !current.some((row) => row.fullName.toLowerCase() === repo))) return false;
    if (receipt.tool === "github_search_code") for (const repo of receipt.repos) await github.api.listTree(repo);
    await tool.run(input, { executor: {} as never, agentName, github: { ...github, api } });
    return called > 0 && !failed;
  } catch {
    return false;
  }
}
