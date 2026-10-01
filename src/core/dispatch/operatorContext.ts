import { freshContext } from "./contextSeed.js";
import {
  isContextDependencies,
  mergeContextDependencies,
  type ContextDependencies,
} from "../references/contextDependencies.js";
/** A notes read carries its storage identity; its text never supplies authority. */
export interface OperatorNote {
  session: string;
  text: string;
  updatedAt: number;
}

export interface OperatorSavedContext {
  notes: readonly OperatorNote[];
  unavailable: readonly string[];
  context?: ContextDependencies;
}

export interface OperatorContext extends OperatorSavedContext {
  memory?: string;
}

/** The caller supplies the same authorized saved-context reader used by runs.
 * This composition shares memory retrieval with execution and adds no source policy. */
export async function loadOperatorContext(input: {
  organization: string;
  requester: string;
  channelId: string;
  text: string;
  readNotes?: () => Promise<OperatorSavedContext>;
  /** Only memory admitted for this requester and destination reaches this reader. */
  readMemory?: () => Promise<{ memory?: string; unavailable: readonly string[]; context?: ContextDependencies }>;
}): Promise<OperatorContext> {
  const [saved, memory] = await Promise.allSettled([
    input.readNotes?.() ?? Promise.resolve({ notes: [], unavailable: [] }),
    input.readMemory?.() ?? Promise.resolve({ unavailable: [] }),
  ]);
  const notes: OperatorSavedContext =
    saved.status === "fulfilled" ? saved.value : { notes: [], unavailable: ["Working notes could not be read."] };
  const recalled: Pick<OperatorContext, "memory" | "context" | "unavailable"> =
    memory.status === "fulfilled" ? memory.value : { unavailable: ["Saved memory could not be read."] };
  const notesAdmitted =
    !notes.notes.length || (isContextDependencies(notes.context) && notes.context.status === "known");
  const memoryAdmitted =
    !recalled.memory || (isContextDependencies(recalled.context) && recalled.context.status === "known");
  const contexts = [notesAdmitted ? notes.context : undefined, memoryAdmitted ? recalled.context : undefined].filter(
    (value): value is ContextDependencies => value !== undefined,
  );
  return {
    notes: notesAdmitted ? notes.notes : [],
    unavailable: [
      ...notes.unavailable,
      ...recalled.unavailable,
      ...(!notesAdmitted ? ["Working notes dependencies are unproved."] : []),
      ...(!memoryAdmitted ? ["Saved memory dependencies are unproved."] : []),
    ],
    ...(memoryAdmitted && recalled.memory ? { memory: recalled.memory } : {}),
    context: mergeContextDependencies(freshContext(), ...contexts),
  };
}
