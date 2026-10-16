import { describe, expect, it } from "vitest";
import type { CoreDeps } from "../core/dispatcher.js";
import { ALL_GRANTS } from "../core/authz/grants.js";
import { InMemoryOrganizationStore } from "../core/organization/memory.js";
import { OrganizationService } from "../core/organization/service.js";
import { handleMcpRequest, type McpOptions } from "./mcp.js";

const deps = { config: { grantsFor: () => ALL_GRANTS, config: {} } } as unknown as CoreDeps;
function setup() {
  const store = new InMemoryOrganizationStore(() => 1);
  let allowed = true;
  const service = new OrganizationService({
    store,
    directory: store.directory,
    mappings: [{ source: "mcp", issuer: "installation:mcp", tenant: null, organization: "org:test" }],
    limits: {
      pendingPerActor: 5,
      pendingPerSource: 10,
      pendingPerOrganization: 20,
      reservedReconciliation: 1,
      contentTtlMs: 90,
      receiptTtlMs: 365,
    },
    authorize: async () => allowed,
  });
  const sources: { userId: string; messageId?: string; credentialDigest: string }[] = [];
  const options: McpOptions = {
    auth: { tokens: { "credential-one": { subject: "service-client", email: "alice@example.test" } } },
    personByEmail: async () => ({ id: "slack:borrowed" }),
    dispatch: async (_core, _msg, io) => io.reply("legacy reply"),
    admit: async (msg, _io, evidence) => {
      if (evidence.source !== "mcp") throw new Error("Expected MCP credential");
      sources.push({ userId: msg.userId, messageId: msg.messageId, credentialDigest: evidence.credentialDigest! });
      return service.admit(
        {
          source: "mcp",
          identity: { issuer: "installation:mcp", tenant: null, subject: evidence.identity.subject },
          kind: "service",
          organizations: ["org:test"],
          sourceReference: {
            actorId: msg.userId,
            userId: msg.userId,
            channelId: msg.channelId,
            threadKey: msg.threadKey,
            messageId: msg.messageId,
            credentialDigest: evidence.credentialDigest,
            approvalConnection: msg.approvalConnection,
          },
        },
        {
          sourceEvent: msg.messageId!,
          key: msg.messageId!,
          content: msg.text,
          context: [],
          destination: { kind: "broad" },
          workload: "message",
          target: null,
        },
      );
    },
  };
  const send = (args: Record<string, unknown>, id = 1, chosenOptions = options) =>
    handleMcpRequest(
      {
        method: "POST",
        headers: { authorization: "Bearer credential-one" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "dispatch", arguments: args },
        }),
      },
      deps,
      chosenOptions,
    );
  return {
    store,
    sources,
    options,
    send,
    deny: () => {
      allowed = false;
    },
  };
}

describe("MCP organization admission", () => {
  it("retries one exact input under its original receipt and owner without borrowing an email identity", async () => {
    const s = setup();
    const args = {
      text: "Build the change",
      thread: "original",
      idempotencyKey: "retry-1",
      credentialDigest: "forged",
    };
    const first = await s.send(args);
    expect(first).toMatchObject({
      status: 200,
      body: { result: { structuredContent: { admission: { status: "pending", duplicate: false } } } },
    });
    const receiptId = (first.body as { result: { structuredContent: { admission: { receiptId: string } } } }).result
      .structuredContent.admission.receiptId;
    await s.store.execute({ action: "claim", organization: "org:test", owner: "worker", leaseMs: 100 });
    expect(
      await s.store.execute({
        action: "settle",
        organization: "org:test",
        owner: "worker",
        generation: 1,
        receiptId,
        status: "accepted",
        ownerRunId: "original-owner",
        reason: null,
        reply: null,
        contentTtlMs: 90,
      }),
    ).toMatchObject({ status: "receipt", receipt: { status: "accepted", ownerRunId: "original-owner" } });
    expect(await s.send(args, 2)).toMatchObject({
      status: 200,
      body: {
        result: {
          structuredContent: { admission: { status: "accepted", receiptId, duplicate: true, runId: "original-owner" } },
        },
      },
    });
    expect(await s.send({ ...args, text: "Different work" })).toMatchObject({
      body: { result: { isError: true, structuredContent: { admission: { status: "conflict" } } } },
    });
    expect(s.sources).toEqual(
      Array(3).fill({
        userId: "mcp:service-client",
        messageId: "mcp:3998fbdb8d844aa01d03de09b39b7b082e03bee469c40387bf2fedb81b1883f8",
        credentialDigest: "020f85bc4a5074beee0ff7599adc11829ded3eaa0acf3f59f5c944e0907a0332",
      }),
    );
  });

  it("refuses malformed retry keys and lost current policy while a valid key admits one receipt", async () => {
    const s = setup();
    for (const idempotencyKey of [null, "", 7, "x".repeat(129)])
      expect(await s.send({ text: "Hello", idempotencyKey })).toMatchObject({ body: { error: { code: -32602 } } });
    expect(s.sources).toEqual([]);
    expect(await s.send({ text: "Hello", idempotencyKey: "allowed" })).toMatchObject({
      body: { result: { structuredContent: { admission: { status: "pending" } } } },
    });
    s.deny();
    expect(await s.send({ text: "Hello", idempotencyKey: "allowed" })).toMatchObject({
      body: { result: { isError: true, structuredContent: { admission: { status: "not_found" } } } },
    });
  });

  it("keeps unkeyed submissions distinct and preserves the unactivated reply path", async () => {
    const s = setup();
    for (let call = 0; call < 2; call++)
      expect(await s.send({ text: "Hello" }, 1)).toMatchObject({
        body: { result: { structuredContent: { admission: { status: "pending", duplicate: false } } } },
      });
    expect(s.sources).toHaveLength(2);
    expect(s.sources[0].messageId).not.toBe(s.sources[1].messageId);
    expect(
      await s.send({ text: "Hello" }, 1, {
        ...s.options,
        auth: { tokens: { "credential-one": { subject: "service-client" } } },
        admit: undefined,
        personByEmail: undefined,
      }),
    ).toMatchObject({ body: { result: { content: [{ type: "text", text: "legacy reply" }] } } });
  });
});
