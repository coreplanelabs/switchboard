import { redactAndCap } from "../../src/core/redact.js";
import { z } from "zod";
import {
  checkCommandHash,
  checkOperationSchema,
  reportCheckResultFailure,
  type CheckOperation,
} from "../../src/execution/checkOperation.js";
import type { ExecResult } from "../../src/execution/execResult.js";
import type { CheckInspection, CheckSource } from "../../src/core/checkInspection.js";
import { NativeOperationJournal, type NativeOperationRows, type NativeOperationStorage } from "./nativeOperation.js";

const contextSchema = z
  .object({
    threadKey: z.string().min(1).max(256),
    runId: z.string().min(1).max(128),
    ownerGen: z.string().min(1).max(128),
    ownerFence: z.number().int().positive(),
    incarnation: z.string().min(1).max(256),
  })
  .strict();
export type CheckOperationContext = z.infer<typeof contextSchema>;
const resultSchema = z
  .object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int().min(0).max(255),
    truncated: z.boolean(),
  })
  .strict();
const recordSchema = z
  .object({
    version: z.literal(1),
    context: contextSchema,
    checkOperation: checkOperationSchema,
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    nativeKey: z.string().min(1).max(512),
    result: resultSchema.extend({ stdout: z.string().max(4_000), stderr: z.string().max(4_000) }).optional(),
    retired: z.literal(true).optional(),
    endingHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
type CheckOperationRows = NativeOperationRows & Pick<NativeOperationStorage, "list">;
export interface CheckOperationStorage extends Omit<NativeOperationStorage, "transaction"> {
  transaction<T>(action: (rows: CheckOperationRows) => Promise<T>): Promise<T>;
}
export type CheckOperationAnswer =
  | { kind: "unknown" }
  | { kind: "not_started"; reason: "capacity" }
  | { kind: "completed"; checkOperation: CheckOperation; nativeKey: string; result: ExecResult };
const unknown = (): CheckOperationAnswer => ({ kind: "unknown" });
// These exits carry only partial output, matching the core check recorder.
const interruptedResult = (result: ExecResult): boolean => [124, 137, 143].includes(result.exitCode);

/** A request alias for one native operation, never permission to launch a second.
 * Native journal settlement and physical shutdown keep their existing owners. */
export class RecordedCheckOperation {
  constructor(private readonly storage: CheckOperationStorage) {}

  private async prefix(threadKey: string): Promise<string> {
    return `check-result:${await checkCommandHash(threadKey)}:`;
  }

  /** Drop bulk output only after the original registration has gone. Pending
   * aliases and no-repeat tombstones survive; this never settles native work. */
  async retire(
    threadKey: string,
    inactive: (context: CheckOperationContext, rows: NativeOperationRows) => Promise<boolean>,
  ): Promise<void> {
    const prefix = await this.prefix(threadKey);
    await this.storage.transaction(async (rows) => {
      for (const [key, value] of await rows.list<unknown>({ prefix, limit: 64 })) {
        const parsed = recordSchema.safeParse(value);
        if (
          !parsed.success ||
          !parsed.data.result ||
          interruptedResult(parsed.data.result) ||
          !(await inactive(parsed.data.context, rows))
        )
          continue;
        const { result: _result, ...record } = parsed.data;
        await rows.put(key, { ...record, retired: true });
      }
    });
  }

  private async key(context: CheckOperationContext, operation: CheckOperation): Promise<string> {
    return `${await this.prefix(context.threadKey)}${await checkCommandHash(JSON.stringify([context.runId, context.ownerGen, context.ownerFence, operation.key]))}`;
  }

  private async originalEndingProof(
    record: z.infer<typeof recordSchema>,
    ending: Awaited<ReturnType<NativeOperationJournal["readEnding"]>>,
    rows: NativeOperationRows,
  ): Promise<string | undefined> {
    if (
      ending.kind !== "ended" ||
      !("runId" in ending.original) ||
      ending.original.runId !== record.context.runId ||
      ending.original.ownerGen !== record.context.ownerGen ||
      ending.original.ownerFence !== record.context.ownerFence ||
      ending.original.native.threadKey !== record.context.threadKey ||
      (await rows.get(record.nativeKey)) !== undefined
    )
      return undefined;
    const proofHash = await checkCommandHash(JSON.stringify(ending.receipt));
    return record.endingHash === undefined || record.endingHash === proofHash ? proofHash : undefined;
  }

  /** The receiver supplies a canonical Memory read, never a caller's owner or key.
   * Historical proof does not require or replace the current registration. */
  async inspectRecorded(source: CheckSource, settle = false): Promise<CheckInspection> {
    if (settle && source.state !== "terminal") return { kind: "unavailable", reason: "live" };
    if (!settle && source.result) return { kind: "known", source: "canonical", result: source.result };
    const operation = source.operation;
    if (!operation) return { kind: "unavailable", reason: "identity" };
    const prefix = await this.prefix(source.threadKey);
    const inspect = async (rows: CheckOperationRows, write: boolean, readback = false): Promise<CheckInspection> => {
      const inventory = await rows.list<unknown>({ prefix, limit: 65 });
      if (inventory.size > 64) return { kind: "unavailable", reason: "identity" };
      const matches: Array<[string, z.infer<typeof recordSchema>]> = [];
      for (const [key, value] of inventory) {
        const parsed = recordSchema.safeParse(value);
        if (
          !parsed.success ||
          parsed.data.context.threadKey !== source.threadKey ||
          key !== (await this.key(parsed.data.context, parsed.data.checkOperation)) ||
          !parsed.data.nativeKey.startsWith(`native-operation:${source.threadKey}:${parsed.data.context.runId}:`) ||
          (parsed.data.retired &&
            parsed.data.result !== undefined &&
            (!parsed.data.endingHash || !interruptedResult(parsed.data.result))) ||
          (parsed.data.endingHash !== undefined && !parsed.data.retired)
        )
          return { kind: "unavailable", reason: "identity" };
        if (parsed.data.context.runId === source.selector.runId && parsed.data.checkOperation.key === operation.key)
          matches.push([key, parsed.data]);
      }
      if (matches.length !== 1) return { kind: "unavailable", reason: "identity" };
      const [key, record] = matches[0]!;
      if (record.checkOperation.commandHash !== operation.commandHash)
        return { kind: "unavailable", reason: "identity" };
      if (record.result && !interruptedResult(record.result))
        return { kind: "known", source: "resident", result: record.result };
      const ending = await new NativeOperationJournal(this.storage).readEnding(record.nativeKey, rows);
      if (ending.kind === "missing") {
        if (record.retired && !record.endingHash) return { kind: "retired", reason: "output_retired" };
        return record.endingHash
          ? { kind: "unavailable", reason: "proof" }
          : { kind: "pending", reason: "native_ending_unproven" };
      }
      const proofHash = await this.originalEndingProof(record, ending, rows);
      if (!proofHash) return { kind: "unavailable", reason: "proof" };
      if (readback && record.endingHash !== proofHash) return { kind: "unavailable", reason: "backend" };
      if (write && record.endingHash === undefined) {
        await rows.put(key, { ...record, retired: true, endingHash: proofHash });
      }
      return { kind: "retired", reason: "native_ended", proofHash };
    };
    try {
      return await this.storage.transaction((rows) => inspect(rows, settle));
    } catch {
      // A lost ACK is read back only. Repeating an uncertain mutation is unnecessary.
      if (settle) {
        try {
          return await this.storage.transaction((rows) => inspect(rows, false, true));
        } catch {
          /* Unreadable custody remains unavailable. */
        }
      }
      return { kind: "unavailable", reason: "backend" };
    }
  }

  async inspect(
    context: CheckOperationContext,
    operation: CheckOperation,
    current: (rows: NativeOperationRows) => Promise<boolean>,
  ): Promise<CheckOperationAnswer> {
    if (!contextSchema.safeParse(context).success || !checkOperationSchema.safeParse(operation).success)
      return unknown();
    const key = await this.key(context, operation);
    return this.storage.transaction(async (rows) => {
      if (!(await current(rows))) return unknown();
      const parsed = recordSchema.safeParse(await rows.get(key));
      if (!parsed.success) return unknown();
      const record = parsed.data;
      if (
        Object.entries(context).some(
          ([name, value]) => record.context[name as keyof CheckOperationContext] !== value,
        ) ||
        record.checkOperation.key !== operation.key ||
        record.checkOperation.commandHash !== operation.commandHash ||
        !record.result
      )
        return unknown();
      return { kind: "completed", checkOperation: operation, nativeKey: record.nativeKey, result: record.result };
    });
  }

  async execute(
    context: CheckOperationContext,
    operation: CheckOperation,
    request: { command: string; timeoutMs: number; env?: Record<string, string> },
    current: (rows: NativeOperationRows) => Promise<boolean>,
    execute: (nativeKey: string) => Promise<unknown>,
  ): Promise<CheckOperationAnswer> {
    if (
      !contextSchema.safeParse(context).success ||
      !checkOperationSchema.safeParse(operation).success ||
      (await checkCommandHash(request.command)) !== operation.commandHash
    )
      return unknown();
    const key = await this.key(context, operation);
    const requestDigest = await checkCommandHash(
      JSON.stringify([
        request.command,
        request.timeoutMs,
        Object.entries(request.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    );
    const nativeKey = `native-operation:${context.threadKey}:${context.runId}:${crypto.randomUUID()}`;
    const record = { version: 1 as const, context, checkOperation: operation, requestDigest, nativeKey };
    // An ambiguous admission ACK never launches. The saved pending alias prevents
    // any later request, including a concurrent one, from launching on that identity.
    const prefix = await this.prefix(context.threadKey);
    const admitted = await this.storage.transaction(async (rows) => {
      if (!(await current(rows)) || (await rows.get(key)) !== undefined) return false;
      const existing = await rows.list<unknown>({ prefix, limit: 65 });
      let retained = existing.size;
      for (const [oldKey, value] of existing) {
        const old = recordSchema.safeParse(value);
        if (
          old.success &&
          old.data.context.threadKey === context.threadKey &&
          old.data.context.ownerFence < context.ownerFence &&
          ((old.data.result && !interruptedResult(old.data.result)) || old.data.retired)
        ) {
          await rows.delete(oldKey);
          retained--;
        }
      }
      if (retained >= 64) return "capacity" as const;
      await rows.put(key, record);
      return true;
    });
    if (admitted === "capacity") return { kind: "not_started", reason: "capacity" };
    if (!admitted) {
      const prior = recordSchema.safeParse(await this.storage.get(key));
      if (!prior.success || prior.data.requestDigest !== requestDigest) return unknown();
      return this.inspect(context, operation, current);
    }
    const parsed = resultSchema.safeParse(await execute(nativeKey));
    if (!parsed.success) return unknown();
    const stdout = redactAndCap(parsed.data.stdout, 4_000);
    const stderr = redactAndCap(parsed.data.stderr, 4_000);
    const result = {
      ...parsed.data,
      stdout: stdout.slice(0, 4_000),
      stderr: stderr.slice(0, 4_000),
      truncated:
        parsed.data.truncated ||
        stdout.length > 4_000 ||
        stderr.length > 4_000 ||
        parsed.data.stdout.length > 4_000 ||
        parsed.data.stderr.length > 4_000,
    };
    try {
      await this.storage.transaction(async (rows) => {
        if (
          !(await current(rows)) ||
          (await rows.get(nativeKey)) !== undefined ||
          JSON.stringify(await rows.get(key)) !== JSON.stringify(record)
        )
          return;
        await rows.put(key, { ...record, result });
      });
    } catch {
      reportCheckResultFailure("result_write_unconfirmed", context, operation);
      // Read the original completion after an ACK loss; never repeat the command
      // or overwrite a different durable result.
    }
    const saved = await this.inspect(context, operation, current);
    return saved.kind === "completed" && JSON.stringify(saved.result) === JSON.stringify(result) ? saved : unknown();
  }
}
