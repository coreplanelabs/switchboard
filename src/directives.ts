import { AGENTS } from "./agents/registry.js";
import { MIN_BOUNDARY_MINUTES } from "./config/validate.js";
import { EFFORT_LEVELS_HINT, isEffort, type Effort } from "./effort.js";

// Per-request directives are inline tokens at the start (or anywhere) in the
// message:  "@switchboard agent:review model:openai/gpt-5 effort:low budget:30 look at the failing test"
// Recognized keys: agent, model, effort, budget. Unknown keys are left in the text untouched.

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
  /** message text with directive tokens removed */
  text: string;
}

/** The directive values a thread can carry forward (stickiness). A budget is
 *  a property of one request and is never carried. */
export interface ThreadDirectives {
  agent?: string;
  model?: string;
  effort?: Effort;
}

const DIRECTIVE_RE = /(?:^|\s)(agent|model|effort|budget)[:=](\S+)/g;

/** `budget:<minutes>` takes a whole number of minutes, at least the boundary
 *  minimum (the bash tool keeps a 60-second reserve, so a shorter run could
 *  never execute a command). Undefined for anything else. */
function parseBudgetMinutes(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const minutes = Number(value);
  return minutes >= MIN_BOUNDARY_MINUTES ? minutes : undefined;
}

/**
 * Last agent/model directives mentioned in earlier thread messages (user turns
 * only, last one wins) — used to keep follow-ups on the agent/model a thread
 * already established instead of falling back to the global default. Lenient
 * where parseDirectives is strict: history is data being scanned, not a
 * command being executed, so malformed or unknown values are skipped, never
 * thrown. A `budget:` in the history is skipped on purpose: it bounded the
 * run it rode on and nothing after it.
 */
export function lastThreadDirectives(history: Array<{ role: string; text: string }>): ThreadDirectives {
  const out: ThreadDirectives = {};
  for (const h of history) {
    if (h.role !== "user") continue;
    for (const m of h.text.matchAll(DIRECTIVE_RE)) {
      if (m[1] === "agent" && AGENTS[m[2]]) out.agent = m[2];
      else if (m[1] === "model") out.model = m[2];
      else if (m[1] === "effort" && isEffort(m[2])) out.effort = m[2];
    }
  }
  return out;
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
        throw new Error(`Unknown agent "${f.value}". Available: ${Object.keys(AGENTS).join(", ")}`);
      }
      out.agent = f.value;
    } else if (f.key === "model") {
      out.model = f.value;
    } else if (f.key === "effort") {
      if (!isEffort(f.value)) {
        throw new Error(`Unknown effort "${f.value}". Valid: ${EFFORT_LEVELS_HINT}`);
      }
      out.effort = f.value;
    } else if (f.key === "budget") {
      const minutes = parseBudgetMinutes(f.value);
      if (minutes === undefined) {
        throw new Error(
          `Invalid budget "${f.value}": budget:<minutes> takes a whole number of minutes, at least ${MIN_BOUNDARY_MINUTES} (e.g. budget:30). It narrows this run's wall clock and never widens it.`,
        );
      }
      out.budget = minutes;
    }
    text = text.replace(f.match, " ");
  }
  out.text = text.replace(/\s+/g, " ").trim();
  return out;
}
