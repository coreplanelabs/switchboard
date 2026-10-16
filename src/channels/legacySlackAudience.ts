import { authorize } from "../core/authz/authorize.js";
import type { Actor } from "../core/authz/types.js";
import type { ExternalIdentity } from "../core/identity/contract.js";
import { mainTaskClaimMatches, isCoordinatorInstance, isCoordinatorUnit } from "../core/coordinator/contract.js";
import type { CoordinatorInstanceStore, UnitEventKey } from "../core/coordinator/instanceStore.js";
import { isUnitContext } from "../core/dispatch/unitContext.js";
import { isRunRecord } from "../core/runRecord.js";
import { directAudienceStampOf } from "../core/runLedger/inboxMessage.js";
import type { RunLedger } from "../core/runLedger/ledger.js";
import type { RunStore } from "../core/runStore.js";
import type { AudienceCheck } from "../core/audienceDecision.js";
import type { ChannelIO, SlackDirectAudience } from "../core/types.js";
import type { OrganizationAuthenticationResult } from "./organizationAuthentication.js";

export interface LegacySlackAudienceOrigin {
  sourceRunId: string;
  unitKey: UnitEventKey;
  threadKey: string;
  userId: string;
}
export interface LegacySlackRecipient {
  io: ChannelIO;
  /** Native source authority only. A browser reader must pass its own policy separately. */
  actor: Actor;
  identity: ExternalIdentity;
  policyFingerprint: string;
  audience: SlackDirectAudience;
  verify(): Promise<AudienceCheck>;
}
export interface LegacySlackAudienceOptions {
  organization: string;
  ledger: Pick<RunLedger, "readIngressByRun">;
  runs: Pick<RunStore, "get">;
  instances: Pick<CoordinatorInstanceStore, "get" | "listUnits" | "getMainTask">;
  authenticate(audience: SlackDirectAudience): Promise<OrganizationAuthenticationResult>;
  addressIO(audience: SlackDirectAudience): ChannelIO | undefined | Promise<ChannelIO | undefined>;
}

/** Restores a recipient, never an old request, source snapshot or execution
 * permission. Modern ingress evidence, including unreadable evidence, wins. */
export function createLegacySlackAudience(options: LegacySlackAudienceOptions) {
  async function prove(origin: LegacySlackAudienceOrigin) {
    try {
      if ((await options.ledger.readIngressByRun(origin.sourceRunId)).status !== "not_found") return;
      const [record, instance, units] = await Promise.all([
        options.runs.get(origin.sourceRunId),
        options.instances.get(origin.unitKey.instanceId),
        options.instances.listUnits(origin.unitKey.instanceId),
      ]);
      if (
        !record ||
        !isRunRecord(record) ||
        record.id !== origin.sourceRunId ||
        record.organizationIngressRunId !== undefined ||
        record.authenticatedAs !== undefined ||
        record.postedBy !== undefined ||
        record.relayedBy !== undefined ||
        record.parentRunId !== undefined ||
        record.parentInstanceId !== undefined ||
        record.userId !== origin.userId ||
        record.threadKey !== origin.threadKey ||
        !instance ||
        !isCoordinatorInstance(instance) ||
        instance.id !== origin.unitKey.instanceId ||
        instance.userId !== record.userId ||
        instance.channelId !== record.channelId ||
        instance.threadKey !== record.threadKey ||
        (instance.runId !== undefined && instance.runId !== record.id) ||
        (instance.generatedTaskSource !== undefined && instance.generatedTaskSource.runId !== record.id) ||
        instance.authenticatedAs !== undefined ||
        instance.postedBy !== undefined
      )
        return;
      const audience = directAudienceStampOf(record);
      const matching = units.filter((unit) => unit.unit === origin.unitKey.unit);
      if (!audience || matching.length !== 1) return;
      const unit = matching[0]!;
      if (!isCoordinatorUnit(unit) || !unit.workBrief || !isUnitContext(unit.context)) return;
      const key = { mainThreadKey: unit.workBrief.mainThreadKey, actId: unit.workBrief.actId };
      if (!mainTaskClaimMatches(key, instance, unit)) return;
      const source = unit.context.handoff.source;
      if (
        source.runId !== record.id ||
        source.requester !== record.userId ||
        source.channelId !== record.channelId ||
        source.threadKey !== record.threadKey
      )
        return;
      const link = await options.instances.getMainTask(key);
      if (
        link?.instanceId !== instance.id ||
        link.unit !== unit.unit ||
        link.authority?.requesterId !== record.userId ||
        link.authority.repo.toLowerCase() !== instance.repo.toLowerCase()
      )
        return;
      const current = await options.authenticate(audience);
      const reference = current.status === "resolved" ? current.authentication.sourceReference : undefined;
      if (
        current.status !== "resolved" ||
        current.authentication.source !== "slack" ||
        current.authentication.kind !== "human" ||
        current.authentication.onBehalfOf !== undefined ||
        current.authentication.identity.issuer !== "https://slack.com" ||
        current.authentication.identity.subject !== record.userId.slice("slack:".length) ||
        !reference ||
        reference.actorId !== record.userId ||
        reference.userId !== record.userId ||
        reference.channelId !== record.channelId ||
        reference.threadKey !== record.threadKey ||
        !current.privateSource ||
        current.actor.kind !== "user" ||
        current.actor.id !== record.userId ||
        current.actor.onBehalfOf ||
        current.actor.viewingAs ||
        current.msg.userId !== record.userId ||
        current.msg.channelId !== record.channelId ||
        current.msg.threadKey !== record.threadKey ||
        !directAudienceStampOf(current.msg) ||
        !authorize(current.actor, "organization:read", { type: "organization", id: options.organization }).allow ||
        !authorize(current.actor, "runs:read", {
          type: "run",
          id: record.id,
          userId: record.userId,
          channelId: record.channelId,
          channelVisibility: record.channelVisibility,
          ...(record.repo ? { repo: record.repo } : {}),
        }).allow
      )
        return;
      for (const repo of new Set([instance.repo, ...(record.repo ? [record.repo] : [])])) {
        const [owner, name, ...extra] = repo.split("/");
        if (
          !owner ||
          !name ||
          extra.length ||
          !authorize(current.actor, "repo:use", { type: "repo", owner, name }).allow
        )
          return;
      }
      const native = await options.addressIO(audience);
      const actual = native?.directAudience?.();
      if (
        !native ||
        actual?.userId !== audience.userId ||
        actual.channelId !== audience.channelId ||
        actual.threadKey !== audience.threadKey ||
        !(await native.verifyDirectAudience?.(audience))?.ok
      )
        return;
      return {
        actor: current.actor,
        identity: current.authentication.identity,
        policyFingerprint: current.policyFingerprint,
        audience,
        native,
      };
    } catch {
      return;
    }
  }
  async function recipient(input: LegacySlackAudienceOrigin): Promise<LegacySlackRecipient | undefined> {
    const origin = structuredClone(input);
    const first = await prove(origin);
    if (!first) return;
    const verify = async (): Promise<AudienceCheck> =>
      (await prove(origin)) ? { ok: true } : { ok: false, code: "direct-audience-unavailable" };
    const io: ChannelIO = {
      directAudience: () => ({ ...first.audience }),
      verifyDirectAudience: async (audience) =>
        audience.kind === first.audience.kind &&
        audience.userId === first.audience.userId &&
        audience.channelId === first.audience.channelId &&
        audience.threadKey === first.audience.threadKey
          ? verify()
          : { ok: false, code: "direct-address-mismatch" },
      reply: async (text) => {
        const current = await prove(origin);
        if (!current) throw new Error("The original private recipient is unavailable.");
        await current.native.reply(text);
      },
      history: async () => {
        throw new Error("Original source history is not restored by a recipient capability.");
      },
      status: async () => ({ update() {}, done: async () => {} }),
    };
    return {
      io,
      actor: first.actor,
      identity: { ...first.identity },
      policyFingerprint: first.policyFingerprint,
      audience: first.audience,
      verify,
    };
  }
  return {
    recipient,
    restore: async (origin: LegacySlackAudienceOrigin): Promise<ChannelIO | undefined> => (await recipient(origin))?.io,
  };
}
