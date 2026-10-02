import type { SourceReadState } from "../../mcp/sourceReadState.js";
import {
  mergeContextDependencies,
  UNKNOWN_CONTEXT_DEPENDENCIES,
  type ContextDependencies,
} from "../references/contextDependencies.js";
import { referenceReceipt, sourceBinding, sourceHash } from "../references/receipts.js";
import type { IncomingMessage } from "../types.js";
import type { ReferencesResult } from "./references.js";

/** Fresh authenticated input has no inherited source dependencies. */
export const freshContext = (): ContextDependencies => ({
  version: 1,
  status: "known",
  revision: 0,
  origins: [],
  slack: [],
  mcp: [],
});

export function contextForReferences(
  references: Pick<ReferencesResult, "conversations" | "visibilities">,
  msg: Pick<IncomingMessage, "userId" | "channelId" | "threadKey">,
): ContextDependencies {
  const receipts = references.conversations.map((conversation, i) => {
    const visibility = references.visibilities[i];
    return visibility ? referenceReceipt(conversation, visibility, sourceBinding(msg)) : undefined;
  });
  return mergeContextDependencies(freshContext(), {
    ...freshContext(),
    ...(receipts.some((receipt) => receipt === undefined)
      ? { status: "unknown" as const, reason: "legacy" as const }
      : {}),
    slack: receipts.flatMap((receipt) => (receipt ? [receipt] : [])),
  });
}

/** Persist this union with the original action before returning its content. */
export async function contextForSourceReads(state: SourceReadState): Promise<ContextDependencies> {
  let dependencies = freshContext();
  for (const row of state.records) {
    if (!row.exposed) continue;
    if (row.phase !== "settled" || row.response?.status !== "succeeded") {
      dependencies = mergeContextDependencies(dependencies, UNKNOWN_CONTEXT_DEPENDENCIES);
      continue;
    }
    dependencies = mergeContextDependencies(dependencies, {
      ...freshContext(),
      mcp: [
        {
          runId: state.owner.runId,
          actionId: row.actionId,
          callIds: [...row.callIds],
          responseHash: await sourceHash(row.response),
        },
      ],
    });
  }
  return dependencies;
}
