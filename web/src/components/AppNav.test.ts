import { describe, expect, it } from "vitest";
import { h } from "vue";
import AppNav from "./AppNav.vue";
import AppShell from "./AppShell.vue";
import { mountApp } from "../testing/mount";

describe("AppNav", () => {
  it("renders the three sections in fixed order with clean hrefs (no tokens, no query strings)", () => {
    const wrapper = mountApp(AppNav, { props: { current: "runs" } });
    const links = wrapper.findAll("nav.site a");
    expect(links.map((a) => a.text())).toEqual(["Runs", "Residents", "Costs"]);
    expect(links.map((a) => a.attributes("href"))).toEqual(["/runs", "/residents", "/costs"]);
    for (const a of links) {
      expect(a.attributes("href")).not.toContain("?");
      expect(a.attributes("href")).not.toContain("t=");
    }
  });

  it("marks exactly the current section with aria-current=page", () => {
    for (const current of ["runs", "residents", "costs"] as const) {
      const wrapper = mountApp(AppNav, { props: { current } });
      const marked = wrapper.findAll('nav.site a[aria-current="page"]');
      expect(marked).toHaveLength(1);
      expect(marked[0].attributes("href")).toBe(`/${current}`);
    }
  });
});

describe("AppShell", () => {
  it("renders the title, the nav, and the page body", () => {
    const wrapper = mountApp(AppShell, {
      props: { title: "Live runs", nav: "runs" },
      slots: { default: () => h("p", { id: "body" }, "hello") },
    });
    expect(wrapper.find("h1").text()).toBe("Live runs");
    expect(wrapper.find("nav.site").exists()).toBe(true);
    expect(wrapper.find("#body").text()).toBe("hello");
  });

  it("offers the phone hamburger (nav + docs + theme in one touch menu) beside the sm+ inline nav", () => {
    const wrapper = mountApp(AppShell, { props: { title: "Live runs", nav: "runs" } });
    expect(wrapper.find('button[aria-label="Menu"]').exists()).toBe(true);
  });

  it("links to the docs at /docs in a new tab, without adding a fourth entry to the section nav", () => {
    const wrapper = mountApp(AppShell, { props: { title: "Live runs", nav: "runs" } });
    const docs = wrapper.find("a.docs-link");
    expect(docs.exists()).toBe(true);
    // The app knows the path, never the docs hostname — the server owns where
    // /docs resolves to (src/core/docsLink.ts).
    expect(docs.attributes("href")).toBe("/docs");
    expect(docs.attributes("target")).toBe("_blank");
    expect(docs.attributes("rel")).toContain("noopener");
    expect(docs.attributes("aria-label")).toBe("Docs");
    expect(wrapper.findAll("nav.site a")).toHaveLength(3);
  });

  it("puts the docs in the phone menu too, as its own group above the sections", () => {
    const wrapper = mountApp(AppShell, { props: { title: "Live runs", nav: "runs" } });
    // The header holds two dropdowns (theme, hamburger); this is the hamburger.
    const menu = wrapper.findAllComponents({ name: "DropdownMenu" }).find((c) => c.find('button[aria-label="Menu"]').exists());
    const items = menu?.props("items") as { label: string; to?: string; target?: string }[][];
    expect(items[0]).toEqual([expect.objectContaining({ label: "Docs", to: "/docs", target: "_blank" })]);
    expect(items[1].map((i) => i.label)).toEqual(["Runs", "Residents", "Costs"]);
  });
});
