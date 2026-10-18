import { describe, expect, it } from "vitest";
import {
  initializeStaging,
  nativeInventoryRows,
  initialMemoryConfig,
  hasFullMemoryBindings,
  type BootstrapIO,
} from "./stagingBootstrap.js";

const commit = "1".repeat(40);
function fixture() {
  const state = { workers: [] as string[], publication: false, ready: [] as string[] };
  const io: BootstrapIO = {
    absent: async (workers) => {
      for (const worker of workers)
        if (state.workers.includes(worker) || (worker === "memory" && state.workers.includes("memory-provisional")))
          throw new Error(`${worker} already exists`);
    },
    upload: async (worker, provisional) => {
      state.workers.push(provisional ? "memory-provisional" : worker);
    },
    provision: async () => {},
    restartBot: async () => {},
    verify: async (worker) => {
      state.ready.push(worker);
    },
    prepare: async () => ({
      key: "owned-slot",
      priorVersion: 0,
      legacyVersion: 0,
      send: async () => {
        state.publication = true;
      },
    }),
    admission: async () => {},
  };
  return { io, state };
}

describe("staging first installation", () => {
  it("restores closed access and repository settings before any Bot can start", async () => {
    const { io } = fixture();
    const restored = { maintenance: "missing", repositories: [] as string[] };
    const upload = io.upload;
    io.upload = async (worker, provisional) => {
      if (worker === "bot" && (restored.maintenance !== "active" || restored.repositories[0] !== "acme/api"))
        throw new Error("Bot would start without restored settings");
      await upload(worker, provisional);
    };
    io.restoreSettings = async () => {
      restored.maintenance = "active";
    };
    io.restoreRepositories = async () => {
      restored.repositories = ["acme/api"];
    };
    expect(await initializeStaging(commit, io)).toEqual({ commit, status: "installed" });
    expect(restored).toEqual({ maintenance: "active", repositories: ["acme/api"] });
  });

  it("creates a fresh stack, then replaces provisional Memory and proves all four Workers", async () => {
    const { io, state } = fixture();
    expect(await initializeStaging(commit, io)).toEqual({ commit, status: "installed" });
    expect(state).toEqual({
      workers: ["memory-provisional", "resident", "sandbox", "bot", "memory"],
      publication: true,
      ready: ["memory", "resident", "sandbox", "bot", "memory"],
    });
  });

  it("refuses an installed or unreadable stack without publishing configuration", async () => {
    const { io, state } = fixture();
    state.workers.push("bot");
    await expect(initializeStaging(commit, io)).rejects.toThrow("bot already exists");
    expect(state).toEqual({ workers: ["bot"], publication: false, ready: [] });
    io.absent = async () => {
      throw new Error("inventory incomplete");
    };
    await expect(initializeStaging(commit, io)).rejects.toThrow("inventory incomplete");
  });

  it("refuses nonempty config slots before creating the Bot", async () => {
    const { io, state } = fixture();
    io.prepare = async () => ({
      key: "owned-slot",
      priorVersion: 0,
      legacyVersion: 1,
      send: async () => {
        state.publication = true;
      },
    });
    await expect(initializeStaging(commit, io)).rejects.toThrow(
      "initial configuration requires empty legacy and owned slots",
    );
    expect(state.publication).toBe(false);
    expect(state.workers).toEqual(["memory-provisional", "resident", "sandbox"]);
  });

  it("rechecks native absence after preparation and stops on an unknown publication acknowledgment", async () => {
    const { io, state } = fixture();
    io.prepare = async () => {
      state.workers.push("bot");
      return {
        key: "owned-slot",
        priorVersion: 0,
        legacyVersion: 0,
        send: async () => {
          state.publication = true;
        },
      };
    };
    await expect(initializeStaging(commit, io)).rejects.toThrow("bot already exists");
    expect(state.publication).toBe(false);
    const second = fixture();
    second.io.prepare = async () => ({
      key: "owned-slot",
      priorVersion: 0,
      legacyVersion: 0,
      send: async () => {
        throw new Error("publication acknowledgment unknown");
      },
    });
    await expect(initializeStaging(commit, second.io)).rejects.toThrow("publication acknowledgment unknown");
    expect(second.state.workers).toEqual(["memory-provisional", "resident", "sandbox"]);
  });
});

describe("initialization provider evidence", () => {
  it("accepts a complete inventory and rejects truncation, unknown cursors and malformed rows", () => {
    expect(
      nativeInventoryRows({
        success: true,
        result: [{ name: "another-application" }],
        result_info: { page: 1, total_count: 1 },
      }),
    ).toEqual([{ name: "another-application" }]);
    for (const value of [
      { success: false, result: [] },
      { success: true, result: [{ name: "another-application" }], result_info: { total_count: 2 } },
      { success: true, result: [], result_info: { cursor: "more" } },
      { success: true, result: [null] },
    ])
      expect(() => nativeInventoryRows(value)).toThrow(/native inventory/);
  });

  it("omits only the unavailable Bot bindings from the provisional Memory render", () => {
    expect(
      JSON.parse(
        initialMemoryConfig(
          '{"name":"stage-memory","durable_objects":{"bindings":[{"name":"CONFIG","class_name":"ConfigDO"}]},"services":[{"service":"stage-bot"}],"workflows":[{"script_name":"stage-bot"}],"vars":{"KEY":"https://memory.example.test"}}',
        ),
      ),
    ).toEqual({
      name: "stage-memory",
      durable_objects: { bindings: [{ name: "CONFIG", class_name: "ConfigDO" }] },
      vars: { KEY: "https://memory.example.test" },
    });
  });
});

describe("final state bindings", () => {
  it("requires one service and Workflow on the selected Bot, rejecting a provisional or misrouted state Worker", () => {
    const bindings = [
      { name: "BOT", type: "service", service: "stage-bot" },
      {
        name: "SHIP_COORDINATOR",
        type: "workflow",
        workflow_name: "stage-bot-ship-coordinator",
        script_name: "stage-bot",
      },
    ];
    expect(hasFullMemoryBindings(bindings, "stage-bot")).toBe(true);
    expect(hasFullMemoryBindings([], "stage-bot")).toBe(false);
    expect(hasFullMemoryBindings(bindings, "other-bot")).toBe(false);
    expect(hasFullMemoryBindings([...bindings, bindings[0]], "stage-bot")).toBe(false);
  });
});

describe("first Bot secret activation", () => {
  it("restarts an early config-refusal process with provisioned secrets before declaring readiness", async () => {
    const f = fixture();
    let process = "absent";
    let provisioned = false;
    const io = {
      ...f.io,
      upload: async (worker, provisional) => {
        await f.io.upload(worker, provisional);
        if (worker === "bot") process = "config-refusal";
      },
      provision: async (worker) => {
        if (worker === "bot") provisioned = true;
      },
      restartBot: async () => {
        if (!provisioned) throw new Error("secrets not installed");
        process = "ready";
      },
      verify: async (worker) => {
        if (worker === "bot" && process !== "ready") throw new Error("Bot is stuck on early config refusal");
        await f.io.verify(worker);
      },
    } satisfies BootstrapIO;
    expect(await initializeStaging(commit, io)).toEqual({ status: "installed", commit });
    expect(process).toBe("ready");
  });
});

describe("recorded provisional Memory continuation", () => {
  it("continues after an owned Memory receipt without replaying its creation or secret provisioning", async () => {
    const f = fixture();
    f.state.workers.push("memory-provisional");
    let checked = false;
    const io: BootstrapIO = {
      ...f.io,
      resume: {
        workers: ["memory"],
        verify: async () => {
          checked = true;
        },
      },
    };
    expect(await initializeStaging(commit, io)).toEqual({ status: "installed", commit });
    expect(checked).toBe(true);
    expect(f.state.workers).toEqual(["memory-provisional", "resident", "sandbox", "bot", "memory"]);
  });
});

describe("recorded executor continuation", () => {
  it("finishes an inspected partial installation without recreating or reprovisioning its executors", async () => {
    const f = fixture();
    f.state.workers.push("memory-provisional", "resident", "sandbox");
    let inspected = false;
    const io: BootstrapIO = {
      ...f.io,
      resume: {
        workers: ["memory", "resident", "sandbox"],
        verify: async () => {
          inspected = true;
        },
      },
      provision: async (worker) => {
        if (worker !== "bot") throw new Error("completed provisioning repeated");
      },
    };
    expect(await initializeStaging(commit, io)).toEqual({ status: "installed", commit });
    expect({ inspected, ...f.state }).toEqual({
      inspected: true,
      workers: ["memory-provisional", "resident", "sandbox", "bot", "memory"],
      publication: true,
      ready: ["memory", "resident", "sandbox", "bot", "memory"],
    });
  });

  it("keeps the partial installation unchanged when executor ownership cannot be verified", async () => {
    const f = fixture();
    f.state.workers.push("memory-provisional", "resident", "sandbox");
    const io: BootstrapIO = {
      ...f.io,
      resume: {
        workers: ["memory", "resident", "sandbox"],
        verify: async () => {
          throw new Error("executor receipt changed");
        },
      },
    };
    await expect(initializeStaging(commit, io)).rejects.toThrow("executor receipt changed");
    expect(f.state).toEqual({ workers: ["memory-provisional", "resident", "sandbox"], publication: false, ready: [] });
  });
});

describe("initialization checkpoint order", () => {
  it("refuses a missing, skipped or post-publication checkpoint before any mutation", async () => {
    for (const workers of [
      [],
      ["resident"],
      ["memory", "sandbox"],
      ["memory", "resident", "sandbox", "bot"],
    ] as const) {
      const f = fixture();
      await expect(initializeStaging(commit, { ...f.io, resume: { workers, verify: async () => {} } })).rejects.toThrow(
        "initialization checkpoint is not a completed creation prefix",
      );
      expect(f.state).toEqual({ workers: [], publication: false, ready: [] });
    }
  });
});
