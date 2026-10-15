import { isRunProfile } from "../../config/profile.js";
import type { LiveRunMeta } from "../runLedger/types.js";
import { sourceHash } from "../references/receipts.js";
import { GITHUB_READ_TOOLS, type GithubCapability } from "../../tools/github.js";
import { capToolResultContent, type ChatMessage } from "../chatMessage.js";
import {
  GithubApiError,
  GithubCredentialUnavailable,
  GithubResponseDecodeError,
  githubResponseFailureOf,
} from "../../execution/githubApi.js";
import { classificationOf } from "../trace/classify.js";
import {
  GITHUB_ACCESS_OPERATIONS,
  GITHUB_ACCESS_ROUTES,
  GITHUB_ACCESS_TOOLS,
  type GithubAccessDiagnostic,
} from "../references/githubAccessDiagnostic.js";
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
): Promise<{ ok: true } | { ok: false; githubAccess: GithubAccessDiagnostic }> {
  const tool = GITHUB_READ_TOOLS.find((tool) => tool.name === receipt.tool);
  const sourceCallHash = await sourceHash(receipt.callId);
  let stage: GithubAccessDiagnostic["stage"] = "tool-family";
  let operation: GithubAccessDiagnostic["operation"] = "none";
  const denied = (
    reason: GithubAccessDiagnostic["reason"],
    facts: Pick<GithubAccessDiagnostic, "httpStatus" | "requestId" | "route"> = {},
    failedOperation = operation,
  ) => ({
    ok: false as const,
    githubAccess: {
      tool: (GITHUB_ACCESS_TOOLS as readonly string[]).includes(receipt.tool)
        ? (receipt.tool as GithubAccessDiagnostic["tool"])
        : ("unknown" as const),
      stage,
      operation: failedOperation,
      reason,
      sourceCallHash,
      ...facts,
    },
  });
  const failedRead = (error: unknown, failedOperation = operation) => {
    if (error instanceof GithubCredentialUnavailable)
      return denied(error.reason === "missing" ? "credential-missing" : "credential-failed", {}, failedOperation);
    const response = githubResponseFailureOf(error);
    const status =
      response?.httpStatus ??
      (error instanceof GithubApiError
        ? error.status
        : error instanceof GithubResponseDecodeError
          ? error.httpStatus
          : undefined);
    const requestId =
      response?.requestId ??
      (error instanceof GithubApiError || error instanceof GithubResponseDecodeError ? error.requestId : undefined);
    const classification = classificationOf(error);
    const originalRoute =
      response?.route ??
      (error instanceof GithubApiError || error instanceof GithubResponseDecodeError
        ? error.route
        : classification?.code);
    const route = (GITHUB_ACCESS_ROUTES as readonly unknown[]).includes(originalRoute)
      ? (originalRoute as GithubAccessDiagnostic["route"])
      : undefined;
    const reason =
      error instanceof GithubApiError
        ? route
          ? "http"
          : "api"
        : error instanceof SyntaxError
          ? "decode"
          : classification?.kind === "transport"
            ? "transport"
            : classification?.kind === "timeout" ||
                (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
              ? "timeout"
              : "unknown";
    return denied(
      reason,
      {
        ...(route && status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
          ? { httpStatus: status }
          : {}),
        ...(requestId && /^[0-9A-Fa-f:]{1,64}$/.test(requestId) ? { requestId } : {}),
        ...(route ? { route } : {}),
      },
      failedOperation,
    );
  };
  if (!tool) return denied("unsupported-tool");
  let called = 0;
  let usesPublicAccess = false;
  let firstFailure: ReturnType<typeof failedRead> | undefined;
  const api = new Proxy(github.api, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        called++;
        const readOperation = (GITHUB_ACCESS_OPERATIONS as readonly unknown[]).includes(property)
          ? (property as GithubAccessDiagnostic["operation"])
          : "none";
        try {
          return await value.apply(target, args);
        } catch (error) {
          firstFailure ??= failedRead(error, readOperation);
          throw error;
        }
      };
    },
  });
  try {
    stage = "catalog";
    operation = "listRepos";
    const current = await github.api.listRepos();
    stage = "repository";
    for (const repo of receipt.repos) {
      if (current.some((row) => row.fullName.toLowerCase() === repo)) continue;
      // Public upstream sources need not belong to this App installation.
      operation = "isPublicRepo";
      if (!(await github.api.isPublicRepo(repo))) return denied("repository-missing");
      usesPublicAccess = true;
    }
    if (receipt.tool === "github_search_code") {
      stage = "contents";
      operation = "listTree";
      for (const repo of receipt.repos) await github.api.listTree(repo);
    }
    stage = "tool-read";
    operation = "none";
    const result = await tool.run(input, { executor: {} as never, agentName, github: { ...github, api } });
    if (firstFailure) return firstFailure;
    if (called === 0) return denied("no-api-call");
    // Current public visibility cannot authorize different, formerly private bytes.
    if (usesPublicAccess && (await sourceHash(capToolResultContent(result))) !== receipt.resultHash)
      return denied("public-result-changed");
    return { ok: true };
  } catch (error) {
    return firstFailure ?? failedRead(error);
  }
}
