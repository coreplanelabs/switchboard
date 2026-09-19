import { z } from "zod";
import { CommandError, commandDefiner, type CommandRegistry } from "../commandRegistry.js";

// The `steer` registration (record 0057; the one-door plan's operator unit): fold
// words into a live run at its next step boundary, by run id — the typed form
// of the thread-reply steer admission does, and the line the operator binds
// when a reply names a run in another thread (the plan's steer rule: a bind of `steer` names a
// run and folds into it at its next boundary, whichever thread holds it).
// Chat-only by design (`surfaces: { mcp: false, http: false, cli: false }`):
// a steer is a person's words into a live conversation, and the machine
// surfaces have `send_to_run` and the ingress for that. Write class: it
// changes a live run's course. The sender seam is the dispatcher's — the
// admission inbox lives there — and a process that has not wired one answers
// `unavailable` by name; the plan's admission unit wires it with the
// steer owner rule.

export interface SteerCommandDeps {
  /** Absent — no sender wired in this process — the command answers
   *  `unavailable` by name. */
  steer?: {
    /** Fold the words into the named run's inbox at its next boundary; answers
     *  the receipt line. Throws `CommandError` when the run is not live or the
     *  caller may not steer it. */
    send(runId: string, words: string, caller: { kind: string; id: string }): Promise<string>;
  };
}

const defineCommand = commandDefiner<SteerCommandDeps>();

export const STEER_UNAVAILABLE = "Steering by run id is not wired in this process; reply in the run's thread instead.";

export const steerRun = defineCommand({
  id: "steer.run",
  args: [
    { name: "id", schema: z.string().min(1), describe: "the run to steer" },
    { name: "words", schema: z.string().min(1), rest: true, describe: "what to tell the run" },
  ],
  action: "runs:write",
  effect: "write",
  // Changes a live run's course; the words fold in and cannot be unsaid.
  annotations: { destructive: false, risk: () => "folds words into someone's live run at its next boundary" },
  surfaces: { mcp: false, http: false, cli: false },
  describe: "Fold words into a live run at its next step boundary, by run id.",
  render: (o) => String((o as { text?: unknown }).text ?? ""),
  handler: async ({ args, caller, deps }) => {
    if (!deps.steer) throw new CommandError("unavailable", STEER_UNAVAILABLE);
    const text = await deps.steer.send(args.id, args.words, { kind: caller.kind, id: caller.id });
    return { runId: args.id, text };
  },
});

export function registerSteerCommands(registry: CommandRegistry<SteerCommandDeps>): void {
  registry.register(steerRun);
}
