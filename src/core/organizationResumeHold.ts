import type { ResumableRun } from "./boot.js";
import type { RunLedger } from "./runLedger/ledger.js";
import {
  organizationResumeHoldOf,
  type OrganizationResumeHold,
  type OrganizationResumeHoldReason,
} from "./runLedger/organizationResumeHold.js";
import type { LiveRunRow } from "./runLedger/types.js";
import { LEASE_MS } from "./runLedger/types.js";
import { originalStorageFailure } from "./storageFailureDiagnostic.js";
import { captureException } from "./exceptionDiagnostic.js";

interface HeldRun {
  run: ResumableRun;
  lastWrite?: OrganizationResumeHold;
}

interface Options<Source> {
  ledger: Pick<RunLedger, "listLive" | "readInbox" | "setState">;
  gen: string;
  now: () => number;
  binding: (runId: string) => Promise<Source | undefined>;
  eligible: (run: ResumableRun, source: Source) => boolean;
  refusalReason: (
    run: ResumableRun,
    source: Source,
  ) => Extract<OrganizationResumeHoldReason, "source_ineligible" | "intake_completed">;
  warn: (line: string) => void;
  log?: (line: string) => void;
  onDiscard?: (runId: string) => void;
}

export interface VerifiedResumes<Source> {
  runnable: ResumableRun[];
  sources: Map<string, Source>;
}

function safeFailure(error: unknown) {
  const storage = originalStorageFailure(error);
  if (storage)
    return {
      errorKind: "storage" as const,
      operation: storage.operation,
      phase: storage.phase,
      ...(storage.requestId ? { requestId: storage.requestId } : {}),
      ...(storage.httpStatus ? { httpStatus: storage.httpStatus } : {}),
    };
  const exception = captureException(error);
  return {
    errorKind: "exception" as const,
    errorName: exception.name,
    ...(exception.code ? { errorCode: exception.code } : {}),
  };
}

/** The source gate owns a claimed row until it launches or records why it cannot. */
export function createOrganizationResumeHold<Source>(opts: Options<Source>) {
  const held = new Map<string, HeldRun>();
  const checking = new Set<string>();
  const empty = (): VerifiedResumes<Source> => ({ runnable: [], sources: new Map() });

  async function writeHold(run: ResumableRun, reason: OrganizationResumeHoldReason): Promise<void> {
    const id = run.row.runId;
    const previous = held.get(id)?.lastWrite ?? organizationResumeHoldOf(run.row.state);
    const next: OrganizationResumeHold = {
      version: 1,
      revision: (previous?.revision ?? 0) + 1,
      status: "held",
      reason,
      since: previous?.since ?? opts.now(),
      attempts: (previous?.attempts ?? 0) + 1,
      nextCheckAt: opts.now() + LEASE_MS * 2 ** Math.min(previous?.attempts ?? 0, 3),
    };
    held.set(id, { run, lastWrite: next });
    try {
      const saved = await opts.ledger.setState(id, opts.gen, { ...run.row.state, organizationResumeHold: next });
      if (!saved.ok) {
        opts.warn(`[resume] ${id}: source hold could not be recorded (${saved.reason})`);
        return;
      }
      run.row = { ...run.row, state: { ...run.row.state, organizationResumeHold: next } };
      opts.warn(
        JSON.stringify({
          event: "run.resume_source_held",
          runId: id,
          reason,
          attempts: next.attempts,
          heldMs: Math.max(0, opts.now() - next.since),
          nextCheckAt: next.nextCheckAt,
        }),
      );
    } catch (error) {
      opts.warn(
        JSON.stringify({ event: "run.resume_source_hold_write_unconfirmed", runId: id, reason, ...safeFailure(error) }),
      );
    }
  }

  async function release(run: ResumableRun): Promise<boolean> {
    const id = run.row.runId;
    let current: LiveRunRow | undefined;
    try {
      current = (await opts.ledger.listLive()).find((row) => row.runId === id);
    } catch (error) {
      opts.warn(JSON.stringify({ event: "run.resume_source_row_read_failed", runId: id, ...safeFailure(error) }));
      await writeHold(run, "recovery_read_failed");
      return false;
    }
    if (!current || current.ownerGen !== opts.gen) {
      held.delete(id);
      opts.onDiscard?.(id);
      return false;
    }
    run.row = current;
    if (current.stop || current.state.cancellation !== undefined) {
      await writeHold(run, "stop_pending");
      return false;
    }
    const previous = held.get(id)?.lastWrite ?? organizationResumeHoldOf(run.row.state);
    if (previous) {
      const next: OrganizationResumeHold = {
        ...previous,
        revision: previous.revision + 1,
        status: "released",
      };
      held.set(id, { run, lastWrite: next });
      try {
        const saved = await opts.ledger.setState(id, opts.gen, { ...run.row.state, organizationResumeHold: next });
        if (!saved.ok) {
          opts.warn(`[resume] ${id}: source hold release refused (${saved.reason})`);
          return false;
        }
        run.row = { ...run.row, state: { ...run.row.state, organizationResumeHold: next } };
      } catch (error) {
        opts.warn(
          JSON.stringify({ event: "run.resume_source_hold_release_unconfirmed", runId: id, ...safeFailure(error) }),
        );
        return false;
      }
      opts.log?.(`[resume] ${id}: original source verified after ${previous.attempts} held check(s)`);
    }
    held.delete(id);
    return true;
  }

  async function select(runs: readonly ResumableRun[]): Promise<VerifiedResumes<Source>> {
    const result = empty();
    for (const run of runs) {
      const id = run.row.runId;
      const originalId = run.row.meta.organizationIngressRunId;
      if (!originalId) {
        result.runnable.push(run);
        continue;
      }
      if (checking.has(id)) continue;
      checking.add(id);
      try {
        if (run.row.stop || run.row.state.cancellation !== undefined) {
          await writeHold(run, "stop_pending");
          continue;
        }
        let source: Source | undefined;
        try {
          source = await opts.binding(originalId);
          if (!source) {
            await writeHold(run, "source_not_verified");
            continue;
          }
          if (!opts.eligible(run, source)) {
            await writeHold(run, opts.refusalReason(run, source));
            continue;
          }
        } catch (error) {
          opts.warn(JSON.stringify({ event: "run.resume_source_check_failed", runId: id, ...safeFailure(error) }));
          await writeHold(run, "source_check_failed");
          continue;
        }
        if (!(await release(run))) continue;
        result.sources.set(id, source);
        result.runnable.push(run);
      } finally {
        checking.delete(id);
      }
    }
    return result;
  }

  /** A sweep rechecks only rows this generation still owns and has not launched. */
  async function retry(): Promise<VerifiedResumes<Source>> {
    if (held.size === 0) return empty();
    let live: LiveRunRow[];
    try {
      live = await opts.ledger.listLive();
    } catch (error) {
      opts.warn(JSON.stringify({ event: "run.resume_source_sweep_read_failed", ...safeFailure(error) }));
      return empty();
    }
    const rows = new Map(live.map((row) => [row.runId, row]));
    const ready: ResumableRun[] = [];
    for (const [id, entry] of held) {
      const row = rows.get(id);
      if (!row || row.ownerGen !== opts.gen) {
        held.delete(id);
        opts.onDiscard?.(id);
        continue;
      }
      if (checking.has(id) || row.stop || row.state.cancellation !== undefined) continue;
      const reason = entry.lastWrite?.reason ?? organizationResumeHoldOf(row.state)?.reason;
      if (reason === "source_ineligible" || reason === "intake_completed" || reason === "stop_pending") continue;
      const due = entry.lastWrite?.nextCheckAt ?? organizationResumeHoldOf(row.state)?.nextCheckAt;
      if (due !== undefined && due > opts.now()) continue;
      const run = { ...entry.run, row };
      if (run.kind !== "rehost") {
        try {
          const latest = Math.max(
            run.kind === "restart" ? 0 : run.lastStep.inboxConsumedSeq,
            ...run.inbox.map((item) => item.seq),
          );
          run.inbox = [...run.inbox, ...(await opts.ledger.readInbox(id, latest))];
        } catch (error) {
          opts.warn(JSON.stringify({ event: "run.resume_source_inbox_read_failed", runId: id, ...safeFailure(error) }));
          await writeHold(run, "recovery_read_failed");
          continue;
        }
      }
      held.set(id, { run, lastWrite: entry.lastWrite });
      ready.push(run);
    }
    return select(ready);
  }

  return { select, retry, pendingRows: () => [...held.values()].map(({ run }) => run) };
}
