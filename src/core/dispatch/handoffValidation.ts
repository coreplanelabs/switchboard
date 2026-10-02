// Canonical checks for a child handoff. A manifest identifies evidence; it
// never proves access or substitutes for the source run and durable log.
import { sourceHash } from "../references/receipts.js";
import type { Notepad } from "../runLedger/types.js";
import type { LiveRunRow } from "../runLedger/types.js";
import type { AssembledTranscript } from "../runLedger/transcript.js";
import type { RunSession } from "../runRecord.js";
import type { RunRecord } from "../runRecord.js";
import {
  contextDependenciesContain,
  contextDependenciesHash,
  type ContextDependencies,
} from "../references/contextDependencies.js";
import type { ThreadAsset } from "./threadAssets.js";
import {
  isUnitContext,
  isUnitContextBinding,
  sameUnitContextBinding,
  type UnitContextBinding,
  type UnitContextAdmission,
} from "./unitContext.js";
import {
  isChildHandoff,
  parentContextOf,
  sameHandoffSource,
  snapshotNotepad,
  type ChildHandoff,
  type HandoffConsumer,
  type HandoffSource,
  type ParentContext,
} from "./handoff.js";

export interface CanonicalHandoffRun {
  runId: string;
  requester: string;
  channelId: string;
  threadKey: string;
  session: RunSession;
  /** Last committed source row, obtained from its finished range or live step. */
  writtenThrough: number;
  childHandoff?: unknown;
  /** Canonical source-read state or its completed-run archive, kept on its original run. */
  dependencies?: ContextDependencies;
}

/** Normalize an actual run record/view or live row. A live thread tail is
 * insufficient: the caller supplies the last committed row of this run. */
export function canonicalHandoffRunOf(
  row:
    | (Pick<RunRecord, "id" | "userId" | "channelId" | "threadKey" | "session"> & { childHandoff?: unknown })
    | LiveRunRow,
  liveWrittenThrough?: number,
  dependencies?: ContextDependencies,
): CanonicalHandoffRun | undefined {
  const live = "meta" in row;
  const facts = live ? row.meta : row;
  const session = facts.session;
  const requester = live ? row.meta.userId : row.userId;
  if (!session || session.range === "broken" || !requester || !facts.channelId || !facts.threadKey) return undefined;
  const writtenThrough = session.range.to ?? liveWrittenThrough;
  if (writtenThrough === undefined || !Number.isSafeInteger(writtenThrough) || writtenThrough < -1) return undefined;
  return {
    runId: live ? row.runId : row.id,
    requester,
    channelId: facts.channelId,
    threadKey: facts.threadKey,
    session,
    writtenThrough,
    ...("childHandoff" in facts && facts.childHandoff !== undefined ? { childHandoff: facts.childHandoff } : {}),
    ...(dependencies !== undefined ? { dependencies } : {}),
  };
}

export interface HandoffValidationDeps {
  loadAdmission?(binding: UnitContextBinding, consumer: HandoffConsumer): Promise<UnitContextAdmission | undefined>;
  loadRun(runId: string): Promise<CanonicalHandoffRun | undefined>;
  readSession(key: string, from: number, to: number): Promise<AssembledTranscript>;
  readNotepad(key: string): Promise<Notepad | null>;
  /** Check live requester grants and the destination audience for this source. */
  canRead(source: HandoffSource, consumer: HandoffConsumer): Promise<boolean>;
  /** Read original artifact events through their frozen source cursors. */
  readAssets(source: HandoffSource): Promise<ThreadAsset[]>;
  /** Revalidate the original source leaves, under this exact current destination. */
  validateDependencies(
    dependencies: ContextDependencies,
    source: HandoffSource,
    consumer: HandoffConsumer,
  ): Promise<boolean>;
}

export type HandoffValidation =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "valid"; context: ParentContext & { handoff: ChildHandoff } };

/** Bind once before persistence, then consume only under that exact child
 * identity. Rebuild the prompt from canonical rows even when inline messages
 * were supplied. Absence and invalid state are deliberately distinct. */
export async function validateChildHandoff(input: {
  value: unknown;
  consumer: HandoffConsumer;
  mode: "bind" | "capture" | "admitted-bind" | "consume" | "inherit";
  admission?: UnitContextBinding;
  deps: HandoffValidationDeps;
  inline?: Pick<ParentContext, "messages" | "actors">;
}): Promise<HandoffValidation> {
  if (input.value === undefined) return { kind: "absent" };
  if (!isChildHandoff(input.value)) return { kind: "invalid", reason: "child context manifest is invalid" };
  const handoff = structuredClone(input.value);
  const invalid = (reason: string): HandoffValidation => ({ kind: "invalid", reason });
  const unbound = input.mode === "bind" || input.mode === "capture" || input.mode === "admitted-bind";
  const fresh = input.mode === "bind" || input.mode === "capture";
  if (
    handoff.consumer === undefined
      ? !unbound
      : unbound || (input.mode !== "inherit" && !sameConsumer(handoff.consumer, input.consumer))
  )
    return invalid("child context belongs to another child or has no persisted child binding");
  let immediate: AssembledTranscript | undefined;
  try {
    if (input.mode === "admitted-bind") {
      if (!isUnitContextBinding(input.admission)) return invalid("the unit context binding is missing or invalid");
      const admission = await input.deps.loadAdmission?.(input.admission, input.consumer);
      if (
        !admission ||
        !isUnitContextBinding(admission.binding) ||
        !sameUnitContextBinding(admission.binding, input.admission) ||
        !isUnitContext(admission.context) ||
        (await sourceHash(admission.context.handoff)) !== (await sourceHash(handoff)) ||
        admission.requester !== input.consumer.requester ||
        admission.channelId !== input.consumer.channelId ||
        admission.threadKey !== input.consumer.threadKey ||
        input.consumer.attempt !== input.admission.idempotencyKey
      )
        return invalid("child context does not match the canonical unit and its execution round");
    }
    if (!unbound) {
      const child = await input.deps.loadRun(input.mode === "inherit" ? handoff.consumer!.runId : input.consumer.runId);
      if (
        !child ||
        child.runId !== handoff.consumer!.runId ||
        child.requester !== handoff.consumer!.requester ||
        child.channelId !== handoff.consumer!.channelId ||
        child.threadKey !== handoff.consumer!.threadKey ||
        !isChildHandoff(child.childHandoff) ||
        (await sourceHash(child.childHandoff)) !== (await sourceHash(handoff))
      )
        return invalid("child context does not match the child run's persisted context");
    }
    let inheritedSources: HandoffSource[] = [];
    for (const source of [handoff, ...(handoff.ancestors ?? [])]) {
      const run = await input.deps.loadRun(source.source.runId);
      if (source.source.runId === input.consumer.runId && input.mode !== "capture")
        return invalid("a child cannot name itself as its parent source");
      if (
        !run ||
        run.runId !== source.source.runId ||
        run.requester !== source.source.requester ||
        run.threadKey !== source.source.threadKey ||
        run.channelId !== source.source.channelId
      )
        return invalid("child context source does not match its original run");
      if (
        run.session.range === "broken" ||
        source.session.key !== run.session.key ||
        source.session.from < 0 ||
        source.session.to > run.writtenThrough ||
        !source.window
      )
        return invalid("child context range is outside its original source run");
      if (!(await input.deps.canRead(source, input.consumer)))
        return invalid("child context source access is unavailable");
      if (source === handoff) {
        if (run.childHandoff !== undefined && !isChildHandoff(run.childHandoff))
          return invalid("the source run has invalid inherited context");
        inheritedSources = isChildHandoff(run.childHandoff)
          ? [run.childHandoff, ...(run.childHandoff.ancestors ?? [])]
          : [];
        if (
          inheritedSources.length !== (handoff.ancestors?.length ?? 0) ||
          inheritedSources.some((s) => !handoff.ancestors?.some((a) => sameHandoffSource(a, s)))
        )
          return invalid("child context dropped or invented an inherited source dependency");
        if (fresh) {
          const currentNote = await input.deps.readNotepad(source.session.key);
          if (
            source.notepad === undefined
              ? currentNote !== null
              : currentNote === null || (await snapshotNotepad(currentNote)).hash !== source.notepad.hash
          )
            return invalid("child context notes do not match the source notepad snapshot");
        }
      } else if (!source.snapshotRunId || !inheritedSources.some((s) => sameHandoffSource(source, s))) {
        return invalid("ancestor is not part of the source run's canonical child context");
      }
      let savedSource: HandoffSource | undefined;
      if (source.snapshotRunId && source !== handoff) {
        const snapshot = await input.deps.loadRun(source.snapshotRunId);
        if (!snapshot || !isChildHandoff(snapshot.childHandoff)) return invalid("ancestor snapshot is unavailable");
        const saved = [snapshot.childHandoff, ...(snapshot.childHandoff.ancestors ?? [])].find(
          (s) => s.source.runId === source.source.runId,
        );
        savedSource = saved;
        if (!saved || !sameHandoffSource(source, saved))
          return invalid("ancestor snapshot does not match its original source");
      }
      if (
        source.notepad?.text !== undefined &&
        (await snapshotNotepad({ text: source.notepad.text, updatedAt: source.notepad.updatedAt })).hash !==
          source.notepad.hash
      )
        return invalid("child context notes do not match their saved hash");
      const transcript =
        source.window.to < source.window.from
          ? { complete: true as const, turns: 0, messages: [], compactions: [] }
          : await input.deps.readSession(source.session.key, source.window.from, source.window.to);
      if (
        !transcript.complete ||
        transcript.turns !== Math.max(0, source.window.to - source.window.from + 1) ||
        (await sourceHash({ messages: transcript.messages, actors: transcript.actors ?? [] })) !== source.window.hash
      )
        return invalid("child context body does not match its frozen source rows");
      const dependencies = source.dependencies?.value ?? savedSource?.dependencies?.value;
      if (
        !dependencies ||
        dependencies.status !== "known" ||
        (await contextDependenciesHash(dependencies)) !== source.dependencies?.hash
      )
        return invalid("child context cumulative context dependencies are missing or changed");
      // A new snapshot must cover the current producer. Reuse instead binds
      // the exact manifest already saved on its unit/child (or ancestor), so
      // later unproved producer output cannot invalidate earlier frozen bytes.
      // Original source permissions are still checked below on every read.
      if (fresh && source === handoff) {
        if (!run.dependencies || !contextDependenciesContain(run.dependencies, dependencies))
          return invalid("child context cumulative context dependencies are missing or changed");
        if ((await contextDependenciesHash(run.dependencies)) !== source.dependencies?.hash)
          return invalid("child context omitted a current context dependency");
      }
      if (!(await input.deps.validateDependencies(dependencies, source, input.consumer)))
        return invalid("child context context dependency access is unavailable");
      const assets = await input.deps.readAssets(source);
      if (source.assets.some((asset) => !assets.some((a) => sameAsset(a, asset))))
        return invalid("child context artifact does not match its original producing run");
      if (
        source.assetRuns?.some(
          (cursor) =>
            !assets.some(
              (a) => a.runId === cursor.runId && (cursor.throughSeq === undefined || a.seq === cursor.throughSeq),
            ),
        )
      )
        return invalid("child context artifact cursor does not match its original producing run");
      if (source === handoff) immediate = transcript;
    }
    if (input.mode !== "capture") {
      handoff.consumer = input.consumer;
      handoff.snapshotRunId = input.consumer.runId;
    }
    const context = parentContextOf(immediate!.messages, handoff, immediate!.actors) as ParentContext & {
      handoff: ChildHandoff;
    };
    if (
      input.inline &&
      (await sourceHash({ messages: input.inline.messages, actors: input.inline.actors ?? [] })) !==
        (await sourceHash({ messages: context.messages, actors: context.actors ?? [] }))
    )
      return invalid("inline parent context does not match its frozen source rows");
    return { kind: "valid", context };
  } catch {
    return invalid("child context source could not be checked");
  }
}

function sameConsumer(a: HandoffConsumer, b: HandoffConsumer): boolean {
  return (
    a.runId === b.runId &&
    a.requester === b.requester &&
    a.channelId === b.channelId &&
    a.threadKey === b.threadKey &&
    a.attempt === b.attempt
  );
}
function sameAsset(a: ThreadAsset, b: ThreadAsset): boolean {
  return (
    a.key === b.key &&
    a.runId === b.runId &&
    a.seq === b.seq &&
    a.direction === b.direction &&
    a.name === b.name &&
    a.size === b.size &&
    a.contentType === b.contentType
  );
}
