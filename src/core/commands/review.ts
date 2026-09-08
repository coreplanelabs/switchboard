import { z } from "zod";
import { authorize } from "../authz/authorize.js";
import type { Actor } from "../authz/types.js";
import {
  CommandError,
  commandDefiner,
  flag,
  wrapUntrusted,
  type Caller,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
} from "../commandRegistry.js";
import {
  AbridgeRefusal,
  type AbridgeArtifactSummary,
  type AbridgeState,
  type ReviewAbridger,
} from "../reviewAbridge.js";
import { RUN_ID_PATTERN } from "../runRecord.js";
import { runResource, type RunsService } from "../runsService.js";

// The `review.*` registrations: `review abridge <id> [--model m] [--force]
// [--wait]` asks for a finished PR review's ABRIDGED reading diff
// (docs/reference/specs/reading-diff.md item 9) — meat.dev run on the bot host over the
// complete diff, appended to the run's stored record. The command is a thin
// wrapper over `ReviewAbridger.abridge`, the ONE path `provider: meat` auto
// mode also takes; nothing about the input, the model, or the artifact is
// decided here.
//
// Two rules about the caller: the command's action is `review:write` (it
// spends one Opus-class call and rewrites a stored record — admins through
// `all`, anyone granted it by name, never a baseline), and the run itself must
// be one the caller may SEE (`runs:read` on the run's own attributes, like every
// `runs.*` point read — a deny is `not_found`, byte-identical to a missing run).
//
// The answer is the state, never the diff: `running` (the in-progress marker a
// panel polls — the same command again answers `done` once the artifact is
// stored), `done` (the artifact's summary; the diff itself is on the record,
// `runs events <id>`), `failed` (the reason). `--wait` blocks for the outcome
// (the CLI's shape); chat gets it as a second reply through `settle`.

export interface ReviewCommandDeps {
  review: {
    /** Absent → `unavailable` naming the three facts the `readingDiffAbridge`
     *  capability reads (the Null Object of an off deployment; the command is
     *  normally hidden before it gets here). */
    abridger(): Promise<ReviewAbridger | undefined>;
    runs(): Promise<RunsService>;
  };
}

const defineCommand = commandDefiner<ReviewCommandDeps>();

const runId = z.string().regex(RUN_ID_PATTERN);

/** The defence-in-depth answer when the abridger is absent at call time — the
 *  `readingDiffAbridge` capability normally HIDES the command instead
 *  (capabilities.md item 2); this names the three facts the capability reads. */
export const ABRIDGE_OFF_MESSAGE =
  "The abridged reading diff is off in this deployment: it needs the `meat` binary on the bot host, the Anthropic provider's credential, `review.readingDiff.provider` not `off`, and run history to store it.";

/** The artifact summary as JSON: each declared field, present only when set
 *  (an `undefined` key would vanish on the wire and differ between surfaces);
 *  the summary wrapped as untrusted — it is model prose generated from the diff. */
function artifactJson(a: AbridgeArtifactSummary): JsonObject {
  return {
    ...(a.model !== undefined ? { model: a.model } : {}),
    ...(a.summary !== undefined ? { summary: wrapUntrusted(a.summary) } : {}),
    ...(a.input !== undefined ? { input: a.input } : {}),
    ...(a.inputBytes !== undefined ? { inputBytes: a.inputBytes } : {}),
    diffChars: a.diffChars,
    truncated: a.truncated,
    ...(a.meatTokens !== undefined ? { meatTokens: { input: a.meatTokens.input, output: a.meatTokens.output } } : {}),
  };
}

/** The command's output: the state as JSON. */
export function abridgeOutput(id: string, state: AbridgeState): JsonValue {
  switch (state.state) {
    case "absent":
      return { id, state: "absent" };
    case "running":
      return { id, state: "running", startedAt: state.startedAt };
    case "failed":
      return { id, state: "failed", reason: state.reason, at: state.at };
    case "done":
      return { id, state: "done", reused: state.reused, artifact: artifactJson(state.artifact) };
  }
}

export function renderAbridge(output: JsonValue): string {
  const o = output as {
    id: string;
    state: string;
    reason?: string;
    reused?: boolean;
    artifact?: Record<string, unknown>;
  };
  switch (o.state) {
    case "running":
      return `Abridging the reading diff of run ${o.id} — running (ask again for the result).`;
    case "failed":
      return `Abridged reading diff for run ${o.id}: failed — ${o.reason ?? "unknown reason"}`;
    case "done": {
      const a = o.artifact ?? {};
      const lines = [
        `Abridged reading diff for run ${o.id}: done${o.reused ? " (already stored)" : ""}`,
        `model: ${String(a.model ?? "?")} · input: ${String(a.input ?? "?")}${typeof a.inputBytes === "number" ? ` (${a.inputBytes} bytes)` : ""} · abridged: ${String(a.diffChars)} chars${a.truncated ? " (capped)" : ""}`,
      ];
      if (typeof a.summary === "string") lines.push(a.summary);
      return lines.join("\n");
    }
    default:
      return `Abridged reading diff for run ${o.id}: ${o.state}`;
  }
}

async function abridgerOf(deps: ReviewCommandDeps): Promise<ReviewAbridger> {
  let abridger: ReviewAbridger | undefined;
  try {
    abridger = await deps.review.abridger();
  } catch (err) {
    throw new CommandError("unavailable", err instanceof Error ? err.message : String(err));
  }
  if (!abridger) throw new CommandError("unavailable", ABRIDGE_OFF_MESSAGE);
  return abridger;
}

/** The run must be one the caller may read (authorization.md items 5–7): a
 *  deny is the same `not_found` an unknown id gives. */
async function assertVisible(deps: ReviewCommandDeps, id: string, caller: Caller): Promise<void> {
  const runs = await deps.review.runs();
  const res = await runs.getRun(id);
  if (!res.ok) throw new CommandError("not_found", "run not found");
  const actor: Actor = caller.actor;
  if (!authorize(actor, "runs:read", runResource(res.value)).allow)
    throw new CommandError("not_found", "run not found");
}

function refused(err: unknown): never {
  if (err instanceof AbridgeRefusal) throw new CommandError(err.code, err.message);
  throw err;
}

export const reviewAbridge = defineCommand({
  id: "review.abridge",
  // Hidden unless the abridging can happen here (the binary, the credential,
  // the switch) AND there is a record to append to.
  enabledWhen: (caps) => caps.runHistory && caps.readingDiffAbridge,
  args: [{ name: "id", schema: runId, describe: "run id of a finished PR review" }],
  options: z.object({
    model: z
      .string()
      .min(1)
      .optional()
      .describe("meat's model (default review.readingDiff.meatModel, else claude-opus-5)"),
    force: flag.optional().describe("recompute even when an abridged diff is already stored, or retry a failed one"),
    wait: flag.optional().describe("block until the abridging finishes and answer the outcome instead of `running`"),
  }),
  action: "review:write",
  effect: "write",
  describe:
    "Abridge a finished PR review's reading diff with meat.dev on the bot host (one Opus-class call) and store it on the run; idempotent — a stored one is answered, not recomputed.",
  render: renderAbridge,
  handler: async ({ args, options, caller, deps }) => {
    await assertVisible(deps, args.id, caller);
    const abridger = await abridgerOf(deps);
    let state = await abridger.abridge({ runId: args.id, model: options.model, force: options.force }).catch(refused);
    if (options.wait && state.state === "running") state = await abridger.wait(args.id);
    return abridgeOutput(args.id, state);
  },
  // Chat: the acknowledgement is `running`; the outcome lands as a second reply.
  settle: async (output, { deps }) => {
    const o = output as { id: string; state: string };
    if (o.state !== "running") return undefined;
    const abridger = await deps.review.abridger();
    if (!abridger) return undefined;
    const final = await abridger.wait(o.id);
    return { ok: final.state === "done", text: renderAbridge(abridgeOutput(o.id, final)) };
  },
});

export const reviewCommands: readonly CommandDef<ReviewCommandDeps>[] = [
  reviewAbridge,
] as unknown as CommandDef<ReviewCommandDeps>[];

export function registerReviewCommands<D extends ReviewCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of reviewCommands) registry.register(cmd as unknown as CommandDef<D>);
}
