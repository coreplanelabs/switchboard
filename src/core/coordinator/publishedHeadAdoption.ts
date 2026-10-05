import { publicationSettlementForRun } from "../publicationSettlement.js";

const HEAD = /^[a-f0-9]{40}$/;

interface OriginalInstance {
  id: string;
  repo: string;
  base: string;
  userId: string;
  threadKey: string;
}

interface OriginalRow {
  instanceId: string;
  unit: string;
  branch: string;
  threadKey?: string;
  startedAt: number;
  rounds: readonly { index: number; agent: string; outcome: string; at: number }[];
  ending?: { kind: string; at: number };
  idle?: unknown;
  recovery?: unknown;
  pr?: unknown;
  publication?: unknown;
  lastPush?: string;
  adoption?: { state: string };
}

interface OriginalRun {
  id: string;
  parentInstanceId?: string;
  idempotencyKey?: string;
  agent?: string;
  userId?: string;
  repo?: string;
  threadKey?: string;
  startedAt: number;
  finishedAt?: number;
  finished: boolean;
  persisted?: boolean;
  provisional?: boolean;
  restarting?: boolean;
  truncated?: boolean;
  eventCount: number;
  storedEventCount?: number;
  events?: readonly {
    type: string;
    seq?: number;
    tool?: string;
    callId?: string;
    ref?: string;
    sha?: string;
    by?: string;
    receipt?: unknown;
    expectedHeadSha?: string;
    ok?: boolean;
  }[];
  pushed?: readonly { ref: string; sha: string; by?: string }[];
  headSha?: string;
  pr?: unknown;
  doorPublicationPending?: unknown;
  publicationSettlement?: unknown;
}

/** The original runner's accepted remote write, without credit for local or
 *  description bytes. Missing events before the push or an unavailable typed
 *  summary keep the record held. */
export function publishedHeadEvidence(input: {
  instance: OriginalInstance;
  row: OriginalRow;
  run: OriginalRun;
  runs: readonly OriginalRun[];
}): { ok: true; head: string; runId: string } | { ok: false; error: string } {
  const { instance, row, run, runs } = input;
  const refuse = (error: string) => ({ ok: false as const, error });
  if (
    row.instanceId !== instance.id ||
    row.ending === undefined ||
    row.idle !== undefined ||
    row.recovery !== undefined ||
    (row.pr !== undefined && row.adoption?.state !== "bound") ||
    (row.publication !== undefined && row.adoption?.state !== "bound") ||
    row.rounds.length === 0 ||
    row.rounds.some((round) => round.agent !== "coding" || round.index !== 0) ||
    !Number.isFinite(row.startedAt) ||
    row.ending.at < row.startedAt
  )
    return refuse("original_unit_not_terminal");
  if (!run.finished || run.restarting || run.provisional || run.finishedAt === undefined)
    return refuse("original_child_active");
  const key = `${instance.id}:${row.unit}/0/coding`;
  const unitThread = row.threadKey ?? instance.threadKey;
  const owned = runs.filter(
    (candidate) =>
      candidate.idempotencyKey?.startsWith(`${instance.id}:${row.unit}/`) ||
      (candidate.idempotencyKey === undefined &&
        candidate.parentInstanceId === instance.id &&
        candidate.threadKey === unitThread),
  );
  if (owned.length !== 1 || owned[0]?.id !== run.id || run.idempotencyKey !== key)
    return refuse("child_evidence_ambiguous");
  if (owned.some((candidate) => candidate.doorPublicationPending != null) || run.doorPublicationPending != null)
    return refuse("door_publication_unresolved");
  if (
    run.parentInstanceId !== instance.id ||
    run.agent !== "coding" ||
    run.userId !== instance.userId ||
    run.repo?.toLowerCase() !== instance.repo.toLowerCase() ||
    run.threadKey !== (row.threadKey ?? instance.threadKey) ||
    run.startedAt < row.startedAt ||
    run.finishedAt > row.ending.at
  )
    return refuse("child_identity_mismatch");
  if (
    run.persisted !== true ||
    run.events === undefined ||
    typeof run.truncated !== "boolean" ||
    !Number.isSafeInteger(run.eventCount) ||
    run.eventCount < run.events.length ||
    !Number.isSafeInteger(run.storedEventCount) ||
    run.storedEventCount !== run.events.length ||
    (!run.truncated && run.eventCount !== run.events.length)
  )
    return refuse("child_record_incomplete");
  const settlement = publicationSettlementForRun(run.publicationSettlement, run);
  if (
    run.publicationSettlement !== undefined &&
    (settlement?.binding.branch !== row.branch ||
      settlement.checkpoint.kind !== "created" ||
      settlement.publication.kind !== "accepted")
  )
    return refuse("publication_settlement_unverified");
  const events = run.events;
  const pushes = events.filter((event) => event.type === "pushed_head");
  // The producer settlement names the accepted final checkpoint. Earlier
  // native updates and same-head salvage do not create another publication.
  const push = settlement
    ? pushes.filter((event) => event.by === "push").at(-1)
    : pushes.length === 1
      ? pushes[0]
      : undefined;
  if (run.truncated) {
    let nextSeq = 1;
    let pastPush = false;
    for (const event of events) {
      const seq = event.seq;
      if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < nextSeq || seq > run.eventCount)
        return refuse("child_record_incomplete");
      if (!pastPush && seq !== nextSeq) return refuse("child_record_incomplete");
      nextSeq = seq + 1;
      if (event === push) pastPush = true;
    }
  }
  if (push?.ref !== row.branch || push.by !== "push" || !HEAD.test(push.sha ?? "")) return refuse("push_unverified");
  const head = push.sha!;
  if (
    (settlement?.publication.kind === "accepted" && settlement.publication.head !== head) ||
    pushes.some(
      (event) =>
        event.ref !== row.branch ||
        !HEAD.test(event.sha ?? "") ||
        (event.by !== "push" && event.by !== "salvage") ||
        event.receipt !== undefined ||
        (event.by === "salvage" && event.sha !== head),
    )
  )
    return refuse("push_unverified");
  // The Git Door recorder commits this typed acceptance before the tool
  // result. A newly created branch has no old-head authorization event.
  if (
    run.pushed?.length !== 1 ||
    run.pushed[0]?.ref !== row.branch ||
    run.pushed[0].sha !== head ||
    run.pushed[0].by !== pushes.at(-1)?.by ||
    (run.headSha !== undefined && run.headSha !== head) ||
    (row.lastPush !== undefined && row.lastPush !== head) ||
    run.pr !== undefined ||
    events.some((event) => event.type === "pr_opened")
  )
    return refuse("push_unverified");
  return { ok: true, head, runId: run.id };
}
