import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import { RouterLink } from "vue-router";
import type { Capabilities } from "@core/core/capabilities.js";
import type { WebSeed } from "@core/channels/webSeed.js";
import { browser } from "../lib/browser";
import Shell from "../../green/components/Shell.vue";
import { ALL_ON, mountApp } from "../testing/mount";

const island = (over: Partial<Capabilities> = {}): WebSeed => ({
  page: "runNotFound",
  title: "Run unavailable",
  retentionDays: null,
  capabilities: { ...ALL_ON, ...over },
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("Global shell navigation", () => {
  it("keeps the signed-in profile photo in the user menu while viewing another person", async () => {
    const wrapper = mountApp(Shell, {
      seed: {
        ...island(),
        signedInUser: { id: "access:alice", name: "Alice Chen", avatarUrl: "https://avatars.slack-edge.com/alice.jpg" },
        viewingAs: { id: "slack:UIVY", name: "ivy" },
        asUser: { id: "slack:UIVY", name: "ivy" },
      },
    });
    const menu = wrapper.get('button[aria-label="User menu"]');
    expect(menu.get(".green-user-name").text()).toBe("Alice Chen");
    expect(menu.get(".green-user-read-target").text()).toBe("Viewing ivy");
    expect(menu.get("img").attributes("src")).toBe("https://avatars.slack-edge.com/alice.jpg");
    await menu.get("img").trigger("error");
    expect(menu.get('[aria-hidden="true"]').text()).toBe("AC");
    expect(menu.get(".green-user-name").text()).toBe("Alice Chen");
    await menu.trigger("click");
    expect(wrapper.text()).toContain("This person's view is read-only.");
  });

  it("renders capability-backed work links and constant run, settings, and documentation paths without tokens", () => {
    const wrapper = mountApp(Shell, { seed: island(), slots: { default: () => h("p", { id: "body" }, "hello") } });
    expect(wrapper.find("#body").text()).toBe("hello");
    expect(wrapper.find("a.green-brand").attributes("href")).toBe("/home");
    expect(wrapper.findAll(".green-sidebar nav a").map((a) => [a.text(), a.attributes("href")])).toEqual([
      ["Home", "/home"],
      ["Delivery", "/delivery"],
      ["Costs", "/costs"],
      ["Metrics", "/metrics"],
      ["Run details", "/runs"],
      ["Scheduled work", "/runs/scheduled"],
      ["Settings", "/settings"],
    ]);
    expect(wrapper.findAllComponents(RouterLink).every((link) => !String(link.props("to")).includes("?"))).toBe(true);
  });
  it("removes unavailable report and schedule paths while keeping Home, run details, Settings, and docs", () => {
    const wrapper = mountApp(Shell, {
      seed: island({ costs: false, metrics: false, github: false, schedules: false }),
    });
    expect(wrapper.findAll(".green-sidebar nav a").map((a) => a.attributes("href"))).toEqual([
      "/home",
      "/runs",
      "/settings",
    ]);
    expect(wrapper.find('a[href="/docs"]').exists()).toBe(true);
  });
  it("keeps Scheduled work reachable when already on its route even if firing history is unavailable", async () => {
    const wrapper = mountApp(Shell, { seed: island({ schedules: false }) });
    await wrapper.findComponent(Shell).vm.$router.push("/runs/scheduled");
    expect(wrapper.find('a[href="/runs/scheduled"]').exists()).toBe(true);
  });
  it("uses the server-owned docs destination in a protected new tab on every installation", () => {
    const wrapper = mountApp(Shell, { seed: island({ costs: false }) });
    const docs = wrapper.find('a[href="/docs"]');
    expect(docs.text()).toBe("Documentation");
    expect(docs.attributes("target")).toBe("_blank");
    expect(docs.attributes("rel")).toContain("noopener");
    expect(wrapper.findAll('nav a[href="/docs"]')).toHaveLength(0);
  });
  it("exposes the phone menu and appearance controls with accessible labels", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((media) => ({
      media,
      matches: false,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    }));
    const wrapper = mountApp(Shell, { seed: island() });
    const open = wrapper.find('button[aria-label="Open navigation"]');
    expect(open.attributes("aria-expanded")).toBe("false");
    await open.trigger("click");
    expect(open.attributes("aria-expanded")).toBe("true");
    expect(wrapper.find('aside[aria-label="Main navigation"]').attributes("aria-modal")).toBe("true");
    expect(
      wrapper.findAll('select[aria-label="Appearance"] option').map((o) => [o.text(), o.attributes("value")]),
    ).toEqual([
      ["System", "system"],
      ["Light", "light"],
      ["Dark", "dark"],
    ]);
    await wrapper.find("button.green-mobile-close").trigger("click");
    expect(open.attributes("aria-expanded")).toBe("false");
  });
  it("keeps appearance with the authenticated actor and organization across read-target changes", async () => {
    const open = (actor: string, organization: string, person?: string, everyone = false) =>
      mountApp(Shell, {
        seed: {
          ...island(),
          pageAccess: { actor, organization },
          ...(person ? { viewingAs: { id: person }, asUser: { id: person } } : {}),
          dataView: { mode: person ? "person" : everyone ? "everyone" : "mine", canViewEveryone: true },
        },
      });
    const appearance = 'select[aria-label="Appearance"]';
    let wrapper = open("access:alice", "org:one");
    await wrapper.get(appearance).setValue("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    wrapper.unmount();

    wrapper = open("access:bob", "org:one", "access:alice");
    expect((wrapper.get(appearance).element as HTMLSelectElement).value).toBe("system");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    await wrapper.get(appearance).setValue("light");
    wrapper.unmount();

    wrapper = open("access:alice", "org:two");
    expect((wrapper.get(appearance).element as HTMLSelectElement).value).toBe("system");
    await wrapper.get(appearance).setValue("light");
    wrapper.unmount();

    wrapper = open("access:alice", "org:one", "access:bob");
    expect((wrapper.get(appearance).element as HTMLSelectElement).value).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await wrapper.get(appearance).setValue("system");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    wrapper.unmount();

    wrapper = open("access:alice", "org:one", undefined, true);
    expect((wrapper.get(appearance).element as HTMLSelectElement).value).toBe("system");
    await wrapper.get(appearance).setValue("light");
    wrapper.unmount();

    wrapper = open("access:alice", "org:one");
    expect((wrapper.get(appearance).element as HTMLSelectElement).value).toBe("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    wrapper.unmount();
  });
  it("does not inherit a browser-wide or unbound account appearance", async () => {
    const appearance = 'select[aria-label="Appearance"]';
    localStorage.setItem("vueuse-color-scheme", "dark");
    for (const pageAccess of [undefined, { actor: "access:alice" }]) {
      const wrapper = mountApp(Shell, { seed: { ...island(), pageAccess } });
      expect((wrapper.get(appearance).element as HTMLSelectElement).value).toBe("system");
      await wrapper.get(appearance).setValue("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      wrapper.unmount();
    }
    const wrapper = mountApp(Shell, {
      seed: { ...island(), pageAccess: { actor: "access:alice", organization: "org:one" } },
    });
    expect((wrapper.get(appearance).element as HTMLSelectElement).value).toBe("system");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    await wrapper.get(appearance).setValue("light");
    expect(localStorage.getItem("vueuse-color-scheme")).toBe("dark");
    wrapper.unmount();
  });
  it("exits the selected person's read-only view through the global Mine choice", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const reload = vi.spyOn(browser, "reload").mockImplementation(() => {});
    const wrapper = mountApp(Shell, {
      seed: {
        ...island(),
        viewingAs: { id: "slack:UIVY", name: "ivy" },
        viewAs: { people: [{ id: "slack:UIVY", name: "ivy" }] },
      },
    });
    await wrapper.find('button[aria-label="User menu"]').trigger("click");
    expect(wrapper.text()).toContain("This person's view is read-only");
    expect(wrapper.find('button[aria-label="User menu"] .green-user-name').text()).toBe("Your account");
    expect(wrapper.find('button[aria-label="User menu"] .green-user-read-target').text()).toBe("Viewing ivy");
    await wrapper.find('select[aria-label="View as person"]').setValue("mine");
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith("/runs/data-view", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: '{"mode":"mine"}',
    });
    vi.unstubAllGlobals();
  });
  it("keeps the selected read-only view and shows a refused global change without reloading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "This view change was refused." }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const reload = vi.spyOn(browser, "reload").mockImplementation(() => {});
    const wrapper = mountApp(Shell, { seed: { ...island(), viewingAs: { id: "slack:UIVY", name: "ivy" } } });
    await wrapper.find('button[aria-label="User menu"]').trigger("click");
    await wrapper.find('select[aria-label="View as person"]').setValue("mine");
    await vi.waitFor(() => expect(wrapper.find('[role="alert"]').text()).toBe("This view change was refused."));
    expect(wrapper.text()).toContain("This person's view is read-only");
    expect(reload).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
