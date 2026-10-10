// Feature: docs/reference/specs/browser-home.md — PR diff in the existing run's main pane.
import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RunHistorySeed } from "@core/channels/webSeed.js";
import RunDetails from "./Run.vue";
import { fakeEventSourceFactory } from "../../src/testing/fakeEventSource";
import { loadDiffs } from "../../src/modules/pr-review/diffsLibrary";
import { ALL_ON, mountApp } from "../../src/testing/mount";
import PullRequest from "./PullRequest.vue";
enableAutoUnmount(afterEach);
beforeAll(async () => {
  await loadDiffs();
});
const seed: RunHistorySeed = {
  page: "run",
  mode: "history",
  id: "hist-4",
  startedAt: 1,
  eventCount: 2,
  events: [
    { type: "run_meta", repo: "sample/api", pr: 42, headSha: "abc1234" },
    {
      type: "review_artifact",
      artifact: "reading_diff",
      poweredBy: "git",
      baseRef: "main",
      truncated: false,
      diff: "diff --git a/src/queue.ts b/src/queue.ts\n--- a/src/queue.ts\n+++ b/src/queue.ts\n@@ -1 +1 @@\n-old\n+new\n",
    },
  ] as never,
  findingsLedger: { unit: "pipeline:unit", rows: 1 },
};
describe("Pull request main pane", () => {
  it("stops waiting for a missing reading diff when the live run ends and preserves any recorded diff", async () => {
    const live = {
      page: "run" as const,
      mode: "live" as const,
      id: "live-diff",
      serverNow: 1,
      startedAt: 1,
      eventsUrl: "/runs/live-diff/events?t=read-capability",
    };
    const missingStream = fakeEventSourceFactory();
    const missing = mountApp(PullRequest, { seed: live, eventSource: missingStream.factory });
    expect(missing.find(".green-empty h3").text()).toBe("Waiting for a recorded diff");
    missingStream.created[0].emitNamed("finished", JSON.stringify({ finishedAt: 2 }));
    await flushPromises();
    expect(missing.find(".green-empty h3").text()).toBe("Waiting for a recorded diff");
    missingStream.created[0].emitNamed("end", JSON.stringify({ sealedAt: 3, replyOk: true }));
    await flushPromises();
    expect(missing.find(".green-empty h3").text()).toBe("No readable diff was recorded");
    const recordedStream = fakeEventSourceFactory();
    const recorded = mountApp(PullRequest, { seed: live, eventSource: recordedStream.factory });
    recordedStream.created[0].emitMessage(seed.events[0]);
    recordedStream.created[0].emitMessage(seed.events[1]);
    recordedStream.created[0].emitNamed("end", JSON.stringify({ sealedAt: 3, replyOk: true }));
    await flushPromises();
    expect(recorded.find("[data-testid=pr-title]").text()).toBe("sample/api#42");
    expect(recorded.find("[data-testid=pr-facts]").text()).toContain("abc1234");
    expect(recorded.findAll(".green-empty")).toHaveLength(0);
  });
  it("keeps run diff controls read-only while viewing as another person", async () => {
    const wrapper = mountApp(RunDetails, {
      seed: {
        ...seed,
        title: "Recorded review",
        capabilities: ALL_ON,
        viewingAs: { id: "slack:UOTHER", name: "Other" },
        events: [
          {
            type: "run_meta",
            agent: "review",
            model: "example/model",
            repo: "sample/api",
            pr: 42,
            headSha: "a".repeat(40),
            at: 1,
          },
          seed.events[1],
        ] as never,
      },
    });
    await wrapper.find('[data-testid="reading-diff-button"]').trigger("click");
    await flushPromises();
    expect(document.querySelector('[data-testid="pr-title"]')?.textContent).toContain("sample/api#42");
    expect(document.querySelector('[data-testid="abridge-button"]')).toBeNull();
  });
  it("preserves the admitted live capability when opening the main pane and returning to run details", async () => {
    const stream = fakeEventSourceFactory();
    const live = {
      page: "run" as const,
      mode: "live" as const,
      id: "live-one",
      serverNow: 1,
      startedAt: 1,
      eventsUrl: "/runs/live-one/events?t=test-capability",
    };
    const run = mountApp(RunDetails, { seed: live, eventSource: stream.factory });
    await run.vm.$router.push("/runs/live-one?t=test-capability");
    stream.created[0].emitMessage({
      type: "run_meta",
      agent: "review",
      model: "example/model",
      repo: "sample/api",
      pr: 42,
      headSha: "a".repeat(40),
      at: 1,
    });
    stream.created[0].emitMessage(seed.events[1]);
    await flushPromises();
    const diffButton = run.findAll("button").find((button) => /diff/i.test(button.text()));
    expect(diffButton).toBeDefined();
    await diffButton!.trigger("click");
    await flushPromises();
    const toDiff = Array.from(document.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Open pull request in main pane"),
    );
    expect(toDiff?.getAttribute("href")).toBe("/runs/live-one?t=test-capability&view=pull-request");
    run.unmount();
    const pane = mountApp(PullRequest, { seed: live, eventSource: fakeEventSourceFactory().factory });
    await pane.vm.$router.push("/runs/live-one?t=test-capability&view=pull-request");
    await flushPromises();
    expect(
      pane
        .findAll("a")
        .find((link) => link.text() === "Run details")
        ?.attributes("href"),
    ).toBe("/runs/live-one?t=test-capability");
  });
  it("renders the recorded PR in the main pane and retains run and unit context links", async () => {
    const wrapper = mountApp(PullRequest, { seed });
    await flushPromises();
    expect(wrapper.find("[data-testid=pr-title]").text()).toBe("sample/api#42");
    expect(wrapper.find("[data-testid=pr-facts]").text()).toContain("abc1234");
    expect(wrapper.findAll("a").map((link) => link.attributes("href"))).toContain("/runs/hist-4");
    expect(wrapper.findAll("a").map((link) => link.attributes("href"))).toContain("/runs/unit/pipeline%3Aunit");
    expect(wrapper.find(".green-pr-pane [data-testid=pr-review-panel]").exists()).toBe(true);
    expect(wrapper.findAll("[role=dialog]").length).toBe(0);
  });
  it("states when a run contains no readable diff rather than fabricating PR content", () => {
    const wrapper = mountApp(PullRequest, { seed: { ...seed, events: [] } });
    expect(wrapper.text()).toContain("No readable diff was recorded");
    expect(wrapper.find("[data-testid=pr-title]").exists()).toBe(false);
  });
});
