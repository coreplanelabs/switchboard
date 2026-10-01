import type { LeftBehind } from "../execution/residentCleanliness.js";
import { redactAndCap, stripAnsi } from "./redact.js";

export function publicationReason(reason: string): string {
  const withoutSignedUrls = stripAnsi(reason).replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
    try {
      const url = new URL(value);
      return url.search || url.hash ? `${url.origin}${url.pathname}?redacted` : value;
    } catch {
      return value;
    }
  });
  return redactAndCap(withoutSignedUrls, 1023);
}

/** Identity, commit hashes and digests remain exact. Only diagnostic text is
 * redacted before crossing a durable or user-visible boundary. */
export function redactPublicationSettlement(value: PublicationSettlement): PublicationSettlement {
  const reason = <T extends { kind: string }>(part: T): T =>
    "reason" in part && typeof part.reason === "string" ? { ...part, reason: publicationReason(part.reason) } : part;
  return {
    ...value,
    checkpoint: reason(value.checkpoint),
    publication: reason(value.publication),
    preservation: reason(value.preservation),
    release: reason(value.release),
  };
}

/** Producer-owned facts, distinct from the remote PR comparison. This bounded
 * record crosses the live ledger, sealed run and coordinator unchanged. */
export interface PublicationBinding {
  runId: string;
  instanceId: string;
  step: string;
  repo: string;
  branch: string;
  requester: string;
  threadKey: string;
  generation: string;
  baseHeadSha?: string;
}

export interface PublicationSettlement {
  version: 1;
  binding: PublicationBinding;
  checkpoint:
    | { kind: "pending" }
    | { kind: "created" | "clean"; head: string }
    | { kind: "failed" | "unknown"; stage: "observe" | "commit"; reason: string };
  publication:
    | { kind: "not_attempted" | "pending" }
    | { kind: "accepted"; head: string }
    | { kind: "rejected" | "unknown"; reason: string };
  preservation:
    | { kind: "pending" }
    | { kind: "unavailable"; reason: string }
    | { kind: "saved"; key: string; size: number; sha256: string };
  release:
    { kind: "pending" } | { kind: "kept" | "unknown"; reason: string } | { kind: "released"; leftBehind?: LeftBehind };
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024;
const head = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);

export function checkpointKey(binding: PublicationBinding, source: string): string {
  return `runs/${binding.runId}/out/0-checkpoint-${binding.baseHeadSha}-${source}.bundle`;
}

export function isPublicationSettlement(v: unknown): v is PublicationSettlement {
  if (!object(v) || v.version !== 1 || !object(v.binding)) return false;
  const b = v.binding;
  if (
    ![b.runId, b.instanceId, b.step, b.repo, b.branch, b.requester, b.threadKey, b.generation].every(text) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(String(b.runId)) ||
    (b.baseHeadSha !== undefined && !head(b.baseHeadSha))
  )
    return false;
  const c = v.checkpoint,
    p = v.publication,
    a = v.preservation,
    r = v.release;
  if (!object(c) || !object(p) || !object(a) || !object(r)) return false;
  if (!(
    c.kind === "pending" ||
    ((c.kind === "created" || c.kind === "clean") && head(c.head)) ||
    ((c.kind === "failed" || c.kind === "unknown") && (c.stage === "observe" || c.stage === "commit") && text(c.reason))
  ))
    return false;
  if (!(
    p.kind === "not_attempted" ||
    p.kind === "pending" ||
    (p.kind === "accepted" && c.kind === "created" && p.head === c.head) ||
    ((p.kind === "rejected" || p.kind === "unknown") && text(p.reason))
  ))
    return false;
  if (!(
    a.kind === "pending" ||
    (a.kind === "unavailable" && text(a.reason)) ||
    (a.kind === "saved" &&
      c.kind === "created" &&
      head(b.baseHeadSha) &&
      a.key === checkpointKey(b as unknown as PublicationBinding, String(c.head)) &&
      Number.isSafeInteger(a.size) &&
      Number(a.size) > 0 &&
      typeof a.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(a.sha256))
  ))
    return false;
  if (r.kind === "pending" || ((r.kind === "kept" || r.kind === "unknown") && text(r.reason))) return true;
  return (
    r.kind === "released" &&
    (r.leftBehind === undefined ||
      (object(r.leftBehind) &&
        [r.leftBehind.uncommittedChanges, r.leftBehind.unpushedCommits].every(
          (n) => Number.isSafeInteger(n) && Number(n) >= 0,
        )))
  );
}

/** A receipt is evidence only for the run and attempt that own it. Both the
 * stored-record validator and artifact reader use this same binding check. */
export function publicationSettlementForRun(value: unknown, owner: unknown): PublicationSettlement | undefined {
  if (!isPublicationSettlement(value) || !object(owner)) return;
  const binding = value.binding;
  if (
    binding.runId !== owner.id ||
    binding.instanceId !== owner.parentInstanceId ||
    binding.step !== owner.idempotencyKey ||
    binding.repo !== owner.repo ||
    binding.requester !== owner.userId ||
    binding.threadKey !== owner.threadKey
  )
    return;
  return value;
}

export function publicationSettlementOf(
  events: readonly { type: string; settlement?: unknown }[],
): PublicationSettlement | undefined {
  let latest: PublicationSettlement | undefined;
  for (const event of events)
    if (event.type === "publication_settlement" && isPublicationSettlement(event.settlement)) latest = event.settlement;
  return latest;
}

export function publicationSettlementSummary(value: PublicationSettlement | null | undefined): string {
  if (value === null) return "the canonical checkpoint receipt is invalid; recovery remains held";
  if (!value) return "local work preservation was not recorded; recovery remains unverified";
  const c = value.checkpoint;
  const checkpoint =
    c.kind === "created"
      ? `local checkpoint ${c.head}`
      : c.kind === "clean"
        ? "the workspace was measured clean with no unpushed commits"
        : c.kind === "failed"
          ? `checkpoint ${c.stage} failed`
          : "the local checkpoint outcome is unknown";
  const artifact =
    value.preservation.kind === "saved"
      ? `saved privately as ${value.preservation.key}`
      : "no verified recovery artifact";
  const release =
    value.release.kind === "released"
      ? "the checkout was released"
      : value.release.kind === "kept"
        ? "checkout release was deferred; later retention is unverified"
        : "checkout release is unverified";
  return `${checkpoint}; ${artifact}; ${release}`;
}

/** A fresh writer requires positive no-work evidence, never missing evidence. */
export function publicationHasNoWork(value: PublicationSettlement | null | undefined): boolean {
  return value?.checkpoint.kind === "clean" && value.publication.kind === "not_attempted";
}
