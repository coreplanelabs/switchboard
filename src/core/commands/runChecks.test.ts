import { describe, expect, it, vi } from "vitest";
import { CLI_ACTOR } from "../authz/actor.js";
import type { CheckSource, CheckInspection, CheckSelector } from "../checkInspection.js";
import { CommandRegistry, type Caller } from "../commandRegistry.js";
import { analyzeRunFriction } from "../runFriction.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import type { RunRecord } from "../runRecord.js";
import { RunRegistry } from "../runRegistry.js";
import { InMemoryRunStore } from "../runStore.js";
import { createRunsService } from "../runsService.js";
import { preapprovedCaller } from "../testing/callers.js";
import { unwrapUntrusted } from "../untrusted.js";
import { registerRunsCommands, type RunsCommandDeps } from "./runs.js";

// Feature: docs/reference/specs/run-history.md — original check inspection and settlement.
const NOW = 1_700_000_000_000;
const selector = { runId: "check-run", callId: "call-1", phase: "command" as const };
const result = { stdout: "1 test failed", stderr: "assertion failed", exitCode: 1, truncated: false };
const cli: Caller = { kind: "cli", id: "cli:local", actor: CLI_ACTOR };
const reader = preapprovedCaller({
  kind: "mcp" as const,
  id: "mcp:reader",
  actor: {
    kind: "service" as const,
    id: "mcp:reader",
    grants: { actions: new Set(["runs:read"]), channels: new Set(["mcp:checks"]), repos: new Set<string>() },
  },
});

function source(): CheckSource {
  return {
    version: 1,
    state: "terminal",
    selector,
    resource: {
      type: "run",
      id: "check-run",
      userId: "mcp:owner",
      channelId: "mcp:checks",
      channelVisibility: "machine",
      repo: "fixture/repo",
    },
    threadKey: "mcp:checks:thread",
    result,
  };
}

async function setup(
  options: {
    source?: CheckSource | null;
    record?: Partial<RunRecord>;
    runtime?: (selected: CheckSelector, settle: boolean, expectedSourceHash: string) => Promise<CheckInspection>;
  } = {},
) {
  const store = new InMemoryRunStore({ now: () => NOW });
  await store.put({
    id: "check-run",
    userId: "mcp:owner",
    channelId: "mcp:checks",
    channelVisibility: "machine",
    repo: "fixture/repo",
    threadKey: "mcp:checks:thread",
    startedAt: NOW - 10,
    finishedAt: NOW,
    status: "completed",
    eventCount: 0,
    storedEventCount: 0,
    truncated: false,
    events: [],
    diagnosis: analyzeRunFriction([]),
    ...options.record,
  });
  const ledger = new InMemoryRunLedger();
  const selected = options.source === undefined ? source() : options.source;
  vi.spyOn(ledger, "readCheckSource").mockResolvedValue(
    selected ? { kind: "source", source: selected } : { kind: "unavailable" },
  );
  const runs = createRunsService({ registry: new RunRegistry(), store, ledger, checkRuntime: options.runtime });
  const registry = new CommandRegistry<RunsCommandDeps>({ audit: () => {} });
  registerRunsCommands(registry);
  const deps = { runs: async () => runs, denied: () => {} };
  const invoke = (command = "runs.check", caller = reader) =>
    registry.invoke(
      command,
      { args: ["check-run", "call-1"], options: { phase: "command" } },
      preapprovedCaller(caller),
      deps,
    );
  return { invoke, registry, deps };
}

describe("recorded check commands", () => {
  it("returns a canonical completed result without a runtime and wraps output as untrusted", async () => {
    const { invoke } = await setup();
    const response = await invoke();
    expect(response).toMatchObject({
      ok: true,
      value: { kind: "known", source: "canonical", result: { exitCode: 1, truncated: false } },
    });
    if (!response.ok) throw new Error("inspection failed");
    const value = response.value as { result: { stdout: string; stderr: string } };
    expect(unwrapUntrusted(value.result.stdout)).toBe("1 test failed");
    expect(unwrapUntrusted(value.result.stderr)).toBe("assertion failed");
    expect(value.result.stdout).not.toBe("1 test failed");
  });

  it.each([
    { userId: "mcp:other" },
    { channelId: "mcp:other" },
    { channelVisibility: "public" as const },
    { repo: "other/repo" },
    { id: "other-run" },
  ])("refuses a public projection that disagrees with frozen identity %j", async (changed) => {
    const original = source();
    const { invoke } = await setup({ source: { ...original, resource: { ...original.resource, ...changed } } });
    expect(await invoke("runs.check", cli)).toMatchObject({ ok: false, error: "not_found" });
  });

  it("refuses a forged public projection of a private worker source", async () => {
    const { invoke } = await setup({ source: { ...source(), threadKey: "worker:private:fixture" } });
    expect(await invoke("runs.check", cli)).toMatchObject({ ok: false, error: "not_found" });
  });

  it("keeps private worker runs hidden from ordinary commands even for an operator", async () => {
    const { invoke } = await setup({
      source: { ...source(), threadKey: "worker:private:fixture" },
      record: { threadKey: "worker:private:fixture" },
    });
    expect(await invoke("runs.check", cli)).toMatchObject({ ok: false, error: "not_found" });
    expect(await invoke("runs.settlecheck", cli)).toMatchObject({ ok: false, error: "not_found" });
  });

  it("uses resolved channel grants even when the caller supplies a visible channel", async () => {
    const { invoke } = await setup();
    const foreign = {
      ...reader,
      channelId: "mcp:checks",
      actor: {
        ...reader.actor,
        grants: { ...reader.actor.grants, channels: new Set(["mcp:elsewhere"]) },
      },
    };
    expect(await invoke("runs.check", foreign)).toMatchObject({ ok: false, error: "not_found" });
  });

  it("requires write authority for settlement and sends only the original selector", async () => {
    const runtime = vi.fn(async (): Promise<CheckInspection> => ({ kind: "retired", reason: "native_ended" }));
    const { invoke } = await setup({ runtime });
    expect(await invoke("runs.check")).toMatchObject({ ok: true, value: { kind: "known", source: "canonical" } });
    expect(await invoke("runs.settlecheck")).toMatchObject({ ok: false, error: "unauthorized" });
    expect(await invoke("runs.settlecheck", cli)).toMatchObject({
      ok: true,
      value: { kind: "retired", reason: "native_ended" },
    });
    expect(runtime.mock.calls).toEqual([
      [{ runId: "check-run", callId: "call-1", phase: "command" }, true, expect.stringMatching(/^[a-f0-9]{64}$/)],
    ]);
  });

  it("refuses live settlement without contacting the runtime", async () => {
    const runtime = vi.fn(async (): Promise<CheckInspection> => ({ kind: "retired", reason: "native_ended" }));
    const { invoke } = await setup({ source: { ...source(), state: "live" }, runtime });
    expect(await invoke("runs.settlecheck", cli)).toMatchObject({
      ok: true,
      value: { kind: "unavailable", reason: "live" },
    });
    expect(runtime.mock.calls).toEqual([]);
  });

  it("keeps missing original source unavailable even when a runtime exists", async () => {
    const runtime = vi.fn(async (): Promise<CheckInspection> => ({ kind: "retired", reason: "native_ended" }));
    const { invoke } = await setup({ source: null, runtime });
    expect(await invoke("runs.check", cli)).toMatchObject({
      ok: true,
      value: { kind: "unavailable", reason: "source" },
    });
    expect(runtime.mock.calls).toEqual([]);
  });

  it("selects metadata separately and reports the original pending state", async () => {
    const runtime = vi.fn(async (): Promise<CheckInspection> => ({
      kind: "pending",
      reason: "native_ending_unproven",
    }));
    const metadata = { ...source(), selector: { ...selector, phase: "metadata" as const }, result: undefined };
    const { registry, deps } = await setup({ source: metadata, runtime });
    expect(
      await registry.invoke(
        "runs.check",
        {
          args: ["check-run", "call-1"],
          options: { phase: "metadata" },
        },
        reader,
        deps,
      ),
    ).toMatchObject({ ok: true, value: { kind: "pending", reason: "native_ending_unproven" } });
    expect(runtime.mock.calls).toEqual([
      [{ runId: "check-run", callId: "call-1", phase: "metadata" }, false, expect.stringMatching(/^[a-f0-9]{64}$/)],
    ]);
  });

  it("refuses caller-authored keys and proof instead of widening the selector", async () => {
    const { registry, deps } = await setup();
    expect(
      await registry.invoke(
        "runs.settlecheck",
        {
          args: ["check-run", "call-1"],
          options: { phase: "command", key: "forged", proof: "forged" },
        },
        preapprovedCaller(cli),
        deps,
      ),
    ).toMatchObject({ ok: false, error: "invalid_input" });
  });

  it("requires run visibility as well as the write grant for settlement", async () => {
    const { invoke } = await setup();
    const foreignWriter = {
      ...reader,
      actor: {
        ...reader.actor,
        grants: { ...reader.actor.grants, actions: new Set(["runs:write"]), channels: new Set(["mcp:elsewhere"]) },
      },
    };
    expect(await invoke("runs.settlecheck", foreignWriter)).toMatchObject({ ok: false, error: "not_found" });
  });

  it("reports a missing backend while preserving unknown output", async () => {
    const { invoke } = await setup({ source: { ...source(), result: undefined } });
    expect(await invoke("runs.check")).toMatchObject({ ok: true, value: { kind: "unavailable", reason: "backend" } });
    expect(await invoke("runs.settlecheck", cli)).toMatchObject({
      ok: true,
      value: { kind: "unavailable", reason: "backend" },
    });
  });

  it("does not fill a missing public visibility stamp from private evidence", async () => {
    const { invoke } = await setup({
      source: source(),
      record: { channelVisibility: undefined },
    });
    expect(await invoke("runs.check", cli)).toMatchObject({ ok: false, error: "not_found" });
  });
});
