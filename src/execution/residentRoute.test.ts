import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceBindingFor, workspaceBindingOf } from "./factory.js";
import { cancellationBindingMatches, cancellationRuntimeSupported } from "../core/runLedger/cancellation.js";
import { residentRouteOf } from "./residentRoute.js";
import { terminalWorkspaceSettlement } from "../core/workspaceSettlement.js";
import type { LiveRunRow } from "../core/runLedger/types.js";
import type { RunRecord } from "../core/runRecord.js";
import { DRAIN_POLL_MS, ResidentExecutor } from "./resident.js";

const route = { residentId: "resident-secondary", placementId: "cf5c0a88-820b-45f2-b689-4432d93fbdce" };
const binding = {
  backend: "resident" as const,
  ref: "main",
  workspace: "/workspace/threads/t/main",
  user: "worker34",
  container: "original-boot",
  ownerGen: "original-generation",
  ownerFence: 7,
  ...route,
};

describe("resident runtime address", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const options = {
    baseUrl: "https://resident.example",
    token: "fixture",
    resource: "repo:acme/api",
    threadKey: "mcp:default:t",
  };
  const attachAnswer = {
    ref: "main",
    sha: "a".repeat(40),
    user: "worker34",
    workspace: binding.workspace,
    container: binding.container,
    ...route,
  };

  it.each([false, true])(
    "recovers a committed secondary before attach acknowledges its address (drain first: %s)",
    async (drainFirst) => {
      vi.useFakeTimers();
      let placementSaved = false;
      let drainPending = drainFirst;
      let transientPending = true;
      const selectors: Record<string, unknown>[] = [];
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        const target = new URL(url);
        const selector = init?.body ? JSON.parse(String(init.body)) : Object.fromEntries(target.searchParams);
        if (target.pathname === "/status") {
          selectors.push(selector);
          return Response.json({
            state: placementSaved && selector.threadKey === options.threadKey ? "warm" : "down",
            reason: "",
          });
        }
        if (target.pathname === "/attach") {
          if (drainPending) {
            drainPending = false;
            return Response.json(
              {
                error: "draining",
                status: 503,
                draining: {
                  since: "2026-09-18T05:00:00.000Z",
                  until: "2026-09-18T06:00:00.000Z",
                  by: "deploy all",
                  reason: "deploy",
                },
              },
              { status: 503 },
            );
          }
          placementSaved = true;
          if (transientPending) {
            transientPending = false;
            return Response.json(
              { error: "attach-failed: Network connection lost.", transient: true },
              { status: 500 },
            );
          }
          return Response.json(attachAnswer);
        }
        return Response.json({
          stdout:
            selector.residentId === route.residentId && selector.placementId === route.placementId
              ? "secondary workspace"
              : "wrong workspace",
          stderr: "",
          exitCode: 0,
          truncated: false,
        });
      });
      const opening = ResidentExecutor.open(options);
      const outcome = opening.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(drainFirst ? DRAIN_POLL_MS : 0);
      expect(((await outcome) as ResidentExecutor).binding).toMatchObject(route);
      const executor = await opening;
      expect(await executor.exec("pwd")).toBe("secondary workspace");
      expect(selectors).toEqual([{ resource: options.resource, threadKey: options.threadKey }]);
    },
  );

  it("sends the acknowledged address on commands and later reattachments", async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return Response.json(
        url.endsWith("/attach") ? attachAnswer : { stdout: "hello", stderr: "", exitCode: 0, truncated: false },
      );
    });
    const executor = await ResidentExecutor.open(options);
    expect(await executor.exec("echo hello")).toBe("hello");
    expect(await executor.attach()).toMatchObject(route);
    expect(calls.map(({ residentId, placementId }) => ({ residentId, placementId }))).toEqual([
      { residentId: undefined, placementId: undefined },
      route,
      route,
    ]);
  });

  it("rejects an attachment answer that changes or drops the saved address", async () => {
    let answer: Record<string, unknown> = attachAnswer;
    let transientPending = true;
    const probes: Record<string, string>[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const target = new URL(url);
      if (target.pathname === "/status") {
        const selector = Object.fromEntries(target.searchParams);
        probes.push(selector);
        const exact =
          selector.threadKey === options.threadKey &&
          selector.residentId === route.residentId &&
          selector.placementId === route.placementId;
        return Response.json({ state: exact ? "warm" : "down", reason: "" });
      }
      if (transientPending) {
        transientPending = false;
        return Response.json({ error: "attach-failed: Network connection lost.", transient: true }, { status: 500 });
      }
      return Response.json(answer);
    });
    const executor = await ResidentExecutor.open({ ...options, ...route });
    expect(executor.binding).toMatchObject(route);
    expect(probes).toEqual([{ resource: options.resource, threadKey: options.threadKey, ...route }]);
    answer = { ...attachAnswer, residentId: "another-resident" };
    await expect(executor.attach()).rejects.toThrow("resident address mismatch");
    const { residentId: _id, placementId: _placement, ...legacy } = attachAnswer;
    answer = legacy;
    await expect(ResidentExecutor.open({ ...options, ...route })).rejects.toThrow("resident address mismatch");
  });

  it("selects the exact recorded resident for status and restore waits", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      return Response.json({ state: "warm", reason: "" });
    });
    const selector = { ...route, threadKey: options.threadKey };
    expect(
      await ResidentExecutor.probeStatus(
        options.baseUrl,
        options.token,
        options.resource,
        1000,
        undefined,
        undefined,
        selector,
      ),
    ).toMatchObject({ kind: "status", state: "warm" });
    expect(
      await ResidentExecutor.awaitRestore(
        options.baseUrl,
        options.token,
        options.resource,
        1000,
        undefined,
        undefined,
        selector,
      ),
    ).toMatchObject({ kind: "status", state: "warm" });
    expect(Object.fromEntries(new URL(requests[0].url).searchParams)).toEqual({
      resource: options.resource,
      ...selector,
    });
    expect(requests[1].body).toEqual({ resource: options.resource, ...selector });
  });
  it("retains the replica through workspace serialization and terminal settlement", () => {
    const saved = workspaceBindingOf(
      workspaceBindingFor({ backend: "resident", binding: { ...binding, sha: "a".repeat(40) } }),
    );
    expect(saved).toEqual({ ...binding, publicationBaseSha: "a".repeat(40) });
    const runId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const row = {
      runId,
      ownerGen: binding.ownerGen,
      threadKey: "mcp:default:t",
      meta: {},
      state: { binding: saved },
    } as unknown as LiveRunRow;
    const record = {
      id: runId,
      threadKey: "mcp:default:t",
      status: "completed",
      repo: "acme/api",
      userId: "mcp:caller",
    } as RunRecord;
    expect(terminalWorkspaceSettlement(row, record)?.binding).toEqual({
      ...binding,
      publicationBaseSha: "a".repeat(40),
    });
  });

  it("refuses cancellation of a different replica or placement even when the old target fields match", () => {
    expect(cancellationBindingMatches(binding, binding)).toBe(true);
    expect(cancellationBindingMatches(binding, { ...binding, residentId: "another-resident" })).toBe(false);
    expect(
      cancellationBindingMatches(binding, { ...binding, placementId: "5f73a3bb-bd29-48f9-858e-a651670565b4" }),
    ).toBe(false);
    const { residentId: _residentId, placementId: _placementId, ...legacy } = binding;
    expect(cancellationBindingMatches(binding, legacy)).toBe(false);
    expect(cancellationBindingMatches(legacy, legacy)).toBe(true);
  });

  it("keeps malformed address metadata from becoming a legacy cancellation target", () => {
    const row = { ownerGen: binding.ownerGen, meta: {}, state: { binding } } as unknown as LiveRunRow;
    expect(cancellationRuntimeSupported(row)).toBe(true);
    const malformed = { ...binding, residentId: undefined };
    expect(residentRouteOf(malformed)).toBeNull();
    expect(cancellationRuntimeSupported({ ...row, state: { binding: malformed } })).toBe(false);
    expect(residentRouteOf(workspaceBindingOf(malformed))).toBeNull();
  });
});
