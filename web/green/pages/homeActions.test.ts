// Feature: docs/reference/specs/browser-home.md — personal attention and one captured answer transport.
import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, reactive } from "vue";
import type { HomeSession, HomeFleetSeed } from "@core/channels/homeSeed.js";
import UnitList from "../components/UnitList.vue";
import type { HomeUnit } from "@core/core/home/service.js";
import Home from "./Home.vue";
import History from "./History.vue";
import MarkdownText from "../../src/components/MarkdownText.vue";
import ReadonlyThread from "../components/ReadonlyThread.vue";
import Shell from "../components/Shell.vue";
import ConversationDock from "../components/ConversationDock.vue";
import { createHomeSession, HomeSessionKey } from "../lib/homeSession";
import { fakeEventSourceFactory } from "../../src/testing/fakeEventSource";
import { mountApp } from "../../src/testing/mount";
import { browser } from "../../src/lib/browser";
enableAutoUnmount(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const need: HomeUnit = {
  unit: {
    unit: "i:q",
    instanceId: "i",
    id: "q",
    title: "Verify staging",
    branch: "codex/staging",
    pr: { number: 42, url: "https://github.com/sample/api/pull/42" },
    threads: { coding: "slack:C1:1" },
    sourceUrls: {},
    rounds: [],
  },
  instance: { id: "i", repo: "sample/api", createdAt: 1 },
  conditions: [
    {
      id: "q",
      unitKey: "i:q",
      revision: 1,
      state: "open",
      owner: { kind: "person", id: "access:alice" },
      summary: "Approve staging?",
      nextAction: "Answer the question",
    },
  ],
  nextAction: { kind: "recorded", text: "Answer the question" },
};
const seed = {
  page: "fleetHome" as const,
  asUser: { id: "access:alice" },
  attentionRecipient: "access:alice",
  answers: { "i:q": { thread: "slack:C1:1", revision: 9, question: "Approve staging?" } },
  snapshot: {
    organizationId: "org",
    status: "complete" as const,
    access: "authorized" as const,
    needsYou: [need],
    moving: [],
    waiting: [],
    pipelines: [{ instance: need.instance, unresolved: 1, needsYou: 1, moving: 0, waiting: 0 }],
  },
};
function session(thread: string | null = null, revision = 9): HomeSession {
  return {
    version: 1,
    organization: "org",
    actor: "access:alice",
    stream: "person:alice",
    bindingRevision: 0,
    accessEpoch: "fixture:policy",
    revision: 1,
    entries: [],
    submissionKey: thread ? "issued:question" : "issued:broad",
    commands: [],
    sendUrl: "/home/send",
    eventsUrl: "/home/events",
    destination: {
      kind: thread ? "thread" : "broad",
      thread,
      label: thread ? "Original unit question" : "Your messages",
      revision,
      canWrite: true,
    },
  };
}
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const host = defineComponent({ render: () => h("div", [h(Home), h(ConversationDock)]) });
describe("Home actions", () => {
  it("keeps owned work visible when the first chat frame matches the page account and organization", async () => {
    const home = createHomeSession((async () => json(session())) as typeof fetch, fakeEventSourceFactory().factory);
    const page = mountApp(Home, { seed, provides: [[HomeSessionKey, home]] });
    expect(page.text()).toContain("Verify staging");
    await home.load();
    await flushPromises();
    expect(page.text()).toContain("Verify staging");
    expect(page.text()).not.toContain("Work access changed");
  });
  it.each([
    ["first account frame", { actor: "access:bob" }, false],
    ["first organization frame", { organization: "other-org" }, false],
    ["already-loaded foreign account", { actor: "access:bob" }, true],
  ] as const)("hides work and saved choices for a mismatched %s", async (_case, changed, loaded) => {
    const home = createHomeSession(
      (async () => json({ ...session(), ...changed })) as typeof fetch,
      fakeEventSourceFactory().factory,
    );
    if (loaded) await home.load();
    let writes = 0;
    vi.stubGlobal("fetch", async () => {
      if (++writes === 1)
        return new Response(
          JSON.stringify({
            error: "confirmation_required",
            confirmation: {
              id: "saved-old-account",
              line: "pulls merge sample/api#42",
            },
          }),
          { status: 409 },
        );
      throw new Error("Unknown original saved choice");
    });
    const page = mountApp(Home, {
      seed: { ...seed, answers: {}, actions: { "i:q": { kind: "merge", pr: "sample/api#42", head: "a".repeat(40) } } },
      provides: [[HomeSessionKey, home]],
    });
    if (!loaded) {
      for (let click = 0; click < 2; click++) {
        await page
          .findAll("button")
          .find((button) => button.text() === "Merge")!
          .trigger("click");
        await flushPromises();
      }
      expect(page.text()).toContain("Check saved action");
      await home.load();
    }
    await flushPromises();
    expect(page.text()).not.toContain("Verify staging");
    expect(page.text()).not.toContain("pulls merge sample/api#42");
    expect(page.findAll("button").some((button) => button.text() === "Check saved action")).toBe(false);
    expect(page.text()).toContain("Work access changed");
  });
  it("refreshes only work after a known merge and preserves the original private draft and unknown submission", async () => {
    const privateSends: unknown[] = [];
    const home = createHomeSession(
      (async (url: string, init?: RequestInit) => {
        if (url === "/home/session") return json(session());
        if (url === "/home/send") {
          privateSends.push(JSON.parse(String(init?.body)));
          throw new Error("Unknown private outcome");
        }
        throw new Error(`Unexpected private request ${url}`);
      }) as typeof fetch,
      fakeEventSourceFactory().factory,
    );
    await home.load();
    home.text.value = "Keep this private draft";
    await home.submit();
    expect(home.pendingSubmission.value).toBe(true);
    const original = privateSends[0];
    const reads: string[] = [];
    let writes = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/pulls.merge") {
        writes++;
        return writes === 1
          ? new Response(
              JSON.stringify({
                error: "confirmation_required",
                confirmation: { id: "saved-merge", line: "pulls merge sample/api#42" },
              }),
              { status: 409 },
            )
          : json({ kind: "merged" });
      }
      reads.push(url);
      return json({ ...seed.snapshot, needsYou: [], pipelines: [], observation: "observed" });
    });
    const page = mountApp(Home, {
      seed: { ...seed, answers: {}, actions: { "i:q": { kind: "merge", pr: "sample/api#42", head: "a".repeat(40) } } },
      provides: [[HomeSessionKey, home]],
    });
    await page
      .findAll("button")
      .find((button) => button.text() === "Merge")!
      .trigger("click");
    await flushPromises();
    await page
      .findAll("button")
      .find((button) => button.text() === "Merge")!
      .trigger("click");
    await flushPromises();
    expect(reads).toEqual(["/home/snapshot?observe=i%3Aq"]);
    expect(page.text()).not.toContain("Verify staging");
    expect(page.text()).toContain("Completed work updated.");
    expect(home.text.value).toBe("Keep this private draft");
    expect(home.pendingSubmission.value).toBe(true);
    await home.submit();
    expect(privateSends).toEqual([original, original]);
    expect(writes).toBe(2);
    home.dispose();
  });
  it("keeps an unknown sibling saved choice outside Needs you after a known merge refresh", async () => {
    const second = { ...need, unit: { ...need.unit, unit: "i:second", id: "second", title: "Second work" } };
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.startsWith("/home/snapshot"))
        return json({ ...seed.snapshot, needsYou: [], pipelines: [], observation: "observed" });
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (!body._confirmation)
        return new Response(
          JSON.stringify({
            error: "confirmation_required",
            confirmation: {
              id: body.pr.endsWith("42") ? "saved-first" : "saved-second",
              line: `pulls merge ${body.pr}`,
            },
          }),
          { status: 409 },
        );
      if (body._confirmation.id === "saved-first") throw new Error("Unknown first merge outcome");
      return json({ kind: "merged" });
    });
    const page = mountApp(Home, {
      seed: {
        ...seed,
        answers: {},
        snapshot: { ...seed.snapshot, needsYou: [need, second] },
        actions: {
          "i:q": { kind: "merge", pr: "sample/api#42", head: "a".repeat(40) },
          "i:second": { kind: "merge", pr: "sample/api#43", head: "a".repeat(40) },
        },
      },
    });
    const first = () => page.get('[data-unit="i:q"]');
    await first()
      .findAll("button")
      .find((b) => b.text() === "Merge")!
      .trigger("click");
    await flushPromises();
    await first()
      .findAll("button")
      .find((b) => b.text() === "Merge")!
      .trigger("click");
    await flushPromises();
    const other = () => page.get('[data-unit="i:second"]');
    await other()
      .findAll("button")
      .find((b) => b.text() === "Merge")!
      .trigger("click");
    await flushPromises();
    await other()
      .findAll("button")
      .find((b) => b.text() === "Merge")!
      .trigger("click");
    await flushPromises();
    expect(page.find('[data-unit="i:q"]').exists()).toBe(false);
    expect(page.find('[data-unit="i:second"]').exists()).toBe(false);
    const saved = page.get('[aria-label="Saved actions with unknown results"]');
    expect(saved.text()).toContain("Verify staging");
    expect(saved.text()).toContain("pulls merge sample/api#42");
    await saved
      .findAll("button")
      .find((b) => b.text() === "Check saved action")!
      .trigger("click");
    await flushPromises();
    expect(bodies.at(-1)).toEqual({ _confirmation: { kind: "confirm", id: "saved-first" } });
    expect(bodies.filter((body) => (body as { pr?: string }).pr === "sample/api#42")).toHaveLength(1);
  });
  it.each(["view change", "unmount"])(
    "ignores a late work response after %s and drops old saved-choice context",
    async (change) => {
      const home = createHomeSession((async () => json(session())) as typeof fetch, fakeEventSourceFactory().factory);
      await home.load();
      const second = { ...need, unit: { ...need.unit, unit: "i:second", id: "second", title: "Second work" } };
      let release!: (response: Response) => void;
      const writes: unknown[] = [];
      vi.spyOn(browser, "reload").mockImplementation(() => {});
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (url.startsWith("/home/snapshot"))
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        if (url === "/runs/view-as") return new Response(null, { status: 204 });
        const body = JSON.parse(String(init?.body));
        writes.push(body);
        if (!body._confirmation)
          return new Response(
            JSON.stringify({
              error: "confirmation_required",
              confirmation: {
                id: body.pr.endsWith("42") ? "saved-first" : "saved-second",
                line: `pulls merge ${body.pr}`,
              },
            }),
            { status: 409 },
          );
        if (body._confirmation.id === "saved-first") throw new Error("Unknown first merge outcome");
        return json({ kind: "merged" });
      });
      const page = mountApp(Shell, {
        slots: { default: () => h(Home) },
        provides: [[HomeSessionKey, home]],
        seed: {
          ...seed,
          answers: {},
          dataView: { mode: "mine", canViewEveryone: true },
          viewAs: { people: [{ id: "slack:bob", name: "Bob" }] },
          snapshot: { ...seed.snapshot, needsYou: [need, second] },
          actions: {
            "i:q": { kind: "merge", pr: "sample/api#42", head: "a".repeat(40) },
            "i:second": { kind: "merge", pr: "sample/api#43", head: "a".repeat(40) },
          },
        },
      });
      for (const unit of ["i:q", "i:second"]) {
        for (let i = 0; i < 2; i++) {
          await page
            .get(`[data-unit="${unit}"]`)
            .findAll("button")
            .find((b) => b.text() === "Merge")!
            .trigger("click");
          await flushPromises();
        }
      }
      if (change === "view change") {
        await page.get('[aria-label="User menu"]').trigger("click");
        await page.get('[aria-label="View as person"]').setValue("person:slack:bob");
        await flushPromises();
        expect(home.scopeChanging.value).toBe(true);
      } else page.unmount();
      release(
        json({
          ...seed.snapshot,
          needsYou: [{ ...need, unit: { ...need.unit, title: "Late private work" } }],
          observation: "observed",
        }),
      );
      await flushPromises();
      expect(document.body.textContent).not.toContain("Late private work");
      expect(document.body.textContent).not.toContain("Verify staging");
      expect(document.body.textContent).not.toContain("pulls merge sample/api#42");
      expect(writes).toHaveLength(4);
      home.dispose();
    },
  );
  it("hides old work when the targeted read loses permission instead of retaining private rows", async () => {
    let writes = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.startsWith("/home/snapshot")) return new Response("not found", { status: 404 });
      return ++writes === 1
        ? new Response(
            JSON.stringify({
              error: "confirmation_required",
              confirmation: { id: "saved", line: "pulls merge sample/api#42" },
            }),
            { status: 409 },
          )
        : json({ kind: "merged" });
    });
    const page = mountApp(Home, {
      seed: { ...seed, answers: {}, actions: { "i:q": { kind: "merge", pr: "sample/api#42", head: "a".repeat(40) } } },
    });
    await page
      .findAll("button")
      .find((b) => b.text() === "Merge")!
      .trigger("click");
    await flushPromises();
    await page
      .findAll("button")
      .find((b) => b.text() === "Merge")!
      .trigger("click");
    await flushPromises();
    expect(page.text()).not.toContain("Verify staging");
    expect(page.find('[aria-label="Saved actions with unknown results"]').exists()).toBe(false);
    expect(page.text()).toContain("Work access changed. This page's data is hidden.");
  });
  it("merges an owned completed review through its exact saved command choice without opening a reply composer", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      if (calls.length === 1)
        return new Response(
          JSON.stringify({
            error: "confirmation_required",
            confirmation: {
              id: "saved-merge",
              line: "pulls merge sample/api#42 --head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
          }),
          { status: 409 },
        );
      if (calls.length === 2) throw new Error("lost acknowledgement");
      return json({ kind: "merged", sha: "b".repeat(40) });
    });
    const wrapper = mountApp(Home, {
      seed: {
        ...seed,
        answers: {},
        actions: {
          "i:q": { kind: "merge", pr: "sample/api#42", head: "a".repeat(40) },
        },
      },
    });
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Merge")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("pulls merge sample/api#42 --head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(wrapper.find("textarea").exists()).toBe(false);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Merge")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("The result is unknown.");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Check saved action")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Merged.");
    expect(calls).toEqual([
      { url: "/api/pulls.merge", body: { pr: "sample/api#42", head: "a".repeat(40) } },
      { url: "/api/pulls.merge", body: { _confirmation: { kind: "confirm", id: "saved-merge" } } },
      { url: "/api/pulls.merge", body: { _confirmation: { kind: "confirm", id: "saved-merge" } } },
    ]);
    const observer = mountApp(Home, {
      seed: {
        ...seed,
        viewingAs: { id: "slack:bob" },
        dataView: { mode: "person" },
        actions: { "i:q": { kind: "merge", pr: "sample/api#42", head: "a".repeat(40) } },
      },
    });
    expect(observer.findAll("button").some((button) => button.text() === "Merge")).toBe(false);
    expect(observer.find('a[href="https://github.com/sample/api/pull/42"]').exists()).toBe(true);
  });
  it("answers its own All people question as the unchanged current sender while foreign metadata has no answer control", async () => {
    const sends: unknown[] = [];
    const home = createHomeSession(
      (async (url: string, init?: RequestInit) => {
        if (url === "/home/session") return json(session());
        if (url === "/home/focus") return json(session("slack:C1:1"));
        sends.push(JSON.parse(String(init?.body)));
        return json({ status: "accepted" });
      }) as typeof fetch,
      fakeEventSourceFactory().factory,
    );
    await home.load();
    const foreign = {
      ...need,
      unit: { ...need.unit, unit: "foreign:U10", title: "Other person's private work", threads: {} },
      conditions: [{ ...need.conditions[0], owner: { kind: "person" as const, id: "access:bob" } }],
    };
    const page = mountApp(host, {
      seed: {
        ...seed,
        dataView: { mode: "everyone", canViewEveryone: true },
        answers: { "i:q": { ...seed.answers["i:q"], primaryAction: { label: "Merge", text: "merge" } } },
        snapshot: { ...seed.snapshot, waiting: [foreign] },
      },
      provides: [[HomeSessionKey, home]],
    });
    expect(page.find('[aria-label="Answer: Other person\'s private work"]').exists()).toBe(false);
    await page.get('[aria-label="Answer: Verify staging"]').trigger("click");
    await flushPromises();
    const inline = page.get('[aria-label="Answer original unit question"]');
    expect(inline.find("textarea").exists()).toBe(false);
    await inline
      .findAll("button")
      .find((button) => button.text() === "Merge")!
      .trigger("click");
    await flushPromises();
    expect(sends).toEqual([
      {
        key: "issued:question",
        revision: 9,
        destination: { kind: "thread", thread: "slack:C1:1" },
        text: "merge",
        context: [],
      },
    ]);
    expect(home.session.value?.actor).toBe("access:alice");
    home.exitFocus();
    await flushPromises();
    expect(page.get('[aria-label="Conversation"]').find("textarea").exists()).toBe(true);
    home.dispose();
  });
  it("moves keyboard focus from the opened attention row to its visible primary answer", async () => {
    const home = createHomeSession(
      (async (url: string) => json(session(url === "/home/session" ? null : "slack:C1:1"))) as typeof fetch,
      fakeEventSourceFactory().factory,
    );
    await home.load();
    const page = mountApp(host, {
      seed: {
        ...seed,
        answers: { "i:q": { ...seed.answers["i:q"], primaryAction: { label: "Merge", text: "merge" } } },
      },
      provides: [[HomeSessionKey, home]],
    });
    const opener = page.get('[aria-label="Answer: Verify staging"]');
    (opener.element as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(opener.element);
    await opener.trigger("click");
    await flushPromises();
    const inline = page.get('[aria-label="Answer original unit question"]');
    expect(inline.find("textarea").exists()).toBe(false);
    expect(document.activeElement).toBe(inline.findAll("button").find((button) => button.text() === "Merge")!.element);
    home.dispose();
  });
  it("expands the original attention row in place with one question and shows preservation only for a real draft", async () => {
    const home = createHomeSession(
      (async (url: string) => json(session(url === "/home/session" ? null : "slack:C1:1"))) as typeof fetch,
      fakeEventSourceFactory().factory,
    );
    await home.load();
    const other = { ...need, unit: { ...need.unit, unit: "i:first", title: "First attention" } };
    const page = mountApp(host, {
      seed: { ...seed, snapshot: { ...seed.snapshot, needsYou: [other, need] } },
      provides: [[HomeSessionKey, home]],
    });
    await page.get('[aria-label="Answer: Verify staging"]').trigger("click");
    await flushPromises();
    const row = page.get('article[data-unit="i:q"]');
    expect(row.find('[aria-label="Answer original unit question"]').exists()).toBe(true);
    expect(
      page.findAll(".green-attention-section article").map((item) => item.get(".green-unit-title").text()),
    ).toEqual(["First attention", "Verify staging"]);
    expect(row.text().split("Approve staging?")).toHaveLength(2);
    expect(row.text()).toContain("Reply in this thread");
    expect(row.text()).not.toContain("Original unit question");
    expect(row.text()).not.toContain("Closing keeps");
    expect(row.get('a[aria-label="Original unit thread"]').attributes("href")).toBe("/threads/slack%3AC1%3A1");
    await row
      .findAll("button")
      .find((button) => button.text() === "Type a reply")!
      .trigger("click");
    await row.get("textarea").setValue("Check staging first");
    expect(document.activeElement).toBe(row.get("textarea").element);
    expect(row.text()).toContain("Closing keeps this thread's draft and any unconfirmed submission.");
    expect(page.findAll("textarea")).toHaveLength(1);
    home.dispose();
  });
  it("keeps pipeline previews compact without repeating an attention question and shows no inline action in Person view", async () => {
    for (const mode of ["person"] as const) {
      const home = createHomeSession((async () => json(session())) as typeof fetch, fakeEventSourceFactory().factory);
      await home.load();
      const page = mountApp(Home, {
        seed: { ...seed, dataView: { mode, canViewEveryone: true } },
        provides: [[HomeSessionKey, home]],
      });
      const card = page.get(".green-pipeline-card");
      expect(card.findAll(".green-unit-row")).toHaveLength(0);
      expect(card.text()).not.toContain("Approve staging?");
      expect(card.get('a[aria-label="Original unit thread"]').attributes("href")).toBe("/threads/slack%3AC1%3A1");
      expect(card.text()).toContain("Answer the question");
      expect(page.find('[aria-label="Answer: Verify staging"]').exists()).toBe(false);
      home.dispose();
    }
  });
  it("measures the expanded answer inside its virtual row and keeps the rest of the list bounded", async () => {
    const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        targets = new Set<Element>();
        constructor(readonly callback: ResizeObserverCallback) {
          observers.push(this);
        }
        observe(element: Element) {
          this.targets.add(element);
        }
        unobserve(element: Element) {
          this.targets.delete(element);
        }
        disconnect() {
          this.targets.clear();
        }
      },
    );
    const home = createHomeSession(
      (async (url: string) => json(session(url === "/home/session" ? null : "slack:C1:1"))) as typeof fetch,
      fakeEventSourceFactory().factory,
    );
    await home.load();
    const rows = [
      need,
      ...Array.from({ length: 19 }, (_, i) => ({
        ...need,
        unit: { ...need.unit, unit: `i:row-${i}`, title: `Loaded work ${i}` },
      })),
    ];
    const page = mountApp(UnitList, {
      props: { rows, urgent: true, label: "Needs you", answers: seed.answers },
      provides: [[HomeSessionKey, home]],
    });
    expect(page.findAll("article")).toHaveLength(8);
    await page.get('[aria-label="Answer: Verify staging"]').trigger("click");
    await flushPromises();
    const row = page.get('article[data-unit="i:q"]');
    expect(row.get('[aria-label="Answer original unit question"]').text()).toContain("Approve staging?");
    const observer = observers.find((value) => value.targets.has(row.element))!;
    observer.callback(
      [{ target: row.element, borderBoxSize: [{ blockSize: 600 }] }] as unknown as ResizeObserverEntry[],
      observer as unknown as ResizeObserver,
    );
    await flushPromises();
    expect(page.findAll("article")).toHaveLength(5);
    expect(page.findAll('[role="list"] > div').at(-1)!.attributes("style")).toBe("height: 2250px;");
    await page.get('[aria-label="Preserve answer and return to your messages"]').trigger("click");
    await flushPromises();
    observer.callback(
      [{ target: row.element, borderBoxSize: [{ blockSize: 150 }] }] as unknown as ResizeObserverEntry[],
      observer as unknown as ResizeObserver,
    );
    await flushPromises();
    expect(page.findAll("article")).toHaveLength(8);
    expect(page.get('article[data-unit="i:q"]').text()).toContain("Approve staging?");
    expect(page.find('[aria-label="Answer original unit question"]').exists()).toBe(false);
    home.dispose();
  });
  it("bounds the loaded pipeline preview and links to the remaining original work", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      ...need,
      unit: { ...need.unit, unit: `i:unit-${i}`, title: `Work ${i}` },
    }));
    const page = mountApp(Home, { seed: { ...seed, snapshot: { ...seed.snapshot, needsYou: rows } } });
    const card = page.get(".green-pipeline-card");
    expect(card.findAll(".green-pipeline-work .green-unit-title").map((title) => title.text())).toEqual([
      "Work 0",
      "Work 1",
      "Work 2",
    ]);
    expect(
      card
        .findAll("a")
        .find((link) => link.text() === "View 2 more")!
        .attributes("href"),
    ).toBe("/pipelines/i");
  });
  it("checks the immutable saved reply after a winning answer makes the thread read-only and keeps it reachable outside attention", async () => {
    const sends: unknown[] = [];
    const stream = fakeEventSourceFactory();
    const home = createHomeSession(
      (async (url: string, init?: RequestInit) => {
        if (url === "/home/session") return json(session());
        if (url === "/home/focus") return json(session("slack:C1:1", 9));
        sends.push(JSON.parse(String(init?.body)));
        if (sends.length === 1) throw new Error("lost acknowledgement");
        return json({ status: "accepted", duplicate: true });
      }) as typeof fetch,
      stream.factory,
    );
    await home.load();
    const currentWork = reactive<HomeFleetSeed["snapshot"]>({ ...seed.snapshot });
    const page = mountApp(host, {
      seed: {
        ...seed,
        snapshot: currentWork,
        answers: { "i:q": { ...seed.answers["i:q"], primaryAction: { label: "Merge", text: "merge" } } },
      },
      provides: [[HomeSessionKey, home]],
    });
    await page.get('[aria-label="Answer: Verify staging"]').trigger("click");
    await flushPromises();
    await page
      .get('[aria-label="Answer original unit question"]')
      .findAll("button")
      .find((button) => button.text() === "Merge")!
      .trigger("click");
    await flushPromises();
    stream.created.at(-1)!.emitMessage({
      ...session("slack:C1:1", 0),
      destination: { ...session("slack:C1:1", 0).destination, canWrite: false },
    });
    await flushPromises();
    currentWork.needsYou = [];
    currentWork.waiting = [need];
    await flushPromises();
    expect(page.get('article[data-unit="i:q"]').find('[aria-label="Answer original unit question"]').exists()).toBe(
      true,
    );
    currentWork.waiting = [];
    await flushPromises();
    expect(page.get('[aria-label="Saved reply"]').text()).toContain("Verify staging");
    home.text.value = "A different answer";
    await home.submit();
    expect(sends).toHaveLength(1);
    expect(home.notice.value).toContain("Only the unchanged saved reply can be checked");
    home.text.value = "merge";
    const check = page
      .get('[aria-label="Answer original unit question"]')
      .findAll("button")
      .find((button) => button.text() === "Check saved reply");
    expect(check?.exists()).toBe(true);
    await check!.trigger("click");
    await flushPromises();
    expect(sends).toEqual([
      {
        key: "issued:question",
        revision: 9,
        destination: { kind: "thread", thread: "slack:C1:1" },
        text: "merge",
        context: [],
      },
      {
        key: "issued:question",
        revision: 9,
        destination: { kind: "thread", thread: "slack:C1:1" },
        text: "merge",
        context: [],
      },
    ]);
    expect(page.text()).toContain("The original message was already accepted.");
    expect(page.findAll("textarea")).toHaveLength(0);
    home.dispose();
  });
  it("captures a chosen repository in the broad message and retains it unchanged during an unknown retry", async () => {
    const sends: unknown[] = [];
    const home = createHomeSession(
      (async (url: string, init?: RequestInit) => {
        if (url === "/home/session")
          return json({
            ...session(),
            repositories: { status: "complete", repositories: [{ repo: "sample/api" }, { repo: "sample/web" }] },
          });
        sends.push(JSON.parse(String(init?.body)));
        if (sends.length === 1) throw new Error("lost response");
        return json({ status: "accepted", duplicate: true });
      }) as typeof fetch,
      fakeEventSourceFactory().factory,
    );
    await home.load();
    const page = mountApp(ConversationDock, { provides: [[HomeSessionKey, home]] });
    await page.get('[aria-label="Repository for coding work"]').setValue("sample/web");
    await page.get("textarea").setValue("Build this change");
    await page.get("form").trigger("submit");
    await flushPromises();
    expect(page.get('[aria-label="Repository for coding work"]').attributes("disabled")).toBeDefined();
    await page.get("form").trigger("submit");
    await flushPromises();
    expect(sends).toEqual([
      {
        text: "Build this change",
        destination: { kind: "broad" },
        revision: 9,
        context: [{ kind: "repository", key: "sample/web" }],
        key: "issued:broad",
      },
      {
        text: "Build this change",
        destination: { kind: "broad" },
        revision: 9,
        context: [{ kind: "repository", key: "sample/web" }],
        key: "issued:broad",
      },
    ]);
    home.dispose();
  });
  it("keeps an unavailable repository catalog distinct from a known empty eligible list", async () => {
    const unavailable = createHomeSession(
      (async () => json({ ...session(), repositories: { status: "unavailable", repositories: [] } })) as typeof fetch,
      fakeEventSourceFactory().factory,
    );
    await unavailable.load();
    const a = mountApp(ConversationDock, { provides: [[HomeSessionKey, unavailable]] });
    expect(a.get('[aria-label="Repository for coding work"]').text()).toBe("Repository list unavailable");
    const empty = createHomeSession(
      (async () => json({ ...session(), repositories: { status: "complete", repositories: [] } })) as typeof fetch,
      fakeEventSourceFactory().factory,
    );
    await empty.load();
    const b = mountApp(ConversationDock, { provides: [[HomeSessionKey, empty]] });
    expect(b.get('[aria-label="Repository for coding work"]').text()).toBe("No eligible repositories");
    unavailable.dispose();
    empty.dispose();
  });
  it("keeps an unknown typed answer visible and never labels its immutable retry as Merge", async () => {
    const sends: unknown[] = [];
    const home = createHomeSession(
      (async (url: string, init?: RequestInit) => {
        if (url === "/home/session") return json(session());
        if (url === "/home/focus") return json(session("slack:C1:1", 9));
        sends.push(JSON.parse(String(init?.body)));
        if (sends.length === 1) throw new Error("response lost");
        return json({ status: "accepted", duplicate: true });
      }) as typeof fetch,
      fakeEventSourceFactory().factory,
    );
    await home.load();
    const page = mountApp(host, {
      seed: {
        ...seed,
        answers: { "i:q": { ...seed.answers["i:q"], primaryAction: { label: "Merge", text: "merge" } } },
      },
      provides: [[HomeSessionKey, home]],
    });
    await page.get('[aria-label="Answer: Verify staging"]').trigger("click");
    await flushPromises();
    const inline = () => page.get('[aria-label="Answer original unit question"]');
    await inline()
      .findAll("button")
      .find((button) => button.text() === "Type a reply")!
      .trigger("click");
    await inline().get("textarea").setValue("Use staging only");
    await inline().get("form").trigger("submit");
    await flushPromises();
    expect(inline().get("textarea").element.value).toBe("Use staging only");
    expect(inline().get("textarea").attributes("readonly")).toBeDefined();
    expect(
      inline()
        .findAll("button")
        .map((button) => button.text()),
    ).not.toContain("Merge");
    await inline()
      .findAll("button")
      .find((button) => button.text() === "Check saved reply")!
      .trigger("click");
    await flushPromises();
    expect(sends).toEqual([
      {
        key: "issued:question",
        revision: 9,
        destination: { kind: "thread", thread: "slack:C1:1" },
        text: "Use staging only",
        context: [],
      },
      {
        key: "issued:question",
        revision: 9,
        destination: { kind: "thread", thread: "slack:C1:1" },
        text: "Use staging only",
        context: [],
      },
    ]);
    home.dispose();
  });
  it("drops old-scope pagination after switching the global person while preserving the selected week and range", async () => {
    vi.spyOn(browser, "pathname").mockReturnValue("/home/history");
    vi.spyOn(browser, "search").mockReturnValue(
      "?week=1970-01-04&tz=America%2FLos_Angeles&cursor=old-scope&before=100&beforeId=old-row&since=1970-01-01",
    );
    const navigate = vi.spyOn(browser, "navigate").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const page = mountApp(Shell, { seed: { ...seed, viewAs: { people: [{ id: "slack:bob", name: "Bob" }] } } });
    await page.get('[aria-label="User menu"]').trigger("click");
    await page.get('[aria-label="View as person"]').setValue("person:slack:bob");
    await flushPromises();
    expect(navigate.mock.calls).toEqual([["/home/history?week=1970-01-04&tz=America%2FLos_Angeles&since=1970-01-01"]]);
  });
  it("shows a recorded action before the editor and checks the same captured answer after an unknown result", async () => {
    const sends: unknown[] = [];
    const stream = fakeEventSourceFactory();
    const home = createHomeSession(
      (async (url: string, init?: RequestInit) => {
        if (url === "/home/session") return json(session());
        if (url === "/home/focus") return json(session("slack:C1:1", 9));
        sends.push(JSON.parse(String(init?.body)));
        if (sends.length === 1) throw new Error("response lost");
        return json({ status: "accepted", duplicate: true });
      }) as typeof fetch,
      stream.factory,
    );
    await home.load();
    const page = mountApp(host, {
      seed: {
        ...seed,
        answers: { "i:q": { ...seed.answers["i:q"], primaryAction: { label: "Merge", text: "merge" } } },
      },
      provides: [[HomeSessionKey, home]],
    });
    await page.get('[aria-label="Answer: Verify staging"]').trigger("click");
    await flushPromises();
    const inline = () => page.get('[aria-label="Answer original unit question"]');
    expect(inline().find("textarea").exists()).toBe(false);
    expect(
      inline()
        .findAll("button")
        .some((button) => button.text() === "Merge"),
    ).toBe(true);
    await inline()
      .findAll("button")
      .find((button) => button.text() === "Merge")!
      .trigger("click");
    await flushPromises();
    expect(
      inline()
        .findAll("button")
        .map((button) => button.text()),
    ).toContain("Check saved reply");
    stream.created.at(-1)!.emitMessage(session("slack:C1:1", 10));
    await flushPromises();
    await inline()
      .findAll("button")
      .find((button) => button.text() === "Check saved reply")!
      .trigger("click");
    await flushPromises();
    expect(sends).toEqual([
      {
        key: "issued:question",
        revision: 9,
        destination: { kind: "thread", thread: "slack:C1:1" },
        text: "merge",
        context: [],
      },
      {
        key: "issued:question",
        revision: 9,
        destination: { kind: "thread", thread: "slack:C1:1" },
        text: "merge",
        context: [],
      },
    ]);
    expect(page.findAll("textarea")).toHaveLength(0);
    home.dispose();
  });
  it("answers inline through the captured original thread and keeps an unknown retry after preserving the draft", async () => {
    const sends: unknown[] = [];
    const stream = fakeEventSourceFactory();
    let questionRevision = 9;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/home/session") return json(session());
      if (url === "/home/focus") {
        expect(JSON.parse(String(init?.body))).toEqual({ thread: "slack:C1:1" });
        return json(session("slack:C1:1", questionRevision));
      }
      sends.push(JSON.parse(String(init?.body)));
      if (sends.length === 1) throw new Error("response lost");
      return json({ status: "accepted", duplicate: true });
    });
    const home = createHomeSession(fetcher as typeof fetch, stream.factory);
    await home.load();
    const page = mountApp(host, { seed, provides: [[HomeSessionKey, home]] });
    await page.get('[aria-label="Answer: Verify staging"]').trigger("click");
    await flushPromises();
    expect(page.findAll("textarea")).toHaveLength(0);
    await page
      .get('[aria-label="Answer original unit question"]')
      .findAll("button")
      .find((button) => button.text() === "Type a reply")!
      .trigger("click");
    expect(page.findAll("textarea")).toHaveLength(1);
    expect(page.get('[aria-label="Answer original unit question"]').text()).toContain("Approve staging?");
    await page.get("textarea").setValue("Use staging only");
    await page.get('[aria-label="Answer original unit question"] form').trigger("submit");
    await flushPromises();
    expect(page.text()).toContain("The result could not be confirmed.");
    questionRevision = 10;
    stream.created.at(-1)!.emitMessage(session("slack:C1:1", 10));
    await flushPromises();
    expect(page.get("textarea").attributes("readonly")).toBeDefined();
    await page.get('[aria-label="Preserve answer and return to your messages"]').trigger("click");
    await flushPromises();
    expect(home.session.value?.destination.thread).toBe(null);
    await page.get('[aria-label="Answer: Verify staging"]').trigger("click");
    await flushPromises();
    expect(page.get("textarea").element.value).toBe("Use staging only");
    await page.get('[aria-label="Answer original unit question"] form').trigger("submit");
    await flushPromises();
    expect(sends).toEqual([
      {
        key: "issued:question",
        revision: 9,
        destination: { kind: "thread", thread: "slack:C1:1" },
        text: "Use staging only",
        context: [],
      },
      {
        key: "issued:question",
        revision: 9,
        destination: { kind: "thread", thread: "slack:C1:1" },
        text: "Use staging only",
        context: [],
      },
    ]);
    expect(page.text()).toContain("The original message was already accepted.");
    home.dispose();
  });
  it("refuses an inline answer when the fresh original question differs from the card", async () => {
    const home = createHomeSession(
      (async (url: string) => json(session(url === "/home/session" ? null : "slack:C1:1", 10))) as typeof fetch,
      fakeEventSourceFactory().factory,
    );
    await home.load();
    const page = mountApp(host, { seed, provides: [[HomeSessionKey, home]] });
    await page.get('[aria-label="Answer: Verify staging"]').trigger("click");
    await flushPromises();
    expect(page.text()).toContain("The question changed. Open the original thread to review it.");
    expect(page.find('[aria-label="Answer original unit question"] form').exists()).toBe(false);
    expect(page.findAll("textarea")).toHaveLength(1);
    home.dispose();
  });
  it("offers global view-as on a report and clears personal cache before the identity request finishes", async () => {
    let resolve!: (response: Response) => void;
    const request = new Promise<Response>((done) => {
      resolve = done;
    });
    const fetcher = vi.fn(() => request);
    vi.stubGlobal("fetch", fetcher);
    const reload = vi.spyOn(browser, "reload").mockImplementation(() => {});
    const home = createHomeSession(
      (async () =>
        json({
          ...session(),
          entries: [{ id: "secret", role: "user", content: "Private Alice request", isViewer: true }],
        })) as typeof fetch,
      fakeEventSourceFactory().factory,
    );
    await home.load();
    home.text.value = "Private Alice draft";
    const page = mountApp(Shell, {
      seed: {
        ...seed,
        title: "Report",
        asUser: { id: "access:alice", name: "Alice" },
        viewAs: { people: [{ id: "slack:bob", name: "Bob" }] },
      },
      provides: [[HomeSessionKey, home]],
    });
    await page.get('[aria-label="User menu"]').trigger("click");
    await page.get('[aria-label="View as person"]').setValue("person:slack:bob");
    await flushPromises();
    expect(home.session.value).toBe(null);
    expect(home.text.value).toBe("");
    expect(fetcher.mock.calls).toEqual([
      [
        "/runs/view-as",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: '{"person":"slack:bob"}',
        },
      ],
    ]);
    resolve(new Response(null, { status: 204 }));
    await flushPromises();
    expect(reload).toHaveBeenCalledTimes(1);
    home.dispose();
  });
  it("shows a verified external merge at its actual completion time while preserving the finished review", () => {
    const now = Date.parse("1970-01-10T12:00:00Z");
    const page = mountApp(History, {
      seed: {
        page: "fleetHistory",
        history: {
          organizationId: "org",
          status: "complete",
          now,
          units: [
            {
              ...need,
              unit: {
                ...need.unit,
                ending: { kind: "merge_ready", at: now - 172800000 },
                mergeCompletion: { at: now - 120000, sha: "b".repeat(40) },
              },
            },
          ],
        },
      },
    });
    expect(page.text()).toContain("Merged");
    expect(page.text()).toContain("2 minutes ago");
    expect(page.text()).not.toContain("2 days ago");
    expect(page.get("time").attributes("datetime")).toBe("1970-01-10T11:58:00.000Z");
  });
  it("shows the selected Sun–Sat week with honest completion times and no future-week arrow", () => {
    const now = Date.parse("1970-01-10T12:00:00Z");
    const page = mountApp(History, {
      seed: {
        page: "fleetHistory",
        history: {
          organizationId: "org",
          status: "complete",
          now,
          week: {
            startDate: "1970-01-04",
            timeZone: "UTC",
            start: Date.parse("1970-01-04T00:00:00Z"),
            end: Date.parse("1970-01-11T00:00:00Z"),
            label: "Jan 4–10, 1970",
            previousUrl: "/home/history?week=1969-12-28&tz=UTC",
          },
          units: [
            { ...need, unit: { ...need.unit, ending: { kind: "done", at: now - 120000 } } },
            {
              ...need,
              unit: {
                ...need.unit,
                unit: "i:older",
                title: "Earlier work",
                ending: { kind: "done", at: now - 172800000 },
              },
            },
          ],
          cursor: "opaque-page",
        },
      },
    });
    expect(page.text()).toContain("Jan 4–10, 1970");
    expect(page.text()).toContain("Sunday–Saturday · UTC");
    expect(page.text()).toContain("2 minutes ago");
    expect(page.text()).toContain("2 days ago");
    expect(page.get('[aria-label="Previous week"]').attributes("href")).toBe("/home/history?week=1969-12-28&tz=UTC");
    expect(page.find('[aria-label="Next week"]').exists()).toBe(false);
    expect(page.get('[aria-label="Older work in this week"]').attributes("href")).toBe(
      "/home/history?week=1970-01-04&tz=UTC&cursor=opaque-page",
    );
  });
  it("renders only catalog-backed local Slack emoji in safe prose and preserves code and unknown names", async () => {
    const prose = defineComponent({
      render: () =>
        h(Shell, {}, { default: () => h(MarkdownText, { text: "Ready :shipit: :unknown: :unsafe: `:shipit:`" }) }),
    });
    const page = mountApp(prose, {
      seed: {
        ...seed,
        emoji: {
          shipit: { path: "/assets/emoji/opaque_123.png" },
          unsafe: { path: "https://attacker.invalid/pixel.png" },
        },
      },
    });
    await flushPromises();
    expect(page.findAll(".md img").map((image) => [image.attributes("src"), image.attributes("alt")])).toEqual([
      ["/assets/emoji/opaque_123.png", ":shipit:"],
    ]);
    expect(page.get(".md code").text()).toBe(":shipit:");
    expect(page.get(".md").text()).toContain(":unknown: :unsafe:");
  });
  it("removes an existing view-as observer's private words immediately when the global scope changes", async () => {
    const stream = fakeEventSourceFactory();
    const home = createHomeSession((async () => json(session())) as typeof fetch, stream.factory);
    await home.load();
    const page = mountApp(ReadonlyThread, {
      props: { thread: "slack:C1:1" },
      seed: { ...seed, viewingAs: { id: "slack:bob", name: "Bob" } },
      eventSource: stream.factory,
      provides: [[HomeSessionKey, home]],
    });
    const observer = stream.created.find((source) => source.url.includes("observe=1"))!;
    observer.emitMessage({
      ...session("slack:C1:1"),
      entries: [
        { id: "question:private", role: "user", isViewer: false, authorLabel: "Bob", content: "Private Bob words" },
      ],
    });
    await flushPromises();
    expect(page.text()).toContain("Private Bob words");
    home.resetPrivate();
    await flushPromises();
    expect(page.text()).not.toContain("Private Bob words");
    expect(page.text()).toContain("unavailable");
    home.dispose();
  });
  it("offers All people only from the trusted global capability and hides personal data while switching", async () => {
    const home = createHomeSession((async () => json(session())) as typeof fetch, fakeEventSourceFactory().factory);
    await home.load();
    const restricted = mountApp(Shell, { seed });
    await restricted.get('[aria-label="User menu"]').trigger("click");
    expect(restricted.findAll("option").map((option) => option.text())).not.toContain("All people");
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(browser, "reload").mockImplementation(() => {});
    const layout = defineComponent({
      render: () => h(Shell, {}, { default: () => h("div", [h("p", "Private report detail"), h(ConversationDock)]) }),
    });
    const page = mountApp(layout, {
      seed: { ...seed, dataView: { mode: "mine", canViewEveryone: true } },
      provides: [[HomeSessionKey, home]],
    });
    expect(page.findAll("textarea")).toHaveLength(1);
    await page.get('[aria-label="User menu"]').trigger("click");
    await page.get('[aria-label="View as person"]').setValue("everyone");
    await flushPromises();
    expect(page.findAll("textarea")).toHaveLength(0);
    expect(page.text()).not.toContain("Private report detail");
    expect(page.text()).toContain("Changing dashboard view.");
    expect(fetcher.mock.calls).toEqual([
      [
        "/runs/data-view",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: '{"mode":"everyone"}',
        },
      ],
    ]);
    await home.load();
    expect(home.session.value).toBe(null);
    home.dispose();
  });
  it("offers original thread, repository, branch, pull request and Changes links from pipeline work", () => {
    const page = mountApp(Home, { seed });
    const card = page.get(".green-pipeline-card");
    expect(card.get('a[aria-label="Original unit thread"]').attributes("href")).toBe("/threads/slack%3AC1%3A1");
    expect(card.get('a[aria-label="Changes"]').attributes("href")).toBe("/runs/unit/i%3Aq#changes");
    expect(card.get('a[href="https://github.com/sample/api"]').text()).toBe("sample/api");
    expect(card.get('a[href="https://github.com/sample/api/tree/codex/staging"]').text()).toBe("codex/staging");
    expect(card.get('a[href="https://github.com/sample/api/pull/42"]').text()).toContain("42");
    expect(card.text()).toContain("Answer the question");
  });
  it("labels current proved own sources as You and names the real external and automation owners", () => {
    const conditions: HomeUnit["conditions"] = [
      ...["access:alice", "slack:alice", "slack:bob"].map((id) => ({
        ...need.conditions[0],
        id,
        owner: { kind: "person" as const, id },
      })),
      { ...need.conditions[0], id: "external", owner: { kind: "external", label: "GitHub checks" } },
      { ...need.conditions[0], id: "automation", owner: { kind: "automation", class: "Reviews" } },
    ];
    const rows = [{ ...need, conditions }];
    const page = mountApp(UnitList, {
      props: { rows, label: "Needs you", attentionRecipients: ["access:alice", "slack:alice"] },
    });
    expect(page.get(".green-unit-owner").text()).toBe("You · You · Assigned to: slack:bob · GitHub checks · Reviews");
  });
  it("reads an authorized All people thread without a personal session and removes it on access revocation", async () => {
    const stream = fakeEventSourceFactory();
    const home = createHomeSession(
      (async () => new Response(JSON.stringify({ status: "not_found" }), { status: 404 })) as typeof fetch,
      stream.factory,
    );
    await home.load();
    const page = mountApp(ReadonlyThread, {
      props: { thread: "slack:C1:1" },
      seed: { ...seed, dataView: { mode: "everyone", canViewEveryone: true } },
      eventSource: stream.factory,
      provides: [[HomeSessionKey, home]],
    });
    const observer = stream.created.find((source) => source.url.includes("observe=1"))!;
    observer.emitMessage({
      ...session("slack:C1:1"),
      entries: [
        {
          id: "question:q",
          role: "assistant",
          isViewer: false,
          authorLabel: "Current question",
          content: "Authorized original question",
        },
      ],
    });
    await flushPromises();
    expect(page.text()).toContain("Authorized original question");
    expect(page.findAll("button").map((button) => button.text())).not.toContain("Reply in this thread");
    observer.emitNamed("revoked");
    await flushPromises();
    expect(page.text()).not.toContain("Authorized original question");
    expect(page.text()).toContain("Conversation is unavailable");
    home.dispose();
  });
});
