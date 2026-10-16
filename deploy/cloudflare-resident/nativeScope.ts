import { MAX_READ_BASE64_CHARS } from "../../src/execution/binaryRead.js";
import { z } from "zod";
/** The existing resident hard-kill control deadline, shared by both transports. */
export const NATIVE_SCOPE_CONTROL_MS = 2_000;
import type { WorkspaceOwner } from "../../src/core/workspaceSettlement.js";
import type { NativeOperationStorage } from "./nativeOperation.js";
import { nativeScopeRefSchema, type NativeScopeRef } from "../../src/execution/nativeScope.js";
export { nativeScopeRefSchema, type NativeScopeRef } from "../../src/execution/nativeScope.js";

const ownerSchema = nativeScopeRefSchema.shape.owner;
const rowSchema = z
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
type Row = z.infer<typeof rowSchema>;
export interface NativeScopeOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated?: boolean;
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
function ownedRow(value: unknown, threadKey: string, owner: WorkspaceOwner): Row {
  const row = rowSchema.parse(value);
  if (
    row.threadKey !== threadKey ||
    row.owner.runId !== owner.runId ||
    row.owner.ownerGen !== owner.ownerGen ||
    row.owner.ownerFence !== owner.ownerFence
  )
    throw new Error("native-scope owner changed");
  return row;
}
function refOf(row: Row): NativeScopeRef {
  return nativeScopeRefSchema.parse({
    version: 1,
    id: row.id,
    boot: row.boot,
    threadKey: row.threadKey,
    owner: row.owner,
  });
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
    const at = nativeScopeKey(threadKey, owner);
    await this.reserve(threadKey, owner);
    const reserved = ownedRow(await this.storage.get(at), threadKey, owner);
    if (reserved.closing || reserved.closed) throw new Error("run cancelled");
    await allowed();
    let boot = reserved.boot;
    if (!boot) {
      const observed = z
        .object({ version: z.literal(1), boot: z.string().uuid() })
        .strict()
        .parse(answer(await this.native.request({ mode: "inspect" }, NATIVE_SCOPE_CONTROL_MS)));
      boot = observed.boot;
    }
    const current = await this.storage.transaction(async (rows) => {
      const row = ownedRow(await rows.get(at), threadKey, owner);
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
        const row = ownedRow(await rows.get(at), threadKey, owner);
        if (row.id !== ref.id || row.closing || row.closed) throw new Error("run cancelled");
        if (row.bootstrap !== "reserved") return false;
        await rows.put(at, { ...row, bootstrap: "requested" });
        return true;
      });
      const observed = z
        .object({
          ref: nativeScopeRefSchema,
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
        const row = ownedRow(await rows.get(at), threadKey, owner);
        if (row.id !== ref.id || row.closing || row.closed) throw new Error("run cancelled");
        await rows.put(at, { ...row, bootstrap: "ready" });
      });
    }
    await allowed();
    const after = ownedRow(await this.storage.get(at), threadKey, owner);
    if (after.id !== ref.id || after.closing || after.closed) throw new Error("run cancelled");
    return ref;
  }

  async find(threadKey: string, owner: WorkspaceOwner): Promise<NativeScopeRef | null> {
    const value = await this.storage.get<unknown>(nativeScopeKey(threadKey, owner));
    if (value === undefined) return null;
    const row = ownedRow(value, threadKey, owner);
    return row.boot ? refOf(row) : null;
  }

  async matching(threadKey: string, runId: string): Promise<WorkspaceOwner[]> {
    const result: WorkspaceOwner[] = [];
    const prefix = `${PREFIX}${encodeURIComponent(threadKey)}:${encodeURIComponent(runId)}:`;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.storage.list<unknown>({ prefix, limit: 25, ...(cursor ? { startAfter: cursor } : {}) });
      for (const [storedKey, value] of page) {
        const row = rowSchema.parse(value);
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
    const at = nativeScopeKey(threadKey, owner);
    const row = await this.storage.transaction(async (rows) => {
      const value = await rows.get<unknown>(at);
      if (value === undefined) return null;
      const row = ownedRow(value, threadKey, owner);
      if (expected && JSON.stringify(refOf(row)) !== JSON.stringify(expected)) throw new Error("native-scope changed");
      await rows.put(at, { ...row, closing: true });
      return row;
    });
    if (!row) return null;
    if (!row.boot) {
      await this.storage.put(at, { ...row, closing: true, closed: true });
      return "unstarted";
    }
    const ref = refOf(row);
    // Old wrappers validate the original boot before any payload instruction.
    // A fresh different kernel proves that this original scope cannot run here.
    const kernel = z
      .object({ version: z.literal(1), boot: z.string().uuid() })
      .strict()
      .parse(answer(await this.native.request({ mode: "inspect" }, NATIVE_SCOPE_CONTROL_MS)));
    if (kernel.boot !== ref.boot) {
      await this.storage.transaction(async (rows) => {
        const current = ownedRow(await rows.get(at), threadKey, owner);
        if (current.id !== row.id || current.boot !== row.boot || !current.closing)
          throw new Error("native-scope changed");
        await rows.put(at, { ...current, closed: true, closedBoot: kernel.boot });
      });
      return ref;
    }
    let result: unknown;
    if (row.closing || row.closed) {
      const view = z
        .object({
          ref: nativeScopeRefSchema,
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
      .object({ ref: nativeScopeRefSchema, closed: z.literal(true), populated: z.literal(false) })
      .strict()
      .parse(result);
    if (JSON.stringify(observed.ref) !== JSON.stringify(ref)) throw new Error("native-scope owner changed");
    await this.storage.transaction(async (rows) => {
      const current = ownedRow(await rows.get(at), threadKey, owner);
      if (current.id !== row.id || current.boot !== row.boot || !current.closing)
        throw new Error("native-scope changed");
      await rows.put(at, { ...current, closed: true, closedBoot: kernel.boot });
    });
    return ref;
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
              ref: nativeScopeRefSchema,
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
          if (killed) return { stdout: killed[0], stderr: killed[1], exitCode: 124, timedOut: true, truncated };
        }
        throw new Error("native-scope outcome is unknown");
      }
      return { stdout: output[0], stderr: output[1], exitCode: output[2], timedOut: false, truncated };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
