import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHomeRuntimeHandler } from "./homeRuntime.js";
import { createHomeHost } from "./homeHost.js";
import { createOrganizationRuntime, type OrganizationExecutionRequest } from "../core/organization/runtime.js";
import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { InMemoryOrganizationStore } from "../core/organization/memory.js";
import { OrganizationService } from "../core/organization/service.js";
import { createOrganizationAuthentication } from "./organizationAuthentication.js";
import { createHomeAccessEpoch } from "./homeAccessEpoch.js";
import { ALL_GRANTS } from "../core/authz/grants.js";
import { NO_GRANTS } from "../core/authz/types.js";
import { digestBearer, InMemoryPersonalTokenStore } from "../mcp/personalTokens.js";
import type { HomeRuntimeContext } from "./homeRuntime.js";
async function fixture() {
  const identity = { issuer: "https://access.test", tenant: null, subject: "alice" };
  const store = new InMemoryOrganizationStore(() => 1);
  const tokens = new InMemoryPersonalTokenStore();
  const organizationId = "installation";
  const mappings = [
    { source: "browser" as const, issuer: identity.issuer, tenant: identity.tenant, organization: organizationId },
    { source: "mcp" as const, issuer: "installation:mcp", tenant: null, organization: organizationId },
  ];
  const person = await store.directory.createPerson();
  if (person.status !== "created") throw new Error("person unavailable");
  await store.directory.change({
    action: "link",
    identity,
    personId: person.person.id,
    expectedRevision: 0,
    actor: identity,
    proof: { method: "dual-authentication", version: 1 },
  });
  let nativeGrants = ALL_GRANTS;
  const authentication = createOrganizationAuthentication({
    organization: organizationId,
    store,
    directory: store.directory,
    mappings,
    grantsFor: (id) => (id === "access:alice" ? ALL_GRANTS : id === "mcp:personal:alice" ? nativeGrants : NO_GRANTS),
    auth: () => ({ tokens: {} }),
    personalTokens: tokens,
    currentBrowser: async () => ({
      status: "verified",
      identity,
      actorId: "access:alice",
      kind: "human",
      organizationMember: true,
      privateSource: true,
      epoch: "current-native-proof",
      access: { sub: "alice" },
    }),
    currentSlack: async () => ({ status: "unavailable" }),
  });
  const organization = new OrganizationService({
    store,
    directory: store.directory,
    mappings,
    authorize: async () => true,
    currentIdentityRead: async (identity, reference, onBehalfOf) =>
      (await authentication.evaluateSourceIdentity(identity, reference, onBehalfOf)).status,
    limits: {
      pendingPerActor: 1000,
      pendingPerSource: 1000,
      pendingPerOrganization: 1000,
      reservedReconciliation: 1,
      contentTtlMs: 900,
      receiptTtlMs: 1000,
    },
  });
  const browser = await authentication.resolveBrowser(identity, {
    userId: "access:alice",
    channelId: "web:alice",
    threadKey: "web:alice:home",
    text: "",
  });
  if (browser.status !== "resolved") throw new Error("browser unavailable");
  const context: HomeRuntimeContext = { actor: browser.actor, authentication: browser.authentication };
  const epoch = createHomeAccessEpoch({
    organizationId,
    store,
    organization,
    authentication,
    policyEpoch: () => "unchanged-config",
  });
  let message = 0;
  async function send(key: string, threadKey = "mcp:alice:home", seal = false) {
    const digest = digestBearer(key);
    await tokens.put({
      digest,
      subject: "personal:alice",
      email: "not-identity@example.test",
      userId: "access:alice",
      createdAt: 1,
    });
    const current = await authentication.resolveNative(
      {
        userId: "access:alice",
        authenticatedAs: "mcp:personal:alice",
        channelId: "mcp:alice",
        threadKey,
        messageId: String(++message),
        text: "private fixture",
        approvalConnection: {
          id: digest,
          credentialId: "mcp:personal:alice",
          requestHash: digestBearer(String(message)),
        },
      },
      { source: "mcp", identity: { subject: "personal:alice" }, credentialDigest: digest },
    );
    if (current.status !== "resolved") throw new Error("source unavailable");
    if (seal) {
      const captured = await epoch({ actor: current.actor, authentication: current.authentication });
      if (!captured || !current.authentication.sourceReference) throw new Error("source epoch unavailable");
      current.authentication.sourceReference = {
        ...current.authentication.sourceReference,
        privateSource: true,
        capturedPrivateEpoch: captured,
      };
    }
    const issued = await organization.issue(current.authentication, 500);
    if (issued.status !== "key") throw new Error("key unavailable");
    const result = await organization.admit(current.authentication, {
      sourceEvent: String(message),
      key: issued.key,
      workload: "message",
      destination: { kind: "broad" },
      target: null,
      context: [],
      content: "private fixture",
    });
    expect(result.status).toBe("receipt");
  }
  return {
    store,
    tokens,
    organization,
    authentication,
    context,
    epoch,
    send,
    narrowSource: () => {
      nativeGrants = { ...ALL_GRANTS, actions: new Set(["organization:read"]) };
    },
    recreateEpoch: () =>
      createHomeAccessEpoch({
        organizationId,
        store,
        organization,
        authentication,
        policyEpoch: () => "unchanged-config",
      }),
  };
}
describe("complete Home access epoch", () => {
  it("keeps an existing draft and accepted owner epoch when new valid credential and thread scopes are added", async () => {
    const h = await fixture();
    await h.send("original-key");
    const captured = await h.epoch(h.context);
    expect(captured).toMatch(/^[0-9a-f]{64}$/);
    await h.send("additional-key", "mcp:alice:another-thread");
    expect(await h.epoch(h.context)).toBe(captured);
    expect(await h.recreateEpoch()(h.context)).toBe(captured);
    await h.tokens.delete(digestBearer("original-key"), "personal:alice");
    const revoked = await h.recreateEpoch()(h.context);
    expect(revoked).toMatch(/^[0-9a-f]{64}$/);
    expect(revoked).not.toBe(captured);
  });
  it("checks more than 200 distinct retained authorized scopes without refusing Home or discarding its epoch", async () => {
    const h = await fixture();
    const before = await h.epoch(h.context);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    for (let i = 0; i < 205; i++) await h.send(`credential-${i}`, `mcp:alice:thread-${i}`);
    expect(await h.epoch(h.context)).toBe(before);
    await h.tokens.delete(digestBearer("credential-0"), "personal:alice");
    const revoked = await h.epoch(h.context);
    expect(revoked).toMatch(/^[0-9a-f]{64}$/);
    expect(revoked).not.toBe(before);
  });

  it("delivers an already accepted owner reply after another valid scope is added and fences it after revocation", async () => {
    const h = await fixture();
    let host!: ReturnType<typeof createHomeHost>;
    let started: (request: OrganizationExecutionRequest) => void = () => {};
    let finish: () => void = () => {};
    const original = new Promise<OrganizationExecutionRequest>((resolve) => {
      started = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const tasks: (() => Promise<void>)[] = [];
    const runtime = createOrganizationRuntime({
      store: h.store,
      service: h.organization,
      ledger: new InMemoryRunLedger(() => 1),
      owner: "epoch-fixture",
      leaseMs: 500,
      batchSize: 1,
      contentTtlMs: 900,
      resolveActor: h.authentication.resolveEnvelope,
      sink: (request) => host.sink(request),
      launch: (task) => tasks.push(task),
      dispatchOwned: async (request) => {
        started(request);
        await hold;
        return { status: "completed" };
      },
    });
    host = createHomeHost({
      organizationId: "installation",
      organization: h.organization,
      store: h.store,
      directory: h.store.directory,
      authentication: h.authentication,
      runtime,
      now: () => 1,
      policyEpoch: () => "unchanged-config",
      readThread: async () => undefined,
      commands: () => [],
      canReadContext: async () => true,
      sourceIo: () => ({
        reply: async () => {},
        history: async () => [],
        status: async () => ({ update() {}, done: async () => {} }),
      }),
    });
    await h.send("accepted-owner", "mcp:alice:home", true);
    await runtime.reconcile("installation");
    const running = tasks[0]!();
    const request = await original;
    try {
      await h.send("new-valid-scope", "mcp:alice:new-thread");
      await request.io.reply("Accepted owner answer");
      const delivered = await h.organization.streamTail(h.context.authentication);
      expect(delivered.status === "stream_tail" ? delivered.entries.map((entry) => entry.content) : null).toEqual([
        "private fixture",
        "private fixture",
        "Accepted owner answer",
      ]);
      await h.tokens.delete(digestBearer("new-valid-scope"), "personal:alice");
      await expect(request.io.reply("Stale owner answer")).rejects.toThrow();
      const current = await h.organization.streamTail(h.context.authentication);
      expect(current.status === "stream_tail" ? current.entries.map((entry) => entry.content) : null).not.toContain(
        "Stale owner answer",
      );
    } finally {
      finish();
      await running;
    }
  });
  it("keeps the existing epoch while an ordinary admitted message arrives during the complete access scan", async () => {
    const h = await fixture();
    await h.send("same-source");
    const before = await h.epoch(h.context);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    const evaluate = h.authentication.evaluateSourceIdentity;
    const spy = vi.spyOn(h.authentication, "evaluateSourceIdentity").mockImplementationOnce(async (...args) => {
      const decision = await evaluate(...args);
      await h.send("same-source");
      return decision;
    });
    expect(await h.epoch(h.context)).toBe(before);
    const retained = await h.organization.streamTail(h.context.authentication);
    expect(retained.status === "stream_tail" ? retained.entries.map((entry) => entry.content) : null).toEqual([
      "private fixture",
      "private fixture",
    ]);
    spy.mockRestore();
  });
  it("rechecks a newly allowed scope added during the scan without discarding an existing epoch", async () => {
    const h = await fixture();
    await h.send("existing-source");
    const before = await h.epoch(h.context);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    const evaluate = h.authentication.evaluateSourceIdentity;
    const spy = vi.spyOn(h.authentication, "evaluateSourceIdentity").mockImplementationOnce(async (...args) => {
      const decision = await evaluate(...args);
      await h.send("new-source", "mcp:alice:new-context");
      return decision;
    });
    expect(await h.epoch(h.context)).toBe(before);
    const retained = await h.organization.streamTail(h.context.authentication);
    expect(retained.status === "stream_tail" ? retained.entries.map((entry) => entry.content) : null).toEqual([
      "private fixture",
      "private fixture",
    ]);
    spy.mockRestore();
  });
  it("fences a partial retained native policy loss even while the source can still read the organization", async () => {
    const h = await fixture();
    await h.send("native-key");
    const before = await h.epoch(h.context);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    h.narrowSource();
    const after = await h.recreateEpoch()(h.context);
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
    expect(await h.recreateEpoch()(h.context)).toBe(after);
  });
  it("refuses an incomplete second catalogue page instead of certifying the first 200 scopes", async () => {
    const h = await fixture();
    for (let i = 0; i < 201; i++) await h.send(`page-key-${i}`);
    expect(await h.epoch(h.context)).toMatch(/^[0-9a-f]{64}$/);
    const execute = h.store.execute.bind(h.store);
    const spy = vi
      .spyOn(h.store, "execute")
      .mockImplementation((command) =>
        command.action === "source-catalogue" && command.after
          ? Promise.resolve({ status: "unavailable" })
          : execute(command),
      );
    expect(await h.epoch(h.context)).toBeUndefined();
    spy.mockRestore();
  });
  it("detects an older exact credential revocation without a browser, configuration, or binding change", async () => {
    const h = await fixture();
    await h.send("old-key");
    for (let i = 0; i < 105; i++) await h.send("new-key");
    const state = await h.store.execute({ action: "get", organization: "installation" });
    const before = await h.epoch(h.context);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    await h.tokens.delete(digestBearer("old-key"), "personal:alice");
    const after = await h.epoch(h.context);
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
    const unchanged = await h.store.execute({ action: "get", organization: "installation" });
    if (state.status !== "state" || unchanged.status !== "state") throw new Error("state unavailable");
    expect(unchanged.state.accessRevision).toBe(state.state.accessRevision + 1);
  });
  it("keeps ordinary messages on the same exact source stable", async () => {
    const h = await fixture();
    await h.send("one-key");
    const before = await h.epoch(h.context);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    await h.send("one-key");
    expect(await h.epoch(h.context)).toBe(before);
  });
  it("refuses a delayed snapshot when an older source loses access before the final frame check", async () => {
    const h = await fixture();
    await h.send("old-key");
    for (let i = 0; i < 105; i++) await h.send("new-key");
    const tail = h.organization.streamTail.bind(h.organization);
    const spy = vi.spyOn(h.organization, "streamTail").mockImplementationOnce(async (...args) => {
      const stale = await tail(...args);
      await h.tokens.delete(digestBearer("old-key"), "personal:alice");
      return stale;
    });
    const handler = createHomeRuntimeHandler({
      organization: h.organization,
      directory: h.store.directory,
      now: () => 1,
      refresh: async (context) => context,
      currentEpoch: h.epoch,
      readThread: async () => undefined,
      submit: (context, input) => h.organization.admit(context.authentication, input),
      commands: () => [],
      publicBaseUrl: "https://app.test",
    });
    const request = Object.assign(new EventEmitter(), {
      url: "/home/session",
      method: "GET",
      headers: { host: "app.test", accept: "application/json" },
    }) as unknown as IncomingMessage;
    let status = 0,
      body = "",
      finish: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const response = {
      writeHead(value: number) {
        status = value;
      },
      end(value = "") {
        body += value;
        finish();
      },
    } as unknown as ServerResponse;
    expect(handler(request, response, h.context)).toBe(true);
    await ended;
    expect(spy).toHaveBeenCalledOnce();
    expect(status).toBe(404);
    expect(JSON.parse(body)).toEqual({ status: "not_found" });
    expect(body).not.toContain("private fixture");
    spy.mockRestore();
  });
  it("keeps the first browser message stable and refuses unavailable retained credential proof", async () => {
    const h = await fixture();
    const before = await h.epoch(h.context);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    const key = await h.organization.issue(h.context.authentication, 500);
    if (key.status !== "key") throw new Error("no key");
    expect(
      (
        await h.organization.admit(h.context.authentication, {
          key: key.key,
          sourceEvent: "first-browser-message",
          destination: { kind: "broad" },
          workload: "message",
          target: null,
          context: [],
          content: "first message",
        })
      ).status,
    ).toBe("receipt");
    expect(await h.epoch(h.context)).toBe(before);
    await h.send("one-key");
    const unavailable = vi.spyOn(h.tokens, "get").mockRejectedValue(new Error("credential service unavailable"));
    expect(await h.epoch(h.context)).toBeUndefined();
    unavailable.mockRestore();
  });
});
