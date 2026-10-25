import type { SeedAnswer } from "./seedPlan.js";

export const SEED_ATTEMPT_KEY = "switchboard.seedAttempt.pending";

export async function waitForPendingRestores(pending: Set<Promise<unknown>>, maxMs: number): Promise<boolean> {
  if (pending.size === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, maxMs);
  });
  try {
    await Promise.race([Promise.allSettled([...pending]), deadline]);
  } finally {
    clearTimeout(timer);
  }
  return pending.size === 0;
}

export function pendingSeedAttemptAnswer(): SeedAnswer {
  return {
    seeded: false,
    reason: "seed-uncertain",
    detail: "an earlier seed attempt has no verified completion",
  };
}

export async function guardSeedMutation<T, R>(
  read: () => Promise<unknown>,
  refusal: R,
  mutate: () => Promise<T>,
): Promise<T | R> {
  try {
    if ((await read()) !== undefined) return refusal;
  } catch {
    return refusal;
  }
  return mutate();
}

export async function guardedSeedAttempt(
  reserve: () => Promise<boolean>,
  release: () => Promise<unknown>,
  run: () => Promise<SeedAnswer>,
): Promise<SeedAnswer> {
  let reserved: boolean;
  try {
    reserved = await reserve();
  } catch {
    return pendingSeedAttemptAnswer();
  }
  if (!reserved) return pendingSeedAttemptAnswer();

  let answer: SeedAnswer;
  try {
    answer = await run();
  } catch {
    return {
      seeded: false,
      reason: "seed-uncertain",
      detail: "seed attempt returned no verified outcome",
    };
  }

  if (!answer.seeded && answer.reason === "seed-uncertain") return answer;
  try {
    await release();
  } catch {
    return {
      seeded: false,
      reason: "seed-uncertain",
      detail: "seed attempt completion could not be recorded",
    };
  }
  return answer;
}
