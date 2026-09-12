// The ship coordinator as a Workflow (docs/decisions/0029-durable-objects-store-workflows-schedule.md,
// docs/decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md;
// docs/reference/specs/http-ingress.md item 9): the `ShipCoordinator`
// entrypoint the Workflows binding names, declared here and re-exported by
// worker.ts (the binding resolves `class_name` against the entry module, the
// way the resident Worker's refresh cycle is split). `run()` is the plan
// runner's driver (`src/core/coordinator/driver.ts`) over the platform's step
// primitives and one bot client: every step is a `POST /admin/coordinator/<step>`
// into the container, presented with the `coordinator` bearer from the token
// map, and every fact and every child run is the bot's to produce. The instance
// id is the plan's (`plan-<plan-id>`, or the ship record's for a task): the
// bot wrote the instance and its unit rows before it created the instance, and
// the driver's first step reads them back — nothing rides in the params.
//
// What a coordinator may hold is bounded here by type and in coordinator.test.ts
// by a scan: the container binding (its loopback into the bot) and the token
// map (the `coordinator` entry it presents to the bot's steps) — no model,
// Slack or GitHub credential, and no fetch but the container binding's.
import { getContainer } from "@cloudflare/containers";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { COORDINATOR_IDENTITY, COORDINATOR_STEP_PATH_PREFIX } from "../../src/core/coordinator/contract.ts";
import {
  readBotAnswer,
  runPlan,
  type CoordinatorBot,
  type PlanRunSummary,
  type StepRunner,
} from "../../src/core/coordinator/driver.ts";
import { parseIngressTokenMap, tokenForSubject } from "../../src/core/ingressTokens.ts";
import { INSTANCE, INTERNAL } from "./shared";
import type { Env } from "./worker";

/** The env slice a coordinator instance may see. Everything else the shim
 *  holds for the container is out of the coordinator's reach by type. */
export type CoordinatorEnv = Pick<Env, "SWITCHBOARD" | "SWITCHBOARD_INGRESS_TOKENS">;

/** What an instance is created with: nothing the driver reads — the instance
 *  id names the plan, and the bot's rows are the input (the coordinator's
 *  contract: ids only, never a task's text or a thread's contents). */
export type ShipCoordinatorParams = Record<string, unknown>;

/** The bot behind the container binding: the reply as the wire carried it.
 *  The transport's failures throw for the step's retry; the door's own refusal
 *  — a 401/403 the bot did not stamp, a bearer it does not admit — is final,
 *  since no retry changes a token map. */
function containerBot(env: CoordinatorEnv): CoordinatorBot {
  return {
    async step(route, body) {
      const bearer = tokenForSubject(parseIngressTokenMap(env.SWITCHBOARD_INGRESS_TOKENS).tokens, COORDINATOR_IDENTITY);
      if (bearer === undefined)
        throw new NonRetryableError(
          `the token map has no single \`${COORDINATOR_IDENTITY}\` entry — the coordinator cannot present itself to the bot`,
        );
      const res = await getContainer(env.SWITCHBOARD, INSTANCE).fetch(
        new Request(`${INTERNAL}${COORDINATOR_STEP_PATH_PREFIX}${route}`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        const read = readBotAnswer(res.status, text);
        if (!read.ok) throw new NonRetryableError(`the bot refused the coordinator bearer on ${route}: ${read.reason}`);
      }
      return { status: res.status, text };
    },
  };
}

/** The platform's step as the driver types it. Every stored step output is a
 *  bot answer — a JSON object — so the platform's serializable bound holds. */
function workflowSteps(step: WorkflowStep): StepRunner {
  return {
    do: (name, config, callback) => step.do(name, config, callback),
    sleep: (name, ms) => step.sleep(name, ms),
    waitForEvent: (name, options) => step.waitForEvent(name, options),
  };
}

export class ShipCoordinator extends WorkflowEntrypoint<CoordinatorEnv, ShipCoordinatorParams> {
  async run(event: Readonly<WorkflowEvent<ShipCoordinatorParams>>, step: WorkflowStep): Promise<PlanRunSummary> {
    return runPlan(workflowSteps(step), containerBot(this.env), event.instanceId);
  }
}
