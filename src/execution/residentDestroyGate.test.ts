import { describe, expect, it } from "vitest";
import { destroyWithPersistentFence } from "./residentDestroyGate.js";

describe("resident container destruction fence", () => {
  it("marks durable uncertainty before destroy and clears it only after confirmed destruction", async () => {
    const steps: string[] = [];
    let marked = false;
    await destroyWithPersistentFence(
      {
        mark: async () => {
          steps.push("mark");
          marked = true;
        },
        clear: async () => {
          steps.push("clear");
          marked = false;
        },
      },
      async () => {
        steps.push("destroy");
        expect(marked).toBe(true);
      },
    );
    expect(steps).toEqual(["mark", "destroy", "clear"]);
    expect(marked).toBe(false);
  });

  it("retains the durable fence when destroy rejects, so no later reuse is authorized", async () => {
    let marked = false;
    let cleared = false;
    await expect(
      destroyWithPersistentFence(
        {
          mark: async () => {
            marked = true;
          },
          clear: async () => {
            cleared = true;
            marked = false;
          },
        },
        async () => {
          throw new Error("SDK destroy failed");
        },
      ),
    ).rejects.toThrow("SDK destroy failed");
    expect(marked).toBe(true);
    expect(cleared).toBe(false);
  });

  it("does not invoke destroy when the durable mark fails", async () => {
    let destroyed = false;
    await expect(
      destroyWithPersistentFence(
        {
          mark: async () => {
            throw new Error("storage unavailable");
          },
          clear: async () => {},
        },
        async () => {
          destroyed = true;
        },
      ),
    ).rejects.toThrow("storage unavailable");
    expect(destroyed).toBe(false);
  });

  it("keeps refusal in force when clearing the fence fails after destroy", async () => {
    let marked = false;
    await expect(
      destroyWithPersistentFence(
        {
          mark: async () => {
            marked = true;
          },
          clear: async () => {
            throw new Error("clear failed");
          },
        },
        async () => {},
      ),
    ).rejects.toThrow("clear failed");
    expect(marked).toBe(true);
  });
});
