// Feature: docs/reference/specs/browser-home.md — hash-only navigation preserves an explicit reply destination.
import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, ref } from "vue";
import type { HomeSession } from "@core/channels/homeSeed.js";
import type { WebSeed } from "@core/channels/webSeed.js";
import App from "./App.vue";
import ThreadPage from "./pages/Thread.vue";
import { SeedRoutingKey } from "../src/lib/seedRouting";
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
    expect(wrapper.find(".green-destination").text()).toBe("Your messages to Switchboard");
    expect(wrapper.find("textarea").element.value).toBe("Broad draft");
  });
});
