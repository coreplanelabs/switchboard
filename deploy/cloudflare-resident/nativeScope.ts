import { MAX_READ_BASE64_CHARS } from "../../src/execution/binaryRead.js";
import { z } from "zod";
/** The existing resident hard-kill control deadline, shared by both transports. */
export const NATIVE_SCOPE_CONTROL_MS = 2_000;
import type { WorkspaceOwner } from "../../src/core/workspaceSettlement.js";
import type { NativeOperationStorage } from "./nativeOperation.js";
import {
  nativeScopeRefSchema,
  nativeOperatorOwnerSchema,
  nativeOperatorScopeRefSchema,
  nativeExecutionScopeRefSchema,
  type NativeScopeRef,
  type NativeOperatorOwner,
  type NativeOperatorScopeRef,
  type NativeExecutionScopeRef,
} from "../../src/execution/nativeScope.js";
export {
  nativeScopeRefSchema,
  nativeOperatorScopeRefSchema,
  nativeExecutionScopeRefSchema,
  type NativeScopeRef,
  type NativeOperatorOwner,
  type NativeOperatorScopeRef,
  type NativeExecutionScopeRef,
} from "../../src/execution/nativeScope.js";

const ownerSchema = nativeScopeRefSchema.shape.owner;
export const nativeTimeoutEndingSchema = z
  .object({
    version: z.literal(1),
    ref: nativeExecutionScopeRefSchema,
    attempt: z.string().uuid(),
    closed: z.literal(false),
    populated: z.literal(false),
    launcherExitCode: z
      .number()
      .int()
      .min(0)
      .max(255)
      .refine((code) => code !== 125),
  })
  .strict();
export type NativeTimeoutEnding = z.infer<typeof nativeTimeoutEndingSchema>;
const runRowSchema = z
  .object({
    id: z.string().uuid(),
    threadKey: z.string().min(1),
    owner: ownerSchema,
    boot: z.string().uuid().nullable(),
    closing: z.boolean(),
    closed: z.boolean(),
    bootstrap: z.enum(["reserved", "requested", "ready"]),
    closedBoot: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (row) =>
      (!row.closed || row.closing) &&
      (row.bootstrap === "reserved" || row.boot !== null) &&
      (row.closedBoot === undefined || (row.closed && row.boot !== null)) &&
      (!row.closed || row.boot === null || row.closedBoot !== undefined),
  );
const operatorRowSchema = z
  .object({
    kind: z.literal("operation"),
    id: z.string().uuid(),
    owner: nativeOperatorOwnerSchema,
    boot: z.string().uuid().nullable(),
    closing: z.boolean(),
    closed: z.boolean(),
    bootstrap: z.enum(["reserved", "requested", "ready"]),
    closedBoot: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (row) =>
      (!row.closed || row.closing) &&
      (row.bootstrap === "reserved" || row.boot !== null) &&
      (row.closedBoot === undefined || (row.closed && row.boot !== null)) &&
      (!row.closed || row.boot === null || row.closedBoot !== undefined),
  );
const rowSchema = z.union([runRowSchema, operatorRowSchema]);
type Row = z.infer<typeof rowSchema>;
type ExecutionOwner = WorkspaceOwner | NativeOperatorOwner;
export interface NativeScopeOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated?: boolean;
  /** Original attempt closure, retained separately from interrupted command output. */
  nativeEnding?: NativeTimeoutEnding;
}
export interface NativeScopeTransport {
  request(value: Record<string, unknown>, timeoutMs: number): Promise<NativeScopeOutput>;
}
const PREFIX = "native-scope:";
export function nativeScopeMatches(value: unknown, ref: NativeScopeRef): boolean {
  const parsed = rowSchema.safeParse(value);
  return parsed.success && parsed.data.boot !== null && JSON.stringify(refOf(parsed.data)) === JSON.stringify(ref);
}

export function nativeScopeClosed(value: unknown, ref: NativeScopeRef): boolean {
  const parsed = rowSchema.safeParse(value);
  return (
    parsed.success &&
    parsed.data.closing &&
    parsed.data.closed &&
    !!parsed.data.closedBoot &&
    JSON.stringify(refOf(parsed.data)) === JSON.stringify(ref)
  );
}

export function nativeScopeKey(threadKey: string, owner: WorkspaceOwner): string {
  return `${PREFIX}${encodeURIComponent(threadKey)}:${encodeURIComponent(owner.runId)}:${encodeURIComponent(owner.ownerGen)}:${owner.ownerFence}`;
}
export function nativeScopeRetirementKey(threadKey: string, owner: WorkspaceOwner): string {
  return nativeScopeKey(threadKey, owner).replace(PREFIX, "native-scope-retirement:");
}
function ownedRow(value: unknown, threadKey: string, owner: WorkspaceOwner): z.infer<typeof runRowSchema> {
  const row = runRowSchema.parse(value);
  if (
    row.threadKey !== threadKey ||
    row.owner.runId !== owner.runId ||
    row.owner.ownerGen !== owner.ownerGen ||
    row.owner.ownerFence !== owner.ownerFence
  )
    throw new Error("native-scope owner changed");
  return row;
}
export function nativeOperatorScopeKey(owner: NativeOperatorOwner): string {
  return `native-operator-scope:${encodeURIComponent(nativeOperatorOwnerSchema.parse(owner).opOwner)}`;
}
function ownedExecutionRow(value: unknown, owner: ExecutionOwner, threadKey?: string): Row {
  if (!("opOwner" in owner)) return ownedRow(value, threadKey!, owner);
  const row = operatorRowSchema.parse(value);
  if (row.owner.opOwner !== owner.opOwner) throw new Error("native-scope owner changed");
  return row;
}
export async function reserveNativeOperatorScope(
  rows: Pick<NativeOperationStorage, "get" | "put">,
  owner: NativeOperatorOwner,
  id: string,
) {
  const at = nativeOperatorScopeKey(owner);
  const value = await rows.get(at);
  if (value !== undefined) {
    const saved = ownedExecutionRow(value, owner);
    if (saved.closing || saved.closed) throw new Error("operator scope is closed");
    return saved;
  }
  const initial = {
    kind: "operation" as const,
    id,
    owner: nativeOperatorOwnerSchema.parse(owner),
    boot: null,
    closing: false,
    closed: false,
    bootstrap: "reserved" as const,
  };
  await rows.put(at, initial);
  return initial;
}
export function nativeOperatorScopeClosing(
  value: unknown,
  owner: NativeOperatorOwner,
  expected?: NativeOperatorScopeRef | null,
): boolean {
  const row = operatorRowSchema.safeParse(value);
  return (
    row.success &&
    row.data.owner.opOwner === owner.opOwner &&
    row.data.closing &&
    (expected === undefined ||
      (expected === null
        ? row.data.boot === null
        : !!row.data.boot && JSON.stringify(refOf(row.data)) === JSON.stringify(expected)))
  );
}
function refOf(row: Row): NativeExecutionScopeRef {
  return "kind" in row
    ? nativeOperatorScopeRefSchema.parse({
        version: 1,
        kind: "operation",
        id: row.id,
        boot: row.boot,
        owner: row.owner,
      })
    : nativeScopeRefSchema.parse({
        version: 1,
        id: row.id,
        boot: row.boot,
        threadKey: row.threadKey,
        owner: row.owner,
      });
}
export function nativeOperatorScopeClosed(value: unknown, ref: NativeOperatorScopeRef): boolean {
  const parsed = operatorRowSchema.safeParse(value);
  return (
    parsed.success &&
    parsed.data.closing &&
    parsed.data.closed &&
    !!parsed.data.closedBoot &&
    JSON.stringify(refOf(parsed.data)) === JSON.stringify(ref)
  );
}
export function nativeOperatorScopeEnding(value: unknown, owner: NativeOperatorOwner) {
  const parsed = operatorRowSchema.safeParse(value);
  if (!parsed.success || parsed.data.owner.opOwner !== owner.opOwner || !parsed.data.closed || !parsed.data.closing)
    return;
  const row = parsed.data;
  if (row.boot === null) return row.bootstrap === "reserved" ? { id: row.id, ref: null } : undefined;
  return row.closedBoot ? { id: row.id, ref: nativeOperatorScopeRefSchema.parse(refOf(row)) } : undefined;
}

function answer(output: NativeScopeOutput): unknown {
  if (output.exitCode !== 0 || output.timedOut || output.truncated || output.stderr !== "")
    throw new Error("native-scope operation is unconfirmed");
  return JSON.parse(output.stdout);
}

/** The reservation survives caller reset and is committed before bootstrap. */
export class NativeRunScopes {
  constructor(
    private readonly storage: NativeOperationStorage,
    private readonly native: NativeScopeTransport,
  ) {}

  async birth(
    threadKey: string,
    owner: WorkspaceOwner,
    native: boolean,
    verify: (rows: Pick<NativeOperationStorage, "get">) => Promise<void>,
  ): Promise<void> {
    await this.storage.transaction(async (rows) => {
      if (await rows.get(`cancelled:${threadKey}:${owner.runId}`)) throw new Error("run cancelled");
      await verify(rows);
      const at = `native-scope-mode:${encodeURIComponent(threadKey)}:${encodeURIComponent(owner.runId)}`;
      const previous = await rows.get<unknown>(at);
      const mode = z
        .object({ threadKey: z.string(), runId: z.string(), protocol: z.enum(["native-v1", "legacy"]) })
        .strict();
      const saved =
        previous === undefined
          ? { threadKey, runId: owner.runId, protocol: native ? ("native-v1" as const) : ("legacy" as const) }
          : mode.parse(previous);
      if (saved.threadKey !== threadKey || saved.runId !== owner.runId) throw new Error("native birth owner changed");
      if (native && saved.protocol === "legacy") throw new Error("legacy execution cannot be adopted");
      if (previous === undefined) await rows.put(at, saved);
      if (saved.protocol === "native-v1") {
        const scopeKey = nativeScopeKey(threadKey, owner);
        const value = await rows.get(scopeKey);
        if (value === undefined)
          await rows.put(scopeKey, {
            id: crypto.randomUUID(),
            threadKey,
            owner,
            boot: null,
            closing: false,
            closed: false,
            bootstrap: "reserved",
          });
        else ownedRow(value, threadKey, owner);
      }
    });
  }

  async protocol(threadKey: string, runId: string): Promise<"native-v1" | "legacy" | undefined> {
    const value = await this.storage.get<unknown>(
      `native-scope-mode:${encodeURIComponent(threadKey)}:${encodeURIComponent(runId)}`,
    );
    if (value === undefined) return;
    const parsed = z
      .object({ threadKey: z.string(), runId: z.string(), protocol: z.enum(["native-v1", "legacy"]) })
      .strict()
      .parse(value);
    if (parsed.threadKey !== threadKey || parsed.runId !== runId) throw new Error("native birth owner changed");
    return parsed.protocol;
  }

  async reserve(threadKey: string, owner: WorkspaceOwner): Promise<void> {
    if ((await this.protocol(threadKey, owner.runId)) !== "native-v1") throw new Error("native birth is unconfirmed");
    await this.birth(threadKey, owner, true, async (rows) => {
      if (await rows.get(`cancelled:${threadKey}:${owner.runId}`)) throw new Error("run cancelled");
    });
  }

  async ensure(threadKey: string, owner: WorkspaceOwner, allowed: () => Promise<void>): Promise<NativeScopeRef> {
    await this.reserve(threadKey, owner);
    return nativeScopeRefSchema.parse(
      await this.ensureExecution(nativeScopeKey(threadKey, owner), owner, allowed, threadKey),
    );
  }
  async reserveOperator(owner: NativeOperatorOwner): Promise<void> {
    const at = nativeOperatorScopeKey(owner);
    const initial = {
      kind: "operation" as const,
      id: crypto.randomUUID(),
      owner: nativeOperatorOwnerSchema.parse(owner),
      boot: null,
      closing: false,
      closed: false,
      bootstrap: "reserved" as const,
    };
    try {
      await this.storage.transaction(async (rows) => {
        await reserveNativeOperatorScope(rows, owner, initial.id);
      });
    } catch (error) {
      const saved = ownedExecutionRow(await this.storage.get(at), owner);
      if (JSON.stringify(saved) !== JSON.stringify(initial)) throw error;
    }
  }
  async ensureOperator(owner: NativeOperatorOwner, allowed: () => Promise<void>): Promise<NativeOperatorScopeRef> {
    await this.reserveOperator(owner);
    const capability = z
      .object({ version: z.literal(1), boot: z.string().uuid(), operatorScopes: z.literal(1).optional() })
      .strict()
      .parse(answer(await this.native.request({ mode: "inspect", operator: true }, NATIVE_SCOPE_CONTROL_MS)));
    if (capability.operatorScopes !== 1) throw new Error("operator scope unsupported");
    return nativeOperatorScopeRefSchema.parse(
      await this.ensureExecution(nativeOperatorScopeKey(owner), owner, allowed, undefined, capability.boot),
    );
  }
  private async ensureExecution(
    at: string,
    owner: ExecutionOwner,
    allowed: () => Promise<void>,
    threadKey?: string,
    observedBoot?: string,
  ): Promise<NativeExecutionScopeRef> {
    const reserved = ownedExecutionRow(await this.storage.get(at), owner, threadKey);
    if (reserved.closing || reserved.closed) throw new Error("run cancelled");
    await allowed();
    if (reserved.boot && observedBoot && reserved.boot !== observedBoot) throw new Error("native-scope kernel changed");
    let boot = reserved.boot ?? observedBoot;
    if (!boot) {
      const observed = z
        .object({ version: z.literal(1), boot: z.string().uuid() })
        .strict()
        .parse(answer(await this.native.request({ mode: "inspect" }, NATIVE_SCOPE_CONTROL_MS)));
      boot = observed.boot;
    }
    const current = await this.storage.transaction(async (rows) => {
      const row = ownedExecutionRow(await rows.get(at), owner, threadKey);
      if (row.id !== reserved.id || row.closing || row.closed) throw new Error("run cancelled");
      if (row.boot && row.boot !== boot) throw new Error("native-scope kernel changed");
      const saved = { ...row, boot };
      await rows.put(at, saved);
      return saved;
    });
    await allowed();
    const ref = refOf(current);
    if (current.bootstrap !== "ready") {
      const submit = await this.storage.transaction(async (rows) => {
        const row = ownedExecutionRow(await rows.get(at), owner, threadKey);
        if (row.id !== ref.id || row.closing || row.closed) throw new Error("run cancelled");
        if (row.bootstrap !== "reserved") return false;
        await rows.put(at, { ...row, bootstrap: "requested" });
        return true;
      });
      const observed = z
        .object({
          ref: nativeExecutionScopeRefSchema,
          closed: z.literal(false),
          populated: z.boolean().optional(),
          present: z.literal(true).optional(),
          ready: z.literal(true).optional(),
        })
        .strict()
        .parse(
          answer(await this.native.request({ mode: submit ? "bootstrap" : "view", ref }, NATIVE_SCOPE_CONTROL_MS)),
        );
      if (!submit && (observed.present !== true || observed.ready !== true))
        throw new Error("native-scope bootstrap is unconfirmed");
      if (JSON.stringify(observed.ref) !== JSON.stringify(ref)) throw new Error("native-scope owner changed");
      await this.storage.transaction(async (rows) => {
        const row = ownedExecutionRow(await rows.get(at), owner, threadKey);
        if (row.id !== ref.id || row.closing || row.closed) throw new Error("run cancelled");
        await rows.put(at, { ...row, bootstrap: "ready" });
      });
    }
    await allowed();
    const after = ownedExecutionRow(await this.storage.get(at), owner, threadKey);
    if (after.id !== ref.id || after.closing || after.closed) throw new Error("run cancelled");
    return ref;
  }

  async find(threadKey: string, owner: WorkspaceOwner): Promise<NativeScopeRef | null> {
    const value = await this.storage.get<unknown>(nativeScopeKey(threadKey, owner));
    if (value === undefined) return null;
    const row = ownedRow(value, threadKey, owner);
    return row.boot ? nativeScopeRefSchema.parse(refOf(row)) : null;
  }

  async matching(threadKey: string, runId: string): Promise<WorkspaceOwner[]> {
    const result: WorkspaceOwner[] = [];
    const prefix = `${PREFIX}${encodeURIComponent(threadKey)}:${encodeURIComponent(runId)}:`;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.storage.list<unknown>({ prefix, limit: 25, ...(cursor ? { startAfter: cursor } : {}) });
      for (const [storedKey, value] of page) {
        const row = runRowSchema.parse(value);
        if (storedKey !== nativeScopeKey(row.threadKey, row.owner))
          throw new Error("native-scope storage identity changed");
        if (row.threadKey === threadKey && row.owner.runId === runId) result.push(row.owner);
      }
      if (page.size < 25) return result;
      const next = [...page.keys()].at(-1)!;
      if (cursor !== undefined && next <= cursor) throw new Error("native-scope inventory is incomplete");
      cursor = next;
    }
  }

  async close(
    threadKey: string,
    owner: WorkspaceOwner,
    expected?: NativeScopeRef,
  ): Promise<NativeScopeRef | "unstarted" | null> {
    const result = await this.closeExecution(nativeScopeKey(threadKey, owner), owner, expected, threadKey);
    return result === null || result === "unstarted" ? result : nativeScopeRefSchema.parse(result);
  }
  async closeOperator(
    owner: NativeOperatorOwner,
    expected?: NativeOperatorScopeRef,
  ): Promise<NativeOperatorScopeRef | "unstarted" | null> {
    const result = await this.closeExecution(nativeOperatorScopeKey(owner), owner, expected);
    return result === null || result === "unstarted" ? result : nativeOperatorScopeRefSchema.parse(result);
  }
  private async closeExecution(
    at: string,
    owner: ExecutionOwner,
    expected?: NativeExecutionScopeRef,
    threadKey?: string,
  ): Promise<NativeExecutionScopeRef | "unstarted" | null> {
    const row = await this.storage.transaction(async (rows) => {
      const value = await rows.get<unknown>(at);
      if (value === undefined) return null;
      const row = ownedExecutionRow(value, owner, threadKey);
      if (expected && JSON.stringify(refOf(row)) !== JSON.stringify(expected)) throw new Error("native-scope changed");
      await rows.put(at, { ...row, closing: true });
      return row;
    });
    if (!row) return null;
    if (!row.boot) {
      const closed = { ...row, closing: true, closed: true };
      try {
        await this.storage.put(at, closed);
      } catch (error) {
        if (JSON.stringify(await this.storage.get(at)) !== JSON.stringify(closed)) throw error;
      }
      return "unstarted";
    }
    const ref = refOf(row);
    const commitClosure = async (closedBoot: string): Promise<void> => {
      let committedClosure: Row | undefined;
      try {
        await this.storage.transaction(async (rows) => {
          const current = ownedExecutionRow(await rows.get(at), owner, threadKey);
          if (current.id !== row.id || current.boot !== row.boot || !current.closing)
            throw new Error("native-scope changed");

          committedClosure = { ...current, closed: true, closedBoot };
          await rows.put(at, committedClosure);
        });
      } catch (error) {
        if (!committedClosure || JSON.stringify(await this.storage.get(at)) !== JSON.stringify(committedClosure))
          throw error;
      }
    };
    const confirmTimedOutClosure = async (
      timeout: NativeScopeControlTimeoutError,
    ): Promise<NativeExecutionScopeRef> => {
      let view: {
        ref: NativeExecutionScopeRef;
        closed: boolean;
        populated: boolean;
        present?: boolean;
        ready?: boolean;
      };
      try {
        view = z
          .object({
            ref: nativeExecutionScopeRefSchema,
            closed: z.boolean(),
            populated: z.boolean(),
            present: z.boolean().optional(),
            ready: z.boolean().optional(),
          })
          .strict()
          .parse(answer(await this.native.request({ mode: "view", ref }, NATIVE_SCOPE_CONTROL_MS)));
      } catch (readbackError) {
        throw new Error(`${timeout.message}; exact closure readback failed`, {
          cause: readbackError,
        });
      }
      if (JSON.stringify(view.ref) !== JSON.stringify(ref))
        throw new Error("native-scope owner changed during timeout readback", { cause: timeout });
      if (!view.closed || view.populated)
        throw new Error(`${timeout.message}; readback closed=${view.closed} populated=${view.populated}`, {
          cause: timeout,
        });
      await commitClosure(ref.boot);
      return ref;
    };
    try {
      // Old wrappers validate the original boot before any payload instruction.
      // A fresh different kernel proves that this original scope cannot run here.
      const kernel = z
        .object({ version: z.literal(1), boot: z.string().uuid() })
        .strict()
        .parse(answer(await this.native.request({ mode: "inspect" }, NATIVE_SCOPE_CONTROL_MS)));
      if (kernel.boot !== ref.boot) {
        await commitClosure(kernel.boot);
        return ref;
      }
      let result: unknown;
      if (row.closing || row.closed) {
        const view = z
          .object({
            ref: nativeExecutionScopeRefSchema,
            closed: z.boolean(),
            populated: z.boolean(),
            present: z.boolean().optional(),
            ready: z.boolean().optional(),
          })
          .strict()
          .parse(answer(await this.native.request({ mode: "view", ref }, NATIVE_SCOPE_CONTROL_MS)));
        if (JSON.stringify(view.ref) !== JSON.stringify(ref)) throw new Error("native-scope owner changed");
        // Close is monotonic for this immutable scope. A positive open/absent
        // observation resumes a reset before submission, never a payload replay.
        result =
          view.closed && !view.populated
            ? { ref: view.ref, closed: true, populated: false }
            : answer(await this.native.request({ mode: "close", ref }, NATIVE_SCOPE_CONTROL_MS));
      } else result = answer(await this.native.request({ mode: "close", ref }, NATIVE_SCOPE_CONTROL_MS));
      const observed = z
        .object({ ref: nativeExecutionScopeRefSchema, closed: z.literal(true), populated: z.literal(false) })
        .strict()
        .parse(result);
      if (JSON.stringify(observed.ref) !== JSON.stringify(ref)) throw new Error("native-scope owner changed");
      await commitClosure(kernel.boot);
      return ref;
    } catch (error) {
      if (error instanceof NativeScopeControlTimeoutError) return confirmTimedOutClosure(error);
      throw error;
    }
  }
}

export class NativeScopeControlTimeoutError extends Error {
  readonly mode: string;
  readonly timeoutMs: number;

  constructor(mode: string, timeoutMs: number) {
    const safeMode = /^[a-z][a-z0-9-]{0,31}$/.test(mode) ? mode : "unknown";
    const safeTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 0;
    super(`native-scope outcome is unknown (mode=${safeMode}, timeoutMs=${safeTimeout})`);
    this.name = "NativeScopeControlTimeoutError";
    this.mode = safeMode;
    this.timeoutMs = safeTimeout;
  }
}

/** Native exec keeps the controller outside the workload's cgroup. */
export class CloudflareNativeScopeTransport implements NativeScopeTransport {
  constructor(private readonly container: Pick<Container, "exec" | "running">) {}
  async request(value: Record<string, unknown>, timeoutMs: number): Promise<NativeScopeOutput> {
    if (!this.container.running) throw new Error("native-scope runtime unavailable");
    const payload = new TextEncoder().encode(JSON.stringify(value));
    const stdin = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const submission = Promise.resolve().then(() =>
      this.container.exec(["/usr/bin/python3", "-I", "/opt/switchboard/native-scope.py"], {
        stdin,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
      }),
    );
    let truncated = false;
    const collect = async (stream: ReadableStream | null): Promise<string> => {
      if (!stream) return "";
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let result = "";
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        const text = decoder.decode(part.value, { stream: true });
        if (result.length + text.length > MAX_READ_BASE64_CHARS) truncated = true;
        result += text.slice(0, Math.max(0, MAX_READ_BASE64_CHARS - result.length));
      }
      return result + decoder.decode();
    };
    // Collection starts even if an exec ACK arrives after the deadline, so
    // finite pipe output does not retain an otherwise finished launcher.
    const completed = submission.then((process) =>
      Promise.all([collect(process.stdout), collect(process.stderr), process.exitCode]),
    );
    try {
      const output = await Promise.race([completed, expired]);
      if (!output) {
        // No signal is sent to an exited or identity-unknown process. A launch
        // timeout is closed through its original caller-known attempt group.
        if (value.mode === "launch") {
          const closure = z
            .object({
              ref: nativeExecutionScopeRefSchema,
              attempt: z.string().uuid(),
              closed: z.literal(false),
              populated: z.literal(false),
            })
            .strict()
            .parse(
              answer(
                await this.request(
                  { mode: "kill-attempt", ref: value.ref, attempt: value.attempt },
                  NATIVE_SCOPE_CONTROL_MS,
                ),
              ),
            );
          if (JSON.stringify(closure.ref) !== JSON.stringify(value.ref) || closure.attempt !== value.attempt)
            throw new Error("native attempt closure is unconfirmed");
          if (timer !== undefined) clearTimeout(timer);
          const killed = await Promise.race([
            completed,
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), NATIVE_SCOPE_CONTROL_MS);
            }),
          ]);
          if (killed)
            return {
              stdout: killed[0],
              stderr: killed[1],
              exitCode: 124,
              timedOut: true,
              truncated,
              nativeEnding: nativeTimeoutEndingSchema.parse({ version: 1, ...closure, launcherExitCode: killed[2] }),
            };
        }
        const mode = typeof value.mode === "string" ? value.mode : "unknown";
        throw new NativeScopeControlTimeoutError(mode, timeoutMs);
      }
      return { stdout: output[0], stderr: output[1], exitCode: output[2], timedOut: false, truncated };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
