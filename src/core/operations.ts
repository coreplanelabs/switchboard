import type { ResidentStep } from "../execution/residentStepTrace.js";
import { repoFromThread } from "./repoContext.js";
import { parseSlug, validRef } from "./residentAdmin.js";

// Deterministic operations (U6, KTD8): the seam behind the registry's
// `repo.test` / `repo.build` commands. The 3-method Executor cannot express a
// named op with a structured result, so this is a separate capability: a name
// from a FIXED enum → {ok, summary, output}. Two implementations exist per the
// ≥2-implementations invariant — resident-backed (ResidentOperations in
// src/execution/resident.ts, POST /op resolving ONLY through the onboard-time
// command table in a disposable per-op checkout) and local (LocalOperations
// in src/execution/executor.ts, dev/CLI).
//
// Injection posture: there is NO model turn on this path to catch prompt
// injection, so nothing here may guess. Op names resolve only through
// OP_NAMES; ref arguments must pass the resident's strict pattern (and later
// resolve in the resident's mirror); request text is NEVER interpolated into
// a shell command — the command STRING always comes from the admin-written
// command table (resident) or a fixed convention (local). The explicit forms
// (`repo test <owner/name> [ref]`) are registry commands bound by the shared
// grammar (src/core/commands/repo.ts); `recognizeOperation` below covers ONLY
// the conservative natural-language forms and translates them into the same
// registry invocation — anything ambiguous is null → the dispatcher falls
// through to the agent (KD3).

export const OP_NAMES = ["test", "build", "status"] as const;
export type OpName = (typeof OP_NAMES)[number];

/** Structured outcome of one op. `result` covers BOTH passing and failing
 *  runs (a failing test run is a result, not an error path); the other kinds
 *  are the named non-run outcomes the command maps to registry errors. */
export type OperationResult =
  | {
      kind: "result";
      ok: boolean;
      summary: string;
      output?: string;
      /** The resident's own step trace (features/tracing.md item 19), sanitized at the parse. */
      trace?: ResidentStep[];
      /** The resident's total for the op, for the clock-skew attr. */
      residentMs?: number;
    }
  /** the backend refused by policy (e.g. a mutating command-table entry) */
  | { kind: "refused"; reason: string }
  /** the repo has no resident — the natural-language path falls through */
  | { kind: "not-onboarded" }
  /** transport or backend failure — never rendered as a fake result */
  | { kind: "error"; message: string };

export interface Operations {
  run(op: OpName, req: { repo: string; ref?: string }): Promise<OperationResult>;
}

/** A natural-language deterministic ask, recognized conservatively. */
export interface RecognizedOp {
  op: "test" | "build";
  repo: string;
  ref: string;
}

// Conservative natural-language forms (KTD8): whole-message anchoring, one
// optional "in <owner/name>" tail, nothing else. "run the tests on main and
// then deploy", question forms, and extra prose all fail to match — by design.
const NL_TEST_RE = /^run\s+(?:the\s+)?tests?\s+on\s+(\S+)(?:\s+in\s+(\S+))?$/i;
const NL_BUILD_RE = /^build\s+(\S+)(?:\s+in\s+(\S+))?$/i;

/**
 * Pure, sync recognition of a natural-language deterministic ask. Recognized
 * only when `allowNatural` (the dispatcher disables it when the message carries
 * explicit agent:/model: directives — the user picked a model path) and only
 * when BOTH the ref and the repo are unambiguous: the repo comes from the "in
 * <owner/name>" tail or the thread's established repo (message or history —
 * the same sources as repoContext). Anything else → null.
 */
export function recognizeOperation(
  text: string,
  history: Array<{ role: string; text: string }>,
  opts: { allowNatural: boolean },
): RecognizedOp | null {
  if (!opts.allowNatural) return null;

  // Trailing "." / "!" are stripped; a trailing "?" is a question → no match.
  const trimmed = text.trim().replace(/[.!\s]+$/, "");
  const m = NL_TEST_RE.exec(trimmed) ?? NL_BUILD_RE.exec(trimmed);
  if (!m) return null;
  const op: "test" | "build" = /^run/i.test(trimmed) ? "test" : "build";

  const refToken = m[1];
  const repoToken = m[2];
  const ref = validRef(refToken);
  if (!ref) return null; // hostile/implausible ref: silently non-matching

  let repo: string | undefined;
  if (repoToken) {
    repo = parseSlug(repoToken);
    if (!repo) return null; // "in <not-a-slug>" — ambiguous, never guess
  } else {
    // An owner/name-shaped "on" token without an explicit repo is ambiguous
    // (slug or slashy branch?) — mirror repoContext's caution and fall through.
    if (parseSlug(refToken)) return null;
    repo = repoFromThread(history);
  }
  if (!repo) return null;

  return { op, repo, ref };
}
