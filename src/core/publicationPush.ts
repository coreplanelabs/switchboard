import type { ExistingPrPublicationBinding } from "./coordinator/contract.js";
import { COMMAND_CAP, TOOL_OUTPUT_CAP, type RunEvent } from "./runEvents.js";

export interface PublicationPushReceipt {
  callId: string;
  previousHeadSha: string;
  repo: string;
  pr: number;
  owner: ExistingPrPublicationBinding["owner"];
}

type PushEvent = Extract<RunEvent, { type: "pushed_head" }>;
const fullSha = (s: string): boolean => /^[a-f0-9]{40}$/.test(s);
const refName = (s: string): boolean =>
  /^[a-zA-Z0-9_/-]+(?:\.[a-zA-Z0-9_/-]+)*$/.test(s) && !s.includes("..") && !s.startsWith("-");
const shortRef = (s: string): string => s.replace(/^refs\/heads\//, "");

/** Broad enough to count competing Git config pushes; leasedPushCommand
 * separately proves whether one selected call is authorized evidence. */
export const mentionsGitPush = (command: string): boolean => /\bgit(?:\s+-c\s+\S+)*\s+push\b/.test(command);

/** Deliberately not a shell interpreter. Only a standalone literal push can
 * attest its result: pipelines, scripts, substitutions and compound commands
 * cannot prove which operation produced stdout or the successful exit. */
export function leasedPushCommand(command: string): { ref: string; expectedHeadSha: string } | undefined {
  if (command.length >= COMMAND_CAP) return;
  const literal = command.replace(/[ \t]+2>&1[ \t]*$/, "");
  const prefix = /^git(?: -c http\.postBuffer=[0-9]+)? push\s/.exec(literal);
  if (!prefix || /[\n\r'"`$;|<>\\&]/.test(literal)) return;
  const words = literal.slice(prefix[0].length).trim().split(/\s+/);
  const leases = words.filter((w) => w.startsWith("--force-with-lease="));
  if (leases.length !== 1) return;
  const lease = /^--force-with-lease=refs\/heads\/([^:]+):([a-f0-9]{40})$/.exec(leases[0]!);
  if (!lease || !refName(lease[1]!)) return;
  const args = words.filter((w) => w !== leases[0] && w !== "-u" && w !== "--set-upstream");
  if (args.length !== 2 || args[0] !== "origin") return;
  const refs = args[1]!.split(":");
  if (refs.length > 2 || shortRef(refs[0]!) !== lease[1] || shortRef(refs[1] ?? refs[0]!) !== lease[1]) return;
  return { ref: lease[1]!, expectedHeadSha: lease[2]! };
}

/** A legacy record needs the complete pair, never its display summary, an
 * assistant's prose or the remote head alone. More than one attempted push is
 * intentionally ambiguous; historical reconciliation does not choose one. */
export function pairedPublicationPush(
  events: readonly RunEvent[],
  binding: ExistingPrPublicationBinding,
  head: string,
  callId?: string,
  gitDoorBaseUrl?: string,
): PushEvent | undefined {
  if (!fullSha(head) || !fullSha(binding.expectedHeadSha) || head === binding.expectedHeadSha) return;
  const calls = events.filter(
    (e): e is Extract<RunEvent, { type: "tool_call" }> =>
      e.type === "tool_call" &&
      (e.tool === "bash" || e.tool === "publish_branch") &&
      (callId === undefined ? e.tool === "bash" && mentionsGitPush(e.command ?? e.summary) : e.callId === callId),
  );
  if (calls.length !== 1) return;
  const call = calls[0]!;
  if (!call.callId || events.filter((e) => e.type === "tool_call" && e.callId === call.callId).length !== 1) return;
  if (call.tool === "publish_branch") {
    const admissions = events.filter((e) => e.type === "publication_push_authorized" && e.callId === call.callId);
    if (
      admissions.length !== 1 ||
      admissions[0]?.type !== "publication_push_authorized" ||
      admissions[0].ref !== binding.publicationRef ||
      admissions[0].expectedHeadSha !== binding.expectedHeadSha
    )
      return;
  } else {
    if (!call.command) return;
    const command = leasedPushCommand(call.command);
    if (command?.ref !== binding.publicationRef || command.expectedHeadSha !== binding.expectedHeadSha) return;
  }
  const results = events.filter(
    (e): e is Extract<RunEvent, { type: "tool_result" }> => e.type === "tool_result" && e.callId === call.callId,
  );
  if (results.length !== 1) return;
  const result = results[0]!;
  if (
    events.indexOf(result) <= events.indexOf(call) ||
    result.tool !== call.tool ||
    !result.ok ||
    (call.tool === "bash" && result.exitCode !== 0) ||
    result.cut ||
    !result.output ||
    result.output.length >= TOOL_OUTPUT_CAP
  )
    return;
  let lines = result.output.trim().split(/\r?\n/);
  const tracking = [
    `branch '${binding.publicationRef}' set up to track 'origin/${binding.publicationRef}'.`,
    `Branch '${binding.publicationRef}' set up to track remote branch '${binding.publicationRef}' from 'origin'.`,
  ];
  if (
    call.tool === "bash" &&
    /(?:^|\s)(?:-u|--set-upstream)(?:\s|$)/.test(call.command ?? "") &&
    lines.filter((line) => tracking.includes(line)).length === 1
  )
    lines = lines.filter((line) => !tracking.includes(line));
  if (lines.length !== 2) return;
  const githubRemote = /^To (?:https:\/\/github\.com\/|git@github\.com:|github\.com:)([^\s]+?)(?:\.git)?$/.exec(
    lines[0]!,
  );
  let doorRemote: string | undefined;
  if (gitDoorBaseUrl !== undefined) {
    try {
      doorRemote = `${new URL(gitDoorBaseUrl).origin}/git/${binding.repo}`;
    } catch {
      return;
    }
  }
  const remoteMatches =
    doorRemote === undefined
      ? githubRemote?.[1]?.toLowerCase() === binding.repo.toLowerCase()
      : lines[0] === `To ${doorRemote}` || lines[0] === `To ${doorRemote}.git`;
  const update = /^\s*\+?\s*([a-f0-9]{7,40})(\.{2,3})([a-f0-9]{7,40})\s+(\S+) -> (\S+)( \(forced update\))?$/.exec(
    lines[1]!,
  );
  if (
    !remoteMatches ||
    !update ||
    !binding.expectedHeadSha.startsWith(update[1]!) ||
    !head.startsWith(update[3]!) ||
    update[1] === update[3] ||
    shortRef(update[4]!) !== binding.publicationRef ||
    shortRef(update[5]!) !== binding.publicationRef
  )
    return;
  return {
    type: "pushed_head",
    ref: binding.publicationRef,
    sha: head,
    by: "push",
    receipt: {
      callId: call.callId,
      previousHeadSha: binding.expectedHeadSha,
      repo: binding.repo,
      pr: binding.pr,
      owner: { ...binding.owner },
    },
  };
}

/** State is stored JSON, not an unchecked cast back into publication authority. */
export function publicationReceiptsFromState(value: unknown): PushEvent[] {
  if (!Array.isArray(value)) return [];
  const valid = value.every((v) => {
    if (typeof v !== "object" || v === null) return false;
    const r = v.receipt;
    return (
      v.type === "pushed_head" &&
      v.by === "push" &&
      typeof v.ref === "string" &&
      refName(v.ref) &&
      typeof v.sha === "string" &&
      fullSha(v.sha) &&
      typeof r === "object" &&
      r !== null &&
      typeof r.callId === "string" &&
      r.callId.length > 0 &&
      typeof r.previousHeadSha === "string" &&
      fullSha(r.previousHeadSha) &&
      typeof r.repo === "string" &&
      Number.isSafeInteger(r.pr) &&
      r.pr > 0 &&
      typeof r.owner === "object" &&
      r.owner !== null &&
      typeof r.owner.instanceId === "string" &&
      typeof r.owner.unit === "string"
    );
  });
  return valid ? ([...value] as PushEvent[]) : [];
}

/** Only the run's typed, contiguous leased transitions can move its restart
 * fence. The caller still verifies the fresh PR and attached workspace. */
export function restoredPublicationHead(
  events: readonly RunEvent[],
  binding: ExistingPrPublicationBinding,
): string | undefined {
  let head = binding.expectedHeadSha;
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type !== "pushed_head" || e.receipt === undefined) continue;
    const r = e.receipt;
    if (
      e.ref !== binding.publicationRef ||
      r.repo !== binding.repo ||
      r.pr !== binding.pr ||
      r.owner.instanceId !== binding.owner.instanceId ||
      r.owner.unit !== binding.owner.unit ||
      r.previousHeadSha !== head ||
      !fullSha(e.sha) ||
      seen.has(r.callId)
    )
      return;
    seen.add(r.callId);
    head = e.sha;
  }
  return head === binding.expectedHeadSha ? undefined : head;
}
