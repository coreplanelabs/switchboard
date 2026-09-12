// The ship coordinator as a Workflow (docs/decisions/0029-durable-objects-store-workflows-schedule.md,
// docs/decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md;
// docs/reference/specs/http-ingress.md item 9): the `ShipCoordinator`
// entrypoint the Workflows binding names, declared here and re-exported by
// worker.ts (the binding resolves `class_name` against the entry module, the
// way the resident Worker's refresh cycle is split). This unit ships the class
// so the Workflow EXISTS — the state Worker's cross-script binding to it and
// the bot's instance creation both need a deployed class to point at, and the
// state Worker deploys before the bot — and its steps are the next unit's:
// `run()` records that it was invoked and nothing more.
//
// What a coordinator may hold is bounded here by type and in coordinator.test.ts
// by a scan: the container binding (its loopback into the bot) and the token
// map (the `coordinator` entry it presents to the bot's steps) — no model,
// Slack or GitHub credential. Every GitHub fact and every child run is the
// bot's to produce, behind `POST /admin/coordinator/*`.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./worker";

/** The env slice a coordinator instance may see. Everything else the shim
 *  holds for the container is out of the coordinator's reach by type. */
export type CoordinatorEnv = Pick<Env, "SWITCHBOARD" | "SWITCHBOARD_INGRESS_TOKENS">;

/** What an instance is created with. Ids only, never a task's text or a
 *  thread's contents (the coordinator's contract); the runner that walks a
 *  plan's unit graph types the fields when it fills `run()`. */
export type ShipCoordinatorParams = Record<string, unknown>;

/** What an instance returns while it has no steps: that it ran, when, and that no step was taken. */
export interface ShipCoordinatorSummary {
  instance: string;
  invokedAt: number;
  steps: 0;
}

export class ShipCoordinator extends WorkflowEntrypoint<CoordinatorEnv, ShipCoordinatorParams> {
  async run(
    event: Readonly<WorkflowEvent<ShipCoordinatorParams>>,
    step: WorkflowStep,
  ): Promise<ShipCoordinatorSummary> {
    return step.do("invoked", async () => ({
      instance: event.instanceId,
      invokedAt: event.timestamp.getTime(),
      steps: 0,
    }));
  }
}
