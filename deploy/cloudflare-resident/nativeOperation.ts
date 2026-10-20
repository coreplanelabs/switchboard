import {
  archiveControlAnswer,
  restoreSnapshotSchema,
  restoreIdentitySchema,
  restoreReceiptSchema,
  workspaceMutationPathsSchema,
  restorePrivateDirectory,
  pathsOverlap,
  sameRestoreIdentity,
  RESTORE_RECEIPT_BYTES,
  type RestoreIdentity,
  type RestoreReceipt,
} from "./restoreArchive.js";
import {
  nativeRetirementPermitSchema,
  nativeRetirementTargetKey,
  type NativeRetirementPermit,
  type NativeRetirementTarget,
} from "../../src/execution/nativeRetirement.js";
import { z } from "zod";
import { isWorkspaceOwner, workspaceOwnerKey, type WorkspaceOwner } from "../../src/core/workspaceSettlement.js";
import {
  NativeRunScopes,
  nativeScopeMatches,
  type NativeScopeTransport,
  nativeScopeRefSchema,
  nativeScopeClosed,
  nativeScopeKey,
  nativeScopeRetirementKey,
  nativeTimeoutEndingSchema,
  type NativeTimeoutEnding,
  type NativeScopeRef,
  nativeExecutionScopeRefSchema,
  nativeOperatorScopeRefSchema,
  nativeOperatorScopeKey,
  nativeOperatorScopeEnding,
  nativeOperatorScopeClosing,
  reserveNativeOperatorScope,
  type NativeExecutionScopeRef,
  type NativeOperatorOwner,
} from "./nativeScope.js";

export const NATIVE_OPERATION_PREFIX = "native-operation:";
const RECEIPT_PREFIX = "native-operation-receipt:";
const OPERATOR_ENDING_PREFIX = "native-operation-ending:";
const PRODUCER_PREFIX = "native-operation-producer:";
const ADMISSION_PREFIX = "native-operation-admission:";
const RETIREMENT_PREFIX = "native-retirement:";
const CONTROL_PREFIX = "native-operation-control:";
const PAGE_SIZE = 25;
const ATTEMPT_LIMIT = 64;
const TIMEOUT_RECEIPT_BYTES = 64 * 1024;
const TERMINAL_SCOPE_RECORD_LIMIT = 64;
const TERMINAL_SCOPE_PREPARATION_BYTES = 64 * 1024;
const processIdentity = z.object({
  id: z.string().min(1).max(256),
  pid: z.number().int().positive(),
  startedAt: z.string().datetime({ offset: true }),
});
const attemptSchema = z
  .object({
    kind: z.enum(["process", "opaque"]),
    process: processIdentity.optional(),
    restore: restoreIdentitySchema.optional(),
    mutationPaths: workspaceMutationPathsSchema.optional(),
  })
  .strict()
  .refine((value) => (!value.restore || value.kind === "opaque") && (!value.mutationPaths || value.kind === "process"));
export const nativeOperationOriginSchema = z
  .object({
    producer: z.enum([
      "git-setup",
      "provisioning",
      "hydration",
      "deps-materialize",
      "deps-backup",
      "deps-adopt",
      "op-test",
      "op-build",
      "resident-call",
      "refresh-step",
      "snapshot",
      "restore",
    ]),
    resource: z
      .string()
      .max(63)
      .regex(/^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    callId: z.string().uuid(),
    sourceId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
    actor: z.enum(["system", "service", "admin", "operator", "read", "drain"]),
    traceId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .nullable(),
    parentSourceId: z.string().min(1).max(256).nullable(),
    build: z.string().min(1).max(128),
    workerVersion: z.string().uuid().nullable(),
    startedAt: z.number().int().nonnegative(),
  })
  .strict();
export type NativeOperationOrigin = z.infer<typeof nativeOperationOriginSchema>;
export type NativeOperationProducer = NativeOperationOrigin["producer"];
const operatorAdmissionSchema = z
  .object({
    opOwner: z.string().startsWith("op:"),
    origin: nativeOperationOriginSchema,
    permit: z.object({ id: z.string().uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    callbackMetadataEnded: z.boolean(),
  })
  .strict();
type OperatorAdmission = z.infer<typeof operatorAdmissionSchema>;
const nativeSchema = z
  .object({
    version: z.literal(1),
    closed: z.boolean(),
    threadKey: z.string().min(1).max(256).optional(),
    scope: nativeExecutionScopeRefSchema.optional(),
    pending: z.record(z.string(), attemptSchema).refine((attempts) => Object.keys(attempts).length <= ATTEMPT_LIMIT),
  })
  .strict();
const recordSchema = z.union([
  z
    .object({
      opOwner: z.string().startsWith("op:"),
      origin: nativeOperationOriginSchema.optional(),
      native: nativeSchema.extend({
        scope: nativeOperatorScopeRefSchema.optional(),
        restoreReceipts: z
          .record(
            z.string().uuid(),
            z.object({ receipt: restoreReceiptSchema, hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
          )
          .optional(),
      }),
    })
    .strict(),
  z
    .object({
      runId: z.string().min(1),
      ownerGen: z.string().min(1),
      ownerFence: z.number().int().positive(),
      native: nativeSchema.extend({ threadKey: z.string().min(1).max(256), scope: nativeScopeRefSchema.optional() }),
    })
    .strict(),
]);
const terminalSchema = processIdentity.extend({
  state: z.literal("exited"),
  endedAt: z.string().datetime({ offset: true }),
  exit: z.object({
    code: z.number().int().nonnegative(),
    signal: z.number().int().nonnegative().optional(),
    timedOut: z.boolean(),
  }),
});
export type NativeOperationRecord = z.infer<typeof recordSchema>;
export { recordSchema as nativeOperationRecordSchema };
export interface NativeRuntimeRetirement {
  version: 1;
  cancellationId: string;
  owner: WorkspaceOwner;
  threadKey: string;
  originalBoot: string;
  currentBoot: string;
  originalOperationOutcome: "unknown";
  records: Record<string, string>;
}
export type NativeProcessIdentity = z.infer<typeof processIdentity>;
type NativeTerminal = z.infer<typeof terminalSchema>;
export interface NativeOperationRows {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string; limit: number; startAfter?: string }): Promise<Map<string, T>>;
}
export interface NativeOperationStorage extends NativeOperationRows {
  transaction<T>(action: (rows: NativeOperationRows) => Promise<T>): Promise<T>;
}
type ProcessEndingReceipt = {
  key: string;
  recordHash: string;
  outcome: "native-ended";
  processes: NativeTerminal[];
};
const timeoutReceiptSchema = z
  .object({
    key: z.string().min(1).max(512),
    recordHash: z.string().regex(/^[a-f0-9]{64}$/),
    outcome: z.literal("native-ended"),
    purpose: z.literal("native-timeout-ending"),
    originalOperationOutcome: z.literal("unknown"),
    nativeEnding: nativeTimeoutEndingSchema,
    processes: z.tuple([]),
  })
  .strict();
type TimeoutEndingReceipt = z.infer<typeof timeoutReceiptSchema>;
export type NativeOperationReceipt = ProcessEndingReceipt | TimeoutEndingReceipt;
export type NativeEndingRead =
  | { kind: "missing" }
  | { kind: "unavailable" }
  | { kind: "ended"; original: NativeOperationRecord; receipt: NativeOperationReceipt };

const terminalRetirementSchema = z
  .object({
    purpose: z.literal("terminal-native-scope"),
    permit: nativeRetirementPermitSchema,
    state: z.enum(["prepared", "closed"]),
    records: z
      .record(z.string(), z.string().regex(/^[a-f0-9]{64}$/))
      .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= TERMINAL_SCOPE_RECORD_LIMIT),
    originalOperationOutcome: z.literal("unknown"),
  })
  .strict();
export type TerminalNativeRetirement = z.infer<typeof terminalRetirementSchema>;

type Refusal = {
  error: string;
  status: 409 | 503;
  details?: { class: string; code?: string };
  controls?: z.infer<typeof controlSchema>[];
};

const TERMINAL_REFUSAL_CAUSES = [
  "original-owner-changed",
  "scope-changed",
  "journal-changed",
  "conflicting-terminal-control",
  "terminal-fence-changed",
  "scope-closure-unconfirmed",
  "closure-unconfirmed",
  "preparation-too-large",
  "invalid-terminal-permit",
  "unconfirmed",
] as const;
type TerminalRetirementPhase = "authority" | "prepare" | "scope-close" | "retirement-commit";
interface TerminalRetirementRefusal extends Refusal {
  purpose: "terminal-native-scope";
  phase: TerminalRetirementPhase;
  cause: (typeof TERMINAL_REFUSAL_CAUSES)[number];
}
function terminalRefusal(phase: TerminalRetirementPhase, error: unknown, reason: string): TerminalRetirementRefusal {
  const message = error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
  const cause = TERMINAL_REFUSAL_CAUSES.find((value) => value === message) ?? "unconfirmed";
  return { ...refuse(reason), purpose: "terminal-native-scope", phase, cause };
}

function errorDetails(error: unknown): { class: string; code?: string } {
  const value = error && typeof error === "object" ? (error as { name?: unknown; code?: unknown }) : {};
  const safe = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
  return { class: safe(value.name) ? value.name : "UnknownError", ...(safe(value.code) ? { code: value.code } : {}) };
}

const controlSchema = z
  .object({
    process: processIdentity,
    recordHash: z.string().regex(/^[a-f0-9]{64}$/),
    outcome: z.enum(["requested", "kill-acknowledged", "kill-unverified"]),
    failure: z.object({ class: z.string().max(128), code: z.string().max(128).optional() }).optional(),
  })
  .strict();
function refuse(reason: string): Refusal {
  return { error: `native-operation-recovery-refused: ${reason}`, status: 409 };
}
export function validNativeOperationKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.startsWith(NATIVE_OPERATION_PREFIX) &&
    key.length > NATIVE_OPERATION_PREFIX.length &&
    key.length <= 512
  );
}
function ownerOf(value: unknown): WorkspaceOwner | { opOwner: string } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (isWorkspaceOwner(row)) return { runId: row.runId, ownerGen: row.ownerGen, ownerFence: row.ownerFence };
  if (typeof row.opOwner === "string" && row.opOwner.startsWith("op:")) return { opOwner: row.opOwner };

  return null;
}
async function recordHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
async function producerClaimKey(origin: NativeOperationOrigin): Promise<string | undefined> {
  if (["op-test", "op-build", "resident-call"].includes(origin.producer)) return;
  return PRODUCER_PREFIX + (await recordHash([origin.producer, origin.resource, origin.sourceId]));
}

function recoverable(record: NativeOperationRecord): boolean {
  return Object.values(record.native.pending).every(
    (attempt) => attempt.kind === "process" && attempt.process !== undefined,
  );
}

function timeoutOwnsAttempt(key: string, record: NativeOperationRecord, ending: NativeTimeoutEnding): boolean {
  const selected = record.native.pending[ending.attempt];
  const owned =
    "kind" in ending.ref
      ? "opOwner" in record &&
        !!record.origin &&
        key === `${NATIVE_OPERATION_PREFIX}${record.opOwner}` &&
        record.opOwner === ending.ref.owner.opOwner
      : isWorkspaceOwner(record) &&
        key.startsWith(`native-operation:${ending.ref.threadKey}:${ending.ref.owner.runId}:`) &&
        record.runId === ending.ref.owner.runId &&
        record.ownerGen === ending.ref.owner.ownerGen &&
        record.ownerFence === ending.ref.owner.ownerFence &&
        record.native.threadKey === ending.ref.threadKey;
  return (
    owned &&
    JSON.stringify(record.native.scope) === JSON.stringify(ending.ref) &&
    Object.keys(record.native.pending).length === 1 &&
    selected?.kind === "process" &&
    selected.process === undefined
  );
}

/** This variant records original attempt ending, never a reconstructed command result. */
async function timeoutArchiveOf(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > TIMEOUT_RECEIPT_BYTES) return;
  const archive = value as { original?: unknown; receipt?: unknown };
  const original = recordSchema.safeParse(archive.original);
  const receipt = timeoutReceiptSchema.safeParse(archive.receipt);
  if (
    !original.success ||
    !receipt.success ||
    receipt.data.key !== key ||
    receipt.data.recordHash !== (await recordHash(archive.original)) ||
    !timeoutOwnsAttempt(key, original.data, receipt.data.nativeEnding)
  )
    return;
  return { original: original.data, receipt: receipt.data };
}
/** An empty, live operator scope is the same pre-allocation exemption as before. */
export function unstartedNativeOperator(value: unknown, owner: string): boolean {
  if (!value || typeof value !== "object" || (value as { opOwner?: unknown }).opOwner !== owner) return false;
  const parsed = recordSchema.safeParse(value);
  return parsed.success
    ? !parsed.data.native.closed && Object.keys(parsed.data.native.pending).length === 0
    : Object.keys(value).length === 1;
}

/** A valid empty admission has issued no native work and can close without a runtime. */
export function unstartedNativeThread(value: unknown, owner: WorkspaceOwner, threadKey: string): boolean {
  const parsed = recordSchema.safeParse(value);
  return (
    parsed.success &&
    isWorkspaceOwner(parsed.data) &&
    parsed.data.runId === owner.runId &&
    parsed.data.ownerGen === owner.ownerGen &&
    parsed.data.ownerFence === owner.ownerFence &&
    parsed.data.native.threadKey === threadKey &&
    Object.keys(parsed.data.native.pending).length === 0
  );
}

/** The existing DO journal owns admission and settlement; native status supplies evidence only. */
export class NativeOperationJournal {
  constructor(private readonly storage: NativeOperationStorage) {}

  /** A cancelled epoch releases physical activity, not historical effect certainty. */
  private async frozen(
    key: string,
    value: unknown,
    rows: Pick<NativeOperationRows, "get"> = this.storage,
  ): Promise<TerminalNativeRetirement | undefined> {
    const record = recordSchema.safeParse(value);
    if (!record.success || !isWorkspaceOwner(record.data)) return;
    const thread = record.data.native.threadKey!;
    const raw = await rows.get<unknown>(nativeScopeRetirementKey(thread, record.data));
    if (!raw || typeof raw !== "object" || (raw as { purpose?: unknown }).purpose !== "terminal-native-scope") return;
    const saved = terminalRetirementSchema.parse(raw);
    const scope = saved.permit.target.scope;
    const fence = await rows.get<{ terminalRetirement?: unknown }>(`cancelled:${thread}:${record.data.runId}`);
    if (
      fence?.terminalRetirement !== saved.permit.id ||
      saved.records[key] !== (await recordHash(value)) ||
      JSON.stringify(record.data.native.scope) !== JSON.stringify(scope)
    )
      throw new Error("terminal retirement evidence changed");
    return saved;
  }

  async retireScope(
    target: NativeRetirementTarget,
    native: NativeScopeTransport,
    ownerMatches: (rows: NativeOperationRows, target: NativeRetirementTarget) => Promise<boolean>,
    prepare: () => Promise<NativeRetirementPermit | undefined>,
  ): Promise<TerminalNativeRetirement | TerminalRetirementRefusal> {
    let permit: NativeRetirementPermit | undefined;
    try {
      permit = await this.storage.transaction(async (rows) => {
        const at = nativeScopeRetirementKey(target.scope.threadKey, target.scope.owner);
        const old = await rows.get<unknown>(at);
        if (old !== undefined) {
          const saved = terminalRetirementSchema.parse(old);
          if (nativeRetirementTargetKey(saved.permit.target) !== nativeRetirementTargetKey(target))
            throw new Error("conflicting-terminal-control");
          return saved.permit;
        }
        if (!(await ownerMatches(rows, target))) throw new Error("original-owner-changed");
        if (
          !nativeScopeMatches(await rows.get(nativeScopeKey(target.scope.threadKey, target.scope.owner)), target.scope)
        )
          throw new Error("scope-changed");
        const original = await rows.get(target.key);
        const record = recordSchema.parse(original);
        if (
          (await recordHash(original)) !== target.recordHash ||
          JSON.stringify(record.native.scope) !== JSON.stringify(target.scope)
        )
          throw new Error("journal-changed");
        return undefined;
      });
      permit ??= await prepare();
    } catch (error) {
      return terminalRefusal("authority", error, "terminal-authority-unconfirmed");
    }
    const parsed = nativeRetirementPermitSchema.safeParse(permit);
    if (!parsed.success || nativeRetirementTargetKey(parsed.data.target) !== nativeRetirementTargetKey(target))
      return terminalRefusal("authority", new Error("invalid-terminal-permit"), "invalid-terminal-permit");
    permit = parsed.data;
    const { scope, key, recordHash: expectedHash } = permit.target;
    const at = nativeScopeRetirementKey(scope.threadKey, scope.owner);
    const gate = `cancelled:${scope.threadKey}:${scope.owner.runId}`;
    const prefix = `native-operation:${scope.threadKey}:${scope.owner.runId}:`;
    let phase: TerminalRetirementPhase = "prepare";
    try {
      const prepared = await this.storage.transaction(async (rows) => {
        const previous = await rows.get<unknown>(at);
        if (previous !== undefined) {
          const saved = terminalRetirementSchema.safeParse(previous);
          if (!saved.success || JSON.stringify(saved.data.permit) !== JSON.stringify(permit))
            throw new Error("conflicting-terminal-control");
          const fence = await rows.get<{ terminalRetirement?: unknown }>(gate);
          if (fence?.terminalRetirement !== permit.id) throw new Error("terminal-fence-changed");
          if (JSON.stringify(await this.fingerprints(prefix, rows)) !== JSON.stringify(saved.data.records))
            throw new Error("journal-changed");
          if (saved.data.state === "closed") {
            if (!nativeScopeClosed(await rows.get(nativeScopeKey(scope.threadKey, scope.owner)), scope))
              throw new Error("scope-closure-unconfirmed");
            return saved.data;
          }
          if (!(await ownerMatches(rows, target))) throw new Error("original-owner-changed");
          return saved.data;
        }
        if (await rows.get(gate)) throw new Error("conflicting-terminal-control");
        if (!(await ownerMatches(rows, target))) throw new Error("original-owner-changed");
        if (!nativeScopeMatches(await rows.get(nativeScopeKey(scope.threadKey, scope.owner)), scope))
          throw new Error("scope-changed");
        const records = await this.fingerprints(prefix, rows);
        if (records[key] !== expectedHash || Object.keys(records).length > TERMINAL_SCOPE_RECORD_LIMIT)
          throw new Error("journal-changed");
        for (const operationKey of Object.keys(records)) {
          const record = recordSchema.parse(await rows.get(operationKey));
          if ((await rows.list({ prefix: `${CONTROL_PREFIX}${operationKey}:`, limit: 1 })).size)
            throw new Error("conflicting-terminal-control");
          if (
            !isWorkspaceOwner(record) ||
            workspaceOwnerKey(record) !== workspaceOwnerKey(scope.owner) ||
            record.native.threadKey !== scope.threadKey ||
            JSON.stringify(record.native.scope) !== JSON.stringify(scope)
          )
            throw new Error("scope-changed");
        }
        const saved = terminalRetirementSchema.parse({
          purpose: "terminal-native-scope",
          permit,
          state: "prepared",
          records,
          originalOperationOutcome: "unknown",
        });
        if (new TextEncoder().encode(JSON.stringify(saved)).byteLength > TERMINAL_SCOPE_PREPARATION_BYTES)
          throw new Error("preparation-too-large");
        await rows.put(at, saved);
        await rows.put(gate, { terminalRetirement: permit.id });
        return saved;
      });
      if (prepared.state === "closed") return prepared;
      phase = "scope-close";
      await new NativeRunScopes(this.storage, native).close(scope.threadKey, scope.owner, scope);
      phase = "retirement-commit";
      return await this.storage.transaction(async (rows) => {
        const current = terminalRetirementSchema.parse(await rows.get(at));
        if (
          JSON.stringify(current) !== JSON.stringify(prepared) ||
          !nativeScopeClosed(await rows.get(nativeScopeKey(scope.threadKey, scope.owner)), scope) ||
          JSON.stringify(await this.fingerprints(prefix, rows)) !== JSON.stringify(prepared.records)
        )
          throw new Error("closure-unconfirmed");
        const fence = await rows.get<{ terminalRetirement?: unknown }>(gate);
        if (fence?.terminalRetirement !== permit.id) throw new Error("terminal-fence-changed");
        const closed: TerminalNativeRetirement = { ...current, state: "closed" };
        await rows.put(at, closed);
        return closed;
      });
    } catch (error) {
      return terminalRefusal(phase, error, "terminal-scope-retirement-unconfirmed");
    }
  }

  private async retirement(key: string, value: unknown, rows: Pick<NativeOperationRows, "get"> = this.storage) {
    const terminal = await this.frozen(key, value, rows);
    if (
      terminal?.state === "closed" &&
      nativeScopeClosed(
        await rows.get(nativeScopeKey(terminal.permit.target.scope.threadKey, terminal.permit.target.scope.owner)),
        terminal.permit.target.scope,
      )
    )
      return terminal;
    const owner = ownerOf(value);
    if (!owner || !isWorkspaceOwner(owner)) return;
    const split = key.lastIndexOf(`:${owner.runId}:`);
    if (split <= NATIVE_OPERATION_PREFIX.length) return;
    const threadKey = key.slice(NATIVE_OPERATION_PREFIX.length, split);
    const scoped = await rows.get<{
      scope: NativeScopeRef;
      cancellationId: string;
      records: Record<string, string>;
      originalOperationOutcome?: unknown;
      controllerOwnerGen?: unknown;
    }>(nativeScopeRetirementKey(threadKey, owner));
    if (scoped && scoped.records?.[key] === (await recordHash(value))) {
      const parsed = recordSchema.safeParse(value);
      const scope = nativeScopeRefSchema.safeParse(scoped.scope);
      const cancelled = await rows.get<{
        stopped?: unknown;
        cancellation?: { id?: unknown; runId?: unknown; ownerGen?: unknown; threadKey?: unknown };
      }>(`cancelled:${threadKey}:${owner.runId}`);
      if (
        scoped.originalOperationOutcome === "unknown" &&
        parsed.success &&
        scope.success &&
        nativeScopeClosed(await rows.get(nativeScopeKey(threadKey, owner)), scope.data) &&
        JSON.stringify(parsed.data.native.scope) === JSON.stringify(scope.data) &&
        scope.data.threadKey === threadKey &&
        JSON.stringify(scope.data.owner) === JSON.stringify(owner) &&
        cancelled?.stopped === true &&
        cancelled.cancellation?.id === scoped.cancellationId &&
        cancelled.cancellation.runId === owner.runId &&
        cancelled.cancellation.ownerGen === scoped.controllerOwnerGen &&
        typeof scoped.controllerOwnerGen === "string" &&
        cancelled.cancellation.threadKey === threadKey
      )
        return scoped;
    }
    const receipt = await rows.get<NativeRuntimeRetirement>(`${RETIREMENT_PREFIX}${threadKey}:${owner.runId}`);
    if (
      !receipt ||
      receipt.version !== 1 ||
      receipt.threadKey !== threadKey ||
      receipt.originalOperationOutcome !== "unknown" ||
      !isWorkspaceOwner(receipt.owner) ||
      receipt.owner.runId !== owner.runId ||
      receipt.owner.ownerGen !== owner.ownerGen ||
      receipt.owner.ownerFence !== owner.ownerFence ||
      typeof receipt.originalBoot !== "string" ||
      typeof receipt.currentBoot !== "string" ||
      !/^[A-Za-z0-9-]{1,64}$/.test(receipt.currentBoot) ||
      receipt.originalBoot === receipt.currentBoot
    )
      return;
    if (!receipt.records || receipt.records[key] !== (await recordHash(value))) return;
    const stopped = await rows.get<{
      stopped?: unknown;
      disposition?: unknown;
      retiredBoot?: unknown;
      cancellation?: { id?: unknown; runId?: unknown; ownerGen?: unknown; threadKey?: unknown };
      target?: { container?: unknown; ownerGen?: unknown; ownerFence?: unknown };
    }>(`cancelled:${threadKey}:${owner.runId}`);
    if (
      stopped?.stopped !== true ||
      stopped.disposition !== "runtime-retired" ||
      stopped.retiredBoot !== receipt.currentBoot ||
      stopped.cancellation?.id !== receipt.cancellationId ||
      stopped.cancellation.runId !== owner.runId ||
      stopped.cancellation.ownerGen !== owner.ownerGen ||
      stopped.cancellation.threadKey !== threadKey ||
      stopped.target?.container !== receipt.originalBoot ||
      stopped.target.ownerGen !== owner.ownerGen ||
      stopped.target.ownerFence !== owner.ownerFence
    )
      return;
    return receipt;
  }

  async fingerprints(
    prefix: string,
    rows: Pick<NativeOperationStorage, "list"> = this.storage,
  ): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    let cursor: string | undefined;
    for (;;) {
      const page = await rows.list<unknown>({
        prefix,
        limit: PAGE_SIZE,
        ...(cursor ? { startAfter: cursor } : {}),
      });
      if (!page.size) break;
      const next = [...page.keys()].at(-1)!;
      if (cursor !== undefined && next <= cursor) throw new Error("native operation inventory is incomplete");
      for (const [key, value] of page) hashes[key] = await recordHash(value);
      if (page.size < PAGE_SIZE) break;
      cursor = next;
    }
    return hashes;
  }

  /** Complete paging is required: retired entries cannot hide a later foreign operation. */
  async unresolved(
    prefix = NATIVE_OPERATION_PREFIX,
    rows: Pick<NativeOperationStorage, "get" | "list"> = this.storage,
  ): Promise<Map<string, unknown>> {
    const active = new Map<string, unknown>();
    let cursor: string | undefined;
    for (;;) {
      const page = await rows.list<unknown>({
        prefix,
        limit: PAGE_SIZE,
        ...(cursor ? { startAfter: cursor } : {}),
      });
      if (!page.size) break;
      const next = [...page.keys()].at(-1)!;
      if (cursor !== undefined && next <= cursor) throw new Error("native operation inventory is incomplete");
      for (const [key, value] of page) if (!(await this.retirement(key, value, rows))) active.set(key, value);
      if (page.size < PAGE_SIZE) break;
      cursor = next;
    }
    return active;
  }

  private async controls(key: string) {
    const rows = await this.storage.list<unknown>({ prefix: `${CONTROL_PREFIX}${key}:`, limit: ATTEMPT_LIMIT });
    return [...rows.values()]
      .map((value) => controlSchema.safeParse(value))
      .filter((value) => value.success)
      .map((value) => value.data);
  }

  async open(
    key: string,
    owner: WorkspaceOwner | { opOwner: string },
    threadKey?: string,
    origin?: NativeOperationOrigin,
  ): Promise<"admitted" | "producer-held"> {
    const record = {
      ...ownerOf(owner),
      ...(origin ? { origin: nativeOperationOriginSchema.parse(origin) } : {}),
      native: { version: 1 as const, closed: false, ...(threadKey ? { threadKey } : {}), pending: {} },
    };
    recordSchema.parse(record);
    const scopeId = crypto.randomUUID();
    const claim = origin ? await producerClaimKey(origin) : undefined;
    return this.storage.transaction(async (rows) => {
      if (
        (await rows.get(key)) !== undefined ||
        (await rows.get(RECEIPT_PREFIX + key)) !== undefined ||
        (await rows.get(OPERATOR_ENDING_PREFIX + key)) !== undefined
      )
        throw new Error("native operation identity already used");
      if (threadKey && isWorkspaceOwner(owner) && (await rows.get(`cancelled:${threadKey}:${owner.runId}`)))
        throw new Error("run cancelled");
      let held = false;
      if (origin && claim) {
        const active = await this.unresolved(NATIVE_OPERATION_PREFIX, rows);
        held =
          (await rows.get(claim)) !== undefined ||
          [...active.values()].some((value) => {
            const parsed = recordSchema.safeParse(value);
            const previous = parsed.success && "opOwner" in parsed.data ? parsed.data.origin : undefined;
            return (
              previous?.producer === origin.producer &&
              previous.resource === origin.resource &&
              previous.sourceId === origin.sourceId
            );
          });
      }
      if (claim && !held && "opOwner" in owner)
        await rows.put(claim, { key, opOwner: owner.opOwner, callId: origin!.callId });
      if (origin && "opOwner" in owner) await reserveNativeOperatorScope(rows, owner, scopeId);
      await rows.put(key, record);
      return held ? "producer-held" : "admitted";
    });
  }

  async bindScope(key: string, scope: NativeExecutionScopeRef): Promise<void> {
    await this.storage.transaction(async (rows) => {
      const original = await rows.get(key);
      const record = recordSchema.parse(original);
      if (await this.frozen(key, original, rows)) throw new Error("terminal retirement is prepared");
      const owned =
        "kind" in scope
          ? "opOwner" in record &&
            !!record.origin &&
            record.opOwner === scope.owner.opOwner &&
            key === `${NATIVE_OPERATION_PREFIX}${record.opOwner}`
          : isWorkspaceOwner(record) &&
            record.runId === scope.owner.runId &&
            record.ownerGen === scope.owner.ownerGen &&
            record.ownerFence === scope.owner.ownerFence &&
            record.native.threadKey === scope.threadKey;
      if (!owned || record.native.closed) throw new Error("native scope owner mismatch");
      if (record.native.scope && JSON.stringify(record.native.scope) !== JSON.stringify(scope))
        throw new Error("native scope identity changed");
      if (!record.native.scope && Object.keys(record.native.pending).length)
        throw new Error("legacy native submission cannot be adopted");
      record.native.scope = scope;
      await rows.put(key, record);
    });
  }

  private evidenceFits(record: NativeOperationRecord): void {
    const reservations = Object.values(record.native.pending).filter((attempt) => attempt.restore).length;
    if (
      new TextEncoder().encode(JSON.stringify(record)).byteLength +
        reservations * (RESTORE_RECEIPT_BYTES + 256) +
        4096 >
      TIMEOUT_RECEIPT_BYTES
    )
      throw new Error("native ending evidence capacity is unavailable");
  }

  private scopeOwnsRecord(key: string, record: NativeOperationRecord): boolean {
    const ref = record.native.scope;
    if (!ref) return false;
    return "opOwner" in record
      ? !!record.origin &&
          "kind" in ref &&
          key === `${NATIVE_OPERATION_PREFIX}${record.opOwner}` &&
          ref.owner.opOwner === record.opOwner
      : !("kind" in ref) &&
          ref.threadKey === record.native.threadKey &&
          workspaceOwnerKey(ref.owner) === workspaceOwnerKey(record);
  }

  private async workspaceAvailable(
    paths: readonly string[],
    purpose: "restore" | "mutation",
    rows: NativeOperationRows,
    selected?: { key: string; id: string },
  ): Promise<void> {
    for (const [key, value] of await this.unresolved(NATIVE_OPERATION_PREFIX, rows)) {
      const parsed = recordSchema.safeParse(value);
      if (!parsed.success || !(await this.archiveReceiptsMatch(key, parsed.data)))
        throw new Error("workspace outcome is unknown");
      if ("opOwner" in parsed.data && key !== selected?.key) {
        for (const [id, saved] of Object.entries(parsed.data.native.restoreReceipts ?? {})) {
          const held = [saved.receipt.identity.target, restorePrivateDirectory(id, saved.receipt.identity.ref.id)];
          if (paths.some((path) => held.some((other) => pathsOverlap(path, other))))
            throw new Error("workspace path has an unresolved restore");
        }
      }
      for (const [id, attempt] of Object.entries(parsed.data.native.pending)) {
        if (selected?.key === key && selected.id === id) continue;
        if (attempt.restore) {
          const held = [attempt.restore.target, restorePrivateDirectory(id, attempt.restore.ref.id)];
          if (paths.some((path) => held.some((other) => pathsOverlap(path, other))))
            throw new Error("workspace path has an unresolved restore");
        } else if (attempt.kind === "opaque") throw new Error("workspace outcome is unknown");
        if (
          purpose === "restore" &&
          attempt.mutationPaths &&
          paths.some((path) => attempt.mutationPaths!.some((other) => pathsOverlap(path, other)))
        )
          throw new Error("workspace path has an unresolved mutation");
      }
    }
  }

  async reserveArchive(key: string, id: string, input: RestoreIdentity): Promise<void> {
    const identity = restoreIdentitySchema.parse(input);
    const observed = (value: unknown) => {
      const parsed = recordSchema.safeParse(value);
      return (
        parsed.success &&
        this.scopeOwnsRecord(key, parsed.data) &&
        JSON.stringify(parsed.data.native.scope) === JSON.stringify(identity.ref) &&
        JSON.stringify(parsed.data.native.pending[id]?.restore) === JSON.stringify(identity)
      );
    };
    try {
      await this.storage.transaction(async (rows) => {
        const value = await rows.get(key);
        if (await this.retirement(key, value, rows)) throw new Error("original native runtime retired");
        const record = recordSchema.parse(value);
        if (
          !this.scopeOwnsRecord(key, record) ||
          !("opOwner" in record) ||
          record.native.closed ||
          id !== identity.attempt ||
          JSON.stringify(record.native.scope) !== JSON.stringify(identity.ref) ||
          record.native.pending[id]?.kind !== "opaque" ||
          record.native.pending[id].restore
        )
          throw new Error("original restore admission changed");
        await this.workspaceAvailable(
          [identity.target, restorePrivateDirectory(id, identity.ref.id)],
          "restore",
          rows,
          { key, id },
        );
        record.native.pending[id].restore = identity;
        this.evidenceFits(record);
        await rows.put(key, record);
      });
    } catch (error) {
      if (!observed(await this.storage.get(key).catch(() => undefined))) throw error;
    }
  }

  private async archiveReceiptsMatch(key: string, record: NativeOperationRecord): Promise<boolean> {
    if (!("opOwner" in record)) return true;
    for (const [id, saved] of Object.entries(record.native.restoreReceipts ?? {})) {
      if (
        !this.scopeOwnsRecord(key, record) ||
        saved.receipt.identity.attempt !== id ||
        JSON.stringify(saved.receipt.identity.ref) !== JSON.stringify(record.native.scope) ||
        saved.hash !== (await recordHash(saved.receipt))
      )
        return false;
    }
    return true;
  }

  async finishArchive(key: string, id: string, input: RestoreReceipt, expectedRecordHash?: string): Promise<void> {
    const receipt = restoreReceiptSchema.parse(input);
    const expected = { receipt, hash: await recordHash(receipt) };
    const observed = async (value: unknown) => {
      const parsed = recordSchema.safeParse(value);
      return (
        parsed.success &&
        "opOwner" in parsed.data &&
        this.scopeOwnsRecord(key, parsed.data) &&
        JSON.stringify(parsed.data.native.restoreReceipts?.[id]) === JSON.stringify(expected) &&
        !parsed.data.native.pending[id] &&
        (await this.archiveReceiptsMatch(key, parsed.data))
      );
    };
    try {
      await this.storage.transaction(async (rows) => {
        const value = await rows.get(key);
        if (value === undefined) {
          const ending = await rows.get<{ original?: unknown }>(OPERATOR_ENDING_PREFIX + key);
          if (
            (await observed(ending?.original)) &&
            (await this.operatorEnded(key, receipt.identity.ref.owner, undefined, rows))
          )
            return;
          throw new Error("original restore receipt changed");
        }
        if (await this.retirement(key, value, rows)) throw new Error("original native runtime retired");
        if (expectedRecordHash !== undefined && (await recordHash(value)) !== expectedRecordHash)
          throw new Error("original restore recovery record changed");
        const record = recordSchema.parse(value);
        if (
          !("opOwner" in record) ||
          !this.scopeOwnsRecord(key, record) ||
          id !== receipt.identity.attempt ||
          JSON.stringify(record.native.scope) !== JSON.stringify(receipt.identity.ref)
        )
          throw new Error("original restore receipt changed");
        const pending = record.native.pending[id];
        if (!pending) {
          if (await observed(value)) return;
          throw new Error("original restore receipt changed");
        }
        if (!pending.restore || !sameRestoreIdentity(pending.restore, receipt.identity))
          throw new Error("original restore receipt changed");
        record.native.restoreReceipts = { ...record.native.restoreReceipts, [id]: expected };
        delete record.native.pending[id];
        this.evidenceFits(record);
        await rows.put(key, record);
      });
    } catch (error) {
      if (await observed(await this.storage.get(key).catch(() => undefined))) return;
      const ending = await this.storage
        .get<{ original?: unknown }>(OPERATOR_ENDING_PREFIX + key)
        .catch(() => undefined);
      if (
        (await observed(ending?.original)) &&
        (await this.operatorEnded(key, receipt.identity.ref.owner).catch(() => false))
      )
        return;
      throw error;
    }
  }

  async begin(key: string, kind: "process" | "opaque", mutationInput?: readonly string[]): Promise<string> {
    const id = crypto.randomUUID();
    const mutationPaths = mutationInput === undefined ? undefined : workspaceMutationPathsSchema.parse(mutationInput);
    if (mutationPaths && kind !== "process") throw new Error("workspace mutation requires a process");
    const expectedAttempt = { kind, ...(mutationPaths ? { mutationPaths } : {}) };
    try {
      await this.storage.transaction(async (rows) => {
        const value = await rows.get(key);
        if (await this.retirement(key, value, rows)) throw new Error("original native runtime retired");
        const record = recordSchema.parse(value);
        if (await this.frozen(key, value, rows)) throw new Error("terminal retirement is prepared");
        if (
          "opOwner" in record &&
          record.origin &&
          nativeOperatorScopeClosing(await rows.get(nativeOperatorScopeKey({ opOwner: record.opOwner })), {
            opOwner: record.opOwner,
          })
        )
          throw new Error("operator scope is closed");
        if (record.native.closed) throw new Error("native operation already closed");
        if (Object.keys(record.native.pending).length >= ATTEMPT_LIMIT)
          throw new Error("too many pending native attempts");
        if (mutationPaths) {
          if (!this.scopeOwnsRecord(key, record)) throw new Error("workspace mutation requires its original scope");
          await this.workspaceAvailable(mutationPaths, "mutation", rows, { key, id });
        }
        record.native.pending[id] = expectedAttempt;
        this.evidenceFits(record);
        await rows.put(key, record);
      });
    } catch (error) {
      // An uncertain write is not a new admission. Read only this locally
      // retained ID; the caller still checks scope closure before submission.
      const value = await this.storage.get(key);
      if (await this.retirement(key, value)) throw error;
      const saved = recordSchema.safeParse(value);
      const attempt = saved.success ? saved.data.native.pending[id] : undefined;
      if (!attempt || JSON.stringify(attempt) !== JSON.stringify(expectedAttempt)) throw error;
    }
    return id;
  }

  async launched(key: string, id: string, status: unknown): Promise<void> {
    const process = processIdentity.parse(status);
    try {
      await this.storage.transaction(async (rows) => {
        const value = await rows.get(key);
        if (await this.retirement(key, value, rows)) throw new Error("original native runtime retired");
        const record = recordSchema.parse(value);
        if (await this.frozen(key, value, rows)) throw new Error("terminal retirement is prepared");
        const attempt = record.native.pending[id];
        if (!attempt || attempt.kind !== "process" || attempt.process)
          throw new Error("native launch identity changed");
        attempt.process = process;
        await rows.put(key, record);
      });
    } catch (error) {
      // Qualify a committed original tuple without repeating native work or
      // overwriting identity. Missing or unreadable evidence remains unknown.
      const value = await this.storage.get(key);
      if (await this.retirement(key, value)) throw error;
      const saved = recordSchema.safeParse(value);
      const attempt = saved.success ? saved.data.native.pending[id] : undefined;
      const original = attempt?.kind === "process" ? attempt.process : undefined;
      if (
        !original ||
        original.id !== process.id ||
        original.pid !== process.pid ||
        original.startedAt !== process.startedAt
      )
        throw error;
    }
  }

  async settle(key: string, id: string, nativeEnding?: NativeTimeoutEnding): Promise<void> {
    const ending = nativeEnding === undefined ? undefined : nativeTimeoutEndingSchema.parse(nativeEnding);
    if (ending && ending.attempt !== id) throw new Error("native timeout attempt changed");
    let expected: { original: unknown; receipt: TimeoutEndingReceipt } | undefined;
    let settledOperator: NativeOperationRecord | undefined;
    const observed = async () => {
      const archive = await this.storage.get(RECEIPT_PREFIX + key);
      const saved = await timeoutArchiveOf(archive, key);
      if (
        !ending ||
        !saved ||
        JSON.stringify(saved.receipt.nativeEnding) !== JSON.stringify(ending) ||
        (expected && JSON.stringify(archive) !== JSON.stringify(expected))
      )
        return false;
      const current = await this.storage.get(key);
      if (current === undefined) return true;
      const parsed = recordSchema.safeParse(current);
      return (
        parsed.success &&
        ("kind" in ending.ref
          ? "opOwner" in parsed.data && parsed.data.opOwner === ending.ref.owner.opOwner
          : isWorkspaceOwner(parsed.data) &&
            workspaceOwnerKey(parsed.data) === workspaceOwnerKey(ending.ref.owner) &&
            parsed.data.native.threadKey === ending.ref.threadKey) &&
        JSON.stringify(parsed.data.native.scope) === JSON.stringify(ending.ref) &&
        !Object.hasOwn(parsed.data.native.pending, id)
      );
    };
    try {
      await this.storage.transaction(async (rows) => {
        const value = await rows.get(key);
        // Recovery may already have archived the same observed terminal process.
        if (value === undefined && (await rows.get(RECEIPT_PREFIX + key)) !== undefined) {
          if (ending) throw new Error("native timeout receipt needs readback");
          return;
        }
        if (await this.retirement(key, value, rows)) {
          if (ending) throw new Error("native timeout operation is retired");
          return;
        }
        const record = recordSchema.parse(value);
        if (record.native.pending[id]?.restore) throw new Error("restore cleanup receipt is required");
        if (await this.frozen(key, value, rows)) {
          if (ending) throw new Error("native timeout operation is retired");
          return;
        }
        if (ending) {
          if (!timeoutOwnsAttempt(key, record, ending)) throw new Error("native timeout admission changed");
          if ((await rows.get(RECEIPT_PREFIX + key)) !== undefined)
            throw new Error("native timeout receipt already exists");
          expected = {
            original: value,
            receipt: {
              key,
              recordHash: await recordHash(value),
              outcome: "native-ended",
              purpose: "native-timeout-ending",
              originalOperationOutcome: "unknown",
              nativeEnding: ending,
              processes: [],
            },
          };
          if (new TextEncoder().encode(JSON.stringify(expected)).byteLength > TIMEOUT_RECEIPT_BYTES)
            throw new Error("native timeout receipt is too large");
          await rows.put(RECEIPT_PREFIX + key, expected);
        }
        delete record.native.pending[id];
        if ("opOwner" in record && record.origin) settledOperator = record;
        if (
          record.native.closed &&
          Object.keys(record.native.pending).length === 0 &&
          !("opOwner" in record && record.origin)
        )
          await rows.delete(key);
        else await rows.put(key, record);
      });
    } catch (error) {
      // Qualify only this original committed receipt; never repeat native work or the write.
      if (ending) {
        try {
          if (await observed()) return;
        } catch {
          /* An unreadable acknowledgment stays unknown. */
        }
      }
      if (!ending && settledOperator) {
        const saved = recordSchema.safeParse(await this.storage.get(key).catch(() => undefined));
        if (saved.success && JSON.stringify(saved.data) === JSON.stringify(settledOperator)) return;
      }
      throw error;
    }
  }

  async close(key: string): Promise<void> {
    let expected: NativeOperationRecord | undefined;
    try {
      await this.storage.transaction(async (rows) => {
        const value = await rows.get(key);
        if (value === undefined) return;
        if (await this.retirement(key, value, rows)) return;
        const record = recordSchema.parse(value);
        if (await this.frozen(key, value, rows)) return;
        record.native.closed = true;
        if ("opOwner" in record && record.origin) expected = record;
        if (Object.keys(record.native.pending).length === 0 && !("opOwner" in record && record.origin))
          await rows.delete(key);
        else await rows.put(key, record);
      });
    } catch (error) {
      if (expected && JSON.stringify(await this.storage.get(key).catch(() => undefined)) === JSON.stringify(expected))
        return;
      throw error;
    }
  }

  /** Ordinary operator closure never credits its unknown payload or opaque effects. */
  async endOperator(
    key: string,
    owner: NativeOperatorOwner,
    callback: "returned" | "threw" | "unknown",
    expectedRecordHash?: string,
    requestRecordHash?: string,
  ): Promise<boolean> {
    let expected: unknown;
    try {
      return await this.storage.transaction(async (rows) => {
        const original = await rows.get(key);
        if (original === undefined) return this.operatorEnded(key, owner, undefined, rows);
        const record = recordSchema.parse(original);
        if (expectedRecordHash !== undefined && (await recordHash(original)) !== expectedRecordHash) return false;
        if (
          !("opOwner" in record) ||
          record.opOwner !== owner.opOwner ||
          !record.origin ||
          key !== `${NATIVE_OPERATION_PREFIX}${owner.opOwner}`
        )
          throw new Error("operator ending owner changed");
        if (!(await this.archiveReceiptsMatch(key, record))) return false;
        const ending = nativeOperatorScopeEnding(await rows.get(nativeOperatorScopeKey(owner)), owner);
        if (
          !ending ||
          (record.native.scope
            ? JSON.stringify(record.native.scope) !== JSON.stringify(ending.ref)
            : Object.keys(record.native.pending).length !== 0) ||
          (ending.ref === null && Object.keys(record.native.pending).length !== 0)
        )
          return false;
        if (Object.values(record.native.pending).some((attempt) => attempt.kind === "opaque")) {
          await rows.put(key, { ...record, native: { ...record.native, closed: true } });
          return false;
        }
        const receipt = {
          key,
          recordHash: await recordHash(original),
          ...(requestRecordHash === undefined ? {} : { requestRecordHash }),
          purpose: "operator-scope-ending",
          owner,
          scopeId: ending.id,
          scope: ending.ref,
          callback,
          originalOperationOutcome: "unknown",
        };
        expected = { original, receipt };
        if (new TextEncoder().encode(JSON.stringify(expected)).byteLength > TIMEOUT_RECEIPT_BYTES)
          throw new Error("operator ending receipt is too large");
        if ((await rows.get(OPERATOR_ENDING_PREFIX + key)) !== undefined)
          throw new Error("operator ending identity used");
        await rows.put(OPERATOR_ENDING_PREFIX + key, expected);
        const claim = await producerClaimKey(record.origin);
        if (claim && Object.keys(record.native.pending).length === 0) {
          const originalClaim = await rows.get(claim);
          if (
            JSON.stringify(originalClaim) ===
            JSON.stringify({ key, opOwner: owner.opOwner, callId: record.origin.callId })
          )
            await rows.delete(claim);
        }
        await rows.delete(key);
        return true;
      });
    } catch {
      const saved = await this.storage.get(OPERATOR_ENDING_PREFIX + key).catch(() => undefined);
      return (
        expected !== undefined &&
        JSON.stringify(saved) === JSON.stringify(expected) &&
        (await this.operatorEnded(key, owner).catch(() => false))
      );
    }
  }

  async operatorEnded(
    key: string,
    owner: NativeOperatorOwner,
    callId?: string,
    rows: Pick<NativeOperationRows, "get"> = this.storage,
  ): Promise<boolean> {
    if (key !== `${NATIVE_OPERATION_PREFIX}${owner.opOwner}` || (await rows.get(key)) !== undefined) return false;
    const archive = await rows.get<{ original?: unknown; receipt?: Record<string, unknown> }>(
      OPERATOR_ENDING_PREFIX + key,
    );
    const original = recordSchema.safeParse(archive?.original),
      receipt = archive?.receipt;
    if (
      !original.success ||
      !("opOwner" in original.data) ||
      original.data.opOwner !== owner.opOwner ||
      !original.data.origin ||
      (callId !== undefined && original.data.origin.callId !== callId) ||
      !receipt ||
      receipt.key !== key ||
      receipt.purpose !== "operator-scope-ending" ||
      (receipt.requestRecordHash !== undefined && !/^[a-f0-9]{64}$/.test(String(receipt.requestRecordHash))) ||
      receipt.originalOperationOutcome !== "unknown" ||
      !["returned", "threw", "unknown"].includes(String(receipt.callback)) ||
      JSON.stringify(receipt.owner) !== JSON.stringify(owner) ||
      receipt.recordHash !== (await recordHash(archive!.original)) ||
      Object.values(original.data.native.pending).some((attempt) => attempt.kind === "opaque")
    )
      return false;
    if (!(await this.archiveReceiptsMatch(key, original.data))) return false;
    const ending = nativeOperatorScopeEnding(await rows.get(nativeOperatorScopeKey(owner)), owner);
    return (
      !!ending &&
      receipt.scopeId === ending.id &&
      JSON.stringify(receipt.scope) === JSON.stringify(ending.ref) &&
      (original.data.native.scope
        ? JSON.stringify(original.data.native.scope) === JSON.stringify(ending.ref)
        : Object.keys(original.data.native.pending).length === 0)
    );
  }

  /** Enroll the original permit before any callback or native work. */
  async enrollOperatorAdmission(
    opOwner: string,
    origin: NativeOperationOrigin,
    permit: OperatorAdmission["permit"],
  ): Promise<void> {
    const value = operatorAdmissionSchema.parse({ opOwner, origin, permit, callbackMetadataEnded: false });
    const key = ADMISSION_PREFIX + opOwner;
    await this.storage.transaction(async (rows) => {
      if (
        (await rows.get(key)) !== undefined ||
        (await rows.get(NATIVE_OPERATION_PREFIX + opOwner)) !== undefined ||
        (await rows.get(OPERATOR_ENDING_PREFIX + NATIVE_OPERATION_PREFIX + opOwner)) !== undefined
      )
        throw new Error("operator admission identity already used");
      await rows.put(key, value);
    });
  }

  /** This proves callback handling and metadata completion, not response delivery. */
  async endOperatorCallback(opOwner: string, callId: string, permit: OperatorAdmission["permit"]): Promise<boolean> {
    return this.storage.transaction(async (rows) => {
      const key = ADMISSION_PREFIX + opOwner;
      const parsed = operatorAdmissionSchema.safeParse(await rows.get(key));
      if (
        !parsed.success ||
        parsed.data.opOwner !== opOwner ||
        parsed.data.origin.callId !== callId ||
        JSON.stringify(parsed.data.permit) !== JSON.stringify(permit)
      )
        return false;
      const operationKey = NATIVE_OPERATION_PREFIX + opOwner;
      const original =
        (await rows.get(operationKey)) ??
        (await rows.get<{ original?: unknown }>(OPERATOR_ENDING_PREFIX + operationKey))?.original;
      const record = recordSchema.safeParse(original);
      if (
        !record.success ||
        !("opOwner" in record.data) ||
        record.data.opOwner !== opOwner ||
        !record.data.native.closed ||
        JSON.stringify(record.data.origin) !== JSON.stringify(parsed.data.origin)
      )
        return false;
      await rows.put(key, { ...parsed.data, callbackMetadataEnded: true });
      return true;
    });
  }

  /** Permit obligations survive native retirement and controller replacement. */
  async producerAdmissions(
    origin: NativeOperationOrigin,
    selectOwner: (opOwner: string) => boolean,
  ): Promise<OperatorAdmission[]> {
    const selected: OperatorAdmission[] = [];
    for (const [key, value] of await this.unresolved(ADMISSION_PREFIX)) {
      const row = operatorAdmissionSchema.parse(value);
      if (key !== ADMISSION_PREFIX + row.opOwner) throw new Error("operator admission owner changed");
      if (
        row.origin.producer === origin.producer &&
        row.origin.resource === origin.resource &&
        selectOwner(row.opOwner)
      )
        selected.push(row);
    }
    return selected;
  }

  async operatorAdmissionReady(
    value: OperatorAdmission,
    rows: Pick<NativeOperationRows, "get"> = this.storage,
  ): Promise<boolean> {
    const archived = await rows.get<{ original?: unknown }>(
      OPERATOR_ENDING_PREFIX + NATIVE_OPERATION_PREFIX + value.opOwner,
    );
    const record = recordSchema.safeParse(archived?.original);
    return (
      value.callbackMetadataEnded &&
      record.success &&
      "opOwner" in record.data &&
      record.data.opOwner === value.opOwner &&
      JSON.stringify(record.data.origin) === JSON.stringify(value.origin) &&
      JSON.stringify(await rows.get(ADMISSION_PREFIX + value.opOwner)) === JSON.stringify(value) &&
      (await this.operatorEnded(
        NATIVE_OPERATION_PREFIX + value.opOwner,
        { opOwner: value.opOwner },
        value.origin.callId,
        rows,
      ))
    );
  }

  /** A bounded operator view, independent of payload and native-scope success. */
  async admissionRecovery(selectOwner: (opOwner: string) => boolean) {
    const records = [];
    let count = 0;
    for (const [key, value] of await this.unresolved(ADMISSION_PREFIX)) {
      const row = operatorAdmissionSchema.parse(value);
      if (key !== ADMISSION_PREFIX + row.opOwner) throw new Error("operator admission owner changed");
      if (!selectOwner(row.opOwner)) continue;
      count++;
      if (records.length >= PAGE_SIZE) continue;
      const stage = !row.callbackMetadataEnded
        ? "callback-ending-unverified"
        : (await this.operatorEnded(NATIVE_OPERATION_PREFIX + row.opOwner, { opOwner: row.opOwner }, row.origin.callId))
          ? "registry-release-pending"
          : "native-ending-unverified";
      records.push({
        id: row.permit.id,
        opOwner: row.opOwner,
        callId: row.origin.callId,
        producer: row.origin.producer,
        sourceId: row.origin.sourceId,
        stage,
        recovery: row.callbackMetadataEnded ? "producer-finalization" : "operator-request-end-receipt",
      });
    }
    return { count, omitted: count - records.length, records };
  }

  /** Called only after the exact Registry release acknowledgement or receipt. */
  async completeOperatorAdmission(value: OperatorAdmission): Promise<void> {
    await this.storage.transaction(async (rows) => {
      const key = ADMISSION_PREFIX + value.opOwner;
      const original = await rows.get(key);
      if (original === undefined) return;
      if (JSON.stringify(original) !== JSON.stringify(value) || !(await this.operatorAdmissionReady(value, rows)))
        throw new Error("operator admission ending changed");
      await rows.delete(key);
    });
  }

  /** Resume cleanup at the existing producer boundary, without invoking its payload. */
  async resumeProducerFinalization(
    origin: NativeOperationOrigin,
    native: NativeScopeTransport,
    ownerMatches: (record: NativeOperationRecord) => Promise<boolean>,
  ): Promise<{ key?: string; opOwner?: string; outcome: "held" | "ended" } | undefined> {
    const canResume = async (record: NativeOperationRecord) =>
      "opOwner" in record &&
      record.native.closed &&
      Object.keys(record.native.pending).length === 0 &&
      nativeOperatorScopeClosing(
        await this.storage.get(nativeOperatorScopeKey({ opOwner: record.opOwner })),
        { opOwner: record.opOwner },
        record.native.scope ?? null,
      );
    let claimKey = await producerClaimKey(origin);
    let selected: { key: string; opOwner: string; outcome: "held" } | undefined;
    // An unchanged checkout can skip build. Any later refresh step must be
    // able to finish saved cleanup before that step's payload starts.
    if (origin.producer === "refresh-step") {
      for (const [key, value] of await this.unresolved()) {
        const parsed = recordSchema.safeParse(value);
        if (!parsed.success || !("opOwner" in parsed.data)) continue;
        const previous = parsed.data;
        if (
          previous.origin?.producer !== origin.producer ||
          previous.origin.resource !== origin.resource ||
          !(await canResume(previous))
        )
          continue;
        claimKey = await producerClaimKey(previous.origin);
        selected = { key, opOwner: previous.opOwner, outcome: "held" };
        break;
      }
    }
    if (!claimKey) return;
    const value = await this.storage.get(claimKey);
    if (value === undefined) return selected;
    const parsedClaim = z
      .object({ key: z.string(), opOwner: z.string(), callId: z.string().uuid() })
      .strict()
      .safeParse(value);
    if (!parsedClaim.success) return { outcome: "held" };
    const claim = parsedClaim.data;
    if (selected && (selected.key !== claim.key || selected.opOwner !== claim.opOwner)) return selected;
    const held = { key: claim.key, opOwner: claim.opOwner, outcome: "held" as const };
    const original = await this.storage.get(claim.key);
    const parsed = recordSchema.safeParse(original);
    if (!parsed.success || !("opOwner" in parsed.data)) return held;
    const record = parsed.data;
    if (
      record.opOwner !== claim.opOwner ||
      claim.key !== `${NATIVE_OPERATION_PREFIX}${record.opOwner}` ||
      !record.origin ||
      record.origin.callId !== claim.callId ||
      (await producerClaimKey(record.origin)) !== claimKey ||
      !(await canResume(record))
    )
      return held;
    const matches = async (current: NativeOperationRecord) =>
      JSON.stringify(await this.storage.get(claimKey)) === JSON.stringify(claim) && (await ownerMatches(current));
    if (!(await matches(record))) return held;
    const result = await this.recoverOperator(claim.key, await recordHash(original), native, matches, true);
    if (!result || !("outcome" in result) || result.outcome !== "operator-scope-ended") return held;
    return { key: claim.key, opOwner: claim.opOwner, outcome: "ended" };
  }

  /** Admin recovery and saved producer finalization share exact-scope retirement. */
  async recoverOperator(
    key: string,
    hash: string,
    native: NativeScopeTransport,
    ownerMatches: (record: NativeOperationRecord) => Promise<boolean>,
    terminate: boolean,
  ) {
    const original = await this.storage.get(key);
    if (original === undefined) {
      const saved = await this.storage.get<{ original?: unknown; receipt?: Record<string, unknown> }>(
        OPERATOR_ENDING_PREFIX + key,
      );
      const parsed = recordSchema.safeParse(saved?.original);
      if (
        parsed.success &&
        "opOwner" in parsed.data &&
        (saved?.receipt?.requestRecordHash ?? saved?.receipt?.recordHash) === hash &&
        (await ownerMatches(parsed.data)) &&
        (await this.operatorEnded(key, { opOwner: parsed.data.opOwner }))
      )
        return {
          key,
          recordHash: hash,
          outcome: "operator-scope-ended" as const,
          originalOperationOutcome: "unknown" as const,
          requestEnd: "unobserved" as const,
        };
      return;
    }
    const parsed = recordSchema.safeParse(original);
    if (!parsed.success || !("opOwner" in parsed.data) || !parsed.data.origin) return;
    const record = parsed.data;
    if (
      key !== `${NATIVE_OPERATION_PREFIX}${record.opOwner}` ||
      hash !== (await recordHash(original)) ||
      !(await ownerMatches(record))
    )
      return refuse("record-or-owner-changed");
    const owner = { opOwner: record.opOwner };
    const row = await this.storage.get(nativeOperatorScopeKey(owner));
    let ending = nativeOperatorScopeEnding(row, owner);
    if (!ending) {
      if (!terminate) return refuse("explicit-operator-scope-closure-required");
      // A missing original reservation never creates a new scope during recovery.
      if (row === undefined) return refuse("original-operator-scope-unavailable");
      const expected = record.native.scope;
      if (expected && !("kind" in expected)) return refuse("operator-scope-owner-changed");
      await new NativeRunScopes(this.storage, native).closeOperator(owner, expected);
      ending = nativeOperatorScopeEnding(await this.storage.get(nativeOperatorScopeKey(owner)), owner);
    }
    if (!ending || !(await ownerMatches(record))) return refuse("operator-scope-closure-unconfirmed");
    let expected = original;
    for (const [id, pending] of Object.entries(record.native.pending)) {
      if (!pending.restore) continue;
      const identity = pending.restore;
      if (JSON.stringify(identity.ref) !== JSON.stringify(ending.ref)) return refuse("original-archive-scope-changed");
      const request = { ref: identity.ref, attempt: id, identity };
      let receipt: RestoreReceipt | undefined;
      try {
        const saved = restoreSnapshotSchema.parse(
          archiveControlAnswer(await native.request({ mode: "archive-read", ...request }, 2000)),
        );
        if (saved.receipt && sameRestoreIdentity(saved.receipt.identity, identity)) receipt = saved.receipt;
      } catch {
        /* Missing original readback grants no replay. */
      }
      if (!receipt) {
        if (!terminate) return refuse("explicit-original-archive-cleanup-required");
        try {
          const saved = restoreSnapshotSchema.parse(
            archiveControlAnswer(await native.request({ mode: "archive-clean", ...request }, 2000)),
          );
          if (saved.receipt && sameRestoreIdentity(saved.receipt.identity, identity)) receipt = saved.receipt;
        } catch {
          /* The original effect stays held. */
        }
      }
      if (!receipt) return refuse("original-archive-cleanup-unconfirmed");
      if (!(await ownerMatches(record))) return refuse("record-or-owner-changed");
      await this.finishArchive(key, id, receipt, await recordHash(expected));
      const next = structuredClone(recordSchema.parse(expected));
      if (!("opOwner" in next)) return refuse("record-or-owner-changed");
      next.native.restoreReceipts = {
        ...next.native.restoreReceipts,
        [id]: {
          receipt: restoreReceiptSchema.parse(receipt),
          hash: await recordHash(restoreReceiptSchema.parse(receipt)),
        },
      };
      delete next.native.pending[id];
      expected = next;
    }
    if (
      !(await this.endOperator(
        key,
        owner,
        "unknown",
        await recordHash(expected),
        expected === original ? undefined : hash,
      ))
    )
      return refuse("operator-ending-held-or-changed");
    return {
      key,
      recordHash: hash,
      outcome: "operator-scope-ended" as const,
      originalOperationOutcome: "unknown" as const,
      requestEnd: "unobserved" as const,
    };
  }

  async list(cursor?: string) {
    const rows = await this.storage.list<unknown>({
      prefix: NATIVE_OPERATION_PREFIX,
      limit: PAGE_SIZE + 1,
      ...(cursor ? { startAfter: cursor } : {}),
    });
    const page = [...rows].slice(0, PAGE_SIZE);
    const operations = await Promise.all(
      page.map(async ([key, value]) => {
        const parsed = recordSchema.safeParse(value);
        const hash = await recordHash(value);
        const retirement = await this.retirement(key, value);
        return {
          key,
          recordHash: hash,
          owner: ownerOf(value),
          recoverable: !retirement && parsed.success && recoverable(parsed.data),
          recoveryReason: retirement
            ? "original-runtime-retired"
            : !parsed.success
              ? "legacy-or-invalid-record"
              : !recoverable(parsed.data)
                ? "original-native-evidence-unavailable"
                : "original-process-result-required",
          controls: await this.controls(key),
          journal: parsed.success ? parsed.data.native : null,
          ...(parsed.success && "opOwner" in parsed.data && parsed.data.origin ? { origin: parsed.data.origin } : {}),
          ...(retirement ? { retirement } : {}),
        };
      }),
    );
    return { operations, cursor: rows.size > PAGE_SIZE ? page.at(-1)![0] : null };
  }

  /** Read a stored ending only; never look up or signal a native process. */
  async readEnding(key: string, rows: Pick<NativeOperationRows, "get"> = this.storage): Promise<NativeEndingRead> {
    if (!validNativeOperationKey(key)) return { kind: "unavailable" };
    const archived = await rows.get<unknown>(RECEIPT_PREFIX + key);
    if (archived === undefined) return { kind: "missing" };
    const timeout = await timeoutArchiveOf(archived, key);
    if (timeout) return (await rows.get(key)) === undefined ? { kind: "ended", ...timeout } : { kind: "unavailable" };
    if (!archived || typeof archived !== "object" || Array.isArray(archived)) return { kind: "unavailable" };
    const value = archived as { original?: unknown; receipt?: unknown };
    const original = recordSchema.safeParse(value.original);
    const saved = z
      .object({
        key: z.string(),
        recordHash: z.string().regex(/^[a-f0-9]{64}$/),
        outcome: z.literal("native-ended"),
        processes: z.array(terminalSchema).max(ATTEMPT_LIMIT),
      })
      .strict()
      .safeParse(value.receipt);
    if (
      !original.success ||
      !recoverable(original.data) ||
      !saved.success ||
      saved.data.key !== key ||
      saved.data.recordHash !== (await recordHash(value.original))
    )
      return { kind: "unavailable" };
    const attempts = Object.values(original.data.native.pending);
    if (
      saved.data.processes.length !== attempts.length ||
      attempts.some((attempt, i) => {
        const terminal = saved.data.processes[i]!;
        return (
          terminal.id !== attempt.process!.id ||
          terminal.pid !== attempt.process!.pid ||
          terminal.startedAt !== attempt.process!.startedAt ||
          Date.parse(terminal.endedAt) < Date.parse(terminal.startedAt)
        );
      })
    )
      return { kind: "unavailable" };
    return { kind: "ended", original: original.data, receipt: saved.data };
  }

  async recover(
    key: string,
    expectedHash: string,
    lookup: (identity: NativeProcessIdentity) => Promise<unknown>,
    ownerMatches: (rows: NativeOperationRows, record: NativeOperationRecord) => Promise<boolean>,
    terminate?: (identity: NativeProcessIdentity) => Promise<void>,
  ): Promise<NativeOperationReceipt | Refusal> {
    const value = await this.storage.get<unknown>(key);
    if (value === undefined) {
      const saved = await this.readEnding(key);
      if (saved.kind === "ended" && saved.receipt.recordHash === expectedHash) return saved.receipt;
      const controls = (await this.controls(key)).filter((control) => control.recordHash === expectedHash);
      return { ...refuse("record-missing-or-changed"), ...(controls.length ? { controls } : {}) };
    }
    if ((await recordHash(value)) !== expectedHash) return refuse("record-changed");
    if ((await this.storage.get(RECEIPT_PREFIX + key)) !== undefined) return refuse("native-ending-receipt-exists");
    if ((await this.frozen(key, value))?.state === "prepared") return refuse("terminal-retirement-prepared");
    if (await this.retirement(key, value)) return refuse("original-runtime-retired; historical effects unknown");
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success || !recoverable(parsed.data)) return refuse("original-native-evidence-unavailable");
    const processes: NativeTerminal[] = [];
    try {
      for (const attempt of Object.values(parsed.data.native.pending)) {
        const identity = attempt.process!;
        let observed = await lookup(identity);
        const live = processIdentity.safeParse(observed);
        if (terminate && (observed as { state?: unknown } | null)?.state === "running") {
          if (
            !live.success ||
            live.data.id !== identity.id ||
            live.data.pid !== identity.pid ||
            live.data.startedAt !== identity.startedAt
          )
            return refuse("original-process-identity-changed");
          const controlKey = `${CONTROL_PREFIX}${key}:${identity.id}`;
          const admitted = await this.storage.transaction(async (rows) => {
            const current = await rows.get(key);
            if ((await this.frozen(key, current, rows))?.state === "prepared")
              return refuse("terminal-retirement-prepared");
            if (await this.retirement(key, current, rows))
              return refuse("original-runtime-retired; historical effects unknown");
            if (
              current === undefined ||
              (await recordHash(current)) !== expectedHash ||
              !(await ownerMatches(rows, parsed.data))
            )
              return refuse("record-or-owner-changed");
            if ((await rows.get(controlKey)) !== undefined)
              return refuse("termination-already-requested; observe the original process before recovery");
            await rows.put(controlKey, { process: identity, recordHash: expectedHash, outcome: "requested" });
            return null;
          });
          if (admitted) return admitted;
          const saveControl = async (control: z.infer<typeof controlSchema>) =>
            this.storage.transaction(async (rows) => {
              const current = await rows.get(key);
              if ((await this.frozen(key, current, rows))?.state === "prepared")
                return refuse("terminal-retirement-prepared");
              if (await this.retirement(key, current, rows))
                return refuse("original-runtime-retired; historical effects unknown");
              if (
                current === undefined ||
                (await recordHash(current)) !== expectedHash ||
                !(await ownerMatches(rows, parsed.data))
              )
                return refuse("record-or-owner-changed");
              await rows.put(controlKey, control);
              return null;
            });
          try {
            await terminate(identity);
            const held = await saveControl({
              process: identity,
              recordHash: expectedHash,
              outcome: "kill-acknowledged",
            });
            if (held) return held;
          } catch (error) {
            const details = errorDetails(error);
            const held = await saveControl({
              process: identity,
              recordHash: expectedHash,
              outcome: "kill-unverified",
              failure: details,
            });
            if (held) return held;
            return { error: "native-operation-recovery-refused: termination-outcome-unverified", status: 503, details };
          }
          observed = await lookup(identity);
        }
        const result = terminalSchema.safeParse(observed);
        if (
          !result.success ||
          result.data.id !== identity.id ||
          result.data.pid !== identity.pid ||
          result.data.startedAt !== identity.startedAt ||
          Date.parse(result.data.endedAt) < Date.parse(identity.startedAt)
        )
          return refuse("original-process-not-confirmed-ended");
        processes.push(result.data);
      }
    } catch (error) {
      return {
        error: "native-operation-recovery-refused: native-evidence-unreadable",
        status: 503,
        details: errorDetails(error),
      };
    }
    return this.storage.transaction(async (rows) => {
      const current = await rows.get<unknown>(key);
      if ((await this.frozen(key, current, rows))?.state === "prepared") return refuse("terminal-retirement-prepared");
      if (await this.retirement(key, current, rows))
        return refuse("original-runtime-retired; historical effects unknown");
      if (
        current === undefined ||
        (await recordHash(current)) !== expectedHash ||
        !(await ownerMatches(rows, parsed.data))
      )
        return refuse("record-or-owner-changed");
      const receipt: NativeOperationReceipt = { key, recordHash: expectedHash, outcome: "native-ended", processes };
      if ((await rows.get(RECEIPT_PREFIX + key)) !== undefined) return refuse("native-ending-receipt-exists");
      // Archive and release are one commit. The original record remains evidence,
      // but the receipt prefix cannot contribute to the unresolved-operation guard.
      await rows.put(RECEIPT_PREFIX + key, { original: current, receipt });
      await rows.delete(key);
      return receipt;
    });
  }
}
