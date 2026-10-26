import {
  observeAdmission,
  admissionExceptionKindOf,
  type RequestContextSelection,
} from "../core/organization/admissionTrace.js";
import { agentMaintenanceRefusal } from "../core/maintenance.js";
import type { TraceOptions } from "../core/trace/types.js";
import { closedStage } from "../core/trace/closedStage.js";
import { operatorModeOf } from "../config.js";
import { historyFailure } from "../core/organization/ownerFailure.js";
import { contextAccessForMessage } from "../core/dispatch/contextAccess.js";
import { isContextDependencies, mergeContextDependencies } from "../core/references/contextDependencies.js";
import { SingleShotIO } from "./singleShotDispatch.js";
import { withChatActor } from "../core/authz/actor.js";
import type { CommandInvoker } from "../core/commandRegistry.js";
import {
  parseUnitKey,
  unitKeyOf,
  type CoordinatorUnit,
  type CoordinatorInstance,
} from "../core/coordinator/contract.js";
import type { OriginalUnitRecipient } from "./originalUnitRecipient.js";
import type { UnitEventKey } from "../core/coordinator/instanceStore.js";
import type { CoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import { dispatch, dispatchClick, type CoreDeps, type DispatchOutcome } from "../core/dispatcher.js";
import { causeOf, REFUSAL_CODES } from "../core/refusal.js";
import { identityKey } from "../core/identity/engine.js";
import type { PersonDirectory, ExternalIdentity } from "../core/identity/contract.js";
import {
  OrganizationService,
  type OrganizationMapping,
  type OrganizationAdmissionInput,
} from "../core/organization/service.js";
import {
  createOrganizationRuntime,
  type OrganizationExecutionRequest,
  type OrganizationOwnerOutcome,
} from "../core/organization/runtime.js";
import {
  envelopeSchema,
  type OrganizationLimits,
  type OrganizationStore,
  type OrganizationEnvelope,
} from "../core/organization/contract.js";
import {
  withOriginalOrganizationDispatch,
  originalOrganizationDispatchOf,
} from "../core/dispatch/privateDestination.js";
import { hasConfirmationConsent, type ConfirmationSourceGuard } from "../core/confirmations.js";
import { authorize } from "../core/authz/authorize.js";
import { allOf, predicateFor, matchesPredicate } from "../core/authz/predicate.js";
import { holdsAll } from "../core/authz/viewAs.js";
import { readableRuns } from "./liveView/viewer.js";
import { historyOf, turnOf } from "./web.js";
import { RUN_LIST_MAX_LIMIT } from "../core/runRecord.js";
import type { RunLedger } from "../core/runLedger/ledger.js";
import { defaultRunRegistry } from "../core/runRegistry.js";
import type { RunsService, RunView } from "../core/runsService.js";
import type { ChannelIO, IncomingMessage, HistoryItem } from "../core/types.js";
import { mapLimit } from "../core/mapLimit.js";
import { HOME_PRIVATE_READ_CONCURRENCY } from "../core/budgets.js";
import type { HomePrivateReadGroup } from "../core/home/service.js";
import type { HomePrivateReadGuard } from "./homeView.js";
import type { HomeUnit } from "../core/home/service.js";
import { hasWorkViewScope, resolveWorkViewScope, withWorkViewScope, workViewScopeOf } from "./workViewScope.js";
import { createHomeHost } from "./homeHost.js";
import { createHomeThreadProjection, homeQuestionDigest, homeQuestionRevision } from "./homeThreadProjection.js";
import { parsePrivateWorkerThreadKey, type PrivateWorkerLog } from "../core/privateWorkerLog.js";
import { privateWorkerAudienceFor } from "./privateWorker.js";
import { isUnitContext } from "../core/dispatch/unitContext.js";
import { ownerOf, readThread as readOwnedThread } from "../core/dispatch/thread.js";
import { requestOnlyPrTarget, freshReviewRequested } from "../core/dispatch/requestOnlyPr.js";
import { nativeMediaDigest, nativeMediaSchema, matchesNativeMedia } from "../core/nativeMedia.js";
import type { HomeRuntimeContext, HomeThreadProjection } from "./homeRuntime.js";
import type { HomeAnswerTarget, HomeMergeAction } from "./homeSeed.js";
import type { LegacySlackAudienceOrigin, LegacySlackRecipient } from "./legacySlackAudience.js";
import type { Actor } from "../core/authz/types.js";
import { homeAttachedContext, type HomeContextMetadata } from "./homeAttachedContext.js";
import { wrapUntrusted } from "../core/untrusted.js";
import { unitFactsForPrivateRecipient, unitFactsOf } from "../core/unitRuns.js";
import type { ConversationDeps } from "./web.js";
import type {
  createOrganizationAuthentication,
  OrganizationQuestionOwner,
  ResolvedOrganizationAuthentication,
  OrganizationNativeEvidence,
  OrganizationMetadataAuthentication,
} from "./organizationAuthentication.js";

export interface BrowserHomeInstallationOptions {
  organizationId: string;
  store: OrganizationStore & { directory: PersonDirectory };
  ledger: RunLedger;
  authentication: ReturnType<typeof createOrganizationAuthentication>;
  core: CoreDeps;
  runs: RunsService;
  coordinator: CoordinatorInstanceStore;
  privateWorkerLog?: Pick<PrivateWorkerLog, "listAfter">;
  commands: CommandInvoker;
  mappings: readonly OrganizationMapping[];
  limits: OrganizationLimits;
  retention: { retentionDays: number } | null;
  intake?: ConversationDeps["intake"];
  owner: string;
  leaseMs: number;
  batchSize: number;
  contentTtlMs: number;
  sourceSnapshotTtlMs?: number;
  reportOwnerFailure?: import("../core/organization/runtime.js").OrganizationRuntimeOptions["reportOwnerFailure"];
  launch(task: () => Promise<void>): void;
  now(): number;
  policyEpoch(): string;
  sourceIo(request: Omit<OrganizationExecutionRequest, "io">): ChannelIO;
  /** Authenticated source adapter; never a URL or bearer supplied by a caller. */
  materializeNativeMedia?(
    envelope: OrganizationEnvelope,
  ): Promise<Pick<IncomingMessage, "images" | "documents" | "staged"> | undefined>;
  canReadContext: Parameters<typeof createHomeHost>[0]["canReadContext"];
  /** Display facts only. Effect authority always uses the current native source. */
  provedActorIds?(context: HomeRuntimeContext): Promise<readonly string[]>;
  viewScope?(context: HomeRuntimeContext): Promise<"mine" | "person" | "everyone">;
  /** Ordinary threads still use the existing target-access policy. */
  canWriteThread(context: HomeRuntimeContext, thread: string, runs: readonly RunView[]): Promise<boolean>;
  sourceRepository?: Parameters<typeof createHomeHost>[0]["sourceRepository"];
  repositories?(context: HomeRuntimeContext): Promise<import("./homeRepositories.js").HomeRepositories>;
  legacyRecipient?(origin: LegacySlackAudienceOrigin): Promise<LegacySlackRecipient | undefined>;
  /** Existing unit metadata only; never its private journal or prompt bytes. */
  originalUnitRecipient?(key: UnitEventKey): Promise<OriginalUnitRecipient | undefined>;
  /** Request-phase metadata proof only; never reused for history or effects. */
  originalUnitRecipientPhase?(
    groups: readonly HomePrivateReadGroup[],
    authentication: OrganizationMetadataAuthentication,
  ): { read(key: UnitEventKey): Promise<OriginalUnitRecipient | undefined>; canEmit(): Promise<boolean> };
  /** Existing explicit GitHub binding for the actual credential; never the unit's requester. */
  mergeLogin?(actorId: string): Promise<string | undefined>;
  /** Existing authenticated GitHub read; no model or browser fields select its PR. */
  mergeFacts?(
    context: HomeRuntimeContext,
    instance: CoordinatorInstance,
    unit: CoordinatorUnit,
  ): Promise<
    | {
        headSha: string;
        mergeCommitSha: string;
        mergedAt: number;
      }
    | undefined
  >;
  refreshProjection?: Parameters<typeof createHomeHost>[0]["refreshProjection"];
  publicBaseUrl?: string;
}
function ownerOutcome(outcome: DispatchOutcome): OrganizationOwnerOutcome {
  const refusalCode = REFUSAL_CODES.find((code) => code === outcome.refusal);
  const cause = refusalCode ? causeOf(refusalCode) : outcome.cause;
  const dispatchResult: NonNullable<OrganizationOwnerOutcome["dispatchResult"]> = {
    status: outcome.inputQueued ? "input_queued" : outcome.unknownClaim ? "unknown_claim" : outcome.status,
    ...(cause ? { cause } : {}),
    ...(refusalCode ? { refusalCode } : {}),
  };
  if (outcome.inputQueued)
    return { status: "uncertain", reason: "The original input is queued with its owner.", dispatchResult };
  if (outcome.status === "completed") return { status: "completed", dispatchResult };
  if (outcome.status === "refused" && outcome.cause !== "system")
    return { status: "refused", reason: outcome.refusal ?? "The original owner refused this request.", dispatchResult };
  return {
    status: "uncertain",
    reason: outcome.refusal ?? "The original owner's result could not be confirmed.",
    dispatchResult,
  };
}
const targetKey = (unit: CoordinatorUnit, gate: NonNullable<NonNullable<CoordinatorUnit["idle"]>["humanGate"]>) =>
  `${unitKeyOf(unit)}:question:${homeQuestionRevision(gate)}:${homeQuestionDigest(gate)}`;
const unitOfTarget = (key: string) => {
  const match = /^([^:]+:[^:]+):question:[0-9]+:[0-9a-f]{64}$/.exec(key);
  return match && parseUnitKey(match[1]) ? match[1] : undefined;
};

/** Installation composition. Source authentication, the canonical unit store,
 * and the existing dispatcher keep their authority and original owners. */
export function createBrowserHomeInstallation(options: BrowserHomeInstallationOptions) {
  if (options.core.coordinatorInstances && options.core.coordinatorInstances !== options.coordinator)
    throw new Error("Browser Home must use the dispatcher's canonical coordinator store.");
  const core = { ...options.core, coordinatorInstances: options.coordinator };
  const registry = core.runRegistry ?? defaultRunRegistry;
  let host: ReturnType<typeof createHomeHost>;
  async function question(unitKey: string) {
    const key = parseUnitKey(unitKey);
    if (!key) return;
    const [instance, units] = await Promise.all([
      options.coordinator.get(key.instanceId),
      options.coordinator.listUnits(key.instanceId),
    ]);
    const matches = units.filter((row) => row.unit === key.unit);
    if (!instance || matches.length !== 1) return;
    const unit = matches[0]!;
    const gate = unit.idle?.humanGate ?? (unit.recoveryHold?.cause === "human" ? unit.recoveryHold.gate : undefined);
    return { instance, unit, gate };
  }
  async function questionOwner(unitKey: string): Promise<OrganizationQuestionOwner> {
    try {
      const saved = await question(unitKey);
      if (!saved) return { status: "unavailable" };
      const { instance, gate } = saved;
      const sourceRunId =
        saved.unit.workBrief && saved.unit.context && isUnitContext(saved.unit.context)
          ? saved.unit.context.handoff.source.runId
          : instance.runId;
      if (sourceRunId) {
        const owner = await options.ledger.readIngressByRun(sourceRunId);
        if (owner.status !== "record" && owner.status !== "not_found") return { status: "unavailable" };
        if (owner.status === "record" && owner.record.origin?.sourceReference) {
          const origin = owner.record.origin;
          if (origin.organization !== options.organizationId || origin.sourceReference!.userId !== instance.userId)
            return { status: "fenced" };
          return {
            status: "proved",
            requester: origin.actor.identity,
            sourceReference: origin.sourceReference!,
            repo: instance.repo,
            ...(gate ? { questionDigest: homeQuestionDigest(gate) } : {}),
          };
        }
      }
      // Native records can name their credential exactly. A relay or machine
      // record without its retained credential digest cannot be reconstructed.
      if (instance.authenticatedAs || instance.postedBy) return { status: "unavailable" };
      const source = instance.userId.startsWith("access:")
        ? "browser"
        : instance.userId.startsWith("slack:")
          ? "slack"
          : undefined;
      if (!source) return { status: "unavailable" };
      const realms = options.mappings.filter(
        (mapping) => mapping.source === source && mapping.organization === options.organizationId,
      );
      const unique = new Map(realms.map((mapping) => [JSON.stringify([mapping.issuer, mapping.tenant]), mapping]));
      if (unique.size !== 1) return { status: "unavailable" };
      const realm = [...unique.values()][0]!;
      const requester: ExternalIdentity = {
        issuer: realm.issuer,
        tenant: realm.tenant,
        subject: instance.userId.slice(instance.userId.indexOf(":") + 1),
      };
      return {
        status: "proved",
        requester,
        sourceReference: {
          actorId: instance.userId,
          userId: instance.userId,
          channelId: instance.channelId,
          threadKey: instance.threadKey,
        },
        repo: instance.repo,
        ...(gate ? { questionDigest: homeQuestionDigest(gate) } : {}),
      };
    } catch {
      return { status: "unavailable" };
    }
  }
  async function current(
    context: HomeRuntimeContext,
    authentication: Pick<typeof options.authentication, "resolveAuthorization"> = options.authentication,
  ): Promise<ResolvedOrganizationAuthentication | undefined> {
    const reference = context.authentication.sourceReference;
    if (!reference) return;
    const resolved = await organization.resolve(context.authentication, true);
    if (!resolved) return;
    const value = await authentication.resolveAuthorization({
      source: context.authentication.source,
      sourceReference: reference,
      organization: options.organizationId,
      actor: resolved.actor,
      action: "read",
      destination: { kind: "thread", thread: reference.threadKey },
      target: null,
      context: [],
    });
    if (value.status === "unavailable") throw new Error("Current source proof is unavailable.");
    return value.status === "resolved" ? value : undefined;
  }
  async function questionAuthentication(context: HomeRuntimeContext, unitKey: string) {
    if (context.actor.viewingAs) return;
    const saved = await question(unitKey),
      actual = await current(context);
    if (
      !saved?.gate ||
      !actual ||
      !saved.gate.assignedTo ||
      actual.actor.kind !== "user" ||
      actual.actor.viewingAs ||
      actual.actor.onBehalfOf
    )
      return;
    if (saved.unit.workBrief) {
      if (!(await canReadPrivateUnit(context, saved.instance, saved.unit))) return;
      const [owner, name, ...extra] = saved.instance.repo.split("/");
      if (
        !owner ||
        !name ||
        extra.length ||
        !authorize(actual.actor, "organization:send", { type: "organization", id: options.organizationId }).allow ||
        !authorize(actual.actor, "steer:write", { type: "command", id: "work.steer" }).allow ||
        !authorize(actual.actor, "repo:use", { type: "repo", owner, name }).allow
      )
        return;
    }
    if (saved.gate.assignedTo === actual.actor.id) return { saved, actual };
    const bridged = await options.authentication.resolveQuestion(actual, unitKey, homeQuestionDigest(saved.gate));
    if (bridged.status === "unavailable") throw new Error("Current question ownership proof is unavailable.");
    if (bridged.status !== "resolved" || bridged.msg.userId !== saved.gate.assignedTo) return;
    return { saved, actual: bridged };
  }
  const projection = createHomeThreadProjection({
    service: options.runs,
    registry,
    coordinator: options.coordinator,
    confirmations: core.confirmations,
    commands: options.commands,
    retention: options.retention,
    intake: options.intake,
    provedActorIds: options.provedActorIds,
    canWriteThread: options.canWriteThread,
    privateThread: privateThread,
  });
  const privateMetadataStamp = (instance: CoordinatorInstance, unit: CoordinatorUnit) =>
    JSON.stringify([
      instance.id,
      instance.userId,
      instance.authenticatedAs,
      instance.postedBy,
      instance.channelId,
      instance.threadKey,
      instance.repo,
      instance.runId,
      unit.instanceId,
      unit.unit,
      unit.workBrief,
      unit.context,
      unit.threadKey,
      unit.idle?.humanGate
        ? homeQuestionDigest(unit.idle.humanGate)
        : unit.recoveryHold?.cause === "human"
          ? homeQuestionDigest(unit.recoveryHold.gate)
          : null,
    ]);
  /** One page's metadata proofs, followed by a separate fresh emission phase.
   * Single-unit history, logs and actions keep their original strict readers. */
  function privateRead(context: HomeRuntimeContext): HomePrivateReadGuard {
    const candidates = new Map<string, { instance: CoordinatorInstance; unit: CoordinatorUnit }>();
    let disclosed = candidates;
    let initialEpoch: Promise<string | undefined> | undefined;
    const phaseAuthentication = options.authentication.metadataPhase();
    const readPhase = async (
      groups: readonly HomePrivateReadGroup[],
      authentication: OrganizationMetadataAuthentication,
    ) => {
      const results = new Map<string, boolean>();
      const actual = await current(context, authentication);
      const scope = (await options.viewScope?.(context)) ?? workViewScopeOf(context.actor).mode;
      const fresh = scope !== "mine" ? await host.refresh(context) : undefined;
      const ids = (await options.provedActorIds?.(context)) ?? [];
      const sourceProof = options.originalUnitRecipientPhase?.(groups, authentication);
      const rows = groups.flatMap(({ instance, units }) => units.map((unit) => ({ instance, unit })));
      await mapLimit(rows, HOME_PRIVATE_READ_CONCURRENCY, async ({ instance, unit }) => {
        const key = unitKeyOf(unit);
        if (
          unit.instanceId !== instance.id ||
          !unit.workBrief ||
          !actual ||
          actual.actor.kind !== "user" ||
          actual.actor.viewingAs
        ) {
          results.set(key, false);
          return;
        }
        const entity = {
          userId: instance.userId,
          channelId: instance.channelId,
          repo: instance.repo,
          channelVisibility: "unknown" as const,
        };
        if (scope !== "mine") {
          const selected = fresh && workViewScopeOf(fresh.actor);
          results.set(
            key,
            !!fresh &&
              holdsAll(actual.actor) &&
              holdsAll(fresh.actor) &&
              authorize(actual.actor, "organization:read", { type: "organization", id: options.organizationId })
                .allow &&
              (scope === "person"
                ? selected?.mode === "person" && fresh.actor.viewingAs?.id === context.actor.viewingAs?.id
                : !fresh.actor.viewingAs) &&
              matchesPredicate(readableRuns(fresh.actor), entity),
          );
          return;
        }
        if (context.actor.viewingAs || !matchesPredicate(predicateFor(actual.actor, "runs:read", "run"), entity)) {
          results.set(key, false);
          return;
        }
        const proof = sourceProof && (await sourceProof.read({ instanceId: instance.id, unit: unit.unit }));
        const source = unit.context && isUnitContext(unit.context) ? unit.context.handoff.source : undefined;
        if (
          proof &&
          source &&
          proof.sourceRunId === source.runId &&
          proof.unitKey.instanceId === instance.id &&
          proof.unitKey.unit === unit.unit &&
          proof.requesterId === unit.workBrief.requesterId &&
          proof.channelId === instance.channelId &&
          proof.threadKey === unit.workBrief.mainThreadKey &&
          (proof.actor.kind === "user" || proof.actor.onBehalfOf?.kind === "user") &&
          (actual.actor.id === proof.actor.id ||
            actual.actor.id === proof.actor.onBehalfOf?.id ||
            ids.includes(proof.actor.id))
        ) {
          results.set(key, true);
          return;
        }
        if (sourceProof && source) {
          const original = await options.ledger.readIngressByRun(source.runId);
          if (original.status !== "record" && original.status !== "not_found")
            throw new Error("Current original-source proof is unavailable.");
          if (original.status === "record" && original.record.origin) {
            results.set(key, false);
            return;
          }
        }
        // Unknown/legacy implementations still use the exact existing reader.
        results.set(key, await canReadPrivateUnit(context, instance, unit));
      });
      if (sourceProof && !(await sourceProof.canEmit())) throw new Error("The original private unit claim changed.");
      return results;
    };
    return {
      async begin() {
        initialEpoch ??= host.currentEpoch(context);
        return !!(await initialEpoch);
      },
      async readMany(groups) {
        initialEpoch ??= host.currentEpoch(context);
        if (!(await initialEpoch)) throw new Error("Current private metadata proof is unavailable.");
        const result = await readPhase(groups, phaseAuthentication);
        for (const { instance, units } of groups)
          for (const unit of units)
            if (result.get(unitKeyOf(unit))) candidates.set(unitKeyOf(unit), { instance, unit });
        return result;
      },
      include(unitKeys) {
        disclosed = new Map(
          unitKeys.flatMap((key) => {
            const row = candidates.get(key);
            return row ? [[key, row] as const] : [];
          }),
        );
      },
      async canEmit() {
        try {
          const first = await (initialEpoch ??= host.currentEpoch(context));
          if (!first) return false;
          const ids = [...new Set([...disclosed.values()].map(({ instance }) => instance.id))];
          const groups = await mapLimit(ids, HOME_PRIVATE_READ_CONCURRENCY, async (id) => {
            const [instance, units] = await Promise.all([
              options.coordinator.get(id),
              options.coordinator.listUnits(id),
            ]);
            if (!instance) throw new Error("The original private unit is unavailable.");
            return { instance, units };
          });
          const selected = groups.map(({ instance, units }) => ({
            instance,
            units: units.filter((unit) => disclosed.has(unitKeyOf(unit))),
          }));
          const final = await readPhase(selected, options.authentication.metadataPhase());
          const currentRows = new Map<string, { instance: CoordinatorInstance; unit: CoordinatorUnit }[]>();
          // Native reads are asynchronous. Re-read the canonical roster AFTER
          // them, so a concurrent owner/question change cannot release old facts.
          const reread = await mapLimit(ids, HOME_PRIVATE_READ_CONCURRENCY, async (id) => {
            const [instance, units] = await Promise.all([
              options.coordinator.get(id),
              options.coordinator.listUnits(id),
            ]);
            if (!instance) throw new Error("The original private unit is unavailable.");
            return { instance, units };
          });
          for (const { instance, units } of reread)
            for (const unit of units) {
              const key = unitKeyOf(unit),
                rows = currentRows.get(key) ?? [];
              rows.push({ instance, unit });
              currentRows.set(key, rows);
            }
          for (const [key, saved] of disclosed) {
            const rows = currentRows.get(key);
            if (
              rows?.length !== 1 ||
              privateMetadataStamp(rows[0]!.instance, rows[0]!.unit) !==
                privateMetadataStamp(saved.instance, saved.unit)
            )
              return false;
          }
          return (
            [...disclosed.keys()].every((key) => final.get(key) === true) &&
            first === (await host.currentEpoch(context))
          );
        } catch {
          return false;
        }
      },
    };
  }
  async function canReadPrivateUnit(
    context: HomeRuntimeContext,
    instance: CoordinatorInstance,
    unit: CoordinatorUnit,
    requireHistory = false,
  ): Promise<boolean> {
    if (context.actor.kind !== "user" || (requireHistory && context.actor.viewingAs)) return false;
    const saved = await question(unitKeyOf(unit));
    if (
      !saved?.unit.workBrief ||
      saved.instance.id !== instance.id ||
      JSON.stringify(saved.unit.workBrief) !== JSON.stringify(unit.workBrief) ||
      (saved.gate ? homeQuestionDigest(saved.gate) : null) !==
        (unit.idle?.humanGate
          ? homeQuestionDigest(unit.idle.humanGate)
          : unit.recoveryHold?.cause === "human"
            ? homeQuestionDigest(unit.recoveryHold.gate)
            : null)
    )
      return false;
    const actual = await current(context);
    if (!actual || actual.actor.kind !== "user" || actual.actor.viewingAs) return false;
    const entity = {
      userId: saved.instance.userId,
      channelId: saved.instance.channelId,
      repo: saved.instance.repo,
      channelVisibility: "unknown" as const,
    };
    const scope = (await options.viewScope?.(context)) ?? workViewScopeOf(context.actor).mode;
    if (!requireHistory && scope !== "mine") {
      const fresh = await host.refresh(context);
      if (
        !fresh ||
        !holdsAll(actual.actor) ||
        !holdsAll(fresh.actor) ||
        !authorize(actual.actor, "organization:read", { type: "organization", id: options.organizationId }).allow
      )
        return false;
      const selected = workViewScopeOf(fresh.actor);
      if (
        (scope === "person" &&
          (selected.mode !== "person" || fresh.actor.viewingAs?.id !== context.actor.viewingAs?.id)) ||
        (scope === "everyone" && fresh.actor.viewingAs)
      )
        return false;
      // Full/selected work views authorize canonical metadata only. They do
      // not replace the private recipient proof below with an admin session.
      return matchesPredicate(readableRuns(fresh.actor), entity);
    }
    if (
      context.actor.viewingAs ||
      !saved.unit.context ||
      !isUnitContext(saved.unit.context) ||
      !matchesPredicate(predicateFor(actual.actor, "runs:read", "run"), entity)
    )
      return false;
    const source = saved.unit.context.handoff.source;
    if (saved.instance.runId && saved.instance.runId !== source.runId) return false;
    let original: { actor: Actor; io: ChannelIO } | undefined = await originalBinding(
      source.runId,
      { threadKey: saved.unit.workBrief.mainThreadKey, userId: saved.unit.workBrief.requesterId },
      "audience",
    );
    if (!original && !requireHistory) {
      const proof = await options.originalUnitRecipient?.({ instanceId: saved.instance.id, unit: saved.unit.unit });
      if (
        proof &&
        proof.sourceRunId === source.runId &&
        proof.unitKey.instanceId === saved.instance.id &&
        proof.unitKey.unit === saved.unit.unit &&
        proof.requesterId === saved.unit.workBrief.requesterId &&
        proof.channelId === saved.instance.channelId &&
        proof.threadKey === saved.unit.workBrief.mainThreadKey &&
        (proof.actor.kind === "user" || proof.actor.onBehalfOf?.kind === "user") &&
        (actual.actor.id === proof.actor.id ||
          actual.actor.id === proof.actor.onBehalfOf?.id ||
          ((await options.provedActorIds?.(context)) ?? []).includes(proof.actor.id))
      )
        return true;
    }
    // A metadata proof cannot release an old mixed private transcript.
    if (!original && requireHistory && saved.unit.context.handoff.privateProjectionHash) return false;
    if (!original) {
      const legacy = await options.legacyRecipient?.({
        sourceRunId: source.runId,
        unitKey: { instanceId: saved.instance.id, unit: saved.unit.unit },
        threadKey: saved.unit.workBrief.mainThreadKey,
        userId: saved.unit.workBrief.requesterId,
      });
      if (legacy && (await legacy.verify()).ok) original = legacy;
    }
    if (
      !original ||
      (original.actor.kind !== "user" && original.actor.onBehalfOf?.kind !== "user") ||
      (actual.actor.id !== original.actor.id &&
        actual.actor.id !== original.actor.onBehalfOf?.id &&
        !((await options.provedActorIds?.(context)) ?? []).includes(original.actor.id))
    )
      return false;
    const audience = await privateWorkerAudienceFor(
      saved.instance,
      saved.unit,
      source.runId,
      async (address) => (address.sourceRunId === source.runId ? original?.io : undefined),
      options.coordinator,
    );
    return !!audience && (await audience.verify(audience.requester)).ok;
  }
  async function privateThread(context: HomeRuntimeContext, thread: string): Promise<HomeThreadProjection | undefined> {
    const key = parsePrivateWorkerThreadKey(thread);
    if (!key) return;
    const saved = await question(`${key.instanceId}:${key.unit}`);
    if (
      !saved ||
      saved.unit.threadKey !== thread ||
      !(await canReadPrivateUnit(context, saved.instance, saved.unit, true))
    )
      return;
    const entries: HomeThreadProjection["entries"] = [];
    const journal = await options.privateWorkerLog?.listAfter(thread, 0, 100);
    // Journal inputs are synthetic coding briefs. A reply recipient does not
    // gain access to those internal model instructions or their source copies.
    for (const event of journal?.events ?? []) {
      if (event.kind === "reply")
        entries.push({
          id: `worker:${event.seq}`,
          role: "assistant",
          content: event.text,
          isViewer: false,
          authorLabel: "Switchboard",
          at: event.at,
        });
    }
    const events = await options.coordinator.listEvents(key);
    for (const event of events)
      entries.push({
        id: `unit:${event.seq}`,
        role: "user",
        content: event.text,
        isViewer: (event.postedBy ?? event.authenticatedAs ?? event.sender) === context.actor.id,
        authorLabel:
          (event.postedBy ?? event.authenticatedAs ?? event.sender) === context.actor.id
            ? "You"
            : (event.postedBy ?? event.authenticatedAs ?? event.sender) !== event.sender
              ? `${event.postedBy ?? event.authenticatedAs} on behalf of ${event.senderName ?? event.sender}`
              : (event.senderName ?? event.sender),
        at: event.at,
      });
    const gate =
      saved.gate && !events.some((event) => event.questionDigest === homeQuestionDigest(saved.gate!))
        ? saved.gate
        : undefined;
    const target = gate ? { key: targetKey(saved.unit, gate), revision: 1 } : undefined;
    if (gate && target)
      entries.push({
        id: `question:${target.key}`,
        role: "receipt",
        isViewer: false,
        authorLabel: "Pending question",
        ...(gate.askedAt === undefined ? {} : { at: gate.askedAt }),
        content: [
          `Review requested for ${gate.pr.url}.`,
          `Verdict: ${gate.verdict}. Round: ${gate.round}.`,
          ...(gate.headSha ? [`Reviewed head: ${gate.headSha}.`] : []),
          ...gate.findings.map((finding) => `${finding.id}: ${finding.title}`),
        ].join("\n"),
      });
    const write = gate ? await questionAuthentication(context, unitKeyOf(saved.unit)) : undefined;
    if (!(await canReadPrivateUnit(context, saved.instance, saved.unit, true))) return;
    return {
      label: saved.unit.title ?? `Unit ${saved.unit.unit}`,
      revision: gate ? homeQuestionRevision(gate) : 0,
      canWrite: !!write && (await options.canWriteThread(context, thread, [])),
      entries,
      history: {
        cursor: journal?.events.at(-1)?.seq ?? 0,
        hasMore: journal?.more ?? false,
        status: journal ? "partial" : "unavailable",
      },
      ...(target ? { target } : {}),
      ...(gate ? { primaryAction: gate.primaryAction ?? { label: "Confirm", text: "confirm" } } : {}),
    };
  }
  async function actualThread(context: HomeRuntimeContext, thread: string) {
    if (!hasWorkViewScope(context.actor) && options.provedActorIds) {
      const ownerIds = await options.provedActorIds(context);
      withWorkViewScope(
        context.actor,
        resolveWorkViewScope(context.actor, { organization: options.organizationId, ownerIds }),
      );
    }
    let read = await projection.readThread(context, thread);
    if (!read) return;
    if (read.offer) {
      const row = await core.confirmations?.get?.(read.offer.id);
      if (!row || !(await canReadOffer(context, row))) read = { ...read, offer: undefined };
    }
    if (!read.target) return read;
    const unitKey = read.target.key.split(":question:")[0]!;
    const saved = await question(unitKey);
    if (
      !saved?.gate ||
      read.revision !== homeQuestionRevision(saved.gate) ||
      (saved.unit.threadKey !== thread && saved.unit.reviewThread?.threadKey !== thread)
    )
      return;
    const write = await questionAuthentication(context, unitKey);
    return {
      ...read,
      label: saved.unit.title ?? `Unit ${saved.unit.unit} · #${saved.gate.pr.number}`,
      target: { key: targetKey(saved.unit, saved.gate), revision: 1 },
      primaryAction: saved.gate.primaryAction ?? { label: "Confirm", text: "confirm" },
      canWrite: read.canWrite && !!write && !context.actor.viewingAs,
    };
  }
  async function readThread(context: HomeRuntimeContext, thread: string) {
    const read = await actualThread(context, thread);
    if (!read) return;
    const mode = (await options.viewScope?.(context)) ?? workViewScopeOf(context.actor).mode;
    return mode === "person" ? { ...read, canWrite: false, offer: undefined } : read;
  }
  async function prepareAdmission(context: HomeRuntimeContext, input: OrganizationAdmissionInput) {
    if (
      input.destination.kind === "broad" &&
      input.context.some((ref) => ref.kind === "repository") &&
      !(await options.sourceRepository?.(context, input))
    )
      return;
    if (input.continuation) {
      const row = await core.confirmations?.get?.(input.continuation.id);
      if (!row || !(await canReadOffer(context, row))) return;
      const repository = row.originalOrganization?.organizationRepo;
      return repository && context.authentication.sourceReference
        ? {
            ...context.authentication,
            sourceReference: { ...context.authentication.sourceReference, sourceRepository: repository },
          }
        : context.authentication;
    }
    if (!input.target) return context.authentication;
    const unitKey = unitOfTarget(input.target.key);
    if (!unitKey || input.destination.kind !== "thread") return;
    const write = await questionAuthentication(context, unitKey);
    if (
      !write?.saved.gate ||
      targetKey(write.saved.unit, write.saved.gate) !== input.target.key ||
      input.target.revision !== 1 ||
      (write.saved.unit.threadKey !== input.destination.thread &&
        write.saved.unit.reviewThread?.threadKey !== input.destination.thread)
    )
      return;
    return write.actual.authentication;
  }
  const organization = new OrganizationService({
    admissionAvailable: async () => !(await agentMaintenanceRefusal(options.core.maintenance)),
    store: options.store,
    directory: options.store.directory,
    mappings: options.mappings,
    limits: {
      ...options.limits,
      ...(options.sourceSnapshotTtlMs !== undefined ? { sourceSnapshotTtlMs: options.sourceSnapshotTtlMs } : {}),
    },
    authorize: (input) => host.authorize(input),
    currentIdentityRead: options.authentication.evaluateSourceIdentity,
    sourceInReadScope: options.authentication.sourceInReadScope,
  });
  // Receipt metadata is bodyless. Only the protected original ledger request
  // can restore input bytes; neither a pending client nor a completed offer may supply them.
  const metadata = (envelope: OrganizationEnvelope) => {
    const {
      content: _content,
      contentExpiresAt: _expires,
      context: _context,
      nativeMedia: _media,
      ...facts
    } = envelope;
    return JSON.stringify(facts);
  };
  async function resolveOriginalInput(envelope: OrganizationEnvelope) {
    const resolved = await options.authentication.resolveEnvelope(envelope);
    if (resolved.status !== "resolved" || !envelope.nativeMedia) return resolved;
    const media = envelope.nativeMedia;
    if (
      !options.materializeNativeMedia ||
      !resolved.privateSource ||
      envelope.nativeMediaDigest !== (await nativeMediaDigest(media))
    )
      return { status: "fenced" as const };
    const context = { actor: resolved.actor, authentication: resolved.authentication };
    const epoch = await host.currentEpoch(context);
    if (!epoch || epoch !== envelope.sourceReference?.capturedPrivateEpoch) return { status: "fenced" as const };
    const materialized = await options.materializeNativeMedia(envelope);
    if (!materialized || !(await matchesNativeMedia(media, materialized))) return { status: "fenced" as const };
    const fresh = await options.authentication.resolveEnvelope(envelope);
    if (
      fresh.status !== "resolved" ||
      !fresh.privateSource ||
      fresh.actor.id !== resolved.actor.id ||
      epoch !== (await host.currentEpoch({ actor: fresh.actor, authentication: fresh.authentication }))
    )
      return { status: "fenced" as const };
    return {
      ...fresh,
      msg: { ...fresh.msg, ...materialized, nativeMedia: media, nativeMediaDigest: envelope.nativeMediaDigest },
    };
  }
  async function originalBinding(
    sourceRunId: string,
    expected?: { threadKey: string; userId: string },
    mode: "input" | "audience" | "metadata" = "input",
  ) {
    const original = await options.ledger.readIngressByRun(sourceRunId);
    if (
      original.status !== "record" ||
      !original.record.origin ||
      !original.record.receiptId ||
      original.record.runId !== sourceRunId ||
      (mode === "input" && original.record.contentExpiresAt <= options.now())
    )
      return;
    const retained = envelopeSchema.safeParse(original.record.request?.envelope);
    const origin = original.record.origin,
      reference = origin.sourceReference;
    if (
      !reference ||
      origin.organization !== options.organizationId ||
      original.record.requester !== reference.userId ||
      original.record.threadKey !== reference.threadKey ||
      (expected && (expected.threadKey !== reference.threadKey || expected.userId !== reference.userId)) ||
      (mode === "input" &&
        (!retained.success ||
          retained.data.digest !== original.record.digest ||
          metadata(retained.data) !== metadata(origin) ||
          retained.data.contentExpiresAt !== original.record.contentExpiresAt))
    )
      return;
    const saved = await options.store.execute({
      action: "submission",
      organization: options.organizationId,
      actor: origin.actor,
      source: origin.source,
      key: origin.key,
    });
    if (
      saved.status !== "submission" ||
      saved.receipt.id !== original.record.receiptId ||
      saved.receipt.ownerRunId !== sourceRunId ||
      saved.receipt.status !== "accepted" ||
      saved.receipt.digest !== original.record.digest ||
      saved.envelope.digest !== original.record.digest ||
      saved.receipt.effectKey !== original.record.effectKey ||
      metadata(saved.envelope) !== metadata(origin) ||
      (mode === "input" &&
        (!retained.success || JSON.stringify(saved.envelope.context) !== JSON.stringify(retained.data.context)))
    )
      return;
    // This path restores a current recipient capability for an existing unit.
    // It cannot restore expired input, context, or an execution permission.
    if (
      mode === "audience" &&
      (origin.destination.kind !== "broad" || origin.actor.stream === null || !reference.privateSource)
    )
      return;
    const envelope =
      mode !== "input" ? { ...origin, content: "", context: [] } : retained.success ? retained.data : undefined;
    if (
      !envelope ||
      !(await (mode !== "input" ? organization.authorizeReply(envelope) : organization.authorizeExecution(envelope)))
    )
      return;
    const current = await (mode === "input"
      ? resolveOriginalInput(envelope)
      : options.authentication.resolveEnvelope(envelope));
    if (current.status !== "resolved") return;
    if (
      origin.actor.stream !== null &&
      (origin.destination.kind === "broad" || origin.nativeMediaDigest !== undefined)
    ) {
      if (
        !reference.privateSource ||
        !reference.capturedPrivateEpoch ||
        !current.privateSource ||
        reference.capturedPrivateEpoch !==
          (await host.currentEpoch({ actor: current.actor, authentication: current.authentication }))
      )
        return;
    }
    const request = {
      envelope,
      receipt: saved.receipt,
      runId: sourceRunId,
      actor: current.actor,
      msg: withOriginalOrganizationDispatch(withChatActor({ ...current.msg, text: envelope.content }, current.actor), {
        ingressRunId: sourceRunId,
        organizationSequence: saved.receipt.revision,
        ...(envelope.nativeMediaDigest ? { nativeMediaDigest: envelope.nativeMediaDigest } : {}),
        ...(reference.sourceRepository ? { organizationRepo: reference.sourceRepository } : {}),
        ...(reference.contextMode ? { contextMode: reference.contextMode } : {}),
      }),
    };
    return { ...request, originalStatus: original.record.status, io: sink(request) };
  }
  async function originalPrivateSourceHistory(sourceRunId: string) {
    const owned = await originalBinding(sourceRunId);
    if (!owned?.io.authoritativePrivateHistory) return;
    // A completed asking run can still provide retained read context for its
    // standing unit. This does not rehost or resume that completed input.
    const history =
      owned.envelope.actor.stream !== null ? await host.privateHistory(owned) : await machineHistory(owned);
    // Recheck deletion, expiry and authority after the asynchronous history
    // read. The current original input is excluded by that reader and appears
    // exactly once here, even when an older message had identical text.
    const current = await originalBinding(sourceRunId, owned.msg);
    if (!current || current.envelope.digest !== owned.envelope.digest) return;
    return [...history, { role: "user" as const, text: current.msg.text, user: current.msg.userId }];
  }
  async function canReadOffer(context: HomeRuntimeContext, row: Parameters<ConfirmationSourceGuard>[0]) {
    if (!row.originalOrganization) return true;
    try {
      return !!(await guardOrganizationConfirmation(row, context.actor, "read"));
    } catch {
      return false;
    }
  }
  const guardOrganizationConfirmation: ConfirmationSourceGuard = async (row, chooser, purpose) => {
    const pointer = row.originalOrganization;
    if (!pointer || !chooser || chooser.viewingAs) return;
    const metadataOnly = !!pointer.nativeMediaDigest && (purpose === "cancel" || purpose === "read");
    const owned = await originalBinding(pointer.ingressRunId, row.message, metadataOnly ? "metadata" : "input");
    const reference = owned?.envelope.sourceReference;
    if (
      !owned ||
      !reference ||
      chooser.id !== owned.actor.id ||
      owned.receipt.revision !== pointer.organizationSequence ||
      reference.sourceRepository !== pointer.organizationRepo ||
      reference.channelId !== row.message.channelId ||
      reference.messageId !== row.message.messageId ||
      reference.authenticatedAs !== row.message.authenticatedAs ||
      reference.postedBy !== row.message.postedBy ||
      JSON.stringify(reference.approvalConnection ?? null) !== JSON.stringify(row.message.approvalConnection ?? null)
    )
      return;
    if (!metadataOnly) await owned.io.authoritativePrivateHistory!();
    return {
      actor: owned.actor,
      io: owned.io,
      ...(!metadataOnly && pointer.nativeMediaDigest ? { message: owned.msg } : {}),
    };
  };
  async function approvalSource(
    row: Parameters<ConfirmationSourceGuard>[0],
    viewer: import("../core/authz/types.js").Actor,
  ) {
    if (viewer.kind !== "user" || viewer.viewingAs || workViewScopeOf(viewer).mode === "person") return;
    if (!row.originalOrganization) {
      // A direct registry offer has no model source to restore. Its protected
      // connection digest still proves the exact active personal device.
      const connection = row.message.approvalConnection;
      if (
        row.kind !== "run" ||
        row.derivation ||
        !connection ||
        !connection.credentialId.startsWith("mcp:personal:") ||
        !/^[0-9a-f]{64}$/.test(connection.id) ||
        (row.message.postedBy ?? row.message.authenticatedAs ?? row.message.userId) !== connection.credentialId ||
        row.message.userId !== viewer.id
      )
        return;
      const current = await options.authentication.resolveNative(row.message, {
        source: "mcp",
        identity: { subject: connection.credentialId.slice("mcp:".length) },
        credentialDigest: connection.id,
      });
      if (current.status === "unavailable") throw new Error("Current approval source proof is unavailable.");
      if (
        current.status !== "resolved" ||
        current.actor.id !== connection.credentialId ||
        current.actor.viewingAs ||
        current.actor.onBehalfOf?.id !== viewer.id ||
        current.msg.userId !== viewer.id
      )
        return;
      return { actor: current.actor, io: new SingleShotIO() };
    }
    const owned = await originalBinding(row.originalOrganization.ingressRunId, row.message);
    if (
      !owned ||
      (owned.actor.id !== viewer.id &&
        (owned.envelope.source !== "mcp" || owned.actor.onBehalfOf?.id !== viewer.id || owned.msg.userId !== viewer.id))
    )
      return;
    return guardOrganizationConfirmation(row, owned.actor);
  }
  async function machineHistory(request: Omit<OrganizationExecutionRequest, "io">): Promise<HistoryItem[]> {
    const current = await options.authentication.resolveEnvelope(request.envelope);
    if (
      current.status !== "resolved" ||
      request.envelope.actor.stream !== null ||
      current.actor.kind !== "service" ||
      current.actor.id !== request.actor.id ||
      current.actor.viewingAs ||
      !(await organization.authorizeExecution(request.envelope)) ||
      !authorize(current.actor, "runs:read", { type: "command", id: "runs.list" }).allow
    )
      throw new Error("The original machine history is unavailable.");
    const visibleTo = allOf([
      predicateFor(current.actor, "runs:read", "run"),
      { kind: "user-is", userId: current.msg.userId },
      { kind: "channels-in", channelIds: new Set([request.msg.channelId]) },
    ]);
    const listed = await options.runs.listRuns({
      status: "all",
      visibleTo,
      threadKey: request.msg.threadKey,
      limit: RUN_LIST_MAX_LIMIT,
      includeDurableHistory: true,
    });
    if (!listed.durableHistory || listed.storeUnavailable || listed.ledgerUnavailable)
      throw new Error("The original machine history is unavailable.");
    const sourceRuns = listed.runs.filter(
      (run) => run.id !== request.runId && (run.postedBy ?? run.authenticatedAs ?? run.userId) === current.actor.id,
    );
    if (!sourceRuns.length && listed.nextBefore) throw new Error("The original machine history is incomplete.");
    const turns = [];
    for (const row of sourceRuns) {
      const read = await options.runs.getRun(row.id, { include: "messages" });
      if (
        !read.ok ||
        !matchesPredicate(visibleTo, read.value) ||
        (read.value.postedBy ?? read.value.authenticatedAs ?? read.value.userId) !== current.actor.id ||
        read.value.threadKey !== request.msg.threadKey
      )
        throw new Error("The original machine history is unavailable.");
      const origin = await options.ledger.readIngressByRun(row.id);
      if (
        origin.status !== "record" ||
        !origin.record.origin ||
        origin.record.origin.source !== request.envelope.source ||
        identityKey(origin.record.origin.actor.identity) !== identityKey(request.envelope.actor.identity) ||
        origin.record.origin.actor.stream !== null ||
        origin.record.origin.sourceReference?.credentialDigest !== request.envelope.sourceReference?.credentialDigest ||
        origin.record.origin.sourceReference?.userId !== current.msg.userId ||
        origin.record.origin.sourceReference?.channelId !== request.msg.channelId ||
        origin.record.origin.sourceReference?.threadKey !== request.msg.threadKey
      )
        throw new Error("The original machine source is unavailable.");
      const proved = await options.authentication.resolveEnvelope(origin.record.origin);
      if (
        proved.status !== "resolved" ||
        proved.actor.id !== current.actor.id ||
        !(await organization.authorizeReply(origin.record.origin))
      )
        throw new Error("The original machine source is unavailable.");
      turns.push(turnOf(read.value));
    }
    turns.sort((a, b) => a.startedAt - b.startedAt);
    return historyOf(turns);
  }
  // The captured sink may read its own first input; rehosting still requires uncertain custody.
  async function machineInput(message: IncomingMessage, historyOwner?: string) {
    const pointer = originalOrganizationDispatchOf(message);
    if (!pointer) return;
    const owned = await originalBinding(pointer.ingressRunId, message);
    if (
      !owned ||
      (owned.originalStatus !== "uncertain" &&
        !(owned.originalStatus === "dispatching" && pointer.ingressRunId === historyOwner)) ||
      owned.envelope.actor.stream !== null ||
      owned.actor.kind !== "service" ||
      owned.receipt.revision !== pointer.organizationSequence ||
      owned.envelope.sourceReference?.sourceRepository !== pointer.organizationRepo
    )
      return;
    const ref = owned.envelope.sourceReference;
    if (
      !ref ||
      owned.msg.text !== message.text ||
      ref.channelId !== message.channelId ||
      ref.messageId !== message.messageId ||
      ref.authenticatedAs !== message.authenticatedAs ||
      ref.postedBy !== message.postedBy ||
      JSON.stringify(ref.approvalConnection ?? null) !== JSON.stringify(message.approvalConnection ?? null)
    )
      return;
    return owned;
  }
  async function attachedMetadata(request: Omit<OrganizationExecutionRequest, "io">) {
    if (!request.envelope.context.length) return;
    const fresh = await options.authentication.resolveEnvelope(request.envelope);
    if (fresh.status !== "resolved") throw new Error("Attached work context is unavailable.");
    const context = { actor: fresh.actor, authentication: fresh.authentication };
    const predicate = readableRuns(fresh.actor);
    const rows: HomeContextMetadata[] = [];
    const privateReads: { instance: CoordinatorInstance; unit: CoordinatorUnit }[] = [];
    const prUrl = (repo: string, number: number) =>
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && Number.isSafeInteger(number) && number > 0
        ? `https://github.com/${repo}/pull/${number}`
        : undefined;
    for (const ref of request.envelope.context) {
      if (!(await options.canReadContext(context, ref))) throw new Error("Attached work context is unavailable.");
      const base = { kind: ref.kind, key: ref.key };
      if (ref.kind === "repository") {
        rows.push({ ...base, url: `https://github.com/${ref.key}`, repository: ref.key });
      } else if (ref.kind === "unit") {
        const key = parseUnitKey(ref.key);
        if (!key) throw new Error("Attached work context is unavailable.");
        const [instance, units] = await Promise.all([
          options.coordinator.get(key.instanceId),
          options.coordinator.listUnits(key.instanceId),
        ]);
        const matching = units.filter((unit) => unitKeyOf(unit) === ref.key);
        if (!instance || instance.id !== key.instanceId || matching.length !== 1)
          throw new Error("Attached work context is unavailable.");
        const unit = matching[0]!;
        const privateRead = unit.workBrief !== undefined && (await canReadPrivateUnit(context, instance, unit));
        if (privateRead) privateReads.push({ instance, unit });
        const facts = privateRead ? unitFactsForPrivateRecipient(unit) : unitFactsOf(unit);
        rows.push({
          ...base,
          url: `/runs/unit/${encodeURIComponent(ref.key)}`,
          title: facts.title,
          repository: instance.repo,
          branch: facts.branch,
          state: facts.ending?.kind ?? facts.idle?.why,
          pullRequest: facts.pr && prUrl(instance.repo, facts.pr.number),
        });
      } else if (ref.kind === "pipeline") {
        const instance = await options.coordinator.get(ref.key);
        if (!instance || instance.id !== ref.key || !(await options.runs.listInstanceUnits(ref.key, predicate)).length)
          throw new Error("Attached work context is unavailable.");
        rows.push({ ...base, url: `/pipelines/${encodeURIComponent(ref.key)}`, repository: instance.repo });
      } else if (ref.kind === "run") {
        const run = await options.runs.getRun(ref.key);
        if (!run.ok || run.value.id !== ref.key || !matchesPredicate(predicate, run.value))
          throw new Error("Attached work context is unavailable.");
        rows.push({
          ...base,
          url: `/runs/${encodeURIComponent(ref.key)}`,
          repository: run.value.repo,
          agent: run.value.agent,
          state: run.value.status,
          pullRequest: run.value.repo && run.value.pr && prUrl(run.value.repo, run.value.pr.number),
        });
      } else if (ref.kind === "pull-request") {
        const match = /^([^#]+)#([1-9][0-9]*)$/.exec(ref.key);
        const url = match && prUrl(match[1]!, Number(match[2]));
        const read =
          match && (await options.runs.listFindings({ repo: match[1]!, number: Number(match[2]) }, predicate));
        if (!url || !read || !read.ok) throw new Error("Attached work context is unavailable.");
        rows.push({ ...base, url, repository: match![1]! });
      } else {
        // A thread attachment names the readable address, not its transcript bytes.
        rows.push({ ...base, url: `/threads/${encodeURIComponent(ref.key)}` });
      }
    }
    const final = await options.authentication.resolveEnvelope(request.envelope);
    if (final.status !== "resolved" || final.actor.id !== fresh.actor.id)
      throw new Error("Attached work context is unavailable.");
    const checked = { actor: final.actor, authentication: final.authentication };
    for (const ref of request.envelope.context)
      if (!(await options.canReadContext(checked, ref))) throw new Error("Attached work context is unavailable.");
    for (const read of privateReads)
      if (!(await canReadPrivateUnit(checked, read.instance, read.unit)))
        throw new Error("Attached work context is unavailable.");
    return homeAttachedContext(rows);
  }
  async function withAttachedMetadata(request: Omit<OrganizationExecutionRequest, "io">, history: HistoryItem[]) {
    const metadata = await attachedMetadata(request);
    if (!metadata) return history;
    // The existing builder drops leading assistant slots. A quoted, uncredited
    // context preface keeps the metadata separate from the next actual user.
    // It follows old orphan assistant turns, so those still remain excluded.
    return [
      ...history,
      ...(!history.some((turn) => turn.role === "user")
        ? [
            {
              role: "user" as const,
              text: wrapUntrusted(
                "Server-provided work references follow as quoted metadata. This is not a person's message.",
              ),
            },
          ]
        : []),
      metadata,
    ];
  }
  function sink(request: Omit<OrganizationExecutionRequest, "io">): ChannelIO {
    const io = Object.create(host.sink(request)) as ChannelIO;
    io.readSavedNativeMedia = async (reference, message) => {
      const pointer = originalOrganizationDispatchOf(message);
      if (
        !pointer?.savedNativeMediaSource ||
        pointer.ingressRunId !== request.runId ||
        pointer.organizationSequence !== request.receipt.revision ||
        JSON.stringify(pointer.savedNativeMediaSource) !== JSON.stringify(reference) ||
        reference.sourceRunId === request.runId ||
        (await nativeMediaDigest(message.text)) !== reference.intentDigest
      )
        return;
      const currentChoice = async () => {
        const choice = await originalBinding(request.runId, message, "metadata");
        if (
          !choice ||
          choice.actor.viewingAs ||
          choice.envelope.continuation?.kind !== "confirm" ||
          choice.envelope.continuation.id !== reference.confirmationId ||
          !(await organization.authorizeExecution(choice.envelope)) ||
          !options.canReadContext
        )
          return;
        const actual = await options.authentication.resolveEnvelope(choice.envelope);
        if (
          actual.status !== "resolved" ||
          actual.actor.id !== choice.actor.id ||
          !(await options.canReadContext(
            { actor: actual.actor, authentication: actual.authentication },
            { kind: "run", key: reference.sourceRunId },
          ))
        )
          return;
        return choice;
      };
      const choice = await currentChoice();
      if (!choice) return;
      const source = await originalBinding(reference.sourceRunId);
      if (
        !source ||
        source.actor.id !== choice.actor.id ||
        source.envelope.nativeMediaDigest !== reference.sourceDigest ||
        source.receipt.revision !== reference.sourceSequence
      )
        return;
      const final = await currentChoice();
      if (!final || final.actor.id !== choice.actor.id) return;
      return { images: source.msg.images, documents: source.msg.documents, staged: source.msg.staged };
    };
    io.authoritativePrivateSourceHistory = (id) =>
      id === request.runId ? originalPrivateSourceHistory(id) : Promise.resolve(undefined);
    if (request.envelope.actor.stream !== null || request.actor.kind !== "service") {
      const originalHistory = io.authoritativePrivateHistory?.bind(io);
      const rehost = io.rehostOrganizationInput?.bind(io);
      if (originalHistory)
        io.authoritativePrivateHistory = async (message, trace) => {
          const history = await originalHistory(message, trace);
          const pointer = message && originalOrganizationDispatchOf(message);
          const owned =
            pointer && pointer.ingressRunId !== request.runId
              ? trace?.span
                ? await closedStage(trace.span, "home.history.binding", () =>
                    originalBinding(pointer.ingressRunId, message),
                  )
                : await originalBinding(pointer.ingressRunId, message)
              : request;
          if (!owned) throw new Error("Attached work context is unavailable.");
          if (!owned.envelope.context.length) return history;
          const result = trace?.span
            ? await closedStage(trace.span, "home.history.attached_metadata", () =>
                withAttachedMetadata(owned, history),
              )
            : await withAttachedMetadata(owned, history);
          await originalHistory(message, trace);
          return result;
        };
      if (rehost)
        io.rehostOrganizationInput = async (message, trace) => {
          const original = originalOrganizationDispatchOf(message);
          if (original?.savedNativeMediaSource) {
            const media = await io.readSavedNativeMedia!(original.savedNativeMediaSource, message);
            const choice = media && (await originalBinding(original.ingressRunId, message, "metadata"));
            if (!choice) return;
            const restored = {
              ...choice,
              msg: withOriginalOrganizationDispatch({ ...choice.msg, text: message.text, ...media }, original),
            };
            return { msg: restored.msg, io: sink(restored) };
          }
          if (original?.nativeMediaDigest) {
            const owned = await originalBinding(original.ingressRunId, message);
            return owned && owned.envelope.nativeMediaDigest === original.nativeMediaDigest
              ? { msg: owned.msg, io: owned.io }
              : undefined;
          }
          const restored = await rehost(message, trace);
          const pointer = restored && originalOrganizationDispatchOf(restored.msg);
          const owned =
            pointer &&
            (trace?.span
              ? await closedStage(trace.span, "home.history.binding", () =>
                  originalBinding(pointer.ingressRunId, restored.msg),
                )
              : await originalBinding(pointer.ingressRunId, restored.msg));
          return owned ? { msg: owned.msg, io: owned.io } : undefined;
        };
      const saved = originalOrganizationDispatchOf(request.msg)?.savedNativeMediaSource;
      if (saved) {
        const verify = io.verifyOrganizationPrivateAudience?.bind(io);
        io.verifyOrganizationPrivateAudience = async (audience) => {
          if (!(await io.readSavedNativeMedia!(saved, request.msg)))
            return { ok: false, code: "saved-context-unproved" };
          return verify ? verify(audience) : { ok: false, code: "saved-context-unproved" };
        };
      }
      return io;
    }
    return Object.assign(io, {
      authoritativePrivateHistory: async (message?: IncomingMessage) => {
        const owned = message ? await machineInput(message, request.runId) : request;
        if (!owned) throw new Error("The original machine input is unavailable.");
        const original = await machineHistory(owned);
        if (!owned.envelope.context.length) return original;
        const history = await withAttachedMetadata(owned, original);
        await machineHistory(owned);
        return history;
      },
      rehostOrganizationInput: async (message: IncomingMessage) => {
        const owned = await machineInput(message);
        if (!owned) return;
        await machineHistory(owned);
        return { msg: owned.msg, io: sink(owned) };
      },
    });
  }
  async function historyOptions(request: OrganizationExecutionRequest) {
    const owner = {
      organizationSequence: request.receipt.revision,
      ...(request.envelope.sourceReference?.sourceRepository
        ? { organizationRepo: request.envelope.sourceReference.sourceRepository }
        : {}),
    };
    return request.envelope.destination.kind === "broad"
      ? {
          ...owner,
          authoritativeHistory: true,
          organizationConversation: true,
          ...(request.envelope.sourceReference?.contextMode
            ? { contextMode: request.envelope.sourceReference.contextMode }
            : {}),
          seed: await request.io.authoritativePrivateHistory!(),
        }
      : owner;
  }
  async function readOriginalRun(runId: string) {
    const live = registry.getById(runId);
    if (live && !live.finished) return { status: "running" as const };
    if (live?.finished && live.status === "completed")
      return { status: "completed" as const, outcome: "Original run completed." };
    const stored = await core.runStore.get(runId);
    if (stored?.status === "completed" && !stored.provisional)
      return { status: "completed" as const, outcome: "Original run completed." };
    const original = await options.ledger.readIngressByRun(runId);
    const origin = original.status === "record" ? original.record.origin : undefined;
    const unitKey = origin?.target ? unitOfTarget(origin.target.key) : undefined;
    const key = unitKey && parseUnitKey(unitKey),
      reference = origin?.sourceReference;
    if (key && reference) {
      const events = await options.coordinator.listEvents(key);
      if (
        events.some(
          (event) =>
            event.organizationIngressRunId === runId &&
            event.id === reference.messageId &&
            event.sender === reference.userId &&
            event.authenticatedAs === reference.authenticatedAs &&
            event.postedBy === reference.postedBy,
        )
      )
        return { status: "completed" as const, outcome: "Original answer recorded." };
    }
    return { status: "unknown" as const };
  }
  core.revalidateNativeMediaSource = async (dependency, consumer) => {
    const pointer = originalOrganizationDispatchOf(consumer.msg);
    if (!pointer || consumer.actor.viewingAs) return false;
    const reader = async () => {
      const current = await originalBinding(pointer.ingressRunId, consumer.msg, "metadata");
      if (!current || current.actor.id !== consumer.actor.id || !options.canReadContext) return;
      const proof = await options.authentication.resolveEnvelope(current.envelope);
      if (proof.status !== "resolved" || proof.actor.viewingAs || proof.actor.id !== current.actor.id) return;
      const context = { actor: proof.actor, authentication: proof.authentication };
      for (const runId of [dependency.executionRunId, dependency.reference.sourceRunId])
        if (runId !== pointer.ingressRunId && !(await options.canReadContext(context, { kind: "run", key: runId })))
          return;
      return current;
    };
    const current = await reader();
    const choice = current && (await originalBinding(dependency.executionRunId, undefined, "metadata"));
    if (
      !choice ||
      choice.receipt.revision !== dependency.executionSequence ||
      choice.envelope.actor.stream === null ||
      choice.envelope.actor.stream !== current!.envelope.actor.stream
    )
      return false;
    if (
      dependency.reference.kind === "confirmed" &&
      (choice.envelope.continuation?.kind !== "confirm" ||
        choice.envelope.continuation.id !== dependency.reference.confirmationId)
    )
      return false;
    const source = await originalBinding(dependency.reference.sourceRunId);
    if (
      !source ||
      source.receipt.revision !== dependency.reference.sourceSequence ||
      source.envelope.nativeMediaDigest !== dependency.reference.sourceDigest ||
      source.envelope.actor.stream !== choice.envelope.actor.stream
    )
      return false;
    if (
      dependency.reference.kind === "original" &&
      (dependency.executionRunId !== dependency.reference.sourceRunId ||
        dependency.executionSequence !== dependency.reference.sourceSequence ||
        (await nativeMediaDigest(source.envelope.content)) !== dependency.reference.intentDigest)
    )
      return false;
    return !!(await reader());
  };
  core.guardOrganizationConfirmation = (row, chooser, purpose) => guardOrganizationConfirmation(row, chooser, purpose);
  const runtime = createOrganizationRuntime({
    store: options.store,
    service: organization,
    ledger: options.ledger,
    owner: options.owner,
    leaseMs: options.leaseMs,
    batchSize: options.batchSize,
    contentTtlMs: options.contentTtlMs,
    sourceSnapshotTtlMs: options.sourceSnapshotTtlMs,
    now: options.now,
    resolveActor: resolveOriginalInput,
    reportOwnerFailure: options.reportOwnerFailure,
    launch: options.launch,
    readOriginalRun,
    sink,
    dispatchOwned: async (request) =>
      ownerOutcome(
        await dispatch(core, request.msg, request.io, {
          ingressRunId: request.runId,
          ...(await historyOptions(request)),
        }),
      ),
    answerOwned: async (request) => {
      const unitKey = request.envelope.target && unitOfTarget(request.envelope.target.key);
      const saved = unitKey ? await question(unitKey) : undefined;
      if (!unitKey || !saved?.gate || targetKey(saved.unit, saved.gate) !== request.envelope.target!.key)
        return { status: "refused", reason: "The original question changed. No new work started." };
      return ownerOutcome(
        await dispatch(core, withChatActor(request.msg, request.actor), request.io, {
          ingressRunId: request.runId,
          answerTarget: { unitKey, expectedQuestion: saved.gate },
        }),
      );
    },
    confirmOwned: async (request) => {
      const choice = request.envelope.continuation;
      if (!choice) return { status: "refused", reason: "The saved choice is unavailable." };
      const choiceCore = {
        ...core,
        guardOrganizationConfirmation: async (
          row: Parameters<ConfirmationSourceGuard>[0],
          chooser?: Actor,
          purpose?: "confirm" | "cancel" | "read",
        ) => {
          const source = await guardOrganizationConfirmation(
            row,
            chooser,
            purpose ?? (choice.kind === "cancel" ? "cancel" : "confirm"),
          );
          if (!source || !row.originalOrganization) return;
          // A is read authority for this exact saved offer. The distinct choice
          // retains B's output receiver, status methods and actual credential.
          const io = Object.create(request.io) as ChannelIO;
          const history = async () => {
            if (!(await guardOrganizationConfirmation(row, chooser)))
              throw new Error("The saved source context is unavailable.");
            await request.io.authoritativePrivateHistory!();
            const turns = await originalPrivateSourceHistory(row.originalOrganization!.ingressRunId);
            if (!turns || !(await guardOrganizationConfirmation(row, chooser)))
              throw new Error("The saved source context is unavailable.");
            await request.io.authoritativePrivateHistory!();
            return turns;
          };
          io.history = history;
          io.authoritativePrivateHistory = history;
          return { actor: source.actor, io, ...(source.message ? { message: source.message } : {}) };
        },
      };
      const sourceIO = Object.create(request.io) as ChannelIO;
      const saved = await core.confirmations?.get?.(choice.id);
      if (saved?.originalOrganization) {
        const guarded = await choiceCore.guardOrganizationConfirmation(saved, request.actor);
        if (guarded) {
          sourceIO.history = guarded.io.history;
          sourceIO.authoritativePrivateHistory = guarded.io.authoritativePrivateHistory;
        }
      }
      return ownerOutcome(
        await dispatchClick(
          choiceCore,
          {
            ...choice,
            actor: request.actor,
            io: sourceIO,
            ...(request.msg.approvalConnection ? { connectionId: request.msg.approvalConnection.id } : {}),
          },
          {
            ingressRunId: request.runId,
            choiceMessage: withOriginalOrganizationDispatch(request.msg, {
              ingressRunId: request.runId,
              organizationSequence: request.receipt.revision,
              ...(request.envelope.sourceReference?.sourceRepository
                ? { organizationRepo: request.envelope.sourceReference.sourceRepository }
                : {}),
            }),
            threadKey: request.msg.threadKey,
            ...(await historyOptions(request)),
          },
        ),
      );
    },
  });
  host = createHomeHost({
    organizationId: options.organizationId,
    organization,
    historyContext: async (receiptId, reader, request, role) => {
      const resolved = await organization.resolve(reader.authentication);
      if (!resolved)
        throw historyFailure("history_provenance_unavailable", "The history source could not be verified.");
      const provenance = await options.store.execute({ action: "provenance", ...resolved, receiptId });
      if (provenance.status !== "provenance")
        throw historyFailure("history_provenance_unavailable", "The history source could not be verified.");
      const ref = provenance.provenance.sourceReference;
      if (!ref?.messageId) {
        if (role === "assistant")
          throw historyFailure("history_provenance_unavailable", "The history source could not be verified.");
        return;
      }
      const source = provenance.provenance.source;
      const key =
        source === "slack"
          ? `${ref.channelId}:${ref.messageId}`
          : source === "browser" && ref.messageId.startsWith("browser:")
            ? ref.messageId.slice("browser:".length)
            : ref.messageId;
      const original = await options.store.execute({
        action: "submission",
        organization: options.organizationId,
        actor: provenance.provenance.actor,
        source: provenance.provenance.source,
        key,
      });
      if (original.status !== "submission" || original.receipt.id !== receiptId || !original.receipt.ownerRunId) {
        if (role === "assistant")
          throw historyFailure("history_producer_unavailable", "The retained history producer could not be verified.");
        return;
      }
      const runId = original.receipt.ownerRunId;
      const live = (await core.runLedger.readLiveRuns()).find((row) => row.runId === runId);
      const stored = live ? undefined : await core.runStore.get(runId);
      let context = live?.state.contextDependencies ?? stored?.contextDependencies;
      const marked =
        original.envelope.nativeMediaDigest !== undefined || original.envelope.continuation?.kind === "confirm";
      if (role === "assistant" && !live && !stored)
        throw historyFailure("history_producer_unavailable", "The retained history producer could not be verified.");
      if (marked && role === "assistant" && (!isContextDependencies(context) || !context.nativeMediaSources?.length))
        throw historyFailure("history_context_unavailable", "The retained history source could not be verified.");
      const pointer = live?.meta.request?.originalOrganizationInput as
        import("../core/dispatch/originalOrganizationInput.js").OriginalOrganizationDispatch | undefined;
      if (
        context &&
        typeof context === "object" &&
        ("nativeMediaSources" in context || "savedNativeMediaSources" in context) &&
        !isContextDependencies(context)
      )
        throw historyFailure("history_context_unavailable", "The saved history source could not be verified.");
      if (pointer?.savedNativeMediaSource && (!isContextDependencies(context) || !context.nativeMediaSources?.length))
        throw historyFailure("history_context_unavailable", "The saved history source could not be verified.");
      if (role === "assistant") {
        const producer = live?.meta ?? stored;
        if (!producer || !isContextDependencies(context) || context.status !== "known")
          throw historyFailure("history_context_unavailable", "The saved history source could not be verified.");
        context = mergeContextDependencies(context, {
          version: 1,
          status: "known",
          revision: 0,
          slack: [],
          mcp: [],
          origins: [
            { runId, requester: producer.userId, channelId: producer.channelId, threadKey: producer.threadKey },
          ],
        });
      } else if (!isContextDependencies(context) || !context.nativeMediaSources?.length) return;
      if (!isContextDependencies(context))
        throw historyFailure("history_context_unavailable", "The saved history source could not be verified.");
      const consumer = withOriginalOrganizationDispatch(withChatActor(request.msg, reader.actor), {
        ingressRunId: request.runId,
        organizationSequence: request.receipt.revision,
      });
      if (!(await contextAccessForMessage(core, { msg: consumer, io: sink(request) }).validateDependencies(context)).ok)
        throw historyFailure("history_context_unavailable", "The saved history source could not be verified.");
      // Carry the same canonical envelope so the later execution keeps and
      // rechecks this provenance through compaction, tools and publication.
      return context;
    },
    normalizeHistory: async (reader, request, turns) => {
      const consumer = withOriginalOrganizationDispatch(withChatActor(request.msg, reader.actor), {
        ingressRunId: request.runId,
        organizationSequence: request.receipt.revision,
      });
      const contexts = turns.flatMap((turn) => (turn.context ? [turn.context] : []));
      const normalized = await contextAccessForMessage(core, {
        msg: consumer,
        io: sink(request),
      }).normalizeDependencies(contexts, contexts);
      let index = 0;
      return turns.map((turn) => (turn.context ? { ...turn, context: normalized[index++]! } : turn));
    },
    ledger: options.ledger,
    store: options.store,
    directory: options.store.directory,
    authentication: options.authentication,
    runtime,
    confirmations: core.confirmations,
    canReadOffer,
    now: options.now,
    policyEpoch: options.policyEpoch,
    readThread: actualThread,
    commands: projection.commands,
    prepareAdmission,
    sourceRepository: options.sourceRepository,
    repositories: options.repositories,
    refreshProjection: options.refreshProjection,
    canReadContext: options.canReadContext,
    sourceIo: options.sourceIo,
    publicBaseUrl: options.publicBaseUrl,
  });
  async function replayNativeChoice(
    msg: IncomingMessage,
    evidence: OrganizationNativeEvidence,
    continuation: NonNullable<OrganizationAdmissionInput["continuation"]>,
  ) {
    if (evidence.source === "browser" || !msg.messageId) return;
    const current = await options.authentication.resolveNative(msg, evidence);
    if (current.status !== "resolved") return { status: current.status };
    const addressed = await organization.resolve(current.authentication);
    if (!addressed) return { status: "not_found" as const };
    const key = evidence.source === "slack" ? `${msg.channelId}:${msg.messageId}` : msg.messageId;
    const saved = await options.store.execute({ action: "submission", ...addressed, source: evidence.source, key });
    if (saved.status === "not_found") return;
    if (saved.status !== "submission" || saved.envelope.sourceReference?.credentialDigest !== evidence.credentialDigest)
      return { status: "not_found" as const };
    const original = await options.authentication.resolveEnvelope(saved.envelope);
    if (original.status !== "resolved" || original.actor.id !== current.actor.id)
      return { status: "not_found" as const };
    return organization.replay(original.authentication, {
      key,
      content: "",
      context: [],
      destination: saved.envelope.destination,
      continuation,
    });
  }
  async function admitNative(
    msg: IncomingMessage,
    evidence: OrganizationNativeEvidence,
    continuation?: OrganizationAdmissionInput["continuation"],
    trace?: TraceOptions,
  ) {
    observeAdmission(trace, { stage: "native-input" });
    const hasMedia = !!(msg.images?.length || msg.documents?.length || msg.staged?.length);
    const media = msg.nativeMedia && nativeMediaSchema.safeParse(msg.nativeMedia);
    if (
      evidence.source === "browser" ||
      !msg.messageId ||
      (hasMedia &&
        (evidence.source !== "slack" ||
          !media?.success ||
          !msg.nativeMediaDigest ||
          msg.nativeMediaDigest !== (await nativeMediaDigest(media.data)) ||
          !(await matchesNativeMedia(media.data, msg))))
    ) {
      if (hasMedia) observeAdmission(trace, { contextSelection: "media" });
      return { status: "unavailable" as const };
    }
    observeAdmission(trace, { stage: "native-proof" });
    const current = await options.authentication.resolveNative(msg, evidence);
    if (current.status !== "resolved") return { status: current.status };
    const context = { actor: current.actor, authentication: current.authentication };
    const event = evidence.source === "slack" ? `${msg.channelId}:${msg.messageId}` : msg.messageId;
    const input: OrganizationAdmissionInput = {
      key: event,
      sourceEvent: event,
      destination: { kind: "broad" },
      workload: continuation ? "act" : "message",
      target: null,
      content: continuation ? "" : msg.text,
      ...(hasMedia && media?.success ? { nativeMedia: media.data, nativeMediaDigest: msg.nativeMediaDigest } : {}),
      ...(continuation ? { continuation } : {}),
      context: [],
    };
    observeAdmission(trace, { stage: "source-lookup" });
    const source = await organization.resolve(current.authentication);
    if (!source) return { status: "not_found" as const };
    const original = await options.store.execute({
      action: "submission",
      ...source,
      source: evidence.source,
      key: event,
    });
    if (original.status === "submission") {
      const reference = original.envelope.sourceReference;
      observeAdmission(trace, {
        contextSelection: reference?.contextMode === "request" ? "retained_request" : "existing_key",
      });
      if (
        !reference ||
        reference.userId !== msg.userId ||
        reference.channelId !== msg.channelId ||
        reference.threadKey !== msg.threadKey ||
        reference.messageId !== msg.messageId ||
        reference.authenticatedAs !== msg.authenticatedAs ||
        reference.postedBy !== msg.postedBy
      )
        return { status: "conflict" as const };
      // An exact source retry retains its recorded destination after ownership changes.
      input.destination = original.envelope.destination;
    } else if (original.status !== "not_found") return original;
    else if (evidence.source === "slack" && current.privateSource) {
      const page = await readOwnedThread(options.runs, msg.threadKey);
      if (page.kind === "unavailable") return { status: "unavailable" as const };
      const owner = await ownerOf(page.runs, (id) => options.coordinator.listUnits(id), msg.threadKey);
      if (owner.kind === "unavailable") return { status: "unavailable" as const };
      if (owner.kind === "pipeline_ambiguous") return { status: "unavailable" as const };
      if (
        owner.kind === "unit" ||
        owner.kind === "pipeline" ||
        page.runs.some((run) => run.parentInstanceId !== undefined || run.parentRunId !== undefined)
      )
        input.destination = { kind: "thread", thread: msg.threadKey };
    }
    observeAdmission(trace, { stage: "replay" });
    const replay = await organization.replay(current.authentication, input);
    if (replay) return replay;
    observeAdmission(trace, { stage: "source-context" });
    const choice = continuation ? await core.confirmations?.get?.(continuation.id) : undefined;
    if (
      continuation &&
      (!choice ||
        choice.message.threadKey !== msg.threadKey ||
        (choice.message.postedBy ?? choice.message.authenticatedAs ?? choice.message.userId) !== current.actor.id ||
        !(await canReadOffer(context, choice)) ||
        (current.authentication.source === "mcp" && continuation.kind === "confirm" && !hasConfirmationConsent(choice)))
    )
      return { status: "not_found" as const };
    let independent: ReturnType<typeof requestOnlyPrTarget>;
    const selectContext = (): RequestContextSelection => {
      if (original.status !== "not_found")
        return original.status === "submission" && original.envelope.sourceReference?.contextMode === "request"
          ? "retained_request"
          : "existing_key";
      if (evidence.source !== "mcp") return "source";
      if (current.authentication.kind !== "human") return "actor";
      if (!current.privateSource) return "private_source";
      if (current.actor.viewingAs || current.actor.onBehalfOf) return "delegation";
      if (continuation) return "continuation";
      if (hasMedia) return "media";
      if (operatorModeOf(core.config.config) !== "on") return "routing";
      if (!freshReviewRequested(msg.text)) return "context";
      independent = requestOnlyPrTarget(msg.text);
      return independent ? "selected" : "target";
    };
    observeAdmission(trace, { contextSelection: selectContext() });
    const repository =
      independent?.repo ??
      (choice?.originalOrganization
        ? choice.originalOrganization.organizationRepo
        : await options.sourceRepository?.(context, input));
    let authentication = current.authentication;
    if (authentication.sourceReference)
      authentication = {
        ...authentication,
        sourceReference: {
          ...authentication.sourceReference,
          ...(repository ? { sourceRepository: repository } : {}),
          ...(independent ? { contextMode: "request" as const } : {}),
        },
      };
    const addressed = await organization.resolve(authentication);
    if (!addressed) return { status: "not_found" as const };
    if (current.privateSource && addressed.actor.stream !== null && authentication.sourceReference) {
      observeAdmission(trace, { stage: "private-epoch" });
      const epoch = await host.currentEpoch({ actor: current.actor, authentication }, trace);
      if (!epoch) return { status: "unavailable" as const };
      authentication = {
        ...authentication,
        sourceReference: { ...authentication.sourceReference, privateSource: true, capturedPrivateEpoch: epoch },
      };
    }
    observeAdmission(trace, { stage: "admit-store" });
    const result = await organization.admit(authentication, input);
    if (result.status !== "receipt") return result;
    observeAdmission(trace, { stage: "reconcile", receipt: result.receipt });
    await runtime.reconcile(options.organizationId);
    observeAdmission(trace, { stage: "refresh" });
    // A failed refresh cannot erase the admission receipt already observed.
    let refreshFailure: import("../core/organization/admissionTrace.js").AdmissionRefreshFailure = "unavailable-result";
    const settled = await organization.replay(authentication, input).catch((error: unknown) => {
      refreshFailure = admissionExceptionKindOf(error);
      return { status: "unavailable" as const };
    });
    if (settled?.status === "unavailable") {
      observeAdmission(trace, { reason: "refresh-unavailable", refreshFailure });
      return result;
    }
    return settled?.status === "receipt" ? { ...settled, duplicate: result.duplicate } : (settled ?? result);
  }
  async function answers(context: HomeRuntimeContext, rows: readonly HomeUnit[]) {
    const result: Record<string, HomeAnswerTarget> = {};
    if (
      context.actor.viewingAs ||
      ((await options.viewScope?.(context)) ?? workViewScopeOf(context.actor).mode) === "person"
    )
      return result;
    for (const row of rows) {
      const saved = await question(row.unit.unit),
        thread = saved?.unit.threadKey;
      if (!saved?.gate || !thread) continue;
      const read = await readThread(context, thread);
      if (!read?.canWrite || read.target?.key !== targetKey(saved.unit, saved.gate)) continue;
      const entry = read.entries.find((entry) => entry.id.startsWith("question:"));
      if (entry)
        result[row.unit.unit] = {
          thread,
          revision: read.revision,
          question: entry.content,
          ...(saved.gate.primaryAction ? { primaryAction: saved.gate.primaryAction } : {}),
        };
    }
    return result;
  }
  async function mergeActions(context: HomeRuntimeContext, rows: readonly HomeUnit[]) {
    const result: Record<string, HomeMergeAction> = {};
    if (
      context.actor.viewingAs ||
      ((await options.viewScope?.(context)) ?? workViewScopeOf(context.actor).mode) === "person"
    )
      return result;
    const actual = await current(context).catch(() => undefined);
    if (
      !actual ||
      actual.actor.kind !== "user" ||
      !authorize(actual.actor, "merge:write", { type: "command", id: "pulls.merge" }).allow ||
      !(await options.mergeLogin?.(actual.actor.id))
    )
      return result;
    const epoch = await host.currentEpoch(context);
    if (!epoch) return result;
    const recipients = new Set([actual.actor.id, ...((await options.provedActorIds?.(context)) ?? [])]);
    const pipelines = new Map<string, { instance: CoordinatorInstance; units: Map<string, CoordinatorUnit> } | null>();
    for (const row of rows) {
      const key = parseUnitKey(row.unit.unit);
      if (!key) continue;
      if (!pipelines.has(key.instanceId)) {
        const [instance, units] = await Promise.all([
          options.coordinator.get(key.instanceId),
          options.coordinator.listUnits(key.instanceId),
        ]);
        const byUnit = new Map(units.map((unit) => [unit.unit, unit]));
        pipelines.set(key.instanceId, instance && byUnit.size === units.length ? { instance, units: byUnit } : null);
      }
      const pipeline = pipelines.get(key.instanceId),
        unit = pipeline?.units.get(key.unit);
      const saved = pipeline && unit ? { instance: pipeline.instance, unit } : undefined;
      const a = saved?.unit.mergeAttention;
      if (
        !saved ||
        !a ||
        a.resolved ||
        !recipients.has(a.assignedTo) ||
        saved.unit.ending?.kind !== "merge_ready" ||
        saved.unit.pr?.number !== a.pr.number ||
        saved.unit.pr.url !== a.pr.url ||
        saved.unit.lastPush !== a.headSha
      )
        continue;
      const [owner, name] = saved.instance.repo.split("/");
      if (
        !owner ||
        !name ||
        !authorize(actual.actor, "repo:use", { type: "repo", owner, name }).allow ||
        !matchesPredicate(readableRuns(actual.actor), {
          userId: saved.instance.userId,
          channelId: saved.instance.channelId,
          repo: saved.instance.repo,
          channelVisibility: "unknown",
        })
      )
        continue;
      if (saved.unit.workBrief && !(await canReadPrivateUnit(context, saved.instance, saved.unit))) continue;
      result[row.unit.unit] = { kind: "merge", pr: `${saved.instance.repo}#${a.pr.number}`, head: a.headSha };
    }
    const fresh = await current(context).catch(() => undefined);
    return fresh?.actor.id === actual.actor.id && epoch === (await host.currentEpoch(context)) ? result : {};
  }
  async function readMergeObservation(
    context: HomeRuntimeContext,
    key: string,
  ): Promise<"observed" | "held" | "unchanged"> {
    if (
      !options.mergeFacts ||
      context.actor.viewingAs ||
      ((await options.viewScope?.(context)) ?? workViewScopeOf(context.actor).mode) === "person"
    )
      return "held";
    const saved = await question(key),
      a = saved?.unit.mergeAttention;
    if (
      !saved ||
      !a ||
      a.resolved ||
      saved.unit.ending?.kind !== "merge_ready" ||
      saved.unit.pr?.number !== a.pr.number ||
      saved.unit.pr.url !== a.pr.url ||
      saved.unit.lastPush !== a.headSha
    )
      return "unchanged";
    const actual = await current(context).catch(() => undefined);
    const recipients = new Set([actual?.actor.id, ...((await options.provedActorIds?.(context)) ?? [])]);
    const [owner, name] = saved.instance.repo.split("/");
    if (
      !actual ||
      actual.actor.kind !== "user" ||
      !owner ||
      !name ||
      !authorize(actual.actor, "repo:use", { type: "repo", owner, name }).allow ||
      !recipients.has(a.assignedTo) ||
      !matchesPredicate(readableRuns(actual.actor), {
        userId: saved.instance.userId,
        channelId: saved.instance.channelId,
        repo: saved.instance.repo,
        channelVisibility: "unknown",
      }) ||
      (saved.unit.workBrief && !(await canReadPrivateUnit(context, saved.instance, saved.unit)))
    )
      return "held";
    const epoch = await host.currentEpoch(context);
    if (!epoch) return "held";
    const facts = await options.mergeFacts(context, saved.instance, saved.unit).catch(() => undefined);
    if (
      !facts ||
      facts.headSha.toLowerCase() !== a.headSha.toLowerCase() ||
      !/^[0-9a-f]{40}$/i.test(facts.mergeCommitSha) ||
      !Number.isSafeInteger(facts.mergedAt) ||
      facts.mergedAt < 0 ||
      facts.mergedAt > options.now()
    )
      return "held";
    const fresh = await current(context).catch(() => undefined);
    if (
      !fresh ||
      fresh.actor.id !== actual.actor.id ||
      !authorize(fresh.actor, "repo:use", { type: "repo", owner, name }).allow ||
      epoch !== (await host.currentEpoch(context)) ||
      !matchesPredicate(readableRuns(fresh.actor), {
        userId: saved.instance.userId,
        channelId: saved.instance.channelId,
        repo: saved.instance.repo,
        channelVisibility: "unknown",
      }) ||
      (saved.unit.workBrief && !(await canReadPrivateUnit(context, saved.instance, saved.unit)))
    )
      return "held";
    const replaced = await options.coordinator.compareAndReplaceUnit(saved.unit, {
      ...saved.unit,
      mergeAttention: { ...a, resolved: { sha: facts.mergeCommitSha, at: facts.mergedAt } },
    });
    return replaced.ok ? "observed" : "held";
  }
  const observing = new Set<string>();
  async function observeMerge(context: HomeRuntimeContext, key: string): Promise<"observed" | "held" | "unchanged"> {
    if (observing.has(key) || observing.size >= options.batchSize) return "held";
    observing.add(key);
    try {
      return await readMergeObservation(context, key);
    } finally {
      observing.delete(key);
    }
  }
  let observationOffset = 0;
  function queueMergeObservations(context: HomeRuntimeContext, rows: readonly HomeUnit[]) {
    if (!options.mergeFacts || !rows.length || context.actor.viewingAs || observing.size >= options.batchSize) return;
    const offset = observationOffset % rows.length;
    const count = Math.min(rows.length, options.batchSize);
    for (let i = 0; i < count; i++) {
      if (observing.size >= options.batchSize) break;
      const key = rows[(offset + i) % rows.length]!.unit.unit;
      observationOffset = (offset + i + 1) % rows.length;
      if (observing.has(key)) continue;
      observing.add(key);
      try {
        options.launch(async () => {
          try {
            await readMergeObservation(context, key);
          } finally {
            observing.delete(key);
          }
        });
      } catch {
        observing.delete(key);
      }
    }
  }
  return {
    host,
    handler: host.handler,
    organization,
    runtime,
    readThread,
    answers,
    mergeActions,
    observeMerge,
    queueMergeObservations,
    canReadPrivateUnit,
    privateRead,
    questionOwner,
    readOriginalRun,
    originalBinding,
    originalPrivateSourceHistory,
    originalAudienceIO: async (sourceRunId: string, expected: { threadKey: string; userId: string }) => {
      const original = await originalBinding(sourceRunId, expected, "audience");
      if (!original) return;
      return Object.assign(Object.create(original.io) as ChannelIO, {
        authoritativePrivateSourceHistory: (requested: string) =>
          requested === sourceRunId ? originalPrivateSourceHistory(sourceRunId) : Promise.resolve(undefined),
      });
    },
    originalRequester: async (sourceRunId: string, expected: { threadKey: string; userId: string }) => {
      const owned = await originalBinding(sourceRunId, expected, "audience");
      return owned ? { status: "resolved" as const, actor: owned.actor } : { status: "unavailable" as const };
    },
    guardOrganizationConfirmation,
    revalidateNativeMediaSource: core.revalidateNativeMediaSource,
    approvalSource,
    admitNative,
    replayNativeChoice,
  };
}
