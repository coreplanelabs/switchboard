import {
  withOrganizationPrivateAudience,
  isOrganizationPrivateAudience,
  verifyPrivateDestination,
} from "./privateDestination.js";
import {
  withOriginalOrganizationDispatch,
  withoutOriginalOrganizationDispatch,
  originalOrganizationDispatchOf,
} from "./originalOrganizationInput.js";
import { withConsumedCommand } from "../commandConfirmations.js";
// The click on a confirmation (docs/decisions/0044-a-routed-write-is-confirmed-in-proportion-to-its-blast-radius.md;
// docs/reference/specs/routing-and-config.md item 25): the pure pieces
// `dispatchClick` (dispatcher.ts) runs. A click is a credential presented
// later, possibly by someone else, possibly after a deploy, for a command a
// model chose — so the row is consumed in the config object, one transaction
// that judges the expiry on the object's clock and the requester against the
// clicker's ids, and only a consumed row runs. What runs is the stored,
// parsed input, through the typed line's own path (`runChatCommand` with the
// stored message): authorization, the inline run record and the audit line are
// the typed grammar's, with `source: confirm` on the audit line and `outcome:
// confirmed` on the record's `route` event. Every refusal is a named statement;
// a later request may mint a new offer, but this click never delegates recovery.
import type { Actor } from "../authz/types.js";
import { nativeMediaDigest } from "../nativeMedia.js";
import { withChatActor } from "../authz/actor.js";
import { markPrivateConversation } from "./privateConversation.js";
import type { ChatCommandResult } from "../commandChat.js";
import {
  parseConfirmation,
  type Confirmation,
  type ConfirmationRefusal,
  type ConfirmationStore,
  type RedispatchConfirmation,
  type ConfirmationSource,
  type ConfirmationSourceGuard,
} from "../confirmations.js";
import type { ContextDependencies } from "../references/contextDependencies.js";
import type { AudienceCheck } from "../audienceDecision.js";
import type { DispatchOutcome } from "./outcome.js";
import { COMMAND_RUN_AGENT } from "../runOwner.js";
import type { RunEnding } from "../runEnding.js";
import type { RequestTrace } from "../requestTrace.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import { runChatCommand } from "./commandRun.js";
import type { FastPathDeps } from "./fastPath.js";
import { redactedInput, ROUTED_RECEIPT_PREFIX } from "./route.js";
import { parseDirectives } from "../../directives.js";
import { shows } from "../verbosity.js";

export const OFFER_EXPIRED_LINE =
  "This approval expired after ten minutes. Nothing ran. A new request can receive a new approval button.";
/** A question's Yes lives `QUESTION_TTL_MS` (a day), not the write's ten
 *  minutes, so its expired click names the window it missed. */
export const QUESTION_EXPIRED_LINE =
  "This question expired after one day. Nothing ran. A new request can receive a new question.";
export const OFFER_FOREIGN_LINE =
  "Only the person who requested this action can approve it. Nothing ran from your click.";
export const OFFER_USED_LINE = "This approval was already used. This click did not run the action again.";
export const OFFER_UNREADABLE_LINE =
  "I couldn't read the saved approval, so nothing ran. A Switchboard operator can check the approval service.";
export const OFFER_CANCELLED_LINE = "Cancelled; nothing ran";
export const OFFER_CONTEXT_LINE =
  "I couldn't verify the information saved with this approval, so nothing ran. A Switchboard operator can check the saved request.";

/** The reason a confirmed run's `route` event gives on the record. */
export const CONFIRMED_REASON = "confirmed after offer";

/** The reason a refused click's record gives (record 0054; [run-history.md](../../../docs/reference/specs/run-history.md)
 *  item 2): the door's no about the command the row had bound. */
export const REFUSED_REASON = "refused after offer";

/** The one line for each refusal the store names. An expired click names the
 *  window it missed — the write's ten minutes, or the question's day when the
 *  store's refusal still carries a `redispatch` row. */
export function refusalLine(refused: ConfirmationRefusal, row?: Pick<Confirmation, "kind">): string {
  switch (refused) {
    case "expired":
      return row?.kind === "redispatch" ? QUESTION_EXPIRED_LINE : OFFER_EXPIRED_LINE;
    case "foreign":
      return OFFER_FOREIGN_LINE;
    case "used":
      return OFFER_USED_LINE;
  }
}

/** The ids the store checks the requester against: the clicker's own id and
 *  every id its `self` holds (record 0042: a credential the identity record
 *  binds to a person carries that person's id there), once each. A plain chat
 *  actor has no `self`, so its own id is the whole list. */
export function actorIdsOf(actor: Pick<Actor, "id" | "self">): string[] {
  return [...new Set([actor.id, ...(actor.self ?? [])])];
}

/** A click's refusal as the request's `dispatch.refuse` outcome names it. */
export type ClickRefusal =
  "confirmation_used" | "confirmation_expired" | "confirmation_foreign" | "confirmation_unreadable";

export type ClickResult =
  /** `row` when the store's refusal still named one (`expired`, `foreign`), so
   *  the refusal can be recorded against the command that was bound. */
  | { kind: "refused"; refusal: ClickRefusal; text: string; row?: Confirmation }
  /** The row ran: the command's result, and the reply — the receipt line first, the command's own text under it. */
  | { kind: "ran"; result: ChatCommandResult; text: string; publicationCheck?: () => Promise<AudienceCheck> }
  /** A question's Yes (record 0054): the consumed `redispatch` row went back
   *  through `dispatch()` as the requester — the caller's `redispatch` ran it
   *  and this is how it ended. The reply is the redispatched request's own. */
  | { kind: "redispatched"; row: RedispatchConfirmation; outcome: DispatchOutcome };

export type CancelResult =
  { kind: "cancelled"; text: string } | { kind: "refused"; refusal: ClickRefusal; text: string };

/** What a click carries into the core: the offer's id and the clicker's ids (`actorIdsOf`). */
export interface Click {
  id: string;
  actorIds: readonly string[];
  connectionId?: string;
  /** Trusted current chooser, never an id list or request-body Actor. */
  actor?: Actor;
  /** Original owner of this new choice, distinct from its saved offer source. */
  ingressRunId?: string;
}

function refused(
  r: ConfirmationRefusal,
  row?: Confirmation,
): { kind: "refused"; refusal: ClickRefusal; text: string; row?: Confirmation } {
  return { kind: "refused", refusal: `confirmation_${r}`, text: refusalLine(r, row), ...(row ? { row } : {}) };
}

const UNREADABLE = { kind: "refused", refusal: "confirmation_unreadable", text: OFFER_UNREADABLE_LINE } as const;

/**
 * Consume the row for the clicker and run it. The store decides — once, in
 * its own transaction — whether this click is the requester's, in time and
 * first; the core then hands the stored message and input to `runChatCommand`,
 * so the command is authorized as the requester again (a requester who lost
 * the grant since the offer gets the typed path's refusal, recorded as the
 * confirmed run's failure), recorded because its route carries an outcome,
 * and announced to the channel only when the command was a run anyway.
 */
/** Atomic saved-id claim shared by chat and machine command continuations. */
/** Protected rows require current channel-owned original-source proof before
 * their existing one-time store claim. Legacy rows retain the typed path. */
export async function currentConfirmationSource(
  row: Confirmation,
  chooser: Actor | undefined,
  guard: ConfirmationSourceGuard | undefined,
  purpose?: "confirm" | "cancel" | "read",
): Promise<ConfirmationSource | undefined | false> {
  if (!row.originalOrganization) return undefined;
  if (!chooser || chooser.viewingAs || !guard) return false;
  try {
    const current = await guard(row, chooser, purpose);
    if (!current || current.actor.viewingAs || current.actor.id !== chooser.id) return false;
    return current;
  } catch {
    return false;
  }
}
export async function claimConfirmation(
  store: ConfirmationStore | undefined,
  click: Click,
  guard?: ConfirmationSourceGuard,
): Promise<
  Extract<ClickResult, { kind: "refused" }> | { kind: "claimed"; row: Confirmation; source?: ConfirmationSource }
> {
  if (!store?.get) return UNREADABLE;
  try {
    const pending = await store.get(click.id);
    if (!pending) return refused("used");
    const row = parseConfirmation(pending);
    if (!row) return UNREADABLE;
    if (
      row.originalOrganization &&
      row.kind === "redispatch" &&
      (!click.ingressRunId || click.ingressRunId === row.originalOrganization.ingressRunId)
    )
      return { ...UNREADABLE, text: OFFER_CONTEXT_LINE };
    const source = await currentConfirmationSource(row, click.actor, guard);
    if (source === false) return { ...UNREADABLE, text: OFFER_CONTEXT_LINE };
    // Guarded credit applies only to this saved id, never Actor.self or grants.
    const consumed = await store.consume(
      click.id,
      source ? [...new Set([...actorIdsOf(source.actor), row.message.userId])] : click.actorIds,
      click.connectionId,
    );
    if (!consumed.ok)
      return refused(
        consumed.refused,
        consumed.row && ("derivation" in consumed.row || consumed.row.originalOrganization) ? undefined : consumed.row,
      );
    const claimed = parseConfirmation(structuredClone(consumed.row));
    if (!claimed) return UNREADABLE;
    // The saved id cannot acquire a different source between read and claim.
    if (JSON.stringify(claimed.originalOrganization ?? null) !== JSON.stringify(row.originalOrganization ?? null))
      return { ...UNREADABLE, text: OFFER_CONTEXT_LINE };
    return { kind: "claimed", row: claimed, ...(source ? { source } : {}) };
  } catch (err) {
    console.warn(
      `[confirm] ${click.id}: the store could not be read — ${err instanceof Error ? err.message : String(err)}`,
    );
    return UNREADABLE;
  }
}

export async function consumeAndRun(
  deps: FastPathDeps,
  click: Click,
  io: ChannelIO,
  ending: RunEnding,
  trace: RequestTrace,
  redispatch: (row: RedispatchConfirmation, io?: ChannelIO) => Promise<DispatchOutcome>,
  validateContext?: (context: ContextDependencies, message: IncomingMessage) => Promise<AudienceCheck>,
  trusted?: { actor: Actor; ingressRunId?: string; authoritativeHistory?: boolean; message?: IncomingMessage },
): Promise<ClickResult> {
  const claimed = await claimConfirmation(
    deps.confirmations,
    { ...click, actor: click.actor ?? trusted?.actor, ingressRunId: click.ingressRunId ?? trusted?.ingressRunId },
    deps.guardOrganizationConfirmation,
  );
  if (claimed.kind === "refused") return claimed;
  const row = claimed.row;
  const intendedText = row.message.text;
  const chooser = click.actor ?? trusted?.actor;
  // Preserve the original saved source before stamping the distinct choice's
  // native address. Publication rechecks A; execution and outputs belong to B.
  const sourceRow = parseConfirmation(structuredClone(row))!;
  const sourceCurrent = async () => currentConfirmationSource(sourceRow, chooser, deps.guardOrganizationConfirmation);
  const current = await sourceCurrent();
  if (current === false) return { ...UNREADABLE, text: OFFER_CONTEXT_LINE };
  if (current) {
    if (current.message) row.message = { ...current.message, text: intendedText };
    if (!trusted?.ingressRunId) io = current.io;
    row.message = withChatActor(
      trusted?.message
        ? {
            ...trusted.message,
            text: row.message.text,
            ...(row.message.images ? { images: row.message.images } : {}),
            ...(row.message.documents ? { documents: row.message.documents } : {}),
            ...(row.message.staged ? { staged: row.message.staged } : {}),
          }
        : row.message,
      trusted?.ingressRunId ? trusted.actor : current.actor,
    );
    const audience = current.io.organizationPrivateAudience?.();
    if (audience !== undefined) {
      if (
        !isOrganizationPrivateAudience(audience) ||
        audience.actorId !== current.actor.id ||
        audience.userId !== row.message.userId ||
        audience.channelId !== row.message.channelId ||
        audience.threadKey !== row.message.threadKey ||
        !(await verifyPrivateDestination(current.io, audience)).ok
      )
        return { ...UNREADABLE, text: OFFER_CONTEXT_LINE };
      row.message = withOrganizationPrivateAudience(
        row.message,
        audience,
        (trusted?.message && originalOrganizationDispatchOf(trusted.message)?.organizationSequence) ??
          row.originalOrganization!.organizationSequence,
      );
      row.message = markPrivateConversation(row.message);
    } else if (trusted?.authoritativeHistory) row.message = markPrivateConversation(row.message);
    // A fresh proposal dispatch receives the distinct choice pointer in opts.
    // Typed actions retain the original source pointer solely for guarded minting.
    row.message =
      row.kind === "redispatch"
        ? withoutOriginalOrganizationDispatch(row.message)
        : trusted?.ingressRunId && trusted.message
          ? row.message
          : withOriginalOrganizationDispatch(row.message, row.originalOrganization!);
  }
  if (row.kind === "redispatch" && row.originalOrganization?.nativeMediaDigest) {
    const execution = trusted?.message && originalOrganizationDispatchOf(trusted.message);
    if (
      !execution ||
      execution.ingressRunId === row.originalOrganization.ingressRunId ||
      execution.nativeMediaDigest ||
      !io.readSavedNativeMedia
    )
      return { ...UNREADABLE, text: OFFER_CONTEXT_LINE };
    const reference = {
      version: 1 as const,
      kind: "confirmed" as const,
      sourceRunId: row.originalOrganization.ingressRunId,
      sourceSequence: row.originalOrganization.organizationSequence,
      sourceDigest: row.originalOrganization.nativeMediaDigest,
      confirmationId: row.id,
      intentDigest: await nativeMediaDigest(intendedText),
    };
    delete row.message.nativeMedia;
    delete row.message.nativeMediaDigest;
    row.message = withOriginalOrganizationDispatch(row.message, { ...execution, savedNativeMediaSource: reference });
    const destination = io;
    const sourceRead = async () => !!(await destination.readSavedNativeMedia!(reference, row.message));
    const guarded = Object.create(destination) as ChannelIO;
    guarded.reply = async (text) => {
      if (!(await sourceRead())) throw new Error(OFFER_CONTEXT_LINE);
      await destination.reply(text);
    };
    guarded.verifyOrganizationPrivateAudience = async (audience) => {
      if (!(await sourceRead())) return { ok: false, code: "saved-context-unproved" };
      return destination.verifyOrganizationPrivateAudience
        ? destination.verifyOrganizationPrivateAudience(audience)
        : { ok: false, code: "saved-context-unproved" };
    };
    io = guarded;
  }
  if (trusted && !current) {
    row.message = withChatActor(row.message, trusted.actor);
    if (trusted.authoritativeHistory) row.message = markPrivateConversation(row.message);
  }
  const verbosity = deps.config.verbosityFor(
    row.message.channelId,
    row.message.userId,
    parseDirectives(row.message.text).verbosity,
  );
  // A question's Yes (record 0054): the row holds no bound command — it holds
  // the proposal, the person's message with the fix applied — so the click
  // hands it back to `dispatch()` whole, as the requester, through the
  // caller's `redispatch`. The store already judged the requester and the
  // expiry, exactly as it judges record 0044's Run.
  if (row.kind === "redispatch") {
    if ((await sourceCurrent()) === false) return { ...UNREADABLE, text: OFFER_CONTEXT_LINE };
    return { kind: "redispatched", row, outcome: await redispatch(row, io) };
  }
  const derivation = row.derivation;
  const contextUnavailable = { ...UNREADABLE, text: OFFER_CONTEXT_LINE };
  let denied = false;
  const publicationCheck = async (): Promise<AudienceCheck> => {
    if ((await sourceCurrent()) === false) {
      denied = true;
      return { ok: false, code: "saved-context-unproved" };
    }
    if (!derivation) return { ok: true };
    if (!denied && derivation.context.status === "known" && validateContext) {
      try {
        const message = structuredClone(row.message);
        if (
          (
            await validateContext(
              structuredClone(derivation.context),
              trusted ? withChatActor(message, trusted.actor) : message,
            )
          ).ok
        )
          return { ok: true };
      } catch {
        /* Unavailable source proof cannot authorize the saved command. */
      }
    }
    denied = true;
    return { ok: false, code: "saved-context-unproved" };
  };
  const withheld = new Error(OFFER_CONTEXT_LINE);
  const beforePublish = async () => {
    if (!(await publicationCheck()).ok) throw withheld;
  };
  if (!(await publicationCheck()).ok) return contextUnavailable;
  let result: ChatCommandResult;
  try {
    result = await withConsumedCommand(row, () =>
      runChatCommand(deps, row.message, io, { kind: "invoke", id: row.command, input: row.input }, ending, trace, {
        source: "confirm",
        confirmationId: row.id,
        ...(trusted?.ingressRunId ? { ingressRunId: trusted.ingressRunId } : {}),
        ...(derivation || row.originalOrganization ? { beforePublish } : {}),
        ...(derivation ? { contextDependencies: derivation.context } : {}),
        route: {
          preset: COMMAND_RUN_AGENT,
          reason: CONFIRMED_REASON,
          model: row.model,
          command: row.command,
          input: redactedInput(row.input),
          receipt: row.receipt,
          outcome: "confirmed",
        },
      }),
    );
  } catch (error) {
    if (denied || error === withheld) return contextUnavailable;
    throw error;
  }
  if (!(await publicationCheck()).ok) return contextUnavailable;
  if ((derivation || row.originalOrganization) && result.followUp) {
    const followUp = result.followUp;
    result = {
      ...result,
      followUp: async () => {
        if (!(await publicationCheck()).ok) return undefined;
        try {
          const outcome = await followUp();
          return (await publicationCheck()).ok ? outcome : undefined;
        } catch (error) {
          if (denied || error === withheld) return undefined;
          throw error;
        }
      },
    };
  }
  return {
    kind: "ran",
    result,
    text: shows(verbosity, "verbose")
      ? `${ROUTED_RECEIPT_PREFIX} ${row.receipt}\n${result.text}`
      : (result.quietText ?? result.text),
    ...(derivation || row.originalOrganization ? { publicationCheck } : {}),
  };
}

/** The other button: delete the row under the same requester check; nothing runs. */
export async function cancelPending(deps: FastPathDeps, click: Click): Promise<CancelResult> {
  const store = deps.confirmations;
  if (!store?.get) return UNREADABLE;
  let cancelled;
  try {
    const row = await store.get(click.id);
    if (!row) return refused("used");
    const source = await currentConfirmationSource(row, click.actor, deps.guardOrganizationConfirmation, "cancel");
    if (source === false) return { ...UNREADABLE, text: OFFER_CONTEXT_LINE };
    // The current source guard proved this exact saved request's credited
    // person. Credit is local to this id and changes no Actor aliases/grants.
    const ids = source ? [...new Set([...actorIdsOf(source.actor), row.message.userId])] : click.actorIds;
    cancelled = await store.cancel(click.id, ids, click.connectionId);
  } catch (err) {
    console.warn(
      `[confirm] ${click.id}: the store could not be read — ${err instanceof Error ? err.message : String(err)}`,
    );
    return UNREADABLE;
  }
  if (!cancelled.ok) return refused(cancelled.refused);
  return { kind: "cancelled", text: OFFER_CANCELLED_LINE };
}
