import { describe, expect, it, vi } from "vitest";
import { secretsFrom } from "../secrets.js";
import { createRunCheck } from "./runCheck.js";

// Feature: docs/reference/specs/run-history.md — selector-only original check transport.
const selector = { runId: "original-run", callId: "original-call", phase: "command" as const };
const execution = { type: "cloudflare" as const, resident: { baseUrl: "https://resident.example" } };
const sourceHash = "a".repeat(64);
const secrets = secretsFrom({ RESIDENT_OPERATOR_TOKEN: "operator" });

describe("run check runtime adapter", () => {
  it("selects inspection and settlement endpoints without sending caller proof or identity", async () => {
    const requests: { url: string; body: unknown; authorization: string | null }[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: JSON.parse(init!.body as string),
        authorization: new Headers(init!.headers).get("authorization"),
      });
      return Response.json({ sourceHash, inspection: { kind: "retired", reason: "native_ended" } });
    });
    const inspect = createRunCheck(execution, secrets, fetch)!;
    const extra = { ...selector, key: "forged-key", owner: "forged-owner", proof: "forged-proof" };
    expect(await inspect(extra, false, sourceHash)).toEqual({ kind: "retired", reason: "native_ended" });
    expect(await inspect(extra, true, sourceHash)).toEqual({ kind: "retired", reason: "native_ended" });
    expect(requests).toEqual([
      {
        url: "https://resident.example/inspect-check",
        body: { runId: "original-run", callId: "original-call", phase: "command" },
        authorization: "Bearer operator",
      },
      {
        url: "https://resident.example/settle-check",
        body: { runId: "original-run", callId: "original-call", phase: "command" },
        authorization: "Bearer operator",
      },
    ]);
  });

  it.each([
    { kind: "known", source: "resident", result: { stdout: "ok", stderr: "", exitCode: 0, truncated: false } },
    { kind: "pending", reason: "native_ending_unproven" },
    { kind: "unavailable", reason: "proof" },
  ])("preserves a validated original operation response %j", async (response) => {
    const inspect = createRunCheck(execution, secrets, async () =>
      Response.json({ sourceHash, inspection: response }),
    )!;
    expect(await inspect(selector, false, sourceHash)).toEqual(response);
  });

  it.each([
    { kind: "known", source: "resident", result: { stdout: "invented", exitCode: 0 } },
    { kind: "retired", reason: "assumed_success" },
    { kind: "retired", reason: "native_ended", owner: "other" },
  ])("refuses malformed runtime evidence %j", async (response) => {
    const inspect = createRunCheck(execution, secrets, async () =>
      Response.json({ sourceHash, inspection: response }),
    )!;
    expect(await inspect(selector, true, sourceHash)).toEqual({ kind: "unavailable", reason: "backend" });
  });

  it("reports missing credentials and transport failures without retrying", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("lost acknowledgement");
    });
    const missing = createRunCheck(execution, secretsFrom({}), fetch)!;
    expect(await missing(selector, true, sourceHash)).toEqual({ kind: "unavailable", reason: "backend" });
    expect(fetch.mock.calls).toEqual([]);
    const inspect = createRunCheck(execution, secrets, fetch)!;
    expect(await inspect(selector, true, sourceHash)).toEqual({ kind: "unavailable", reason: "backend" });
    expect(fetch.mock.calls).toHaveLength(1);
  });

  it("refuses unsuccessful HTTP responses even when the body claims an ending", async () => {
    const inspect = createRunCheck(execution, secrets, async () =>
      Response.json({ kind: "retired", reason: "native_ended" }, { status: 403 }),
    )!;
    expect(await inspect(selector, true, sourceHash)).toEqual({ kind: "unavailable", reason: "backend" });
  });

  it("withholds results when the receiver reread a different canonical identity", async () => {
    const inspect = createRunCheck(execution, secrets, async () =>
      Response.json({
        sourceHash: "b".repeat(64),
        inspection: {
          kind: "known",
          source: "resident",
          result: { stdout: "other owner's output", stderr: "", exitCode: 0, truncated: false },
        },
      }),
    )!;
    expect(await inspect(selector, false, sourceHash)).toEqual({ kind: "unavailable", reason: "identity" });
  });

  it("refuses an unbound result but preserves a receiver's missing-source refusal", async () => {
    const inspect = createRunCheck(execution, secrets, async () =>
      Response.json({ kind: "retired", reason: "native_ended" }),
    )!;
    expect(await inspect(selector, false, sourceHash)).toEqual({ kind: "unavailable", reason: "backend" });
    const unavailable = createRunCheck(execution, secrets, async () =>
      Response.json({ kind: "unavailable", reason: "source" }),
    )!;
    expect(await unavailable(selector, false, sourceHash)).toEqual({ kind: "unavailable", reason: "source" });
  });
});
