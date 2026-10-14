import {
  checkExecutionStateOf,
  checkOperationSeed,
  checkMetadataOperationSeed,
  stateSchema,
} from "./checkExecutionSchema.js";
import { z } from "zod";
import { checkCommandHash, checkOperationSchema, type CheckOperation } from "../execution/checkOperation.js";
import type { ExecResult } from "../execution/execResult.js";
import type { Resource } from "./authz/types.js";

export const checkSelectorSchema = z
  .object({
    runId: z.string().min(1).max(128),
    callId: z.string().min(1).max(200),
    phase: z.enum(["metadata", "command"]),
  })
  .strict();
export type CheckSelector = z.infer<typeof checkSelectorSchema>;
const identitySchema = z
  .object({
    id: z.string().min(1).max(128),
    userId: z.string().min(1).max(512),
    channelId: z.string().min(1).max(512),
    channelVisibility: z.enum(["public", "private", "dm", "machine", "unknown"]),
    repo: z.string().min(1).max(512),
    threadKey: z.string().min(1).max(512),
    unit: z.string().min(1).max(512).optional(),
  })
  .strict();
const archiveSchema = z
  .object({ version: z.literal(1), identity: identitySchema, sealed: z.boolean(), checks: z.unknown() })
  .strict();
export type CheckArchive = z.infer<typeof archiveSchema>;
const resultSchema = z
  .object({
    stdout: z.string().max(4_000),
    stderr: z.string().max(4_000),
    exitCode: z.number().int().min(0).max(255),
    truncated: z.boolean(),
  })
  .strict();

/** Called only with the store's fenced live row, never the submitted final record. */
export function captureCheckArchive(
  row: {
    runId: string;
    meta: {
      userId: string;
      channelId: string;
      channelVisibility?: Extract<Resource, { type: "run" }>["channelVisibility"];
      repo?: string;
      threadKey: string;
      idempotencyKey?: string;
    };
    state: { checkExecutions?: unknown };
  },
  sealed = false,
): CheckArchive | undefined {
  if (row.state.checkExecutions === undefined) return undefined;
  const source = archiveSchema.safeParse({
    version: 1,
    sealed,
    identity: {
      id: row.runId,
      userId: row.meta.userId,
      channelId: row.meta.channelId,
      channelVisibility: row.meta.channelVisibility ?? "unknown",
      repo: row.meta.repo,
      threadKey: row.meta.threadKey,
      ...(row.meta.idempotencyKey === undefined ? {} : { unit: row.meta.idempotencyKey }),
    },
    checks: row.state.checkExecutions,
  });
  if (
    !source.success ||
    !checkExecutionStateOf(source.data.checks, {
      runId: row.runId,
      requester: row.meta.userId,
      threadKey: row.meta.threadKey,
      repo: row.meta.repo ?? "",
      ...(row.meta.idempotencyKey === undefined ? {} : { unit: row.meta.idempotencyKey }),
    })
  )
    throw new Error("canonical check state is unreadable");
  return structuredClone(source.data);
}

export function checkArchiveOf(value: unknown): CheckArchive | undefined {
  const source = archiveSchema.safeParse(value);
  if (!source.success) return undefined;
  const identity = source.data.identity;
  return checkExecutionStateOf(source.data.checks, {
    runId: identity.id,
    requester: identity.userId,
    threadKey: identity.threadKey,
    repo: identity.repo,
    ...(identity.unit === undefined ? {} : { unit: identity.unit }),
  })
    ? source.data
    : undefined;
}

export interface CheckSource {
  version: 1;
  state: "live" | "terminal";
  selector: CheckSelector;
  resource: Extract<Resource, { type: "run" }>;
  threadKey: string;
  operation?: CheckOperation;
  result?: ExecResult;
}
export type CheckSourceRead = { kind: "source"; source: CheckSource } | { kind: "unavailable" };

/** A bounded selector read. Missing phase identities are never reconstructed. */
export async function selectCheckSource(
  archive: unknown,
  selector: CheckSelector,
  state: CheckSource["state"],
): Promise<CheckSourceRead> {
  const source = checkArchiveOf(archive);
  if (
    !source ||
    !checkSelectorSchema.safeParse(selector).success ||
    source.identity.id !== selector.runId ||
    (state === "terminal" && !source.sealed)
  )
    return { kind: "unavailable" };
  const identity = source.identity;
  const owner = {
    runId: identity.id,
    requester: identity.userId,
    threadKey: identity.threadKey,
    repo: identity.repo,
    ...(identity.unit === undefined ? {} : { unit: identity.unit }),
  };
  const checks = checkExecutionStateOf(source.checks, owner);
  if (!checks) return { kind: "unavailable" };
  const selected =
    selector.phase === "metadata"
      ? checks.metadata?.callId === selector.callId
        ? checks.metadata
        : undefined
      : checks.receipts.find((value) => value.callId === selector.callId);
  if (!selected) return { kind: "unavailable" };
  const operation = selected.checkOperation;
  if (operation) {
    const commandKey = await checkCommandHash(checkOperationSeed(owner, selector.callId, selected.inputHash));
    const expected =
      selector.phase === "metadata" ? await checkCommandHash(checkMetadataOperationSeed(commandKey)) : commandKey;
    if (operation.key !== expected) return { kind: "unavailable" };
  }
  const result =
    "result" in selected
      ? selected.result
      : "outcome" in selected && selected.outcome.kind === "completed"
        ? (({ kind: _kind, ...result }) => result)(selected.outcome)
        : undefined;
  return {
    kind: "source",
    source: {
      version: 1,
      state,
      selector: { ...selector },
      threadKey: identity.threadKey,
      resource: {
        type: "run",
        id: identity.id,
        userId: identity.userId,
        channelId: identity.channelId,
        channelVisibility: identity.channelVisibility,
        repo: identity.repo,
      },
      ...(operation ? { operation } : {}),
      ...(result && ![124, 137, 143].includes(result.exitCode) ? { result } : {}),
    },
  };
}

export type CheckInspection =
  | { kind: "known"; result: ExecResult; source: "canonical" | "resident" }
  | { kind: "pending"; reason: "native_ending_unproven" }
  | { kind: "retired"; reason: "output_retired" | "native_ended"; proofHash?: string }
  | { kind: "unavailable"; reason: "source" | "identity" | "proof" | "backend" | "live" };

const sourceSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(["live", "terminal"]),
    selector: checkSelectorSchema,
    resource: z
      .object({
        type: z.literal("run"),
        id: z.string().min(1).max(128),
        userId: z.string().min(1).max(512),
        channelId: z.string().min(1).max(512),
        channelVisibility: z.enum(["public", "private", "dm", "machine", "unknown"]),
        repo: z.string().min(1).max(512),
      })
      .strict(),
    threadKey: z.string().min(1).max(512),
    operation: checkOperationSchema.optional(),
    result: resultSchema.optional(),
  })
  .strict();

export function checkSourceReadOf(value: unknown, selector: CheckSelector): CheckSourceRead {
  const parsed = z
    .object({ kind: z.literal("source"), source: sourceSchema })
    .strict()
    .safeParse(value);
  if (
    !parsed.success ||
    parsed.data.source.selector.runId !== selector.runId ||
    parsed.data.source.selector.callId !== selector.callId ||
    parsed.data.source.selector.phase !== selector.phase ||
    parsed.data.source.resource.id !== selector.runId
  )
    return { kind: "unavailable" };
  return parsed.data;
}

/** Binds a returned observation to the source already authorized by the gateway. */
export async function checkSourceIdentityHash(source: CheckSource): Promise<string> {
  const { selector, resource, operation } = source;
  return checkCommandHash(
    JSON.stringify({
      version: 1,
      selector: { runId: selector.runId, callId: selector.callId, phase: selector.phase },
      resource: {
        type: resource.type,
        id: resource.id,
        userId: resource.userId,
        channelId: resource.channelId,
        channelVisibility: resource.channelVisibility,
        repo: resource.repo,
      },
      threadKey: source.threadKey,
      operation: operation ? { key: operation.key, commandHash: operation.commandHash } : null,
    }),
  );
}

/** Restart cannot erase an earlier operation's no-repeat evidence. */
export function restoreArchivedChecks(
  archive: unknown,
  incoming: unknown,
  owner: {
    id: string;
    userId: string;
    channelId: string;
    channelVisibility?: Extract<Resource, { type: "run" }>["channelVisibility"];
    threadKey: string;
    repo?: string;
    idempotencyKey?: string;
  },
): { checks: unknown } | undefined {
  if (archive === undefined) return { checks: incoming };
  const parsed = checkArchiveOf(archive);
  if (
    !parsed ||
    parsed.identity.id !== owner.id ||
    parsed.identity.userId !== owner.userId ||
    parsed.identity.channelId !== owner.channelId ||
    parsed.identity.channelVisibility !==
      (owner.channelVisibility === undefined ? "unknown" : owner.channelVisibility) ||
    parsed.identity.threadKey !== owner.threadKey ||
    parsed.identity.repo !== owner.repo
  )
    return undefined;
  const binding = {
    runId: owner.id,
    requester: owner.userId,
    threadKey: owner.threadKey,
    repo: owner.repo ?? "",
    ...(owner.idempotencyKey === undefined ? {} : { unit: owner.idempotencyKey }),
  };
  const prior = parsed && checkExecutionStateOf(parsed.checks, binding);
  if (!prior) return undefined;
  if (incoming === undefined) return { checks: structuredClone(prior) };
  const next = checkExecutionStateOf(incoming, binding);
  if (!next) return undefined;
  for (const receipt of prior.receipts) {
    const replacement = next.receipts.find((candidate) => candidate.callId === receipt.callId);
    if (!replacement) return undefined;
    const { outcome, completedAt: _at, ...identity } = receipt;
    const { outcome: later, completedAt: _laterAt, ...laterIdentity } = replacement;
    if (
      JSON.stringify(identity) !== JSON.stringify(laterIdentity) ||
      (outcome.kind === "completed" && JSON.stringify(outcome) !== JSON.stringify(later))
    )
      return undefined;
  }
  if (prior.metadata && !next.metadata) {
    const command = next.receipts.find(
      (receipt) => receipt.callId === prior.metadata!.callId && receipt.inputHash === prior.metadata!.inputHash,
    );
    if (!command) return undefined;
  } else if (prior.metadata && next.metadata) {
    const { result: _result, ...identity } = prior.metadata;
    const { result: _laterResult, ...laterIdentity } = next.metadata;
    if (JSON.stringify(identity) !== JSON.stringify(laterIdentity)) return undefined;
  }
  return { checks: incoming };
}

/** Abandon is only for a reservation without recorded execution evidence. */
export function hasRecordedCheckEvidence(value: unknown): boolean {
  if (value === undefined) return false;
  const state = stateSchema.safeParse(value);
  return !state.success || state.data.receipts.length > 0 || state.data.metadata !== undefined;
}
