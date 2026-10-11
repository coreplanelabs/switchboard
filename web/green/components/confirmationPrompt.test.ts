// Feature: docs/reference/specs/browser-home.md — explicit saved actions, scoped retries and offers.
import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { HomeSession } from "@core/channels/homeSeed.js";
import ConversationDock from "./ConversationDock.vue";
import { createHomeSession, HomeSessionKey } from "../lib/homeSession";
import { fakeEventSourceFactory } from "../../src/testing/fakeEventSource";
import { mountApp } from "../../src/testing/mount";
enableAutoUnmount(afterEach);
const offer = {
  id: "saved:one",
  line: "repo offboard sample/api",
  risk: "This removes the environment.",
  question: "Proceed with this saved action?",
};
function session(): HomeSession {
  return {
    version: 1,
    organization: "org",
    actor: "access:alice",
    stream: "person:alice",
    bindingRevision: 0,
    accessEpoch: "fixture:current-source",
    revision: 1,
    entries: [],
    submissionKey: "issued:one",
    commands: [],
    sendUrl: "/home/send",
    eventsUrl: "/home/events",
    destination: { kind: "broad", thread: null, label: "Your messages", revision: 1, canWrite: true },
    offer,
  };
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function setup(answers: Array<Response | Error | Promise<Response>>) {
  const stream = fakeEventSourceFactory();
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => {
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    if (!answer) throw new Error("unexpected request");
    return await answer;
  });
  const home = createHomeSession(fetcher as unknown as typeof fetch, stream.factory);
  home.routeChanged("/home");
  return { stream, fetcher, home };
}
function body(fetcher: ReturnType<typeof vi.fn>, index: number) {
  return JSON.parse((fetcher.mock.calls[index][1] as RequestInit).body as string);
}
describe("Scoped saved action confirmation", () => {
  it.each(["confirm", "cancel"] as const)(
    "preserves %s after a transient server response and retries its exact issued choice",
    async (kind) => {
      const { home, fetcher } = setup([
        json(session()),
        json({ reason: "Temporarily unavailable" }, 503),
        json({ status: "accepted", duplicate: true }),
      ]);
      await home.load();
      const wrapper = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
      const label = kind === "confirm" ? "Confirm saved action" : "Cancel";
      const button = () => wrapper.findAll("button").find((item) => item.text() === label);
      await button()?.trigger("click");
      await flushPromises();
      expect(wrapper.find("[data-testid=confirmation-offer]").text()).toContain("Proceed with this saved action?");
      expect(home.notice.value).toContain("The result could not be confirmed.");
      await button()?.trigger("click");
      await flushPromises();
      const expected = {
        confirmation: { kind, id: "saved:one" },
        destination: { kind: "broad" },
        revision: 1,
        context: [],
        key: "issued:one",
      };
      expect(body(fetcher, 1)).toEqual(expected);
      expect(body(fetcher, 2)).toEqual(expected);
      expect(home.offer.value).toBe(null);
      expect(home.notice.value).toBe("The original message was already accepted. It was not sent twice.");
      home.dispose();
    },
  );
  it.each(["confirm", "cancel"] as const)(
    "sends explicit %s choice with its issued key and no replacement command prose",
    async (kind) => {
      const { home, fetcher } = setup([json(session()), json({ status: "accepted" })]);
      await home.load();
      const wrapper = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
      expect(wrapper.find("[data-testid=confirmation-offer]").text()).toContain("repo offboard sample/api");
      const label = kind === "confirm" ? "Confirm saved action" : "Cancel";
      await wrapper
        .findAll("button")
        .find((button) => button.text() === label)
        ?.trigger("click");
      await flushPromises();
      expect(body(fetcher, 1)).toEqual({
        confirmation: { kind, id: "saved:one" },
        destination: { kind: "broad" },
        revision: 1,
        context: [],
        key: "issued:one",
      });
      expect(home.offer.value).toBe(null);
      home.dispose();
    },
  );
  it("replays an uncertain confirmation with its original key and exact choice", async () => {
    const { home, fetcher } = setup([
      json(session()),
      new Error("timeout"),
      json({ status: "accepted", duplicate: true }),
    ]);
    await home.load();
    const wrapper = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
    const confirm = () => wrapper.findAll("button").find((button) => button.text() === "Confirm saved action");
    await confirm()?.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("The result could not be confirmed.");
    await confirm()?.trigger("click");
    await flushPromises();
    const expected = {
      confirmation: { kind: "confirm", id: "saved:one" },
      destination: { kind: "broad" },
      revision: 1,
      context: [],
      key: "issued:one",
    };
    expect(body(fetcher, 1)).toEqual(expected);
    expect(body(fetcher, 2)).toEqual(expected);
    expect(home.notice.value).toBe("The original message was already accepted. It was not sent twice.");
    home.dispose();
  });
  it("keeps confirmation-looking text as ordinary message text", async () => {
    const { home, fetcher } = setup([json(session()), json({ status: "accepted" })]);
    await home.load();
    home.text.value = "Confirm saved action";
    await home.submit();
    expect(body(fetcher, 1)).toEqual({
      text: "Confirm saved action",
      destination: { kind: "broad" },
      revision: 1,
      context: [],
      key: "issued:one",
    });
    home.dispose();
  });
  it("removes offers when route or identity scope changes and ignores a late offer from the previous route", async () => {
    let finish: (value: Response) => void = () => {};
    const pending = new Promise<Response>((done) => {
      finish = done;
    });
    const { home, stream } = setup([json(session()), pending, json(session())]);
    await home.load();
    home.text.value = "Request an action";
    const sending = home.submit();
    home.routeChanged("/runs/r");
    expect(home.offer.value).toBe(null);
    finish(json({ offer }));
    await sending;
    expect(home.offer.value).toBe(null);
    await home.load();
    const wrapper = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
    expect(wrapper.text()).toContain("Proceed with this saved action?");
    stream.created.at(-1)?.emitMessage({ ...session(), bindingRevision: 1 });
    await nextTick();
    expect(wrapper.find("[data-testid=confirmation-offer]").exists()).toBe(false);
    expect(wrapper.text()).toContain("Conversation is unavailable with your current access.");
    home.dispose();
  });
  it("renders a fresh response offer without copying its command into the message draft", async () => {
    const initial = session();
    delete initial.offer;
    const { home } = setup([json(initial), json({ offer })]);
    await home.load();
    home.text.value = "Remove the environment";
    await home.submit();
    const wrapper = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
    expect(wrapper.find("[data-testid=confirmation-offer]").text()).toContain("repo offboard sample/api");
    expect(wrapper.find("textarea").element.value).toBe("");
    home.dispose();
  });
});
