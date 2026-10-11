// Feature: docs/reference/specs/browser-home.md — authenticated browser sessions, retries and revocation.
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actor } from "../core/authz/testing.js";
import { InMemoryOrganizationStore } from "../core/organization/memory.js";
import { OrganizationService } from "../core/organization/service.js";
import { CONFIRMATION_TTL_MS, DAY_MS, RUN_VIEW_POLL_MS } from "../core/budgets.js";
import type { HomeSession } from "./homeSeed.js";
import { createHomeRuntimeHandler, type HomeRuntimeContext, type HomeThreadProjection } from "./homeRuntime.js";

const credential = actor("user", "access:alice", { actions: "all", channels: "all", repos: "all" });
const identity = { issuer: "access:test", tenant: null, subject: "alice" };
const context: HomeRuntimeContext = {
  actor: credential,
  authentication: {
    source: "browser",
    kind: "human",
    identity,
    sourceReference: {
      actorId: "access:alice",
      userId: "access:alice",
      channelId: "web:alice",
      threadKey: "web:alice:organization",
    },
  },
};
const requests: EventEmitter[] = [];
afterEach(() => {
  for (const request of requests.splice(0)) request.emit("close");
  vi.useRealTimers();
});
function request(url: string, body?: unknown, headers: Record<string, string> = {}) {
  const input = Object.assign(new EventEmitter(), {
    url,
    method: body === undefined ? "GET" : "POST",
    headers: {
      host: "app.test",
      accept: "application/json",
      ...(body === undefined ? {} : { origin: "https://app.test", "content-type": "application/json" }),
      ...headers,
    },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  });
  requests.push(input);
  return input as unknown as IncomingMessage;
}
function response() {
  let status = 0,
    body = "",
    finish: () => void = () => {},
    dataReady: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const firstData = new Promise<void>((resolve) => {
    dataReady = resolve;
  });
  return {
    ended,
    firstData,
    value: () => ({ status, body }),
    res: {
      writeHead(value: number) {
        status = value;
      },
      write(value: string) {
        body += value;
        if (value.includes("data:")) dataReady();
        return true;
      },
      end(value = "") {
        body += value;
        dataReady();
        finish();
      },
    } as unknown as ServerResponse,
  };
}
function fixture(options: { maxBodyBytes?: number; currentOffer?: () => Promise<undefined> } = {}) {
  const store = new InMemoryOrganizationStore(() => 1000);
  const service = new OrganizationService({
    store,
    directory: store.directory,
    mappings: [{ source: "browser", issuer: "access:test", tenant: null, organization: "installation" }],
    limits: {
      pendingPerActor: 10,
      pendingPerSource: 20,
      pendingPerOrganization: 30,
      reservedReconciliation: 1,
      contentTtlMs: DAY_MS,
      receiptTtlMs: DAY_MS,
    },
    authorize: async () => true,
    currentIdentityRead: async (source) => (source.issuer === "access:test" ? "allowed" : "denied"),
  });
  let readable = true,
    threadReadable = true,
    epoch = "fixture:policy",
    changed: (organization: string) => void = () => {};
  const thread: HomeThreadProjection = {
    label: "Shared unit thread",
    revision: 7,
    canWrite: true,
    entries: [
      {
        id: "source:1",
        role: "user",
        content: "A teammate's request",
        isViewer: false,
        authorLabel: "Morgan",
        source: "slack",
      },
    ],
    history: { cursor: 1, hasMore: false, status: "complete" },
  };
  const submissions: HomeRuntimeContext[] = [];
  const handler = createHomeRuntimeHandler({
    organization: service,
    directory: store.directory,
    now: () => 1000,
    refresh: async (current) => (readable ? current : undefined),
    currentEpoch: async () => epoch,
    readThread: async (_current, key) => (readable && threadReadable && key === "slack:C1:thread" ? thread : undefined),
    submit: async (current, input) => {
      submissions.push(current);
      return service.admit(current.authentication, input);
    },
    deleteContent: (current, receiptId) => service.delete(current.authentication, receiptId),
    commands: () => [],
    ...(options.maxBodyBytes ? { maxBodyBytes: options.maxBodyBytes } : {}),
    ...(options.currentOffer ? { currentOffer: options.currentOffer } : {}),
    keyTtlMs: CONFIRMATION_TTL_MS,
    publicBaseUrl: "https://app.test",
    subscribe: (listener) => {
      changed = listener;
      return () => {
        changed = () => {};
      };
    },
  });
  async function read(
    url: string,
    body?: unknown,
    current: HomeRuntimeContext | undefined = context,
    headers?: Record<string, string>,
  ) {
    const output = response();
    expect(handler(request(url, body, headers), output.res, current)).toBe(true);
    await output.ended;
    return { ...output.value(), json: JSON.parse(output.value().body) as Record<string, unknown> };
  }
  return {
    store,
    service,
    handler,
    read,
    submissions,
    thread,
    revokeThread: () => {
      threadReadable = false;
      changed("installation");
    },
    changeEpoch: () => {
      epoch = "fixture:other-source-revoked";
      changed("installation");
    },
    revoke: () => {
      readable = false;
      changed("installation");
    },
  };
}

describe("authenticated browser organization runtime", () => {
  it("follows server event URLs for authorized read-only threads and view-as", async () => {
    vi.useFakeTimers();
    for (const viewer of [context, { ...context, actor: { ...credential, viewingAs: { id: "slack:UBOB" } } }]) {
      const h = fixture();
      h.thread.canWrite = false;
      const session = (await h.read("/home/session?thread=slack%3AC1%3Athread", undefined, viewer))
        .json as unknown as HomeSession;
      expect(session.destination.canWrite).toBe(false);
      const stream = response();
      h.handler(request(session.eventsUrl), stream.res, viewer);
      await stream.firstData;
      await vi.advanceTimersByTimeAsync(RUN_VIEW_POLL_MS);
      expect(stream.value().body).toContain(": hb");
      expect(stream.value().body).not.toContain("event: revoked");
      expect(session.eventsUrl).toBe("/home/events?thread=slack%3AC1%3Athread&observe=1");
      h.handler.dispose();
      await stream.ended;
    }
  });
  it("keeps explicit observation in every emitted session and reopened stream", async () => {
    vi.useFakeTimers();
    const h = fixture(),
      first = response();
    h.handler(request("/home/events?thread=slack%3AC1%3Athread&observe=1"), first.res, context);
    await first.firstData;
    const frame = JSON.parse(first.value().body.match(/data: (.+)/)![1]) as HomeSession;
    expect(frame.destination.canWrite).toBe(true);
    expect(frame.eventsUrl).toBe("/home/events?thread=slack%3AC1%3Athread&observe=1");
    const reopened = response();
    h.handler(request(frame.eventsUrl), reopened.res, context);
    await reopened.firstData;
    h.thread.canWrite = false;
    await vi.advanceTimersByTimeAsync(RUN_VIEW_POLL_MS);
    expect(reopened.value().body).toContain('"canWrite":false');
    expect(reopened.value().body).not.toContain("event: revoked");
    expect((await h.read("/home/session?thread=slack%3AC1%3Athread&observe=1")).json.eventsUrl).toBe(frame.eventsUrl);
    h.handler.dispose();
  });
  it("revokes a writable focused stream when write permission is lost", async () => {
    vi.useFakeTimers();
    const h = fixture();
    const focused = (await h.read("/home/focus", { thread: "slack:C1:thread" })).json as unknown as HomeSession;
    expect(focused.eventsUrl).toBe("/home/events?thread=slack%3AC1%3Athread");
    const stream = response();
    h.handler(request(focused.eventsUrl), stream.res, context);
    await stream.firstData;
    h.thread.canWrite = false;
    await vi.advanceTimersByTimeAsync(RUN_VIEW_POLL_MS);
    await stream.ended;
    expect(stream.value().body).toContain("event: revoked\n");
  });
  it("preserves broad event URLs and reads when key issuance is unavailable", async () => {
    vi.useFakeTimers();
    for (const readonly of [false, true]) {
      const h = fixture();
      if (readonly) vi.spyOn(h.service, "issue").mockResolvedValue({ status: "unavailable" });
      const session = (await h.read("/home/session")).json as unknown as HomeSession;
      expect(session.eventsUrl).toBe("/home/events");
      expect(session.destination.canWrite).toBe(!readonly);
      const stream = response();
      h.handler(request(session.eventsUrl), stream.res, context);
      await stream.firstData;
      await vi.advanceTimersByTimeAsync(RUN_VIEW_POLL_MS);
      expect(stream.value().body).toContain(": hb");
      expect(stream.value().body).not.toContain("event: revoked");
      h.handler.dispose();
    }
  });
  it("revokes observer streams on current thread read or privacy loss", async () => {
    for (const loss of ["read", "epoch"]) {
      const h = fixture(),
        stream = response();
      h.handler(request("/home/events?thread=slack%3AC1%3Athread&observe=1"), stream.res, context);
      await stream.firstData;
      if (loss === "read") h.revokeThread();
      else h.changeEpoch();
      await stream.ended;
      expect(stream.value().body).toContain("event: revoked\n");
      h.handler.dispose();
    }
    const refused = await fixture().read("/home/session?thread=slack%3Ahidden%3Athread");
    expect(refused.status).toBe(404);
    expect(refused.json).toEqual({ status: "not_found" });
  });

  it("loads only the admitted organization and private actor while client identity claims select no authority", async () => {
    const h = fixture();
    const loaded = await h.read("/home/session?organization=other&actor=access:bob&person=person:bob");
    expect(loaded.status).toBe(200);
    expect(loaded.json).toMatchObject({
      version: 1,
      organization: "installation",
      actor: "access:alice",
      bindingRevision: 0,
      entries: [],
      destination: { kind: "broad", thread: null, canWrite: true },
    });
    const refused = await h.read("/home/session", undefined, {
      ...context,
      authentication: { ...context.authentication, identity: { ...identity, issuer: "foreign" } },
    });
    expect(refused.status).toBe(404);
    expect(refused.json).toEqual({ status: "not_found" });
  });
  it("replays the same browser body and key through durable admission while preserving the credential actor", async () => {
    const h = fixture();
    const loadedResponse = await h.read("/home/session");
    expect(loadedResponse.status).toBe(200);
    const loaded = loadedResponse.json as unknown as HomeSession;
    const body = {
      text: "A private request",
      key: loaded.submissionKey,
      destination: { kind: "broad" },
      revision: loaded.destination.revision,
      context: [],
    };
    expect((await h.read("/home/send", body)).json).toMatchObject({ status: "pending", duplicate: false });
    expect((await h.read("/home/send", body)).json).toMatchObject({ status: "pending", duplicate: true });
    expect((await h.read("/home/send", { ...body, text: "Different request" })).status).toBe(409);
    expect(h.submissions[0].actor).toBe(credential);
    const transcript = (await h.read("/home/session")).json as unknown as HomeSession;
    expect(transcript.entries).toEqual([
      {
        id: expect.any(String),
        role: "user",
        content: "A private request",
        isViewer: true,
        authorLabel: "You",
        source: "browser",
        at: 1000,
        deleteUrl: expect.stringMatching(/^\/home\/messages\//),
      },
    ]);
    const other = {
      ...context,
      actor: actor("user", "access:bob", { actions: "all", channels: "all", repos: "all" }),
      authentication: { ...context.authentication, identity: { ...identity, subject: "bob" } },
    };
    expect((await h.read("/home/session", undefined, other)).json.entries).toEqual([]);
  });
  it("removes only an owned private receipt through the protected removal endpoint", async () => {
    const h = fixture();
    const initial = (await h.read("/home/session")).json as unknown as HomeSession;
    await h.read("/home/send", {
      text: "Private bytes",
      key: initial.submissionKey,
      destination: { kind: "broad" },
      revision: 0,
      context: [],
    });
    const loaded = (await h.read("/home/session")).json as unknown as HomeSession;
    const address = loaded.entries[0].deleteUrl;
    expect(address).toMatch(/^\/home\/messages\//);
    const removed = response();
    const req = request(address!, undefined, { origin: "https://app.test" });
    req.method = "DELETE";
    expect(h.handler(req, removed.res, context)).toBe(true);
    await removed.ended;
    expect(removed.value().status).toBe(200);
    expect((await h.read("/home/session")).json.entries).toEqual([]);
  });
  it("labels an older authorized window as partial and returns a latest control", async () => {
    const h = fixture();
    const initial = (await h.read("/home/session")).json as unknown as HomeSession;
    await h.read("/home/send", {
      text: "Earlier bytes",
      key: initial.submissionKey,
      destination: { kind: "broad" },
      revision: 0,
      context: [],
    });
    const older = (await h.read("/home/session?before=999")).json as unknown as HomeSession;
    expect(older.entries[0].content).toBe("Earlier bytes");
    expect(older.history).toMatchObject({ status: "partial", latestUrl: "/home/session" });
  });
  it("pages byte-clipped private history from the oldest visible entry without skipping retained bytes", async () => {
    const h = fixture({ maxBodyBytes: 18 });
    for (const text of ["First bytes", "Second bytes", "Third bytes"]) {
      const key = await h.service.issue(context.authentication, CONFIRMATION_TTL_MS);
      if (key.status !== "key") throw new Error("missing issued key");
      await h.service.admit(context.authentication, {
        sourceEvent: key.key,
        key: key.key,
        destination: { kind: "broad" },
        workload: "message",
        target: null,
        content: text,
        context: [],
      });
    }
    const latest = (await h.read("/home/session")).json as unknown as HomeSession;
    expect(latest.entries.map((entry) => entry.content)).toEqual(["Third bytes"]);
    expect(latest.history).toMatchObject({ cursor: 3, previousUrl: "/home/session?before=3", status: "partial" });
    const older = (await h.read(latest.history!.previousUrl!)).json as unknown as HomeSession;
    expect(older.entries.map((entry) => entry.content)).toEqual(["Second bytes"]);
    const oldest = (await h.read(older.history!.previousUrl!)).json as unknown as HomeSession;
    expect(oldest.entries.map((entry) => entry.content)).toEqual(["First bytes"]);
    expect(oldest.history).toMatchObject({ status: "partial", latestUrl: "/home/session" });
  });
  it("focuses only a currently authorized explicit foreign thread and refuses cross-site sends before admission", async () => {
    const h = fixture();
    const focused = await h.read("/home/focus", { thread: "slack:C1:thread" });
    expect(focused.status).toBe(200);
    expect(focused.json).toMatchObject({
      actor: "access:alice",
      entries: [{ isViewer: false, authorLabel: "Morgan", source: "slack" }],
      destination: { kind: "thread", thread: "slack:C1:thread", revision: 7, canWrite: true },
    });
    const wrong = await h.read("/home/focus", { thread: "slack:hidden:thread" });
    expect(wrong.status).toBe(404);
    const rejected = await h.read(
      "/home/send",
      { text: "Cross-site", key: "unknown", destination: { kind: "broad" }, revision: 0, context: [] },
      context,
      { origin: "https://foreign.test" },
    );
    expect(rejected.status).toBe(403);
    expect(h.submissions).toEqual([]);
  });
  it("answers the server-selected question act while preserving the browser source and stable issued message identity", async () => {
    const h = fixture();
    h.thread.target = { key: "unit:question:7", revision: 1 };
    await h.store.execute({ action: "observe", organization: "installation", target: "unit:question:7", revision: 1 });
    const focused = (await h.read("/home/focus", { thread: "slack:C1:thread" })).json as unknown as HomeSession;
    const body = {
      text: "Answer this question",
      key: focused.submissionKey,
      destination: { kind: "thread", thread: "slack:C1:thread" },
      revision: 7,
      context: [],
    };
    expect((await h.read("/home/send", body)).json).toMatchObject({ status: "pending", duplicate: false });
    expect(h.submissions[0].authentication.sourceReference).toEqual({
      actorId: "access:alice",
      userId: "access:alice",
      channelId: "web:alice",
      threadKey: "slack:C1:thread",
      messageId: `browser:${focused.submissionKey}`,
      browserRevision: 7,
    });
    const unknown = { ...body, key: (await h.read("/home/key")).json.key, revision: 6 };
    expect((await h.read("/home/send", unknown)).status).toBe(409);
    expect(h.submissions).toHaveLength(1);
    h.thread.canWrite = false;
    const readable = await h.read("/home/session?thread=slack%3AC1%3Athread");
    expect(readable.status).toBe(200);
    expect(readable.json).toMatchObject({
      destination: { canWrite: false },
      entries: [{ content: "A teammate's request" }],
    });
    expect((await h.read("/home/focus", { thread: "slack:C1:thread" })).status).toBe(404);
  });
  it("keeps saved choices separate from changed question revisions and rejects client context for a saved action", async () => {
    const h = fixture();
    h.thread.target = { key: "unit:question:7", revision: 1 };
    h.thread.offer = { id: "00000000-0000-4000-8000-000000000001", line: "Saved action", expiresAt: 2000 };
    const focused = (await h.read("/home/focus", { thread: "slack:C1:thread" })).json as unknown as HomeSession;
    const body = {
      confirmation: { kind: "confirm", id: "00000000-0000-4000-8000-000000000001" },
      key: focused.submissionKey,
      destination: { kind: "thread", thread: "slack:C1:thread" },
      revision: 6,
      context: [],
    };
    expect((await h.read("/home/send", { ...body, context: [{ kind: "unit", key: "other" }] })).status).toBe(400);
    expect((await h.read("/home/send", body)).json).toMatchObject({ status: "pending", duplicate: false });
    expect((await h.read("/home/send", body)).json).toMatchObject({ status: "pending", duplicate: true });
  });
  it("replays the exact original disposition after a question changes and write access becomes read-only", async () => {
    const h = fixture();
    h.thread.target = { key: "unit:question:7", revision: 1 };
    await h.store.execute({ action: "observe", organization: "installation", target: "unit:question:7", revision: 1 });
    const focused = (await h.read("/home/focus", { thread: "slack:C1:thread" })).json as unknown as HomeSession;
    const body = {
      text: "Original answer",
      key: focused.submissionKey,
      destination: { kind: "thread", thread: "slack:C1:thread" },
      revision: 7,
      context: [],
    };
    const original = await h.read("/home/send", body);
    expect(original.json).toMatchObject({ status: "pending", duplicate: false });
    h.thread.target = { key: "unit:question:8", revision: 1 };
    h.thread.revision = 8;
    h.thread.canWrite = false;
    const replayed = await h.read("/home/send", body);
    expect(replayed.status).toBe(200);
    expect(replayed.json).toEqual({ ...original.json, duplicate: true });
    expect((await h.read("/home/send", { ...body, text: "Changed answer" })).status).toBe(409);
    expect((await h.read("/home/send", { ...body, revision: 8 })).status).toBe(409);
    expect(h.submissions).toHaveLength(1);
  });
  it("never projects the actual admin's personal bytes while viewing as but permits an authorized read-only target", async () => {
    const h = fixture();
    const initial = (await h.read("/home/session")).json as unknown as HomeSession;
    await h.read("/home/send", {
      text: "Admin private bytes",
      key: initial.submissionKey,
      destination: { kind: "broad" },
      revision: 0,
      context: [],
    });
    const viewed = { ...context, actor: { ...credential, viewingAs: { id: "slack:UBOB" } } };
    const broad = await h.read("/home/session", undefined, viewed);
    expect(broad.status).toBe(404);
    expect(broad.body).not.toContain("Admin private bytes");
    const target = await h.read("/home/session?thread=slack%3AC1%3Athread", undefined, viewed);
    expect(target.status).toBe(200);
    expect(target.json).toMatchObject({
      entries: [{ content: "A teammate's request" }],
      destination: { canWrite: false },
      submissionKey: "read-only",
    });
    const observer = response();
    h.handler(request("/home/events?thread=slack%3AC1%3Athread&observe=1"), observer.res, viewed);
    await observer.firstData;
    expect(observer.value().status).toBe(200);
    expect(observer.value().body).not.toContain("Admin private bytes");
    h.handler.dispose();
  });
  it("refuses a delayed private snapshot after another proved source changes access", async () => {
    let release: () => void = () => {},
      entered: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const h = fixture({
      currentOffer: async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return undefined;
      },
    });
    const reading = h.read("/home/session");
    await waiting;
    h.changeEpoch();
    release();
    expect((await reading).status).toBe(404);
  });
  it("does not start a private stream after its viewer disconnected during the first authorized read", async () => {
    let release: () => void = () => {},
      entered: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const h = fixture({
      currentOffer: async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return undefined;
      },
    });
    const req = request("/home/events"),
      output = response();
    h.handler(req, output.res, context);
    await waiting;
    req.emit("close");
    release();
    await output.firstData;
    expect(output.value()).toEqual({ status: 0, body: "" });
    h.handler.dispose();
  });
  it("revokes on another proved source epoch even when the browser binding has not changed and ends disposed streams", async () => {
    const h = fixture(),
      output = response();
    h.handler(request("/home/events"), output.res, context);
    await output.firstData;
    h.changeEpoch();
    await output.ended;
    expect(output.value().body).toContain("event: revoked");
    const next = response();
    h.handler(request("/home/events"), next.res, context);
    await next.firstData;
    h.handler.dispose();
    await next.ended;
    expect(next.value().body).toContain('"accessEpoch":"fixture:other-source-revoked"');
  });
  it("revokes both broad and unfocused thread streams after a fresh policy check", async () => {
    vi.useFakeTimers();
    for (const path of ["/home/events", "/home/events?thread=slack%3AC1%3Athread&observe=1"]) {
      const h = fixture(),
        output = response();
      expect(h.handler(request(path), output.res, context)).toBe(true);
      await output.firstData;
      expect(output.value().status).toBe(200);
      h.revoke();
      await vi.advanceTimersByTimeAsync(RUN_VIEW_POLL_MS);
      await output.ended;
      expect(output.value().body).toContain("event: revoked\n");
      expect((await h.read("/home/session")).status).toBe(404);
    }
  });
});
