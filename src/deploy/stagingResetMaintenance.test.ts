import { describe, expect, it } from "vitest";
import { InMemoryMaintenanceStore } from "../core/maintenance.js";
import { withStagingResetMaintenance } from "./stagingResetMaintenance.js";

describe("staging reset maintenance ownership", () => {
  it("reopens access after a failed preview and propagates the original failure", async () => {
    const store = new InMemoryMaintenanceStore();
    const failure = new Error("routing preview refused");
    await expect(
      withStagingResetMaintenance(store, "reset-controller:test", async () => {
        expect((await store.read()).episode?.phase).toBe("active");
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect((await store.read()).episode).toMatchObject({ phase: "ended", actor: "reset-controller:test" });
  });

  it("retains maintenance after an attempted apply with an unknown outcome", async () => {
    const store = new InMemoryMaintenanceStore();
    const failure = new Error("original reset response lost");
    let attempts = 0;
    await expect(
      withStagingResetMaintenance(store, "reset-controller:test", async ({ apply }) => {
        apply(() => {
          attempts++;
          throw failure;
        });
      }),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect((await store.read()).episode).toMatchObject({ phase: "active", actor: "reset-controller:test" });
  });

  it("ends its own hold after verified reset checks complete", async () => {
    const store = new InMemoryMaintenanceStore();
    expect(
      await withStagingResetMaintenance(store, "reset-controller:test", async ({ apply }) => {
        apply(() => {});
        return "verified";
      }),
    ).toBe("verified");
    expect((await store.read()).episode?.phase).toBe("ended");
  });

  it("preserves another operator's changed hold and retains both failures", async () => {
    const store = new InMemoryMaintenanceStore();
    const failure = new Error("fixture write failed");
    const result = withStagingResetMaintenance(store, "reset-controller:test", async () => {
      const state = await store.read();
      await store.write(state.version, { episode: { ...state.episode!, actor: "another-operator" } });
      throw failure;
    });
    await expect(result).rejects.toMatchObject({ errors: [failure, expect.any(Error)] });
    expect((await store.read()).episode).toMatchObject({ phase: "active", actor: "another-operator" });
  });
});
