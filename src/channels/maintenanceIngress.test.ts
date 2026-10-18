import { describe, expect, it } from "vitest";
import { handleIngressRequest } from "./http.js";
import { ALL_GRANTS } from "../core/authz/grants.js";
import type { CoreDeps } from "../core/dispatcher.js";
import { InMemoryMaintenanceStore, MaintenanceService } from "../core/maintenance.js";

describe("HTTP maintenance admission", () => {
  it("refuses a valid user request during maintenance and dispatches after explicit release", async () => {
    const maintenance = new InMemoryMaintenanceStore();
    const service = new MaintenanceService({ store: maintenance });
    const state = await service.start({ scopes: ["all"] }, "cli:local");
    const deps = { maintenance, config: { config: {}, grantsFor: () => ALL_GRANTS } } as unknown as CoreDeps;
    const options = {
      auth: { tokens: { token: { subject: "fixture" } } },
      dispatch: async (_core: CoreDeps, _msg: unknown, io: { reply(text: string): Promise<void> }) => {
        await io.reply("Request accepted.");
      },
    };
    const request = {
      method: "POST",
      headers: { authorization: "Bearer token" },
      body: JSON.stringify({ text: "Review the PR" }),
    };
    expect(await handleIngressRequest(request, deps, options)).toEqual({
      status: 503,
      body: { error: "maintenance", message: "Down for maintenance. You cannot use Switchboard agents or web pages." },
    });
    await service.end(state.episode!.id, "cli:local");
    expect(await handleIngressRequest(request, deps, options)).toMatchObject({
      status: 200,
      body: { reply: "Request accepted." },
    });
  });
});
