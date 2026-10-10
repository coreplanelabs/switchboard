// Feature: docs/reference/specs/browser-home.md — thread vocabulary and authorized search transport.
import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UnitRunRowSeed } from "@core/channels/webSeed.js";
import ThreadSearch from "./ThreadSearch.vue";
import { mountApp } from "../../src/testing/mount";
enableAutoUnmount(afterEach);
const runs: UnitRunRowSeed[] = [
  { id: "child", startedAt: 1, finished: true, eventCount: 2, round: 1, thread: "coding" },
];
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const sessions = [
  { thread: "coding", key: "instance:unit:coding" },
  { thread: "review", key: "instance:unit:review" },
] as const;
describe("Green thread search", () => {
  it("uses Code thread and Review thread labels while preserving the session search API", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ hits: [{ turn: 9, role: "assistant", snippet: "The retry is verified", runId: "child", gap: 2 }] }),
    );
    const wrapper = mountApp(ThreadSearch, { props: { sessions, runs, fetch: fetcher } });
    expect(wrapper.findAll("option").map((option) => option.text())).toEqual(["Code thread", "Review thread"]);
    await wrapper.find("input").setValue("retry");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(fetcher.mock.calls[0]).toEqual([
      "/api/runs.search?session=instance%3Aunit%3Acoding&query=retry&limit=20",
      { credentials: "same-origin" },
    ]);
    expect(wrapper.text()).toContain("The retry is verified");
    expect(wrapper.text()).toContain("Round 1 · Code thread");
    expect(wrapper.text()).toContain("compacted at turn 2");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Round 1 · Code thread →")
      ?.trigger("click");
    expect(wrapper.findComponent(ThreadSearch).emitted("open")).toEqual([["child", 9]]);
  });
  it("does not paint an old Code thread result after switching to the Review thread", async () => {
    let finish: (response: Response) => void = () => {};
    const old = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetcher = vi.fn(async (url: string) =>
      url.includes("coding")
        ? old
        : json({ hits: [{ turn: 12, role: "assistant", snippet: "Review result", runId: "child" }] }),
    );
    const wrapper = mountApp(ThreadSearch, { props: { sessions, runs, fetch: fetcher } });
    await wrapper.find("input").setValue("retry");
    await wrapper.find("form").trigger("submit");
    await wrapper.find("select").setValue("review");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    finish(json({ hits: [{ turn: 9, role: "assistant", snippet: "Old code result", runId: "child" }] }));
    await flushPromises();
    expect(wrapper.text()).toContain("Review result");
    expect(wrapper.text()).not.toContain("Old code result");
    expect(wrapper.find("select").element.value).toBe("review");
  });
});
