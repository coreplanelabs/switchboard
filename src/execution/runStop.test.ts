import { describe, expect, it, vi } from "vitest";
import { createRunStop } from "./runStop.js";
import { secretsFrom } from "../secrets.js";
import { cancellationTargetPrepared, type RunCancellation } from "../core/runLedger/cancellation.js";
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
  it("requires affirmative no-workspace evidence and leaves unsupported backends on ordinary stop", async () => {
    const stop = createRunStop(
      { type: "cloudflare", url: "https://sandbox.example" },
      secretsFrom({ SANDBOX_TOKEN: "fixture" }),
      async () => Response.json({ stopped: false }),
    );
    const legacy = row();
    delete legacy.state.binding;
    delete legacy.meta.selection;
    expect(await stop!(legacy, cancellation)).toEqual({ stopped: false });
    legacy.meta.selection = "none";
    expect(await stop!(legacy, cancellation)).toEqual({ stopped: false });
    legacy.meta.profile = { machine: "none", identity: "read", minutes: 25 };
    expect(await stop!(legacy, cancellation)).toEqual({ stopped: true, disposition: "no-workspace" });
    legacy.state.binding = { backend: "unknown", workspace: "/private" };
    expect(await stop!(legacy, cancellation)).toEqual({ stopped: false });
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
    expect(await unknown!(row(), cancellation)).toEqual({ stopped: false });
  });
  it("logs a closed prepared-check cause and exact identity without private exception data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        await cancellationTargetPrepared(
          cancellation,
          row().state.binding,
          "https://state.example",
          "fixture",
          async () => {
            throw new Error("private transport body and credential");
          },
        ),
      ).toBe(false);
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
        event: "run.cancellation.refused",
        phase: "prepare",
        cause: "state-unreachable",
        runId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
        cancellationId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      });
      warn.mockClear();
      expect(
        await cancellationTargetPrepared(
          cancellation,
          row().state.binding,
          "https://state.example",
          "fixture",
          async () => Response.json({ prepared: true, cancellationId: "foreign" }),
        ),
      ).toBe(false);
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ phase: "prepare", cause: "ticket-mismatch" });
    } finally {
      warn.mockRestore();
    }
  });
  it("requires the actual store-fenced binding before a Worker can kill a target", async () => {
    const binding = row().state.binding;
    expect(
      await cancellationTargetPrepared(cancellation, binding, "https://state.example", "fixture", async () =>
        Response.json({ prepared: true, cancellationId: cancellation.id }),
      ),
    ).toBe(true);
    expect(
      await cancellationTargetPrepared(cancellation, binding, "https://state.example", "fixture", async () =>
        Response.json({ prepared: true, cancellationId: "foreign" }),
      ),
    ).toBe(false);
    expect(await cancellationTargetPrepared(cancellation, binding, undefined, undefined)).toBe(false);
  });
});
