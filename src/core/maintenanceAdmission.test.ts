import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../config.js";
import { InMemoryRunStore } from "./runStore.js";
import { RunRegistry } from "./runRegistry.js";
import { createRunHistoryWriter } from "./runHistoryWriter.js";
import { NullLedgerWriteThrough } from "./runLedger/writeThrough.js";
import type { SpanRecord } from "./trace/types.js";
import { buildCoreCommands } from "./commandCatalogue.js";
import { secretsFrom } from "../secrets.js";
import { dispatch, activeRunCount, type CoreDeps } from "./dispatcher.js";
import type { IncomingMessage } from "./types.js";
import { SingleShotIO } from "../channels/singleShotDispatch.js";
import {
  InMemoryMaintenanceStore,
  MaintenanceService,
  MAINTENANCE_UNAVAILABLE,
  type MaintenanceStore,
  maintenanceGate,
} from "./maintenance.js";

function core(maintenance: MaintenanceStore, mode = "on") {
  const dataDir = mkdtempSync(join(tmpdir(), "maintenance-dispatch-"));
  const path = join(dataDir, "config.yaml");
  writeFileSync(
    path,
    `organization: acme\nproviders:\n  anthropic: { type: anthropic, apiKeyEnv: UNSET_TEST_KEY }\ndefaults:\n  agent: general\n  models: { general: anthropic/model }\nrouting: { operator: ${mode} }\ngrants:\n  "slack:UOPS": { actions: all, channels: all, repos: all }\n`,
  );
  const config = new ConfigStore(path, join(dataDir, "overrides.json"));
  const store = new InMemoryRunStore();
  const registry = new RunRegistry();
  const writer = createRunHistoryWriter({ store, warn: () => {} });
  const service = new MaintenanceService({ store: maintenance });
  const spans: SpanRecord[] = [];
  const commands = buildCoreCommands(config, store, {
    registry,
    dataDir,
    secrets: secretsFrom({}),
    warn: () => {},
    audit: () => {},
    maintenance: { store: maintenance, service },
  });
  return {
    deps: {
      config,
      maintenance,
      commands,
      sinks: [
        {
          onEnd: (span: SpanRecord) => {
            spans.push(span);
          },
        },
      ],
      runStore: store,
      runLedger: new NullLedgerWriteThrough("maintenance-test", store),
      runRegistry: registry,
      runHistoryWriter: writer,
      dataDir,
      completions: {
        get: () => {
          throw new Error("Maintenance must not reach a provider.");
        },
      },
    } as unknown as CoreDeps,
    store,
    writer,
    spans,
  };
}

describe("maintenance request boundaries", () => {
  it("counts the durable admission read in flight from entry and releases a refused request", async () => {
    const state = new InMemoryMaintenanceStore();
    await new MaintenanceService({ store: state }).start({ scopes: ["all"] }, "cli:local");
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store: MaintenanceStore = {
      read: async () => {
        await wait;
        return state.read();
      },
      write: (...args) => state.write(...args),
    };
    const io = new SingleShotIO();
    const fixture = core(store);
    const pending = dispatch(
      fixture.deps,
      { text: "Review the PR", channelId: "mcp:client", userId: "mcp:person", threadKey: "mcp:client:1" },
      io,
    );
    expect(activeRunCount()).toBe(1);
    release();
    const outcome = await pending;
    expect(outcome, io.collected()).toMatchObject({ status: "refused", refusal: "maintenance" });
    expect(activeRunCount()).toBe(0);
    expect(io.collected()).toBe("Down for maintenance. You cannot use Switchboard agents or web pages.");
  });
  it("refuses every dispatcher surface and child input before any model or executor is needed", async () => {
    const store = new InMemoryMaintenanceStore();
    await new MaintenanceService({ store }).start({ scopes: ["residents"] }, "cli:local");
    for (const channel of ["slack:COPS", "mcp:client", "http:client", "access:person", "cli:local"]) {
      const io = new SingleShotIO();
      const fixture = core(store);
      const outcome = await dispatch(
        fixture.deps,
        {
          text: "Review this pull request",
          channelId: channel,
          userId: "user",
          threadKey: `${channel}:1`,
        } as IncomingMessage,
        io,
      );
      expect(outcome).toEqual({ status: "refused", refusal: "maintenance", cause: "system" });
      expect(io.collected()).toBe(
        "Down for maintenance. You cannot start or continue agent work or run repository tests and builds.",
      );
    }
  });

  it("fails closed on an unreadable store and keeps health and recovery transport available", async () => {
    const store: MaintenanceStore = {
      read: async () => {
        throw new Error("unavailable");
      },
      write: async () => {
        throw new Error("unavailable");
      },
    };
    const io = new SingleShotIO();
    const fixture = core(store);
    expect(
      await dispatch(
        fixture.deps,
        { text: "Review the PR", channelId: "mcp:client", userId: "mcp:person", threadKey: "mcp:client:1" },
        io,
      ),
    ).toMatchObject({ status: "refused", refusal: "maintenance" });
    expect(io.collected()).toBe(MAINTENANCE_UNAVAILABLE);
    const edge = await maintenanceGate(new Request("https://example.com/unknown"), store);
    expect(edge?.status).toBe(503);
    expect(await edge?.json()).toEqual({ error: "maintenance_unavailable", message: MAINTENANCE_UNAVAILABLE });
    expect(await maintenanceGate(new Request("https://example.com/healthz"), store)).toBeUndefined();
    expect(await maintenanceGate(new Request("https://example.com/mcp"), store)).toBeUndefined();
    expect(await maintenanceGate(new Request("https://example.com/settings/approve"), store)).toBeUndefined();
  });
  it.each(["on", "shadow", "off"])(
    "keeps command-like input on the deterministic path with routing %s",
    async (mode) => {
      const maintenance = new InMemoryMaintenanceStore();
      await new MaintenanceService({ store: maintenance }).start({ scopes: ["all"] }, "cli:local");
      const fixture = core(maintenance, mode);
      for (const text of [
        "repo list\nThen review https://github.com/acme/api/pull/12",
        "runs list --statuz all",
        "status show",
      ]) {
        const io = new SingleShotIO();
        const outcome = await dispatch(
          fixture.deps,
          { text, userId: "slack:UOPS", channelId: "slack:COPS", threadKey: "slack:COPS:1" },
          io,
        );
        expect(outcome.status).toBe("completed");
        expect(io.collected()).toMatch(/takes no arguments|unknown option|Switchboard/);
      }
      const io = new SingleShotIO();
      expect(
        await dispatch(
          fixture.deps,
          {
            text: "confirm ------------------------------------",
            userId: "slack:UOPS",
            channelId: "slack:COPS",
            threadKey: "slack:COPS:1",
          },
          io,
        ),
      ).toMatchObject({ status: "refused", refusal: "maintenance" });
      expect(io.collected()).toContain("Down for maintenance");
    },
  );
  it("persists the maintenance reason and system cause in the refusal record", async () => {
    const maintenance = new InMemoryMaintenanceStore();
    await new MaintenanceService({ store: maintenance }).start({ scopes: ["agents"] }, "cli:local");
    const fixture = core(maintenance);
    const io = new SingleShotIO();
    expect(
      await dispatch(
        fixture.deps,
        { text: "Review the PR", userId: "slack:UOPS", channelId: "slack:COPS", threadKey: "slack:COPS:1" },
        io,
      ),
    ).toMatchObject({ status: "refused", refusal: "maintenance", cause: "system" });
    await fixture.writer.settled();
    const records = await fixture.store.list({ limit: 10 });
    expect(records).toHaveLength(1);
    const record = await fixture.store.get(records[0].id);
    expect(record?.events).toContainEqual(
      expect.objectContaining({ type: "refusal", code: "maintenance", cause: "system" }),
    );
    expect(fixture.spans).toContainEqual(
      expect.objectContaining({
        name: "dispatch.refuse",
        attrs: expect.objectContaining({ refusal: "maintenance", cause: "system" }),
      }),
    );
  });
});
