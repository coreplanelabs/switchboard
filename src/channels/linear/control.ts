import { chatActorOf } from "../../core/authz/actor.js";
import { authorize } from "../../core/authz/authorize.js";
import { predicateFor } from "../../core/authz/predicate.js";
import { runResource, type RunsService } from "../../core/runsService.js";
import type { ChannelIO } from "../../core/types.js";
import { linearThread, type LinearInput } from "./session.js";
import type { LinearInbox } from "./inbox.js";

/** Native cancellation asks the shared policy for the person's own run or an
 * operator's visible run. Session access never implies team-wide membership. */
export async function stopLinearSession(
  deps: { config: Parameters<typeof chatActorOf>[0]; runs: RunsService; inbox?: Pick<LinearInbox, "cancelPending"> },
  input: Extract<LinearInput, { kind: "stop" }>,
  io: ChannelIO,
): Promise<void> {
  const actor = chatActorOf(deps.config, input);
  let pending = 0;
  if (deps.inbox) {
    const thread = linearThread(input.threadKey);
    if (!thread || !input.userId.startsWith(`linear:${thread.organizationId}:`)) throw new Error("linear_invalid_stop");
    const resource = {
      type: "run" as const,
      id: input.threadKey,
      channelId: input.channelId,
      channelVisibility: "unknown" as const,
      userId: input.userId,
    };
    // With no owner match, only the policy's channel-wide operator rules can
    // authorize all queued people. Session presence supplies no membership.
    const all = authorize(actor, "runs:stop", { ...resource, userId: "" }).allow;
    if (all || authorize(actor, "runs:stop", resource).allow)
      pending = await deps.inbox.cancelPending({
        ...thread,
        receivedAt: input.receivedAt,
        ...(!all ? { userId: input.userId.slice(`linear:${thread.organizationId}:`.length) } : {}),
      });
  }
  const listing = await deps.runs.listRuns({
    status: "active",
    threadKey: input.threadKey,
    visibleTo: predicateFor(actor, "runs:read", "run"),
  });
  let stopped = false;
  for (const run of listing.runs) {
    if (run.startedAt > input.receivedAt || !authorize(actor, "runs:stop", runResource(run)).allow) continue;
    const result = await deps.runs.stopRun(run.id, "hard", { kind: "chat", id: actor.id });
    if (result.ok) stopped = true;
    else if (result.error !== "conflict") throw new Error("linear_stop_unavailable");
  }
  if (stopped) {
    const status = await io.status({
      title: "Stopping",
      detail: "Stop requested. Switchboard is cancelling this session's active work.",
    });
    await status.done({ title: "Stopping" });
    return;
  }
  if (pending) {
    // A terminal response here could close a different person's active session
    // or a newer prompt. A thought acknowledges only the queued cancellation.
    const status = await io.status({
      title: "Stopped queued work",
      detail: "Cancelled pending requests before execution.",
    });
    await status.done({ title: "Stopped queued work" });
  }
  // Do not filter out another person's newer run: an older visible question
  // must never let this Stop close their current session. Metadata stays here;
  // the shared stop policy alone authorizes an effect, and nothing is disclosed.
  const latest = await deps.runs.listRuns({
    status: "all",
    threadKey: input.threadKey,
    visibleTo: { kind: "all" },
    limit: 1,
  });
  const run = latest.runs[0];
  if (latest.storeUnavailable) throw new Error("linear_stop_unavailable");
  if (
    !run ||
    !run.finished ||
    run.startedAt > input.receivedAt ||
    !authorize(actor, "runs:stop", runResource(run)).allow
  )
    return;
  // The final native activity can reach Linear just before its run record lands.
  if (!run.persisted) throw new Error("linear_stop_unavailable");
  if (
    (run.awaitingInput || run.inputStop?.at === input.receivedAt) &&
    run.finishedAt !== undefined &&
    run.finishedAt <= input.receivedAt
  ) {
    const result = await deps.runs.stopRun(
      run.id,
      "hard",
      { kind: "chat", id: actor.id },
      { receivedAt: input.receivedAt },
    );
    if (!result.ok) {
      if (result.error === "conflict") return;
      throw new Error("linear_stop_unavailable");
    }
    await io.reply("Stopped waiting for input. Send a new prompt when you want to continue.");
  }
}
