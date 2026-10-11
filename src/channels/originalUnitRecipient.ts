import { mapLimit } from "../core/mapLimit.js";
import { HOME_PRIVATE_READ_CONCURRENCY } from "../core/budgets.js";
import type { HomePrivateReadGroup } from "../core/home/service.js";
import { authorize } from "../core/authz/authorize.js";
import { matchesPredicate, predicateFor } from "../core/authz/predicate.js";
import { mainTaskClaimMatches } from "../core/coordinator/contract.js";
import { isUnitContext } from "../core/dispatch/unitContext.js";
import { identityKey } from "../core/identity/engine.js";
import { envelopeSchema, type OrganizationEnvelope } from "../core/organization/contract.js";
import { ingressRecordSchema } from "../core/runLedger/ingress.js";
import { privateWorkerThreadKey } from "../core/privateWorkerLog.js";
import type { Actor } from "../core/authz/types.js";
import type { ExternalIdentity } from "../core/identity/contract.js";
import type { UnitEventKey, CoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import type { RunLedger } from "../core/runLedger/ledger.js";
import type { OrganizationStore } from "../core/organization/contract.js";
import type { OrganizationService } from "../core/organization/service.js";
import type {
  OrganizationMetadataAuthentication,
  createOrganizationAuthentication,
} from "./organizationAuthentication.js";

export interface OriginalUnitRecipient {
  actor: Actor;
  identity: ExternalIdentity;
  sourceRunId: string;
  requesterId: string;
  channelId: string;
  threadKey: string;
  unitKey: UnitEventKey;
}
export interface OriginalUnitRecipientOptions {
  organizationId: string;
  ledger: Pick<RunLedger, "readIngressByRun">;
  store: OrganizationStore;
  organization: Pick<OrganizationService, "resolve">;
  coordinator: Pick<CoordinatorInstanceStore, "get" | "listUnits" | "getMainTask">;
  authentication: Pick<ReturnType<typeof createOrganizationAuthentication>, "resolveEnvelope"> &
    Partial<Pick<ReturnType<typeof createOrganizationAuthentication>, "metadataPhase">>;
  now(): number;
}
/** Read-only proof for an existing unit's ownership metadata.
 * It returns no input, conversation history, IO or execution capability. */
export function createOriginalUnitRecipient(options: OriginalUnitRecipientOptions) {
  const metadata = (envelope: OrganizationEnvelope) => {
    const { content: _content, context: _context, contentExpiresAt: _expires, ...value } = envelope;
    return JSON.stringify(value);
  };
  async function readUnit(key: UnitEventKey) {
    const [instance, units] = await Promise.all([
      options.coordinator.get(key.instanceId),
      options.coordinator.listUnits(key.instanceId),
    ]);
    const matches = units.filter((row) => row.unit === key.unit);
    if (!instance || matches.length !== 1) return;
    const unit = matches[0]!,
      brief = unit.workBrief;
    if (
      !brief ||
      !unit.context ||
      !isUnitContext(unit.context) ||
      unit.threadKey !== privateWorkerThreadKey(key) ||
      !mainTaskClaimMatches({ mainThreadKey: brief.mainThreadKey, actId: brief.actId }, instance, unit)
    )
      return;
    const source = unit.context.handoff.source;
    if (
      source.requester !== instance.userId ||
      source.channelId !== instance.channelId ||
      source.threadKey !== brief.mainThreadKey ||
      (instance.runId && instance.runId !== source.runId)
    )
      return;
    const claim = await options.coordinator.getMainTask({ mainThreadKey: brief.mainThreadKey, actId: brief.actId });
    if (
      !claim?.authority ||
      claim.instanceId !== instance.id ||
      claim.unit !== unit.unit ||
      claim.authority.requesterId !== instance.userId ||
      claim.authority.repo.toLowerCase() !== instance.repo.toLowerCase()
    )
      return;
    return { instance, unit, source, claim: { ...claim, authority: claim.authority } };
  }
  async function read(key: UnitEventKey): Promise<OriginalUnitRecipient | undefined> {
    try {
      const saved = await readUnit(key),
        now = options.now();
      if (!saved || !Number.isSafeInteger(now) || now < 0) return;
      const lookup = await options.ledger.readIngressByRun(saved.source.runId);
      if (lookup.status !== "record") return;
      const decoded = ingressRecordSchema.safeParse(lookup.record);
      if (!decoded.success) return;
      const record = decoded.data,
        origin = record.origin,
        ref = origin?.sourceReference;
      if (
        !origin ||
        !ref ||
        !ref.privateSource ||
        !ref.capturedPrivateEpoch ||
        !record.receiptId ||
        record.runId !== saved.source.runId ||
        record.originExpiresAt === undefined ||
        record.originExpiresAt <= now ||
        origin.organization !== options.organizationId ||
        origin.destination.kind !== "broad" ||
        origin.actor.stream === null ||
        origin.digest !== record.digest ||
        record.requester !== ref.userId ||
        record.threadKey !== ref.threadKey ||
        ref.userId !== saved.instance.userId ||
        ref.channelId !== saved.instance.channelId ||
        ref.threadKey !== saved.instance.threadKey ||
        saved.instance.authenticatedAs !== ref.authenticatedAs ||
        saved.instance.postedBy !== ref.postedBy ||
        (ref.sourceRepository && ref.sourceRepository.toLowerCase() !== saved.instance.repo.toLowerCase())
      )
        return;
      const sourceOrigin = origin,
        sourceRef = ref,
        sourceInstance = saved.instance;
      async function resolveCurrent() {
        const current = await options.authentication.resolveEnvelope(sourceOrigin);
        if (
          current.status !== "resolved" ||
          !current.privateSource ||
          current.actor.viewingAs ||
          (current.actor.kind !== "user" && current.actor.onBehalfOf?.kind !== "user") ||
          identityKey(current.authentication.identity) !== identityKey(sourceOrigin.actor.identity) ||
          current.authentication.kind !== sourceOrigin.actor.kind ||
          current.actor.id !== sourceRef.actorId ||
          current.msg.userId !== sourceRef.userId ||
          current.msg.channelId !== sourceRef.channelId ||
          current.msg.threadKey !== sourceRef.threadKey ||
          current.msg.messageId !== sourceRef.messageId ||
          current.msg.authenticatedAs !== sourceRef.authenticatedAs ||
          current.msg.postedBy !== sourceRef.postedBy
        )
          return;
        if (
          !authorize(current.actor, "organization:read", { type: "organization", id: options.organizationId }).allow ||
          !matchesPredicate(predicateFor(current.actor, "runs:read", "run"), {
            userId: sourceInstance.userId,
            channelId: sourceInstance.channelId,
            repo: sourceInstance.repo,
            channelVisibility: "unknown",
          })
        )
          return;
        return current;
      }
      const current = await resolveCurrent();
      if (!current) return;
      const addressed = await options.organization.resolve(current.authentication);
      if (!addressed || addressed.organization !== options.organizationId) return;
      const submission = await options.store.execute({
        action: "submission",
        ...addressed,
        source: origin.source,
        key: origin.key,
      });
      if (
        submission.status !== "submission" ||
        submission.receipt.id !== record.receiptId ||
        submission.receipt.status !== "accepted" ||
        submission.receipt.ownerRunId !== record.runId ||
        submission.receipt.effectKey !== record.effectKey ||
        submission.receipt.digest !== record.digest ||
        submission.receipt.expiresAt <= options.now() ||
        metadata(envelopeSchema.parse(submission.envelope)) !== metadata(origin) ||
        !ref.messageId ||
        saved.claim.authority.sourceMessageId !==
          `browser:${submission.receipt.revision}:${encodeURIComponent(ref.messageId)}`
      )
        return;
      // Recheck the named unit after asynchronous native proof; no source,
      // ancestor or replacement claim can inherit this recipient result.
      const final = await readUnit(key);
      if (
        !final ||
        final.source.runId !== saved.source.runId ||
        JSON.stringify(final.claim) !== JSON.stringify(saved.claim) ||
        final.instance.userId !== saved.instance.userId ||
        final.instance.channelId !== saved.instance.channelId ||
        final.instance.threadKey !== saved.instance.threadKey ||
        final.instance.repo !== saved.instance.repo ||
        record.originExpiresAt <= options.now()
      )
        return;
      const fresh = await resolveCurrent();
      if (!fresh || record.originExpiresAt <= options.now()) return;
      return {
        actor: fresh.actor,
        identity: fresh.authentication.identity,
        sourceRunId: record.runId,
        requesterId: ref.userId,
        channelId: ref.channelId,
        threadKey: ref.threadKey,
        unitKey: { instanceId: final.instance.id, unit: final.unit.unit },
      };
    } catch {
      return;
    }
  }
  return {
    read,
    /** Disposable metadata phase. Canonical rows come from this page's read;
     * emission must use a new phase seeded from fresh canonical rows. */
    metadataPhase(groups: readonly HomePrivateReadGroup[], authentication?: OrganizationMetadataAuthentication) {
      function memo<A extends unknown[], R>(key: (...args: A) => string, run: (...args: A) => Promise<R>) {
        const reads = new Map<string, Promise<R>>();
        return (...args: A): Promise<R> => {
          const id = key(...args);
          let result = reads.get(id);
          if (!result) {
            result = run(...args);
            reads.set(id, result);
          }
          return result;
        };
      }
      const canonical = new Map(groups.map((group) => [group.instance.id, group]));
      const claims = new Map<
        string,
        {
          key: Parameters<OriginalUnitRecipientOptions["coordinator"]["getMainTask"]>[0];
          value: ReturnType<OriginalUnitRecipientOptions["coordinator"]["getMainTask"]>;
        }
      >();
      const phase = createOriginalUnitRecipient({
        ...options,
        coordinator: {
          get: async (id) => canonical.get(id)?.instance ?? null,
          listUnits: async (id) => [...(canonical.get(id)?.units ?? [])],
          getMainTask: (key) => {
            const id = JSON.stringify(key);
            let claim = claims.get(id);
            if (!claim) {
              claim = { key, value: options.coordinator.getMainTask(key) };
              claims.set(id, claim);
            }
            return claim.value;
          },
        },
        ledger: {
          readIngressByRun: memo(
            (id) => id,
            (id) => options.ledger.readIngressByRun(id),
          ),
        },
        organization: {
          resolve: memo(
            (auth) => JSON.stringify(auth),
            (auth) => options.organization.resolve(auth),
          ),
        },
        store: {
          execute: memo(
            (command) => JSON.stringify(command),
            (command) => options.store.execute(command),
          ),
        },
        authentication: authentication ?? options.authentication.metadataPhase?.() ?? options.authentication,
      });
      return {
        read: phase.read,
        async canEmit() {
          const current = await mapLimit(
            [...claims.values()],
            HOME_PRIVATE_READ_CONCURRENCY,
            async ({ key, value }) =>
              JSON.stringify(await value) === JSON.stringify(await options.coordinator.getMainTask(key)),
          );
          return current.every(Boolean);
        },
      };
    },
  };
}
