import { describe, expect, it, vi } from "vitest";
import { createRunStop } from "./runStop.js";
import { secretsFrom } from "../secrets.js";
import { readCancellationPreparation, type RunCancellation } from "../core/runLedger/cancellation.js";
import type { LiveRunRow } from "../core/runLedger/types.js";

// Feature: docs/reference/specs/run-history.md — hard stop targets an existing runtime.
const cancellation: RunCancellation = {
  version: 1,
  id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  runId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  ownerGen: "g1",
  startedAt: 1,
  threadKey: "mcp:fixture:thread",
  actor: { kind: "chat", id: "slack:operator" },
};
function row(): LiveRunRow {
  return {
    runId: cancellation.runId,
    ownerGen: "g1",
    startedAt: 1,
    leaseUntil: 2,
    card: null,
    phase: "live",
    stop: "hard",
    threadKey: cancellation.threadKey,
    meta: {
      agent: "review",
      channelId: "mcp:fixture",
      userId: "slack:requester",
      threadKey: cancellation.threadKey,
      repo: "fixture/repo",
      selection: "sandbox",
    },
    system: "",
    tools: [],
    state: {
      cancellation,
      binding: {
        backend: "sandbox",
        workspace: "/workspace/checkout",
        sandboxKey: "review:bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
        container: "original-container",
      },
    },
  };
}

describe("run runtime stop", () => {
  it("keeps a recorded sandbox target when the selection metadata is stale", async () => {
    const saved = row();
    saved.meta.selection = "resident";
    const fetch = vi.fn(async (_input: URL | RequestInfo) =>
      Response.json({ cancellationId: cancellation.id, stopped: true, disposition: "workspace-discarded" }),
    );
    const stop = createRunStop(
      { type: "cloudflare", url: "https://sandbox.example" },
      secretsFrom({ SANDBOX_TOKEN: "fixture" }),
      fetch,
    )!;
    expect(stop.supports(saved)).toBe(true);
    expect(await stop(saved, cancellation)).toEqual({ stopped: true, disposition: "workspace-discarded" });
    expect(String(fetch.mock.calls[0]![0])).toBe("https://sandbox.example/cancel-run");
  });
  it("does not treat machine=none as a receipt that the bot-host producer exited", async () => {
    const target = row();
    delete target.state.binding;
    target.meta.profile = { machine: "none", identity: "none", minutes: 5 };
    const stop = createRunStop({ type: "cloudflare", url: "https://sandbox.example" }, secretsFrom({}));
    expect(stop!.supports(target)).toBe(false);
    expect(await stop!(target, cancellation)).toEqual({
      stopped: false,
      refusal: { phase: "prepare", cause: "custody-unverified" },
    });
  });

  it("asks the recorded Resident backend to resolve an incomplete original target without attaching", async () => {
    const target = row();
    target.phase = "attaching";
    target.meta.selection = "resident";
    delete target.state.binding;
    const ticket = { ...cancellation, repo: "fixture/repo" };
    target.state.cancellation = ticket;
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual({
        cancellation: ticket,
        binding: null,
        resource: "repo:fixture/repo",
      });
      return Response.json({ cancellationId: ticket.id, stopped: true, disposition: "processes-stopped" });
    });
    const stop = createRunStop(
      { type: "cloudflare", resident: { baseUrl: "https://resident.example" } },
      secretsFrom({ RESIDENT_OPERATOR_TOKEN: "operator" }),
      fetch,
    );
    expect(await stop!(target, ticket)).toEqual({ stopped: true, disposition: "processes-stopped" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toBe("https://resident.example/native/cancel-run");
  });
  it.each([
    { step: "other-target", phase: "exit", cause: "exit-unconfirmed", exitCode: 2 },
    { step: "initial-kill", phase: "exit", cause: "exit-unconfirmed", exitCode: "2" },
    { step: "initial-kill", phase: "exit", cause: "exit-unconfirmed", exitCode: 2, stdout: "private-native-output" },
    { step: "initial-kill", phase: "exit", cause: "exit-unconfirmed", exitCode: 2, retirement: "private error text" },
  ])("drops an invalid observation while retaining the exact shutdown refusal: %j", async (observation) => {
    const target = row();
    target.state.binding = {
      backend: "resident",
      workspace: "/workspace/thread",
      ref: "main",
      user: "worker2",
      container: "original-container",
      ownerGen: "g1",
      ownerFence: 7,
    };
    const stop = createRunStop(
      { type: "cloudflare", resident: { baseUrl: "https://resident.example" } },
      secretsFrom({ RESIDENT_OPERATOR_TOKEN: "fixture" }),
      async () =>
        Response.json({
          stopped: false,
          cancellationId: cancellation.id,
          refusal: { phase: "resident", cause: "kill-unconfirmed" },
          observation,
        }),
    );
    expect(await stop!(target, cancellation)).toEqual({
      stopped: false,
      refusal: { phase: "resident", cause: "kill-unconfirmed" },
    });
  });
  it("keeps a validated native failure observation for the exact cancellation", async () => {
    const target = row();
    target.state.binding = {
      backend: "resident",
      workspace: "/workspace/thread",
      ref: "main",
      user: "worker2",
      container: "original-container",
      ownerGen: "g1",
      ownerFence: 7,
    };
    const stop = createRunStop(
      { type: "cloudflare", resident: { baseUrl: "https://resident.example" } },
      secretsFrom({ RESIDENT_OPERATOR_TOKEN: "fixture" }),
      async () =>
        Response.json({
          stopped: false,
          cancellationId: cancellation.id,
          refusal: { phase: "resident", cause: "kill-unconfirmed" },
          observation: { step: "initial-kill", phase: "exit", cause: "exit-unconfirmed", exitCode: 2 },
          privateBody: "must not leave this boundary",
        }),
    );
    expect(await stop!(target, cancellation)).toEqual({
      stopped: false,
      refusal: { phase: "resident", cause: "kill-unconfirmed" },
      observation: { step: "initial-kill", phase: "exit", cause: "exit-unconfirmed", exitCode: 2 },
    });
  });
  it("preserves an exact closed refusal without exposing the Worker's private payload", async () => {
    const target = row();
    target.state.binding = {
      backend: "resident",
      workspace: "/workspace/thread",
      ref: "main",
      user: "worker2",
      container: "original-container",
      ownerGen: "g1",
      ownerFence: 7,
    };
    const stop = createRunStop(
      { type: "cloudflare", resident: { baseUrl: "https://resident.example" } },
      secretsFrom({ RESIDENT_OPERATOR_TOKEN: "fixture" }),
      async () =>
        Response.json({
          stopped: false,
          cancellationId: cancellation.id,
          refusal: { phase: "resident", cause: "kill-unconfirmed" },
          privateBody: "must not leave this boundary",
        }),
    );
    expect(await stop!(target, cancellation)).toEqual({
      stopped: false,
      refusal: { phase: "resident", cause: "kill-unconfirmed" },
    });
  });
  it("accepts an exact resident retirement receipt without claiming a kill on its old boot", async () => {
    const target = row();
    target.state.binding = {
      backend: "resident",
      workspace: "/workspace/thread",
      ref: "main",
      user: "worker2",
      container: "original-container",
      ownerGen: "g1",
      ownerFence: 7,
    };
    const stop = createRunStop(
      { type: "cloudflare", resident: { baseUrl: "https://resident.example" } },
      secretsFrom({ RESIDENT_OPERATOR_TOKEN: "fixture" }),
      async () => Response.json({ stopped: true, cancellationId: cancellation.id, disposition: "runtime-retired" }),
    );
    expect(await stop!(target, cancellation)).toEqual({ stopped: true, disposition: "runtime-retired" });
  });
  it.each(["foreign ticket", "foreign phase", "unknown cause", "malformed phase", "lost answer"])(
    "keeps an unconfirmed runtime outcome private: %s",
    async (outcome) => {
      const stop = createRunStop(
        { type: "cloudflare", url: "https://sandbox.example" },
        secretsFrom({ SANDBOX_TOKEN: "fixture" }),
        async () => {
          if (outcome === "lost answer") throw new Error("private transport payload");
          return Response.json({
            stopped: false,
            cancellationId: outcome === "foreign ticket" ? "foreign" : cancellation.id,
            refusal: {
              phase: outcome === "foreign phase" ? "resident" : outcome === "malformed phase" ? ["sandbox"] : "sandbox",
              cause: outcome === "unknown cause" ? "private payload" : "destroy-unconfirmed",
            },
          });
        },
      );
      expect(await stop!(row(), cancellation)).toEqual({
        stopped: false,
        refusal: { phase: "sandbox", cause: "runtime-unconfirmed" },
      });
    },
  );
  it("retains the exact prepared-check refusal on a non-success HTTP response", async () => {
    const stop = createRunStop(
      { type: "cloudflare", url: "https://sandbox.example" },
      secretsFrom({ SANDBOX_TOKEN: "fixture" }),
      async () =>
        Response.json(
          {
            stopped: false,
            cancellationId: cancellation.id,
            refusal: { phase: "prepare", cause: "state-not-prepared" },
          },
          { status: 409 },
        ),
    );
    expect(await stop!(row(), cancellation)).toEqual({
      stopped: false,
      refusal: { phase: "prepare", cause: "state-not-prepared" },
    });
  });
  it("requires affirmative no-workspace evidence and names an unverified shutdown target", async () => {
    const stop = createRunStop(
      { type: "cloudflare", url: "https://sandbox.example" },
      secretsFrom({ SANDBOX_TOKEN: "fixture" }),
      async () => Response.json({ stopped: false }),
    );
    const legacy = row();
    delete legacy.state.binding;
    delete legacy.meta.selection;
    expect(await stop!(legacy, cancellation)).toEqual({
      stopped: false,
      refusal: { phase: "prepare", cause: "custody-unverified" },
    });
    legacy.meta.selection = "none";
    expect(await stop!(legacy, cancellation)).toEqual({
      stopped: false,
      refusal: { phase: "prepare", cause: "custody-unverified" },
    });
    legacy.meta.profile = { machine: "none", identity: "read", minutes: 25 };
    expect(await stop!(legacy, cancellation)).toEqual({
      stopped: false,
      refusal: { phase: "prepare", cause: "custody-unverified" },
    });
    legacy.state.binding = { backend: "unknown", workspace: "/private" };
    expect(await stop!(legacy, cancellation)).toEqual({
      stopped: false,
      refusal: { phase: "prepare", cause: "custody-unverified" },
    });
  });
  it("does not reserve cancellation for an unavailable resident target or an empty physical binding", () => {
    const stop = createRunStop(
      { type: "cloudflare", url: "https://sandbox.example" },
      secretsFrom({ SANDBOX_TOKEN: "fixture" }),
    );
    const resident = row();
    resident.state.binding = {
      backend: "resident",
      workspace: "/workspace/thread",
      ref: "main",
      user: "worker2",
      container: "original-container",
      ownerGen: "g1",
      ownerFence: 7,
    };
    expect(stop!.supports(resident)).toBe(false);
    const supported = createRunStop(
      { type: "cloudflare", url: "https://sandbox.example", resident: { baseUrl: "https://resident.example" } },
      secretsFrom({ RESIDENT_OPERATOR_TOKEN: "fixture" }),
    );
    expect(supported!.supports(resident)).toBe(true);
    resident.state.binding = { ...(resident.state.binding as object), container: "" };
    expect(supported!.supports(resident)).toBe(false);
  });
  it("uses the dedicated sandbox key and accepts only the exact cancellation acknowledgment", async () => {
    const sent: Array<{ url: string; key: string | null; body: unknown }> = [];
    const stop = createRunStop(
      { type: "cloudflare", url: "https://sandbox.example" },
      secretsFrom({ SANDBOX_TOKEN: "fixture" }),
      async (input, init) => {
        sent.push({
          url: String(input),
          key: new Headers(init?.headers).get("x-thread-key"),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({ stopped: true, cancellationId: cancellation.id, disposition: "workspace-discarded" });
      },
    );
    expect(await stop!(row(), cancellation)).toEqual({ stopped: true, disposition: "workspace-discarded" });
    expect(sent).toEqual([
      {
        url: "https://sandbox.example/cancel-run",
        key: "review:bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
        body: {
          cancellation,
          binding: {
            backend: "sandbox",
            workspace: "/workspace/checkout",
            sandboxKey: "review:bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
            container: "original-container",
          },
        },
      },
    ]);
    const unknown = createRunStop(
      { type: "cloudflare", url: "https://sandbox.example" },
      secretsFrom({ SANDBOX_TOKEN: "fixture" }),
      async () => Response.json({ stopped: true, cancellationId: "foreign", disposition: "workspace-discarded" }),
    );
    expect(await unknown!(row(), cancellation)).toEqual({
      stopped: false,
      refusal: { phase: "sandbox", cause: "runtime-unconfirmed" },
    });
  });
  it("logs a closed prepared-check cause and exact identity without private exception data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        await readCancellationPreparation(
          cancellation,
          row().state.binding,
          "https://state.example",
          "fixture",
          async () => {
            throw new Error("private transport body and credential");
          },
        ),
      ).toMatchObject({ stopped: false, refusal: { phase: "prepare", cause: "state-unreachable" } });
      expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
        event: "run.cancellation.refused",
        phase: "prepare",
        cause: "state-unreachable",
        runId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
        cancellationId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private transport body and credential");
      warn.mockClear();
      expect(
        await readCancellationPreparation(
          cancellation,
          row().state.binding,
          "https://state.example",
          "fixture",
          async () => Response.json({ prepared: true, cancellationId: "foreign" }),
        ),
      ).toMatchObject({ stopped: false, refusal: { phase: "prepare", cause: "ticket-mismatch" } });
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ phase: "prepare", cause: "ticket-mismatch" });
    } finally {
      warn.mockRestore();
    }
  });
  it("requires the actual store-fenced binding before a Worker can kill a target", async () => {
    const binding = row().state.binding;
    expect(
      await readCancellationPreparation(cancellation, binding, "https://state.example", "fixture", async () =>
        Response.json({ prepared: true, cancellationId: cancellation.id }),
      ),
    ).toEqual({ prepared: true });
    expect(
      await readCancellationPreparation(cancellation, binding, "https://state.example", "fixture", async () =>
        Response.json({ prepared: true, cancellationId: "foreign" }),
      ),
    ).toMatchObject({ stopped: false, refusal: { phase: "prepare", cause: "ticket-mismatch" } });
    expect(await readCancellationPreparation(cancellation, binding, undefined, undefined)).toMatchObject({
      stopped: false,
      refusal: { phase: "prepare", cause: "state-unconfigured" },
    });
  });
});
