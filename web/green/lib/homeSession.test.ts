// Feature: docs/reference/specs/browser-home.md — one authorized destination and retry identity.
import { describe, expect, it, vi } from "vitest";
import type { HomeSession } from "@core/channels/homeSeed.js";
import { createHomeSession, isHomeSession } from "./homeSession";
import { fakeEventSourceFactory } from "../../src/testing/fakeEventSource";

function session(over: Partial<HomeSession> = {}): HomeSession {
  return {
    version: 1,
    organization: "org:a",
    actor: "access:alice",
    stream: "person:alice",
    bindingRevision: 0,
    accessEpoch: "fixture:current-source",
    revision: 4,
    entries: [],
    sendUrl: "/home/send",
    eventsUrl: "/home/events",
    commands: [],
    submissionKey: "issued:one",
    destination: { kind: "broad", label: "Your messages to Switchboard", thread: null, revision: 4, canWrite: true },
    ...over,
  };
}
function focused(): HomeSession {
  return session({
    submissionKey: "issued:thread",
    eventsUrl: "/home/events?thread=slack%3AC1%3A1",
    destination: { kind: "thread", label: "Unit A thread", thread: "slack:C1:1", revision: 9, canWrite: true },
  });
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function harness(answers: Array<Response | Error | Promise<Response>>) {
  const stream = fakeEventSourceFactory();
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => {
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    if (!answer) throw new Error("unexpected request");
    return await answer;
  });
  const home = createHomeSession(fetcher as unknown as typeof fetch, stream.factory);
  home.routeChanged("/runs/unit/a");
  return { home, fetcher, stream };
}
function body(fetcher: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  return JSON.parse((fetcher.mock.calls[index][1] as RequestInit).body as string) as Record<string, unknown>;
}

describe("Home conversation destination", () => {
  it("accepts display entries without private storage fields and refuses malformed attribution frames", async () => {
    const entry = {
      id: "thread:one",
      role: "user",
      content: "Shared message",
      isViewer: false,
      authorLabel: "Other person",
      source: "Slack",
      sourceUrl: "https://example.com/thread",
      at: 1,
    };
    const projected = { ...session(), entries: [entry] };
    expect(isHomeSession(projected)).toBe(true);
    const { home, stream } = harness([json(projected)]);
    await home.load();
    expect(home.session.value?.entries[0].content).toBe("Shared message");
    for (const broken of [
      { isViewer: "yes" },
      { id: null },
      { content: null },
      { authorLabel: 5 },
      { source: 5 },
      { sourceUrl: 5 },
      { at: "now" },
    ]) {
      stream.created.at(-1)?.emitMessage({ ...projected, revision: 5, entries: [{ ...entry, ...broken }] });
      expect(home.session.value?.revision).toBe(4);
    }
    stream.created
      .at(-1)
      ?.emitMessage({ ...projected, revision: 5, entries: [{ ...entry, content: "Confirmed update" }] });
    expect(home.session.value?.entries[0].content).toBe("Confirmed update");
    home.dispose();
  });
  it("reserves an uncertain key after an edited intent succeeds before a third message", async () => {
    const { home, fetcher } = harness([
      json(session()),
      new Error("timeout"),
      json({ key: "issued:two" }),
      json({ status: "accepted" }),
      json({ key: "issued:three" }),
      json({ status: "accepted" }),
    ]);
    await home.load();
    home.text.value = "First request";
    await home.submit();
    home.text.value = "Edited request";
    await home.submit();
    home.text.value = "Third request";
    await home.submit();
    expect(body(fetcher, 1).key).toBe("issued:one");
    expect(body(fetcher, 3).key).toBe("issued:two");
    const posts = fetcher.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(init!.body as string));
    expect(posts).toEqual([
      { text: "First request", destination: { kind: "broad" }, revision: 4, context: [], key: "issued:one" },
      { text: "Edited request", destination: { kind: "broad" }, revision: 4, context: [], key: "issued:two" },
      { text: "Third request", destination: { kind: "broad" }, revision: 4, context: [], key: "issued:three" },
    ]);
    expect(home.notice.value).toBe("Message accepted.");
    home.dispose();
  });
  it("clears the active transcript when access is revoked during a pending focus and refuses its late response", async () => {
    let finish: (value: Response) => void = () => {};
    const pending = new Promise<Response>((done) => {
      finish = done;
    });
    const { home, stream } = harness([json(session()), pending]);
    await home.load();
    home.text.value = "Private draft";
    const focusing = home.focus("slack:C1:1");
    stream.created[0].emitNamed("revoked");
    expect(home.status.value).toBe("unavailable");
    expect(home.text.value).toBe("");
    finish(json(focused()));
    expect(await focusing).toBe(false);
    expect(home.session.value).toBe(null);
    expect(home.notice.value).toBe("Conversation is unavailable with your current access.");
    home.dispose();
  });
  it("finishes the initial broad load when route resolution arrives before its response", async () => {
    let finish: (value: Response) => void = () => {};
    const pending = new Promise<Response>((done) => {
      finish = done;
    });
    const { home } = harness([pending]);
    const loading = home.load();
    home.routeChanged("/home");
    finish(json(session()));
    await loading;
    expect(home.status.value).toBe("ready");
    expect(home.session.value?.destination.label).toBe("Your messages to Switchboard");
    home.dispose();
  });
  it("purges private drafts and retries when a stable actor changes stream or binding epoch", async () => {
    const { home, stream, fetcher } = harness([
      json(session()),
      new Error("timeout"),
      json(session({ stream: "person:bob", bindingRevision: 1 })),
      json({ status: "accepted" }),
    ]);
    await home.load();
    home.text.value = "Person A secret";
    home.scroll.value = 420;
    home.attach({ kind: "unit", key: "a", label: "A" });
    await home.submit();
    stream.created.at(-1)?.emitMessage(session({ revision: 5, stream: "person:bob", bindingRevision: 1 }));
    expect({
      status: home.status.value,
      text: home.text.value,
      scroll: home.scroll.value,
      context: home.context.value,
      session: home.session.value,
    }).toEqual({ status: "unavailable", text: "", scroll: 0, context: [], session: null });
    await home.load();
    expect(home.session.value?.stream).toBe("person:bob");
    expect(home.text.value).toBe("");
    home.text.value = "Person B request";
    await home.submit();
    expect(body(fetcher, 3).text).toBe("Person B request");
    expect(body(fetcher, 3).context).toEqual([]);
    home.dispose();
  });
  it("clears an accepted raw slash command after navigation", async () => {
    let finish: (response: Response) => void = () => {};
    const pending = new Promise<Response>((done) => {
      finish = done;
    });
    const { home, fetcher } = harness([json(session({ commands: [{ chat: "help", describe: "Help" }] })), pending]);
    await home.load();
    home.text.value = "/help";
    const sent = home.submit();
    home.routeChanged("/home");
    finish(json({ status: "accepted" }));
    await sent;
    expect(body(fetcher, 1).text).toBe("help");
    expect(home.text.value).toBe("");
    home.dispose();
  });
  it("purges a same-stream draft when the authenticated binding revision changes", async () => {
    const { home } = harness([json(session()), json(session({ bindingRevision: 1 }))]);
    await home.load();
    home.text.value = "Old binding draft";
    home.scroll.value = 420;
    await home.load();
    expect(home.session.value?.bindingRevision).toBe(1);
    expect({ text: home.text.value, scroll: home.scroll.value }).toEqual({ text: "", scroll: 0 });
    home.dispose();
  });
  it("refuses a focused response from a different private stream without retaining its prior draft", async () => {
    const { home } = harness([json(session()), json({ ...focused(), stream: "person:bob", bindingRevision: 1 })]);
    await home.load();
    home.text.value = "Private A";
    expect(await home.focus("slack:C1:1")).toBe(false);
    expect(home.status.value).toBe("unavailable");
    expect(home.text.value).toBe("");
    expect(home.session.value).toBe(null);
    home.dispose();
  });
  it("fences superseded and disposed broad-load responses independently of navigation", async () => {
    let finish: (value: Response) => void = () => {};
    const old = new Promise<Response>((done) => {
      finish = done;
    });
    const { home } = harness([old, json(session({ stream: "person:bob", bindingRevision: 1 }))]);
    const first = home.load();
    await home.load();
    finish(json(session()));
    await first;
    expect(home.session.value?.stream).toBe("person:bob");
    expect(home.status.value).toBe("ready");
    home.dispose();
    let finishDisposed: (value: Response) => void = () => {};
    const pending = new Promise<Response>((done) => {
      finishDisposed = done;
    });
    const closed = harness([pending]).home;
    const loading = closed.load();
    closed.dispose();
    finishDisposed(json(session()));
    await loading;
    expect(closed.status.value).toBe("unavailable");
    expect(closed.notice.value).toBe("Conversation closed.");
    expect(closed.session.value).toBe(null);
  });
  it("retains a different current draft when a previous slash command is accepted after navigation", async () => {
    let finish: (value: Response) => void = () => {};
    const pending = new Promise<Response>((done) => {
      finish = done;
    });
    const { home } = harness([json(session({ commands: [{ chat: "help", describe: "Help" }] })), pending]);
    await home.load();
    home.text.value = "/help";
    const sent = home.submit();
    home.routeChanged("/home");
    home.text.value = "A different unsent request";
    home.attach({ kind: "unit", key: "b", label: "B" });
    home.routeChanged("/costs");
    finish(json({ status: "accepted" }));
    await sent;
    expect(home.text.value).toBe("A different unsent request");
    expect(home.context.value).toEqual([{ kind: "unit", key: "b", label: "B" }]);
    home.dispose();
  });
  it("preserves a broad draft while an explicit local reply uses only the authorized thread", async () => {
    const { home, fetcher } = harness([json(session()), json(focused()), json({ status: "accepted", revision: 10 })]);
    await home.load();
    home.text.value = "Broad question";
    home.attach({ kind: "unit", key: "a", label: "Unit A" });
    expect(await home.focus("slack:C1:1")).toBe(true);
    home.text.value = "Local answer";
    await home.submit();
    expect(body(fetcher, 2)).toEqual({
      text: "Local answer",
      destination: { kind: "thread", thread: "slack:C1:1" },
      revision: 9,
      context: [],
      key: "issued:thread",
    });
    expect(home.notice.value).toBe("Message accepted.");
    home.routeChanged("/home");
    expect(home.session.value?.destination.label).toBe("Your messages to Switchboard");
    expect(home.text.value).toBe("Broad question");
    expect(home.context.value).toEqual([{ kind: "unit", key: "a", label: "Unit A" }]);
    home.dispose();
  });
  it("keeps the saved reply scroll when acceptance arrives after leaving its thread", async () => {
    let finish: (response: Response) => void = () => {};
    const pending = new Promise<Response>((done) => {
      finish = done;
    });
    const { home, fetcher } = harness([json(session()), json(focused()), pending, json(focused())]);
    await home.load();
    home.text.value = "Unsent broad request";
    home.scroll.value = 14;
    expect(await home.focus("slack:C1:1")).toBe(true);
    home.text.value = "Local answer";
    home.scroll.value = 640;
    home.attach({ kind: "run", key: "first", label: "First run" });
    const sent = home.submit();
    home.routeChanged("/home");
    finish(json({ status: "accepted" }));
    await sent;
    expect({ text: home.text.value, scroll: home.scroll.value }).toEqual({ text: "Unsent broad request", scroll: 14 });
    expect(await home.focus("slack:C1:1")).toBe(true);
    expect({ text: home.text.value, context: home.context.value, scroll: home.scroll.value }).toEqual({
      text: "",
      context: [],
      scroll: 640,
    });
    expect(body(fetcher, 2)).toEqual({
      text: "Local answer",
      destination: { kind: "thread", thread: "slack:C1:1" },
      revision: 9,
      context: [{ kind: "run", key: "first" }],
      key: "issued:thread",
    });
    home.dispose();
  });
  it("restores private scroll separately for each authorized reply destination", async () => {
    const { home } = harness([
      json(session()),
      json(focused()),
      json(session({ actor: "access:bob", stream: "person:bob" })),
    ]);
    await home.load();
    home.scroll.value = 420;
    await home.focus("slack:C1:1");
    expect(home.scroll.value).toBe(0);
    home.scroll.value = 80;
    home.exitFocus();
    expect(home.scroll.value).toBe(420);
    await home.load();
    expect(home.session.value?.actor).toBe("access:bob");
    expect(home.scroll.value).toBe(0);
    home.dispose();
  });
  it("keeps attached context separate from the broad reply destination and client identity claims", async () => {
    const { home, fetcher } = harness([json(session()), json({ status: "pending" })]);
    await home.load();
    home.attach({ kind: "unit", key: "a", label: "Unit A" });
    home.text.value = "Check other work";
    await home.submit();
    expect(body(fetcher, 1)).toEqual({
      text: "Check other work",
      destination: { kind: "broad" },
      revision: 4,
      context: [{ kind: "unit", key: "a" }],
      key: "issued:one",
    });
    expect(home.notice.value).toBe("Message accepted. Processing is pending.");
    home.dispose();
  });
  it("retries an uncertain response with the original issued key and exact payload", async () => {
    const { home, fetcher } = harness([
      json(session()),
      new Error("timeout"),
      json({ status: "accepted", duplicate: true }),
    ]);
    await home.load();
    home.text.value = "Start this work";
    await home.submit();
    expect(home.text.value).toBe("Start this work");
    expect(home.notice.value).toContain("The result could not be confirmed.");
    await home.submit();
    expect(body(fetcher, 1)).toEqual({
      text: "Start this work",
      destination: { kind: "broad" },
      revision: 4,
      context: [],
      key: "issued:one",
    });
    expect(body(fetcher, 2)).toEqual({
      text: "Start this work",
      destination: { kind: "broad" },
      revision: 4,
      context: [],
      key: "issued:one",
    });
    expect(home.notice.value).toBe("The original message was already accepted. It was not sent twice.");
    home.dispose();
  });
  it("keeps the original revision when a live refresh arrives during an uncertain retry", async () => {
    const { home, fetcher, stream } = harness([
      json(session()),
      new Error("timeout"),
      json({ status: "accepted", duplicate: true }),
    ]);
    await home.load();
    home.text.value = "Start once";
    await home.submit();
    stream.created.at(-1)?.emitMessage(
      session({
        revision: 5,
        destination: {
          kind: "broad",
          label: "Your messages to Switchboard",
          thread: null,
          revision: 5,
          canWrite: true,
        },
      }),
    );
    await home.submit();
    expect(fetcher.mock.calls[2]?.[0]).toBe("/home/send");
    expect(body(fetcher, 2)).toEqual({
      text: "Start once",
      destination: { kind: "broad" },
      revision: 4,
      context: [],
      key: "issued:one",
    });
    expect(home.notice.value).toBe("The original message was already accepted. It was not sent twice.");
    home.dispose();
  });
  it("obtains a distinct issued key after an uncertain payload is edited", async () => {
    const { home, fetcher } = harness([
      json(session()),
      new Error("timeout"),
      json({ key: "issued:two" }),
      json({ status: "accepted" }),
    ]);
    await home.load();
    home.text.value = "First";
    await home.submit();
    home.text.value = "Second";
    await home.submit();
    expect(fetcher.mock.calls[2]?.[0]).toBe("/home/key");
    expect(body(fetcher, 3)).toEqual({
      text: "Second",
      destination: { kind: "broad" },
      revision: 4,
      context: [],
      key: "issued:two",
    });
    expect(home.notice.value).toBe("Message accepted.");
    home.dispose();
  });
  it("issues a new key when an uncertain message keeps its words but changes attached context", async () => {
    const { home, fetcher } = harness([
      json(session()),
      new Error("timeout"),
      json({ key: "issued:two" }),
      json({ status: "accepted" }),
    ]);
    await home.load();
    home.text.value = "Inspect it";
    await home.submit();
    home.attach({ kind: "unit", key: "b", label: "B" });
    await home.submit();
    expect(body(fetcher, 3)).toEqual({
      text: "Inspect it",
      destination: { kind: "broad" },
      revision: 4,
      context: [{ kind: "unit", key: "b" }],
      key: "issued:two",
    });
    home.dispose();
  });
  it("retains a refused local answer without falling back to the broad stream", async () => {
    const { home, fetcher } = harness([
      json(session()),
      json(focused()),
      json({ status: "stale", reason: "Question already resolved" }, 409),
    ]);
    await home.load();
    await home.focus("slack:C1:1");
    home.text.value = "My answer";
    await home.submit();
    expect(home.text.value).toBe("My answer");
    expect(home.notice.value).toBe("Question already resolved");
    expect(home.session.value?.destination.kind).toBe("thread");
    expect(body(fetcher, 2).destination).toEqual({ kind: "thread", thread: "slack:C1:1" });
    home.dispose();
  });
  it("discards a late focus response after navigation and continues the broad feed", async () => {
    let resolve: (value: Response) => void = () => {};
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const { home, stream } = harness([json(session()), pending]);
    await home.load();
    const entered = home.focus("slack:C1:1");
    home.routeChanged("/home");
    resolve(json(focused()));
    expect(await entered).toBe(false);
    expect(home.session.value?.destination.kind).toBe("broad");
    stream.created.at(-1)?.emitMessage(session({ revision: 5 }));
    expect(home.session.value?.revision).toBe(5);
    home.dispose();
  });
  it("removes private text and drafts immediately when the current feed revokes access", async () => {
    const { home, stream } = harness([json(session())]);
    await home.load();
    home.text.value = "Private draft";
    home.attach({ kind: "run", key: "r", label: "Run" });
    stream.created.at(-1)?.emitNamed("revoked");
    expect({
      status: home.status.value,
      text: home.text.value,
      context: home.context.value,
      session: home.session.value,
    }).toEqual({ status: "unavailable", text: "", context: [], session: null });
    expect(home.notice.value).toBe("Conversation is unavailable with your current access.");
    home.dispose();
  });
  it("clears the prior actor's draft before adopting a different authenticated session", async () => {
    const { home } = harness([
      json(session()),
      json(session({ actor: "access:bob", stream: "person:bob" })),
      json({ ...focused(), actor: "access:bob", stream: "person:bob" }),
    ]);
    await home.load();
    home.text.value = "Alice only";
    await home.load();
    expect(home.session.value?.actor).toBe("access:bob");
    expect(home.text.value).toBe("");
    expect(await home.focus("slack:C1:1")).toBe(true);
    home.exitFocus();
    expect(home.session.value?.actor).toBe("access:bob");
    expect(home.text.value).toBe("");
    home.dispose();
  });
  it("refuses malformed private frames and older revisions while preserving the current draft", async () => {
    const { home, stream } = harness([json(session())]);
    await home.load();
    home.text.value = "Draft";
    stream.created.at(-1)?.emitMessage({ ...session(), entries: [null] });
    stream.created.at(-1)?.emitMessage(session({ revision: 3 }));
    expect(home.session.value?.revision).toBe(4);
    expect(home.text.value).toBe("Draft");
    stream.created.at(-1)?.emitMessage(session({ revision: 5 }));
    expect(home.session.value?.revision).toBe(5);
    home.dispose();
  });
  it("returns a safe unavailable state for an unauthorized session without mounting a destination", async () => {
    const { home } = harness([json({ error: "unavailable" }, 404)]);
    await home.load();
    expect(home.status.value).toBe("unavailable");
    expect(home.notice.value).toBe("Conversation is unavailable with your current access.");
    expect(home.session.value).toBe(null);
    home.dispose();
  });
});
