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
  elsewhere_agent_allowlist: "policy",
  elsewhere_follow_up_refused: "request",
  which_branch: "request",
  workspace_lost: "system",
  ship_preflight: "system",
  ship_budget: "request",
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

/** A refusal as a throwable, for producers whose call shape is a throw. */
export class RefusalError extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(refusal.text);
    this.name = "RefusalError";
    this.refusal = refusal;
  }
}
