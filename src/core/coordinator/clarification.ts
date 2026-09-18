import type { RequestDirectives } from "../../directives.js";
import type { GithubApi } from "../../execution/githubApi.js";
import { MIN_BOUNDARY_MINUTES } from "../../config/validate.js";
import { MINUTE_MS } from "../budgets.js";
import type { IncomingMessage } from "../types.js";
import type { RunView, RunsService } from "../runsService.js";
import { childRequestText } from "../dispatch/spawn.js";
import { contractFor } from "./briefs.js";
import {
  unitOfIdempotencyKey,
  type CoordinatorInstance,
  type CoordinatorUnit,
  type CoordinatorTag,
} from "./contract.js";
import type { CoordinatorInstanceStore } from "./instanceStore.js";

export class CoordinatorClarificationRefusal extends Error {}

export interface CoordinatorClarification {
  preset: "coding" | "review";
  tag: CoordinatorTag;
  instance: CoordinatorInstance;
  unit: CoordinatorUnit;
  targetText: string;
  remainingMinutes?: number;
}

/** Stored lineage selects the task; the dispatcher still authorizes the new turn. */
export async function coordinatorClarificationFor(input: {
  newest: RunView | undefined;
  msg: IncomingMessage;
  directives: RequestDirectives;
  instances: CoordinatorInstanceStore | undefined;
  now: number;
}): Promise<CoordinatorClarification | undefined> {
  const { newest: run, msg, directives, instances, now } = input;
  if (!run?.finished || run.status !== "completed" || !run.awaitingInput || !run.parentInstanceId) return;
  if (run.agent !== "coding" && run.agent !== "review") return;
  // An explicit change of agent starts independent work, not a unit continuation.
  if (directives.agent !== undefined && directives.agent !== run.agent) return;
  if (run.userId !== msg.userId || run.authenticatedAs !== msg.authenticatedAs)
    throw new CoordinatorClarificationRefusal("Only the original requester can answer this coordinator question.");
  if (!instances || !run.idempotencyKey)
    throw new CoordinatorClarificationRefusal("The coordinator context is unavailable; please retry.");
  const instance = await instances.get(run.parentInstanceId);
  if (
    !instance ||
    instance.userId !== msg.userId ||
    instance.channelId !== msg.channelId ||
    instance.authenticatedAs !== msg.authenticatedAs ||
    instance.postedBy !== msg.postedBy
  )
    throw new CoordinatorClarificationRefusal("The coordinator requester could not be verified.");
  if (!run.idempotencyKey.startsWith(`${instance.id}:`))
    throw new CoordinatorClarificationRefusal("The coordinator round could not be verified.");
  const unitId = unitOfIdempotencyKey(run.idempotencyKey);
  const unit = (await instances.listUnits(instance.id)).find((row) => row.unit === unitId);
  const thread = run.agent === "review" ? (unit?.reviewThread?.threadKey ?? unit?.threadKey) : unit?.threadKey;
  if (!unit || unit.ending || thread !== msg.threadKey)
    throw new CoordinatorClarificationRefusal("This coordinator question no longer belongs to an active unit.");
  const remainingMinutes =
    instance.caps === undefined
      ? undefined
      : Math.floor(instance.caps.maxMinutes - (now - (unit.startedAt ?? instance.createdAt)) / MINUTE_MS);
  if (remainingMinutes !== undefined && remainingMinutes < MIN_BOUNDARY_MINUTES)
    throw new CoordinatorClarificationRefusal(
      "This coordinator's time budget has elapsed; re-issue the task to continue it.",
    );
  if (run.agent === "review" && unit.pr === undefined)
    throw new CoordinatorClarificationRefusal("The coordinator's review target is unavailable; please retry.");
  return {
    preset: run.agent,
    tag: {
      parentInstanceId: instance.id,
      idempotencyKey: run.idempotencyKey,
      ...(instance.base !== undefined ? { base: instance.base } : {}),
    },
    instance,
    unit,
    targetText:
      run.agent === "review"
        ? `https://github.com/${instance.repo}/pull/${unit.pr!.number}`
        : childRequestText({ preset: "coding", repo: instance.repo, ref: unit.branch, prompt: "" }),
    ...(remainingMinutes !== undefined ? { remainingMinutes } : {}),
  };
}

/** Rebuild the unit contract only after fresh agent and repository authorization. */
export async function coordinatorClarificationContract(
  context: CoordinatorClarification,
  deps: { github: Pick<GithubApi, "readFile">; runs: Pick<RunsService, "getRun"> },
) {
  const { instance, unit } = context;
  return contractFor(instance, unit, {
    readRepoFile: async (path, opts) => {
      try {
        const file = await deps.github.readFile(instance.repo, path, instance.base ?? "main", opts);
        return { content: file.content, truncated: file.truncated };
      } catch {
        return undefined;
      }
    },
    readRunFacts: async () => undefined,
    readShipRequest: async () => {
      if (!instance.runId) return undefined;
      const result = await deps.runs.getRun(instance.runId, { include: "messages" });
      if (!result.ok || result.value.userId !== instance.userId) return undefined;
      const input = result.value.events?.find((event) => event.type === "input");
      return input?.type === "input" ? input.text : undefined;
    },
  });
}
