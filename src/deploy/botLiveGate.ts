import { MINUTE_MS } from "../core/budgets.js";
import { LIVE_GATE_DEADLINE_MS, servedCommit } from "./liveGate.js";
import type { AppState, HealthRead, Read, ContainerInstance } from "./sandboxLiveGate.js";

/** The facts the bot gate combines after a full Worker + container application deploy. */
export interface BotLiveInput {
  containerApp: string;
  health: HealthRead;
  app: Read<AppState>;
  /** Exact release image from the plan; null for a locally built image. */
  expectedImage: string | null;
  instances: Read<ContainerInstance[]>;
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
  if (!app.image || !Number.isSafeInteger(app.version) || app.version < 0)
    return waiting(`container application ${input.containerApp} has incomplete image/version evidence`);
  if (input.expectedImage !== null && app.image !== input.expectedImage)
    return waiting(
      `container application ${input.containerApp} still targets ${app.image}; expected ${input.expectedImage}`,
    );
  if ("error" in input.instances)
    return waiting(`container instances ${input.containerApp} unreadable: ${input.instances.error}`);
  if (
    input.instances.value.some(
      (instance) =>
        !["running", "stopped", "stopping", "failed", "provisioning", "unhealthy", "inactive"].includes(
          instance.state.toLowerCase(),
        ),
    )
  )
    return waiting(`container application ${input.containerApp} has an instance with unknown state`);
  const running = input.instances.value.filter((instance) => instance.state.toLowerCase() === "running");
  const singleton = input.instances.value.filter((instance) => instance.name === "singleton");
  if (singleton.length !== 1)
    return waiting(`container application ${input.containerApp} has no unique singleton identity`);
  // Durable Object placement may still say stopped or inactive while the
  // singleton serves traffic. Its own health proves process uptake; the
  // inventory can still contradict that proof with a competing live instance.
  if (
    running.length > 1 ||
    running.some((instance) => instance.name !== "singleton" || instance.version !== app.version)
  )
    return waiting(
      `container application ${input.containerApp} singleton is not the only running instance on version ${app.version}`,
    );

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

  const target = app.image;
  return {
    kind: "live",
    summary: `container application ${input.containerApp} targets ${target} at version ${app.version}; singleton /healthz serves exact ${commit}`,
  };
}

/**
 * A bot upload is live only when the independently managed container application
 * targets the selected release image and singleton health reports the full expected commit.
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
