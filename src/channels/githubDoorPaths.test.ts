import { describe, expect, it } from "vitest";
import { githubDoorEdgeRoute } from "./githubDoorPaths.js";

const door = "https://git.switchboard.example.test";
const route = (url: string, method = "GET", configured = door) => githubDoorEdgeRoute(new URL(url), method, configured);

describe("GitHub door edge route", () => {
  it("admits only the exact HTTPS git host and methods for Git and read API", () => {
    expect(route(`${door}/o/r.git/info/refs?service=git-upload-pack`)).toBe("door");
    expect(route(`${door}/git/o/r.git/git-receive-pack`, "POST")).toBe("door");
    expect(route(`${door}/api/v3/repos/o/r`)).toBe("door");
    expect(route(`${door}/api/graphql`, "POST")).toBe("door");
    expect(route(`${door}/api/v3/repos/o/r`, "PATCH")).toBe("refuse");
    expect(route(`${door}/o/r.git/info/refs?service=unknown`)).toBe("refuse");
    expect(route(`${door}/git/o/r.git/git-receive-pack`, "GET")).toBe("refuse");
    expect(route(`http://git.switchboard.example.test/o/r.git/info/refs?service=git-upload-pack`)).toBe("refuse");
  });

  it("rejects dashboards, ingress, MCP and admin routes on git host", () => {
    for (const path of ["/", "/runs", "/runs/id", "/ingress", "/mcp", "/admin/restart", "/healthz", "/api/commands"])
      expect(route(`${door}${path}`)).toBe("refuse");
  });

  it("rejects door paths on dashboard, fallback and typo hosts", () => {
    for (const host of [
      "switchboard.example.test",
      "switchboard.workers.dev",
      "git.switchboard.example.test.evil.invalid",
    ])
      expect(route(`https://${host}/api/v3/repos/o/r`)).toBe("refuse");
    expect(route("https://switchboard.example.test/runs")).toBe("other");
    expect(githubDoorEdgeRoute(new URL(`${door}/api/v3/repos/o/r`), "GET", undefined)).toBe("refuse");
  });
});
