import { describe, expect, it } from "vitest";
import { Secret } from "../../secrets.js";
import { createInstanceViaShim, fetchInstanceStatusViaShim } from "./instancesClient.js";

// Feature: docs/reference/specs/http-ingress.md item 9 — how the bot asks its
// own shim for a coordinator instance: `POST <PUBLIC_BASE_URL>/admin/coordinator/instances`
// with the `coordinator` bearer of the token map it holds, `{ id, params: {} }`
// as the body, the answer read by `readCreateInstanceAnswer`. A process without
// the base URL or the bearer, or a shim that cannot be reached, is `unanswered`
// by reason — never a throw into the ship branch.

const TOKENS = new Secret(
  JSON.stringify({ "tok-coord": { subject: "coordinator" }, "tok-cron": { subject: "cron" } }),
  "SWITCHBOARD_INGRESS_TOKENS",
);

function fetchDouble(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { impl, calls };
}

describe("createInstanceViaShim — the bot's request for a coordinator instance", () => {
  it("POSTs the id to the shim's instance route with the coordinator bearer and reads the answer", async () => {
    const f = fetchDouble(201, { ok: true, id: "plan-fixture", created: true });
    const out = await createInstanceViaShim(
      { baseUrl: "https://bot.example/", tokens: TOKENS, fetch: f.impl },
      "plan-fixture",
    );
    expect(out).toEqual({ kind: "created", id: "plan-fixture" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://bot.example/admin/coordinator/instances");
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(f.calls[0]!.init.headers).toEqual({ authorization: "Bearer tok-coord", "content-type": "application/json" });
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ id: "plan-fixture", params: {} });
  });

  it("a duplicate and a failure come back as the shim said; a shim that cannot be reached, no base URL and no coordinator bearer are unanswered by reason and nothing is sent", async () => {
    const dup = fetchDouble(409, { ok: false, error: "duplicate_instance", id: "plan-fixture", status: "running" });
    expect(
      await createInstanceViaShim({ baseUrl: "https://bot.example", tokens: TOKENS, fetch: dup.impl }, "plan-fixture"),
    ).toEqual({
      kind: "duplicate",
      id: "plan-fixture",
      status: "running",
    });
    const down: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(
      await createInstanceViaShim({ baseUrl: "https://bot.example", tokens: TOKENS, fetch: down }, "plan-fixture"),
    ).toEqual({
      kind: "unanswered",
      reason: "the shim could not be reached: ECONNREFUSED",
    });
    const sent = fetchDouble(201, {});
    expect(
      await createInstanceViaShim({ baseUrl: undefined, tokens: TOKENS, fetch: sent.impl }, "plan-fixture"),
    ).toEqual({
      kind: "unanswered",
      reason: "PUBLIC_BASE_URL is not set — the bot cannot address its own shim",
    });
    expect(
      await createInstanceViaShim(
        {
          baseUrl: "https://bot.example",
          tokens: new Secret(JSON.stringify({ t: { subject: "cron" } }), "X"),
          fetch: sent.impl,
        },
        "plan-fixture",
      ),
    ).toEqual({
      kind: "unanswered",
      reason:
        "SWITCHBOARD_INGRESS_TOKENS has no single `coordinator` entry — the bot cannot present the coordinator bearer",
    });
    expect(
      await createInstanceViaShim(
        { baseUrl: "https://bot.example", tokens: undefined, fetch: sent.impl },
        "plan-fixture",
      ),
    ).toEqual({
      kind: "unanswered",
      reason:
        "SWITCHBOARD_INGRESS_TOKENS has no single `coordinator` entry — the bot cannot present the coordinator bearer",
    });
    expect(sent.calls).toEqual([]);
  });
});

describe("fetchInstanceStatusViaShim — an earlier attempt's instance, as the platform has it", () => {
  it("GETs the instance's status path with the coordinator bearer and reads the word, the absence, or an unanswered reason; no base URL or bearer sends nothing", async () => {
    const running = fetchDouble(200, { ok: true, id: "plan-fixture", status: "running" });
    expect(
      await fetchInstanceStatusViaShim(
        { baseUrl: "https://bot.example/", tokens: TOKENS, fetch: running.impl },
        "plan-fixture",
      ),
    ).toEqual({ kind: "status", status: "running" });
    expect(running.calls[0]!.url).toBe("https://bot.example/admin/coordinator/instances/plan-fixture");
    expect(running.calls[0]!.init.method).toBe("GET");
    expect(running.calls[0]!.init.headers).toEqual({ authorization: "Bearer tok-coord" });
    const absent = fetchDouble(404, { ok: false, error: "no_instance", id: "plan-fixture" });
    expect(
      await fetchInstanceStatusViaShim(
        { baseUrl: "https://bot.example", tokens: TOKENS, fetch: absent.impl },
        "plan-fixture",
      ),
    ).toEqual({ kind: "absent" });
    const down: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(
      await fetchInstanceStatusViaShim({ baseUrl: "https://bot.example", tokens: TOKENS, fetch: down }, "plan-fixture"),
    ).toEqual({ kind: "unanswered", reason: "the shim could not be reached: ECONNREFUSED" });
    const sent = fetchDouble(200, {});
    expect(
      await fetchInstanceStatusViaShim({ baseUrl: undefined, tokens: TOKENS, fetch: sent.impl }, "plan-fixture"),
    ).toEqual({ kind: "unanswered", reason: "PUBLIC_BASE_URL is not set — the bot cannot address its own shim" });
    expect(sent.calls).toEqual([]);
  });
});
