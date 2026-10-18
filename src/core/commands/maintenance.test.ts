import { describe, expect, it } from "vitest";
import { bindCommands, CommandRegistry, type CommandDef } from "../commandRegistry.js";
import { parseInvocation } from "../commandSurface.js";
import { callerWith } from "../testing/callers.js";
import { InMemoryMaintenanceStore, MaintenanceService } from "../maintenance.js";
import { commandMaintenanceRefusal } from "../maintenanceAdmission.js";
import { registerMaintenanceCommands, type MaintenanceCommandDeps } from "./maintenance.js";

const id = "12345678-1234-4234-8234-123456789abc";
const operator = callerWith("mcp", "mcp:operator", [
  "maintenance:read",
  "maintenance:write",
  "repo:write",
  "repo:read",
  "status:read",
]);
function setup() {
  const store = new InMemoryMaintenanceStore();
  const service = new MaintenanceService({ store, id: () => id, clock: () => 1 });
  const registry = new CommandRegistry<MaintenanceCommandDeps>({
    audit: () => {},
    admission: (command, caller) => commandMaintenanceRefusal(store, command, caller),
  });
  registerMaintenanceCommands(registry);
  const commands = bindCommands(registry, { maintenance: { store, service, inFlight: () => 2 } });
  return { commands, store, service };
}

describe("maintenance commands", () => {
  it("returns exact CLI and MCP activation inputs without installing a schedule", async () => {
    const { commands } = setup();
    const parsed = parseInvocation(commands.get("maintenance.announce")!, [
      "--scopes",
      "agents,residents",
      "--timing",
      "in a few minutes",
    ]);
    if (parsed.kind !== "invoke") throw new Error("fixture grammar refused");
    const result = await commands.invoke("maintenance.announce", parsed.input, operator);
    expect(result).toMatchObject({
      ok: true,
      value: {
        episode: { id, phase: "announced", scopes: ["agents", "residents"], notice: { status: "unverified" } },
        inFlight: 2,
        activationCommand: `switchboard maintenance start --id ${id}`,
        activationTool: { name: "maintenance_start", arguments: { id } },
        schedule: { owner: "client", installed: false, startsAt: null, timing: "in a few minutes" },
      },
    });
  });

  it("requires explicit maintenance write authority and keeps status usable during a hold", async () => {
    const { commands } = setup();
    const reader = callerWith("mcp", "mcp:reader", ["maintenance:read"]);
    expect(await commands.invoke("maintenance.start", {}, reader)).toMatchObject({ ok: false, status: 403 });
    expect(await commands.invoke("maintenance.start", { options: { scopes: "all" } }, operator)).toMatchObject({
      ok: true,
      value: { episode: { phase: "active" } },
    });
    expect(await commands.invoke("maintenance.status", {}, reader)).toMatchObject({
      ok: true,
      value: { episode: { phase: "active" }, inFlight: 2 },
    });
    expect(await commands.invoke("maintenance.end", { options: { id } }, operator)).toMatchObject({
      ok: true,
      value: { episode: { phase: "ended" } },
    });
  });

  it("refuses invalid scopes and saved episode overrides", async () => {
    const { commands } = setup();
    expect(await commands.invoke("maintenance.start", { options: { scopes: "unknown" } }, operator)).toMatchObject({
      ok: false,
      status: 400,
    });
    await commands.invoke("maintenance.announce", {}, operator);
    expect(await commands.invoke("maintenance.start", { options: { id, scopes: "web" } }, operator)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await commands.invoke("maintenance.start", { options: { id } }, operator)).toMatchObject({
      ok: true,
      value: { episode: { phase: "active", scopes: ["all"] } },
    });
  });

  it("applies one command hold to every caller surface while preserving authorized repair", async () => {
    const { store, service } = setup();
    await service.start({ scopes: ["all"] }, operator.id);
    const registry = new CommandRegistry<object>({
      audit: () => {},
      admission: (command, caller) => commandMaintenanceRefusal(store, command, caller),
    });
    registry.register({
      id: "repo.build",
      action: "repo:exec",
      resource: () => ({ type: "agent", name: "coding" }),
      effect: "write",
      describe: "Build",
      handler: async () => ({ built: true }),
    } as CommandDef<object>);
    registry.register({
      id: "repo.rebuild",
      action: "repo:write",
      effect: "write",
      describe: "Repair",
      handler: async () => ({ repair: "accepted" }),
    } as CommandDef<object>);
    const commands = bindCommands(registry, {});
    for (const kind of ["mcp", "chat", "access", "cli"] as const) {
      const caller = callerWith(kind, `${kind}:user`, ["agent:run:coding"]);
      expect(await commands.invoke("repo.build", {}, caller)).toMatchObject({
        ok: false,
        status: 503,
        message: expect.stringContaining("Down for maintenance"),
      });
    }
    expect(await commands.invoke("repo.rebuild", {}, operator)).toMatchObject({
      ok: true,
      value: { repair: "accepted" },
    });
  });
});
