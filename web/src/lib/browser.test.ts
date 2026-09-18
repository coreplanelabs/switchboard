// Feature: docs/reference/specs/live-view.md item 31 — `browser.navigate` goes
// through the router for the app's own paths once main.ts hands its push in.
import { afterEach, describe, expect, it, vi } from "vitest";
import { browser, isAppPath, routeNavigationInApp } from "./browser";

describe("browser.navigate — in place for the app's own paths, a full navigation otherwise", () => {
  afterEach(() => routeNavigationInApp(null));

  it("isAppPath: root-relative paths are the app's; other origins, protocol-relative and relative addresses are not", () => {
    expect(isAppPath("/runs")).toBe(true);
    expect(isAppPath("/runs/abc?t=1#step-3")).toBe(true);
    expect(isAppPath("//evil.example/runs")).toBe(false);
    expect(isAppPath("https://github.com/acme/api")).toBe(false);
    expect(isAppPath("?fresh=1")).toBe(false);
  });

  it("without a handler every navigation is the browser's; with one, an app path goes to it and any other address stays the browser's", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign, pathname: "/runs", search: "", reload: vi.fn() });
    browser.navigate("/costs");
    expect(assign).toHaveBeenCalledWith("/costs");
    const inApp = vi.fn();
    routeNavigationInApp(inApp);
    browser.navigate("/costs?days=7");
    expect(inApp).toHaveBeenCalledWith("/costs?days=7");
    browser.navigate("https://github.com/acme/api/pull/1");
    expect(assign).toHaveBeenCalledWith("https://github.com/acme/api/pull/1");
    expect(inApp).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("the address the page is already at is a reload — the page seeded anew — while a hash on it is routed", () => {
    const assign = vi.fn();
    const reload = vi.fn();
    const inApp = vi.fn();
    vi.stubGlobal("location", { assign, reload, pathname: "/runs", search: "?all=1" });
    routeNavigationInApp(inApp);
    browser.navigate("/runs?all=1");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(inApp).not.toHaveBeenCalled();
    browser.navigate("/runs?all=1#row-3");
    expect(inApp).toHaveBeenCalledWith("/runs?all=1#row-3");
    browser.navigate("/runs");
    expect(inApp).toHaveBeenCalledWith("/runs");
    expect(assign).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("leave is always the browser's, whatever the handler", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign, pathname: "/runs", search: "", reload: vi.fn() });
    routeNavigationInApp(vi.fn());
    browser.leave("/runs/abc/events");
    expect(assign).toHaveBeenCalledWith("/runs/abc/events");
    vi.unstubAllGlobals();
  });
});
