import { freshContext } from "./contextSeed.js";
import type { AudienceCheck } from "../audienceDecision.js";
import {
  contextDependenciesOf,
  mergeContextDependencies,
  type ContextDependencies,
} from "../references/contextDependencies.js";
import type { RunLedger } from "../runLedger/ledger.js";
import type { RunView } from "../runsService.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import { privateAudienceDecision, privateAudienceRequired } from "./privateAudience.js";
import type { OperatorNote, OperatorSavedContext } from "./operatorContext.js";

export interface OperatorNotesInput {
  ledger: Pick<RunLedger, "readSessionTail" | "readNotepad">;
  /** The caller's run-read capability has already admitted these identities. */
  runs: readonly RunView[];
  msg: IncomingMessage;
  io: ChannelIO;
  /** The current source owner's canonical read check, bound to this requester
   * and destination. No saved permission stamp can substitute for this call. */
  validateDependencies?: (context: ContextDependencies) => Promise<AudienceCheck>;
  normalizeDependencies?: (
    contexts: readonly ContextDependencies[],
    candidates: readonly ContextDependencies[],
  ) => Promise<ContextDependencies[]>;
}

/** Read notes as a source-aware projection of the ledger, independent of model
 * compaction. An unsupported source loses its own note, never the new request. */
export async function readOperatorNotes(input: OperatorNotesInput): Promise<OperatorSavedContext> {
  const { ledger, msg, io } = input;
  const sessions = [
    ...new Set(
      input.runs
        .filter(
          (run) =>
            typeof run.userId === "string" &&
            run.userId.length > 0 &&
            run.channelId === msg.channelId &&
            run.threadKey === msg.threadKey,
        )
        .flatMap((run) => (run.session?.key ? [run.session.key] : [])),
    ),
  ];
  const read = async (
    session: string,
  ): Promise<{ note?: OperatorNote; context?: ContextDependencies; unavailable?: string }> => {
    const omit = (reason: string) => ({ unavailable: `Working notes for ${session} are unavailable: ${reason}.` });
    try {
      const stored = await ledger.readNotepad(session);
      const notepad = stored ? { ...stored } : undefined;
      if (!notepad?.text.trim()) return {};
      // Source dependencies are persisted before their text is exposed to the
      // notes writer. Read their metadata after this note snapshot, so a source
      // acquired concurrently cannot hide behind an older metadata read.
      // The tail's source metadata is independent of its byte window.
      const tail = await ledger.readSessionTail(session, 1);
      const sources = tail.sources;
      const saved = structuredClone(contextDependenciesOf(sources));
      let components: ContextDependencies[] = [
        saved,
        ...input.runs
          .filter(
            (run) => run.session?.key === session && run.channelId === msg.channelId && run.threadKey === msg.threadKey,
          )
          .flatMap((run) =>
            run.userId && run.channelId && run.threadKey
              ? [
                  {
                    ...freshContext(),
                    origins: [
                      { runId: run.id, requester: run.userId, channelId: run.channelId, threadKey: run.threadKey },
                    ],
                  },
                ]
              : [],
          ),
      ];
      if (input.normalizeDependencies) components = await input.normalizeDependencies(components, [saved]);
      const context = mergeContextDependencies(...components);
      if (context.status !== "known" || !input.validateDependencies) return omit("saved-context-unproved");
      const checked = await input.validateDependencies(context);
      if (!checked.ok) return omit(checked.code);
      if (privateAudienceRequired(msg)) {
        const checked = await privateAudienceDecision(msg, io);
        if (!checked.ok) return omit(checked.code);
      }
      return { note: { session, text: notepad.text, updatedAt: notepad.updatedAt }, context };
    } catch {
      return omit("the current storage or source check could not complete");
    }
  };
  const results = await Promise.all(sessions.map(read));
  return {
    context: mergeContextDependencies(
      freshContext(),
      ...results.flatMap((result) => (result.context ? [result.context] : [])),
    ),
    notes: results.flatMap((result) => (result.note ? [result.note] : [])),
    unavailable: results.flatMap((result) => (result.unavailable ? [result.unavailable] : [])),
  };
}
