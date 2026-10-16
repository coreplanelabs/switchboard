// Feature: docs/reference/specs/browser-home.md — unfocused transcript access is continuously checked.
import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import type { HomeSession } from "@core/channels/homeSeed.js";
import { mountApp } from "../../src/testing/mount";
import { fakeEventSourceFactory } from "../../src/testing/fakeEventSource";
import { createHomeSession, HomeSessionKey } from "../lib/homeSession";
import ReadonlyThread from "./ReadonlyThread.vue";
import ThreadPage from "../pages/Thread.vue";
enableAutoUnmount(afterEach);
const thread = "slack:C1:1";
function session(focused = false): HomeSession {
  return {
    version: 1,
    organization: "org",
    actor: "access:alice",
    stream: "person:alice",
    bindingRevision: 0,
    accessEpoch: "fixture:policy",
    revision: 7,
    entries: focused
      ? [
          {
            id: "r:request",
            role: "user",
            content: "Morgan's private source words",
            isViewer: false,
            authorLabel: "Morgan",
            source: "slack",
          },
        ]
      : [],
    turns: focused
      ? [
          {
            id: "r",
            startedAt: 1,
            eventCount: 2,
            request: "Morgan's private source words",
            finished: true,
            answer: "Recorded answer",
          },
        ]
      : [],
    destination: {
      kind: focused ? "thread" : "broad",
      thread: focused ? thread : null,
      label: "Conversation",
      revision: 0,
      canWrite: true,
    },
    history: { cursor: 0, hasMore: false, status: "partial" },
    commands: [],
    submissionKey: "issued",
    sendUrl: "/home/send",
    eventsUrl: "/home/events",
  };
}
describe("unfocused thread privacy", () => {
  it("focuses the read-only unavailable explanation on explicit revocation without focusing network failures", async () => {
    const stream = fakeEventSourceFactory();
    const home = createHomeSession(
      (async (url: string) => new Response(JSON.stringify(session(url.includes("thread="))))) as typeof fetch,
      stream.factory,
    );
    await home.load();
    const page = mountApp(ReadonlyThread, {
      props: { thread },
      eventSource: stream.factory,
      provides: [[HomeSessionKey, home]],
    });
    await flushPromises();
    (page.get("button").element as HTMLButtonElement).focus();
    const observer = stream.created.find((source) => source.url.includes("observe=1"))!;
    observer.emitError();
    await flushPromises();
    expect(document.activeElement?.getAttribute("tabindex")).not.toBe("-1");
    expect(page.text()).toContain("Conversation is unavailable");
    page.unmount();
    const ready = mountApp(ReadonlyThread, {
      props: { thread },
      eventSource: stream.factory,
      provides: [[HomeSessionKey, home]],
    });
    await flushPromises();
    (ready.get("button").element as HTMLButtonElement).focus();
    stream.created.at(-1)!.emitNamed("revoked");
    await flushPromises();
    expect(document.activeElement?.textContent).toContain("Conversation is unavailable");
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
    home.dispose();
  });

  it("offers All people Reply only after the actual viewer's target session proves write access and holds unavailable private targets", async () => {
    const stream = fakeEventSourceFactory();
    const home = createHomeSession(
      (async (url: string) =>
        url.includes("thread=")
          ? new Response(JSON.stringify(session(true)))
          : new Response(JSON.stringify(session()))) as typeof fetch,
      stream.factory,
    );
    await home.load();
    const page = mountApp(ReadonlyThread, {
      props: { thread },
      seed: { page: "runNotFound", retentionDays: null, dataView: { mode: "everyone", canViewEveryone: true } },
      eventSource: stream.factory,
      provides: [[HomeSessionKey, home]],
    });
    await flushPromises();
    const observer = stream.created.find((source) => source.url.includes("observe=1"))!;
    observer.emitMessage({ ...session(true), destination: { ...session(true).destination, canWrite: false } });
    await flushPromises();
    expect(page.findAll("button").map((button) => button.text())).toContain("Reply in this thread");
    expect(home.session.value?.destination.kind).toBe("broad");
    observer.emitNamed("revoked");
    await flushPromises();
    expect(page.text()).toContain("Conversation is unavailable");
    expect(page.findAll("button").map((button) => button.text())).not.toContain("Reply in this thread");
    home.dispose();
    const unavailable = createHomeSession(
      (async (url: string) =>
        url.includes("thread=")
          ? new Response(JSON.stringify({ status: "not_found" }), { status: 404 })
          : new Response(JSON.stringify(session()))) as typeof fetch,
      stream.factory,
    );
    await unavailable.load();
    const denied = mountApp(ReadonlyThread, {
      props: { thread: "worker:other:U10" },
      seed: { page: "runNotFound", retentionDays: null, dataView: { mode: "everyone", canViewEveryone: true } },
      eventSource: stream.factory,
      provides: [[HomeSessionKey, unavailable]],
    });
    await flushPromises();
    expect(denied.text()).toContain("Conversation is unavailable");
    expect(denied.findAll("button").map((button) => button.text())).not.toContain("Reply in this thread");
    unavailable.dispose();
  });
  it("does not restore private All people content or Reply after a late target proof loses its observer", async () => {
    const stream = fakeEventSourceFactory();
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const home = createHomeSession(
      (async (url: string) =>
        url.includes("thread=") ? pending : new Response(JSON.stringify(session()))) as typeof fetch,
      stream.factory,
    );
    await home.load();
    const page = mountApp(ReadonlyThread, {
      props: { thread },
      seed: { page: "runNotFound", retentionDays: null, dataView: { mode: "everyone", canViewEveryone: true } },
      eventSource: stream.factory,
      provides: [[HomeSessionKey, home]],
    });
    stream.created.find((source) => source.url.includes("observe=1"))!.emitNamed("revoked");
    finish(new Response(JSON.stringify(session(true))));
    await flushPromises();
    expect(page.text()).toContain("Conversation is unavailable");
    expect(page.text()).not.toContain("Morgan's private source words");
    expect(page.findAll("button").map((button) => button.text())).not.toContain("Reply in this thread");
    home.dispose();
  });
  it("allows a view-as target observer to establish its own epoch while the personal session is unavailable", async () => {
    const stream = fakeEventSourceFactory();
    const home = createHomeSession(
      (async () => new Response(JSON.stringify({ status: "not_found" }), { status: 404 })) as typeof fetch,
      stream.factory,
    );
    await home.load();
    const wrapper = mountApp(ReadonlyThread, {
      props: { thread },
      seed: {
        page: "home",
        title: "Thread",
        conversation: thread,
        lane: "web:alice",
        now: 1,
        retentionDays: 30,
        turns: [],
        conversations: [],
        viewer: { name: "Admin" },
        suggestions: [],
        commands: [],
        sendUrl: "/threads/source/send",
        viewingAs: { id: "slack:UBOB", name: "Bob" },
      },
      eventSource: stream.factory,
      provides: [[HomeSessionKey, home]],
    });
    const observer = stream.created.find((source) => source.url.includes("observe=1"));
    expect(observer).toBeDefined();
    observer!.emitMessage({
      ...session(true),
      accessEpoch: "fixture:view-as-policy",
      destination: { ...session(true).destination, canWrite: false },
    });
    await nextTick();
    expect(wrapper.text()).toContain("Morgan's private source words");
    expect(wrapper.findAll("button").map((button) => button.text())).not.toContain("Reply in this thread");
    observer!.emitMessage({ ...session(true), accessEpoch: "fixture:another-scope" });
    await nextTick();
    expect(wrapper.text()).not.toContain("Morgan's private source words");
    expect(wrapper.text()).toContain("Conversation is unavailable");
    home.dispose();
  });
  it.each(["unit", "thread"])(
    "%s observes the exact thread without moving the composer and removes all private turns on revocation",
    async (page) => {
      const stream = fakeEventSourceFactory();
      const home = createHomeSession(
        (async (url: string) => new Response(JSON.stringify(session(url.includes("?thread="))))) as typeof fetch,
        stream.factory,
      );
      await home.load();
      const wrapper = mountApp(page === "unit" ? ReadonlyThread : ThreadPage, {
        props: page === "unit" ? { thread } : {},
        seed:
          page === "thread"
            ? {
                page: "home",
                title: "Thread",
                conversation: thread,
                lane: "web:alice",
                now: 1,
                retentionDays: 30,
                turns: [],
                conversations: [],
                viewer: { name: "Alice" },
                suggestions: [],
                commands: [],
                sendUrl: "/threads/source/send",
                elsewhere: { surface: "slack" },
              }
            : undefined,
        eventSource: stream.factory,
        provides: [[HomeSessionKey, home]],
      });
      await flushPromises();
      const observer = stream.created.find((source) => source.url === "/home/events?thread=slack%3AC1%3A1&observe=1");
      expect(observer).toBeDefined();
      observer!.emitMessage(session(true));
      await nextTick();
      expect(wrapper.text()).toContain("Morgan");
      expect(wrapper.text()).toContain("Morgan's private source words");
      expect(home.session.value?.destination.kind).toBe("broad");
      observer!.emitNamed("revoked");
      await nextTick();
      expect(wrapper.text()).toContain("Conversation is unavailable");
      expect(wrapper.text()).not.toContain("Morgan");
      expect(wrapper.findAll(".turn")).toHaveLength(0);
      expect(observer!.closed).toBe(true);
      home.dispose();
    },
  );
  it("clears an unfocused transcript on another source epoch change and ignores late prior frames", async () => {
    const stream = fakeEventSourceFactory();
    const home = createHomeSession(
      (async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes("?thread=")
              ? { ...session(true), destination: { ...session(true).destination, canWrite: false } }
              : session(),
          ),
        )) as typeof fetch,
      stream.factory,
    );
    await home.load();
    const wrapper = mountApp(ReadonlyThread, {
      props: { thread },
      eventSource: stream.factory,
      provides: [[HomeSessionKey, home]],
    });
    await flushPromises();
    const old = stream.created.find((source) => source.url.includes("observe=1"));
    expect(old).toBeDefined();
    old!.emitMessage(session(true));
    await nextTick();
    old!.emitMessage({ ...session(true), destination: { ...session(true).destination, canWrite: false } });
    await nextTick();
    expect(wrapper.text()).toContain("Morgan's private source words");
    expect(wrapper.findAll("button").map((button) => button.text())).not.toContain("Reply in this thread");
    stream.created[0].emitMessage({ ...session(), accessEpoch: "fixture:revoked-source" });
    await nextTick();
    old!.emitMessage(session(true));
    await nextTick();
    expect(wrapper.text()).not.toContain("Morgan's private source words");
    expect(old!.closed).toBe(true);
    home.dispose();
  });
});
