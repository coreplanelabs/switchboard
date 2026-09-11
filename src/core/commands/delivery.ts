import { z } from "zod";
import { predicateFor } from "../authz/predicate.js";
import {
  CommandError,
  commandDefiner,
  type CommandDef,
  type CommandRegistry,
  type JsonValue,
} from "../commandRegistry.js";
import {
  DELIVERY_OFF_MESSAGE,
  MAX_WEEKS,
  renderDeliveryReport,
  runFactsOf,
  type DeliveryRange,
  type DeliveryReport,
  type DeliveryService,
  type RunFact,
} from "../delivery.js";
import { RUN_LIST_MAX_LIMIT } from "../runRecord.js";
import type { RunsService } from "../runsService.js";

// `delivery.report` (docs/reference/specs/delivery.md): the delivery indicators of
// one repository — issue-to-merge time, first-pass CI, review rounds, the
// findings and the share resolved with no human edit — per week and per unit,
// read from GitHub and the caller's own run history, written nowhere. Derived
// forms: `delivery report [--repo owner/name] [--since YYYY-MM-DD] [--weeks n]`
// in chat and on the CLI, `/api/delivery.report`, the `delivery_report` MCP tool.
//
// Two rules the service does not enforce because they are about the CALLER:
//   - which runs join the report is the authorization policy: the store is
//     handed `predicateFor(actor, "runs:read", "run")`, so a caller who may
//     read no runs gets the pull requests' facts alone — never a refusal;
//   - the command needs the `github` capability (the read is the App's token)
//     and is hidden everywhere without it.
// GitHub is read through the delivery service; nothing here starts a run.

export interface DeliveryCommandDeps {
  delivery: {
    /** The service; a process without GitHub hands the Null Object, whose report is `unavailable`. */
    service(): Promise<DeliveryService>;
  };
  /** The runs the history adds — resolved lazily like every store-backed dep. */
  runs(): Promise<RunsService>;
}

const defineCommand = commandDefiner<DeliveryCommandDeps>();

const REPO_SLUG = /^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const asJson = (v: unknown): JsonValue => v as JsonValue;

export const deliveryReport = defineCommand({
  id: "delivery.report",
  options: z.object({
    repo: z
      .string()
      .regex(REPO_SLUG)
      .optional()
      .describe("the repository (`owner/name`); default: the first under `delivery.repos`"),
    since: z
      .string()
      .regex(ISO_DAY)
      .optional()
      .describe("the first day of the range (`YYYY-MM-DD`, UTC); the range ends today"),
    weeks: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_WEEKS)
      .optional()
      .describe(
        `Monday-start weeks back from this one (default 4, at most ${MAX_WEEKS}); --since, when given, decides instead`,
      ),
  }),
  action: "delivery:read",
  effect: "read",
  enabledWhen: (caps) => caps.github,
  describe:
    "Delivery indicators per week and per unit — issue-to-merge time, first-pass CI, review rounds, findings and the share resolved with no human edit — read from GitHub and the run history; nothing written.",
  render: (output) => renderDeliveryReport(output as unknown as DeliveryReport),
  handler: async ({ options, caller, deps }) => {
    const service = await deps.delivery.service();
    const repo = options.repo ?? service.repos()[0];
    if (repo === undefined)
      throw new CommandError(
        "invalid_input",
        "name a repository with --repo owner/name (no repository is configured under delivery.repos)",
      );
    // The history's half: the caller's visible finished runs of this repository
    // since the range began — the store applies the policy predicate, so a
    // caller with no `runs:read` contributes an empty list, not an error.
    const runs = async (range: DeliveryRange): Promise<RunFact[]> => {
      const page = await (
        await deps.runs()
      ).listRuns({
        status: "finished",
        visibleTo: predicateFor(caller.actor, "runs:read", "run"),
        sinceMs: Date.parse(`${range.since}T00:00:00Z`),
        limit: RUN_LIST_MAX_LIMIT,
      });
      return runFactsOf(page.runs, repo);
    };
    try {
      return asJson(await service.report(repo, { since: options.since, weeks: options.weeks, runs }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === DELIVERY_OFF_MESSAGE) throw new CommandError("unavailable", message);
      throw new CommandError("unavailable", `delivery indicators unavailable: ${message}`);
    }
  },
});

export const deliveryCommands: readonly CommandDef<DeliveryCommandDeps>[] = [
  deliveryReport,
] as unknown as CommandDef<DeliveryCommandDeps>[];

export function registerDeliveryCommands<D extends DeliveryCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of deliveryCommands) registry.register(cmd as unknown as CommandDef<D>);
}
