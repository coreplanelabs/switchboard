import {
  mainTaskClaimMatches,
  STEP_NAME_PATTERN,
  unitOfIdempotencyKey,
  type CoordinatorInstance,
  type CoordinatorUnit,
} from "../coordinator/contract.js";
import { parsePrivateWorkerThreadKey, privateWorkerThreadKey } from "../privateWorkerLog.js";
import { directAudienceStampOf } from "../runLedger/inboxMessage.js";
import { isUnitContext, isUnitContextBinding } from "./unitContext.js";
import { reflectionActor } from "../memory/reflection.js";
import { readCoordinatorStatus } from "../coordinator/unitStatus.js";
import type { UnitStatusReference } from "../references/unitStatusReference.js";
import {
  applyContextCheckpointAliases,
  checkpointOutsideOrdinaryWindow,
  normalizeCheckpointContexts,
  validateContextCheckpoint,
  type CanonicalCheckpointSource,
} from "../references/contextCheckpoint.js";
import type { ConversationRef } from "../references/types.js";
import type { MemoryScope } from "../memory/types.js";
import { githubCapabilityFor } from "./run.js";
import type { ChannelIO, IncomingMessage, SlackDirectAudience } from "../types.js";
import type { MemoryRecord } from "../memory/types.js";
import { frozenMemoryRecord, validMemoryProvenance } from "../memory/provenance.js";
import type { CoreDeps } from "../dispatcher.js";
import { chatActorOf } from "../authz/actor.js";
import { authorize } from "../authz/authorize.js";
import type { AudienceCheck } from "../audienceDecision.js";
import { RUN_EVENTS_MAX_PAGE, operatorOfEvents, type RunOperatorDecision, type RunRecord } from "../runRecord.js";
import type { LiveRunRow } from "../runLedger/types.js";
import { executionAdmissionHash, recordedGithubRead, currentGithubReadCapability } from "./executionGithubContext.js";
import { isSourceResultReceipt } from "../references/sourceResultContext.js";
import {
  isContextDependencies,
  contextDependenciesOf,
  mergeContextDependencies,
  memoryScopeDependencies,
  contextDependenciesContain,
  type ContextDependencies,
  type ContextOrigin,
} from "../references/contextDependencies.js";
import { sourceReadState } from "../../mcp/sourceReadState.js";
import { inspectStoredSourceRead } from "../../mcp/sourceRead.js";
import { PRIVATE_WORKER_INTERNAL_READ } from "../runsService.js";
import { privateAudienceDecision, revalidateSourcesDecision } from "./privateAudience.js";
import { canonicalHandoffRunOf } from "./handoffValidation.js";
import { isChildHandoff, type HandoffSource } from "./handoff.js";
import type { HandoffAccess, HandoffAccessFactory } from "./handoffRuntime.js";
import { threadAssetsOf, type ThreadAsset } from "./threadAssets.js";
import { systemClock } from "../trace/clock.js";

type StoredContextRun = RunRecord | LiveRunRow;
export type ContextAccessDeps = Pick<
  CoreDeps,
  | "config"
  | "runStore"
  | "runLedger"
  | "runs"
  | "mcp"
  | "slackContextForRun"
  | "artifacts"
  | "githubApi"
  | "coordinatorInstances"
>;
const denied = (): AudienceCheck => ({ ok: false, code: "saved-context-unproved" });

/** Validate only the inputs admitted to this execution. A stored session can
 * also contain omitted legacy rows or live-only results that cannot be reused. */
export async function revalidateAdmittedContext(
  current: () => ContextDependencies,
  validate: (snapshot: ContextDependencies) => Promise<AudienceCheck>,
): Promise<AudienceCheck> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const snapshot = structuredClone(current());
      if (!isContextDependencies(snapshot) || snapshot.status !== "known") return denied();
      const revision = JSON.stringify(snapshot);
      const checked = await validate(snapshot);
      if (!checked.ok) return checked;
      if (JSON.stringify(current()) === revision) return checked;
    }
  } catch {
    // Missing proof cannot authorize publication.
  }
  return denied();
}
const factsOf = (row: StoredContextRun) => ("meta" in row ? { ...row.meta, id: row.runId } : row);

/** One current reader over the existing run, session and adapter seams.
 * Canonical dependencies describe what to check; none of their bytes grant access. */
export interface MessageContextAccess {
  validateDependencies(context: ContextDependencies): Promise<AudienceCheck>;
  normalizeDependencies(
    contexts: readonly ContextDependencies[],
    candidates: readonly ContextDependencies[],
  ): Promise<ContextDependencies[]>;
  canReadOrigin(origin: ContextOrigin): Promise<boolean>;
  readRunDependencies(runId: string): Promise<ContextDependencies | undefined>;
  readOperatorDecision(
    runId: string,
  ): Promise<{ operator: RunOperatorDecision; context: ContextDependencies } | undefined>;
  authorizeMemory(candidate: MemoryRecord): Promise<AudienceCheck>;
}

export function contextAccessForMessage(
  deps: ContextAccessDeps,
  input: { msg: IncomingMessage; io: ChannelIO },
): MessageContextAccess {
  return buildContextAccess(deps, input).message;
}

/** Only the active execution controller supplies this identity, never a message or handoff reader. */
export function contextAccessForExecution(
  deps: ContextAccessDeps,
  input: {
    msg: IncomingMessage;
    io: ChannelIO;
    executionConsumer: { runId: string; gen: string; admissionHash: string };
  },
): MessageContextAccess {
  return buildContextAccess(deps, input).message;
}

export function contextAccessForRun(deps: ContextAccessDeps): HandoffAccessFactory {
  return ({ consumer, msg, io }): HandoffAccess => {
    const access = buildContextAccess(deps, { msg, io });
    return {
      ...access.handoff,
      canRead: async (source, who) =>
        who.requester === msg.userId &&
        who.channelId === consumer.channelId &&
        who.threadKey === consumer.threadKey &&
        (await access.message.canReadOrigin(source.source)),
    };
  };
}

function buildContextAccess(
  deps: ContextAccessDeps,
  {
    msg,
    io,
    executionConsumer,
  }: {
    msg: IncomingMessage;
    io: ChannelIO;
    executionConsumer?: { runId: string; gen: string; admissionHash: string };
  },
) {
  const actor = () => chatActorOf(deps.config, msg);
  const load = async (id: string): Promise<StoredContextRun | undefined> => {
    const live = (await deps.runLedger.readLiveRuns()).find((row) => row.runId === id);
    return live ?? (await deps.runStore.get(id)) ?? undefined;
  };
  const admitted = (row: StoredContextRun): boolean => {
    const facts = factsOf(row);
    return authorize(actor(), "runs:read", {
      type: "run",
      id: facts.id,
      userId: facts.userId,
      channelId: facts.channelId,
      channelVisibility: facts.channelVisibility ?? "unknown",
      ...(facts.repo ? { repo: facts.repo } : {}),
    }).allow;
  };
  const unitFor = async (instanceId: string, unitId: string) => {
    const instance = await deps.coordinatorInstances?.get(instanceId);
    if (!instance || instance.id !== instanceId) return undefined;
    const units = await deps.coordinatorInstances!.listUnits(instanceId);
    const matching = units.filter((unit) => unit.unit === unitId);
    if (matching.length !== 1 || matching[0].instanceId !== instance.id) return undefined;
    return { instance, unit: matching[0], count: units.length };
  };
  const stepMatches = (key: string | undefined, instanceId: string, unit: string): boolean => {
    if (!key?.startsWith(`${instanceId}:`) || unitOfIdempotencyKey(key) !== unit) return false;
    return STEP_NAME_PATTERN.test(key.slice(instanceId.length + 1));
  };
  // A worker thread is an internal execution address. Only its original
  // stored main decision identifies the real private delivery audience.
  const privateUnitAudience = async (
    instance: CoordinatorInstance,
    unit: CoordinatorUnit,
  ): Promise<SlackDirectAudience | undefined> => {
    const brief = unit.workBrief;
    if (
      !brief ||
      unit.reviewThread !== undefined ||
      unit.threadKey !== privateWorkerThreadKey({ instanceId: instance.id, unit: unit.unit }) ||
      !mainTaskClaimMatches({ mainThreadKey: brief.mainThreadKey, actId: brief.actId }, instance, unit)
    )
      return undefined;
    const link = await deps.coordinatorInstances?.getMainTask({
      mainThreadKey: brief.mainThreadKey,
      actId: brief.actId,
    });
    if (
      link?.instanceId !== instance.id ||
      link.unit !== unit.unit ||
      link.authority?.requesterId !== instance.userId ||
      link.authority.repo.toLowerCase() !== instance.repo.toLowerCase()
    )
      return undefined;
    return directAudienceStampOf({
      ...instance,
      directAudience: {
        kind: "slack-unshared-im",
        userId: instance.userId,
        channelId: instance.channelId,
        threadKey: instance.threadKey,
      },
    });
  };
  const destinationAudience = async (): Promise<SlackDirectAudience | undefined> => {
    if (!msg.threadKey.startsWith("worker:"))
      return (await privateAudienceDecision(msg, io)).ok ? directAudienceStampOf(msg) : undefined;
    const worker = parsePrivateWorkerThreadKey(msg.threadKey);
    if (!worker || msg.directAudience !== undefined) return undefined;
    const stored = await unitFor(worker.instanceId, worker.unit);
    if (
      !stored ||
      stored.instance.userId !== msg.userId ||
      stored.instance.channelId !== msg.channelId ||
      !stepMatches(msg.messageId, worker.instanceId, worker.unit)
    )
      return undefined;
    const audience = await privateUnitAudience(stored.instance, stored.unit);
    if (!audience || !(await io.verifyPrivateWorkerAudience?.(msg))?.ok) return undefined;
    return audience;
  };
  const originMessage = (origin: Pick<ContextOrigin, "channelId" | "threadKey">) => ({
    ...msg,
    channelId: origin.channelId,
    threadKey: origin.threadKey,
    text: "",
    directAudience: undefined,
  });
  const sourceAllowedAtDestination = async (ref: ConversationRef): Promise<boolean> => {
    let destination = msg;
    if (msg.threadKey.startsWith("worker:")) {
      const audience = await destinationAudience();
      if (!audience) return false;
      destination = { ...msg, channelId: audience.channelId, threadKey: audience.threadKey, directAudience: audience };
    }
    return (await deps.slackContextForRun?.(actor(), destination).canReadSource?.(ref)) === true;
  };
  const originAllowed = async (origin: ContextOrigin): Promise<boolean> => {
    const row = await load(origin.runId);
    if (!row || !admitted(row)) return false;
    const source = factsOf(row);
    if (
      source.id !== origin.runId ||
      source.userId !== origin.requester ||
      source.channelId !== origin.channelId ||
      source.threadKey !== origin.threadKey
    )
      return false;
    if (origin.checkpoint !== undefined) {
      const checkpoint = await deps.runLedger.readContextCheckpoint(origin.runId);
      if (
        !checkpoint?.receipt ||
        checkpoint.receipt.hash !== origin.checkpoint ||
        checkpoint.runId !== origin.runId ||
        checkpoint.meta.userId !== origin.requester ||
        checkpoint.meta.channelId !== origin.channelId ||
        checkpoint.meta.threadKey !== origin.threadKey ||
        !(await validateContextCheckpoint(checkpoint.receipt, checkpoint))
      )
        return false;
    }
    if (msg.threadKey.startsWith("worker:") && !(await destinationAudience())) return false;
    let visibilityOrigin = origin;
    if (origin.threadKey.startsWith("worker:")) {
      const worker = parsePrivateWorkerThreadKey(origin.threadKey);
      if (
        !worker ||
        source.parentInstanceId !== worker.instanceId ||
        !stepMatches(source.idempotencyKey, worker.instanceId, worker.unit) ||
        origin.requester !== msg.userId
      )
        return false;
      const stored = await unitFor(worker.instanceId, worker.unit);
      if (!stored || stored.instance.userId !== origin.requester || stored.instance.channelId !== origin.channelId)
        return false;
      const audience = await privateUnitAudience(stored.instance, stored.unit);
      if (!audience) return false;
      visibilityOrigin = { ...origin, channelId: audience.channelId, threadKey: audience.threadKey };
    }
    if (!origin.channelId.startsWith("slack:"))
      return origin.requester === msg.userId && origin.channelId === msg.channelId;
    const capability = deps.slackContextForRun?.(actor(), originMessage(visibilityOrigin));
    const visibility = await capability?.originAudience?.();
    if (visibility === undefined) return false;
    if (visibility === "public")
      return sourceAllowedAtDestination({
        channelId: visibilityOrigin.channelId,
        threadKey: visibilityOrigin.threadKey,
        url: "",
      });
    if (origin.requester !== msg.userId) return false;
    if (origin.channelId === msg.channelId && visibility !== "dm") return true;
    return (await destinationAudience()) !== undefined;
  };
  const unitStatusAllowed = async (ref: UnitStatusReference): Promise<boolean> => {
    const stored = await unitFor(ref.instanceId, ref.unit);
    if (
      !stored ||
      stored.instance.userId !== ref.requester ||
      stored.instance.channelId !== ref.channelId ||
      (stored.instance.attempt ?? 0) < ref.attempt ||
      stored.instance.repo.toLowerCase() !== ref.repo ||
      !deps.config.canUseRepo(actor(), ref.repo)
    )
      return false;
    const snapshot = await readCoordinatorStatus(deps.runLedger, ref);
    if (!snapshot) return false;
    let sourceThread = ref.threadKey;
    if (stored.unit.workBrief) {
      const audience = await privateUnitAudience(stored.instance, stored.unit);
      if (
        !audience ||
        ref.requester !== msg.userId ||
        ref.threadKey !== privateWorkerThreadKey({ instanceId: ref.instanceId, unit: ref.unit }) ||
        ref.destinationThreadKey !== audience.threadKey ||
        snapshot.actId !== stored.unit.workBrief.actId ||
        !(await destinationAudience())
      )
        return false;
      sourceThread = audience.threadKey;
    } else if (
      snapshot.actId !== undefined ||
      ref.threadKey !== (stored.unit.threadKey ?? (stored.count === 1 ? stored.instance.threadKey : undefined)) ||
      ref.destinationThreadKey !== ref.threadKey
    )
      return false;
    const visibility = ref.channelId.startsWith("slack:")
      ? await deps
          .slackContextForRun?.(actor(), originMessage({ channelId: ref.channelId, threadKey: sourceThread }))
          .originAudience?.()
      : undefined;
    if (ref.channelId.startsWith("slack:")) {
      if (!visibility) return false;
      if (visibility !== "public") {
        if (ref.requester !== msg.userId) return false;
        if ((visibility === "dm" || ref.channelId !== msg.channelId) && !(await destinationAudience())) return false;
      }
    } else if (ref.requester !== msg.userId || ref.channelId !== msg.channelId) return false;
    return authorize(actor(), "runs:read", {
      type: "run",
      id: stored.instance.runId ?? stored.instance.id,
      userId: ref.requester,
      channelId: ref.channelId,
      channelVisibility: visibility ?? "unknown",
      repo: ref.repo,
    }).allow;
  };
  const validate = async (dependencies: ContextDependencies): Promise<AudienceCheck> => {
    if (!isContextDependencies(dependencies) || dependencies.status !== "known") return denied();
    try {
      dependencies = structuredClone(dependencies);
      if (msg.threadKey.startsWith("worker:") && !(await destinationAudience())) return denied();
      if (dependencies.executionGithub?.length) {
        if (!executionConsumer) return denied();
        const current = (await deps.runLedger.readLiveRuns()).find((row) => row.runId === executionConsumer.runId);
        if (
          !current ||
          current.ownerGen !== executionConsumer.gen ||
          current.meta.agent === "orchestrator" ||
          current.meta.userId !== msg.userId ||
          current.meta.channelId !== msg.channelId ||
          current.meta.threadKey !== msg.threadKey ||
          current.meta.authenticatedAs !== msg.authenticatedAs ||
          current.meta.postedBy !== msg.postedBy ||
          (await executionAdmissionHash(current.meta)) !== executionConsumer.admissionHash ||
          !current.meta.session?.key
        )
          return denied();
        const retained = await deps.runLedger.readSession(current.meta.session.key, current.meta.session.seedFrom);
        if (!retained.complete) return denied();
        const receipts = Array.isArray(current.state.sourceResults)
          ? current.state.sourceResults.filter(isSourceResultReceipt)
          : [];
        const github = githubCapabilityFor(deps, actor());
        for (const ref of dependencies.executionGithub) {
          if (ref.runId !== current.runId || ref.admissionHash !== executionConsumer.admissionHash) return denied();
          const receipt = receipts.find(
            (r) =>
              r.version === 2 &&
              r.runId === ref.runId &&
              r.callId === ref.callId &&
              r.resultHash === ref.resultHash &&
              r.admissionHash === ref.admissionHash,
          );
          if (!receipt) return denied();
          const original = await recordedGithubRead(retained.messages, receipt);
          if (!original || !(await currentGithubReadCapability(receipt, original, github, current.meta.agent!)))
            return denied();
        }
        const final = (await deps.runLedger.readLiveRuns()).find((row) => row.runId === current.runId);
        if (
          !final ||
          final.ownerGen !== executionConsumer.gen ||
          (await executionAdmissionHash(final.meta)) !== executionConsumer.admissionHash
        )
          return denied();
      }

      for (const status of dependencies.unitStatuses ?? []) if (!(await unitStatusAllowed(status))) return denied();
      for (const key of dependencies.memoryScopes ?? []) {
        const kind = key.slice(0, key.indexOf(":")) as MemoryScope;
        if (
          !authorize(reflectionActor(actor(), { channelId: msg.channelId }), "memory:read", {
            type: "memory-scope",
            key,
            kind,
          }).allow
        )
          return denied();
      }
      if (dependencies.githubRepos?.length) {
        const current = await githubCapabilityFor(deps, actor(), {
          requesterId: msg.userId,
          verifiedDirectAudience:
            directAudienceStampOf(msg) !== undefined && (await destinationAudience()) !== undefined,
        }).readableRepos?.(dependencies.githubRepos);
        const readable = new Set(current?.map((repo) => repo.fullName.toLowerCase()));
        if (dependencies.githubRepos.some((repo) => !readable.has(repo.toLowerCase()))) return denied();
      }
      for (const origin of dependencies.origins) {
        if (!(await originAllowed(origin))) return denied();
      }
      const slack = await revalidateSourcesDecision(dependencies.slack, async (receipt) => {
        if (
          receipt.requester !== msg.userId ||
          !deps.slackContextForRun ||
          !(await sourceAllowedAtDestination(receipt.source))
        )
          return false;
        if (
          receipt.visibility !== "public" &&
          receipt.source.channelId !== msg.channelId &&
          !(await destinationAudience())
        )
          return false;
        const original = {
          ...msg,
          userId: receipt.requester,
          channelId: receipt.origin.channelId,
          threadKey: receipt.origin.threadKey,
          text: "",
          directAudience: undefined,
        };
        return deps.slackContextForRun(actor(), original).revalidateSource(receipt);
      });
      if (!slack.ok) return slack;
      for (const reference of dependencies.mcp) {
        const row = await load(reference.runId);
        if (!row || !admitted(row)) return denied();
        const source = factsOf(row);
        if (!source.agent) return denied();
        const owner = {
          runId: source.id,
          requester: source.userId,
          agent: source.agent,
          channelId: source.channelId,
          threadKey: source.threadKey,
        };
        const archive = "meta" in row ? row.state.sourceReads : row.sourceReads;
        const state = sourceReadState(archive, owner);
        if (!state) return denied();
        const audience = await destinationAudience();
        if (!audience) return denied();
        const tools = await deps.mcp.toolsFor(owner.agent, {
          userId: msg.userId,
          channelId: audience.channelId,
          directAudience: audience,
        });
        const decision = await inspectStoredSourceRead({
          state,
          owner,
          reference,
          requester: msg.userId,
          operations: tools.tools.flatMap((tool) => (tool.sourceRead ? [tool.sourceRead] : [])),
          now: systemClock,
          audience: async () =>
            (await originAllowed({
              runId: source.id,
              requester: source.userId,
              channelId: source.channelId,
              threadKey: source.threadKey,
            })) && (await destinationAudience()) !== undefined,
        });
        if (!decision.ok) return decision;
      }
      return { ok: true };
    } catch {
      return denied();
    }
  };
  const canReadOrigin = async (origin: ContextOrigin): Promise<boolean> => {
    try {
      return await originAllowed(origin);
    } catch {
      return false;
    }
  };
  const normalizeDependencies = async (
    contexts: readonly ContextDependencies[],
    candidates: readonly ContextDependencies[],
  ): Promise<ContextDependencies[]> => {
    const sources: CanonicalCheckpointSource[] = [];
    const seen = new Set<string>();
    const expired = new Set<string>();
    for (const context of [...candidates, ...contexts]) {
      if (!isContextDependencies(context)) continue;
      for (const origin of context.origins) {
        const identity = `${origin.runId}:${origin.checkpoint}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const identityContext: ContextDependencies = {
          version: 1,
          status: "known",
          revision: 0,
          origins: [origin],
          slack: [],
          mcp: [],
        };
        if (sources.some((source) => applyContextCheckpointAliases(identityContext, source) !== identityContext))
          continue;
        try {
          if (!(await canReadOrigin(origin))) continue;
          const source = await deps.runLedger.readContextCheckpoint(origin.runId);
          if (
            !source?.receipt ||
            source.runId !== origin.runId ||
            source.meta.userId !== origin.requester ||
            source.meta.channelId !== origin.channelId ||
            source.meta.threadKey !== origin.threadKey ||
            (origin.checkpoint !== undefined && source.receipt.hash !== origin.checkpoint) ||
            !(await validateContextCheckpoint(source.receipt, source))
          )
            continue;
          if (sources.some((latest) => checkpointOutsideOrdinaryWindow(source, latest))) {
            expired.add(identity);
            continue;
          }
          sources.push(source);
        } catch {
          // Normalization is optional; original admitted dependencies remain.
        }
      }
    }
    const normalized = await normalizeCheckpointContexts(contexts, sources);
    return normalized.map((context, index) =>
      context.status === "known" &&
      contexts[index]!.origins.some((origin) => expired.has(`${origin.runId}:${origin.checkpoint}`))
        ? { ...context, status: "unknown", reason: "legacy" }
        : context,
    );
  };
  const readRunDependencies = async (runId: string): Promise<ContextDependencies | undefined> => {
    try {
      const row = await load(runId);
      if (!row || factsOf(row).id !== runId || !admitted(row)) return undefined;
      const source = factsOf(row);
      const origin = { runId, requester: source.userId, channelId: source.channelId, threadKey: source.threadKey };
      if (!(await originAllowed(origin))) return undefined;
      // A completed run's archive is immutable. A later shared session may
      // contain unrelated work and cannot fill a missing producer envelope.
      const raw = "meta" in row ? row.state.contextDependencies : row.contextDependencies;
      if (!isContextDependencies(raw) || raw.status !== "known") return undefined;
      let context = structuredClone(raw);
      if ("meta" in row) {
        if (!row.meta.session?.key) return undefined;
        const latest = await deps.runLedger.readSessionTail(row.meta.session.key, 1);
        context = mergeContextDependencies(context, contextDependenciesOf(latest.sources));
      }
      if (!(await validate(context)).ok || !(await originAllowed(origin))) return undefined;
      return context;
    } catch {
      return undefined;
    }
  };
  const authorizeMemory = async (record: MemoryRecord): Promise<AudienceCheck> => {
    try {
      const candidate = frozenMemoryRecord(record);
      if (!candidate.sourceRunId || !(await validMemoryProvenance(candidate))) return denied();
      const row = await load(candidate.sourceRunId);
      if (!row || factsOf(row).threadKey !== candidate.sourceThreadKey) return denied();
      const producer = await readRunDependencies(candidate.sourceRunId);
      const context = candidate.provenance?.dependencies;
      if (!producer || !context || !contextDependenciesContain(context, producer)) return denied();
      return validate(mergeContextDependencies(context, memoryScopeDependencies([candidate.scopeKey])));
    } catch {
      return denied();
    }
  };
  const readOperatorDecision = async (
    runId: string,
  ): Promise<{ operator: RunOperatorDecision; context: ContextDependencies } | undefined> => {
    try {
      const stored = await load(runId);
      if (!stored || "meta" in stored) return undefined;
      // Snapshot the actual immutable event before any asynchronous source
      // check. List projections and incomplete/live records cannot supply it.
      const record = structuredClone(stored);
      if (
        record.id !== runId ||
        record.agent !== "door" ||
        record.provisional ||
        !Number.isFinite(record.finishedAt) ||
        record.channelId !== msg.channelId ||
        record.threadKey !== msg.threadKey ||
        !admitted(record) ||
        record.events.filter((event) => event.type === "operator").length !== 1
      )
        return undefined;
      const operator = operatorOfEvents(record.events);
      const raw = record.contextDependencies;
      if (!operator || !isContextDependencies(raw) || raw.status !== "known") return undefined;
      const context = mergeContextDependencies(raw, {
        version: 1,
        status: "known",
        revision: 0,
        slack: [],
        mcp: [],
        origins: [{ runId, requester: record.userId, channelId: record.channelId, threadKey: record.threadKey }],
      });
      if (!(await validate(context)).ok) return undefined;
      return { operator, context };
    } catch {
      return undefined;
    }
  };
  const captureDependencies = async (source: HandoffSource): Promise<ContextDependencies> => {
    const row = await load(source.source.runId);
    if (!row || factsOf(row).session?.key !== source.session.key || !(await canReadOrigin(source.source)))
      throw new Error("source run is unavailable");
    const context = await readRunDependencies(source.source.runId);
    if (!context) throw new Error("source dependencies are unavailable");
    return context;
  };
  const readAssets = async (source: HandoffSource): Promise<ThreadAsset[]> => {
    const cursors = new Map<string, number | undefined>();
    for (const ref of source.assetRuns ??
      source.assets.map((asset) => ({ runId: asset.runId, throughSeq: asset.seq }))) {
      const previous = cursors.get(ref.runId);
      cursors.set(
        ref.runId,
        !cursors.has(ref.runId)
          ? ref.throughSeq
          : previous === undefined || ref.throughSeq === undefined
            ? undefined
            : Math.max(previous, ref.throughSeq),
      );
    }
    const result: ThreadAsset[] = [];
    for (const [runId, throughSeq] of cursors) {
      const row = await load(runId);
      if (!row || !admitted(row)) throw new Error("artifact source is unavailable");
      const facts = factsOf(row);
      if (
        !(await originAllowed({
          runId,
          requester: facts.userId,
          channelId: facts.channelId,
          threadKey: facts.threadKey,
        }))
      )
        throw new Error("artifact source access changed");
      const events = "meta" in row ? [] : row.events;
      if ("meta" in row) {
        if (!deps.runs || typeof throughSeq !== "number" || !Number.isSafeInteger(throughSeq) || throughSeq < 0)
          throw new Error("live artifact source has no frozen cursor");
        let afterSeq: number | undefined;
        for (;;) {
          const page = await deps.runs.getRunEvents(runId, {
            limit: RUN_EVENTS_MAX_PAGE,
            ...(afterSeq !== undefined ? { afterSeq } : {}),
            ...(facts.threadKey.startsWith("worker:") ? { privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ } : {}),
          });
          if (!page.ok) throw new Error("artifact source is incomplete");
          events.push(...page.value.events);
          const next = page.value.nextAfterSeq;
          if (next === undefined || next >= throughSeq) break;
          if (!Number.isSafeInteger(next) || next <= (afterSeq ?? -1))
            throw new Error("artifact source cursor did not advance");
          afterSeq = next;
        }
      }
      for (const asset of threadAssetsOf([
        {
          id: runId,
          events: events.filter(
            (event) => throughSeq === undefined || (event.seq !== undefined && event.seq <= throughSeq),
          ),
        },
      ])) {
        const held = deps.artifacts ? await deps.artifacts.head(asset.key) : undefined;
        result.push({ ...asset, ...(held !== undefined ? { held: held !== null } : {}) });
      }
    }
    return result;
  };
  const handoff: Omit<HandoffAccess, "canRead"> = {
    loadAdmission: async (binding, consumer) => {
      try {
        if (
          !isUnitContextBinding(binding) ||
          !stepMatches(binding.idempotencyKey, binding.instanceId, binding.unit) ||
          consumer.attempt !== binding.idempotencyKey ||
          consumer.requester !== msg.userId ||
          consumer.channelId !== msg.channelId ||
          consumer.threadKey !== msg.threadKey
        )
          return undefined;
        const stored = await unitFor(binding.instanceId, binding.unit);
        if (
          !stored ||
          (stored.instance.attempt ?? 0) !== binding.instanceAttempt ||
          stored.instance.userId !== consumer.requester ||
          stored.instance.channelId !== consumer.channelId ||
          !isUnitContext(stored.unit.context)
        )
          return undefined;
        let threadKey: string | undefined;
        if (stored.unit.workBrief) {
          threadKey = privateWorkerThreadKey({ instanceId: stored.instance.id, unit: stored.unit.unit });
          if (msg.messageId !== binding.idempotencyKey || !(await destinationAudience())) return undefined;
        } else {
          const step = binding.idempotencyKey.slice(binding.instanceId.length + 1);
          const review = /\/review(?:\/[ar][1-9][0-9]*)?$/.test(step);
          threadKey =
            (review ? stored.unit.reviewThread?.threadKey : undefined) ??
            stored.unit.threadKey ??
            (stored.count === 1 ? stored.instance.threadKey : undefined);
        }
        if (threadKey !== consumer.threadKey) return undefined;
        return structuredClone({
          binding,
          context: stored.unit.context,
          requester: stored.instance.userId,
          channelId: stored.instance.channelId,
          threadKey,
        });
      } catch {
        return undefined;
      }
    },
    loadRun: async (runId) => {
      const row = await load(runId);
      if (!row || !admitted(row)) return undefined;
      const checkpoint =
        "meta" in row ? (row.state.contextCheckpoint as { key?: unknown; through?: unknown } | undefined) : undefined;
      const through =
        checkpoint?.key === factsOf(row).session?.key && Number.isSafeInteger(checkpoint?.through)
          ? (checkpoint!.through as number)
          : undefined;
      const canonical = canonicalHandoffRunOf(row, through);
      if (!canonical) return undefined;
      const dependencies = await readRunDependencies(runId);
      return { ...canonical, ...(dependencies ? { dependencies } : {}) };
    },
    readSession: (key, from, to) => deps.runLedger.readSession(key, from, to),
    readNotepad: (key) => deps.runLedger.readNotepad(key),
    readAssets,
    validateDependencies: async (dependencies) => (await validate(dependencies)).ok,
    captureDependencies,
    loadSource: async (source) => {
      if (!source.snapshotRunId) return source;
      const snapshot = await load(source.snapshotRunId);
      if (!snapshot || !admitted(snapshot)) return undefined;
      const manifest = factsOf(snapshot).childHandoff;
      if (!isChildHandoff(manifest)) return undefined;
      const original = [manifest, ...(manifest.ancestors ?? [])].find(
        (item) => item.source.runId === source.source.runId,
      );
      if (!original) return undefined;
      return { ...original, assets: source.omitted?.assets ? await readAssets(source) : original.assets };
    },
  };
  return {
    handoff,
    message: {
      validateDependencies: validate,
      normalizeDependencies,
      canReadOrigin,
      readRunDependencies,
      readOperatorDecision,
      authorizeMemory,
    },
  };
}
