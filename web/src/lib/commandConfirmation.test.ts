import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { CommandRegistry, bindCommands } from "@core/core/commandRegistry.js";
import { ALL_GRANTS } from "@core/core/authz/grants.js";
import { InMemoryConfirmationStore } from "@core/core/confirmations.js";
import { createCommandHttpHandler } from "@core/channels/commandHttp.js";
import type { CoreDeps } from "@core/core/dispatcher.js";
import { postCommand } from "./settingsApi";

// Feature: docs/reference/specs/settings-page.md — native dashboard saved-id consent.
function fixture() {
  let removed = 0;
  const registry = new CommandRegistry({ audit: () => {}, confirmationClass: () => "destructive" });
  registry.register({
    id: "repo.offboard",
    action: "repo:write",
    effect: "write",
    describe: "Remove a repository",
    annotations: { destructive: true },
    handler: async () => ({ removed: ++removed }),
  });
  registry.register({
    id: "mcp.add",
    action: "mcp:write",
    effect: "write",
    describe: "Add a server",
    args: [{ name: "name", schema: z.string(), describe: "Server name" }],
    annotations: { destructive: true },
    handler: async () => ({ connect: { url: "https://bot.example/settings/connect/server" } }),
  });
  const commands = bindCommands(registry, {});
  const deps = { commands, confirmations: new InMemoryConfirmationStore() } as unknown as CoreDeps;
  return { deps, options: { commands }, removed: () => removed };
}

describe("native dashboard confirmation", () => {
  it("native dashboard confirmation works without Access links and returns the original JSON result once", async () => {
    const f = fixture();
    const handler = createCommandHttpHandler(f.options.commands!, {
      core: f.deps,
      browserApprovals: false,
      publicBaseUrl: "https://bot.example",
      grantsFor: () => ALL_GRANTS,
    });
    let subject = "local-operator";
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      async function* chunks() {
        yield Buffer.from(String(init?.body ?? ""));
      }
      const req = Object.assign(chunks(), {
        method: init?.method ?? "GET",
        url,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          host: "bot.example",
          origin: "https://bot.example",
        },
        destroy() {},
      });
      let status = 0;
      let body = "";
      const res = {
        writeHead: (value: number) => {
          status = value;
        },
        end: (value: string) => {
          body = value;
        },
      };
      handler(req as never, res as never, { sub: subject });
      await vi.waitFor(() => expect(status).not.toBe(0));
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    };
    let savedId = "";
    const accepted = await postCommand(fetchFn, "repo.offboard", {}, async (offer) => {
      expect(f.removed()).toBe(0);
      expect(offer.line).toBe("repo offboard");
      savedId = offer.id;
      return true;
    });
    expect(accepted).toEqual({ ok: true, value: { removed: 1 } });
    expect(f.removed()).toBe(1);
    const replay = await fetchFn("/api/repo.offboard", {
      method: "POST",
      headers: { "content-type": "application/json", "x-switchboard-client": "dashboard" },
      body: JSON.stringify({ _confirmation: { kind: "confirm", id: savedId } }),
    });
    expect(replay.ok).toBe(false);
    expect(f.removed()).toBe(1);
    const connect = await postCommand(fetchFn, "mcp.add", { name: "acme" }, async () => true);
    expect(connect).toEqual({ ok: true, value: { connect: { url: "https://bot.example/settings/connect/server" } } });
    const foreign = await postCommand(fetchFn, "repo.offboard", {}, async () => {
      subject = "another-operator";
      return true;
    });
    expect(foreign).toEqual({
      ok: false,
      failure: { error: "not_found", message: "This saved action is unavailable; nothing ran." },
    });
    expect(f.removed()).toBe(1);
    subject = "local-operator";
    const cancelled = await postCommand(fetchFn, "repo.offboard", {}, async () => false);
    expect(cancelled).toEqual({ ok: false, failure: { error: "cancelled", message: "Cancelled; nothing ran." } });
    expect(f.removed()).toBe(1);
  });
});
