import { createHash } from "node:crypto";
import { authorize } from "../core/authz/authorize.js";
import type { IncomingMessage, ChannelIO } from "../core/types.js";
import type {
  OrganizationAuthorization,
  OrganizationService,
  OrganizationAdmissionInput,
  OrganizationAuthentication,
} from "../core/organization/service.js";
import type { OrganizationStore } from "../core/organization/contract.js";
import { envelopeSchema } from "../core/organization/contract.js";
import type { createOrganizationRuntime, OrganizationExecutionRequest } from "../core/organization/runtime.js";
import type { TextTurn } from "../core/dispatch/textTurns.js";
import type { PersonDirectory } from "../core/identity/contract.js";
import type { Confirmation, ConfirmationStore } from "../core/confirmations.js";
import { renderOffer, confirmationActionLabel } from "../core/confirmations.js";
import { createHomeRuntimeHandler, type HomeRuntimeContext, type HomeThreadProjection } from "./homeRuntime.js";
import type { createOrganizationAuthentication } from "./organizationAuthentication.js";
import type { HomeCommandSeed } from "./webSeed.js";
import type { HomeDestination } from "./homeSeed.js";
import { createHomeAccessEpoch } from "./homeAccessEpoch.js";
import { samePrivateDestination, type OrganizationPrivateAudience } from "../core/dispatch/privateDestination.js";
import {
  originalOrganizationDispatchOf,
  withOriginalOrganizationDispatch,
} from "../core/dispatch/originalOrganizationInput.js";
import { withChatActor } from "../core/authz/actor.js";
import type { RunLedger } from "../core/runLedger/ledger.js";
import type { HomeRepositories } from "./homeRepositories.js";

export interface HomeHostOptions {
  organizationId: string;
  organization: OrganizationService;
  store: OrganizationStore;
  directory: PersonDirectory;
  authentication: ReturnType<typeof createOrganizationAuthentication>;
  runtime: ReturnType<typeof createOrganizationRuntime>;
  ledger?: Pick<RunLedger, "readIngressByRun">;
  confirmations?: ConfirmationStore;
  now(): number;
  /** Current configuration and native membership facts; content changes do not enter this epoch. */
  policyEpoch(): string;
  readThread(context: HomeRuntimeContext, thread: string): Promise<HomeThreadProjection | undefined>;
  commands(context: HomeRuntimeContext): HomeCommandSeed[];
  repositories?(context: HomeRuntimeContext): Promise<HomeRepositories>;
  refreshProjection?(previous: HomeRuntimeContext, fresh: HomeRuntimeContext): Promise<HomeRuntimeContext | undefined>;
  canReadOffer?(context: HomeRuntimeContext, offer: Confirmation): Promise<boolean>;
  prepareAdmission?(
    context: HomeRuntimeContext,
    input: OrganizationAdmissionInput,
  ): Promise<OrganizationAuthentication | undefined>;
  sourceRepository?(context: HomeRuntimeContext, input: OrganizationAdmissionInput): Promise<string | undefined>;
  canReadContext(
    context: HomeRuntimeContext,
    reference: OrganizationAuthorization["context"][number],
  ): Promise<boolean>;
  sourceIo(request: Omit<OrganizationExecutionRequest, "io">): ChannelIO;
  publicBaseUrl?: string;
}
function messageOf(context: HomeRuntimeContext): IncomingMessage | undefined {
  const ref = context.authentication.sourceReference;
  if (!ref) return;
  return {
    channelId: ref.channelId,
    userId: ref.userId,
    threadKey: ref.threadKey,
    text: "",
    ...(ref.messageId ? { messageId: ref.messageId } : {}),
    ...(ref.authenticatedAs ? { authenticatedAs: ref.authenticatedAs } : {}),
    ...(ref.postedBy ? { postedBy: ref.postedBy } : {}),
    ...(ref.approvalConnection ? { approvalConnection: ref.approvalConnection } : {}),
  };
}

/** Host composition only: the common policy and original execution owners
 * remain authoritative. Browser arguments never supply these callbacks. */
export function createHomeHost(options: HomeHostOptions) {
  async function refresh(context: HomeRuntimeContext): Promise<HomeRuntimeContext | undefined> {
    const msg = messageOf(context);
    if (!msg) return;
    const current = await options.authentication.resolveBrowser(context.authentication.identity, msg);
    if (current.status !== "resolved") return;
    const fresh = { actor: current.actor, authentication: current.authentication };
    return options.refreshProjection ? options.refreshProjection(context, fresh) : fresh;
  }
  const currentEpoch = createHomeAccessEpoch(options);
  async function authorizeInput(input: OrganizationAuthorization): Promise<boolean> {
    if (input.organization !== options.organizationId) return false;
    const current = await options.authentication.resolveAuthorization(input);
    if (current.status === "unavailable") throw new Error("Current authentication is unavailable.");
    if (current.status !== "resolved") return false;
    if (
      !authorize(current.actor, input.action === "read" ? "organization:read" : "organization:send", {
        type: "organization",
        id: options.organizationId,
      }).allow
    )
      return false;
    const context = { actor: current.actor, authentication: current.authentication };
    if (input.destination.kind === "thread") {
      const projection = await options.readThread(context, input.destination.thread);
      if (!projection || (input.action !== "read" && !projection.canWrite)) return false;
      if (
        input.action !== "read" &&
        input.target &&
        (projection.target?.key !== input.target.key || projection.target.revision !== input.target.revision)
      )
        return false;
    } else if (input.target) return false;
    for (const reference of input.context) if (!(await options.canReadContext(context, reference))) return false;
    return true;
  }
  async function currentOffer(context: HomeRuntimeContext, destination: HomeDestination) {
    if (destination.kind === "thread") return (await options.readThread(context, destination.thread!))?.offer;
    const msg = messageOf(context);
    if (!msg || !options.confirmations || context.actor.viewingAs) return;
    const row = await options.confirmations.pendingByThread(msg.threadKey);
    if (!row || (row.message.authenticatedAs ?? row.message.userId) !== context.actor.id) return;
    if (!(options.canReadOffer ? await options.canReadOffer(context, row) : !row.originalOrganization)) return;
    return {
      id: row.id,
      line: row.kind === "redispatch" ? row.line : row.receipt,
      actionLabel: confirmationActionLabel(row),
      ...(row.kind === "run" ? { risk: row.risk } : { question: row.evidence }),
      expiresAt: row.expiresAt,
    };
  }
  async function privateHistory(request: Omit<OrganizationExecutionRequest, "io">): Promise<TextTurn[]> {
    const current = await options.authentication.resolveEnvelope(request.envelope);
    if (current.status !== "resolved") throw new Error("The private conversation is unavailable.");
    if (!current.privateSource || request.envelope.actor.stream === null) return [];
    const captured = request.envelope.sourceReference?.capturedPrivateEpoch;
    if (captured && captured !== (await currentEpoch({ actor: current.actor, authentication: current.authentication })))
      throw new Error("The private conversation is unavailable.");
    const history = await options.organization.streamTail(current.authentication, 100);
    if (history.status !== "stream_tail") throw new Error("The private conversation is unavailable.");
    const final = await options.authentication.resolveEnvelope(request.envelope);
    if (
      final.status !== "resolved" ||
      !final.privateSource ||
      (captured && captured !== (await currentEpoch({ actor: final.actor, authentication: final.authentication })))
    )
      throw new Error("The private conversation is unavailable.");
    return history.entries
      .filter((entry) => entry.receiptId !== request.receipt.id && entry.role !== "receipt")
      .map((entry) => ({
        role: entry.role as "user" | "assistant",
        text: entry.content,
        ...(entry.role === "user" && entry.authorId ? { user: entry.authorId } : {}),
      }));
  }
  async function originalInput(
    message: IncomingMessage,
  ): Promise<Omit<OrganizationExecutionRequest, "io"> | undefined> {
    const pointer = originalOrganizationDispatchOf(message);
    if (!pointer || !options.ledger) return;
    const original = await options.ledger.readIngressByRun(pointer.ingressRunId);
    if (
      original.status !== "record" ||
      original.record.runId !== pointer.ingressRunId ||
      original.record.status === "completed" ||
      !original.record.origin ||
      !original.record.receiptId
    )
      return;
    const retained = envelopeSchema.safeParse(original.record.request?.envelope);
    if (
      !retained.success ||
      retained.data.content !== message.text ||
      original.record.contentExpiresAt <= options.now()
    )
      return;
    const origin = original.record.origin;
    if (origin.organization !== options.organizationId || origin.destination.kind !== "broad") return;
    const ref = origin.sourceReference;
    if (
      !ref ||
      !ref.privateSource ||
      !ref.capturedPrivateEpoch ||
      ref.userId !== message.userId ||
      ref.channelId !== message.channelId ||
      ref.threadKey !== message.threadKey ||
      ref.messageId !== message.messageId ||
      ref.authenticatedAs !== message.authenticatedAs ||
      ref.postedBy !== message.postedBy ||
      JSON.stringify(ref.approvalConnection ?? null) !== JSON.stringify(message.approvalConnection ?? null) ||
      pointer.organizationRepo !== ref.sourceRepository
    )
      return;
    const saved = await options.store.execute({
      action: "submission",
      organization: origin.organization,
      source: origin.source,
      actor: origin.actor,
      key: origin.key,
    });
    if (
      saved.status !== "submission" ||
      saved.receipt.id !== original.record.receiptId ||
      saved.receipt.digest !== original.record.digest ||
      saved.receipt.ownerRunId !== pointer.ingressRunId ||
      saved.receipt.status !== "accepted" ||
      saved.receipt.revision !== pointer.organizationSequence
    )
      return;
    const envelope = {
      ...saved.envelope,
      content: retained.data.content,
      contentExpiresAt: original.record.contentExpiresAt,
    };
    if (
      envelope.contentExpiresAt === undefined ||
      envelope.contentExpiresAt <= options.now() ||
      !(await options.organization.authorizeExecution(envelope))
    )
      return;
    const current = await options.authentication.resolveEnvelope(envelope);
    if (current.status !== "resolved" || !current.privateSource) return;
    return {
      envelope,
      receipt: saved.receipt,
      runId: pointer.ingressRunId,
      actor: current.actor,
      msg: withOriginalOrganizationDispatch(withChatActor(current.msg, current.actor), pointer),
    };
  }
  function sink(request: Omit<OrganizationExecutionRequest, "io">): ChannelIO {
    const checked = async () => {
      const current = await options.authentication.resolveEnvelope(request.envelope);
      if (current.status !== "resolved" || !(await options.organization.authorizeReply(request.envelope)))
        throw new Error("The original conversation is unavailable.");
      const captured = request.envelope.sourceReference?.capturedPrivateEpoch;
      if (
        captured &&
        captured !== (await currentEpoch({ actor: current.actor, authentication: current.authentication }))
      )
        throw new Error("The original conversation is unavailable.");
    };
    const privateAudience: OrganizationPrivateAudience | undefined =
      (request.envelope.source === "browser" ||
        (request.envelope.source === "mcp" &&
          request.actor.kind === "service" &&
          !request.actor.viewingAs &&
          request.actor.onBehalfOf?.kind === "user" &&
          !request.actor.onBehalfOf.viewingAs &&
          !request.actor.onBehalfOf.onBehalfOf &&
          request.actor.onBehalfOf.id === request.msg.userId &&
          request.msg.authenticatedAs === request.actor.id &&
          !request.msg.postedBy &&
          !request.msg.relayedBy)) &&
      request.envelope.destination.kind === "broad" &&
      request.envelope.actor.stream &&
      request.envelope.sourceReference?.privateSource &&
      request.envelope.sourceReference.capturedPrivateEpoch
        ? {
            kind: "organization-private",
            organization: options.organizationId,
            stream: request.envelope.actor.stream,
            actorId: request.actor.id,
            userId: request.msg.userId,
            channelId: request.msg.channelId,
            threadKey: request.msg.threadKey,
          }
        : undefined;
    const wrap = (source: ChannelIO, parentReceipt = true): ChannelIO => {
      const reply = async (text: string) => {
        await checked();
        if (!parentReceipt) {
          await source.reply(text);
          return;
        }
        const key = `reply:${createHash("sha256").update(text).digest("hex")}`;
        const result = await options.runtime.reply(request, key, text);
        if (result.status !== "ok") throw new Error("The private reply could not be delivered.");
        if (request.envelope.source !== "browser") {
          await checked();
          await source.reply(text);
        }
      };
      return {
        reply,
        authoritativePrivateHistory: async (message) => {
          const owned = message ? await originalInput(message) : request;
          if (!owned) throw new Error("The original private input is unavailable.");
          return privateHistory(owned);
        },
        rehostOrganizationInput: async (message) => {
          const owned = await originalInput(message);
          if (!owned) return;
          await privateHistory(owned);
          return { msg: owned.msg, io: sink(owned) };
        },
        ...(privateAudience
          ? {
              organizationPrivateAudience: () => privateAudience,
              verifyOrganizationPrivateAudience: async (audience) => {
                if (!samePrivateDestination(audience, privateAudience))
                  return { ok: false, code: "direct-address-mismatch" };
                try {
                  await checked();
                  return { ok: true };
                } catch {
                  return { ok: false, code: "direct-audience-unavailable" };
                }
              },
            }
          : {}),
        reportDelivery: source.reportDelivery,
        undeliverable: request.envelope.source === "browser" ? undefined : source.undeliverable,
        status: async (initial, display) => {
          await checked();
          const handle = await source.status(initial, display);
          return {
            ...(handle.handle ? { handle: handle.handle } : {}),
            update: (frame) => {
              void checked()
                .then(() => handle.update(frame))
                .catch(() => {});
            },
            done: async (frame) => {
              await checked();
              await handle.done(frame);
            },
            ...(handle.doneWithReceipt
              ? {
                  doneWithReceipt: async (frame) => {
                    await checked();
                    return handle.doneWithReceipt!(frame);
                  },
                }
              : {}),
          };
        },
        history: async () => {
          await checked();
          return parentReceipt && request.envelope.destination.kind === "broad" ? [] : source.history();
        },
        ...(source.directAudience ? { directAudience: () => source.directAudience!() } : {}),
        ...(source.verifyDirectAudience
          ? { verifyDirectAudience: (audience) => source.verifyDirectAudience!(audience) }
          : {}),
        ...(source.verifyPrivateWorkerAudience
          ? { verifyPrivateWorkerAudience: (msg) => source.verifyPrivateWorkerAudience!(msg) }
          : {}),
        ...(source.attach
          ? {
              attach: async (file) => {
                await checked();
                await source.attach!(file);
              },
            }
          : {}),
        ...(source.attachFile
          ? {
              attachFile: async (file) => {
                await checked();
                await source.attachFile!(file);
              },
            }
          : {}),
        ...(source.uploadTicket
          ? {
              uploadTicket: async (file) => {
                await checked();
                const ticket = await source.uploadTicket!(file);
                return {
                  url: ticket.url,
                  complete: async (lead) => {
                    await checked();
                    await ticket.complete(lead);
                  },
                };
              },
            }
          : {}),
        ...(source.openThread
          ? {
              openThread: async (lead, key) => {
                await checked();
                const opened = await source.openThread!(lead, key);
                return { thread: opened.thread, io: wrap(opened.io, false) };
              },
            }
          : {}),
        ...(source.runStarted ? { runStarted: (started) => source.runStarted!(started) } : {}),
        ...(source.runFinished ? { runFinished: (receipt) => source.runFinished!(receipt) } : {}),
        ...(source.requestFailed ? { requestFailed: () => source.requestFailed!() } : {}),
        offer: async (offer) => {
          if (!parentReceipt && source.offer) {
            await checked();
            await source.offer(offer);
            return;
          }
          await reply(renderOffer(offer));
          if (parentReceipt && request.envelope.source !== "browser") {
            await checked();
            await source.offer?.(offer);
          }
        },
      };
    };
    return wrap(options.sourceIo(request));
  }
  const handler = createHomeRuntimeHandler({
    organization: options.organization,
    directory: options.directory,
    now: options.now,
    refresh,
    currentEpoch,
    readThread: options.readThread,
    repositories: options.repositories,
    submit: async (context, input) => {
      let authentication = options.prepareAdmission
        ? await options.prepareAdmission(context, input)
        : context.authentication;
      if (!authentication) return { status: "not_found" };
      if (input.destination.kind === "broad") {
        const repository = await options.sourceRepository?.(context, input);
        if (repository && authentication.sourceReference)
          authentication = {
            ...authentication,
            sourceReference: { ...authentication.sourceReference, sourceRepository: repository },
          };
        const addressed = await options.organization.resolve(authentication);
        if (!addressed) return { status: "not_found" };
        const current = await options.authentication.resolveAuthorization({
          ...addressed,
          source: authentication.source,
          sourceReference: authentication.sourceReference,
          destination: input.destination,
          target: input.target,
          context: input.context,
          action: "send",
        });
        if (current.status !== "resolved") return { status: "not_found" };
        if (current.privateSource && authentication.sourceReference) {
          const epoch = await currentEpoch({ actor: current.actor, authentication: current.authentication });
          if (!epoch) return { status: "unavailable" };
          authentication = {
            ...authentication,
            sourceReference: { ...authentication.sourceReference, privateSource: true, capturedPrivateEpoch: epoch },
          };
        }
      }
      if (input.target) {
        const observed = await options.store.execute({
          action: "observe",
          organization: options.organizationId,
          target: input.target.key,
          revision: input.target.revision,
        });
        if (observed.status !== "ok") return observed;
      }
      return options.organization.admit(authentication, input);
    },
    deleteContent: (context, receiptId) => options.runtime.deleteContent(context.authentication, receiptId),
    commands: options.commands,
    currentOffer,
    onAdmitted: (organization) => {
      void options.runtime.reconcile(organization).catch(() => {});
    },
    subscribe: options.runtime.subscribe,
    publicBaseUrl: options.publicBaseUrl,
  });
  return { handler, refresh, currentEpoch, authorize: authorizeInput, privateHistory, sink };
}
