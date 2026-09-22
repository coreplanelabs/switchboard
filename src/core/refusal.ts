// The refusal seam (docs/decisions/0054-a-refusal-the-person-caused-is-one-question-with-a-best-guess.md): every refusal the
// bot makes is one `Refusal` value with a cause, produced by the stage that
// cannot proceed and rendered in one place (`renderRefusal` in
// dispatch/reply.ts). A code has exactly one cause, in one table — a code the
// table does not know is a type error — so the trace, the run record and the
// door report count refusals by the same names.
import type { IncomingMessage } from "./types.js";

/** Why the bot refused, in the record's three classes: a different sentence
 *  from the person would work (`request`), the person may not (`policy`), or
 *  the bot or a dependency cannot act now (`system`). */
export type RefusalCause = "request" | "policy" | "system";

/** The bot's best guess at what the person meant: the person's message with
 *  the fix applied, the line as the person would type it, and the evidence
 *  that names the match. Produced by a later unit of record 0054's plan;
 *  carried here so the seam's
 *  shape is complete from the first unit. */
export interface Guess {
  proposal: IncomingMessage;
  line: string;
  evidence: string;
}

/** A command handler's guess hint (record 0054): the corrected chat form and
 *  the evidence, without the full proposal — the proposal is synthesised at
 *  the invocation point from the original message and this hint's `line`. The
 *  handler carries this lighter type on `CommandError.guess`; the adapter
 *  (`invokeChatCommand`, `answerCommand`) builds the `Guess` that
 *  `renderRefusal` expects. */
export interface CommandGuessHint {
  line: string;
  evidence: string;
}

/** One cause per code — the closed table `causeOf` reads. The codes are the
 *  inventory's: the dispatch gates' `refuse(code)` outcomes, the click's four
 *  `confirmation_*` codes, the two `elsewhere_*` reasons that never reached a
 *  span before, the references step's eight reasons (request 2, policy 3,
 *  system 3 — the appendix's split), and `uncaught` for the catch-all. */
const CAUSE_OF = {
  // the dispatch gates (dispatcher.ts `refuse(code)`)
  agent_allowlist: "policy",
  profile_bounded: "policy",
  repo_not_visible: "policy",
  repo_unverified: "system",
  repo_not_onboarded: "request",
  repo_access: "policy",
  pr_head_unknown: "system",
  branch_moved: "system",
  coordinator_thread_live: "system",
  live_agent_allowlist: "policy",
  follow_up_refused: "request",
  // the seed thread of a live pipeline runner (record 0051's owner rule):
  // a reply there is refused naming the unit thread, never run beside it
  pipeline_thread_owned: "request",
  elsewhere_agent_allowlist: "policy",
  elsewhere_follow_up_refused: "request",
  which_branch: "request",
  workspace_lost: "system",
  ship_budget: "request",
  // one pipeline per thread (record 0060): the host key's claim answered thread-live
  ship_thread_live: "request",
  setup_failed: "system",
  // the click on a confirmation (confirm.ts)
  confirmation_used: "request",
  confirmation_expired: "request",
  confirmation_foreign: "policy",
  confirmation_unreadable: "system",
  // the references step's eight reasons (record 0037: one sentence, eight codes)
  reference_over_cap: "request",
  reference_rate_limited: "request",
  reference_guest: "policy",
  reference_not_a_member: "policy",
  reference_denied: "policy",
  reference_timed_out: "system",
  reference_never: "system",
  reference_fetch_failed: "system",
  // the catch-all: an uncaught throw in dispatch()
  uncaught: "system",
  // the ship preflight's nine results (record 0054's plan): the old
  // `ship_preflight` code is kept as these codes' prefix, so a query on the
  // old code still finds them; the sentence did not split with the code.
  ship_preflight_channel: "system",
  ship_preflight_permission: "policy",
  ship_preflight_no_repo: "request",
  ship_preflight_pr_unreachable: "system",
  ship_preflight_pr_facts: "system",
  ship_preflight_fork_head: "request",
  ship_preflight_head_unknown: "system",
  ship_preflight_closed_resume: "request",
  ship_preflight_no_task: "request",
  ship_preflight_base_missing: "request",
  // the plan hand-off's fifteen sentences (two share `plan_history_unavailable`)
  plan_base_unknown: "request",
  plan_routed_seed: "request",
  plan_id_invalid: "request",
  plan_unreadable: "request",
  plan_no_units: "request",
  plan_units_unknown: "request",
  plan_runner_state_unknown: "system",
  plan_runner_live: "system",
  plan_runner_state_unread: "system",
  plan_units_merged: "request",
  plan_history_unavailable: "system",
  decision_record_store_unavailable: "system",
  plan_runner_conflict: "system",
  plan_instance_orphaned: "system",
  plan_start_failed: "system",
  // the resolve parser's thrown errors (A6 of the inventory); the directive
  // parser no longer refuses — a token whose value is outside its vocabulary
  // is text (the interim grammar, src/directives.ts)
  provider_unknown: "request",
  // the model card's refusal (record 0052, model-proxy item 11): a control the
  // resolved card does not take, named before any card or model call
  model_card_refused: "request",
  // a follow-up dropped because the run it was folded into was stopped
  follow_up_dropped: "system",
  // the typed-command codes (`InvokeErrorCode`): `chatErrorLine` renders these
  // through the renderer's one line shape; the cause rides `CommandError`.
  command_unauthorized: "policy",
  command_invalid_input: "request",
  command_not_found: "request",
  command_conflict: "system",
  command_unavailable: "system",
  command_busy: "system",
  command_internal: "system",
  // the resident Worker's JSON errors, at the moment the bot receives them
  // (record 0054): the cause is read from the Worker's `error` prefix.
  resident_attach_rejected: "request",
  resident_attach_failed: "system",
} as const satisfies Record<string, RefusalCause>;

/** Every code a refusal may carry. A new refusal site adds its code here with
 *  its one cause; an unknown code does not compile. */
export type RefusalCode = keyof typeof CAUSE_OF;

/** The one cause of a code — exhaustive over the union above. */
export function causeOf(code: RefusalCode): RefusalCause {
  return CAUSE_OF[code];
}

/** Every code the table knows, for tests and reports. */
export const REFUSAL_CODES: readonly RefusalCode[] = Object.keys(CAUSE_OF) as RefusalCode[];

/** One refusal: the cause, the code, the sentence the person reads (built by
 *  the producing site, byte-identical to what it said before the seam), the
 *  best guess when the site holds one, and the way forward when the cause is
 *  `policy` and the text does not already carry it. */
export interface Refusal {
  cause: RefusalCause;
  code: RefusalCode;
  text: string;
  guess?: Guess;
  wayForward?: string;
}

/** Build a `Refusal` for a code: the cause comes from the one table. */
export function refusalOf(code: RefusalCode, text: string, extra?: Pick<Refusal, "guess" | "wayForward">): Refusal {
  return { cause: causeOf(code), code, text, ...(extra ?? {}) };
}

/** The one line a `Refusal` reads as, shared by the async renderer and the
 *  string-shaped surfaces (`chatErrorLine`): the producer's own text, plus the
 *  way forward when the cause is `policy` and one was set apart. */
export function refusalLine(refusal: Refusal): string {
  if (refusal.cause === "policy" && refusal.wayForward) return `${refusal.text} ${refusal.wayForward}`;
  return refusal.text;
}

/** A typed command's error code as a refusal code with its one cause. */
export function commandRefusalCode(
  code: "unauthorized" | "invalid_input" | "not_found" | "conflict" | "unavailable" | "busy" | "internal",
): RefusalCode {
  return `command_${code}`;
}

/** The cause the Worker's `error` prefix names (record 0054): a wrong or missing ref is
 *  the person's to fix (`request`); everything else is the machinery's —
 *  `op-unavailable` included: the Worker says it when its command table has no
 *  entry for the op the bot sent, a version skew between bot and Worker, not a
 *  sentence the person could reword. */
export function residentErrorCause(error: string): RefusalCause {
  const prefix = error.split(":", 1)[0]?.trim();
  return prefix === "needs-ref" || prefix === "unknown-ref" ? "request" : "system";
}

/** A refusal as a throwable, for producers whose call shape is a throw. */
export class RefusalError extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(refusal.text);
    this.name = "RefusalError";
    this.refusal = refusal;
  }
}
