import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ALL_GRANTS } from "../core/authz/grants.js";
import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";
import { InMemoryOrganizationStore } from "../core/organization/memory.js";
import { OrganizationService } from "../core/organization/service.js";
import { createOrganizationRuntime, type OrganizationExecutionRequest } from "../core/organization/runtime.js";
import { DAY_MS } from "../core/budgets.js";
import { LEASE_MS } from "../core/runLedger/types.js";
import type { ChannelIO, StatusUpdate } from "../core/types.js";
import { createHomeHost } from "./homeHost.js";
import { createOrganizationAuthentication, type NativeOrganizationProof } from "./organizationAuthentication.js";
import type { HomeSession } from "./homeSeed.js";
import type { HomeRuntimeContext } from "./homeRuntime.js";
import { digestBearer, InMemoryPersonalTokenStore } from "../mcp/personalTokens.js";
import { withOriginalOrganizationDispatch } from "../core/dispatch/originalOrganizationInput.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(
  nativeChildOffer = false,
  afterHistory?: (request: OrganizationExecutionRequest) => Promise<void>,
  duringHistoryContext?: () => Promise<void>,
) {
  const identity = { issuer: "https://fixture.test", tenant: null, subject: "alice" };
  const store = new InMemoryOrganizationStore(() => 1000),
    ledger = new InMemoryRunLedger(() => 1000);
  let available = true;
  let organizationMember = true;
  let grants = ALL_GRANTS;
  let policy = "configuration";
  let privateSource = true;
  let uncertain = false;
  const proof = async (): Promise<NativeOrganizationProof> =>
    available
      ? {
          status: "verified",
          identity,
          actorId: "access:alice",
          kind: "human",
          organizationMember,
          privateSource,
          epoch: "verified-session",
        }
      : { status: "fenced" };
  const mappings = [
    { source: "browser" as const, issuer: identity.issuer, tenant: null, organization: "fixture" },
    { source: "mcp" as const, issuer: "installation:mcp", tenant: null, organization: "fixture" },
  ];
  const tokens = new InMemoryPersonalTokenStore();
  const authentication = createOrganizationAuthentication({
    organization: "fixture",
    mappings,
    grantsFor: () => grants,
    auth: () => ({ tokens: {} }),
    directory: store.directory,
    store,
    ledger,
    personalTokens: tokens,
    personalApproval: { issuer: identity.issuer, audience: "fixture-app" },
    currentBrowser: proof,
    currentSlack: proof,
  });
  const msg = { channelId: "web:alice", userId: "access:alice", threadKey: "web:alice:organization", text: "" };
  const resolved = await authentication.resolveBrowser(identity, msg);
  if (resolved.status !== "resolved") throw new Error("fixture authentication failed");
  const context: HomeRuntimeContext = { actor: resolved.actor, authentication: resolved.authentication };
  let host!: ReturnType<typeof createHomeHost>;
  const service = new OrganizationService({
    store,
    directory: store.directory,
    mappings,
    limits: {
      pendingPerActor: 10,
      pendingPerSource: 20,
      pendingPerOrganization: 30,
      reservedReconciliation: 1,
      contentTtlMs: DAY_MS,
      receiptTtlMs: DAY_MS,
    },
    authorize: (input) => host.authorize(input),
    currentIdentityRead: async (source, reference, onBehalfOf) =>
      (await authentication.evaluateSourceIdentity(source, reference, onBehalfOf)).status,
  });
  const tasks: (() => Promise<void>)[] = [],
    history: { role: string; text: string }[][] = [];
  const requests: OrganizationExecutionRequest[] = [];
  const statuses: string[] = [];
  const deliveries: string[] = [];
  class BrowserIo implements ChannelIO {
    async reply() {
      throw new Error("Browser replies must use the durable private stream");
    }
    async history() {
      return [{ role: "user" as const, text: "Deleted raw source history" }];
    }
    async status(update: StatusUpdate) {
      statuses.push(update.title);
      return {
        update(frame: StatusUpdate) {
          deliveries.push(`status:${frame.title}`);
        },
        done: async (frame: StatusUpdate) => {
          deliveries.push(`done:${frame.title}`);
        },
        doneWithReceipt: async (frame: StatusUpdate) => {
          deliveries.push(`receipt:${frame.title}`);
          return { delivered: true, complete: true };
        },
      };
    }
    async uploadTicket() {
      return {
        url: "https://fixture.test/upload",
        complete: async () => {
          deliveries.push("upload");
        },
      };
    }
    async attach() {
      deliveries.push("attach");
    }
    async attachFile() {
      deliveries.push("file");
    }
    async openThread() {
      deliveries.push("thread");
      return {
        thread: { threadKey: "web:alice:child" },
        io: Object.assign(new BrowserIo(), {
          reply: async (text: string) => {
            deliveries.push(`child:${text}`);
          },
          history: async () => [{ role: "user" as const, text: "Child history" }],
          offer: nativeChildOffer
            ? async (offer: import("../core/types.js").ConfirmationOffer) => {
                deliveries.push(`child-offer:${offer.id}`);
              }
            : undefined,
        }),
      };
    }
  }
  const runtime = createOrganizationRuntime({
    store,
    service,
    ledger,
    owner: "fixture-process",
    leaseMs: LEASE_MS,
    batchSize: 10,
    contentTtlMs: DAY_MS,
    resolveActor: authentication.resolveEnvelope,
    sink: (request) => host.sink(request),
    launch: (task) => tasks.push(task),
    dispatchOwned: async (request) => {
      requests.push(request);
      history.push(await host.privateHistory(request));
      await afterHistory?.(request);
      await request.io.status({ title: "Working" });
      await request.io.reply("The recorded reply");
      return { status: uncertain ? "uncertain" : "completed" };
    },
  });
  host = createHomeHost({
    organizationId: "fixture",
    organization: service,
    store,
    directory: store.directory,
    authentication,
    runtime,
    ledger,
    now: () => 1000,
    policyEpoch: () => policy,
    readThread: async () => undefined,
    commands: () => [],
    canReadContext: async () => false,
    ...(duringHistoryContext
      ? {
          historyContext: async () => {
            await duringHistoryContext();
            return undefined;
          },
        }
      : {}),
    sourceIo: (request) =>
      request.envelope.source === "browser"
        ? new BrowserIo()
        : Object.assign(new BrowserIo(), {
            reply: async (text: string) => {
              deliveries.push(`native:${text}`);
            },
          }),
  });
  const server: Server = createServer((req, res) => {
    if (!host.handler(req, res, context)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server");
  const origin = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    host.handler.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const session = async () => {
    const response = await fetch(`${origin}/home/session`);
    return { status: response.status, body: (await response.json()) as HomeSession };
  };
  const send = async (value: HomeSession, text: string) => {
    const response = await fetch(`${origin}/home/send`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        key: value.submissionKey,
        destination: { kind: "broad" },
        revision: value.destination.revision,
        context: [],
        text,
      }),
    });
    return { status: response.status, body: await response.json() };
  };
  const execute = async () => {
    for (let count = 0; count < 40 && !tasks.length; count++) await new Promise((resolve) => setTimeout(resolve, 0));
    const task = tasks.shift();
    if (!task) throw new Error("No original owner admission");
    await task();
  };
  return {
    host,
    ledger,
    authentication,
    tokens,
    store,
    service,
    runtime,
    context,
    origin,
    session,
    send,
    execute,
    history,
    requests,
    statuses,
    deliveries,
    holdOutcome: () => {
      uncertain = true;
    },
    removePrivateSource: () => {
      privateSource = false;
    },
    changePolicy: () => {
      policy = "changed configuration";
    },
    removeOrganizationRead: () => {
      organizationMember = false;
      grants = { ...ALL_GRANTS, actions: new Set(["organization:send"]), organizations: new Set<string>() };
    },
    revoke: () => {
      available = false;
    },
  };
}
describe("Home authenticated host", () => {
  it.each([false, true])("fences a live owner's copied plain-text history after deletion: %s", async (remove) => {
    let entered: () => void = () => {},
      release: () => void = () => {};
    const copying = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = await fixture(false, async (request) => {
      if (request.envelope.content === "Continue B") {
        entered();
        await held;
      }
    });
    await s.send((await s.session()).body, "Private note A");
    await s.execute();
    const sourceA = s.requests[0]!;
    await s.send((await s.session()).body, "Continue B");
    const executing = s.execute();
    await copying;
    const ownerB = s.requests[1]!;
    let before, after;
    try {
      expect(s.history[1]).toEqual([
        { role: "user", text: "Private note A", user: "access:alice" },
        { role: "assistant", text: "The recorded reply" },
      ]);
      const audience = ownerB.io.organizationPrivateAudience!();
      if (!audience) throw new Error("The live owner has no private audience.");
      before = await ownerB.io.verifyOrganizationPrivateAudience!(audience);
      const unchanged = await s.host.currentEpoch(s.context);
      expect(await s.runtime.deleteContent(s.context.authentication, "unknown-receipt")).toEqual({
        status: "ok",
        removed: 0,
      });
      expect(
        await s.runtime.deleteContent(
          {
            ...s.context.authentication,
            identity: { ...s.context.authentication.identity, subject: "foreign" },
          },
          sourceA.receipt.id,
        ),
      ).toEqual({ status: "not_found" });
      expect(await s.host.currentEpoch(s.context)).toBe(unchanged);
      if (remove)
        expect(await s.runtime.deleteContent(s.context.authentication, sourceA.receipt.id)).toEqual({
          status: "ok",
          removed: 2,
        });
      after = await ownerB.io.verifyOrganizationPrivateAudience!(audience);
    } finally {
      release();
      await executing;
    }
    expect(before).toEqual({ ok: true });
    expect(after).toEqual(remove ? { ok: false, code: "direct-audience-unavailable" } : { ok: true });
    const replay = await s.service.replay(s.context.authentication, {
      key: ownerB.envelope.key,
      content: ownerB.envelope.content,
      context: ownerB.envelope.context,
      destination: ownerB.envelope.destination,
      revision: ownerB.envelope.sourceReference?.browserRevision,
    });
    expect(replay).toMatchObject({
      status: "receipt",
      duplicate: true,
      receipt: { id: ownerB.receipt.id, ownerRunId: ownerB.runId },
    });
    expect(s.requests.map((request) => request.runId)).toEqual([sourceA.runId, ownerB.runId]);
    if (remove) {
      const epoch = await s.host.currentEpoch(s.context);
      expect(await s.runtime.deleteContent(s.context.authentication, sourceA.receipt.id)).toEqual({
        status: "ok",
        removed: 0,
      });
      expect(await s.host.currentEpoch(s.context)).toBe(epoch);
      expect(await s.ledger.readIngressByRun(sourceA.runId)).toMatchObject({
        status: "record",
        record: { runId: sourceA.runId, request: null },
      });
    }
    expect(await s.ledger.readIngressByRun(ownerB.runId)).toMatchObject({
      status: "record",
      record: {
        runId: ownerB.runId,
        receiptId: ownerB.receipt.id,
        request: { envelope: { content: "Continue B" } },
        origin: { actor: { identity: ownerB.envelope.actor.identity } },
      },
    });
  });
  it.each([false, true])("fences deletion during private history context loading: %s", async (remove) => {
    let loading = false,
      removed = false;
    const s = await fixture(false, undefined, async () => {
      if (!loading || removed || !remove) return;
      removed = true;
      expect((await s.runtime.deleteContent(s.context.authentication, s.requests[0]!.receipt.id)).status).toBe("ok");
    });
    await s.send((await s.session()).body, "Original input");
    await s.execute();
    await s.send((await s.session()).body, "New input");
    await s.execute();
    loading = true;
    const history = s.host.privateHistory(s.requests[1]!);
    if (remove) await expect(history).rejects.toThrow("unavailable");
    else
      expect(await history).toEqual([
        { role: "user", text: "Original input", user: "access:alice" },
        { role: "assistant", text: "The recorded reply" },
      ]);
    expect(s.requests[1]!.envelope.content).toBe("New input");
  });
  it("keeps opened thread replies and history local while preserving current source checks", async () => {
    const s = await fixture();
    await s.send((await s.session()).body, "Start work");
    await s.execute();
    const child = await s.host.sink(s.requests[0]!).openThread!("Child", "child-key");
    expect(child.thread.threadKey).toBe("web:alice:child");
    await child.io.reply("Child reply");
    expect(s.deliveries).toEqual(["thread", "child:Child reply"]);
    expect(await child.io.history()).toEqual([{ role: "user", text: "Child history" }]);
    expect((await s.session()).body.entries.map((entry) => entry.content)).toEqual([
      "Start work",
      "The recorded reply",
    ]);
    s.revoke();
    await expect(child.io.reply("After revocation")).rejects.toThrow("unavailable");
    expect(s.deliveries).toEqual(["thread", "child:Child reply"]);
  });
  it.each([false, true])("keeps child offers local with native offer capability %s", async (nativeOffer) => {
    const s = await fixture(nativeOffer);
    await s.send((await s.session()).body, "Start work");
    await s.execute();
    const child = await s.host.sink(s.requests[0]!).openThread!("Child", "child-key");
    await child.io.offer!({
      id: "child-confirmation",
      line: "Confirm child work",
      risk: "Changes the child",
      expiresAt: 2000,
    });
    expect(s.deliveries).toEqual(
      nativeOffer
        ? ["thread", "child-offer:child-confirmation"]
        : ["thread", "child:Confirm child work\nChanges the child"],
    );
    expect((await s.session()).body.entries.map((entry) => entry.content)).toEqual([
      "Start work",
      "The recorded reply",
    ]);
  });
  it("preserves original user authors in private history and fences a policy change during the read", async () => {
    const s = await fixture();
    await s.send((await s.session()).body, "Original input");
    await s.execute();
    await s.send((await s.session()).body, "New input");
    await s.execute();
    const request = s.requests[1]!;
    expect(await s.host.privateHistory(request)).toEqual([
      { role: "user", text: "Original input", user: "access:alice" },
      { role: "assistant", text: "The recorded reply" },
    ]);
    const tail = s.service.streamTail.bind(s.service);
    s.service.streamTail = async (...args) => {
      const result = await tail(...args);
      s.changePolicy();
      return result;
    };
    await expect(s.host.privateHistory(request)).rejects.toThrow("unavailable");
  });
  it("supplies only the exact delegated MCP private audience and fences it after current source policy changes", async () => {
    const s = await fixture();
    const digest = digestBearer("fixture-device");
    await s.tokens.put({
      digest,
      subject: "personal:alice",
      email: "unused@example.test",
      userId: "access:alice",
      createdAt: 1000,
      approval: {
        version: 1,
        issuer: "https://fixture.test",
        audience: "fixture-app",
        organization: "fixture",
        subject: "alice",
      },
    });
    const msg = {
      userId: "access:alice",
      authenticatedAs: "mcp:personal:alice",
      channelId: "mcp:alice",
      threadKey: "mcp:alice:home",
      messageId: "native:one",
      text: "Inspect this source",
      approvalConnection: { id: digest, credentialId: "mcp:personal:alice", requestHash: digestBearer("one") },
    };
    const resolved = await s.authentication.resolveNative(msg, {
      source: "mcp",
      identity: { subject: "personal:alice" },
      credentialDigest: digest,
    });
    if (resolved.status !== "resolved" || !resolved.authentication.sourceReference)
      throw new Error("Source proof missing");
    const epoch = await s.host.currentEpoch({ actor: resolved.actor, authentication: resolved.authentication });
    if (!epoch) throw new Error("Source epoch missing");
    resolved.authentication.sourceReference = {
      ...resolved.authentication.sourceReference,
      privateSource: true,
      capturedPrivateEpoch: epoch,
    };
    const admitted = await s.service.admit(resolved.authentication, {
      sourceEvent: msg.messageId,
      key: "native:key",
      workload: "message",
      content: msg.text,
      context: [],
      destination: { kind: "broad" },
      target: null,
    });
    expect(admitted.status).toBe("receipt");
    await s.runtime.reconcile("fixture");
    await s.execute();
    const request = s.requests[0]!;
    const audience = await request.io.organizationPrivateAudience?.();
    expect(audience).toEqual({
      kind: "organization-private",
      organization: "fixture",
      stream: 'mcp:["installation:mcp",null,"personal:alice"]',
      actorId: "mcp:personal:alice",
      userId: "access:alice",
      channelId: "mcp:alice",
      threadKey: "mcp:alice:home",
    });
    expect(await request.io.verifyOrganizationPrivateAudience?.(audience!)).toEqual({ ok: true });
    expect(s.deliveries).toContain("native:The recorded reply");
    expect(
      s.host.sink({ ...request, msg: { ...request.msg, userId: "access:other" } }).organizationPrivateAudience,
    ).toBeUndefined();
    expect(
      s.host.sink({ ...request, msg: { ...request.msg, postedBy: "http:relay" } }).organizationPrivateAudience,
    ).toBeUndefined();
    s.changePolicy();
    expect(await request.io.verifyOrganizationPrivateAudience?.(audience!)).toEqual({
      ok: false,
      code: "direct-audience-unavailable",
    });
  });
  it("rehosts only the retained original input and sends its reply to that input's receipt", async () => {
    const s = await fixture();
    s.holdOutcome();
    await s.send((await s.session()).body, "First request");
    await s.execute();
    await s.send((await s.session()).body, "Second request");
    await s.execute();
    const first = s.requests[0]!,
      second = s.requests[1]!;
    const message = withOriginalOrganizationDispatch(second.msg, {
      ingressRunId: second.runId,
      organizationSequence: second.receipt.revision,
    });
    const rehosted = await first.io.rehostOrganizationInput!(message);
    expect(rehosted?.msg).toMatchObject({ text: "Second request", userId: "access:alice" });
    expect(await rehosted!.io.authoritativePrivateHistory!()).toEqual([
      { role: "user", text: "First request", user: "access:alice" },
      { role: "assistant", text: "The recorded reply" },
    ]);
    await rehosted!.io.reply("Second owner's resumed reply");
    const session = (await s.session()).body;
    expect(session.entries.map((entry) => entry.content)).toEqual([
      "First request",
      "The recorded reply",
      "Second request",
      "The recorded reply",
      "Second owner's resumed reply",
    ]);
    const tail = await s.service.streamTail(s.context.authentication, 20);
    expect(tail.status === "stream_tail" ? tail.entries.at(-1) : null).toMatchObject({
      content: "Second owner's resumed reply",
      receiptId: second.receipt.id,
    });
    expect(await first.io.rehostOrganizationInput!({ ...message, text: "Changed request" })).toBeUndefined();
    expect(await first.io.rehostOrganizationInput!(JSON.parse(JSON.stringify(message)))).toBeUndefined();
    s.revoke();
    expect(await first.io.rehostOrganizationInput!(message)).toBeUndefined();
  });
  it("refuses private history and delivery when the source loses its private audience proof", async () => {
    const s = await fixture();
    await s.send((await s.session()).body, "Private request");
    await s.execute();
    expect(await s.host.privateHistory(s.requests[0]!)).toEqual([]);
    s.removePrivateSource();
    await expect(s.host.privateHistory(s.requests[0]!)).rejects.toThrow("unavailable");
    await expect(s.requests[0]!.io.reply("Private result")).rejects.toThrow("unavailable");
  });
  it("binds its private worker audience to the captured source policy before model input or delivery", async () => {
    const s = await fixture();
    await s.send((await s.session()).body, "Private work");
    await s.execute();
    const request = s.requests[0]!;
    expect(request.envelope.sourceReference).toMatchObject({
      privateSource: true,
      capturedPrivateEpoch: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const audience = request.io.organizationPrivateAudience!();
    expect(audience).toMatchObject({
      kind: "organization-private",
      organization: "fixture",
      actorId: "access:alice",
      userId: "access:alice",
      channelId: "web:alice",
      threadKey: "web:alice:organization",
    });
    expect(await request.io.verifyOrganizationPrivateAudience!(audience!)).toEqual({ ok: true });
    s.changePolicy();
    expect(await request.io.verifyOrganizationPrivateAudience!(audience!)).toEqual({
      ok: false,
      code: "direct-audience-unavailable",
    });
    await expect(s.host.privateHistory(request)).rejects.toThrow("unavailable");
    await expect(request.io.reply("Old checkpoint output")).rejects.toThrow("unavailable");
  });
  it("refuses delayed source delivery after organization read permission is removed", async () => {
    const s = await fixture();
    await s.send((await s.session()).body, "Hello");
    await s.execute();
    const io = s.requests[0]!.io;
    const ticket = await io.uploadTicket!({ name: "recording.mp4", size: 42 });
    const status = await io.status({ title: "Uploading" });
    const child = await io.openThread!("Child work");
    s.deliveries.length = 0;
    s.removeOrganizationRead();
    await expect(ticket.complete("Done")).rejects.toThrow("unavailable");
    await expect(io.attach!({ name: "result.txt", text: "Private bytes", lead: "Result" })).rejects.toThrow(
      "unavailable",
    );
    await expect(io.attachFile!({ name: "result.png", bytes: new Uint8Array([42]), lead: "Result" })).rejects.toThrow(
      "unavailable",
    );
    await expect(io.openThread!("Late child")).rejects.toThrow("unavailable");
    await expect(child.io.history()).rejects.toThrow("unavailable");
    await expect(child.io.status({ title: "Private child status" })).rejects.toThrow("unavailable");
    status.update({ title: "Private update" });
    await expect(status.done({ title: "Private done" })).rejects.toThrow("unavailable");
    await expect(status.doneWithReceipt!({ title: "Private receipt" })).rejects.toThrow("unavailable");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.deliveries).toEqual([]);
  });
  it("admits through HTTP once, keeps its original run, and preserves prototype-backed IO", async () => {
    const s = await fixture();
    const initial = await s.session();
    expect(initial.status).toBe(200);
    const epoch = initial.body.accessEpoch;
    const first = await s.send(initial.body, "Hello");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "pending", duplicate: false });
    await s.execute();
    const retry = await s.send(initial.body, "Hello");
    expect(retry.body).toMatchObject({ status: "accepted", duplicate: true });
    expect(s.requests).toHaveLength(1);
    expect(await s.runtime.readOwner(s.requests[0]!.receipt.effectKey!)).toMatchObject({
      status: "record",
      record: { runId: s.requests[0]!.runId, status: "completed" },
    });
    expect(s.statuses).toEqual(["Working"]);
    const read = await s.session();
    expect(read.body.accessEpoch).toBe(epoch);
    expect(read.body.entries.map((entry) => entry.content)).toEqual(["Hello", "The recorded reply"]);
    expect(s.history).toEqual([[]]);
  });
  it("removes private content from the next owned input and refuses a late reply after revocation", async () => {
    const s = await fixture();
    const initial = await s.session();
    await s.send(initial.body, "Private first message");
    await s.execute();
    const removed = await fetch(`${s.origin}/home/messages/${encodeURIComponent(s.requests[0]!.receipt.id)}`, {
      method: "DELETE",
      headers: { origin: s.origin },
    });
    expect(removed.status).toBe(200);
    const next = await s.session();
    expect(next.body.entries).toEqual([]);
    expect((await s.send(next.body, "Next message")).status).toBe(200);
    await s.execute();
    expect(s.history).toEqual([[], []]);
    s.revoke();
    await expect(s.requests[1]!.io.reply("Late private reply")).rejects.toThrow("unavailable");
    expect((await s.session()).status).toBe(404);
  });
});
