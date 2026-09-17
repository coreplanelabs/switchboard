import { chatActorOf } from "../../core/authz/actor.js";
import { authorize } from "../../core/authz/authorize.js";
import { predicateFor } from "../../core/authz/predicate.js";
import { runResource, type RunsService } from "../../core/runsService.js";
import type { ChannelIO } from "../../core/types.js";
import type { LinearInput } from "./session.js";

/** A platform stop is a control request, subject to the same policy as
 * runs.stop. Access to an agent session never implies team-wide membership. */
export async function stopLinearSession(
  deps: { config: Parameters<typeof chatActorOf>[0]; runs: RunsService },
  input: Extract<LinearInput, { kind: "stop" }>,
  io: ChannelIO,
): Promise<void> {
  const actor = chatActorOf(deps.config, input);
  const listing = await deps.runs.listRuns({
    status: "active",
    threadKey: input.threadKey,
    visibleTo: predicateFor(actor, "runs:read", "run"),
  });
  let stopped = false;
  for (const run of listing.runs) {
    if (run.startedAt > input.receivedAt || !authorize(actor, "runs:write", runResource(run)).allow) continue;
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
  } else await io.reply("No active work that you are authorized to stop was found in this session.");
}
