// Feature: docs/reference/specs/browser-home.md — hash-only navigation preserves an explicit reply destination.
import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, inject, provide, ref } from "vue";
import { useRouter } from "vue-router";
import type { HomeSession } from "@core/channels/homeSeed.js";
import type { WebSeed } from "@core/channels/webSeed.js";
import App from "./App.vue";
import ThreadPage from "./pages/Thread.vue";
import UnitPage from "./pages/Unit.vue";
import { installSeedRouting, SeedRoutingKey } from "../src/lib/seedRouting";
import { SeedKey } from "../src/lib/seed";
import { ALL_ON, mountApp } from "../src/testing/mount";
import { fakeEventSourceFactory } from "../src/testing/fakeEventSource";

enableAutoUnmount(afterEach);
afterEach(() => vi.unstubAllGlobals());
const session: HomeSession = {
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
};
const island: WebSeed = {
  page: "home",
  title: "Thread",
  capabilities: ALL_ON,
  conversation: "slack:C1:1",
  lane: "web:alice",
  turns: [],
  conversations: [],
  viewer: { name: "Alice" },
  sendUrl: "/unused",
  now: 1,
  retentionDays: 30,
  suggestions: [],
  commands: [],
  elsewhere: { surface: "slack" },
};

describe("Green App navigation", () => {
  it("discards a pending page checked before deletion and rechecks the user's selected destination", async () => {
    let removed = false;
    const own = {
      id: "own",
      role: "user" as const,
      isViewer: true,
      content: "Private note for deletion",
      deleteUrl: "/home/messages/own",
    };
    let finishDelete!: (value: Response) => void;
    const deletion = new Promise<Response>((resolve) => {
      finishDelete = resolve;
    });
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/home/messages/own") {
        removed = true;
        return deletion;
      }
      return Response.json({
        ...session,
        accessEpoch: removed ? "after-delete" : session.accessEpoch,
        entries: removed ? [] : [own],
      });
    });
    const seed = {
      ...island,
      title: "Current allowed work",
      pageAccess: { actor: "access:alice", organization: "org" },
    };
    let releaseOld!: (value: WebSeed) => void,
      releaseFresh!: (value: WebSeed) => void,
      runReads = 0;
    const oldPage = new Promise<WebSeed>((resolve) => {
      releaseOld = resolve;
    });
    const freshPage = new Promise<WebSeed>((resolve) => {
      releaseFresh = resolve;
    });
    const host = defineComponent({
      setup() {
        const routing = installSeedRouting(useRouter(), {
          island: seed,
          leave: vi.fn(),
          load: async (address) => {
            if (address !== "/runs") return { ...seed, title: removed ? "Fresh home work" : "Current allowed work" };
            return ++runReads === 1 ? oldPage : freshPage;
          },
        });
        provide(SeedRoutingKey, routing);
        return () => h(App);
      },
    });
    const page = mountApp(host, { eventSource: fakeEventSourceFactory().factory });
    const leaf = defineComponent({
      setup() {
        const data = inject(SeedKey);
        return () => data?.title;
      },
    });
    for (const path of ["/home", "/runs"]) page.vm.$router.addRoute({ path, component: leaf });
    await page.vm.$router.push("/home");
    await flushPromises();
    await page.get("textarea").setValue("Keep the unsent draft");
    const navigation = page.vm.$router.push("/runs");
    await vi.waitFor(() => expect(runReads).toBe(1));
    await page.get('[aria-label="Remove private request content"]').trigger("click");
    const confirm = page.get('[aria-label="Delete saved text confirmation"]').findAll("button")[0]!;
    await confirm.trigger("click");
    finishDelete(Response.json({ status: "ok" }));
    await flushPromises();
    releaseOld({ ...seed, title: "Stale private work" });
    await vi.waitFor(() => expect(runReads).toBe(2));
    expect(page.text()).not.toContain("Stale private work");
    releaseFresh({ ...seed, title: "Fresh selected work" });
    await navigation;
    await flushPromises();
    expect(page.text()).toContain("Fresh selected work");
    expect(page.text()).not.toContain("Dashboard access changed");
    await page.vm.$router.push("/home");
    await flushPromises();
    expect(page.get("textarea").element.value).toBe("Keep the unsent draft");
    expect(page.text()).not.toContain("Private note for deletion");
  });
  it("loads a fresh page after deleting saved text and never restores the old access epoch", async () => {
    const streams = fakeEventSourceFactory();
    const own = {
      id: "own",
      role: "user" as const,
      isViewer: true,
      content: "Erase this saved text",
      deleteUrl: "/home/messages/own",
    };
    let removed = false;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/home/messages/own") {
        removed = true;
        return Response.json({ status: "ok" });
      }
      return Response.json({
        ...session,
        accessEpoch: removed ? "after-deletion" : session.accessEpoch,
        entries: removed ? [] : [own],
      });
    });
    const currentSeed = ref<WebSeed>({
      ...island,
      title: "Old work",
      pageAccess: { actor: "access:alice", organization: "org" },
    });
    const refresh = vi.fn(async (address) => {
      expect(address).toBe("/home");
      currentSeed.value = { ...currentSeed.value, title: "Fresh authorized work" };
      return true;
    });
    const wrapper = mountApp(App, {
      eventSource: streams.factory,
      provides: [[SeedRoutingKey, { loading: ref(false), seedAt: () => currentSeed.value, refresh }]],
    });
    const leaf = defineComponent({
      setup() {
        const seed = inject(SeedKey);
        return () => seed?.title;
      },
    });
    wrapper.vm.$router.addRoute({ path: "/home", component: leaf });
    await wrapper.vm.$router.push("/home");
    await flushPromises();
    const original = streams.created.at(-1)!;
    await wrapper.get("textarea").setValue("Keep my draft");
    await wrapper.get('[aria-label="Remove private request content"]').trigger("click");
    await wrapper.get('[aria-label="Delete saved text confirmation"]').findAll("button")[0]!.trigger("click");
    await flushPromises();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain("Fresh authorized work");
    expect(wrapper.text()).not.toContain("Dashboard access changed");
    expect(wrapper.get("textarea").element.value).toBe("Keep my draft");
    original.emitMessage({ ...session, entries: [own] });
    await flushPromises();
    expect(wrapper.text()).not.toContain("Erase this saved text");
    expect(wrapper.text()).toContain("Fresh authorized work");
  });

  it.each([
    "unit write",
    "thread read",
    "late unit read",
    "recovered unit network",
    "pending malformed unit read",
    "plain unit denial",
    "empty thread denial",
  ] as const)("keeps freshly authorized broad conversation after focused %s access loss", async (loss) => {
    const streams = fakeEventSourceFactory();
    const unitPage = loss !== "thread read" && loss !== "empty thread denial";
    const readLost = loss === "thread read" || loss === "late unit read" || loss === "pending malformed unit read";
    const thread = unitPage ? "worker:private:alice" : "slack:C1:1";
    const local: HomeSession = {
      ...session,
      eventsUrl: `/home/events?thread=${encodeURIComponent(thread)}`,
      entries: [{ id: "target", role: "assistant", isViewer: false, content: "Readable target journal" }],
      destination: { kind: "thread", thread, label: "Private target", revision: 4, canWrite: true },
    };
    let revoked = false;
    let denyTarget!: (value: Response) => void;
    const pendingTarget = new Promise<Response>((resolve) => {
      denyTarget = resolve;
    });
    let authorize!: (value: Response) => void;
    const freshBroad = new Promise<Response>((resolve) => {
      authorize = resolve;
    });
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/home/session") return revoked ? freshBroad : new Response(JSON.stringify(session));
      if (url === "/home/focus") return new Response(JSON.stringify(local));
      if (url === "/home/send") {
        revoked = true;
        return new Response(loss === "plain unit denial" ? "forbidden" : "", {
          status: loss === "plain unit denial" ? 403 : 404,
        });
      }
      if (url.includes("?thread="))
        return loss === "pending malformed unit read" && revoked
          ? pendingTarget
          : readLost && revoked
            ? new Response("{}", { status: 403 })
            : new Response(JSON.stringify({ ...local, destination: { ...local.destination, canWrite: !revoked } }));
      throw new Error(`Unexpected request ${url} ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const seed = (
      unitPage
        ? {
            page: "unit",
            title: "Private unit",
            now: 1000,
            retentionDays: 30,
            view: {
              unit: "private:U10",
              instanceId: "private",
              id: "U10",
              title: "Alice private deliverable",
              branch: "codex/private-alice",
              threads: { coding: thread },
              sourceUrls: {},
              rounds: [],
              runs: [],
              instance: { id: "private", repo: "sample/private", createdAt: 1 },
            },
          }
        : { ...island }
    ) as WebSeed;
    Object.assign(seed, {
      capabilities: ALL_ON,
      asUser: { id: "access:alice" },
      dataView: { mode: "mine" },
      pageAccess: { actor: "access:alice", organization: "org" },
    });
    const wrapper = mountApp(App, {
      eventSource: streams.factory,
      provides: [[SeedRoutingKey, { loading: ref(false), seedAt: () => seed }]],
    });
    wrapper.vm.$router.addRoute({
      path: unitPage ? "/runs/unit/:key" : "/threads/:id",
      component: unitPage ? UnitPage : ThreadPage,
    });
    await wrapper.vm.$router.push(unitPage ? "/runs/unit/private%3AU10" : "/threads/slack%3AC1%3A1");
    await flushPromises();
    await wrapper.get("textarea").setValue("Keep my authorized broad draft");
    const broadTranscript = wrapper.get('[aria-label="Conversation transcript"]');
    (broadTranscript.element as HTMLElement).scrollTop = 420;
    await broadTranscript.trigger("scroll");
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Reply in this thread"))!
      .trigger("click");
    await flushPromises();
    expect(wrapper.get("textarea").element.value).toBe("");
    await wrapper.get("textarea").setValue("Local unsent private action");
    const focused = streams.created.find((source) => source.url === local.eventsUrl && !source.closed)!;
    const sendDenied = loss === "plain unit denial" || loss === "empty thread denial";
    if (sendDenied) await wrapper.get(".green-dock form").trigger("submit");
    else {
      revoked = true;
      focused.emitNamed("revoked");
    }
    const observer = streams.created.find((source) => source.url.includes("observe=1") && !source.closed);
    if (loss === "thread read") observer?.emitNamed("revoked");
    else if (!readLost) observer?.emitMessage({ ...local, destination: { ...local.destination, canWrite: false } });
    await flushPromises();
    expect(wrapper.text()).not.toContain("Local unsent private action");
    authorize(
      new Response(
        JSON.stringify({
          ...session,
          submissionKey: "issued:recovered",
          entries: [{ id: "fresh", role: "assistant", isViewer: false, content: "Current authorized broad message" }],
        }),
      ),
    );
    await flushPromises();
    if (loss === "recovered unit network") {
      const currentObserver = streams.created.find((source) => source.url.includes("observe=1") && !source.closed)!;
      (wrapper.get("textarea").element as HTMLTextAreaElement).focus();
      currentObserver.emitError();
      await flushPromises();
      expect(wrapper.get(".green-page-content").text()).toContain("Alice private deliverable");
      expect(document.activeElement).toBe(wrapper.get("textarea").element);
    }
    if (loss === "pending malformed unit read") {
      const currentObserver = streams.created.find((source) => source.url.includes("observe=1") && !source.closed)!;
      currentObserver.emitMessage("{broken");
      await flushPromises();
      denyTarget(new Response("{}", { status: 403 }));
      await flushPromises();
      expect(wrapper.get(".green-page-content").text()).not.toContain("Alice private deliverable");
      expect(wrapper.get(".green-page-content").text()).toContain("Dashboard access changed");
    }
    if (loss === "late unit read") {
      observer?.emitNamed("revoked");
      await flushPromises();
      expect(wrapper.get(".green-page-content").text()).not.toContain("Alice private deliverable");
      expect(wrapper.get(".green-page-content").text()).toContain("Dashboard access changed");
    }
    expect(wrapper.get("textarea").element.value).toBe("Keep my authorized broad draft");
    expect(wrapper.get('[aria-label="Conversation transcript"]').text()).toContain("Current authorized broad message");
    expect((wrapper.get('[aria-label="Conversation transcript"]').element as HTMLElement).scrollTop).toBe(420);
    expect(wrapper.get(".green-dock").text()).not.toContain("Readable target journal");
    if (loss === "thread read")
      expect(wrapper.get(".green-page-content").text()).not.toContain("Readable target journal");
    else if (loss === "unit write" || loss === "recovered unit network" || (sendDenied && unitPage))
      expect(wrapper.get(".green-page-content").text()).toContain("Alice private deliverable");
    else if (sendDenied) expect(wrapper.get(".green-page-content").text()).toContain("Readable target journal");
    expect(
      fetcher.mock.calls.filter(([url]) => url === "/home/send").map(([, init]) => JSON.parse(String(init?.body))),
    ).toEqual(
      sendDenied
        ? [
            {
              key: "issued:first",
              revision: 4,
              destination: { kind: "thread", thread },
              text: "Local unsent private action",
              context: [],
            },
          ]
        : [],
    );
  });

  it("removes revoked unit metadata and attached context while preserving its independently authorized broad draft", async () => {
    const streams = fakeEventSourceFactory();
    const local = {
      ...session,
      entries: [{ id: "private", role: "assistant", isViewer: false, content: "Private unit journal" }],
      destination: {
        kind: "thread",
        thread: "worker:private:alice",
        label: "Private unit",
        revision: 4,
        canWrite: false,
      },
    };
    vi.stubGlobal(
      "fetch",
      async (url: string) =>
        new Response(JSON.stringify(url.includes("?thread=") ? local : session), {
          headers: { "content-type": "application/json" },
        }),
    );
    const privateUnit = {
      page: "unit",
      title: "Private unit",
      capabilities: ALL_ON,
      now: 1000,
      retentionDays: 30,
      asUser: { id: "access:alice" },
      pageAccess: { actor: "access:alice", organization: "org" },
      dataView: { mode: "mine" },
      view: {
        unit: "private:U10",
        instanceId: "private",
        id: "U10",
        title: "Alice private deliverable",
        branch: "codex/private-alice",
        threads: { coding: "worker:private:alice" },
        sourceUrls: {},
        rounds: [],
        runs: [],
        instance: { id: "private", repo: "sample/private", createdAt: 1 },
      },
    } as unknown as WebSeed;
    const wrapper = mountApp(App, {
      eventSource: streams.factory,
      provides: [[SeedRoutingKey, { loading: ref(false), seedAt: () => privateUnit }]],
    });
    wrapper.vm.$router.addRoute({ path: "/runs/unit/:key", component: UnitPage });
    await wrapper.vm.$router.push("/runs/unit/private%3AU10");
    await flushPromises();
    const observer = streams.created.find((source) => source.url.includes("observe=1"))!;
    observer.emitMessage(local);
    await flushPromises();
    expect(wrapper.text()).toContain("Alice private deliverable");
    expect(wrapper.text()).toContain("Private unit journal");
    expect(wrapper.get(".green-page-content .green-badge").text()).toBe("State not recorded");
    await wrapper.get("textarea").setValue("Keep my broad draft");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Attach this unit")!
      .trigger("click");
    observer.emitNamed("revoked");
    await flushPromises();
    expect(wrapper.text()).not.toContain("Alice private deliverable");
    expect(wrapper.text()).not.toContain("Private unit journal");
    expect(wrapper.text()).not.toContain("sample/private");
    expect(wrapper.get("textarea").element.value).toBe("Keep my broad draft");
    expect(wrapper.findAll("button").map((button) => button.text())).not.toContain("Attach this unit");
    expect(wrapper.text()).toContain("Dashboard access changed");
  });
  it.each(["matching", "person", "everyone", "token", "unavailable"] as const)(
    "keeps an authorized %s page without treating its read target or a missing private chat as another viewer",
    async (mode) => {
      const streams = fakeEventSourceFactory();
      const actualActor = mode === "token" ? "access:configured-token" : "access:alice";
      const currentSeed = {
        page: "runs",
        title: "Authorized recorded work",
        capabilities: { ...ALL_ON, dashboardAuth: mode === "token" ? "token" : "access" },
        asUser: { id: mode === "person" ? "access:bob" : actualActor },
        viewingAs: mode === "person" ? { id: "access:bob" } : undefined,
        dataView: { mode: mode === "person" || mode === "everyone" ? mode : "mine" },
        pageAccess: { actor: actualActor, organization: "org" },
      } as unknown as WebSeed;
      vi.stubGlobal("fetch", async () =>
        mode === "token" || mode === "person" || mode === "unavailable"
          ? new Response("{}", { status: 503 })
          : new Response(JSON.stringify(session), { headers: { "content-type": "application/json" } }),
      );
      const leaf = defineComponent({
        emits: ["accessLost"],
        setup() {
          const seed = inject(SeedKey);
          return () => seed?.title;
        },
      });
      const wrapper = mountApp(App, {
        eventSource: streams.factory,
        provides: [[SeedRoutingKey, { loading: ref(false), seedAt: () => currentSeed }]],
      });
      wrapper.vm.$router.addRoute({ path: "/home", component: leaf });
      await wrapper.vm.$router.push("/home");
      await flushPromises();
      expect(wrapper.text()).toContain("Authorized recorded work");
      expect(wrapper.text()).not.toContain("Dashboard access changed");
      expect(wrapper.findAll("textarea")).toHaveLength(mode === "matching" || mode === "everyone" ? 1 : 0);
    },
  );
  it("removes every old page seed after an established private feed loses current access", async () => {
    const streams = fakeEventSourceFactory();
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify(session), { headers: { "content-type": "application/json" } }),
    );
    const currentSeed = {
      ...island,
      title: "Alice retained private page",
      asUser: { id: "access:alice" },
      pageAccess: { actor: "access:alice", organization: "org" },
    } as WebSeed;
    const leaf = defineComponent({
      emits: ["accessLost"],
      setup() {
        const seed = inject(SeedKey);
        return () => seed?.title;
      },
    });
    const loading = ref(false);
    const wrapper = mountApp(App, {
      eventSource: streams.factory,
      provides: [[SeedRoutingKey, { loading, seedAt: () => currentSeed }]],
    });
    wrapper.vm.$router.addRoute({ path: "/runs", component: leaf });
    await wrapper.vm.$router.push("/runs");
    await flushPromises();
    expect(wrapper.text()).toContain("Alice retained private page");
    loading.value = true;
    await flushPromises();
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(true);
    streams.created.find((source) => source.url === "/home/events" && !source.closed)!.emitNamed("revoked");
    await flushPromises();
    expect(wrapper.text()).not.toContain("Alice retained private page");
    expect(wrapper.text()).toContain("Dashboard access changed");
    expect(document.title).toBe("Dashboard access changed");
  });
  it.each([false, true])(
    "hides old private unit metadata when the first authenticated chat belongs to another viewer: loaded %s",
    async (loaded) => {
      const streams = fakeEventSourceFactory();
      let release!: (value: Response) => void;
      const delayed = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const foreign = { ...session, actor: "access:bob", stream: "person:bob" };
      const response = () => new Response(JSON.stringify(foreign), { headers: { "content-type": "application/json" } });
      vi.stubGlobal("fetch", async () => (loaded ? response() : delayed));
      const privateUnit = {
        page: "unit",
        title: "Private Alice unit",
        capabilities: ALL_ON,
        now: 1000,
        retentionDays: 30,
        asUser: { id: "access:alice" },
        dataView: { mode: "mine" },
        pageAccess: { actor: "access:alice", organization: "org" },
        view: {
          unit: "private:U10",
          instanceId: "private",
          id: "U10",
          title: "Alice private deliverable",
          branch: "codex/private-alice",
          threads: { coding: "worker:private:alice" },
          sourceUrls: {},
          rounds: [],
          runs: [],
          instance: { id: "private", repo: "sample/private", createdAt: 1 },
        },
      } as unknown as WebSeed;
      const wrapper = mountApp(App, {
        eventSource: streams.factory,
        provides: [[SeedRoutingKey, { loading: ref(false), seedAt: () => privateUnit }]],
      });
      const router = wrapper.vm.$router;
      router.addRoute({ path: "/runs/unit/:id", component: UnitPage });
      await router.push("/runs/unit/private%3AU10");
      await flushPromises();
      if (!loaded) {
        expect(wrapper.text()).toContain("Alice private deliverable");
        release(response());
        await flushPromises();
      }
      expect(wrapper.text()).not.toContain("Alice private deliverable");
      expect(wrapper.text()).not.toContain("sample/private");
      expect(wrapper.find('a[href="/threads/worker%3Aprivate%3Aalice"]').exists()).toBe(false);
      expect(wrapper.text()).toContain("Dashboard access changed");
    },
  );
  it("keeps the focused reply and local draft through hash navigation, while a new page restores the broad draft", async () => {
    const streams = fakeEventSourceFactory();
    vi.stubGlobal(
      "fetch",
      async (url: string) =>
        new Response(
          JSON.stringify(
            url === "/home/session"
              ? session
              : {
                  ...session,
                  submissionKey: "issued:thread",
                  revision: 9,
                  destination: {
                    kind: "thread",
                    thread: "slack:C1:1",
                    label: "Chosen thread",
                    revision: 9,
                    canWrite: true,
                  },
                },
          ),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const wrapper = mountApp(App, {
      eventSource: streams.factory,
      provides: [[SeedRoutingKey, { loading: ref(false), seedAt: () => island }]],
    });
    const router = wrapper.vm.$router;
    router.addRoute({ path: "/threads/:id", component: ThreadPage });
    router.addRoute({ path: "/home", component: defineComponent({ template: "<p>Home</p>" }) });
    await router.push("/threads/slack%3AC1%3A1");
    await flushPromises();
    streams.created
      .find((source) => source.url.includes("observe=1"))!
      .emitMessage({
        ...session,
        destination: { kind: "thread", thread: "slack:C1:1", label: "Chosen thread", revision: 9, canWrite: true },
      });
    await flushPromises();
    await wrapper.find("textarea").setValue("Broad draft");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Reply in this thread")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find(".green-destination").text()).toBe("Chosen thread");
    await wrapper.find("textarea").setValue("Local reply draft");
    await router.push("/threads/slack%3AC1%3A1#main-content");
    await flushPromises();
    expect(wrapper.find(".green-destination").text()).toBe("Chosen thread");
    expect(wrapper.find("textarea").element.value).toBe("Local reply draft");
    await router.push("/home");
    await flushPromises();
    expect(wrapper.find(".green-destination").text()).toBe("Private messages · only you");
    expect(wrapper.find("textarea").element.value).toBe("Broad draft");
  });
});
