import { isUnitStatusReference, unitStatusIdentity, type UnitStatusReference } from "./unitStatusReference.js";
import { isSlackSourceReceipt, type SlackSourceReceipt } from "./sourceReceipt.js";

import { isSourceReadReference, type SourceReadReference } from "../../mcp/sourceReadState.js";
export { isSourceReadReference, type SourceReadReference } from "../../mcp/sourceReadState.js";

export interface ContextOrigin {
  runId: string;
  /** Committed canonical session checkpoint, checked by the storage reader. */
  checkpoint?: string;
  requester: string;
  channelId: string;
  threadKey: string;
}

/** Cumulative dependencies of everything admitted to a context, including
 * summaries and notes. Each leaf keeps its original audience and action. */
export interface ContextDependencies {
  version: 1 | 2;
  status: "known" | "unknown" | "revoked";
  revision: number;
  origins: readonly ContextOrigin[];
  slack: readonly SlackSourceReceipt[];
  mcp: readonly SourceReadReference[];
  /** One catalog-access leaf, containing the original exposed repository names. */
  githubRepos?: readonly string[];
  /** Exact native results reusable only by the original acknowledged execution. */
  executionGithub?: readonly ExecutionGithubReference[];
  /** Storage scopes remain access dependencies after their content is transformed. */
  memoryScopes?: readonly string[];
  /** Immutable typed work status in the existing coordinator/session stores. */
  unitStatuses?: readonly UnitStatusReference[];
  reason?: "legacy" | "overflow" | "equivocation" | "invalid";
}
export interface ExecutionGithubReference {
  runId: string;
  callId: string;
  resultHash: string;
  admissionHash: string;
}
export function isExecutionGithubReference(value: unknown): value is ExecutionGithubReference {
  if (!value || typeof value !== "object") return false;
  const r = value as ExecutionGithubReference;
  return (
    Object.keys(r).every((key) => ["runId", "callId", "resultHash", "admissionHash"].includes(key)) &&
    [r.runId, r.callId].every((v) => typeof v === "string" && v.length > 0 && v.length <= 256) &&
    [r.resultHash, r.admissionHash].every((v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))
  );
}
const executionKey = (r: ExecutionGithubReference) => JSON.stringify([r.runId, r.callId]);
export const CONTEXT_DEPENDENCY_MAX = 32;
export const CONTEXT_GITHUB_REPO_MAX = 256;
export const CONTEXT_MEMORY_SCOPE_MAX = 256;
export const CONTEXT_DEPENDENCY_MAX_BYTES = 16 * 1024;
export const UNKNOWN_CONTEXT_DEPENDENCIES: ContextDependencies = Object.freeze({
  version: 1,
  status: "unknown",
  revision: 0,
  origins: Object.freeze([]),
  slack: Object.freeze([]),
  mcp: Object.freeze([]),
  reason: "legacy",
});

const boundedString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
export function isContextDependencies(value: unknown): value is ContextDependencies {
  if (!value || typeof value !== "object") return false;
  const c = value as ContextDependencies;
  return (
    (c.version === 1 ? c.executionGithub === undefined : c.version === 2) &&
    (c.executionGithub === undefined ||
      (Array.isArray(c.executionGithub) &&
        c.executionGithub.length <= 256 &&
        c.executionGithub.every(isExecutionGithubReference) &&
        new Set(c.executionGithub.map(executionKey)).size === c.executionGithub.length)) &&
    ["known", "unknown", "revoked"].includes(c.status) &&
    Number.isSafeInteger(c.revision) &&
    c.revision >= 0 &&
    Array.isArray(c.origins) &&
    c.origins.every(isContextOrigin) &&
    Array.isArray(c.slack) &&
    Array.isArray(c.mcp) &&
    (c.githubRepos === undefined ||
      (Array.isArray(c.githubRepos) &&
        c.githubRepos.length <= CONTEXT_GITHUB_REPO_MAX &&
        c.githubRepos.every(isGithubRepo) &&
        new Set(c.githubRepos.map((repo) => repo.toLowerCase())).size === c.githubRepos.length)) &&
    (c.memoryScopes === undefined ||
      (Array.isArray(c.memoryScopes) &&
        c.memoryScopes.length <= CONTEXT_MEMORY_SCOPE_MAX &&
        c.memoryScopes.every(isMemoryScopeKey) &&
        new Set(c.memoryScopes).size === c.memoryScopes.length)) &&
    (c.unitStatuses === undefined ||
      (Array.isArray(c.unitStatuses) &&
        c.unitStatuses.length <= 256 &&
        c.unitStatuses.every(isUnitStatusReference) &&
        new Set(c.unitStatuses.map(unitStatusIdentity)).size === c.unitStatuses.length)) &&
    c.origins.length +
      c.slack.length +
      c.mcp.length +
      (c.executionGithub?.length ? 1 : 0) +
      (c.githubRepos?.length ? 1 : 0) +
      (c.memoryScopes?.length ? 1 : 0) +
      (c.unitStatuses?.length ? 1 : 0) <=
      CONTEXT_DEPENDENCY_MAX &&
    c.slack.every(isSlackSourceReceipt) &&
    c.mcp.every(isSourceReadReference) &&
    (c.reason === undefined || ["legacy", "overflow", "equivocation", "invalid"].includes(c.reason)) &&
    (c.status !== "known" || c.reason === undefined) &&
    new Set(c.origins.map((o) => o.runId)).size === c.origins.length &&
    new Set(c.mcp.map(mcpKey)).size === c.mcp.length &&
    new Set(c.slack.map(canonical)).size === c.slack.length &&
    !conflictingEvidence(c.slack, c.mcp) &&
    bytes(c) <= CONTEXT_DEPENDENCY_MAX_BYTES
  );
}

export function contextDependenciesOf(value: { context?: ContextDependencies } | undefined): ContextDependencies {
  return value?.context && isContextDependencies(value.context) ? value.context : UNKNOWN_CONTEXT_DEPENDENCIES;
}

/** Pure synchronous union for the existing storage transaction. Unknown and
 * revoked inputs remain tainted; overflow preserves existing leaves and names
 * the gap. This helper does not grant authority to a supplied reference. */
export function mergeContextDependencies(...values: readonly (ContextDependencies | undefined)[]): ContextDependencies {
  if (values.length === 0) return UNKNOWN_CONTEXT_DEPENDENCIES;
  let result: ContextDependencies | undefined;
  for (const value of values) {
    const next: ContextDependencies = normalize(
      value === undefined
        ? UNKNOWN_CONTEXT_DEPENDENCIES
        : isContextDependencies(value)
          ? value
          : { ...UNKNOWN_CONTEXT_DEPENDENCIES, reason: "invalid" },
    );
    if (!result) {
      result = normalize(next);
      continue;
    }
    const previous = result;
    let status: ContextDependencies["status"] =
      previous.status === "revoked" || next.status === "revoked"
        ? "revoked"
        : previous.status === "unknown" || next.status === "unknown"
          ? "unknown"
          : "known";
    let reason = previous.reason ?? next.reason;
    const origins = [...previous.origins];
    const slack = [...previous.slack];
    const mcp = [...previous.mcp];
    const githubRepos = [...(previous.githubRepos ?? [])];
    const memoryScopes = [...(previous.memoryScopes ?? [])];
    const unitStatuses = [...(previous.unitStatuses ?? [])];
    const executionGithub = [...(previous.executionGithub ?? [])];
    const version = previous.version === 2 || next.version === 2 ? (2 as const) : (1 as const);
    const groups = [
      ["githubRepos", githubRepos, next.githubRepos ?? [], CONTEXT_GITHUB_REPO_MAX],
      ["memoryScopes", memoryScopes, next.memoryScopes ?? [], CONTEXT_MEMORY_SCOPE_MAX],
    ] as const;
    for (const [field, current, incoming, limit] of groups)
      for (const key of incoming) {
        if (current.includes(key)) continue;
        const candidate = {
          version,
          status,
          revision: 0,
          origins,
          slack,
          mcp,
          githubRepos,
          memoryScopes,
          unitStatuses,
          executionGithub,
          [field]: [...current, key],
        };
        if (
          candidate[field].length > limit ||
          origins.length +
            slack.length +
            mcp.length +
            (candidate.githubRepos.length ? 1 : 0) +
            (candidate.memoryScopes.length ? 1 : 0) +
            (unitStatuses.length ? 1 : 0) >
            CONTEXT_DEPENDENCY_MAX - (executionGithub.length ? 1 : 0) ||
          bytes(candidate) > CONTEXT_DEPENDENCY_MAX_BYTES - 128
        ) {
          if (status !== "revoked") status = "unknown";
          reason = "overflow";
          continue;
        }
        current.push(key);
      }
    for (const reference of next.unitStatuses ?? []) {
      const previous = unitStatuses.find((r) => unitStatusIdentity(r) === unitStatusIdentity(reference));
      if (previous) {
        if (canonical(previous) !== canonical(reference)) {
          if (status !== "revoked") status = "unknown";
          reason = "equivocation";
        }
        continue;
      }
      const candidate = {
        version,
        status,
        revision: 0,
        origins,
        slack,
        mcp,
        githubRepos,
        memoryScopes,
        unitStatuses: [...unitStatuses, reference],
        executionGithub,
      };
      if (
        candidate.unitStatuses.length > 256 ||
        origins.length + slack.length + mcp.length + (githubRepos.length ? 1 : 0) + (memoryScopes.length ? 1 : 0) + 1 >
          CONTEXT_DEPENDENCY_MAX - (executionGithub.length ? 1 : 0) ||
        bytes(candidate) > CONTEXT_DEPENDENCY_MAX_BYTES - 128
      ) {
        if (status !== "revoked") status = "unknown";
        reason = "overflow";
        continue;
      }
      unitStatuses.push(reference);
    }
    for (const origin of next.origins) {
      const existing = origins.find((o) => o.runId === origin.runId);
      if (existing) {
        const { checkpoint: oldCheckpoint, ...oldIdentity } = existing;
        const { checkpoint: newCheckpoint, ...newIdentity } = origin;
        if (
          canonical(oldIdentity) === canonical(newIdentity) &&
          (!oldCheckpoint || !newCheckpoint || oldCheckpoint === newCheckpoint)
        ) {
          if (newCheckpoint && !oldCheckpoint) origins[origins.indexOf(existing)] = origin;
          continue;
        }
        if (canonical(existing) !== canonical(origin)) {
          if (status !== "revoked") status = "unknown";
          reason = "equivocation";
        }
        continue;
      }
      const candidate = {
        version,
        status,
        revision: 0,
        origins: [...origins, origin],
        slack,
        mcp,
        githubRepos,
        memoryScopes,
        unitStatuses,
        executionGithub,
      };
      if (
        candidate.origins.length +
          slack.length +
          mcp.length +
          (githubRepos.length ? 1 : 0) +
          (memoryScopes.length ? 1 : 0) +
          (unitStatuses.length ? 1 : 0) >
          CONTEXT_DEPENDENCY_MAX - (executionGithub.length ? 1 : 0) ||
        bytes(candidate) > CONTEXT_DEPENDENCY_MAX_BYTES - 128
      ) {
        if (status !== "revoked") status = "unknown";
        reason = "overflow";
        continue;
      }
      origins.push(origin);
    }
    for (const receipt of next.slack) {
      if (slack.some((r) => canonical(r) === canonical(receipt))) continue;
      if (conflictingEvidence([...slack, receipt], mcp)) {
        if (status !== "revoked") status = "unknown";
        reason = "equivocation";
        continue;
      }
      const candidate = {
        version,
        status,
        revision: 0,
        origins,
        slack: [...slack, receipt],
        mcp,
        githubRepos,
        memoryScopes,
        unitStatuses,
        executionGithub,
      };
      if (
        origins.length +
          candidate.slack.length +
          mcp.length +
          (githubRepos.length ? 1 : 0) +
          (memoryScopes.length ? 1 : 0) +
          (unitStatuses.length ? 1 : 0) >
          CONTEXT_DEPENDENCY_MAX - (executionGithub.length ? 1 : 0) ||
        bytes(candidate) > CONTEXT_DEPENDENCY_MAX_BYTES - 128
      ) {
        if (status !== "revoked") status = "unknown";
        reason = "overflow";
        continue;
      }
      slack.push(receipt);
    }
    for (const reference of next.mcp) {
      const existing = mcp.find((r) => mcpKey(r) === mcpKey(reference));
      if (existing) {
        if (canonical(existing) !== canonical(reference)) {
          if (status !== "revoked") status = "unknown";
          reason = "equivocation";
        }
        continue;
      }
      const candidate = {
        version,
        status,
        revision: 0,
        origins,
        slack,
        mcp: [...mcp, reference],
        githubRepos,
        memoryScopes,
        unitStatuses,
        executionGithub,
      };
      if (
        origins.length +
          slack.length +
          candidate.mcp.length +
          (githubRepos.length ? 1 : 0) +
          (memoryScopes.length ? 1 : 0) +
          (unitStatuses.length ? 1 : 0) >
          CONTEXT_DEPENDENCY_MAX - (executionGithub.length ? 1 : 0) ||
        bytes(candidate) > CONTEXT_DEPENDENCY_MAX_BYTES - 128
      ) {
        if (status !== "revoked") status = "unknown";
        reason = "overflow";
        continue;
      }
      mcp.push(reference);
    }
    for (const reference of next.executionGithub ?? []) {
      const existing = executionGithub.find((r) => executionKey(r) === executionKey(reference));
      if (existing) {
        if (canonical(existing) !== canonical(reference)) {
          if (status !== "revoked") status = "unknown";
          reason = "equivocation";
        }
        continue;
      }
      if (
        executionGithub.length >= 256 ||
        bytes({
          version,
          status,
          revision: 0,
          origins,
          slack,
          mcp,
          githubRepos,
          memoryScopes,
          unitStatuses,
          executionGithub: [...executionGithub, reference],
        }) >
          CONTEXT_DEPENDENCY_MAX_BYTES - 128 ||
        origins.length +
          slack.length +
          mcp.length +
          (githubRepos.length ? 1 : 0) +
          (memoryScopes.length ? 1 : 0) +
          (unitStatuses.length ? 1 : 0) +
          1 >
          CONTEXT_DEPENDENCY_MAX
      ) {
        if (status !== "revoked") status = "unknown";
        reason = "overflow";
        continue;
      }
      executionGithub.push(reference);
    }
    const revision = Math.max(previous.revision, next.revision);
    const merged = normalize({
      version,
      status,
      revision,
      origins,
      slack,
      mcp,
      ...(githubRepos.length ? { githubRepos } : {}),
      ...(memoryScopes.length ? { memoryScopes } : {}),
      ...(unitStatuses.length ? { unitStatuses } : {}),
      ...(executionGithub.length ? { executionGithub } : {}),
      ...(status !== "known" && reason ? { reason } : {}),
    });
    if (sameContent(previous, merged)) result = { ...merged, revision };
    else if (sameContent(next, merged) && next.revision > previous.revision) result = merged;
    else if (revision < Number.MAX_SAFE_INTEGER) result = { ...merged, revision: revision + 1 };
    else result = { ...merged, status: status === "revoked" ? status : "unknown", reason: "overflow" };
  }
  if (bytes(result) > CONTEXT_DEPENDENCY_MAX_BYTES) {
    const origins = [...result!.origins];
    const slack = [...result!.slack];
    const mcp = [...result!.mcp];
    const githubRepos = [...(result!.githubRepos ?? [])];
    const memoryScopes = [...(result!.memoryScopes ?? [])];
    const unitStatuses = [...(result!.unitStatuses ?? [])];
    const executionGithub = [...(result!.executionGithub ?? [])];
    result = {
      ...result!,
      status: result!.status === "revoked" ? "revoked" : "unknown",
      reason: "overflow",
      origins,
      slack,
      mcp,
      ...(githubRepos.length ? { githubRepos } : {}),
      ...(memoryScopes.length ? { memoryScopes } : {}),
      ...(unitStatuses.length ? { unitStatuses } : {}),
      ...(executionGithub.length ? { executionGithub } : {}),
    };
    while (bytes(result) > CONTEXT_DEPENDENCY_MAX_BYTES) {
      if (executionGithub.length) executionGithub.pop();
      else if (unitStatuses.length) unitStatuses.pop();
      else if (memoryScopes.length) memoryScopes.pop();
      else if (githubRepos.length) githubRepos.pop();
      else if (mcp.length) mcp.pop();
      else if (slack.length) slack.pop();
      else if (origins.length) origins.pop();
      else break;
    }
  }
  return result!;
}

/** A current cumulative envelope can prove an older frozen view only while
 * its provenance is complete and every original leaf is still present. */
export function contextDependenciesContain(current: ContextDependencies, snapshot: ContextDependencies): boolean {
  if (
    !isContextDependencies(current) ||
    !isContextDependencies(snapshot) ||
    current.status !== "known" ||
    snapshot.status !== "known" ||
    current.revision < snapshot.revision
  )
    return false;
  return (
    snapshot.origins.every((o) =>
      current.origins.some(
        (c) =>
          c.runId === o.runId &&
          c.requester === o.requester &&
          c.channelId === o.channelId &&
          c.threadKey === o.threadKey &&
          (o.checkpoint === undefined || c.checkpoint === o.checkpoint),
      ),
    ) &&
    snapshot.slack.every((r) => current.slack.some((c) => canonical(c) === canonical(r))) &&
    snapshot.mcp.every((r) => current.mcp.some((c) => canonical(c) === canonical(r))) &&
    (snapshot.executionGithub ?? []).every((r) =>
      current.executionGithub?.some((c) => canonical(c) === canonical(r)),
    ) &&
    (snapshot.githubRepos ?? []).every((repo) =>
      current.githubRepos?.some((currentRepo) => currentRepo.toLowerCase() === repo.toLowerCase()),
    ) &&
    (snapshot.memoryScopes ?? []).every((scope) => current.memoryScopes?.includes(scope)) &&
    (snapshot.unitStatuses ?? []).every((ref) => current.unitStatuses?.some((r) => canonical(r) === canonical(ref)))
  );
}

export async function contextDependenciesHash(value: ContextDependencies): Promise<string> {
  if (!isContextDependencies(value)) throw new Error("invalid context dependencies");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(normalize(value))));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalize(value: ContextDependencies): ContextDependencies {
  const { githubRepos, memoryScopes, unitStatuses, executionGithub, ...rest } = value;
  return {
    ...rest,
    ...(executionGithub?.length
      ? { executionGithub: [...executionGithub].sort((a, b) => compareText(executionKey(a), executionKey(b))) }
      : {}),
    ...(githubRepos?.length
      ? { githubRepos: [...githubRepos].map((repo) => repo.toLowerCase()).sort(compareText) }
      : {}),
    ...(memoryScopes?.length ? { memoryScopes: [...memoryScopes].sort(compareText) } : {}),
    ...(unitStatuses?.length
      ? { unitStatuses: [...unitStatuses].sort((a, b) => compareText(unitStatusIdentity(a), unitStatusIdentity(b))) }
      : {}),
    origins: [...value.origins].sort((a, b) => compareText(a.runId, b.runId)),
    slack: [...value.slack].sort((a, b) => compareText(canonical(a), canonical(b))),
    mcp: value.mcp
      .map((r) => ({ ...r, callIds: [...r.callIds].sort() }))
      .sort((a, b) => compareText(mcpKey(a), mcpKey(b))),
  };
}
function isContextOrigin(value: unknown): value is ContextOrigin {
  if (!value || typeof value !== "object") return false;
  const o = value as ContextOrigin;
  return (
    [o.runId, o.requester, o.channelId, o.threadKey].every(boundedString) &&
    (o.checkpoint === undefined || (typeof o.checkpoint === "string" && /^[a-f0-9]{64}$/.test(o.checkpoint)))
  );
}
function mcpKey(reference: SourceReadReference): string {
  return JSON.stringify([reference.runId, reference.actionId]);
}
function sameContent(a: ContextDependencies, b: ContextDependencies): boolean {
  return canonical({ ...a, revision: 0 }) === canonical({ ...b, revision: 0 });
}
function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compareText(a, b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function conflictingEvidence(slack: readonly SlackSourceReceipt[], mcp: readonly SourceReadReference[]): boolean {
  const facts = new Map<string, string>();
  const record = (key: string, evidence: string): boolean => {
    const previous = facts.get(key);
    facts.set(key, evidence);
    return previous !== undefined && previous !== evidence;
  };
  for (const receipt of slack) {
    for (const message of receipt.messages)
      if (
        record(
          JSON.stringify(["message", receipt.source.channelId, receipt.source.threadKey, message.id]),
          message.hash,
        )
      )
        return true;
    if (receipt.file && record(JSON.stringify(["file", receipt.source.channelId, receipt.file.id]), receipt.file.hash))
      return true;
  }
  for (const ref of mcp) if (record(mcpKey(ref), canonical({ ...ref, callIds: [...ref.callIds].sort() }))) return true;
  return false;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isGithubRepo(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value);
}

/** Metadata counts as exposure too. Overflow remains explicit provenance,
 * never a silently shortened declaration of what the model consumed. */
export function githubRepositoryDependencies(repos: readonly string[]): ContextDependencies {
  let context: ContextDependencies = { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] };
  for (const repo of repos)
    context = mergeContextDependencies(context, {
      version: 1,
      status: "known",
      revision: 0,
      origins: [],
      slack: [],
      mcp: [],
      githubRepos: [repo],
    });
  return context;
}

function isMemoryScopeKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256 || !/^(org|user|channel|repo):[^\s]+$/.test(value)) return false;
  return !value.startsWith("repo:") || isGithubRepo(value.slice(5));
}

export function memoryScopeDependencies(scopes: readonly string[]): ContextDependencies {
  let context: ContextDependencies = { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] };
  for (const scope of scopes)
    context = mergeContextDependencies(context, {
      version: 1,
      status: "known",
      revision: 0,
      origins: [],
      slack: [],
      mcp: [],
      memoryScopes: [scope],
    });
  return context;
}
