import { refusalOf, RefusalError } from "./core/refusal.js";
import { AGENTS } from "./agents/registry.js";
import { MIN_BOUNDARY_MINUTES } from "./config/validate.js";
import { GRANT_RENEWALS_MAX } from "./core/budgets.js";
import { EFFORT_LEVELS_HINT, isEffort, type Effort } from "./effort.js";
import { ADDRESS_SEVERITIES, isAddressSeverity, type AddressSeverity } from "./core/shipPipeline.js";
import { isVerbosity, VERBOSITY_LEVELS_HINT, type Verbosity } from "./core/verbosity.js";

// Per-request directives are inline tokens at the start (or anywhere) in the
// message:  "@switchboard agent:review model:openai/gpt-5 effort:low budget:30 look at the failing test"
// Recognized keys: agent, model, effort, budget, severity, renewals, verbosity. Unknown keys are left in the text untouched.

export interface RequestDirectives {
  agent?: string;
  model?: string;
  effort?: Effort;
  /** The caller's own boundary on THIS run's wall clock, in minutes
   *  (docs/reference/specs/routing-and-config.md items 1–2): it narrows the
   *  preset's budget and never widens it. Whole minutes, at least the boundary
   *  minimum; never sticky — a thread that wants a lower budget on every turn
   *  sets a user boundary instead. */
  budget?: number;
  /** `severity:<level>` — the severity agent:ship must address before an
   *  approve stands. One request's, like `budget:`; resolved by
   *  the ship hand-off over the channel/user scopes and the org default. */
  severity?: AddressSeverity;
  /** `renewals:<count>` — the renewals this ship request may spend (decision
   *  0046, the renewable lease): a whole number from 0 to `GRANT_RENEWALS_MAX`.
   *  One request's, like `budget:`; it sets the grant's count and keeps the
   *  cost cap the scopes set. Never sticky. */
  renewals?: number;
  /** `verbosity:<level>` — how much of itself the bot says in this thread
   *  (docs/reference/specs/routing-and-config.md item 28): `quiet`, `verbose`
   *  or `debug`. Sticky like the effort: a later turn without one keeps it. */
  verbosity?: Verbosity;
  /** message text with directive tokens removed */
  text: string;
}

/** The directive values a thread carries forward (stickiness,
 *  docs/reference/specs/routing-and-config.md item 3): the model, the effort
 *  and the verbosity from the thread's user turns, and the agent from the thread's transcript —
 *  the agent of its newest finished run with a session log, read by the
 *  dispatcher (`stickyAgentOf`), never from an `agent:` token in the history.
 *  A budget is a property of one request and is never carried. */
export interface ThreadDirectives {
  agent?: string;
  model?: string;
  effort?: Effort;
  verbosity?: Verbosity;
}

const DIRECTIVE_RE = /(?:^|\s)(agent|model|effort|budget|severity|renewals|verbosity)[:=](\S+)/g;

/** `budget:<minutes>` takes a whole number of minutes, at least the boundary
 *  minimum (the bash tool keeps a 60-second reserve, so a shorter run could
 *  never execute a command). Undefined for anything else. */
function parseBudgetMinutes(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const minutes = Number(value);
  return minutes >= MIN_BOUNDARY_MINUTES ? minutes : undefined;
}

/**
 * The last model, effort and verbosity directives mentioned in earlier thread messages
 * (user turns only, last one wins) — used to keep follow-ups on the model and
 * effort a thread already established instead of falling back to the global
 * default. The agent is not read here: a thread's agent is the one whose
 * transcript it holds (`stickyAgentOf`), so an `agent:` token in the history
 * is skipped — it named the run it rode on, and that run's session is what
 * carries the agent forward. Lenient where parseDirectives is strict: history
 * is data being scanned, not a command being executed, so malformed or
 * unknown values are skipped, never thrown. A `budget:` in the history is
 * skipped on purpose: it bounded the run it rode on and nothing after it.
 */
export function lastThreadDirectives(history: Array<{ role: string; text: string }>): ThreadDirectives {
  const out: ThreadDirectives = {};
  for (const h of history) {
    if (h.role !== "user") continue;
    for (const m of h.text.matchAll(DIRECTIVE_RE)) {
      if (m[1] === "model") out.model = m[2];
      else if (m[1] === "effort" && isEffort(m[2])) out.effort = m[2];
      else if (m[1] === "verbosity" && isVerbosity(m[2])) out.verbosity = m[2];
    }
  }
  return out;
}

/**
 * The text with every directive token removed and nothing else judged —
 * lenient like `lastThreadDirectives`, for text that is data rather than a
 * command: the replay harness hides the `agent:` a requester typed before it
 * asks the router, whatever else the token said. Whitespace collapses as in
 * `parseDirectives`, so the two agree on a message with no directives.
 */
export function stripDirectiveTokens(input: string): string {
  return input.replace(DIRECTIVE_RE, " ").replace(/\s+/g, " ").trim();
}

export function parseDirectives(input: string): RequestDirectives {
  const out: RequestDirectives = { text: input };
  const found: Array<{ key: string; value: string; match: string }> = [];

  for (const m of input.matchAll(DIRECTIVE_RE)) {
    found.push({ key: m[1], value: m[2], match: m[0] });
  }

  let text = input;
  for (const f of found) {
    if (f.key === "agent") {
      if (!AGENTS[f.value]) {
        throw new RefusalError(
          refusalOf("directive_agent", `Unknown agent "${f.value}". Available: ${Object.keys(AGENTS).join(", ")}`),
        );
      }
      out.agent = f.value;
    } else if (f.key === "model") {
      out.model = f.value;
    } else if (f.key === "effort") {
      if (!isEffort(f.value)) {
        throw new RefusalError(
          refusalOf("directive_effort", `Unknown effort "${f.value}". Valid: ${EFFORT_LEVELS_HINT}`),
        );
      }
      out.effort = f.value;
    } else if (f.key === "budget") {
      const minutes = parseBudgetMinutes(f.value);
      if (minutes === undefined) {
        throw new RefusalError(
          refusalOf(
            "directive_budget",
            `Invalid budget "${f.value}": budget:<minutes> takes a whole number of minutes, at least ${MIN_BOUNDARY_MINUTES} (e.g. budget:30). It narrows this run's wall clock and never widens it.`,
          ),
        );
      }
      out.budget = minutes;
    } else if (f.key === "severity") {
      if (!isAddressSeverity(f.value)) {
        throw new RefusalError(
          refusalOf(
            "directive_severity",
            `Unknown severity "${f.value}". severity:<level> takes one of ${ADDRESS_SEVERITIES.join(", ")} — the severity to address: a review's approve carrying a finding at or above it is a request_changes.`,
          ),
        );
      }
      out.severity = f.value;
    } else if (f.key === "renewals") {
      const count = /^\d+$/.test(f.value) ? Number(f.value) : undefined;
      if (count === undefined || count > GRANT_RENEWALS_MAX) {
        throw new RefusalError(
          refusalOf(
            "directive_renewals",
            `Invalid renewals "${f.value}": renewals:<count> takes a whole number from 0 to ${GRANT_RENEWALS_MAX} — the segments agent:ship may add after its first lease.`,
          ),
        );
      }
      out.renewals = count;
    } else if (f.key === "verbosity") {
      if (!isVerbosity(f.value)) {
        throw new RefusalError(
          refusalOf(
            "directive_verbosity",
            `Unknown verbosity "${f.value}". verbosity:<level> takes one of ${VERBOSITY_LEVELS_HINT} — how much of itself the bot says in this thread.`,
          ),
        );
      }
      out.verbosity = f.value;
    }
    text = text.replace(f.match, " ");
  }
  out.text = text.replace(/\s+/g, " ").trim();
  return out;
}
