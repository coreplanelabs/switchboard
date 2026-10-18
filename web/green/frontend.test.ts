// Feature: docs/reference/specs/browser-home.md — real green page composition and one composer.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createGreenPreview } from "../../scripts/web-green-fixtures.js";
import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import type { HomeSeed, UnitSeed } from "@core/channels/webSeed.js";
import type { HomeSession } from "@core/channels/homeSeed.js";
import PipelinePage from "./pages/Pipeline.vue";
import HomePage from "./pages/Home.vue";
import UnitPage from "./pages/Unit.vue";
import ReadonlyThread from "./components/ReadonlyThread.vue";
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
    accessEpoch: "fixture:policy",
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
  it("keeps the marked review preview page and its JSON twin identical", async () => {
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
    const usage = preview.page(new URL("/metrics", "http://preview.test"));
    const health = preview.page(new URL("/metrics/health", "http://preview.test"));
    if (usage?.seed.page !== "reviewsMetrics" || health?.seed.page !== "reviewsMetrics")
      throw new Error("review fixture missing");
    let status = 0,
      payload = "";
    const address = new URL("/metrics.json?from=1969-12-26&to=1970-01-01", "http://preview.test");
    const handled = await preview.handle(
      { method: "GET", url: address.pathname + address.search } as IncomingMessage,
      {
        writeHead(code: number) {
          status = code;
        },
        end(body: string) {
          payload = body;
        },
      } as unknown as ServerResponse,
      address,
    );
    expect(handled).toBe(true);
    expect(status).toBe(200);
    const report = JSON.parse(payload);
    expect(report.usage.runs).toBe(21);
    expect(report.dataset).toBe("fixture_reviews");
    expect(report).toEqual(usage.seed.report);
    expect(report).toEqual(health.seed.report);
    expect(report.tiles).toBeUndefined();
  });
  it("ends only snapshot preview event reads after their real initial session frame", async () => {
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
    for (const snapshot of [true, false]) {
      let ended = false,
        frame = "",
        close: (() => void) | undefined;
      const response = {
        writeHead() {},
        write(value: string) {
          frame += value;
        },
        end() {
          ended = true;
        },
        on(event: string, callback: () => void) {
          if (event === "close") close = callback;
        },
      } as unknown as ServerResponse;
      await preview.handle(
        { method: "GET", headers: snapshot ? { "x-switchboard-preview-snapshot": "1" } : {} } as IncomingMessage,
        response,
        new URL("/home/events", "http://preview.test"),
      );
      try {
        expect(ended).toBe(snapshot);
        const payload = JSON.parse(frame.slice("data: ".length).trim());
        expect(payload.actor).toBe("access:preview");
        expect(payload.entries[0].content).toBe("What needs my attention?");
        expect(payload.destination.kind).toBe("broad");
      } finally {
        close?.();
      }
    }
  });
  it.each([false, true])(
    "keeps marked preview Home work visible with its real fixture session loaded before mount: %s",
    async (loaded) => {
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
      const page = preview.page(new URL("/home", "http://preview.test"));
      if (!page) throw new Error("Preview page missing");
      const fetcher = async (address: string) => {
        let status = 0,
          payload = "";
        await preview.handle(
          { url: address, method: "GET" } as IncomingMessage,
          {
            writeHead(code: number) {
              status = code;
            },
            end(body: string) {
              payload = body;
            },
          } as unknown as ServerResponse,
          new URL(address, "http://preview.test"),
        );
        return new Response(payload, { status, headers: { "content-type": "application/json" } });
      };
      const stream = fakeEventSourceFactory();
      const home = createHomeSession(fetcher as typeof fetch, stream.factory);
      if (loaded) await home.load();
      const wrapper = mountApp(HomePage, { seed: page.seed, provides: [[HomeSessionKey, home]] });
      if (!loaded) await home.load();
      await flushPromises();
      expect(home.session.value?.actor).toBe("access:preview");
      expect(home.session.value?.organization).toBe("organization:preview");
      expect(wrapper.get('[data-unit="pipeline:U13"]').text()).toContain("Confirm the review before merging");
      expect(wrapper.text()).toContain("Needs you 1");
      expect(wrapper.text()).not.toContain("Work access changed");
      expect(page.seed.preview).toContain("Fictional local fixtures");
    },
  );
  it("renders recorded private worker and unit entries without fake run controls and clears them on revocation", async () => {
    for (const component of [ThreadPage, ReadonlyThread]) {
      const stream = fakeEventSourceFactory();
      const home = createHomeSession(
        (async (url: string) =>
          json(
            url.includes("?thread=")
              ? session({
                  destination: {
                    kind: "thread",
                    thread: "worker:private:U101",
                    label: "Private original unit",
                    revision: 4,
                    canWrite: false,
                  },
                })
              : session(),
          )) as typeof fetch,
        stream.factory,
      );
      await home.load();
      const page = mountApp(component, {
        seed: { ...thread, conversation: "worker:private:U101" },
        props: component === ReadonlyThread ? { thread: "worker:private:U101" } : undefined,
        eventSource: stream.factory,
        provides: [[HomeSessionKey, home]],
      });
      const observer = stream.created.find((source) => source.url.includes("observe=1"))!;
      observer.emitMessage(
        session({
          turns: [],
          entries: [
            {
              id: "worker:1",
              role: "assistant",
              isViewer: false,
              authorLabel: "Switchboard",
              content: "Private **worker report**",
              at: 2000,
            },
            {
              id: "unit:2",
              role: "user",
              isViewer: true,
              authorLabel: "You",
              source: "browser",
              content: "My saved answer",
              at: 3000,
            },
            {
              id: "question:original",
              role: "receipt",
              isViewer: false,
              authorLabel: "Pending question",
              content: "Choose the private behavior",
              at: 4000,
            },
          ],
          destination: {
            kind: "thread",
            thread: "worker:private:U101",
            label: "Private original unit",
            revision: 4,
            canWrite: false,
          },
        }),
      );
      await flushPromises();
      expect(page.text()).toContain("Private worker report");
      expect(page.get("strong").text()).toBe("worker report");
      expect(page.text()).toContain("My saved answer");
      expect(page.text()).toContain("You · browser");
      expect(page.get('time[datetime="1970-01-01T00:00:03.000Z"]').attributes("datetime")).toBe(
        "1970-01-01T00:00:03.000Z",
      );
      expect(page.text().split("Choose the private behavior")).toHaveLength(2);
      expect(page.text()).not.toContain("No messages in the loaded thread window");
      expect(page.findAll('a[href^="/runs/"]')).toHaveLength(0);
      expect(page.findAll("button").map((button) => button.text())).not.toContain("Stop");
      observer.emitNamed("revoked");
      await flushPromises();
      expect(page.text()).not.toContain("Private worker report");
      expect(page.text()).not.toContain("My saved answer");
      expect(page.text()).toContain("Conversation is unavailable");
      home.dispose();
    }
  });

  it("keeps missing or denied thread reads unavailable without local reply while preserving the authenticated broad dock", async () => {
    const stream = fakeEventSourceFactory();
    const home = createHomeSession(
      (async (url: string) =>
        json(
          url.includes("?thread=")
            ? session({
                turns: [],
                destination: { kind: "thread", thread: "slack:C1:1", label: "Thread", revision: 0, canWrite: true },
              })
            : session(),
        )) as typeof fetch,
      stream.factory,
    );
    await home.load();
    const host = defineComponent({ render: () => h("div", [h(ThreadPage), h(ConversationDock)]) });
    for (const seed of [null, { page: "runNotFound", retentionDays: 30 } as const]) {
      const page = mountApp(host, { seed, eventSource: stream.factory, provides: [[HomeSessionKey, home]] });
      expect(page.find(".green-empty h3").text()).toBe("Thread unavailable");
      expect(page.findAll("button").map((button) => button.text())).not.toContain("Reply in this thread");
      expect(page.find(".green-dock-heading h2").text()).toBe("Messages");
      expect(page.findAll("textarea")).toHaveLength(1);
      page.unmount();
    }
    const empty = mountApp(host, { seed: thread, eventSource: stream.factory, provides: [[HomeSessionKey, home]] });
    expect(empty.text()).toContain("Checking current thread access");
    stream.created
      .find((source) => source.url.includes("observe=1") && !source.closed)!
      .emitMessage(
        session({
          turns: [],
          destination: { kind: "thread", thread: "slack:C1:1", label: "Thread", revision: 0, canWrite: true },
        }),
      );
    await flushPromises();
    expect(empty.find(".green-empty h3").text()).toBe("No messages in the loaded thread window");
    expect(empty.findAll("button").map((button) => button.text())).toContain("Reply in this thread");
    home.dispose();
  });
  it("moves focus to the revoked thread explanation while preserving the broad destination and draft", async () => {
    const streams = fakeEventSourceFactory();
    const local = session({
      destination: { kind: "thread", thread: "slack:C1:1", label: "Original thread", revision: 4, canWrite: true },
    });
    const home = createHomeSession(
      (async (url: string) => json(url.includes("?thread=") ? local : session())) as typeof fetch,
      streams.factory,
    );
    await home.load();
    const host = defineComponent({ render: () => h("div", [h(ThreadPage), h(ConversationDock)]) });
    const page = mountApp(host, { seed: thread, eventSource: streams.factory, provides: [[HomeSessionKey, home]] });
    const observer = streams.created.find((source) => source.url.includes("observe=1"))!;
    observer.emitMessage(local);
    await flushPromises();
    await page.get("textarea").setValue("Keep my broad draft");
    const reply = page.findAll("button").find((button) => button.text() === "Reply in this thread")!;
    (reply.element as HTMLElement).focus();
    expect(document.activeElement).toBe(reply.element);
    observer.emitNamed("revoked");
    await flushPromises();
    const explanation = page.find('[role="alert"][tabindex="-1"]');
    expect(explanation.exists()).toBe(true);
    expect(document.activeElement).toBe(explanation.element);
    expect(home.session.value?.destination.kind).toBe("broad");
    expect(page.get("textarea").element.value).toBe("Keep my broad draft");
    expect(page.findAll("button").map((button) => button.text())).not.toContain("Reply in this thread");
    home.dispose();
  });
  it("keeps initial unavailable thread reads from stealing focus from the broad draft", async () => {
    const streams = fakeEventSourceFactory();
    const home = createHomeSession(
      (async (url: string) =>
        url.includes("?thread=") ? new Response("{}", { status: 404 }) : json(session())) as typeof fetch,
      streams.factory,
    );
    await home.load();
    const host = defineComponent({ render: () => h("div", [h(ThreadPage), h(ConversationDock)]) });
    const page = mountApp(host, { seed: thread, eventSource: streams.factory, provides: [[HomeSessionKey, home]] });
    await flushPromises();
    const composer = page.get("textarea");
    (composer.element as HTMLElement).focus();
    streams.created.find((source) => source.url.includes("observe=1"))?.emitNamed("unavailable");
    await flushPromises();
    expect(page.text()).toContain("Conversation is unavailable");
    expect(document.activeElement).toBe(composer.element);
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
        if (url.startsWith("/home/session?thread="))
          return json(
            session({
              destination: { kind: "thread", thread: target, label: "Chosen thread", revision: 9, canWrite: true },
            }),
          );
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
      expect(page.findAll("button").some((button) => button.text() === "Reply in this thread")).toBe(false);
      stream.created
        .find((source) => source.url.includes("observe=1"))!
        .emitMessage(
          session({
            destination: { kind: "thread", thread: target, label: "Chosen thread", revision: 9, canWrite: true },
          }),
        );
      await flushPromises();
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
    stream.created
      .find((source) => source.url.includes("observe=1"))!
      .emitMessage(
        session({
          destination: { kind: "thread", thread: "slack:C1:1", label: "Unit A thread", revision: 9, canWrite: true },
        }),
      );
    await flushPromises();
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
    expect(wrapper.find(".green-destination").text()).toBe("Private messages · only you");
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
    const home = createHomeSession(
      (async () =>
        json(
          session({ entries: [{ id: "admin", role: "user", isViewer: true, content: "Admin-only private words" }] }),
        )) as typeof fetch,
      stream.factory,
    );
    await home.load();
    const host = defineComponent({ render: () => h("div", [h(ThreadPage), h(ConversationDock)]) });
    const wrapper = mountApp(host, {
      seed: { ...thread, title: "Read-only", capabilities: ALL_ON, viewingAs: { id: "slack:bob", name: "Bob" } },
      eventSource: stream.factory,
      provides: [[HomeSessionKey, home]],
    });
    expect(wrapper.text()).toContain("This view is read-only.");
    expect(wrapper.text()).not.toContain("Admin-only private words");
    expect(wrapper.findAll("textarea").length).toBe(0);
    expect(wrapper.findAll("button").map((button) => button.text())).not.toContain("Reply in this thread");
    home.dispose();
  });
  it("shows an observed merge on the unit while keeping its original reviewed-head report", () => {
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
        runs: [],
        instance: { id: "pipeline", repo: "sample/api", createdAt: 1 },
        ending: { kind: "merge_ready", at: 900, report: "Original reviewed head aaaaaaa." },
        mergeCompletion: { at: 899, sha: "b".repeat(40) },
      },
    };
    const page = mountApp(UnitPage, { seed });
    expect(page.get(".green-badge").text()).toBe("Merged");
    expect(page.text()).toContain("Original reviewed head aaaaaaa.");
    expect(page.text()).not.toContain("This unit has not started");
    expect(page.text()).toContain("No retained run evidence");
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
      // This recording explicitly carries the action; the older shared preview
      // supplies provenance only, and question prose is never an action label.
      const recorded = JSON.parse(payload);
      if (recorded.destination?.thread === "slack:C1:1")
        recorded.destination.primaryAction = { label: "Merge", text: "yes" };
      return new Response(JSON.stringify(recorded), { status, headers: { "content-type": "application/json" } });
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
    expect(wrapper.findAll("textarea")).toHaveLength(0);
    expect(wrapper.findAll("button").map((button) => button.text())).toContain("Merge");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Type a reply")!
      .trigger("click");
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
