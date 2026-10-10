// Feature: docs/reference/specs/browser-home.md — real green page composition and one composer.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createGreenPreview } from "../../scripts/web-green-fixtures.js";
import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import type { HomeSeed, UnitSeed } from "@core/channels/webSeed.js";
import type { HomeSession } from "@core/channels/homeSeed.js";
import PipelinePage from "./pages/Pipeline.vue";
import UnitPage from "./pages/Unit.vue";
import ThreadPage from "./pages/Thread.vue";
import ConversationDock from "./components/ConversationDock.vue";
import { createHomeSession, HomeSessionKey } from "./lib/homeSession";
import { fakeEventSourceFactory } from "../src/testing/fakeEventSource";
import { ALL_ON, mountApp } from "../src/testing/mount";
enableAutoUnmount(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function session(over: Partial<HomeSession> = {}): HomeSession {
  return {
    version: 1,
    organization: "org",
    actor: "access:alice",
    stream: "person:alice",
    bindingRevision: 0,
    revision: 4,
    entries: [],
    sendUrl: "/home/send",
    eventsUrl: "/home/events",
    submissionKey: "issued:first",
    commands: [],
    destination: { kind: "broad", label: "Your messages to Switchboard", thread: null, revision: 4, canWrite: true },
    ...over,
  };
}
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const thread: HomeSeed = {
  page: "home",
  conversation: "slack:C1:1",
  turns: [],
  conversations: [],
  viewer: { name: "Alice" },
  sendUrl: "/unused",
  lane: "web:alice",
  elsewhere: { surface: "slack" },
  now: 1000,
  retentionDays: 30,
  suggestions: [],
  commands: [],
};

describe("Green browser frontend", () => {
  it("keeps missing or denied thread reads unavailable without local reply while preserving the authenticated broad dock", async () => {
    const stream = fakeEventSourceFactory();
    const home = createHomeSession((async () => json(session())) as typeof fetch, stream.factory);
    await home.load();
    const host = defineComponent({ render: () => h("div", [h(ThreadPage), h(ConversationDock)]) });
    for (const seed of [null, { page: "runNotFound", retentionDays: 30 } as const]) {
      const page = mountApp(host, { seed, provides: [[HomeSessionKey, home]] });
      expect(page.find(".green-empty h3").text()).toBe("Thread unavailable");
      expect(page.text()).not.toContain("This authorized thread contains no retained turns.");
      expect(page.findAll("button").map((button) => button.text())).not.toContain("Reply in this thread");
      expect(page.find(".green-destination").text()).toBe("Your messages to Switchboard");
      expect(page.findAll("textarea")).toHaveLength(1);
      page.unmount();
    }
    const empty = mountApp(host, { seed: thread, provides: [[HomeSessionKey, home]] });
    expect(empty.find(".green-empty h3").text()).toBe("No conversation to show");
    expect(empty.text()).toContain("This authorized thread contains no retained turns.");
    expect(empty.findAll("button").map((button) => button.text())).toContain("Reply in this thread");
    home.dispose();
  });
  it.each([
    { label: "a full browser key", conversation: "web:alice:conv-1", elsewhere: undefined, target: "web:alice:conv-1" },
    { label: "a short browser id", conversation: "conv-1", elsewhere: undefined, target: "web:alice:conv-1" },
    { label: "a foreign key", conversation: "slack:C1:1", elsewhere: { surface: "slack" }, target: "slack:C1:1" },
  ])(
    "replies to $label through the exact authorized thread destination",
    async ({ conversation, elsewhere, target }) => {
      const stream = fakeEventSourceFactory();
      let focusRequest: unknown;
      const fetcher = async (url: string, init?: RequestInit) => {
        if (url === "/home/session") return json(session());
        focusRequest = JSON.parse(String(init?.body));
        if ((focusRequest as { thread: string }).thread !== target)
          return new Response(JSON.stringify({ status: "not_found" }), { status: 404 });
        return json(
          session({
            destination: { kind: "thread", thread: target, label: "Chosen thread", revision: 9, canWrite: true },
          }),
        );
      };
      const home = createHomeSession(fetcher as typeof fetch, stream.factory);
      home.routeChanged(`/threads/${encodeURIComponent(conversation)}`);
      await home.load();
      const host = defineComponent({ render: () => h("div", [h(ThreadPage), h(ConversationDock)]) });
      const page = mountApp(host, {
        seed: { ...thread, conversation, elsewhere },
        eventSource: stream.factory,
        provides: [[HomeSessionKey, home]],
      });
      await page
        .findAll("button")
        .find((button) => button.text() === "Reply in this thread")!
        .trigger("click");
      await flushPromises();
      expect(focusRequest).toEqual({ thread: target });
      expect(page.find(".green-destination").text()).toBe("Chosen thread");
      expect(page.findAll("textarea")).toHaveLength(1);
      home.dispose();
    },
  );
  it("mounts one composer and changes its announced destination only after explicit thread focus", async () => {
    const stream = fakeEventSourceFactory();
    const fetcher = vi.fn(async (url: string) =>
      url === "/home/session"
        ? json(session())
        : json(
            session({
              destination: {
                kind: "thread",
                label: "Unit A thread",
                thread: "slack:C1:1",
                revision: 9,
                canWrite: true,
              },
              submissionKey: "issued:local",
            }),
          ),
    );
    const home = createHomeSession(fetcher as typeof fetch, stream.factory);
    home.routeChanged("/threads/slack%3AC1%3A1");
    await home.load();
    const host = defineComponent({ render: () => h("div", [h(ThreadPage), h(ConversationDock)]) });
    const wrapper = mountApp(host, { seed: thread, eventSource: stream.factory, provides: [[HomeSessionKey, home]] });
    expect(wrapper.findAll("textarea").length).toBe(1);
    await wrapper.find("textarea").setValue("Broad draft");
    const button = wrapper.findAll("button").find((candidate) => candidate.text() === "Reply in this thread");
    expect(button?.text()).toBe("Reply in this thread");
    await button?.trigger("click");
    await nextTick();
    expect(wrapper.findAll("textarea").length).toBe(1);
    expect(wrapper.find(".green-destination").text()).toBe("Unit A thread");
    expect(wrapper.find("textarea").element.value).toBe("");
    await wrapper.find("textarea").setValue("Local draft");
    home.routeChanged("/home");
    await nextTick();
    expect(wrapper.find(".green-destination").text()).toBe("Your messages to Switchboard");
    expect(wrapper.find("textarea").element.value).toBe("Broad draft");
    home.dispose();
  });
  it("removes the composer and transcript on an active private-feed revocation", async () => {
    const stream = fakeEventSourceFactory();
    const home = createHomeSession((async () => json(session())) as typeof fetch, stream.factory);
    await home.load();
    const wrapper = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
    await wrapper.find("textarea").setValue("Private draft");
    stream.created.at(-1)?.emitNamed("revoked");
    await nextTick();
    expect(wrapper.text()).toContain("Conversation is unavailable with your current access.");
    expect(wrapper.findAll("textarea").length).toBe(0);
    expect(wrapper.text()).not.toContain("Private draft");
    home.dispose();
  });
  it("discloses more retained history and does not call an empty bounded page a complete conversation", async () => {
    const stream = fakeEventSourceFactory();
    const home = createHomeSession(
      (async () => json(session({ history: { cursor: 200, hasMore: true, status: "complete" } }))) as typeof fetch,
      stream.factory,
    );
    await home.load();
    const wrapper = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
    expect(wrapper.text()).toContain("More retained messages exist beyond this page.");
    expect(wrapper.text()).toContain("No readable messages in this page");
    stream.created.at(-1)?.emitMessage(session({ revision: 5, history: undefined }));
    await nextTick();
    expect(wrapper.text()).toContain("Conversation coverage is unknown.");
    home.dispose();
  });
  it("keeps view-as pages read-only even when the person's own broad session permits writes", async () => {
    const stream = fakeEventSourceFactory();
    const home = createHomeSession((async () => json(session())) as typeof fetch, stream.factory);
    await home.load();
    const host = defineComponent({ render: () => h("div", [h(ThreadPage), h(ConversationDock)]) });
    const wrapper = mountApp(host, {
      seed: { ...thread, title: "Read-only", capabilities: ALL_ON, viewingAs: { id: "slack:bob", name: "Bob" } },
      eventSource: stream.factory,
      provides: [[HomeSessionKey, home]],
    });
    expect(wrapper.text()).toContain("This view is read-only.");
    expect(wrapper.findAll("textarea").length).toBe(0);
    expect(wrapper.findAll("button").map((button) => button.text())).not.toContain("Reply in this thread");
    home.dispose();
  });
  it("opens an artifact-proven unit PR in the canonical run query route", async () => {
    const seed: UnitSeed = {
      page: "unit",
      now: 1000,
      retentionDays: 30,
      view: {
        unit: "pipeline:u",
        instanceId: "pipeline",
        id: "u",
        title: "Bound unit",
        branch: "codex/u",
        threads: {},
        sourceUrls: {},
        rounds: [],
        instance: { id: "pipeline", repo: "sample/api", createdAt: 1 },
        pr: { number: 42, url: "https://github.com/sample/api/pull/42" },
        runs: [{ id: "evidence", agent: "code", finished: true, startedAt: 1, eventCount: 2 }],
      },
    };
    vi.stubGlobal("fetch", async () =>
      json({
        page: "run",
        title: "Run evidence",
        capabilities: ALL_ON,
        mode: "history",
        id: "evidence",
        startedAt: 1,
        eventCount: 2,
        events: [
          { type: "run_meta", repo: "sample/api", pr: 42, headSha: "abc1234" },
          {
            type: "review_artifact",
            artifact: "reading_diff",
            poweredBy: "git",
            baseRef: "main",
            diff: "recorded diff",
            truncated: false,
          },
        ],
      }),
    );
    const wrapper = mountApp(UnitPage, { seed });
    await wrapper.vm.$router.isReady();
    const button = wrapper.findAll("button").find((candidate) => candidate.text() === "Inspect recorded diff");
    expect(button?.text()).toBe("Inspect recorded diff");
    await button?.trigger("click");
    await flushPromises();
    expect(wrapper.vm.$router.currentRoute.value.fullPath).toBe("/runs/evidence?view=pull-request");
  });
  it("preserves other authors and source provenance when the dock focuses a shared thread", async () => {
    const preview = createGreenPreview({
      now: 1000,
      thread,
      unit: {
        unit: "pipeline:U13",
        instanceId: "pipeline",
        id: "U13",
        title: "Preview unit",
        branch: "codex/u13",
        threads: { coding: "slack:C1:1" },
        sourceUrls: {},
        rounds: [],
        instance: { id: "pipeline", repo: "sample/api", createdAt: 1 },
        runs: [],
      },
    });
    const stream = fakeEventSourceFactory();
    const fetcher = async (address: string, init?: RequestInit) => {
      let status = 0;
      let payload = "";
      const request = {
        url: address,
        method: init?.method ?? "GET",
        async *[Symbol.asyncIterator]() {
          if (init?.body) yield String(init.body);
        },
      } as IncomingMessage;
      const response = {
        writeHead(code: number) {
          status = code;
        },
        end(body: string) {
          payload = body;
        },
      } as unknown as ServerResponse;
      await preview.handle(request, response, new URL(address, "http://preview.test"));
      return new Response(payload, { status, headers: { "content-type": "application/json" } });
    };
    const home = createHomeSession(fetcher as typeof fetch, stream.factory);
    home.routeChanged("/threads/slack%3AC1%3A1");
    await home.load();
    const wrapper = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]], eventSource: stream.factory });
    const labels = () =>
      wrapper.findAll(".green-message-label").map((label) => label.element.firstChild?.textContent?.trim());
    expect(labels()).toEqual(["You", "Switchboard"]);
    expect(await home.focus("slack:C1:1")).toBe(true);
    await nextTick();
    expect(labels()).toEqual(["Morgan", "Unknown author", "Build bot", "Automation on your behalf"]);
    expect(wrapper.findAll(".green-message-label span").map((source) => source.text())).toEqual([
      "slack",
      "slack",
      "slack",
      "http",
    ]);
    expect(wrapper.findAll("textarea")).toHaveLength(1);
    home.exitFocus();
    await nextTick();
    expect(labels()).toEqual(["You", "Switchboard"]);
    home.dispose();
  });
  it("keeps completed pipeline units visible beside proven moving preview work", async () => {
    const preview = createGreenPreview({
      now: 1000,
      thread,
      unit: {
        unit: "pipeline:U13",
        instanceId: "pipeline",
        id: "U13",
        title: "Preview unit",
        branch: "codex/u13",
        threads: { coding: "slack:C1:1" },
        sourceUrls: {},
        rounds: [],
        instance: { id: "pipeline", repo: "sample/api", createdAt: 1 },
        runs: [],
      },
    });
    const page = preview.page(new URL("/pipelines/pipeline", "http://preview.test"));
    if (!page) throw new Error("preview pipeline missing");
    const wrapper = mountApp(PipelinePage, { seed: page.seed });
    expect(wrapper.findAll(".green-unit-row")).toHaveLength(5);
    expect(wrapper.text()).toContain("Preview work 12");
    expect(wrapper.text()).toContain("merged");
    expect(
      wrapper
        .findAll(".green-unit-row-head .green-badge")
        .map((status) => status.text())
        .filter((status) => status === "Working"),
    ).toHaveLength(2);
    expect(wrapper.findAll('a[href="/runs/unit/pipeline%3AU12"]')).toHaveLength(1);
  });
});
