import { MINUTE_MS } from "../core/budgets.js";
import { LIVE_GATE_DEADLINE_MS, servedCommit } from "./liveGate.js";
import type { AppState, HealthRead, Read, RolloutTarget } from "./sandboxLiveGate.js";

/** The facts the bot gate combines after a full Worker + container application deploy. */
export interface BotLiveInput {
  containerApp: string;
  health: HealthRead;
  app: Read<AppState>;
  /** Application state read before the full deploy. */
  before: Read<AppState>;
  /** The container application target printed by wrangler; null means Worker-only. */
  target: RolloutTarget | null;
  expectedCommit: string;
  elapsedMs: number;
}

export type BotLiveDecision =
  { kind: "live"; summary: string } | { kind: "waiting"; reason: string } | { kind: "failed"; reason: string };

const waiting = (reason: string): BotLiveDecision => ({ kind: "waiting", reason });

function judge(input: BotLiveInput): BotLiveDecision {
  if ("error" in input.app)
    return waiting(`container application ${input.containerApp} unreadable: ${input.app.error}`);
  const app = input.app.value;
  let rollout: string;
  if (input.target) {
    if (input.target.image !== null && app.image !== input.target.image)
      return waiting(
        `container application ${input.containerApp} still targets ${app.image ?? "an unknown image"}; expected ${input.target.image}`,
      );
    if ("error" in input.before)
      return waiting(
        `container application ${input.containerApp} pre-deploy version unreadable (${input.before.error}); cannot prove the application version advanced`,
      );
    if (app.version <= input.before.value.version)
      return waiting(
        `container application ${input.containerApp} is still at pre-deploy version ${input.before.value.version}; expected a newer application version`,
      );
    rollout = ` at version ${app.version} (up from ${input.before.value.version})`;
  } else {
    rollout = ` at version ${app.version} (Worker-only deploy; no application change printed)`;
  }

  if ("error" in input.health) return waiting(`health: GET /healthz failed: ${input.health.error}`);
  if (input.health.status !== 200)
    return waiting(
      `health: GET /healthz → HTTP ${input.health.status}; expected the deployed container's exact build identity`,
    );
  if (!input.health.body || input.health.body.ok !== true)
    return waiting("health: /healthz is not ready or did not answer with JSON");
  const commit = servedCommit(input.health.body);
  if (!commit) return waiting("health: /healthz carries no build identity");
  if (commit !== input.expectedCommit)
    return waiting(`health: serving commit ${commit}, expected exact ${input.expectedCommit}`);
  if (input.health.body.draining === true)
    return waiting("health: the exact deployed commit answers but its container is draining");

  const target = input.target?.image ?? app.image ?? "an unchanged image";
  return {
    kind: "live",
    summary: `container application ${input.containerApp} targets ${target}${rollout}; /healthz serves exact ${commit}`,
  };
}

/**
 * A bot upload is live only when the independently managed container application
 * moved to wrangler's target and `/healthz` reports the full expected commit.
 * At the ordinary live deadline, the first missing fact becomes the failure.
 */
export function decideBotLive(input: BotLiveInput, deadlineMs: number = LIVE_GATE_DEADLINE_MS): BotLiveDecision {
  const decision = judge(input);
  if (decision.kind !== "waiting" || input.elapsedMs < deadlineMs) return decision;
  return {
    kind: "failed",
    reason: `${decision.reason} — still not live after ${Math.round(input.elapsedMs / MINUTE_MS)} min (deadline ${deadlineMs / MINUTE_MS} min)`,
  };
}
