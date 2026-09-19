import { describe, expect, it, vi } from "vitest";
import { h } from "vue";
import { RouterLink } from "vue-router";
import type { Capabilities } from "@core/core/capabilities.js";
import type { WebSeed } from "@core/channels/webSeed.js";
import AppNav from "./AppNav.vue";
import { navSections } from "../lib/navSections";
import AppShell from "./AppShell.vue";
import { ALL_ON, mountApp } from "../testing/mount";
import { browser } from "../lib/browser";

// Feature: docs/reference/specs/live-view.md — the site nav and the shell follow the
// installation's capabilities (the seed): Residents needs `residents`, Costs
// `costs`, Delivery `github`, Plane `runLedger`; Threads and Runs are always there, and so is the section the viewer is on. The
// docs link needs nothing: it opens the project's published site
// (docs/reference/specs/docs-site.md item 11).

/** A page island whose capabilities are ALL_ON with `over` applied — the page
 *  itself is irrelevant to the chrome, so the smallest seed stands in. */
const island = (over: Partial<Capabilities> = {}): WebSeed => ({
  page: "runNotFound",
  title: "Run not found",
  retentionDays: null,
  capabilities: { ...ALL_ON, ...over },
});
const MINIMAL: Partial<Capabilities> = {
  residents: false,
  costs: false,
  schedules: false,
  github: false,
  runLedger: false,
};

describe("navSections — which sections exist", () => {
  it("every capability on → Threads, Runs, Plane, Residents, Costs, Delivery in fixed order; settings is chrome, not a section", () => {
    expect(navSections(ALL_ON, "runs").map((s) => s.id)).toEqual([
      "home",
      "runs",
      "plane",
      "residents",
      "costs",
      "delivery",
    ]);
    expect(navSections(ALL_ON, "settings").map((s) => s.id)).toEqual([
      "home",
      "runs",
      "plane",
      "residents",
      "costs",
      "delivery",
    ]);
  });

  it("a section is listed only when its capability is on; Runs needs none", () => {
    expect(navSections({ ...ALL_ON, residents: false }, "runs").map((s) => s.id)).toEqual([
      "home",
      "runs",
      "plane",
      "costs",
      "delivery",
    ]);
    expect(navSections({ ...ALL_ON, costs: false }, "runs").map((s) => s.id)).toEqual([
      "home",
      "runs",
      "plane",
      "residents",
      "delivery",
    ]);
    expect(navSections({ ...ALL_ON, ...MINIMAL }, "runs").map((s) => s.id)).toEqual(["home", "runs"]);
  });

  it("the section the viewer is on is always listed, even with its capability off", () => {
    expect(navSections({ ...ALL_ON, ...MINIMAL }, "costs").map((s) => s.id)).toEqual(["home", "runs", "costs"]);
    expect(navSections({ ...ALL_ON, ...MINIMAL }, "residents").map((s) => s.id)).toEqual(["home", "runs", "residents"]);
  });

  it("no capabilities (no seed) → Threads, Runs and the current section only", () => {
    expect(navSections(null, "runs").map((s) => s.id)).toEqual(["home", "runs"]);
    expect(navSections(null, "residents").map((s) => s.id)).toEqual(["home", "runs", "residents"]);
  });
});

describe("AppNav", () => {
  it("renders the six sections in fixed order with clean hrefs (no tokens, no query strings), each a RouterLink — navigated in place", () => {
    const wrapper = mountApp(AppNav, { props: { current: "runs" }, seed: island() });
    const links = wrapper.findAll("nav.site a");
    expect(links.map((a) => a.text())).toEqual(["Threads", "Runs", "Plane", "Residents", "Costs", "Delivery"]);
    expect(links.map((a) => a.attributes("href"))).toEqual([
      "/threads",
      "/runs",
      "/plane",
      "/residents",
      "/costs",
      "/delivery",
    ]);
    for (const a of links) {
      expect(a.attributes("href")).not.toContain("?");
      expect(a.attributes("href")).not.toContain("t=");
    }
    expect(wrapper.findAllComponents(RouterLink).map((l) => l.props("to"))).toEqual([
      "/threads",
      "/runs",
      "/plane",
      "/residents",
      "/costs",
      "/delivery",
    ]);
  });

  it("marks exactly the current section with aria-current=page", () => {
    for (const current of ["home", "runs", "plane", "residents", "costs", "delivery"] as const) {
      const wrapper = mountApp(AppNav, { props: { current }, seed: island() });
      const marked = wrapper.findAll('nav.site a[aria-current="page"]');
      expect(marked).toHaveLength(1);
      expect(marked[0].attributes("href")).toBe(current === "home" ? "/threads" : `/${current}`);
    }
  });

  it("drops Residents when residents is off and Costs when costs is off; the minimal installation is Threads and Runs", () => {
    expect(
      mountApp(AppNav, { props: { current: "runs" }, seed: island({ residents: false }) })
        .findAll("nav.site a")
        .map((a) => a.text()),
    ).toEqual(["Threads", "Runs", "Plane", "Costs", "Delivery"]);
    expect(
      mountApp(AppNav, { props: { current: "runs" }, seed: island({ costs: false }) })
        .findAll("nav.site a")
        .map((a) => a.text()),
    ).toEqual(["Threads", "Runs", "Plane", "Residents", "Delivery"]);
    const minimal = mountApp(AppNav, { props: { current: "runs" }, seed: island(MINIMAL) });
    expect(minimal.findAll("nav.site a").map((a) => a.text())).toEqual(["Threads", "Runs"]);
    expect(minimal.find('nav.site a[aria-current="page"]').attributes("href")).toBe("/runs");
  });

  it("without a seed lists Threads and Runs only", () => {
    const wrapper = mountApp(AppNav, { props: { current: "runs" } });
    expect(wrapper.findAll("nav.site a").map((a) => a.text())).toEqual(["Threads", "Runs"]);
  });
});

describe("AppShell", () => {
  it("renders the title, the nav, and the page body", () => {
    const wrapper = mountApp(AppShell, {
      props: { title: "Live runs", nav: "runs" },
      seed: island(),
      slots: { default: () => h("p", { id: "body" }, "hello") },
    });
    expect(wrapper.find("h1 .title").text()).toBe("Live runs");
    expect(wrapper.find("h1 a.brand .wordmark").text()).toBe("Switchboard");
    expect(wrapper.find("h1 a.brand").attributes("href")).toBe("/threads");
    expect(wrapper.find("nav.site").exists()).toBe(true);
    expect(wrapper.find("#body").text()).toBe("hello");
  });

  // Feature: docs/decisions/0053 — the banner on every page while viewing as a person.
  it("draws the view-as banner under the header when the seed carries viewingAs — the person by name with the id beside, read-only said plainly, an Exit that posts the exit route and reloads — and nothing of it otherwise", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const reload = vi.spyOn(browser, "reload").mockImplementation(() => {});
    try {
      const plain = mountApp(AppShell, { props: { title: "Live runs", nav: "runs" }, seed: island() });
      expect(plain.find("#view-as").exists()).toBe(false);
      const viewing = mountApp(AppShell, {
        props: { title: "Live runs", nav: "runs" },
        seed: { ...island(), viewingAs: { id: "slack:UIVY", name: "ivy" } },
      });
      const banner = viewing.find("#view-as");
      expect(banner.exists()).toBe(true);
      expect(banner.attributes("role")).toBe("status");
      expect(banner.find(".who strong").text()).toBe("ivy");
      expect(banner.find(".who .font-mono").text()).toBe("slack:UIVY");
      expect(banner.find(".readonly").text()).toContain("read-only");
      await banner.find("#view-as-exit").trigger("click");
      expect(fetch).toHaveBeenCalledWith("/runs/view-as/exit", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
      });
      await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      // Without a name the id stands alone.
      const unnamed = mountApp(AppShell, {
        props: { title: "Live runs", nav: "runs" },
        seed: { ...island(), viewingAs: { id: "slack:UIVY" } },
      });
      expect(unnamed.find("#view-as .who strong").text()).toBe("slack:UIVY");
      expect(unnamed.find("#view-as .who .font-mono").exists()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("a refused exit keeps the banner and shows the server's sentence; nothing reloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: "unauthorized",
          message: "Only a session holding every grant may view as a person.",
        }),
      }),
    );
    const reload = vi.spyOn(browser, "reload").mockImplementation(() => {});
    try {
      const viewing = mountApp(AppShell, {
        props: { title: "Live runs", nav: "runs" },
        seed: { ...island(), viewingAs: { id: "slack:UIVY", name: "ivy" } },
      });
      await viewing.find("#view-as-exit").trigger("click");
      await vi.waitFor(() =>
        expect(viewing.find("#view-as .text-bad").text()).toBe(
          "Only a session holding every grant may view as a person.",
        ),
      );
      expect(reload).not.toHaveBeenCalled();
      expect(viewing.find("#view-as").exists()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("offers the phone hamburger (nav + docs + theme in one touch menu) beside the sm+ inline nav", () => {
    const wrapper = mountApp(AppShell, { props: { title: "Live runs", nav: "runs" }, seed: island() });
    expect(wrapper.find('button[aria-label="Menu"]').exists()).toBe(true);
  });

  it("links to the docs at /docs in a new tab — the project's published site, on every installation — without adding an entry to the section nav", () => {
    const wrapper = mountApp(AppShell, { props: { title: "Live runs", nav: "runs" }, seed: island() });
    const docs = wrapper.find("a.docs-link");
    expect(docs.exists()).toBe(true);
    // The app knows the path, never the docs hostname — the server owns where
    // /docs resolves to (src/core/docsLink.ts).
    expect(docs.attributes("href")).toBe("/docs");
    expect(docs.attributes("target")).toBe("_blank");
    expect(docs.attributes("rel")).toContain("noopener");
    expect(docs.attributes("aria-label")).toBe("Docs");
    expect(wrapper.findAll("nav.site a")).toHaveLength(6);
  });

  it("carries the settings cog in the header on every installation — a same-tab link to /settings, lit only on the settings page, never a nav section", () => {
    const elsewhere = mountApp(AppShell, { props: { title: "Live runs", nav: "runs" }, seed: island(MINIMAL) });
    const cog = elsewhere.find("a.settings-link");
    expect(cog.exists()).toBe(true);
    expect(cog.attributes("href")).toBe("/settings");
    expect(cog.attributes("target")).toBeUndefined();
    expect(cog.attributes("aria-label")).toBe("Settings");
    expect(cog.attributes("aria-current")).toBeUndefined();
    expect(elsewhere.findAll("nav.site a").map((a) => a.text())).toEqual(["Threads", "Runs"]);
    const here = mountApp(AppShell, { props: { title: "Settings", nav: "settings" }, seed: island() });
    expect(here.find("a.settings-link").attributes("aria-current")).toBe("page");
    expect(here.find('nav.site a[aria-current="page"]').exists()).toBe(false);
  });

  /** The hamburger's item groups (the header holds two dropdowns — theme, hamburger; this is the hamburger). */
  const menuGroups = (wrapper: ReturnType<typeof mountApp>) => {
    const menu = wrapper
      .findAllComponents({ name: "DropdownMenu" })
      .find((c) => c.find('button[aria-label="Menu"]').exists());
    return menu?.props("items") as { label: string; to?: string; target?: string }[][];
  };

  it("puts the docs in the phone menu too, as its own group above the sections", () => {
    const items = menuGroups(mountApp(AppShell, { props: { title: "Live runs", nav: "runs" }, seed: island() }));
    expect(items[0]).toEqual([
      expect.objectContaining({ label: "Docs", to: "/docs", target: "_blank" }),
      expect.objectContaining({ label: "Settings", checked: false }),
    ]);
    expect(items[1].map((i) => i.label)).toEqual(["Threads", "Runs", "Plane", "Residents", "Costs", "Delivery"]);
    expect(items[2].map((i) => i.label)).toEqual(["Light", "Dark", "System"]);
  });

  it("the docs link and its menu group stay when a section is off; the menu's sections follow the nav", () => {
    const wrapper = mountApp(AppShell, {
      props: { title: "Live runs", nav: "runs" },
      seed: island({ costs: false }),
    });
    expect(wrapper.find("a.docs-link").exists()).toBe(true);
    expect(wrapper.findAll("nav.site a").map((a) => a.text())).toEqual([
      "Threads",
      "Runs",
      "Plane",
      "Residents",
      "Delivery",
    ]);
    const items = menuGroups(wrapper);
    expect(items).toHaveLength(3);
    expect(items[0].map((i) => i.label)).toEqual(["Docs", "Settings"]);
    expect(items[1].map((i) => i.label)).toEqual(["Threads", "Runs", "Plane", "Residents", "Delivery"]);
    expect(items[2].map((i) => i.label)).toEqual(["Light", "Dark", "System"]);
  });

  it("the minimal installation's header is Threads, Runs, the settings cog, the docs link, the theme toggle and the menu — nothing that leads nowhere", () => {
    const wrapper = mountApp(AppShell, { props: { title: "Live runs", nav: "runs" }, seed: island(MINIMAL) });
    expect(wrapper.findAll("nav.site a").map((a) => a.text())).toEqual(["Threads", "Runs"]);
    expect(wrapper.find("a.docs-link").exists()).toBe(true);
    expect(wrapper.find("a.settings-link").exists()).toBe(true);
    expect(menuGroups(wrapper).map((g) => g.map((i) => i.label))).toEqual([
      ["Docs", "Settings"],
      ["Threads", "Runs"],
      ["Light", "Dark", "System"],
    ]);
  });
});
