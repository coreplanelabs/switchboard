import { SettlementRefused, type StepRunner } from "./driver.js";

/** Convert inside the durable callback, where the platform applies its retry policy. */
export function workflowSteps(step: StepRunner, permanentError: (message: string) => Error): StepRunner {
  return {
    do: (name, config, callback) =>
      step.do(name, config, async () => {
        try {
          return await callback();
        } catch (error) {
          if (error instanceof SettlementRefused) throw permanentError(error.message);
          throw error;
        }
      }),
    sleep: (name, ms) => step.sleep(name, ms),
    waitForEvent: (name, options) => step.waitForEvent(name, options),
  };
}
