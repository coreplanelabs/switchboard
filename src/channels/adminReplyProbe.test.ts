import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Secret } from "../secrets.js";
import { NO_GRANTS } from "../core/authz/types.js";
import { handleAdminReplyProbe, REPLY_PROBE_PATH } from "./adminReplyProbe.js";

function request(body: string, token?: string, method = "POST") {
  const output = { status: 0, body: "" };
  const req = Object.assign(
    (async function* () {
      yield Buffer.from(body);
    })(),
    {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      destroy: () => {},
    },
  ) as unknown as IncomingMessage;
  const res = {
    writeHead: (status: number) => {
      output.status = status;
    },
    end: (body: string) => {
      output.body = body;
    },
  } as unknown as ServerResponse;
  return { req, res, output };
}
describe("operator reply probe", () => {
  it("a disconnected body resolves without model work or a response on the closed socket", async () => {
    let calls = 0;
    const t = request("", "operator");
    const req = Object.assign(
      (async function* () {
        yield Buffer.from('{"model":');
        throw new Error("ECONNRESET");
      })(),
      { method: "POST", headers: { authorization: "Bearer operator" }, destroyed: true, destroy: () => {} },
    ) as unknown as IncomingMessage;
    Object.assign(t.res, { destroyed: true });
    await expect(
      handleAdminReplyProbe(req, t.res, {
        tokens: new Secret(JSON.stringify({ operator: { subject: "ops" } }), "SWITCHBOARD_INGRESS_TOKENS"),
        grantsFor: () => ({
          actions: new Set(["deploy:write"]),
          channels: new Set<string>(),
          repos: new Set<string>(),
        }),
        probe: async () => {
          calls++;
          return {};
        },
      }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(0);
    expect(t.output.status).toBe(0);
  });
  it("authorizes before model work and accepts only bounded typed requests", async () => {
    let calls = 0;
    const deps = {
      tokens: new Secret(
        JSON.stringify({ operator: { subject: "ops" }, reader: { subject: "reader" } }),
        "SWITCHBOARD_INGRESS_TOKENS",
      ),
      grantsFor: (id: string) =>
        id === "http:ops"
          ? { actions: new Set(["deploy:write"]), channels: new Set<string>(), repos: new Set<string>() }
          : NO_GRANTS,
      probe: async () => {
        calls++;
        return { kind: "synthetic-reply-probe", liveRoutingChanged: false };
      },
    };
    const body = JSON.stringify({ model: "typesafe/jev-1.13.0", message: "Can you explain this error?" });
    for (const [r, status] of [
      [request(body), 401],
      [request(body, "reader"), 403],
      [request(body, "operator", "GET"), 405],
      [request("{", "operator"), 400],
      [request(JSON.stringify({ model: "openai/model", message: "hi" }), "operator"), 400],
      [request("x".repeat(5000), "operator"), 413],
    ] as const) {
      await handleAdminReplyProbe(r.req, r.res, deps);
      expect(r.output.status).toBe(status);
    }
    expect(calls).toBe(0);
    const valid = request(body, "operator");
    await handleAdminReplyProbe(valid.req, valid.res, deps);
    expect(valid.output.status).toBe(200);
    expect(JSON.parse(valid.output.body)).toMatchObject({ ok: true, liveRoutingChanged: false });
    expect(calls).toBe(1);
    expect(REPLY_PROBE_PATH).toBe("/admin/reply-probe");
  });
});
