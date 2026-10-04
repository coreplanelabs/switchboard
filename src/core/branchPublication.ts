import { parsePushed, type PushedBranch } from "../execution/residentRebind.js";

/** Producer facts retained independently of the bounded display event stream. */
export interface BranchPublication {
  version: 1;
  repo?: string;
  branches: PushedBranch[];
  complete: boolean;
  pending?: { id: string; ref?: string; headSha: string; pr?: number };
}

export function branchPublicationOf(value: unknown, repo?: string): BranchPublication | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
    (v.repo !== undefined && (typeof v.repo !== "string" || !v.repo)) ||
    (repo !== undefined && v.repo !== undefined && v.repo !== repo)
  )
    return undefined;
  if (typeof v.complete !== "boolean") return undefined;
  const parsed = parsePushed(v.branches);
  if (
    v.branches === undefined ||
    "error" in parsed ||
    new Set(parsed.pushed.map((b) => b.ref)).size !== parsed.pushed.length
  )
    return undefined;
  if ((parsed.pushed.length > 0 || v.pending !== undefined) && v.repo === undefined) return undefined;
  if (v.pending !== undefined) {
    if (v.complete || typeof v.pending !== "object" || v.pending === null) return undefined;
    const p = v.pending as Record<string, unknown>;
    if (
      typeof p.id !== "string" ||
      !p.id ||
      (p.ref !== undefined && (typeof p.ref !== "string" || !p.ref)) ||
      typeof p.headSha !== "string" ||
      !/^[0-9a-f]{40}$/.test(p.headSha)
    )
      return undefined;
    if (p.pr !== undefined && (!Number.isSafeInteger(p.pr) || (p.pr as number) <= 0)) return undefined;
    if (p.ref === undefined && p.pr === undefined) return undefined;
  }
  return structuredClone(value) as BranchPublication;
}
