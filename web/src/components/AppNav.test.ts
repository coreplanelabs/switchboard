import { describe, expect, it } from "vitest";
import { h } from "vue";
import type { Capabilities } from "@core/core/capabilities.js";
import type { WebSeed } from "@core/channels/webSeed.js";
import AppNav from "./AppNav.vue";
import { navSections } from "../lib/navSections";
import AppShell from "./AppShell.vue";
import { ALL_ON, mountApp } from "../testing/mount";

// Feature: docs/reference/specs/live-view.md — the site nav and the shell follow the
// installation's capabilities (the seed): Residents needs `residents`, Costs
// `costs`, Delivery `github`; Runs is always there, and so is the section the viewer is on. The
// docs link needs nothing: it opens the project's published site
// (docs/reference/specs/docs-site.md item 11).

/** A page island whose capabilities are ALL_ON with `over` applied — the page
 *  itself is irrelevant to the chrome, so the smallest seed stands in. */
const island = (over: Partial<Capabilities> = {}): WebSeed => ({
  page: "runNotFound",
  retentionDays: null,
  capabilities: { ...ALL_ON, ...over },
});
const MINIMAL: Partial<Capabilities> = { residents: false, costs: false, schedules: false, github: false };

describe("navSections — which sections exist", () => {
  it("every capability on → Runs, Residents, Costs, Delivery in fixed order", () => {
    expect(navSections(ALL_ON, "runs").map((s) => s.id)).toEqual(["runs", "residents", "costs", "delivery"]);
  });

  it("a section is listed only when its capability is on; Runs needs none", () => {
    expect(navSections({ ...ALL_ON, residents: false }, "runs").map((s) => s.id)).toEqual([
      "runs",
      "costs",
      "delivery",
    ]);
    expect(navSections({ ...ALL_ON, costs: false }, "runs").map((s) => s.id)).toEqual([
      "runs",
      "residents",
      "delivery",
    ]);
    expect(navSections({ ...ALL_ON, ...MINIMAL }, "runs").map((s) => s.id)).toEqual(["runs"]);
  });

  it("the section the viewer is on is always listed, even with its capability off", () => {
    expect(navSections({ ...ALL_ON, ...MINIMAL }, "costs").map((s) => s.id)).toEqual(["runs", "costs"]);
    expect(navSections({ ...ALL_ON, ...MINIMAL }, "residents").map((s) => s.id)).toEqual(["runs", "residents"]);
  });

  it("no capabilities (no seed) → Runs and the current section only", () => {
    expect(navSections(null, "runs").map((s) => s.id)).toEqual(["runs"]);
    expect(navSections(null, "residents").map((s) => s.id)).toEqual(["runs", "residents"]);
  });
});

describe("AppNav", () => {
  it("renders the four sections in fixed order with clean hrefs (no tokens, no query strings)", () => {
    const wrapper = mountApp(AppNav, { props: { current: "runs" }, seed: island() });
    const links = wrapper.findAll("nav.site a");
    expect(links.map((a) => a.text())).toEqual(["Runs", "Residents", "Costs", "Delivery"]);
    expect(links.map((a) => a.attributes("href"))).toEqual(["/runs", "/residents", "/costs", "/delivery"]);
    for (const a of links) {
      expect(a.attributes("href")).not.toContain("?");
      expect(a.attributes("href")).not.toContain("t=");
    }
  });

  it("marks exactly the current section with aria-current=page", () => {
    for (const current of ["runs", "residents", "costs", "delivery"] as const) {
      const wrapper = mountApp(AppNav, { props: { current }, seed: island() });
      const marked = wrapper.findAll('nav.site a[aria-current="page"]');
      expect(marked).toHaveLength(1);
      expect(marked[0].attributes("href")).toBe(`/${current}`);
    }
  });

  it("drops Residents when residents is off and Costs when costs is off; the minimal installation is Runs alone", () => {
    expect(
      mountApp(AppNav, { props: { current: "runs" }, seed: island({ residents: false }) })
        .findAll("nav.site a")
        .map((a) => a.text()),
    ).toEqual(["Runs", "Costs", "Delivery"]);
    expect(
      mountApp(AppNav, { props: { current: "runs" }, seed: island({ costs: false }) })
        .findAll("nav.site a")
        .map((a) => a.text()),
    ).toEqual(["Runs", "Residents", "Delivery"]);
    const minimal = mountApp(AppNav, { props: { current: "runs" }, seed: island(MINIMAL) });
    expect(minimal.findAll("nav.site a").map((a) => a.text())).toEqual(["Runs"]);
    expect(minimal.find('nav.site a[aria-current="page"]').attributes("href")).toBe("/runs");
  });

  it("without a seed lists Runs only", () => {
    const wrapper = mountApp(AppNav, { props: { current: "runs" } });
    expect(wrapper.findAll("nav.site a").map((a) => a.text())).toEqual(["Runs"]);
  });
});

describe("AppShell", () => {
  it("renders the title, the nav, and the page body", () => {
    const wrapper = mountApp(AppShell, {
      props: { title: "Live runs", nav: "runs" },
      seed: island(),
      slots: { default: () => h("p", { id: "body" }, "hello") },
    });
    expect(wrapper.find("h1").text()).toBe("Live runs");
    expect(wrapper.find("nav.site").exists()).toBe(true);
    expect(wrapper.find("#body").text()).toBe("hello");
  });

  it("offers the phone hamburger (nav + docs + theme in one touch menu) beside the sm+ inline nav", () => {
    const wrapper = mountApp(AppShell, { props: { title: "Live runs", nav: "runs" }, seed: island() });
    expect(wrapper.find('button[aria-label="Menu"]').exists()).toBe(true);
  });

  it("links to the docs at /docs in a new tab — the project's published site, on every installation — without adding a fifth entry to the section nav", () => {
    const wrapper = mountApp(AppShell, { props: { title: "Live runs", nav: "runs" }, seed: island() });
    const docs = wrapper.find("a.docs-link");
    expect(docs.exists()).toBe(true);
    // The app knows the path, never the docs hostname — the server owns where
    // /docs resolves to (src/core/docsLink.ts).
    expect(docs.attributes("href")).toBe("/docs");
    expect(docs.attributes("target")).toBe("_blank");
    expect(docs.attributes("rel")).toContain("noopener");
    expect(docs.attributes("aria-label")).toBe("Docs");
    expect(wrapper.findAll("nav.site a")).toHaveLength(4);
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
    expect(items[0]).toEqual([expect.objectContaining({ label: "Docs", to: "/docs", target: "_blank" })]);
    expect(items[1].map((i) => i.label)).toEqual(["Runs", "Residents", "Costs", "Delivery"]);
    expect(items[2].map((i) => i.label)).toEqual(["Light", "Dark", "System"]);
  });

  it("the docs link and its menu group stay when a section is off; the menu's sections follow the nav", () => {
    const wrapper = mountApp(AppShell, {
      props: { title: "Live runs", nav: "runs" },
      seed: island({ costs: false }),
    });
    expect(wrapper.find("a.docs-link").exists()).toBe(true);
    expect(wrapper.findAll("nav.site a").map((a) => a.text())).toEqual(["Runs", "Residents", "Delivery"]);
    const items = menuGroups(wrapper);
    expect(items).toHaveLength(3);
    expect(items[0].map((i) => i.label)).toEqual(["Docs"]);
    expect(items[1].map((i) => i.label)).toEqual(["Runs", "Residents", "Delivery"]);
    expect(items[2].map((i) => i.label)).toEqual(["Light", "Dark", "System"]);
  });

  it("the minimal installation's header is Runs, the docs link, the theme toggle and the menu — nothing that leads nowhere", () => {
    const wrapper = mountApp(AppShell, { props: { title: "Live runs", nav: "runs" }, seed: island(MINIMAL) });
    expect(wrapper.findAll("nav.site a").map((a) => a.text())).toEqual(["Runs"]);
    expect(wrapper.find("a.docs-link").exists()).toBe(true);
    expect(menuGroups(wrapper).map((g) => g.map((i) => i.label))).toEqual([
      ["Docs"],
      ["Runs"],
      ["Light", "Dark", "System"],
    ]);
  });
});
