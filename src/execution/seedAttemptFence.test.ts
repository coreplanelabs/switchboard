import { describe, expect, it, vi } from "vitest";
import { guardSeedMutation, guardedSeedAttempt, SEED_ATTEMPT_KEY, waitForPendingRestores } from "./seedAttemptFence.js";
import type { SeedAnswer } from "./seedPlan.js";
import { RootProcessOutcomeUnknownError, rootProcessOutput } from "./sandboxRootProcess.js";

function durableReservation() {
  const records = new Map<string, string>();
  const next = () => ({
    reserve: vi.fn(async () => {
      if (records.has(SEED_ATTEMPT_KEY)) return false;
      records.set(SEED_ATTEMPT_KEY, "pending");
      return true;
    }),
    release: vi.fn(async () => {
      records.delete(SEED_ATTEMPT_KEY);
    }),
  });
  return { records, next };
}

const failed: SeedAnswer = { seeded: false, reason: "seed-failed", detail: "fixup exited 1" };
const uncertain: SeedAnswer = { seeded: false, reason: "seed-uncertain", detail: "process output did not complete" };
const seeded: SeedAnswer = {
  seeded: true,
  cached: false,
  slug: "acme/widgets",
  ref: "main",
  sha: "a".repeat(40),
  from: { ref: "main", sha: "a".repeat(40), checkoutBackupId: "backup-id" },
  steps: { restore: 1, deps: null, fixup: 1 },
  ms: 2,
};

describe("durable seed attempt fence", () => {
  it("refuses later workspace mutations after an uncertain seed, including when storage cannot answer", async () => {
    const store = durableReservation();
    const first = store.next();
    expect(await guardedSeedAttempt(first.reserve, first.release, async () => uncertain)).toEqual(uncertain);

    const mutate = vi.fn(async () => ({ ok: true as const }));
    const refusal = { error: "saved workspace setup has an unknown outcome", status: 409 };
    expect(
      await guardSeedMutation(() => Promise.resolve(store.records.get(SEED_ATTEMPT_KEY)), refusal, mutate),
    ).toEqual(refusal);
    expect(await guardSeedMutation(() => Promise.reject(new Error("storage unavailable")), refusal, mutate)).toEqual(
      refusal,
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(store.records.get(SEED_ATTEMPT_KEY)).toBe("pending");

    store.records.delete(SEED_ATTEMPT_KEY);
    expect(
      await guardSeedMutation(() => Promise.resolve(store.records.get(SEED_ATTEMPT_KEY)), refusal, mutate),
    ).toEqual({
      ok: true,
    });
  });

  it("keeps the workspace and refuses a later seed after a non-timeout output error", async () => {
    const transportError = new Error("output transport unavailable");
    const process = {
      output: vi.fn(async () => {
        throw transportError;
      }),
      status: vi.fn(async () => ({ state: "running" })),
      kill: vi.fn(async (_signal: number) => {}),
    };
    const cleanup = vi.fn(async () => failed);
    const store = durableReservation();
    const first = store.next();
    const answer = await guardedSeedAttempt(first.reserve, first.release, async () => {
      try {
        await rootProcessOutput(process, 200_000);
      } catch (error) {
        if (error instanceof RootProcessOutcomeUnknownError) return uncertain;
      }
      return cleanup();
    });
    expect(answer).toEqual(uncertain);
    expect(cleanup).not.toHaveBeenCalled();
    expect(store.records.get(SEED_ATTEMPT_KEY)).toBe("pending");
    const laterSeed = vi.fn(async () => failed);
    const later = store.next();
    expect(await guardedSeedAttempt(later.reserve, later.release, laterSeed)).toEqual({
      seeded: false,
      reason: "seed-uncertain",
      detail: "an earlier seed attempt has no verified completion",
    });
    expect(laterSeed).not.toHaveBeenCalled();
  });

  it("keeps the reservation and refuses another sweep while a restore remains active after cleanup waits", async () => {
    vi.useFakeTimers();
    let finishRestore: () => void = () => {};
    const restore = new Promise<void>((resolve) => {
      finishRestore = resolve;
    });
    const pending = new Set<Promise<unknown>>([restore]);
    restore.then(() => pending.delete(restore));
    const store = durableReservation();
    const cleanup = vi.fn(async () => failed);
    try {
      const first = store.next();
      const attempt = guardedSeedAttempt(first.reserve, first.release, async () => {
        if (!(await waitForPendingRestores(pending, 100))) return uncertain;
        return cleanup();
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(await attempt).toEqual(uncertain);
      expect(cleanup).not.toHaveBeenCalled();
      expect(store.records.get(SEED_ATTEMPT_KEY)).toBe("pending");

      const next = store.next();
      const sweep = vi.fn(async () => failed);
      expect(await guardedSeedAttempt(next.reserve, next.release, sweep)).toEqual({
        seeded: false,
        reason: "seed-uncertain",
        detail: "an earlier seed attempt has no verified completion",
      });
      expect(sweep).not.toHaveBeenCalled();
    } finally {
      finishRestore();
      vi.useRealTimers();
    }
  });

  it("allows cleanup after the restore promise settles", async () => {
    const restore = Promise.resolve();
    const pending = new Set<Promise<unknown>>([restore]);
    restore.then(() => pending.delete(restore));
    expect(await waitForPendingRestores(pending, 100)).toBe(true);
  });

  it("refuses a later same-object seed after an uncertain answer, including after a new handler instance", async () => {
    const store = durableReservation();
    const first = store.next();
    expect(await guardedSeedAttempt(first.reserve, first.release, async () => uncertain)).toEqual(uncertain);
    expect(store.records.get(SEED_ATTEMPT_KEY)).toBe("pending");
    expect(first.release).not.toHaveBeenCalled();

    const afterRestart = store.next();
    const sweep = vi.fn(async () => failed);
    expect(await guardedSeedAttempt(afterRestart.reserve, afterRestart.release, sweep)).toEqual({
      seeded: false,
      reason: "seed-uncertain",
      detail: "an earlier seed attempt has no verified completion",
    });
    expect(sweep).not.toHaveBeenCalled();
  });

  it("keeps the reservation when the seed throws without a verified result", async () => {
    const store = durableReservation();
    const permit = store.next();
    expect(
      await guardedSeedAttempt(permit.reserve, permit.release, async () => {
        throw new Error("output lost");
      }),
    ).toEqual({ seeded: false, reason: "seed-uncertain", detail: "seed attempt returned no verified outcome" });
    expect(store.records.get(SEED_ATTEMPT_KEY)).toBe("pending");
    expect(permit.release).not.toHaveBeenCalled();
  });

  it("refuses before running a seed when the durable reservation cannot be read", async () => {
    const run = vi.fn(async () => failed);
    expect(
      await guardedSeedAttempt(
        async () => {
          throw new Error("storage unavailable");
        },
        async () => {},
        run,
      ),
    ).toEqual({
      seeded: false,
      reason: "seed-uncertain",
      detail: "an earlier seed attempt has no verified completion",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("releases a completed ordinary failure so another seed may start", async () => {
    const store = durableReservation();
    const first = store.next();
    expect(await guardedSeedAttempt(first.reserve, first.release, async () => failed)).toEqual(failed);
    expect(store.records.has(SEED_ATTEMPT_KEY)).toBe(false);
    const retry = vi.fn(async () => failed);
    const second = store.next();
    expect(await guardedSeedAttempt(second.reserve, second.release, retry)).toEqual(failed);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("releases a completed seed after its result is ready", async () => {
    const store = durableReservation();
    const permit = store.next();
    expect(await guardedSeedAttempt(permit.reserve, permit.release, async () => seeded)).toEqual(seeded);
    expect(store.records.has(SEED_ATTEMPT_KEY)).toBe(false);
  });

  it("retains an uncertain result when recording completion fails", async () => {
    const store = durableReservation();
    const permit = store.next();
    permit.release.mockRejectedValue(new Error("storage unavailable"));
    expect(await guardedSeedAttempt(permit.reserve, permit.release, async () => failed)).toEqual({
      seeded: false,
      reason: "seed-uncertain",
      detail: "seed attempt completion could not be recorded",
    });
    expect(store.records.get(SEED_ATTEMPT_KEY)).toBe("pending");
  });
});
