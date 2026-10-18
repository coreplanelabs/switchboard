import type { Env } from "./worker.js";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { commandSchema, type OrganizationCommand } from "../../src/core/organization/contract.js";
import {
  directoryCommandSchema,
  executeDirectory,
  type DirectoryCommand,
} from "../../src/core/organization/directoryTransport.js";
import { SqliteOrganizationStore } from "../../src/core/organization/sqlite.js";
import { systemClock } from "../../src/core/trace/clock.js";
import {
  readResetSettings,
  freezeResetSettings,
  restoreResetSettings,
  verifyResetSettings,
  resetSettingsStatus,
  type SettingsSnapshot,
} from "./resetSettings.js";

/** One installation database keeps identity bindings and admission fences atomic. */
export class OrganizationDO extends DurableObject<Env> {
  private readonly store: SqliteOrganizationStore;
  resetSettings(
    action: "preview" | "freeze" | "restore" | "verify" | "status",
    operation?: string,
    snapshot?: SettingsSnapshot,
  ) {
    if (action === "status") return resetSettingsStatus(this.ctx.storage);
    if (action === "preview") return readResetSettings(this.ctx.storage, "organization");
    if (action === "freeze") return freezeResetSettings(this.ctx.storage, "organization", operation!);
    if (action === "restore") {
      if (snapshot?.kind !== "organization") throw new Error("invalid organization reset settings");
      return restoreResetSettings(this.ctx.storage, snapshot, operation!);
    }
    return verifyResetSettings(this.ctx.storage, operation!);
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqliteOrganizationStore(ctx.storage, systemClock);
  }
  execute(command: OrganizationCommand) {
    return this.store.execute(command);
  }
  directory(command: DirectoryCommand) {
    return executeDirectory(this.store.directory, command);
  }
}
const requestSchema = z.object({ installation: z.string().min(1).max(2048), command: z.unknown() }).strict();
/** The caller has already applied the Memory Worker's bearer and body-size gates. */
export async function organizationRoute(
  request: Request,
  organizations: DurableObjectNamespace<OrganizationDO>,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path !== "/organization/execute" && path !== "/organization/directory") return undefined;
  if (request.method !== "POST") return Response.json({ status: "invalid" }, { status: 405 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ status: "invalid" }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ status: "invalid" }, { status: 400 });
  const stub = organizations.get(organizations.idFromName(`organization:v1:${parsed.data.installation}`));
  if (path === "/organization/execute") {
    const command = commandSchema.safeParse(parsed.data.command);
    if (!command.success) return Response.json({ status: "invalid" }, { status: 400 });
    return Response.json(await stub.execute(command.data));
  }
  const command = directoryCommandSchema.safeParse(parsed.data.command);
  if (!command.success) return Response.json({ status: "invalid" }, { status: 400 });
  return Response.json(await stub.directory(command.data));
}
