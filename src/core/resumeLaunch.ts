// Launching the resumes (features/run-history.md item 38): after the Slack
// socket is up, every run the boot reclaim found resumable is planned
// (`planResume`) and dispatched through the ordinary `dispatch()` with a
// `ResumeContext` — so it runs through the same admission, workspace attach,
// tools, post-steps and finish as a fresh run — or, when the plan says
// `interrupted` or the run has no channel to continue on, closed with a record
// exactly as the boot reclaim closes the rest.

import type { AgentDef } from "../agents/registry.js";
import type { ChannelIO, IncomingMessage } from "./types.js";
import type { CoreDeps, DispatchOptions, ResumeContext } from "./dispatcher.js";
import type { RepoContext } from "./repoContext.js";
import type { ResumableRun } from "./boot.js";
import { messageFromInbox } from "./runLedger/inboxMessage.js";
import { planResume, type KnownTool } from "./runLedger/resume.js";
import type { LiveRunRow } from "./runLedger/types.js";
import { TOOLSETS } from "../tools/workspace.js";

/** What the planner needs to know about the agent's static tools: their names
 *  and which are side-effect-free. A bridged MCP tool is deliberately absent —
 *  unknown to the planner, it gets the not-available result (plan D3). */
export function knownToolsFor(agent: Pick<AgentDef, "toolset">): KnownTool[] {
  return (TOOLSETS[agent.toolset] ?? []).map((t) => ({
    name: t.name,
    ...(t.sideEffectFree ? { sideEffectFree: true as const } : {}),
  }));
}

/** The request text of a run, from the `input` event it published first. */
export function inputTextOf(events: readonly { type: string; text?: string }[]): string {
  const input = events.find((e) => e.type === "input");
  return typeof input?.text === "string" ? input.text : "";
}

/** The message a resumed dispatch runs under: the row's identity, and a text
 *  that pins the agent, model and effort the run had so the dispatcher
 *  resolves the same ones (the text itself is only a label — the model sees the
 *  transcript). */
export function resumeMessage(row: LiveRunRow, inputText: string): IncomingMessage {
  const directives = [
    row.meta.agent ? `agent:${row.meta.agent}` : "",
    row.meta.model ? `model:${row.meta.model}` : "",
    row.meta.effort ? `effort:${row.meta.effort}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    channelId: row.meta.channelId,
    userId: row.meta.userId,
    threadKey: row.threadKey,
    text: `${directives} ${inputText}`.trim(),
    ...(row.meta.userName !== undefined ? { userName: row.meta.userName } : {}),
    ...(row.meta.sourceUrl !== undefined ? { sourceUrl: row.meta.sourceUrl } : {}),
  };
}

/** The repo context the run had, from the row's meta — never re-resolved from
 *  the message, whose PR/branch phrasing the previous generation already read. */
export function repoContextOf(row: LiveRunRow): RepoContext {
  const m = row.meta;
  return {
    ...(m.repo !== undefined ? { repo: m.repo } : {}),
    ...(m.ref !== undefined ? { ref: m.ref } : {}),
    ...(m.pr !== undefined ? { pr: m.pr } : {}),
    ...(m.headSha !== undefined ? { headSha: m.headSha } : {}),
  };
}

export interface LaunchResumesOptions {
  /** The channel IO for a row, or undefined when its channel cannot be resumed on. */
  ioFor: (row: LiveRunRow) => ChannelIO | undefined;
  /** Close a run the plan refuses, with the reason (the boot reclaim's closer). */
  close: (run: ResumableRun, why: string) => Promise<void>;
  agentFor: (name: string | undefined) => AgentDef | undefined;
  /** Injectable for tests; default the real `dispatch`. */
  dispatchFn?: (deps: CoreDeps, msg: IncomingMessage, io: ChannelIO, opts: DispatchOptions) => Promise<void>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export interface LaunchOutcome {
  launched: string[];
  closed: { runId: string; why: string }[];
}

/** Plan and start every resumable run. Each dispatch is fire-and-forget (a run
 *  takes minutes); a dispatch that throws is logged, never propagated — the
 *  run's own finally closes its row. Resolves once every run is either
 *  dispatched or closed. */
export async function launchResumes(
  deps: CoreDeps,
  resumable: readonly ResumableRun[],
  opts: LaunchResumesOptions,
): Promise<LaunchOutcome> {
  const log = opts.log ?? (() => {});
  const warn = opts.warn ?? (() => {});
  const dispatchFn = opts.dispatchFn ?? (await import("./dispatcher.js")).dispatch;
  const outcome: LaunchOutcome = { launched: [], closed: [] };
  for (const run of resumable) {
    const { row } = run;
    const agent = opts.agentFor(row.meta.agent);
    if (!agent) {
      await closeWith(run, `agent ${row.meta.agent ?? "(none)"} is unknown to this build`);
      continue;
    }
    if (run.kind === "restart") {
      // Killed while attaching (item 42): the request itself, dispatched again
      // as the message it was — directives included, so the dispatcher resolves
      // the same agent and model — under the row's id and card.
      const restored = messageFromInbox(row.meta.request ?? {}, row.startedAt);
      if (!restored) {
        await closeWith(run, "the row's request has a shape this build cannot read");
        continue;
      }
      const io = opts.ioFor(row);
      if (!io) {
        await closeWith(run, `channel ${row.meta.channelId} cannot be resumed on`);
        continue;
      }
      log(
        `[resume] ${row.runId} ${row.threadKey}: restarting from its request (killed while attaching; ${run.inbox.length} follow-up(s) pending)`,
      );
      outcome.launched.push(row.runId);
      void dispatchFn(deps, restored.msg, io, { restart: { row, inbox: run.inbox } }).catch((err: unknown) =>
        warn(
          `[resume] ${row.runId} ${row.threadKey}: restart dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      continue;
    }
    const plan = planResume({ transcript: run.transcript, lastStep: run.lastStep, tools: knownToolsFor(agent) });
    if (plan.kind === "interrupted") {
      await closeWith(run, plan.why);
      continue;
    }
    const io = opts.ioFor(row);
    if (!io) {
      await closeWith(run, `channel ${row.meta.channelId} cannot be resumed on`);
      continue;
    }
    const lastSeq = run.events.reduce((max, e) => Math.max(max, e.seq), 0);
    const ctx: ResumeContext = {
      row,
      lastStep: run.lastStep,
      plan,
      events: run.events,
      inbox: run.inbox,
      lastSeq,
      repoCtx: repoContextOf(row),
    };
    log(
      `[resume] ${row.runId} ${row.threadKey}: resuming (${plan.stepRecorded ? "settling" : "running fresh"} step ${plan.step}, ${plan.settlements.length} call(s), ${Math.round(plan.remainingMs / 60_000)} min left)`,
    );
    outcome.launched.push(row.runId);
    void dispatchFn(deps, resumeMessage(row, inputTextOf(run.events)), io, { resume: ctx }).catch((err: unknown) =>
      warn(
        `[resume] ${row.runId} ${row.threadKey}: dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
  return outcome;

  async function closeWith(run: ResumableRun, why: string): Promise<void> {
    outcome.closed.push({ runId: run.row.runId, why });
    try {
      await opts.close(run, why);
    } catch (err) {
      warn(`[resume] ${run.row.runId}: could not close: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
