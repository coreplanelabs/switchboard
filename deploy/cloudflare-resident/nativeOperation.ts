import { z } from "zod";
import { isWorkspaceOwner, type WorkspaceOwner } from "../../src/core/workspaceSettlement.js";
import {
  nativeScopeRefSchema,
  nativeScopeClosed,
  nativeScopeKey,
  nativeScopeRetirementKey,
  type NativeScopeRef,
} from "./nativeScope.js";

export const NATIVE_OPERATION_PREFIX = "native-operation:";
const RECEIPT_PREFIX = "native-operation-receipt:";
const RETIREMENT_PREFIX = "native-retirement:";
const CONTROL_PREFIX = "native-operation-control:";
const PAGE_SIZE = 25;
const ATTEMPT_LIMIT = 64;
const processIdentity = z.object({
  id: z.string().min(1).max(256),
  pid: z.number().int().positive(),
  startedAt: z.string().datetime({ offset: true }),
});
const attemptSchema = z
  .object({
    kind: z.enum(["process", "opaque"]),
    process: processIdentity.optional(),
  })
  .strict();
const nativeSchema = z
  .object({
    version: z.literal(1),
    closed: z.boolean(),
    threadKey: z.string().min(1).max(256).optional(),
    scope: nativeScopeRefSchema.optional(),
    pending: z.record(z.string(), attemptSchema).refine((attempts) => Object.keys(attempts).length <= ATTEMPT_LIMIT),
  })
  .strict();
const recordSchema = z.union([
  z.object({ opOwner: z.string().startsWith("op:"), native: nativeSchema }).strict(),
  z
    .object({
      runId: z.string().min(1),
      ownerGen: z.string().min(1),
      ownerFence: z.number().int().positive(),
      native: nativeSchema.extend({ threadKey: z.string().min(1).max(256) }),
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
export type NativeOperationReceipt = {
  key: string;
  recordHash: string;
  outcome: "native-ended";
  processes: NativeTerminal[];
};
export type NativeEndingRead =
  | { kind: "missing" }
  | { kind: "unavailable" }
  | { kind: "ended"; original: NativeOperationRecord; receipt: NativeOperationReceipt };

type Refusal = {
  error: string;
  status: 409 | 503;
  details?: { class: string; code?: string };
  controls?: z.infer<typeof controlSchema>[];
};

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
function recoverable(record: NativeOperationRecord): boolean {
  return Object.values(record.native.pending).every(
    (attempt) => attempt.kind === "process" && attempt.process !== undefined,
  );
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
  private async retirement(key: string, value: unknown, rows: Pick<NativeOperationRows, "get"> = this.storage) {
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

  async open(key: string, owner: WorkspaceOwner | { opOwner: string }, threadKey?: string): Promise<void> {
    const record = {
      ...ownerOf(owner),
      native: { version: 1 as const, closed: false, ...(threadKey ? { threadKey } : {}), pending: {} },
    };
    recordSchema.parse(record);
    await this.storage.transaction(async (rows) => {
      if ((await rows.get(key)) !== undefined || (await rows.get(RECEIPT_PREFIX + key)) !== undefined)
        throw new Error("native operation identity already used");
      if (threadKey && isWorkspaceOwner(owner) && (await rows.get(`cancelled:${threadKey}:${owner.runId}`)))
        throw new Error("run cancelled");
      await rows.put(key, record);
    });
  }

  async bindScope(key: string, scope: NativeScopeRef): Promise<void> {
    await this.storage.transaction(async (rows) => {
      const record = recordSchema.parse(await rows.get(key));
      if (
        !isWorkspaceOwner(record) ||
        record.runId !== scope.owner.runId ||
        record.ownerGen !== scope.owner.ownerGen ||
        record.ownerFence !== scope.owner.ownerFence ||
        record.native.threadKey !== scope.threadKey ||
        record.native.closed
      )
        throw new Error("native scope owner mismatch");
      if (record.native.scope && JSON.stringify(record.native.scope) !== JSON.stringify(scope))
        throw new Error("native scope identity changed");
      if (!record.native.scope && Object.keys(record.native.pending).length)
        throw new Error("legacy native submission cannot be adopted");
      record.native.scope = scope;
      await rows.put(key, record);
    });
  }

  async begin(key: string, kind: "process" | "opaque"): Promise<string> {
    const id = crypto.randomUUID();
    try {
      await this.storage.transaction(async (rows) => {
        const value = await rows.get(key);
        if (await this.retirement(key, value, rows)) throw new Error("original native runtime retired");
        const record = recordSchema.parse(value);
        if (record.native.closed) throw new Error("native operation already closed");
        if (Object.keys(record.native.pending).length >= ATTEMPT_LIMIT)
          throw new Error("too many pending native attempts");
        record.native.pending[id] = { kind };
        await rows.put(key, record);
      });
    } catch (error) {
      // An uncertain write is not a new admission. Read only this locally
      // retained ID; the caller still checks scope closure before submission.
      const value = await this.storage.get(key);
      if (await this.retirement(key, value)) throw error;
      const saved = recordSchema.safeParse(value);
      const attempt = saved.success ? saved.data.native.pending[id] : undefined;
      if (!attempt || attempt.kind !== kind || attempt.process) throw error;
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

  async settle(key: string, id: string): Promise<void> {
    await this.storage.transaction(async (rows) => {
      const value = await rows.get(key);
      // Recovery may already have archived the same observed terminal process.
      if (value === undefined && (await rows.get(RECEIPT_PREFIX + key)) !== undefined) return;
      if (await this.retirement(key, value, rows)) return;
      const record = recordSchema.parse(value);
      delete record.native.pending[id];
      if (record.native.closed && Object.keys(record.native.pending).length === 0) await rows.delete(key);
      else await rows.put(key, record);
    });
  }

  async close(key: string): Promise<void> {
    await this.storage.transaction(async (rows) => {
      const value = await rows.get(key);
      if (value === undefined) return;
      if (await this.retirement(key, value, rows)) return;
      const record = recordSchema.parse(value);
      record.native.closed = true;
      if (Object.keys(record.native.pending).length === 0) await rows.delete(key);
      else await rows.put(key, record);
    });
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
      const saved = await this.storage.get<{ receipt: NativeOperationReceipt }>(RECEIPT_PREFIX + key);
      if (saved?.receipt.recordHash === expectedHash) return saved.receipt;
      const controls = (await this.controls(key)).filter((control) => control.recordHash === expectedHash);
      return { ...refuse("record-missing-or-changed"), ...(controls.length ? { controls } : {}) };
    }
    if ((await recordHash(value)) !== expectedHash) return refuse("record-changed");
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
      if (await this.retirement(key, current, rows))
        return refuse("original-runtime-retired; historical effects unknown");
      if (
        current === undefined ||
        (await recordHash(current)) !== expectedHash ||
        !(await ownerMatches(rows, parsed.data))
      )
        return refuse("record-or-owner-changed");
      const receipt: NativeOperationReceipt = { key, recordHash: expectedHash, outcome: "native-ended", processes };
      // Archive and release are one commit. The original record remains evidence,
      // but the receipt prefix cannot contribute to the unresolved-operation guard.
      await rows.put(RECEIPT_PREFIX + key, { original: current, receipt });
      await rows.delete(key);
      return receipt;
    });
  }
}
