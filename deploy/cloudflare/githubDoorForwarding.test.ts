import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("GitHub door edge wiring", () => {
  it("refuses disallowed git-host requests before any Worker route forwards to the bot", () => {
    const source = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
    const gate = source.indexOf("githubDoorEdgeRoute(requestUrl, request.method, env.PUBLIC_GIT_BASE_URL)");
    const forward = source.indexOf("getContainer(env.SWITCHBOARD, INSTANCE).fetch(inbound)");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(forward);
    expect(source.slice(gate, forward)).toContain('new Response("not found", { status: 404 })');
    expect(source).toContain('"PUBLIC_GIT_BASE_URL",');
  });
});
