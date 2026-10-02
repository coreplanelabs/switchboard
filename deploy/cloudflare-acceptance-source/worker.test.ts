import { describe, expect, it, vi } from "vitest";
import { MCP_PROTOCOL_VERSION, StreamableHttpMcpClient } from "../../src/mcp/client.js";
import { sourceReadContract } from "../../src/mcp/sourceReadProtocol.js";
import source, { AcceptanceActions, READ_TOOL, type Env } from "./worker.js";

// A storage-backed fake retains entries across Durable Object reconstruction.
function fixture() {
  const rows = new Map<string, unknown>();
  let alarmAt: number | undefined;
  const base = {
    get: async <T>(key: string) => rows.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      rows.set(key, structuredClone(value));
    },
    setAlarm: async (at: number) => {
      alarmAt = at;
    },
    getAlarm: async () => alarmAt ?? null,
  };
  const storage = { ...base, transaction: async <T>(fn: (tx: typeof base) => Promise<T>) => fn(base) };
  const credential = crypto.randomUUID(); // Ephemeral; never checked in or logged.
  const env = {
    SOURCE_BEARER: credential,
    SOURCE_REQUESTER: "controlled-requester",
    SOURCE_RESOURCE_SCOPE: "quick,slow",
    ACTIONS: {
      idFromName: () => "controlled",
      get: () => ({ fetch: (request: Request) => object.fetch(request) }),
    },
  } as Env;
  let object = new AcceptanceActions({ storage }, env);
  const restart = () => {
    object = new AcceptanceActions({ storage }, env);
  };
  const post = (body: unknown, session?: string, authorization = `Bearer ${credential}`) =>
    source.fetch(
      new Request("https://source.invalid/mcp", {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
          ...(session ? { "mcp-session-id": session } : {}),
        },
        body: JSON.stringify(body),
      }),
      env,
    );
  const rpc = (method: string, params: unknown = {}, session?: string, authorization?: string) =>
    post({ jsonrpc: "2.0", id: 1, method, params }, session, authorization);
  const session = async () =>
    (await rpc("initialize", { protocolVersion: MCP_PROTOCOL_VERSION })).headers.get("mcp-session-id")!;
  const call = async (
    sessionId: string,
    action: "execute" | "inspect",
    resource = "quick",
    actionId = crypto.randomUUID(),
  ) => {
    const response = await rpc(
      "tools/call",
      {
        name: READ_TOOL.name,
        arguments: {
          version: 1,
          operationRevision: "1",
          action,
          actionId,
          resource: { id: resource },
          input: {},
        },
      },
      sessionId,
    );
    return { response, body: (await response.json()) as { result?: { structuredContent: Record<string, unknown> } } };
  };
  return {
    env,
    credential,
    storage,
    get alarmAt() {
      return alarmAt;
    },
    restart,
    post,
    rpc,
    session,
    call,
    alarm: () => object.alarm(),
  };
}

describe("controlled read source", () => {
  it("discovers exactly one closed versioned read tool over Streamable HTTP", async () => {
    const f = fixture();
    const session = await f.session();
    expect(session).toBeTruthy();
    const listed = (await (await f.rpc("tools/list", {}, session)).json()) as { result: { tools: unknown[] } };
    expect(listed.result.tools).toEqual([READ_TOOL]);
    expect(READ_TOOL._meta.sourceAction).toMatchObject({
      version: 1,
      lifecycle: "execute_inspect",
      resourceEffect: "read",
      replayPolicy: "reconcile_only",
    });
    expect(READ_TOOL.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: { resource: { additionalProperties: false }, input: { additionalProperties: false } },
    });
    const client = new StreamableHttpMcpClient({
      url: "https://source.invalid/mcp",
      headers: { Authorization: `Bearer ${f.credential}` },
      fetch: (url, init) => source.fetch(new Request(url, init), f.env),
    });
    const tools = await client.listTools();
    const contract = sourceReadContract(tools[0]!);
    expect(contract?.descriptor.replayPolicy).toBe("reconcile_only");
    expect(contract?.accepts({ resource: { id: "quick" }, input: {} })).toBe(true);
    expect(contract?.accepts({ resource: { id: "quick" }, input: { write: true } })).toBe(false);
    const bound = await client.sourceSession();
    const receipt = await client.callTool(
      READ_TOOL.name,
      {
        version: 1,
        operationRevision: "1",
        action: "execute",
        actionId: crypto.randomUUID(),
        resource: { id: "quick" },
        input: {},
      },
      { sourceSession: bound },
    );
    expect(receipt.structuredContent).toMatchObject({ status: "succeeded", binding: { sessionId: bound } });
  });

  it("rejects missing or wrong bearer, forged sessions, forbidden resources and open inputs", async () => {
    const f = fixture();
    expect((await f.rpc("initialize", {}, undefined, "")).status).toBe(401);
    expect((await f.rpc("initialize", {}, undefined, `Bearer ${crypto.randomUUID()}`)).status).toBe(401);
    const session = await f.session();
    expect((await f.rpc("tools/list", {}, crypto.randomUUID())).status).toBe(404);
    f.env.SOURCE_RESOURCE_SCOPE = "slow";
    expect((await f.call(session, "execute", "quick")).body.result?.structuredContent).toMatchObject({
      status: "refused",
      reason: "unauthorized",
    });
    expect((await f.call(session, "execute", "private")).body.result?.structuredContent).toMatchObject({
      status: "refused",
      reason: "invalid_request",
    });
    const forbidden = await f.rpc(
      "tools/call",
      {
        name: READ_TOOL.name,
        arguments: {
          version: 1,
          action: "execute",
          actionId: crypto.randomUUID(),
          operationRevision: "1",
          resource: { id: "quick" },
          input: { secret: "x" },
        },
      },
      session,
    );
    expect(
      ((await forbidden.json()) as { result: { structuredContent: { reason: string } } }).result.structuredContent
        .reason,
    ).toBe("invalid_request");
    expect(await f.storage.get("fixture:private")).toBeUndefined();
  });

  it("records execute once before waiting, then inspects the original session after disconnect and restart", async () => {
    const f = fixture();
    const session = await f.session();
    const actionId = crypto.randomUUID();
    const first = await f.call(session, "execute", "quick", actionId);
    const receipt = first.body.result?.structuredContent;
    expect(receipt).toMatchObject({
      status: "succeeded",
      attempt: "completed",
      actionId,
      binding: { sessionId: session, subjectId: "controlled-requester", resource: { id: "quick" }, input: {} },
      truncation: "none",
      result: { verified: true },
    });
    f.restart();
    expect((await f.call(session, "inspect", "quick", actionId)).body.result?.structuredContent).toEqual(receipt);
    expect((await f.call(session, "execute", "quick", actionId)).body.result?.structuredContent).toMatchObject({
      status: "refused",
      reason: "action_conflict",
    });
    const otherSession = await f.session();
    expect((await f.call(otherSession, "inspect", "quick", actionId)).body.result?.structuredContent).toMatchObject({
      status: "refused",
      reason: "not_found",
    });
  });

  it("persists a slow entry beyond the client timeout, exposes only timing/stage, and completes by alarm", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const session = await f.session();
      const actionId = crypto.randomUUID();
      const original = f.call(session, "execute", "slow", actionId);
      let entry: { enteredAt: string; sessionId: string; stage: string } | undefined;
      for (let i = 0; i < 50 && !entry; i++) {
        await vi.advanceTimersByTimeAsync(1);
        entry = await f.storage.get<{ enteredAt: string; sessionId: string; stage: string }>(`action:${actionId}`);
      }
      expect(entry).toMatchObject({ sessionId: session, stage: "pending" });
      expect(f.alarmAt).toBeGreaterThan(Date.now() + 30_000);
      const diag = await source.fetch(
        new Request(`https://source.invalid/diagnostic/${actionId}`, {
          headers: { authorization: `Bearer ${f.credential}`, "mcp-session-id": session },
        }),
        f.env,
      );
      expect(diag.status).toBe(200);
      const detail = await diag.text();
      expect(JSON.parse(detail)).toMatchObject({ actionId, stage: "pending", enteredAt: entry?.enteredAt });
      expect(detail).not.toMatch(/resource|query|input|token|requester|result/);
      // The client abandons the request; durable state and its alarm are independent.
      void original;
      f.restart();
      await vi.advanceTimersByTimeAsync(31_000);
      expect((await f.call(session, "inspect", "slow", actionId)).body.result?.structuredContent).toMatchObject({
        status: "unknown",
        reason: "pending",
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await f.alarm();
      f.restart();
      expect((await f.call(session, "inspect", "slow", actionId)).body.result?.structuredContent).toMatchObject({
        status: "succeeded",
        result: { verified: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reports success when fixture readback fails and refuses changed scope on recovery", async () => {
    const f = fixture();
    const session = await f.session();
    await f.storage.put("fixture:quick", "tampered");
    const actionId = crypto.randomUUID();
    expect((await f.call(session, "execute", "quick", actionId)).body.result?.structuredContent).toMatchObject({
      status: "unknown",
      reason: "pending",
    });
    f.restart();
    expect((await f.call(session, "inspect", "quick", actionId)).body.result?.structuredContent).toMatchObject({
      status: "unknown",
      reason: "pending",
    });
    f.env.SOURCE_RESOURCE_SCOPE = "slow";
    expect((await f.call(session, "inspect", "quick", actionId)).body.result?.structuredContent).toMatchObject({
      status: "refused",
      reason: "unauthorized",
    });
  });
});
