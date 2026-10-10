// Feature: docs/reference/specs/browser-home.md — real transcript scroll per authorized destination.
import { enableAutoUnmount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
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
