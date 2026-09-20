// The one execution table (record 0069, as amended; the
// one-execution-path plan's loop unit): after the operator decides, ONE
// module owns what happens next. The loop's turn outcome and the surface it
// landed on map to exactly one cell — run, click, route, question or refuse —
// and every caller executes the cell it is answered, rendering nothing of its
// own. Both unions are closed and `decideExecution` switches exhaustively, so
// a new tool or surface is a compile error at every caller: the next defect
// is a missing cell, never a fifteenth render site (the record's day of
// fourteen defects, each one more module deciding a bind's fate alone).

/** Where the person is: a chat surface renders clicks and cards (Slack, the
 *  web chat); a typed surface's native act is typing (the CLI, HTTP, MCP), so
 *  its refusals may name the line — chat's never do. */
export type Surface = "chat" | "typed";

/** How one operator turn ended — the loop's whole vocabulary of acts, closed.
 *  A malformed act is unrepresentable: the typed tool schema carries the
 *  preset and the person's request as arguments, so there is no line to
 *  mangle, and the model authors no refusal — its "cannot" is an `ask` or an
 *  ended turn, and a refusal exists only where the policy table made one. */
export type TurnOutcome =
  /** `run_command`: a registry command with typed arguments. `confirm` is the
   *  class ladder's verdict over the PARSED input against the path's
   *  effective confirm class; `mintable` says record 0044's store could mint
   *  the click — false when the store is unreachable or `redactSecrets`
   *  would alter the line (an unshowable line is never a button). */
  | { kind: "run_command"; confirm: "below" | "at_or_above"; mintable: boolean }
  /** `bind_preset`: a preset on the person's own request, carried verbatim as
   *  a typed argument. */
  | { kind: "bind_preset" }
  /** `ask`: one question, parked as the thread's pending question in durable
   *  state; the person's next words in the thread are its answer. */
  | { kind: "ask" }
  /** `unresolvable_write`: a write-class command call the deployment cannot
   *  run as typed — a required argument missing, or a value naming a model
   *  provider this deployment does not have (issue 2088: "openai" where
   *  OpenAI models ride openrouter). The intent is a write, so no read
   *  command answers it and no floor re-reads it: the cell is one question
   *  whose proposal is the write line built from the providers and presets
   *  that exist, so "yes" runs it through the click path and the person's
   *  next words refine it. */
  | { kind: "unresolvable_write" }
  /** A turn that ended with no tool call: the model had nothing to act on. */
  | { kind: "ended" }
  /** A line the person's own chat grammar parses: their typed decision — it
   *  never enters the loop and is never re-spelled. */
  | { kind: "typed_line" }
  /** A steer into a thread a live run or a pipeline owns: the owner rule's
   *  fold, read before the loop sees the message. */
  | { kind: "steer_owned" }
  /** A refusal the policy table made, naming the row it stands on — never a
   *  sentence the model authored. */
  | { kind: "policy_refusal" };

/** The five cells a turn outcome can land in. Every caller executes its cell
 *  and renders nothing else — no cell is a line for a person to retype on a
 *  chat surface. */
export type ExecutionCell =
  /** Run through the class ladder, the receipt naming the line, the class
   *  verdict and the reason. */
  | { cell: "run" }
  /** Record 0044's row, minted by the one offer path, the full bound line on
   *  the button. */
  | { cell: "click" }
  /** The readers' route runs the person's own request — the one last-resort
   *  floor, terminal for the event: a floored request never re-enters the
   *  loop, and the router reads the thread's parent as the request. */
  | { cell: "route" }
  /** One question, parked as the thread's pending question; the next words in
   *  the thread are its answer and rebind the original request. */
  | { cell: "question" }
  /** A refusal through record 0054's renderer, its text carried whole under
   *  the reason cap. `names` says what the refusal must name: the policy row
   *  it stands on, why the click could not mint, or — on a typed surface
   *  only — the typed form of the line. */
  | { cell: "refuse"; names: "policy_row" | "mint_failure" | "typed_form" };

/**
 * The table, pure and total (record 0069's amended table): every turn outcome
 * × surface pair answers exactly one cell. The rows, verbatim from the
 * record: `run_command` below the effective confirm class runs on both
 * surfaces; at or above it, a chat surface gets the click (or a refusal
 * naming why the mint failed — never a line to retype) and a typed surface a
 * refusal naming the typed form, typing being that surface's native act; a
 * preset bind routes the person's own request; an `ask` is the parked
 * question — and so is a write-class call the deployment cannot run as typed
 * (a required argument missing, or a provider it does not have), its proposal
 * built from what exists (issue 2088's cell: a write intent never executes as
 * a read command); a turn ending with no tool call floors to the route; a typed
 * registry line runs as typed; a steer into an owned thread runs as
 * admission's fold; and a refusal comes only from the policy table, naming
 * its row.
 */
export function decideExecution(outcome: TurnOutcome, surface: Surface): ExecutionCell {
  switch (outcome.kind) {
    case "run_command":
      if (outcome.confirm === "below") return { cell: "run" };
      if (surface === "typed") return { cell: "refuse", names: "typed_form" };
      return outcome.mintable ? { cell: "click" } : { cell: "refuse", names: "mint_failure" };
    case "bind_preset":
      return { cell: "route" };
    case "ask":
      return { cell: "question" };
    case "unresolvable_write":
      return { cell: "question" };
    case "ended":
      return { cell: "route" };
    case "typed_line":
      return { cell: "run" };
    case "steer_owned":
      return { cell: "run" };
    case "policy_refusal":
      return { cell: "refuse", names: "policy_row" };
    default:
      return unreachable(outcome);
  }
}

/** The totality guard: a `TurnOutcome` the switch above does not name fails
 *  to compile here, so an unknown tool refuses to compile at the table rather
 *  than falling through at a caller. */
function unreachable(outcome: never): never {
  throw new Error(`no cell for turn outcome ${JSON.stringify(outcome)}`);
}
