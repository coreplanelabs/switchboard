// Feature: docs/reference/specs/browser-home.md — real transcript scroll per authorized destination.
import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { HomeSession } from "@core/channels/homeSeed.js";
import ConversationDock from "./ConversationDock.vue";
import { createHomeSession, HomeSessionKey } from "../lib/homeSession";
import { fakeEventSourceFactory } from "../../src/testing/fakeEventSource";
import { mountApp } from "../../src/testing/mount";
enableAutoUnmount(afterEach);
function session(thread: string | null): HomeSession {
  return {
    version: 1,
    organization: "org",
    actor: "access:alice",
    stream: "person:alice",
    bindingRevision: 0,
    accessEpoch: "fixture:policy",
    revision: 1,
    entries: [],
    submissionKey: "issued:first",
    commands: [],
    sendUrl: "/home/send",
    eventsUrl: "/home/events",
    destination: {
      kind: thread ? "thread" : "broad",
      thread,
      label: thread ? "Unit thread" : "Your messages",
      revision: 1,
      canWrite: true,
    },
  };
}
describe("Conversation dock scroll", () => {
  it("blocks older and latest history during deletion and rejects a pre-deletion history response", async () => {
    const initial = {
      ...session(null),
      history: {
        cursor: 4,
        hasMore: true,
        status: "partial" as const,
        previousUrl: "/home/session?before=4",
        latestUrl: "/home/session",
      },
      entries: [
        { id: "own", role: "user" as const, isViewer: true, content: "Saved text", deleteUrl: "/home/messages/own" },
      ],
    };
    let finishHistory!: (value: Response) => void,
      finishDelete!: (value: Response) => void,
      finishRefresh!: (value: Response) => void;
    const history = new Promise<Response>((resolve) => {
      finishHistory = resolve;
    });
    const deletion = new Promise<Response>((resolve) => {
      finishDelete = resolve;
    });
    const refresh = new Promise<Response>((resolve) => {
      finishRefresh = resolve;
    });
    let deleting = false;
    const streams = fakeEventSourceFactory();
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/home/session?before=4") return history;
      if (url === "/home/messages/own") {
        deleting = true;
        return deletion;
      }
      return deleting ? (await refresh).clone() : Response.json(initial);
    });
    const home = createHomeSession(fetcher as typeof fetch, streams.factory);
    await home.load();
    const page = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
    home.text.value = "Keep unsent draft";
    const oldRead = home.loadHistory("/home/session?before=4");
    const removal = home.removePrivate("own");
    finishDelete(Response.json({ status: "ok" }));
    await flushPromises();
    finishHistory(Response.json(initial));
    expect(await oldRead).toBe(false);
    await flushPromises();
    for (const button of page.findAll('[aria-label="Conversation history controls"] button'))
      expect(button.attributes("disabled")).toBeDefined();
    expect(await home.loadHistory("/home/session")).toBe(false);
    expect(streams.created.filter((source) => !source.closed)).toHaveLength(0);
    finishRefresh(Response.json({ ...initial, entries: [], accessEpoch: "fresh-after-delete" }));
    expect(await removal).toBe(true);
    await flushPromises();
    expect(home.historyLoading.value).toBe(false);
    for (const button of page.findAll('[aria-label="Conversation history controls"] button'))
      expect(button.attributes("disabled")).toBeUndefined();
    expect(await home.loadHistory("/home/session")).toBe(true);
    expect(home.text.value).toBe("Keep unsent draft");
    expect(home.session.value?.accessEpoch).toBe("fresh-after-delete");
    home.dispose();
  });
  it("holds sending during deletion and recovers on the current route without repeating DELETE", async () => {
    const initial = {
      ...session(null),
      entries: [
        { id: "own", role: "user" as const, isViewer: true, content: "Old text", deleteUrl: "/home/messages/own" },
      ],
    };
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    let deleting = false;
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/home/messages/own") {
        deleting = true;
        return pending;
      }
      return Response.json(deleting ? { ...session(null), accessEpoch: "fresh-after-delete" } : initial);
    });
    const home = createHomeSession(fetcher as typeof fetch, fakeEventSourceFactory().factory);
    await home.load();
    home.text.value = "Keep draft";
    const removal = home.removePrivate("own");
    await home.submit();
    home.routeChanged("/home?view=investigation");
    finish(Response.json({ status: "ok" }));
    expect(await removal).toBe(true);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/home/session", "/home/messages/own", "/home/session"]);
    expect(home.status.value).toBe("ready");
    expect(home.session.value?.accessEpoch).toBe("fresh-after-delete");
    expect(home.text.value).toBe("Keep draft");
    home.dispose();
  });
  it.each([
    "unit SSE",
    "thread SSE",
    "inline SSE",
    "send401",
    "send403",
    "send404",
    "send401html",
    "send403plain",
    "send404empty",
    "denied broad",
    "unknown broad",
  ] as const)("focuses a persistent permission-safe explanation during focused %s recovery", async (loss) => {
    const stream = fakeEventSourceFactory();
    let recovering = false;
    let authorize!: (value: Response) => void;
    let fail!: (reason: Error) => void;
    const broad = new Promise<Response>((resolve, reject) => {
      authorize = resolve;
      fail = reject;
    });
    const thread = "slack:C1:1";
    const sent: unknown[] = [];
    const home = createHomeSession(
      (async (url: string, init?: RequestInit) => {
        if (url === "/home/session") return recovering ? broad : new Response(JSON.stringify(session(null)));
        if (url === "/home/focus") return new Response(JSON.stringify(session(thread)));
        if (url === "/home/send") {
          sent.push(JSON.parse(String(init?.body)));
          recovering = true;
          return new Response(
            loss.endsWith("plain")
              ? "forbidden"
              : loss.endsWith("html")
                ? "<html>Sign in</html>"
                : loss.endsWith("empty")
                  ? ""
                  : "{}",
            { status: Number.parseInt(loss.slice(4)) },
          );
        }
        throw new Error(`Unexpected request ${url}`);
      }) as typeof fetch,
      stream.factory,
    );
    await home.load();
    const page = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
    await page.get("textarea").setValue("Keep my broad draft");
    if (loss === "inline SSE")
      await home.beginInlineAnswer("i:q", "Question", { thread, revision: 1, question: "Approve?" });
    else await home.focus(thread);
    await flushPromises();
    if (loss.startsWith("send")) {
      await page.get("textarea").setValue("Original local reply");
      await page.get("form").trigger("submit");
    } else {
      recovering = true;
      stream.created.at(-1)!.emitNamed("revoked");
    }
    await flushPromises();
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement?.textContent).toContain("This reply is no longer available.");
    if (loss === "denied broad") authorize(new Response("{}", { status: 403 }));
    else if (loss === "unknown broad") fail(new Error("Unknown broad proof"));
    else authorize(new Response(JSON.stringify(session(null))));
    await flushPromises();
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement?.textContent).toContain(
      loss === "denied broad" || loss === "unknown broad" ? "unavailable" : "This reply is no longer available.",
    );
    if (loss !== "denied broad" && loss !== "unknown broad")
      expect(page.get("textarea").element.value).toBe("Keep my broad draft");
    expect(sent).toEqual(
      loss.startsWith("send")
        ? [
            {
              key: "issued:first",
              revision: 1,
              destination: { kind: "thread", thread },
              text: "Original local reply",
              context: [],
            },
          ]
        : [],
    );
    home.dispose();
  });
  it("checks an earlier uncertain choice after a real reload without restoring its offer or sending it again", async () => {
    localStorage.clear();
    const stream = fakeEventSourceFactory(),
      calls: Array<{ url: string; method?: string }> = [];
    const offer = { id: "saved:old", line: "private obsolete proposal", question: "Private question" };
    let first = true;
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      if (init?.method === "POST") throw new Error("lost action acknowledgment");
      if (url.includes("/submissions/"))
        return new Response(
          JSON.stringify({ status: "known", admission: "accepted", dispatch: "uncertain", nativeEffect: "unknown" }),
        );
      return new Response(JSON.stringify({ ...session(null), ...(first ? { offer } : {}) }));
    }) as typeof fetch;
    const original = createHomeSession(fetcher, stream.factory);
    await original.load();
    const page = mountApp(ConversationDock, { provides: [[HomeSessionKey, original]] });
    await page
      .findAll("button")
      .find((button) => button.text() === "Confirm")!
      .trigger("click");
    await flushPromises();
    stream.created.at(-1)!.emitNamed("revoked");
    await flushPromises();
    expect(page.text()).not.toContain("private obsolete proposal");
    page.unmount();
    original.dispose();
    first = false;
    const restored = createHomeSession(fetcher, stream.factory);
    await restored.load();
    const loaded = mountApp(ConversationDock, { provides: [[HomeSessionKey, restored]] });
    await loaded
      .findAll("button")
      .find((button) => button.text() === "Check earlier request")!
      .trigger("click");
    await flushPromises();
    expect(loaded.text()).toContain("The original request was accepted. Its processing result is not confirmed here.");
    expect(loaded.text()).not.toContain("private obsolete proposal");
    expect(calls.filter((call) => call.method === "POST")).toEqual([{ url: "/home/send", method: "POST" }]);
    expect(calls.at(-1)?.url).toBe("/home/submissions/issued%3Afirst");
    restored.dispose();
    localStorage.clear();
  });

  it("attaches the viewed pipeline and recorded pull request without changing the reply destination", async () => {
    const stream = fakeEventSourceFactory();
    const home = createHomeSession(
      (async () => new Response(JSON.stringify(session(null)))) as typeof fetch,
      stream.factory,
    );
    await home.load();
    const page = mountApp(ConversationDock, {
      provides: [[HomeSessionKey, home]],
      seed: {
        page: "run",
        mode: "history",
        id: "evidence",
        startedAt: 1,
        eventCount: 1,
        events: [{ type: "run_meta", agent: "review", repo: "sample/api", pr: 42 }],
      },
    });
    page.vm.$router.addRoute({ path: "/pipelines/:id", component: { template: "<div />" } });
    page.vm.$router.addRoute({ path: "/runs/:id", component: { template: "<div />" } });
    await page.vm.$router.push("/pipelines/old-pipeline");
    await flushPromises();
    await page
      .findAll("button")
      .find((button) => button.text() === "Attach this pipeline")!
      .trigger("click");
    await page.vm.$router.push("/runs/evidence?view=pull-request");
    await flushPromises();
    await page
      .findAll("button")
      .find((button) => button.text() === "Attach this pull request")!
      .trigger("click");
    expect(home.context.value).toEqual([
      { kind: "pipeline", key: "old-pipeline", label: "This pipeline" },
      { kind: "pull-request", key: "sample/api#42", label: "sample/api#42" },
    ]);
    expect(home.session.value?.destination).toEqual({
      kind: "broad",
      thread: null,
      label: "Your messages",
      revision: 1,
      canWrite: true,
    });
    home.dispose();
  });
  it("moves focus to the unavailable explanation only on explicit conversation revocation", async () => {
    const stream = fakeEventSourceFactory();
    const home = createHomeSession(
      (async () => new Response(JSON.stringify(session(null)))) as typeof fetch,
      stream.factory,
    );
    await home.load();
    const page = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
    const button = page.get("button").element as HTMLButtonElement;
    button.focus();
    home.text.value = "Unsent draft";
    stream.created[0]!.emitError();
    await flushPromises();
    expect(document.activeElement).toBe(button);
    expect(home.text.value).toBe("Unsent draft");
    expect(page.text()).toContain("Connection lost");
    stream.created[0]!.emitNamed("revoked");
    await flushPromises();
    expect(document.activeElement?.textContent).toContain("Conversation is unavailable with your current access.");
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
    expect(page.find("textarea").exists()).toBe(false);
    home.dispose();
  });

  it("enables a new question on the same thread after an accepted reply and captures a distinct reply", async () => {
    const stream = fakeEventSourceFactory(),
      sends: unknown[] = [];
    const first = {
      ...session("slack:C1:1"),
      destination: { ...session("slack:C1:1").destination, primaryAction: { label: "Merge", text: "merge" } },
    };
    const home = createHomeSession(
      (async (address: string, init?: RequestInit) => {
        if (address === "/home/session") return new Response(JSON.stringify(session(null)));
        if (address === "/home/focus") return new Response(JSON.stringify(first));
        if (address === "/home/key") return new Response(JSON.stringify({ key: "issued:second" }));
        sends.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ status: "accepted" }));
      }) as typeof fetch,
      stream.factory,
    );
    await home.load();
    await home.focus("slack:C1:1");
    const wrapper = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
    const action = (label: string) => wrapper.findAll("button").find((button) => button.text() === label)!;
    await action("Merge").trigger("click");
    await flushPromises();
    expect(action("Reply accepted").attributes("disabled")).toBeDefined();
    stream.created.at(-1)!.emitMessage({ ...first, destination: { ...first.destination, revision: 2 } });
    await flushPromises();
    expect(wrapper.findAll("button").map((button) => button.text())).toContain("Merge");
    expect(action("Merge").attributes("disabled")).toBeUndefined();
    expect(action("Type a reply").attributes("disabled")).toBeUndefined();
    await action("Merge").trigger("click");
    await flushPromises();
    expect(sends).toEqual([
      {
        key: "issued:first",
        revision: 1,
        destination: { kind: "thread", thread: "slack:C1:1" },
        text: "merge",
        context: [],
      },
      {
        key: "issued:second",
        revision: 2,
        destination: { kind: "thread", thread: "slack:C1:1" },
        text: "merge",
        context: [],
      },
    ]);
    stream.created.at(-1)!.emitMessage({
      ...first,
      destination: { ...first.destination, revision: 2, primaryAction: { label: "Approve", text: "approve" } },
    });
    await flushPromises();
    expect(action("Approve").attributes("disabled")).toBeUndefined();
    home.dispose();
  });
  it("keeps an unknown first reply immutable when a new question arrives and enables that new question after checking it", async () => {
    const stream = fakeEventSourceFactory(),
      sends: unknown[] = [];
    const first = {
      ...session("slack:C1:1"),
      destination: { ...session("slack:C1:1").destination, primaryAction: { label: "Merge", text: "merge" } },
    };
    const home = createHomeSession(
      (async (address: string, init?: RequestInit) => {
        if (address === "/home/session") return new Response(JSON.stringify(session(null)));
        if (address === "/home/focus") return new Response(JSON.stringify(first));
        if (address === "/home/key") return new Response(JSON.stringify({ key: "issued:second" }));
        sends.push(JSON.parse(String(init?.body)));
        if (sends.length === 1) throw new Error("unknown outcome");
        return new Response(JSON.stringify({ status: "accepted", duplicate: sends.length === 2 }));
      }) as typeof fetch,
      stream.factory,
    );
    await home.load();
    await home.focus("slack:C1:1");
    const wrapper = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
    const action = (label: string) => wrapper.findAll("button").find((button) => button.text() === label)!;
    await action("Merge").trigger("click");
    await flushPromises();
    stream.created.at(-1)!.emitMessage({
      ...first,
      destination: { ...first.destination, revision: 2, primaryAction: { label: "Approve", text: "approve" } },
    });
    await flushPromises();
    expect(home.pendingSubmission.value).toBe(true);
    expect(home.text.value).toBe("merge");
    await action("Check saved reply").trigger("click");
    await flushPromises();
    expect(sends).toEqual([
      {
        key: "issued:first",
        revision: 1,
        destination: { kind: "thread", thread: "slack:C1:1" },
        text: "merge",
        context: [],
      },
      {
        key: "issued:first",
        revision: 1,
        destination: { kind: "thread", thread: "slack:C1:1" },
        text: "merge",
        context: [],
      },
    ]);
    expect(wrapper.findAll("button").map((button) => button.text())).toContain("Approve");
    expect(action("Approve").attributes("disabled")).toBeUndefined();
    expect(action("Type a reply").attributes("disabled")).toBeUndefined();
    await action("Approve").trigger("click");
    await flushPromises();
    expect(sends[2]).toEqual({
      key: "issued:second",
      revision: 2,
      destination: { kind: "thread", thread: "slack:C1:1" },
      text: "approve",
      context: [],
    });
    home.dispose();
  });
  it("loads an advertised older window through the actual control and keeps the broad draft", async () => {
    const initial = {
      ...session(null),
      history: { cursor: 8, hasMore: true, status: "partial" as const, previousUrl: "/home/session?before=8" },
    };
    const fetcher = vi.fn(
      async (address: string) =>
        new Response(
          JSON.stringify(
            address === "/home/session"
              ? initial
              : {
                  ...initial,
                  entries: [{ id: "old", role: "user", isViewer: true, content: "Earlier request" }],
                  history: { cursor: 1, hasMore: true, status: "partial", latestUrl: "/home/session" },
                },
          ),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const home = createHomeSession(fetcher as typeof fetch, fakeEventSourceFactory().factory);
    await home.load();
    const wrapper = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
    await wrapper.get("textarea").setValue("Broad draft");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Older messages")
      ?.trigger("click");
    await flushPromises();
    expect(fetcher.mock.calls.map(([address]) => address)).toEqual(["/home/session", "/home/session?before=8"]);
    expect(wrapper.text()).toContain("Earlier request");
    expect(wrapper.get("textarea").element.value).toBe("Broad draft");
    expect(wrapper.findAll("button").map((button) => button.text())).toContain("Latest messages");
    home.dispose();
  });
  it("deletes saved text only after confirmation, refreshes its session and rejects the old stream", async () => {
    const own = {
      id: "own",
      role: "user" as const,
      content: "Private request",
      isViewer: true,
      deleteUrl: "/home/messages/receipt%3A1",
    };
    const other = { id: "other", role: "user" as const, content: "Other source request", isViewer: false };
    const initial = { ...session(null), entries: [own, other] };
    const fresh = { ...session(null), accessEpoch: "after-deletion", revision: 2, entries: [other] };
    let removed = false;
    const fetcher = vi.fn(async (address: string) => {
      if (address === "/home/session") return new Response(JSON.stringify(removed ? fresh : initial));
      removed = true;
      return new Response(JSON.stringify({ status: "ok" }));
    });
    const stream = fakeEventSourceFactory();
    const home = createHomeSession(fetcher as typeof fetch, stream.factory);
    await home.load();
    const oldStream = stream.created[0];
    const wrapper = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
    await wrapper.get("textarea").setValue("Keep this draft");
    await wrapper.get('[aria-label="Remove private request content"]').trigger("click");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[aria-label="Delete saved text confirmation"]').text()).toContain("This cannot be undone");
    await wrapper.get('[aria-label="Delete saved text confirmation"]').findAll("button")[0]!.trigger("click");
    await flushPromises();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/home/session",
      "/home/messages/receipt%3A1",
      "/home/session",
    ]);
    expect(wrapper.get(".green-dock-transcript").text()).not.toContain("Private request");
    expect(wrapper.text()).toContain("Other source request");
    expect(wrapper.get("textarea").element.value).toBe("Keep this draft");
    expect(home.contentRemovals.value).toBe(1);
    oldStream?.emitMessage(initial);
    expect(home.session.value?.accessEpoch).toBe("after-deletion");
    expect(wrapper.text()).not.toContain("Private request");
    home.dispose();
  });
  it("requires a visible review action before sending a draft for a changed question", async () => {
    const stream = fakeEventSourceFactory();
    const local = session("slack:C1:1");
    const fetcher = vi.fn(
      async (address: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify(
            address === "/home/session" ? session(null) : address === "/home/focus" ? local : { status: "accepted" },
          ),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const home = createHomeSession(fetcher as typeof fetch, stream.factory);
    await home.load();
    await home.focus("slack:C1:1");
    const wrapper = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
    await wrapper.get("textarea").setValue("Old question draft");
    stream.created.at(-1)?.emitMessage({ ...local, revision: 2, destination: { ...local.destination, revision: 2 } });
    await nextTick();
    expect(wrapper.text()).toContain("The question changed");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Use draft for current question")
      ?.trigger("click");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(JSON.parse((fetcher.mock.calls[2][1] as RequestInit).body as string)).toMatchObject({
      revision: 2,
      text: "Old question draft",
    });
    home.dispose();
  });
  it("uses proved authorship for You and preserves other people, unknown authors and service labels", async () => {
    const initial = {
      ...session(null),
      entries: [
        { id: "mine", role: "user", content: "My message", isViewer: true },
        { id: "other", role: "user", content: "Other message", isViewer: false, authorLabel: "Other person" },
        { id: "unknown", role: "user", content: "Unknown message", isViewer: false },
        { id: "bot", role: "assistant", content: "External message", isViewer: false, authorLabel: "External bot" },
        {
          id: "delegated",
          role: "user",
          content: "Delegated message",
          isViewer: false,
          authorLabel: "Deployment service",
        },
        { id: "agent", role: "assistant", content: "Unknown agent message", isViewer: false },
        { id: "receipt", role: "receipt", content: "Saved receipt", isViewer: false },
      ],
    };
    const home = createHomeSession(
      (async () =>
        new Response(JSON.stringify(initial), { headers: { "content-type": "application/json" } })) as typeof fetch,
      fakeEventSourceFactory().factory,
    );
    await home.load();
    const wrapper = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
    expect(wrapper.findAll(".green-message-label").map((label) => label.text())).toEqual([
      "You",
      "Other person",
      "Unknown author",
      "External bot",
      "Deployment service",
      "Unknown author",
      "Receipt",
    ]);
    home.dispose();
  });
  it("captures actual transcript scrolling and restores broad 420 and local 80 independently", async () => {
    const stream = fakeEventSourceFactory();
    const answers = [session(null), session("slack:C1:1"), session("slack:C1:1")];
    const home = createHomeSession(
      (async () =>
        new Response(JSON.stringify(answers.shift()), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      stream.factory,
    );
    await home.load();
    const wrapper = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
    await nextTick();
    const transcript = wrapper.find('[aria-label="Conversation transcript"]');
    (transcript.element as HTMLElement).scrollTop = 420;
    await transcript.trigger("scroll");
    expect(home.scroll.value).toBe(420);
    await home.focus("slack:C1:1");
    await nextTick();
    await nextTick();
    (transcript.element as HTMLElement).scrollTop = 80;
    await transcript.trigger("scroll");
    expect(home.scroll.value).toBe(80);
    home.exitFocus();
    await nextTick();
    await nextTick();
    expect((transcript.element as HTMLElement).scrollTop).toBe(420);
    await home.focus("slack:C1:1");
    await nextTick();
    await nextTick();
    expect((transcript.element as HTMLElement).scrollTop).toBe(80);
    home.dispose();
  });
});
