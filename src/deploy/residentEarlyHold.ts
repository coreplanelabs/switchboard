import type { HealthRead } from "./sandboxLiveGate.js";
import type { PostAnswer } from "./residentDrain.js";
import { isWorkspaceOwner } from "../core/workspaceSettlement.js";
import { nativeScopeRefSchema } from "../execution/nativeScope.js";
import { nativeRetirementPermitSchema } from "../execution/nativeRetirement.js";

const NATIVE_KEY = /^native-operation:.{1,495}$/;
const RECORD_HASH = /^[a-f0-9]{64}$/;
const RESOURCE = /^repo:[a-z0-9][a-z0-9._/-]{0,57}$/;
const MAX_PAGES_PER_RESIDENT = 200;

interface EarlyHoldReader {
  baseUrl: string;
  bearer: string | undefined;
  signal?: AbortSignal;
  onClosedOperation?: (problem: string) => void;
  readHealth(url: string, bearer?: string, timeoutMs?: number, signal?: AbortSignal): Promise<HealthRead>;
  postJson?(url: string, bearer: string, body: Record<string, unknown>): Promise<PostAnswer>;
}

const unavailable = (reason: string) => `resident deployment inventory unavailable before any Worker upload: ${reason}`;

function retirementMatches(value: unknown, key: string, hash: string, resource: string, journal: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const records = receipt.records;
  if (
    receipt.originalOperationOutcome !== "unknown" ||
    !records ||
    typeof records !== "object" ||
    Array.isArray(records) ||
    !Object.hasOwn(records, key) ||
    (records as Record<string, unknown>)[key] !== hash ||
    !Object.values(records).every((digest) => typeof digest === "string" && RECORD_HASH.test(digest))
  )
    return false;
  if (receipt.purpose === "terminal-native-scope") {
    const permit = nativeRetirementPermitSchema.safeParse(receipt.permit);
    const scope = nativeScopeRefSchema.safeParse(
      journal && typeof journal === "object" ? (journal as Record<string, unknown>).scope : undefined,
    );
    return (
      receipt.state === "closed" &&
      permit.success &&
      scope.success &&
      (records as Record<string, unknown>)[permit.data.target.key] === permit.data.target.recordHash &&
      permit.data.target.resource === resource &&
      key.startsWith(`native-operation:${scope.data.threadKey}:${scope.data.owner.runId}:`) &&
      JSON.stringify(scope.data) === JSON.stringify(permit.data.target.scope)
    );
  }
  if (typeof receipt.cancellationId !== "string" || !receipt.cancellationId) return false;
  if (receipt.scope !== undefined) {
    const scope = nativeScopeRefSchema.safeParse(receipt.scope);
    return (
      scope.success &&
      typeof receipt.controllerOwnerGen === "string" &&
      !!receipt.controllerOwnerGen &&
      key.startsWith(`native-operation:${scope.data.threadKey}:${scope.data.owner.runId}:`)
    );
  }
  return (
    receipt.version === 1 &&
    isWorkspaceOwner(receipt.owner) &&
    typeof receipt.threadKey === "string" &&
    !!receipt.threadKey &&
    typeof receipt.originalBoot === "string" &&
    !!receipt.originalBoot &&
    typeof receipt.currentBoot === "string" &&
    /^[A-Za-z0-9-]{1,64}$/.test(receipt.currentBoot) &&
    receipt.originalBoot !== receipt.currentBoot &&
    key.startsWith(`native-operation:${receipt.threadKey}:${receipt.owner.runId}:`)
  );
}

/** A read-only early warning for holds that cannot settle through the normal wait.
 * The final fenced preflight still owns the upload decision and any work that
 * starts after this observation. */
export async function residentEarlyHoldProblem(reader: EarlyHoldReader): Promise<string | null> {
  if (reader.signal?.aborted) return "deployment cancelled";
  if (!reader.bearer?.trim()) return unavailable("read bearer missing");
  const listed = await reader.readHealth(
    new URL("/residents", reader.baseUrl).toString(),
    reader.bearer,
    undefined,
    reader.signal,
  );
  if (reader.signal?.aborted) return "deployment cancelled";
  if ("error" in listed || listed.status !== 200) return unavailable("resident list unreadable");
  const body: unknown = listed.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return unavailable("resident list malformed");
  const fleet = body as Record<string, unknown>;
  if (
    !Number.isSafeInteger(fleet.count) ||
    Number(fleet.count) < 0 ||
    fleet.inFlightUnknown !== 0 ||
    !Array.isArray(fleet.residents) ||
    fleet.residents.length !== fleet.count
  )
    return unavailable("resident list incomplete");

  const seenResidents = new Set<string>();
  for (const item of fleet.residents) {
    if (reader.signal?.aborted) return "deployment cancelled";
    if (!item || typeof item !== "object" || Array.isArray(item)) return unavailable("resident row malformed");
    const row = item as Record<string, unknown>;
    if (
      typeof row.resource !== "string" ||
      !RESOURCE.test(row.resource) ||
      (row.replicaOrdinal !== undefined &&
        (!Number.isSafeInteger(row.replicaOrdinal) || Number(row.replicaOrdinal) < 0)) ||
      !row.live ||
      typeof row.live !== "object" ||
      Array.isArray(row.live) ||
      "error" in row.live
    )
      return unavailable("resident row incomplete");
    const resident = row.replicaOrdinal === undefined ? row.resource : `${row.resource}:${row.replicaOrdinal}`;
    if (seenResidents.has(resident)) return unavailable("resident row repeated");
    seenResidents.add(resident);
    if (!reader.postJson) return unavailable("native-operation reader missing");

    let cursor: string | undefined;
    let lastKey: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_RESIDENT; page++) {
      if (reader.signal?.aborted) return "deployment cancelled";
      const answer = await reader.postJson(new URL("/debug", reader.baseUrl).toString(), reader.bearer, {
        op: "native-operations",
        resource: row.resource,
        ...(row.replicaOrdinal === undefined ? {} : { resident: Number(row.replicaOrdinal) + 1 }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (reader.signal?.aborted) return "deployment cancelled";
      if ("error" in answer || answer.status !== 200)
        return unavailable(`native operations unreadable for ${resident}`);
      const operations = answer.body.operations;
      const next = answer.body.cursor;
      if (
        !Array.isArray(operations) ||
        operations.length > 25 ||
        !(next === null || (typeof next === "string" && NATIVE_KEY.test(next))) ||
        (next !== null && (operations.length !== 25 || next !== (operations.at(-1) as { key?: unknown })?.key)) ||
        (cursor !== undefined && next !== null && next <= cursor)
      )
        return unavailable(`native operation page incomplete for ${resident}`);
      for (const item of operations) {
        if (!item || typeof item !== "object" || Array.isArray(item))
          return unavailable(`native operation row malformed for ${resident}`);
        const operation = item as Record<string, unknown>;
        if (
          typeof operation.key !== "string" ||
          !NATIVE_KEY.test(operation.key) ||
          (lastKey !== undefined && operation.key <= lastKey) ||
          typeof operation.recordHash !== "string" ||
          !RECORD_HASH.test(operation.recordHash) ||
          typeof operation.recoverable !== "boolean" ||
          typeof operation.recoveryReason !== "string" ||
          ![
            "original-process-result-required",
            "original-native-evidence-unavailable",
            "legacy-or-invalid-record",
            "original-runtime-retired",
          ].includes(operation.recoveryReason) ||
          operation.recoverable !== (operation.recoveryReason === "original-process-result-required") ||
          (operation.recoveryReason === "original-runtime-retired") !== (operation.retirement !== undefined)
        )
          return unavailable(`native operation row incomplete for ${resident}`);
        lastKey = operation.key;
        if (operation.retirement !== undefined) {
          if (
            !retirementMatches(
              operation.retirement,
              operation.key,
              operation.recordHash,
              row.resource,
              operation.journal,
            )
          )
            return unavailable(`native operation row incomplete for ${resident}`);
          continue;
        }
        if (operation.recoveryReason === "legacy-or-invalid-record")
          return `resident deployment blocked before any Worker upload: ${resident} has unreadable ${JSON.stringify(operation.key)} at ${operation.recordHash}; reconcile this record before deployment`;
        if (
          !operation.journal ||
          typeof operation.journal !== "object" ||
          Array.isArray(operation.journal) ||
          typeof (operation.journal as Record<string, unknown>).closed !== "boolean"
        )
          return unavailable(`native operation status incomplete for ${resident}`);
        if ((operation.journal as Record<string, unknown>).closed === true) {
          const problem = `resident deployment blocked before any Worker upload: ${resident} has closed ${JSON.stringify(operation.key)} at ${operation.recordHash} without original ending evidence; resolve that exact record before deployment`;
          if (!reader.onClosedOperation) return problem;
          reader.onClosedOperation(problem);
        }
      }
      if (next === null) break;
      cursor = next;
      if (page === MAX_PAGES_PER_RESIDENT - 1) return unavailable(`native operation page limit for ${resident}`);
    }
  }
  return null;
}
