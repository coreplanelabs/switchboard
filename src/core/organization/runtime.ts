import type { Actor } from "../authz/types.js";
import { withChatActor } from "../authz/actor.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import type { RunLedger } from "../runLedger/ledger.js";
import type { IngressResult } from "../runLedger/ingress.js";
import { envelopeSchema } from "./contract.js";
import type { OrganizationEnvelope, OrganizationReceipt, OrganizationResult, OrganizationStore } from "./contract.js";
import type { OrganizationService, OrganizationAuthentication } from "./service.js";

export interface OrganizationExecutionRequest {
  envelope: OrganizationEnvelope;
  receipt: OrganizationReceipt;
  actor: Actor;
  msg: IncomingMessage;
  runId: string;
  io: ChannelIO;
}
export interface OrganizationOwnerOutcome {
  status: "completed" | "refused" | "uncertain";
  reason?: string;
}
export type OrganizationActorResolution =
  { status?: "resolved"; actor: Actor; msg: IncomingMessage } | { status: "fenced" | "unavailable" } | undefined;
function resolvedActor(
  value: OrganizationActorResolution,
): value is { status?: "resolved"; actor: Actor; msg: IncomingMessage } {
  return !!value && (value.status === undefined || value.status === "resolved") && "actor" in value;
}
export interface OrganizationRuntimeOptions {
  store: OrganizationStore;
  service: OrganizationService;
  ledger: Pick<
    RunLedger,
    | "pendingUnreadIngress"
    | "claimUnreadIngress"
    | "consumeIngress"
    | "readIngress"
    | "finishIngress"
    | "clearIngressContent"
    | "pendingIngressRefusals"
    | "ackIngressRefusal"
  >;
  owner: string;
  leaseMs: number;
  batchSize: number;
  contentTtlMs: number;
  /** Original request bytes expire from admission, separately from private history. */
  sourceSnapshotTtlMs?: number;
  /** Required when a separate source snapshot lifetime is configured. */
  now?(): number;
  /** Rebuild the full credential/person intersection from current trusted facts.
   * Never turn an organization principal or saved grants into a Core Actor. */
  resolveActor(envelope: OrganizationEnvelope): Promise<OrganizationActorResolution>;
  sink(request: Omit<OrganizationExecutionRequest, "io">): ChannelIO;
  dispatchOwned(request: OrganizationExecutionRequest): Promise<OrganizationOwnerOutcome>;
  answerOwned?(request: OrganizationExecutionRequest): Promise<OrganizationOwnerOutcome>;
  confirmOwned?(request: OrganizationExecutionRequest): Promise<OrganizationOwnerOutcome>;
  /** Supervise work using the host's existing run/shutdown lifecycle. */
  launch(task: () => Promise<void>): void;
  /** Read evidence for this exact original run. Missing evidence never permits replay. */
  readOriginalRun?(runId: string): Promise<{ status: "running" | "completed" | "unknown"; outcome?: string }>;
}
function sourceMatches(envelope: OrganizationEnvelope, resolved: { actor: Actor; msg: IncomingMessage }): boolean {
  const ref = envelope.sourceReference;
  const { actor, msg } = resolved;
  return (
    !!ref &&
    !actor.viewingAs &&
    actor.id === ref.actorId &&
    msg.userId === ref.userId &&
    msg.channelId === ref.channelId &&
    msg.threadKey === ref.threadKey &&
    msg.messageId === ref.messageId &&
    msg.authenticatedAs === ref.authenticatedAs &&
    msg.postedBy === ref.postedBy &&
    JSON.stringify(msg.approvalConnection ?? null) === JSON.stringify(ref.approvalConnection ?? null) &&
    (envelope.destination.kind !== "thread" || envelope.destination.thread === msg.threadKey)
  );
}
async function hash(content: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
/** The organization schedules admission; existing commands, confirmations and
 * unit owners still authorize and perform every effect. An uncertain original
 * owner is queried, never routed again under a new identity. */
export function createOrganizationRuntime(options: OrganizationRuntimeOptions) {
  if (options.sourceSnapshotTtlMs !== undefined && !options.now)
    throw new Error("Organization source snapshot retention requires a current clock.");
  const snapshotDeadline = (receipt: OrganizationReceipt): number =>
    options.sourceSnapshotTtlMs === undefined
      ? receipt.expiresAt
      : Math.min(Number.MAX_SAFE_INTEGER, receipt.createdAt + options.sourceSnapshotTtlMs);
  const snapshotEnvelope = (envelope: OrganizationEnvelope, receipt: OrganizationReceipt): OrganizationEnvelope => ({
    ...envelope,
    ...(envelope.contentExpiresAt === undefined
      ? {}
      : { contentExpiresAt: Math.min(envelope.contentExpiresAt, snapshotDeadline(receipt)) }),
  });
  const snapshotRetained = (receipt: OrganizationReceipt): boolean =>
    options.sourceSnapshotTtlMs === undefined ||
    (options.now !== undefined && options.now() < snapshotDeadline(receipt));
  const currentSnapshot = async (
    envelope: OrganizationEnvelope,
    receipt: OrganizationReceipt,
    runId: string,
  ): Promise<boolean> => {
    if (!receipt.effectKey || !snapshotRetained(receipt)) return false;
    const original = await options.ledger.readIngress(receipt.effectKey);
    if (
      original.status !== "record" ||
      original.record.runId !== runId ||
      original.record.digest !== envelope.digest ||
      !original.record.request
    )
      return false;
    const parsed = envelopeSchema.safeParse(original.record.request.envelope);
    return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(snapshotEnvelope(envelope, receipt));
  };
  const listeners = new Set<(organization: string) => void>();
  const invalidate = (organization: string) => {
    for (const listener of listeners) {
      try {
        listener(organization);
      } catch {
        /* A disconnected feed cannot stop original-owner admission. */
      }
    }
  };
  const readOwner = async (effectKey: string): Promise<IngressResult> => {
    let original = await options.ledger.readIngress(effectKey);
    if (original.status === "record" && original.record.refusalPending && original.record.origin) {
      await repairRefusals(original.record.origin.organization);
      original = await options.ledger.readIngress(effectKey);
    }
    if (
      original.status !== "record" ||
      original.record.status === "completed" ||
      original.record.unread?.status === "pending" ||
      !options.readOriginalRun
    )
      return original;
    let evidence;
    try {
      evidence = await options.readOriginalRun(original.record.runId);
    } catch {
      return original;
    }
    if (evidence.status !== "completed") return original;
    return options.ledger.finishIngress({
      effectKey,
      digest: original.record.digest,
      runId: original.record.runId,
      status: "completed",
      outcome: evidence.outcome ?? "Original run completed.",
    });
  };
  const clearOwners = async (organization: string): Promise<boolean> => {
    const pending = await options.store.execute({ action: "owner-clears", organization, limit: options.batchSize });
    if (pending.status !== "owner-clears") return false;
    for (const item of pending.items) {
      try {
        const cleared = await options.ledger.clearIngressContent(item.effectKey);
        if (cleared.status !== "record" && cleared.status !== "not_found") return false;
        const ack = await options.store.execute({ action: "owner-cleared", organization, ...item });
        if (ack.status !== "ok") return false;
      } catch {
        return false;
      }
    }
    return true;
  };
  const repairRefusals = async (organization: string): Promise<boolean> => {
    const pending = await options.ledger.pendingIngressRefusals(organization, options.batchSize);
    if (pending.status !== "refusals") return false;
    for (const owner of pending.records) {
      if (!owner.origin || !owner.receiptId || owner.status !== "completed" || !owner.refusalPending) return false;
      const result = await options.store.execute({
        action: "owner-refused",
        organization,
        receiptId: owner.receiptId,
        ownerRunId: owner.runId,
        reason: owner.outcome ?? "The original owner refused without an effect.",
        target: owner.origin.target,
      });
      if (
        result.status !== "ok" &&
        result.status !== "not_found" &&
        !(result.status === "receipt" && result.receipt.status === "rejected")
      )
        return false;
      const ack = await options.ledger.ackIngressRefusal({
        effectKey: owner.effectKey,
        digest: owner.digest,
        runId: owner.runId,
      });
      if (ack.status !== "record") return false;
      invalidate(organization);
    }
    return true;
  };
  const deleteContent = async (
    authentication: OrganizationAuthentication,
    receiptId: string,
  ): Promise<OrganizationResult> => {
    const deleted = await options.service.delete(authentication, receiptId);
    if (deleted.status !== "ok") return deleted;
    const resolved = await options.service.resolve(authentication);
    if (!resolved || !(await clearOwners(resolved.organization))) return { status: "unavailable" };
    invalidate(resolved.organization);
    return deleted;
  };
  const reply = async (
    request: Omit<OrganizationExecutionRequest, "io">,
    replyKey: string,
    content: string,
  ): Promise<OrganizationResult> => {
    try {
      const current = await options.resolveActor(request.envelope);
      if (current?.status === "unavailable") return { status: "unavailable" };
      if (
        !resolvedActor(current) ||
        !sourceMatches(request.envelope, current) ||
        !(await options.service.authorizeReply(request.envelope))
      )
        return { status: "fenced" };
      const result = await options.store.execute({
        action: "reply",
        organization: request.envelope.organization,
        receiptId: request.receipt.id,
        actor: request.envelope.actor,
        ownerRunId: request.runId,
        replyKey,
        digest: await hash(content),
        content,
        contentTtlMs: options.contentTtlMs,
      });
      if (result.status === "ok") invalidate(request.envelope.organization);
      return result;
    } catch {
      return { status: "unavailable" };
    }
  };
  const repairUnread = async (organization: string): Promise<boolean> => {
    const pending = await options.ledger.pendingUnreadIngress(organization, options.batchSize);
    if (pending.status !== "unread") return false;
    for (const original of pending.records) {
      // Only the original receiver's durable unread handoff permits continuation.
      // Generic uncertain dispatches, expired bytes and active physical owners do not.
      if (!original.request || !original.receiptId || original.unread?.status !== "pending") continue;
      const parsed = envelopeSchema.safeParse(original.request.envelope);
      if (
        !parsed.success ||
        parsed.data.organization !== organization ||
        parsed.data.digest !== original.digest ||
        parsed.data.target ||
        parsed.data.continuation ||
        parsed.data.destination.kind !== "broad"
      )
        continue;
      const envelope = parsed.data;
      try {
        const resolved = await options.resolveActor(envelope);
        if (
          !resolvedActor(resolved) ||
          !sourceMatches(envelope, resolved) ||
          !(await options.service.authorizeExecution(envelope))
        )
          continue;
        const submission = await options.store.execute({
          action: "submission",
          organization,
          source: envelope.source,
          actor: envelope.actor,
          key: envelope.key,
        });
        if (
          submission.status !== "submission" ||
          submission.receipt.status !== "accepted" ||
          submission.receipt.id !== original.receiptId ||
          submission.receipt.ownerRunId !== original.runId ||
          !snapshotRetained(submission.receipt)
        )
          continue;
        options.launch(async () => {
          let current;
          try {
            // Source proof is current at actual launch, before the one-time claim.
            current = await options.resolveActor(envelope);
            if (
              !resolvedActor(current) ||
              !sourceMatches(envelope, current) ||
              !(await options.service.authorizeExecution(envelope))
            )
              return;
            const fence = await options.store.execute({
              action: "execution",
              organization,
              receiptId: original.receiptId!,
              actor: envelope.actor,
              ownerRunId: original.runId,
            });
            if (fence.status !== "ok" || !(await currentSnapshot(envelope, submission.receipt, original.runId))) return;
          } catch {
            return;
          }
          const claimed = await options.ledger.claimUnreadIngress(original.runId);
          if (claimed.status !== "claimed") return;
          const request = {
            envelope,
            receipt: submission.receipt,
            actor: current.actor,
            msg: withChatActor({ ...current.msg, text: envelope.content }, current.actor),
            runId: original.runId,
          };
          let outcome: OrganizationOwnerOutcome;
          try {
            outcome = await options.dispatchOwned({ ...request, io: options.sink(request) });
          } catch {
            outcome = {
              status: "uncertain",
              reason: "The original unread input's continuation outcome could not be confirmed.",
            };
          }
          await options.ledger.finishIngress({
            effectKey: original.effectKey,
            digest: original.digest,
            runId: original.runId,
            status: outcome.status === "uncertain" ? "uncertain" : "completed",
            outcome: outcome.reason ?? outcome.status,
            ...(outcome.status === "refused" ? { refusalPending: true } : {}),
          });
          if (outcome.status === "refused") await repairRefusals(organization);
          invalidate(organization);
        });
      } catch {
        /* The durable unread item remains pending until launch succeeds. */
      }
    }
    return true;
  };
  const reconcile = async (organization: string): Promise<OrganizationResult> => {
    if (!(await clearOwners(organization))) return { status: "unavailable" };
    if (!(await repairRefusals(organization))) return { status: "unavailable" };
    if (!(await repairUnread(organization))) return { status: "unavailable" };
    const claimed = await options.store.execute({
      action: "claim",
      organization,
      owner: options.owner,
      leaseMs: options.leaseMs,
    });
    if (claimed.status !== "state" || !claimed.state.lease) return claimed;
    const lease = { organization, owner: options.owner, generation: claimed.state.lease.generation };
    const pending = await options.store.execute({ action: "pending", ...lease, limit: options.batchSize });
    if (pending.status !== "pending") return pending;
    let unavailableProof = false;
    for (let index = 0; index < pending.envelopes.length; index++) {
      const envelope = pending.envelopes[index]!;
      const receipt = pending.receipts[index]!;
      const settle = (status: "accepted" | "rejected", reason: string | null, ownerRunId?: string) =>
        options.store.execute({
          action: "settle",
          ...lease,
          receiptId: receipt.id,
          status,
          reason,
          reply: null,
          contentTtlMs: options.contentTtlMs,
          ...(ownerRunId ? { ownerRunId } : {}),
        });
      if (!snapshotRetained(receipt)) {
        await settle("rejected", "The original source snapshot expired.");
        invalidate(organization);
        continue;
      }
      let resolved;
      let owner;
      const execute = envelope.continuation
        ? options.confirmOwned
        : envelope.target
          ? options.answerOwned
          : options.dispatchOwned;
      try {
        resolved = await options.resolveActor(envelope);
        if (resolved?.status === "unavailable") {
          unavailableProof = true;
          continue;
        }
        if (
          !resolvedActor(resolved) ||
          !sourceMatches(envelope, resolved) ||
          !execute ||
          !(await options.service.authorizeEffect(envelope, lease))
        ) {
          await settle("rejected", "Current authority or original destination could not be verified.");
          invalidate(organization);
          continue;
        }
        if (!receipt.effectKey || envelope.contentExpiresAt === undefined) continue;
        owner = await options.ledger.consumeIngress({
          effectKey: receipt.effectKey,
          digest: envelope.digest,
          requester: resolved.msg.userId,
          threadKey: resolved.msg.threadKey,
          request: { envelope: snapshotEnvelope(envelope, receipt) },
          origin: { ...envelope, content: "", context: [] },
          originExpiresAt: receipt.expiresAt,
          receiptId: receipt.id,
          contentExpiresAt: Math.min(envelope.contentExpiresAt, snapshotDeadline(receipt)),
        });
        if (owner.status !== "claimed" && owner.status !== "duplicate") {
          await settle("rejected", "The original owner refused this admission.");
          invalidate(organization);
          continue;
        }
      } catch {
        unavailableProof = true;
        continue;
      }
      const accepted = await settle(
        "accepted",
        owner.status === "duplicate" && owner.record.status !== "completed"
          ? "The original owner retained this request; its outcome is not yet confirmed."
          : null,
        owner.record.runId,
      );
      invalidate(organization);
      if (accepted.status !== "receipt" || accepted.receipt.status !== "accepted") continue;
      if (owner.status === "duplicate") {
        await readOwner(receipt.effectKey);
        continue;
      }
      const runId = owner.record.runId;
      const finish = async (outcome: OrganizationOwnerOutcome) => {
        const finished = await options.ledger.finishIngress({
          effectKey: receipt.effectKey!,
          digest: envelope.digest,
          runId,
          status: outcome.status === "uncertain" ? "uncertain" : "completed",
          outcome: outcome.reason ?? outcome.status,
          ...(outcome.status === "refused" ? { refusalPending: true } : {}),
        });
        if (finished.status === "record" && outcome.status === "refused") await repairRefusals(organization);
        invalidate(organization);
      };
      try {
        options.launch(async () => {
          try {
            // Authority can change while the host waits to start this task.
            const current = await options.resolveActor(envelope);
            if (current?.status === "unavailable") {
              await finish({ status: "uncertain", reason: "The original actor's current proof is unavailable." });
              return;
            }
            if (!resolvedActor(current) || !sourceMatches(envelope, current)) {
              await finish({ status: "refused", reason: "Current actor could not be verified." });
              return;
            }
            if (!(await options.service.authorizeExecution(envelope))) {
              await finish({ status: "refused", reason: "Current organization authority could not be verified." });
              return;
            }
            const fence = await options.store.execute({
              action: "execution",
              organization,
              receiptId: receipt.id,
              actor: envelope.actor,
              ownerRunId: runId,
            });
            if (fence.status === "unavailable") {
              await finish({ status: "uncertain", reason: "The original execution fence is unavailable." });
              return;
            }
            if (fence.status !== "ok") {
              await finish({ status: "refused", reason: "Access, retention or the original target changed." });
              return;
            }
            if (!(await currentSnapshot(envelope, accepted.receipt, runId))) {
              await finish({ status: "refused", reason: "The original source snapshot is unavailable." });
              return;
            }
            const request = {
              envelope: snapshotEnvelope(envelope, accepted.receipt),
              receipt: accepted.receipt,
              actor: current.actor,
              msg: withChatActor({ ...current.msg, text: envelope.content }, current.actor),
              runId,
            };
            await finish(await execute({ ...request, io: options.sink(request) }));
          } catch {
            await finish({ status: "uncertain", reason: "The original owner's outcome could not be confirmed." });
          }
        });
      } catch {
        await finish({ status: "uncertain", reason: "The original owner could not be scheduled." });
      }
    }
    return unavailableProof
      ? options.store.execute({ action: "yield", ...lease })
      : options.store.execute({ action: "complete", ...lease, through: claimed.state.lease.through });
  };
  return {
    reconcile,
    reply,
    readOwner,
    deleteContent,
    invalidate,
    subscribe(listener: (organization: string) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
