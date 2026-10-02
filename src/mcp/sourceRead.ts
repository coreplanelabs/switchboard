import { createHash } from "node:crypto";
import { sourceHash } from "../core/references/receipts.js";
import { isSourceReadReference, type SourceReadReference } from "./sourceReadState.js";
import { sourceReadState, type SourceReadState, type SourceReadOwner, type ReadRecord } from "./sourceReadState.js";
export { sourceReadState, type SourceReadState, type SourceReadOwner } from "./sourceReadState.js";
import { wrapUntrusted } from "../core/commandRegistry.js";
import type { AudienceCheck } from "../core/audienceDecision.js";
import { SOURCE_READ_ELIGIBILITY_MS, SOURCE_REVALIDATE_MAX_MS } from "../core/budgets.js";
import type { McpCallResult } from "./types.js";
import type { Span } from "../core/trace/types.js";
import {
  sourceReadJson,
  sourceReadResponseSchema,
  type SourceReadContract,
  type SourceReadResponse,
} from "./sourceReadProtocol.js";

export interface SourceReadOperation {
  toolName: string;
  serverId: string;
  connectionRevision: string;
  contract: SourceReadContract;
  session(signal?: AbortSignal): Promise<string | undefined>;
  current(): Promise<boolean>;
  call(request: Record<string, unknown>, sessionId: string, signal?: AbortSignal, span?: Span): Promise<McpCallResult>;
}
export interface SourceReads {
  run(tool: string, input: unknown, callId: string, signal?: AbortSignal, span?: Span): Promise<string>;
  /** Reconcile source actions only; this does not authorize transcript or model replay. */
  recover(): Promise<boolean>;
  commitRecovery(): Promise<boolean>;
  snapshot(): SourceReadState | undefined;
  revalidate(): Promise<AudienceCheck>;
  recoveredText(callId: string): string | undefined;
}
const unavailable = "Source unavailable: the read could not be authorized or recorded. No source result is available.";
const unknown =
  "Source outcome unknown: only inspection of the original action is allowed. No source result is available.";

function resultText(r: ReadRecord): string {
  const response = r.response;
  if (r.phase !== "settled" || !response) return unknown;
  if (response.status !== "succeeded") return unavailable;
  return wrapUntrusted(
    JSON.stringify({
      status: response.status,
      resource: r.query.resource,
      input: r.query.input,
      observedAt: response.observedAt,
      truncation: response.truncation,
      result: response.result,
    }),
  );
}
function validResponse(raw: McpCallResult, r: ReadRecord, now: () => number): SourceReadResponse | undefined {
  if (raw.isError || JSON.stringify(raw.structuredContent ?? null).length > 24_000) return undefined;
  const parsed = sourceReadResponseSchema.safeParse(raw.structuredContent);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  if (value.actionId !== undefined && value.actionId !== r.actionId) return undefined;
  if (!("binding" in value)) return value;
  if (
    value.operationId !== r.operationId ||
    value.operationRevision !== r.operationRevision ||
    value.binding.sessionId !== r.sessionId ||
    sourceReadJson(value.binding.resource) !== sourceReadJson(r.query.resource) ||
    sourceReadJson(value.binding.input) !== sourceReadJson(r.query.input) ||
    Date.parse(value.binding.expiresAt) <= now()
  )
    return undefined;
  if (r.response && "binding" in r.response && sourceReadJson(r.response.binding) !== sourceReadJson(value.binding))
    return undefined;
  if (
    value.status === "succeeded" &&
    (JSON.stringify(value.result).length > 16_000 ||
      Date.parse(value.observedAt) > now() ||
      Date.parse(value.observedAt) >= Date.parse(value.binding.expiresAt) ||
      Date.parse(value.binding.expiresAt) - Date.parse(value.observedAt) > SOURCE_READ_ELIGIBILITY_MS)
  )
    return undefined;
  if (r.response?.status === "succeeded" && sourceReadJson(r.response) !== sourceReadJson(value)) return undefined;
  return value;
}

/** Inspect an original action for a currently admitted consumer. This read
 * neither creates an action nor retargets, refreshes or rewrites its owner. */
export async function inspectStoredSourceRead(input: {
  state: unknown;
  owner: SourceReadOwner;
  reference: SourceReadReference;
  requester: string;
  operations: readonly SourceReadOperation[];
  audience(): Promise<boolean>;
  now(): number;
  signal?: AbortSignal;
}): Promise<AudienceCheck> {
  const refused = { ok: false as const, code: "mcp-source-changed" as const };
  if (
    input.requester !== input.owner.requester ||
    !isSourceReadReference(input.reference) ||
    input.reference.runId !== input.owner.runId
  )
    return refused;
  const state = sourceReadState(input.state, input.owner);
  const row = state?.records.find((r) => r.actionId === input.reference.actionId);
  if (
    !row ||
    !row.exposed ||
    row.phase !== "settled" ||
    row.response?.status !== "succeeded" ||
    !input.reference.callIds.every((id) => row.callIds.includes(id)) ||
    (await sourceHash(row.response)) !== input.reference.responseHash ||
    Date.parse(row.response.binding.expiresAt) <= input.now()
  )
    return refused;
  const operation = input.operations.find(
    (op) =>
      op.toolName === row.toolName &&
      op.serverId === row.serverId &&
      op.connectionRevision === row.connectionRevision &&
      op.contract.descriptor.operationId === row.operationId &&
      op.contract.descriptor.operationRevision === row.operationRevision &&
      op.contract.accepts(row.query),
  );
  if (!operation) return refused;
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const allowed = async () =>
    !controller.signal.aborted &&
    (await input.audience()) &&
    (await operation.current()) &&
    (await input.audience()) &&
    !controller.signal.aborted;
  try {
    return await Promise.race([
      (async (): Promise<AudienceCheck> => {
        if (!(await allowed())) return refused;
        const response = validResponse(
          await operation.call(
            {
              version: 1,
              action: "inspect",
              actionId: row.actionId,
              operationRevision: row.operationRevision,
              ...row.query,
            },
            row.sessionId,
            controller.signal,
          ),
          row,
          input.now,
        );
        return response?.status === "succeeded" &&
          (await allowed()) &&
          Date.parse(response.binding.expiresAt) > input.now()
          ? { ok: true }
          : refused;
      })(),
      new Promise<AudienceCheck>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ ok: false, code: "source-check-timeout" });
        }, SOURCE_REVALIDATE_MAX_MS);
      }),
    ]);
  } catch {
    return refused;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}

/** The ledger owns intent; the source owns authority and effect settlement. */
export function createSourceReads(opts: {
  owner: SourceReadOwner;
  operations: readonly SourceReadOperation[];
  previous?: unknown;
  canRecover?: boolean;
  save(state: SourceReadState): Promise<boolean>;
  now(): number;
  audience(): Promise<boolean>;
}): SourceReads {
  let state =
    opts.previous === undefined
      ? { version: 1 as const, owner: opts.owner, recoverable: opts.canRecover === true, records: [] as ReadRecord[] }
      : sourceReadState(opts.previous, opts.owner);
  let failed = state === undefined;
  const recovered = new Set<string>();
  let recoveryPending = false;
  let queue = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const next = queue.then(f);
    queue = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  async function save(next: SourceReadState): Promise<boolean> {
    if (failed) return false;
    try {
      if (await opts.save(structuredClone(next))) {
        state = next;
        return true;
      }
    } catch {
      /* A failed commit is not authority to return an unrecorded result. */
    }
    failed = true;
    return false;
  }
  async function allowed(op: SourceReadOperation, signal?: AbortSignal): Promise<boolean> {
    try {
      return (
        !failed &&
        !signal?.aborted &&
        (await opts.audience()) &&
        !signal?.aborted &&
        (await op.current()) &&
        (await opts.audience()) &&
        !failed &&
        !signal?.aborted
      );
    } catch {
      return false;
    }
  }
  async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, fallback: T): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        failed = true;
        controller.abort();
        resolve(fallback);
      }, SOURCE_REVALIDATE_MAX_MS);
    });
    try {
      return await Promise.race([work(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
  function operation(r: ReadRecord): SourceReadOperation | undefined {
    return opts.operations.find(
      (op) =>
        op.toolName === r.toolName &&
        op.serverId === r.serverId &&
        op.connectionRevision === r.connectionRevision &&
        op.contract.descriptor.operationId === r.operationId &&
        op.contract.descriptor.operationRevision === r.operationRevision &&
        op.contract.accepts(r.query),
    );
  }
  async function invoke(
    r: ReadRecord,
    action: "execute" | "inspect",
    signal?: AbortSignal,
    stage = false,
    span?: Span,
  ): Promise<ReadRecord | undefined> {
    const op = operation(r);
    if (!op || !(await allowed(op, signal))) {
      failed = true;
      return undefined;
    }
    let response: SourceReadResponse | undefined;
    try {
      response = validResponse(
        await op.call(
          { version: 1, action, actionId: r.actionId, operationRevision: r.operationRevision, ...r.query },
          r.sessionId,
          signal,
          span,
        ),
        r,
        opts.now,
      );
    } catch {
      /* A lost acknowledgment leaves this original action unresolved. */
    }
    if (!(await allowed(op, signal))) {
      failed = true;
      return undefined;
    }
    if (r.exposed && response?.status !== "succeeded") {
      failed = true;
      return undefined;
    }
    const settled =
      response?.status === "succeeded" ||
      (response?.status === "refused" && "attempt" in response && response.attempt !== "possibly_dispatched");
    const next: ReadRecord = { ...r, phase: settled ? "settled" : "unknown" };
    if (response) next.response = response;
    else delete next.response;
    const nextState = { ...state!, records: state!.records.map((old) => (old.actionId === r.actionId ? next : old)) };
    if (stage) state = nextState;
    else if (sourceReadJson(state) !== sourceReadJson(nextState) && !(await save(nextState))) return undefined;
    return next;
  }
  return {
    run: (tool, input, callId, signal, span) =>
      serial(async () => {
        const op = opts.operations.find((candidate) => candidate.toolName === tool);
        if (!state || recoveryPending || !callId || !op || !op.contract.accepts(input) || !(await allowed(op, signal)))
          return unavailable;
        let r = state.records.find((row) => row.callIds.includes(callId));
        if (r && (r.toolName !== tool || sourceReadJson(r.query) !== sourceReadJson(input))) return unavailable;
        r ??= state.records.find((row) => row.toolName === tool && sourceReadJson(row.query) === sourceReadJson(input));
        let action: "execute" | "inspect" = "inspect";
        if (!r) {
          if (state.records.some((row) => row.phase !== "settled")) return unknown;
          if (state.records.length >= 50) return unavailable;
          const sessionId = await op.session(signal).catch(() => undefined);
          if (!sessionId) return unavailable;
          r = {
            actionId: `read:${createHash("sha256").update(`${opts.owner.runId}\0${callId}`).digest("hex")}`,
            callIds: [callId],
            toolName: tool,
            serverId: op.serverId,
            connectionRevision: op.connectionRevision,
            sessionId,
            operationId: op.contract.descriptor.operationId,
            operationRevision: op.contract.descriptor.operationRevision,
            query: structuredClone(input),
            phase: "pending",
            exposed: false,
          };
          if (!(await save({ ...state, records: [...state.records, r] }))) return unavailable;
          action = "execute";
        } else if (!r.callIds.includes(callId)) {
          if (r.callIds.length >= 50) return unavailable;
          r = { ...r, callIds: [...r.callIds, callId] };
          if (
            !(await save({ ...state, records: state.records.map((row) => (row.actionId === r!.actionId ? r! : row)) }))
          )
            return unavailable;
        }
        const result = await invoke(r, action, signal, false, span);
        if (!result) return unavailable;
        if (result.response?.status === "succeeded") {
          const exposed = { ...result, exposed: true };
          if (
            !(await save({
              ...state,
              records: state.records.map((row) => (row.actionId === result.actionId ? exposed : row)),
            }))
          )
            return unavailable;
        }
        // The ledger write can outlast an audience or connection change. Check
        // again after it acknowledges, before returning private data to the model.
        if (
          !(await allowed(op, signal)) ||
          (result.response &&
            "binding" in result.response &&
            Date.parse(result.response.binding.expiresAt) <= opts.now())
        ) {
          failed = true;
          return unavailable;
        }
        return resultText(result);
      }),
    recover: () =>
      serial(() =>
        bounded(async (signal) => {
          if (!state || !state.recoverable || failed || state.records.length === 0) return false;
          recoveryPending = true;
          for (const r of [...state.records]) {
            const checked = await invoke(r, "inspect", signal, true);
            if (!checked || !checked.response || checked.response.status === "refused") {
              failed = true;
              return false;
            }
            if (checked.response.status === "succeeded")
              state = {
                ...state!,
                records: state!.records.map((row) =>
                  row.actionId === checked.actionId ? { ...checked, exposed: true } : row,
                ),
              };
            for (const call of r.callIds) recovered.add(call);
          }
          return true;
        }, false),
      ),
    commitRecovery: () =>
      serial(() =>
        bounded(async (signal) => {
          if (!state || failed || !recoveryPending || !(await save(state))) return false;
          // A slow claim or receipt commit must not carry its pre-claim permission
          // check into the resumed model. Exposed results need a fresh inspection.
          for (const r of [...state.records]) if (r.exposed && !(await invoke(r, "inspect", signal))) return false;
          if (failed || signal.aborted) return false;
          recoveryPending = false;
          return true;
        }, false),
      ),
    snapshot: () => state && structuredClone(state),
    recoveredText: (callId) => {
      const r = state?.records.find((row) => row.callIds.includes(callId));
      return !failed && !recoveryPending && recovered.has(callId) && r ? resultText(r) : undefined;
    },
    revalidate: () =>
      serial(() =>
        bounded<AudienceCheck>(
          async (signal) => {
            if (!state || failed) return { ok: false, code: "mcp-source-changed" };
            for (const r of [...state.records])
              if (r.exposed && !(await invoke(r, "inspect", signal))) return { ok: false, code: "mcp-source-changed" };
            return { ok: true };
          },
          { ok: false, code: "source-check-timeout" },
        ),
      ),
  };
}
