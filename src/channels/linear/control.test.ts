import { describe, expect, it, vi } from "vitest";
import { stopLinearSession } from "./control.js";
import { RunRegistry } from "../../core/runRegistry.js";
import { createRunsService } from "../../core/runsService.js";
import { ALL_GRANTS } from "../../core/authz/grants.js";
import { NO_GRANTS } from "../../core/authz/types.js";
import { NullRunStore } from "../../core/runStore.js";
import { nullChannelIO } from "../../core/nullChannelIo.js";

describe("Linear stop authorization", () => {
  it("requires the policy's write permission and scopes control to the signed session and arrival", async () => {
    const registry = new RunRegistry({ now: () => 100 });
    const run = registry.create(undefined, {
      threadKey: "linear:org:s",
      channelId: "linear:org:team",
      userId: "linear:org:alice",
    });
    const other = registry.create(undefined, {
      threadKey: "linear:org:other",
      channelId: "linear:org:team",
      userId: "linear:org:alice",
    });
    const runs = createRunsService({ registry, store: new NullRunStore() });
    const input = {
      kind: "stop" as const,
      threadKey: "linear:org:s",
      channelId: "linear:org:team",
      userId: "linear:org:alice",
      receivedAt: 101,
    };
    const io = { ...nullChannelIO("test"), reply: vi.fn(async () => {}) };
    await stopLinearSession({ runs, config: { grantsFor: () => NO_GRANTS } }, input, io);
    expect(run.control.requested).toBeUndefined();
    await stopLinearSession({ runs, config: { grantsFor: () => ALL_GRANTS } }, { ...input, receivedAt: 99 }, io);
    expect(run.control.requested).toBeUndefined();
    await stopLinearSession({ runs, config: { grantsFor: () => ALL_GRANTS } }, input, io);
    expect(run.control.requested).toBe("hard");
    expect(other.control.requested).toBeUndefined();
  });
});
