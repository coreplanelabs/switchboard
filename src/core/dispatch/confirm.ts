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
import type { ChatCommandResult } from "../commandChat.js";
import type { Confirmation, ConfirmationRefusal, RedispatchConfirmation } from "../confirmations.js";
import type { DispatchOutcome } from "./outcome.js";
import { COMMAND_RUN_AGENT } from "../runOwner.js";
import type { RunEnding } from "../runEnding.js";
import type { RequestTrace } from "../requestTrace.js";
import type { ChannelIO } from "../types.js";
import { runChatCommand } from "./commandRun.js";
import type { FastPathDeps } from "./fastPath.js";
import { redactedInput, ROUTED_RECEIPT_PREFIX } from "./route.js";

export const OFFER_EXPIRED_LINE =
  "this offer expired after ten minutes; nothing ran, and a later request may receive a fresh confirmation";
/** A question's Yes lives `QUESTION_TTL_MS` (a day), not the write's ten
 *  minutes, so its expired click names the window it missed. */
export const QUESTION_EXPIRED_LINE =
  "this question expired after one day; nothing ran, and a later request may receive a fresh question";
export const OFFER_FOREIGN_LINE = "only the requester can confirm this";
export const OFFER_USED_LINE = "this offer was already used";
export const OFFER_UNREADABLE_LINE =
  "this is a bug: the confirmation could not be read, so nothing ran and no replacement offer was minted";
export const OFFER_CANCELLED_LINE = "Cancelled; nothing ran";

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
  | { kind: "ran"; result: ChatCommandResult; text: string }
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
export async function consumeAndRun(
  deps: FastPathDeps,
  click: Click,
  io: ChannelIO,
  ending: RunEnding,
  trace: RequestTrace,
  redispatch: (row: RedispatchConfirmation) => Promise<DispatchOutcome>,
): Promise<ClickResult> {
  const store = deps.confirmations;
  if (!store) return UNREADABLE;
  let consumed;
  try {
    consumed = await store.consume(click.id, click.actorIds);
  } catch (err) {
    console.warn(
      `[confirm] ${click.id}: the store could not be read — ${err instanceof Error ? err.message : String(err)}`,
    );
    return UNREADABLE;
  }
  if (!consumed.ok) return refused(consumed.refused, consumed.row);
  const row = consumed.row;
  // A question's Yes (record 0054): the row holds no bound command — it holds
  // the proposal, the person's message with the fix applied — so the click
  // hands it back to `dispatch()` whole, as the requester, through the
  // caller's `redispatch`. The store already judged the requester and the
  // expiry, exactly as it judges record 0044's Run.
  if (row.kind === "redispatch") return { kind: "redispatched", row, outcome: await redispatch(row) };
  const result = await runChatCommand(
    deps,
    row.message,
    io,
    { kind: "invoke", id: row.command, input: row.input },
    ending,
    trace,
    {
      source: "confirm",
      route: {
        preset: COMMAND_RUN_AGENT,
        reason: CONFIRMED_REASON,
        model: row.model,
        command: row.command,
        input: redactedInput(row.input),
        receipt: row.receipt,
        outcome: "confirmed",
      },
    },
  );
  return { kind: "ran", result, text: `${ROUTED_RECEIPT_PREFIX} ${row.receipt}\n${result.text}` };
}

/** The other button: delete the row under the same requester check; nothing runs. */
export async function cancelPending(deps: FastPathDeps, click: Click): Promise<CancelResult> {
  const store = deps.confirmations;
  if (!store) return UNREADABLE;
  let cancelled;
  try {
    cancelled = await store.cancel(click.id, click.actorIds);
  } catch (err) {
    console.warn(
      `[confirm] ${click.id}: the store could not be read — ${err instanceof Error ? err.message : String(err)}`,
    );
    return UNREADABLE;
  }
  if (!cancelled.ok) return refused(cancelled.refused);
  return { kind: "cancelled", text: OFFER_CANCELLED_LINE };
}
