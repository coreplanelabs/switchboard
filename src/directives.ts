import { AGENTS } from "./agents/registry.js";
import { MIN_BOUNDARY_MINUTES } from "./config/validate.js";
import { GRANT_RENEWALS_MAX } from "./core/budgets.js";
import { isEffort, type Effort } from "./effort.js";
import { isAddressSeverity, type AddressSeverity } from "./core/shipPipeline.js";
import { isVerbosity, type Verbosity } from "./core/verbosity.js";

// Per-request directives are inline tokens in the message:
//   "@switchboard agent:review model:openai/gpt-5 effort:low budget:30 look at the failing test"
// Recognized keys: agent, model, effort, budget, severity, renewals, verbosity. Unknown keys are left in the text untouched.
//
// The interim grammar until record 0057 removes directive syntax from the chat
// surfaces: `agent:` is a directive only where a command would
// be — the head of the message, its first token once the mention is stripped —
// because prose ABOUT the system quotes it mid-sentence ("…the next agent:ship
// in the thread claims the host key") and a steer refused for that read is
// silent to the run it addressed. Every other key keeps the anywhere rule,
// since review asks carry `severity:` at the tail. And a token whose value is
// not in its key's vocabulary is text, never a refusal of the whole message: a
// quoted `severity:major"` (stray quote included) must not sink the ask that
// carries it.

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

/** Every directive key but `agent`, anywhere in the text. */
const DIRECTIVE_RE = /(?:^|\s)(model|effort|budget|severity|renewals|verbosity)[:=](\S+)/g;
/** `agent:` binds only at the head: the first token of the text. */
const HEAD_AGENT_RE = /^\s*agent[:=](\S+)/;

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
 * carries the agent forward. Malformed or unknown values are skipped, never
 * thrown — the same fall-back-to-text rule `parseDirectives` applies. A
 * `budget:` in the history is skipped on purpose: it bounded the run it rode
 * on and nothing after it.
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
 * The text with every directive token removed and nothing else judged — for
 * text that is data rather than a command: the replay harness hides the
 * `agent:` a requester typed before it asks the router, whatever else the
 * token said. One scanner with `parseDirectives`, so the two agree on the
 * boundary: a head `agent:`, an anywhere token with a value in its
 * vocabulary, and nothing else.
 */
export function stripDirectiveTokens(input: string): string {
  return parseDirectives(input).text;
}

/** `renewals:<count>` takes a whole number from 0 to the module's ceiling.
 *  Undefined for anything else. */
function parseRenewals(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const count = Number(value);
  return count <= GRANT_RENEWALS_MAX ? count : undefined;
}

export function parseDirectives(input: string): RequestDirectives {
  const out: RequestDirectives = { text: input };
  let text = input;

  // `agent:` binds only at the head, and only a registered agent binds: an
  // unknown name is someone's prose, not a command to refuse.
  const head = HEAD_AGENT_RE.exec(input);
  if (head !== null && AGENTS[head[1]] !== undefined) {
    out.agent = head[1];
    text = text.replace(head[0], " ");
  }

  for (const m of input.matchAll(DIRECTIVE_RE)) {
    const [token, key, value] = m;
    if (key === "model") {
      out.model = value; // no vocabulary: unknown models pass through and the provider errors
    } else if (key === "effort") {
      if (!isEffort(value)) continue;
      out.effort = value;
    } else if (key === "budget") {
      const minutes = parseBudgetMinutes(value);
      if (minutes === undefined) continue;
      out.budget = minutes;
    } else if (key === "severity") {
      if (!isAddressSeverity(value)) continue;
      out.severity = value;
    } else if (key === "renewals") {
      const count = parseRenewals(value);
      if (count === undefined) continue;
      out.renewals = count;
    } else {
      if (!isVerbosity(value)) continue;
      out.verbosity = value;
    }
    text = text.replace(token, " ");
  }
  out.text = text.replace(/\s+/g, " ").trim();
  return out;
}
