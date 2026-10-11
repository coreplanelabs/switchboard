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
  it("removes only an offered owned private request through its real button", async () => {
    const initial = {
      ...session(null),
      entries: [
        {
          id: "own",
          role: "user",
          content: "Private request",
          isViewer: true,
          deleteUrl: "/home/messages/receipt%3A1",
        },
        { id: "other", role: "user", content: "Other source request", isViewer: false },
      ],
    };
    const fetcher = vi.fn(
      async (address: string, _init?: RequestInit) =>
        new Response(JSON.stringify(address === "/home/session" ? initial : { status: "ok" }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const home = createHomeSession(fetcher as typeof fetch, fakeEventSourceFactory().factory);
    await home.load();
    const wrapper = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
    expect(wrapper.findAll('[aria-label="Remove private request content"]')).toHaveLength(1);
    await wrapper.get('[aria-label="Remove private request content"]').trigger("click");
    await flushPromises();
    expect(fetcher.mock.calls[1]).toMatchObject([
      "/home/messages/receipt%3A1",
      { method: "DELETE", credentials: "same-origin" },
    ]);
    expect(wrapper.get(".green-dock-transcript").text()).not.toContain("Private request");
    expect(wrapper.text()).toContain("Other source request");
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
