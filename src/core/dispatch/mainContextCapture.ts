import type { SessionCapability } from "../../tools/session.js";
import type { LedgerRun } from "../runLedger/writeThrough.js";
import type { MainContextRefusalCode } from "../mainContextRefusal.js";
import type { HandoffSource, ParentContext } from "./handoff.js";
import type { HandoffAccess } from "./handoffRuntime.js";
import { contextCapsuleOf, type UnitContext } from "./unitContext.js";

export type { MainContextRefusalCode } from "../mainContextRefusal.js";

/** An intentionally closed vocabulary: errors from the session, dependency and
 * validation stores must never become run events or model-visible replies. */
export class MainContextCaptureError extends Error {
  constructor(readonly code: MainContextRefusalCode) {
    super("Private work context unavailable.");
  }
}

export async function capturePrivateWorkContext(input: {
  run?: Pick<LedgerRun, "tracked" | "checkpointSession" | "lastCheckpointFailure">;
  capability?: Pick<SessionCapability, "captureHandoff"> & { session: Pick<SessionCapability["session"], "key"> };
  captureDependencies?: HandoffAccess["captureDependencies"];
  source: HandoffSource["source"];
  validate: (parent: ParentContext) => Promise<"valid" | "invalid">;
}): Promise<UnitContext> {
  const { run, capability, captureDependencies } = input;
  if (!run?.tracked()) throw new MainContextCaptureError("precondition_untracked");
  if (!capability?.captureHandoff || !captureDependencies)
    throw new MainContextCaptureError("precondition_capture_unavailable");
  let checkpoint;
  try {
    checkpoint = await run.checkpointSession();
    // Only the typed transient state write may be attempted again. The second
    // write belongs to this run, never a replacement run or request source.
    if (!checkpoint && run.tracked() && run.lastCheckpointFailure === "state-unavailable")
      checkpoint = await run.checkpointSession();
  } catch {
    throw new MainContextCaptureError("checkpoint_unknown");
  }
  if (!checkpoint) throw new MainContextCaptureError(`checkpoint_${run.lastCheckpointFailure ?? "unknown"}`);
  if (checkpoint.key !== capability.session.key) throw new MainContextCaptureError("checkpoint_mismatch");

  let dependencyFailed = false;
  let parent: ParentContext;
  try {
    parent = await capability.captureHandoff(
      input.source,
      async (source) => {
        try {
          return await captureDependencies(source);
        } catch {
          dependencyFailed = true;
          throw new MainContextCaptureError("dependencies_failed");
        }
      },
      checkpoint.through,
    );
  } catch {
    throw new MainContextCaptureError(dependencyFailed ? "dependencies_failed" : "snapshot_failed");
  }
  try {
    if ((await input.validate(parent)) !== "valid") throw new MainContextCaptureError("validation_failed");
  } catch {
    throw new MainContextCaptureError("validation_failed");
  }
  try {
    return contextCapsuleOf(parent.handoff!);
  } catch {
    throw new MainContextCaptureError("capsule_invalid");
  }
}
