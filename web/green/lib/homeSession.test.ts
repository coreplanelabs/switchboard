import { flushPromises } from "@vue/test-utils";
// Feature: docs/reference/specs/browser-home.md — one authorized destination and retry identity.
import { afterEach, describe, expect, it, vi } from "vitest";
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
    accessEpoch: "fixture:policy",
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
  it.each([
    ["broad text", false, "text", 403, "forbidden"],
    ["broad confirm", false, "confirm", 401, "<html>Sign in</html>"],
    ["broad cancel", false, "cancel", 404, ""],
    ["focused confirm", true, "confirm", 403, "forbidden"],
    ["focused cancel", true, "cancel", 404, ""],
    ["focused retry", true, "retry", 401, "<html>Sign in</html>"],
  ] as const)(
    "handles definite non-JSON denial for %s without replaying its original intent",
    async (_case, local, intent, statusCode, responseBody) => {
      const offer = { id: "saved:original", line: "Original private proposal" };
      const responses: Array<Response | Error> = [json(session({ offer }))];
      if (local) responses.push(json({ ...focused(), offer }));
      if (intent === "retry") responses.push(new Error("Unknown first result"));
      responses.push(new Response(responseBody, { status: statusCode }));
      if (local) responses.push(json(session()));
      const { home, fetcher } = harness(responses);
      await home.load();
      home.text.value = "Keep my broad draft";
      if (local) await home.focus("slack:C1:1");
      home.text.value = "Original private reply";
      const submit = () =>
        intent === "confirm" || intent === "cancel"
          ? home.submitConfirmation({ kind: intent, id: offer.id })
          : home.submit();
      if (intent === "retry") await submit();
      await submit();
      expect({
        status: home.status.value,
        destination: home.session.value?.destination.kind ?? null,
        text: home.text.value,
        offer: home.offer.value,
        pending: home.pendingSubmission.value,
        revocations: home.revocations.value,
      }).toEqual(
        local
          ? {
              status: "ready",
              destination: "broad",
              text: "Keep my broad draft",
              offer: null,
              pending: false,
              revocations: 1,
            }
          : { status: "unavailable", destination: null, text: "", offer: null, pending: false, revocations: 1 },
      );
      const sends = fetcher.mock.calls.filter(([url, init]) => url === "/home/send" && init?.method === "POST");
      const payload = {
        key: local ? "issued:thread" : "issued:one",
        revision: local ? 9 : 4,
        destination: local ? { kind: "thread", thread: "slack:C1:1" } : { kind: "broad" },
        context: [],
        ...(intent === "confirm" || intent === "cancel"
          ? { confirmation: { kind: intent, id: offer.id } }
          : { text: "Original private reply" }),
      };
      expect(sends.map(([, init]) => JSON.parse(String(init?.body)))).toEqual(
        intent === "retry" ? [payload, payload] : [payload],
      );
      home.dispose();
    },
  );
  it.each(["malformed200", "object200", "malformed500", "network"] as const)(
    "keeps %s uncertain with its exact original retry rather than a new intent",
    async (failure) => {
      const first =
        failure === "network"
          ? new Error("Transport lost")
          : failure === "object200"
            ? json({})
            : new Response("not JSON", { status: failure === "malformed500" ? 500 : 200 });
      const { home, fetcher } = harness([json(session()), first, json({ status: "accepted", duplicate: true })]);
      await home.load();
      home.text.value = "Original private reply";
      await home.submit();
      expect({
        status: home.status.value,
        text: home.text.value,
        pending: home.pendingSubmission.value,
        revocations: home.revocations.value,
      }).toEqual({ status: "ready", text: "Original private reply", pending: true, revocations: 0 });
      expect(home.notice.value).toBe("The result could not be confirmed. Retry returns the same submission receipt.");
      await home.submit();
      expect([body(fetcher, 1), body(fetcher, 2)]).toEqual([
        { text: "Original private reply", destination: { kind: "broad" }, revision: 4, context: [], key: "issued:one" },
        { text: "Original private reply", destination: { kind: "broad" }, revision: 4, context: [], key: "issued:one" },
      ]);
      expect(home.notice.value).toBe("The original message was already accepted. It was not sent twice.");
      home.dispose();
    },
  );
  it("ignores a late non-JSON target denial after navigation without clearing the current broad draft", async () => {
    let release!: (value: Response) => void;
    const delayed = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { home, fetcher } = harness([json(session()), json(focused()), delayed]);
    await home.load();
    await home.focus("slack:C1:1");
    home.text.value = "Original local reply";
    const pending = home.submit();
    await flushPromises();
    home.routeChanged("/home");
    home.text.value = "New authorized broad draft";
    release(new Response("forbidden", { status: 403 }));
    await pending;
    expect({
      status: home.status.value,
      destination: home.session.value?.destination.kind,
      text: home.text.value,
      revocations: home.revocations.value,
    }).toEqual({ status: "ready", destination: "broad", text: "New authorized broad draft", revocations: 0 });
    expect(body(fetcher, 2)).toEqual({
      text: "Original local reply",
      destination: { kind: "thread", thread: "slack:C1:1" },
      revision: 9,
      context: [],
      key: "issued:thread",
    });
    home.dispose();
  });
  it.each(["unit", "thread", "inline"] as const)(
    "restores only freshly authorized broad draft and scroll after focused %s revocation",
    async (entry) => {
      let authorize!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        authorize = resolve;
      });
      const broad = session({
        entries: [{ id: "old-broad", role: "assistant", isViewer: false, content: "Old broad message" }],
      });
      const local = {
        ...focused(),
        entries: [{ id: "local", role: "assistant" as const, isViewer: false, content: "Focused private message" }],
      };
      const { home, stream, fetcher } = harness([json(broad), json(local), pending]);
      home.routeChanged(
        entry === "unit" ? "/runs/unit/unit-a" : entry === "thread" ? "/threads/slack%3AC1%3A1" : "/home",
      );
      await home.load();
      home.text.value = "Keep my broad draft";
      home.scroll.value = 420;
      home.attach({ kind: "thread", key: "slack:C1:1", label: "Affected thread" });
      home.attach({ kind: "unit", key: "unit-a", label: "Affected unit" });
      home.attach({ kind: "run", key: "unrelated", label: "Other work" });
      if (entry === "inline")
        expect(
          await home.beginInlineAnswer("unit-a", "Unit A", {
            thread: "slack:C1:1",
            revision: 9,
            question: "Choose the behavior",
            primaryAction: { label: "Answer", text: "yes" },
          }),
        ).toBe(true);
      else expect(await home.focus("slack:C1:1")).toBe(true);
      const revoked = stream.created.at(-1)!;
      home.text.value = "Private local draft";
      home.scroll.value = 80;
      revoked.emitNamed("revoked");
      expect(revoked.closed).toBe(true);
      expect(home.session.value?.entries.some((row) => row.content === "Focused private message")).not.toBe(true);
      expect(home.text.value).toBe("");
      authorize(
        json(
          session({
            submissionKey: "issued:recovered",
            ...(entry === "thread" ? { destination: { ...session().destination, canWrite: false } } : {}),
            entries: [
              { id: "fresh-broad", role: "assistant", isViewer: false, content: "Freshly authorized broad message" },
            ],
          }),
        ),
      );
      await flushPromises();
      expect({
        status: home.status.value,
        destination: home.session.value?.destination.kind,
        text: home.text.value,
        scroll: home.scroll.value,
      }).toEqual({ status: "ready", destination: "broad", text: "Keep my broad draft", scroll: 420 });
      expect(home.session.value?.entries.map((row) => row.content)).toEqual(["Freshly authorized broad message"]);
      expect(home.context.value.some((ref) => ref.kind === "thread" && ref.key === "slack:C1:1")).toBe(false);
      if (entry !== "thread")
        expect(home.context.value.some((ref) => ref.kind === "unit" && ref.key === "unit-a")).toBe(false);
      expect(home.context.value).toContainEqual({ kind: "run", key: "unrelated", label: "Other work" });
      expect(home.inlineAnswer.value).toBe(null);
      expect(home.session.value?.destination.canWrite).toBe(entry !== "thread");
      expect(fetcher.mock.calls[2]?.[0]).toBe("/home/session");
      revoked.emitMessage(local);
      expect(home.session.value?.destination.kind).toBe("broad");
      expect(home.text.value).toBe("Keep my broad draft");
      home.dispose();
    },
  );
  it.each(["actor", "organization", "stream", "binding", "epoch", "denied", "unknown"] as const)(
    "clears focused and broad private state when fresh broad proof is %s",
    async (failure) => {
      const replacement = session({
        ...(failure === "actor" ? { actor: "access:bob" } : {}),
        ...(failure === "organization" ? { organization: "org:b" } : {}),
        ...(failure === "stream" ? { stream: "person:other" } : {}),
        ...(failure === "binding" ? { bindingRevision: 1 } : {}),
        ...(failure === "epoch" ? { accessEpoch: "changed-policy" } : {}),
      });
      const answer =
        failure === "denied" ? json({}, 403) : failure === "unknown" ? new Error("unavailable") : json(replacement);
      const { home, stream } = harness([json(session()), json(focused()), answer]);
      await home.load();
      home.text.value = "Private broad draft";
      await home.focus("slack:C1:1");
      home.text.value = "Private target draft";
      stream.created.at(-1)!.emitNamed("revoked");
      await flushPromises();
      expect({
        status: home.status.value,
        session: home.session.value,
        text: home.text.value,
        context: home.context.value,
      }).toEqual({ status: "unavailable", session: null, text: "", context: [] });
      home.dispose();
    },
  );
  it.each(["navigate", "reset", "dispose"] as const)(
    "does not revive cached focus during recovery after %s",
    async (change) => {
      let finish!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      const { home, stream, fetcher } = harness([json(session()), json(focused()), pending]);
      await home.load();
      home.text.value = "Lawful broad draft";
      await home.focus("slack:C1:1");
      home.text.value = "Closed target draft";
      const closed = stream.created.at(-1)!;
      closed.emitNamed("revoked");
      home.exitFocus();
      expect(await home.focus("slack:C1:other")).toBe(false);
      if (change === "navigate") home.routeChanged("/runs");
      else if (change === "reset") home.resetPrivate();
      else home.dispose();
      expect(home.session.value).toBe(null);
      expect(home.text.value).toBe("");
      closed.emitMessage(focused());
      finish(json(session({ submissionKey: "issued:after-recovery" })));
      await flushPromises();
      if (change === "navigate")
        expect({
          status: home.status.value,
          destination: home.session.value?.destination.kind,
          text: home.text.value,
        }).toEqual({ status: "ready", destination: "broad", text: "Lawful broad draft" });
      else
        expect({ status: home.status.value, session: home.session.value, text: home.text.value }).toEqual({
          status: "unavailable",
          session: null,
          text: "",
        });
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      home.dispose();
    },
  );
  it("keeps only opaque original receipt recovery while a revoked target's late acknowledgment cannot consume the broad draft or repost", async () => {
    let accept!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      accept = resolve;
    });
    const { home, stream, fetcher } = harness([
      json(session()),
      json(focused()),
      pending,
      json(session({ submissionKey: "issued:fresh-broad" })),
      json({ status: "accepted" }),
    ]);
    await home.load();
    home.text.value = "Keep broad intent";
    await home.focus("slack:C1:1");
    home.text.value = "Target intent";
    const sent = home.submit();
    const revoked = stream.created.at(-1)!;
    revoked.emitNamed("revoked");
    await flushPromises();
    expect(home.earlierRequests.value.some((item) => item.key === "issued:thread")).toBe(true);
    expect(home.pendingSubmission.value).toBe(false);
    expect(home.text.value).toBe("Keep broad intent");
    accept(json({ status: "accepted", offer: { id: "old-target-offer", line: "Old target action" } }));
    await sent;
    expect(home.offer.value).toBe(null);
    expect(home.text.value).toBe("Keep broad intent");
    expect(home.earlierRequests.value.some((item) => item.key === "issued:thread")).toBe(false);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    await home.submit();
    expect(body(fetcher, 4)).toEqual({
      text: "Keep broad intent",
      destination: { kind: "broad" },
      revision: 4,
      context: [],
      key: "issued:fresh-broad",
    });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(3);
    home.dispose();
  });

  it("does not retarget an unsent draft or attached context onto a changed shared question", async () => {
    const { home, stream, fetcher } = harness([json(session()), json(focused())]);
    await home.load();
    await home.focus("slack:C1:1");
    home.attach({ kind: "unit", key: "unit-a", label: "Unit A" });
    stream.created
      .at(-1)
      ?.emitMessage({ ...focused(), revision: 5, destination: { ...focused().destination, revision: 10 } });
    home.text.value = "My answer to the earlier question";
    await home.submit();
    expect(home.notice.value).toBe("The question changed. Review the current question before sending this draft.");
    expect(home.text.value).toBe("My answer to the earlier question");
    expect(fetcher.mock.calls).toHaveLength(2);
    home.dispose();
  });
  it("pages an authorized history window without changing its draft or uncertain submission identity", async () => {
    const latest = session({
      history: { cursor: 20, hasMore: true, status: "partial", previousUrl: "/home/session?before=20" },
    });
    const older = session({
      submissionKey: "issued:history",
      eventsUrl: "/home/events?before=20",
      entries: [{ id: "earlier", role: "user", content: "Earlier request", isViewer: true }],
      history: { cursor: 1, hasMore: false, status: "complete", latestUrl: "/home/session" },
    });
    const { home, fetcher } = harness([
      json(latest),
      new Error("timeout"),
      json(older),
      json({ status: "accepted", duplicate: true }),
    ]);
    await home.load();
    home.text.value = "Keep this draft";
    await home.submit();
    expect(await home.loadHistory("/home/session?before=20")).toBe(true);
    expect(home.text.value).toBe("Keep this draft");
    expect(home.session.value?.entries.map((entry) => entry.content)).toEqual(["Earlier request"]);
    expect(home.session.value?.destination).toEqual({
      kind: "broad",
      label: "Your messages to Switchboard",
      thread: null,
      revision: 4,
      canWrite: true,
    });
    await home.submit();
    expect(body(fetcher, 1)).toEqual({
      text: "Keep this draft",
      destination: { kind: "broad" },
      revision: 4,
      context: [],
      key: "issued:one",
    });
    expect(body(fetcher, 3)).toEqual({
      text: "Keep this draft",
      destination: { kind: "broad" },
      revision: 4,
      context: [],
      key: "issued:one",
    });
    home.dispose();
  });
  it("cannot restore a delayed older window after another linked source changes the access epoch", async () => {
    let resolve: (value: Response) => void = () => {};
    const delayed = new Promise<Response>((done) => {
      resolve = done;
    });
    const older = session({
      entries: [{ id: "revoked", role: "user", content: "Revoked source content", isViewer: true }],
    });
    const { home, stream, fetcher } = harness([
      json(
        session({ history: { cursor: 20, hasMore: true, status: "partial", previousUrl: "/home/session?before=20" } }),
      ),
      delayed,
    ]);
    await home.load();
    const paging = home.loadHistory("/home/session?before=20");
    stream.created.at(-1)?.emitMessage(session({ accessEpoch: "fixture:source-revoked", revision: 5 }));
    resolve(json(older));
    expect(await paging).toBe(false);
    expect(fetcher.mock.calls[1]?.[0]).toBe("/home/session?before=20");
    expect(home.status.value).toBe("unavailable");
    expect(home.session.value).toBe(null);
    home.dispose();
  });
  it("opens a requested older window when ordinary live replies advance the broad revision", async () => {
    let finish: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const latest = session({
      history: { cursor: 20, hasMore: true, status: "partial", previousUrl: "/home/session?before=20" },
    });
    const { home, stream } = harness([json(latest), pending]);
    await home.load();
    home.text.value = "Draft";
    const paging = home.loadHistory("/home/session?before=20");
    stream.created.at(-1)?.emitMessage({ ...latest, revision: 5 });
    finish(
      json(
        session({
          eventsUrl: "/home/events?before=20",
          entries: [{ id: "old", role: "user", isViewer: true, content: "Older request" }],
          history: { cursor: 1, hasMore: true, status: "partial", latestUrl: "/home/session" },
        }),
      ),
    );
    expect(await paging).toBe(true);
    expect(home.session.value?.entries.map((entry) => entry.content)).toEqual(["Older request"]);
    expect(home.text.value).toBe("Draft");
    home.dispose();
  });
  it("clears retained messages and drafts when the full access epoch changes without a browser binding change", async () => {
    const { home, stream } = harness([
      json(session({ entries: [{ id: "old", role: "user", content: "Earlier private message", isViewer: true }] })),
    ]);
    await home.load();
    home.text.value = "Private draft";
    stream.created.at(-1)?.emitMessage(session({ accessEpoch: "fixture:revoked-source", revision: 5 }));
    expect(home.status.value).toBe("unavailable");
    expect(home.session.value).toBe(null);
    expect(home.text.value).toBe("");
    home.dispose();
  });
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
  it("accepts a lower new owner question revision and requires explicit review before the first send", async () => {
    const { home, fetcher, stream } = harness([json(session()), json(focused()), json({ status: "accepted" })]);
    await home.load();
    await home.focus("slack:C1:1");
    home.text.value = "Draft for the first question";
    stream.created
      .at(-1)
      ?.emitMessage({ ...focused(), revision: 2, destination: { ...focused().destination, revision: 2 } });
    expect(home.session.value?.destination.revision).toBe(2);
    await home.submit();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(home.draftStale.value).toBe(true);
    home.reviewDraft();
    await home.submit();
    expect(body(fetcher, 2)).toMatchObject({ text: "Draft for the first question", revision: 2 });
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
  it("retains a reconnectable snapshot but clears private words and drafts when the transport permanently denies a reconnect", async () => {
    const { home, stream } = harness([
      json(session({ entries: [{ id: "private", role: "user", isViewer: true, content: "Retained private words" }] })),
    ]);
    await home.load();
    home.text.value = "Private draft";
    stream.created[0].emitError(false);
    expect(home.session.value?.entries[0].content).toBe("Retained private words");
    expect(home.notice.value).toBe("Connection lost. The last confirmed conversation is shown.");
    stream.created[0].emitError(true);
    expect(home.status.value).toBe("unavailable");
    expect(home.session.value).toBe(null);
    expect(home.text.value).toBe("");
    home.dispose();
  });
  it("ignores late frames from a replaced source after a refused focus lookup", async () => {
    const { home, stream } = harness([json(session()), json({ status: "not_found" }, 404)]);
    await home.load();
    expect(await home.focus("slack:hidden:1")).toBe(false);
    stream.created.at(-1)?.emitMessage(
      session({
        revision: 5,
        entries: [{ id: "current", role: "assistant", content: "Current authorized reply", isViewer: false }],
      }),
    );
    stream.created[0].emitMessage(
      session({
        revision: 6,
        entries: [{ id: "late", role: "assistant", content: "Old source reply", isViewer: false }],
      }),
    );
    expect(home.session.value?.entries.map((entry) => entry.content)).toEqual(["Current authorized reply"]);
    stream.created[0].emitNamed("revoked");
    expect(home.status.value).toBe("ready");
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

describe("Opaque earlier request recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });
  it("bounds opaque tracking before sending and expires identifiers without claiming no effect", async () => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const namespace = 'switchboard:earlier:["org:a","access:alice"]';
    localStorage.setItem(
      namespace,
      JSON.stringify(Array.from({ length: 100 }, (_, n) => ({ key: `old-${n}`, expiresAt: 2000 }))),
    );
    const { home, fetcher } = harness([json(session()), json({ status: "accepted" })]);
    await home.load();
    home.text.value = "New private request";
    await home.submit();
    expect(home.notice.value).toBe(
      "Earlier request tracking is full. Check or forget a saved request identifier before sending.",
    );
    home.forgetEarlierRequest("old-0");
    await home.submit();
    expect(fetcher.mock.calls.map(([url, init]) => ({ url, method: init?.method }))).toEqual([
      { url: "/home/session", method: undefined },
      { url: "/home/send", method: "POST" },
    ]);
    expect(body(fetcher, 1)).toEqual({
      key: "issued:one",
      revision: 4,
      destination: { kind: "broad" },
      text: "New private request",
      context: [],
    });
    home.dispose();
    vi.setSystemTime(2001);
    const expired = createHomeSession((async () => json(session())) as typeof fetch, fakeEventSourceFactory().factory);
    await expired.load();
    expect(expired.session.value?.destination.label).toBe("Your messages to Switchboard");
    expect(expired.earlierRequests.value).toEqual([]);
    expired.dispose();
    localStorage.clear();
    vi.useRealTimers();
  });

  it("keeps missing and unavailable status unknown without dropping the original key or retrying", async () => {
    localStorage.clear();
    const { home, stream, fetcher } = harness([
      json(session()),
      new Error("lost acknowledgment"),
      json(session()),
      json({ status: "unknown" }, 404),
      json({ status: "unavailable" }, 503),
    ]);
    await home.load();
    home.text.value = "unconfirmed private input";
    await home.submit();
    stream.created.at(-1)!.emitNamed("revoked");
    await home.load();
    for (let n = 0; n < 2; n++) {
      await home.checkEarlierRequest("issued:one");
      expect(home.earlierRequests.value.map((item) => [item.key, item.message])).toEqual([
        ["issued:one", "The original request status is unknown. No action was retried."],
      ]);
    }
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    home.dispose();
    localStorage.clear();
  });

  it("restores only the original opaque key after revocation and reload and checks status without replay", async () => {
    localStorage.clear();
    const offer = { id: "saved:private", line: "private old offer", question: "private old question" };
    const stream = fakeEventSourceFactory();
    const calls: Array<{ url: string; method?: string }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      if (init?.method === "POST") throw new Error("lost acknowledgment");
      if (url.startsWith("/home/submissions/"))
        return json({ status: "known", admission: "accepted", dispatch: "handler_returned", nativeEffect: "unknown" });
      return json(session({ offer }));
    }) as typeof fetch;
    const first = createHomeSession(fetcher, stream.factory);
    await first.load();
    await first.submitConfirmation({ kind: "confirm", id: offer.id });
    stream.created.at(-1)!.emitNamed("revoked");
    expect(first.offer.value).toBe(null);
    first.dispose();
    const saved = JSON.stringify(Object.entries(localStorage));
    expect(saved).toContain("issued:one");
    expect(saved).not.toContain("private old");
    expect(saved).not.toContain("saved:private");
    const restored = createHomeSession(fetcher, stream.factory);
    await restored.load();
    expect(restored.earlierRequests.value.map((item) => item.key)).toEqual(["issued:one"]);
    await restored.checkEarlierRequest("issued:one");
    expect(restored.earlierRequests.value[0]?.message).toBe(
      "The original request was accepted. Its processing step returned; action and work results are not confirmed here.",
    );
    expect(calls.filter((call) => call.method === "POST")).toEqual([{ url: "/home/send", method: "POST" }]);
    expect(calls.at(-1)).toEqual({ url: "/home/submissions/issued%3Aone", method: undefined });
    restored.dispose();
    const foreign = createHomeSession(
      (async () => json(session({ actor: "access:bob" }))) as typeof fetch,
      stream.factory,
    );
    await foreign.load();
    expect(foreign.earlierRequests.value).toEqual([]);
    foreign.dispose();
    localStorage.clear();
  });
});
