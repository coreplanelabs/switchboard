import type { Span } from "./types.js";

export type ClosedStageName =
  | "dispatch.operator.source_context"
  | "dispatch.operator.source_rehost"
  | "dispatch.operator.source_history"
  | "dispatch.operator.source_media"
  | "run.source_check.audience"
  | "run.source_check.audience_recheck"
  | "run.source_check.media"
  | "run.source_check.destination"
  | "run.source_check.history"
  | "run.source_check.context"
  | "home.history.resolve_initial"
  | "home.history.original_input"
  | "home.history.epoch_initial"
  | "home.history.stream_tail"
  | "home.history.resolve_after_tail"
  | "home.history.epoch_after_tail"
  | "home.history.context"
  | "home.history.normalize"
  | "home.history.resolve_after_context"
  | "home.history.epoch_after_context"
  | "home.history.attached_metadata"
  | "home.history.binding"
  | "home.epoch.resolve_initial"
  | "home.epoch.authorization"
  | "home.epoch.resolve_reader"
  | "home.epoch.source_catalogue"
  | "home.epoch.source_identity"
  | "home.epoch.policy_observe"
  | "home.epoch.receiver_check"
  | "home.epoch.resolve_receiver"
  | "home.epoch.final_snapshot";

/** Time a source check without copying its exception or private input into the child span. */
export async function closedStage<T>(
  parent: Span,
  name: ClosedStageName,
  work: (child: Span) => Promise<T> | T,
): Promise<T> {
  const child = parent.start(name);
  try {
    const result = await work(child);
    child.end("ok");
    return result;
  } catch (cause) {
    child.end("error");
    throw cause;
  }
}
