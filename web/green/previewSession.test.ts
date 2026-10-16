import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { createGreenPreview } from "../../scripts/web-green-fixtures.js";
import type { HomeSeed, UnitSeed } from "@core/channels/webSeed.js";
import { mountApp } from "../src/testing/mount";
import { fakeEventSourceFactory } from "../src/testing/fakeEventSource";
import { createHomeSession, HomeSessionKey } from "./lib/homeSession";
import Thread from "./pages/Thread.vue";
import Unit from "./pages/Unit.vue";

enableAutoUnmount(afterEach);
const thread: HomeSeed = {
  page: "home",
  conversation: "slack:C1:1",
  turns: [],
  conversations: [],
  viewer: { name: "Preview account" },
  sendUrl: "/unused",
  lane: "web:preview",
  elsewhere: { surface: "slack" },
  now: 1000,
  retentionDays: 30,
  suggestions: [],
  commands: [],
};
const unit: UnitSeed["view"] = {
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
};

describe("green preview target session", () => {
  const create = () => {
    const preview = createGreenPreview({ now: 1000, thread, unit });
    const calls: string[] = [];
    const fetcher = async (address: string) => {
      calls.push(address);
      let status = 0,
        payload = "";
      expect(
        await preview.handle(
          { method: "GET" } as IncomingMessage,
          {
            writeHead(code: number) {
              status = code;
            },
            end(value: string) {
              payload = value;
            },
          } as unknown as ServerResponse,
          new URL(address, "http://preview.test"),
        ),
      ).toBe(true);
      return new Response(payload, { status, headers: { "content-type": "application/json" } });
    };
    return { preview, fetcher, calls };
  };
  it("returns the requested allowed local transcript without changing the broad destination", async () => {
    const { fetcher } = create();
    const local = await fetcher("/home/session?thread=slack%3AC1%3A1");
    expect(local.status).toBe(200);
    expect(await local.json()).toMatchObject({
      actor: "access:preview",
      organization: "organization:preview",
      destination: { kind: "thread", thread: "slack:C1:1", canWrite: true },
      entries: [{ content: "Preview: a teammate asked about this unit." }, {}, {}, {}],
    });
    const broad = await (await fetcher("/home/session")).json();
    expect(broad.destination).toMatchObject({ kind: "broad", thread: null });
    expect(broad.entries[0].content).toBe("What needs my attention?");
  });
  it.each(["unknown:private", ""])(
    "refuses unknown or empty target %s without broad transcript fallback",
    async (target) => {
      const { fetcher } = create();
      const response = await fetcher(`/home/session?thread=${encodeURIComponent(target)}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ status: "not_found", preview: true });
    },
  );
  it.each(["thread", "unit"])(
    "keeps the allowed %s observer readable through the real preview proof route",
    async (page) => {
      const { preview, fetcher, calls } = create();
      const events = fakeEventSourceFactory();
      const home = createHomeSession(fetcher as typeof fetch, events.factory);
      await home.load();
      const seed =
        page === "thread"
          ? preview.page(new URL("/threads/slack%3AC1%3A1", "http://preview.test"))!.seed
          : { page: "unit" as const, view: unit, now: 1000, retentionDays: 30 };
      const wrapper = mountApp(page === "thread" ? Thread : Unit, {
        seed,
        provides: [[HomeSessionKey, home]],
        eventSource: events.factory,
      });
      await flushPromises();
      expect(wrapper.text()).toContain("Preview: a teammate asked about this unit.");
      expect(wrapper.text()).not.toContain("Conversation is unavailable");
      expect(wrapper.findAll("button").map((button) => button.text())).toContain("Reply in this thread");
      expect(home.session.value?.destination).toMatchObject({ kind: "broad", thread: null });
      expect(events.created.some((source) => !source.closed && source.url.includes("observe=1"))).toBe(true);
      expect(calls).toEqual(["/home/session", "/home/session?thread=slack%3AC1%3A1"]);
      home.dispose();
    },
  );
});
