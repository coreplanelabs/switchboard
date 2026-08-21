import { AGENTS } from "./agents/registry.js";

// Per-request directives are inline tokens at the start (or anywhere) in the
// message:  "@switchboard agent:review model:openai/gpt-5 look at PR #42"
// Recognized keys: agent, model. Unknown keys are left in the text untouched.

export interface RequestDirectives {
  agent?: string;
  model?: string;
  /** message text with directive tokens removed */
  text: string;
}

const DIRECTIVE_RE = /(?:^|\s)(agent|model)[:=](\S+)/g;

/**
 * Last agent/model directives mentioned in earlier thread messages (user turns
 * only, last one wins) — used to keep follow-ups on the agent/model a thread
 * already established instead of falling back to the global default. Lenient
 * where parseDirectives is strict: history is data being scanned, not a
 * command being executed, so malformed or unknown values are skipped, never
 * thrown.
 */
export function lastThreadDirectives(
  history: Array<{ role: string; text: string }>,
): { agent?: string; model?: string } {
  const out: { agent?: string; model?: string } = {};
  for (const h of history) {
    if (h.role !== "user") continue;
    for (const m of h.text.matchAll(DIRECTIVE_RE)) {
      if (m[1] === "agent" && AGENTS[m[2]]) out.agent = m[2];
      else if (m[1] === "model") out.model = m[2];
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
        throw new Error(
          `Unknown agent "${f.value}". Available: ${Object.keys(AGENTS).join(", ")}`,
        );
      }
      out.agent = f.value;
    } else if (f.key === "model") {
      out.model = f.value;
    }
    text = text.replace(f.match, " ");
  }
  out.text = text.replace(/\s+/g, " ").trim();
  return out;
}
