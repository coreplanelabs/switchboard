import type { ResidentStep } from "../execution/residentStepTrace.js";
import type { Span } from "./trace/types.js";

// Deterministic operations: the seam behind the registry's
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
// command table (resident) or a fixed convention (local). The commands that
// reach this seam (`repo test <owner/name> [ref]`, `repo build …`) are registry
// commands bound by the shared grammar (src/core/commands/repo.ts); a natural
// sentence ("run the tests on main in acme/api") reaches the same command
// through the router's door (src/core/dispatch/route.ts), which binds the
// arguments under the command's schema — nothing here reads prose.

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
      /** The resident's own step trace (docs/reference/specs/tracing.md item 19), sanitized at the parse. */
      trace?: ResidentStep[];
      /** The resident's total for the op, for the clock-skew attr. */
      residentMs?: number;
    }
  /** the backend refused by policy (e.g. a mutating command-table entry) */
  | { kind: "refused"; reason: string }
  /** the repo has no resident — the command answers `not_found` naming `repo onboard` */
  | { kind: "not-onboarded" }
  /** transport or backend failure — never rendered as a fake result */
  | { kind: "error"; message: string };

export interface Operations {
  /** `trace.span`: the caller's span, when it has one — the backend's HTTP
   *  call becomes its `http.client` child (docs/reference/specs/tracing.md item 21). */
  run(op: OpName, req: { repo: string; ref?: string }, trace?: { span?: Span }): Promise<OperationResult>;
}
