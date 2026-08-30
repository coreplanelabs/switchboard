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
});
