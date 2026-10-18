import { z } from "zod";
import type { Env } from "./worker.js";
import type { SettingsSnapshot } from "./resetSettings.js";
import { captureException } from "../../src/core/runStateWriteDiagnostic.js";

const inputSchema = z
  .object({
    action: z.enum(["preview", "freeze", "restore", "verify", "status", "addresses"]),
    operation: z.string().uuid().optional(),
    installations: z.array(z.string().min(1).max(2048)).max(100),
    config: z.unknown().optional(),
    organizations: z.array(z.unknown()).optional(),
  })
  .strict();

/** Same state-Worker bearer as configuration. Never log private transfer bodies. */
export async function resetSettingsRoute(request: Request, env: Env): Promise<Response> {
  const length = request.headers.get("content-length");
  if (!length || !/^\d+$/.test(length)) return Response.json({ error: "length required" }, { status: 411 });
  if (Number(length) > 2 * 1024 * 1024) return Response.json({ error: "settings transfer too large" }, { status: 413 });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 2 * 1024 * 1024)
    return Response.json({ error: "settings transfer too large" }, { status: 413 });
  let input: z.infer<typeof inputSchema>;
  try {
    input = inputSchema.parse(JSON.parse(raw));
  } catch {
    return Response.json({ error: "invalid reset settings request" }, { status: 400 });
  }
  if (!["preview", "status", "addresses"].includes(input.action) && !input.operation)
    return Response.json({ error: "reset operation required" }, { status: 400 });
  if (input.action === "restore" && (!input.config || input.organizations?.length !== input.installations.length))
    return Response.json({ error: "complete reset settings required" }, { status: 400 });
  if (new Set(input.installations).size !== input.installations.length)
    return Response.json({ error: "duplicate installation" }, { status: 400 });
  if (input.action === "addresses")
    return Response.json({
      config: env.CONFIG.idFromName("config").toString(),
      organizations: input.installations.map((installation) =>
        env.ORGANIZATIONS.idFromName(`organization:v1:${installation}`).toString(),
      ),
    });
  const config = env.CONFIG.get(env.CONFIG.idFromName("config"));
  const action = input.action;
  let failedObject: { kind: "config" | "organization" | "transfer"; index?: number } = { kind: "config" };
  try {
    // Config freezes first, so maintenance cannot end while other settings are captured.
    // During restoration it comes last, after all identity/access state is present.
    const readConfig = () => config.resetSettings(action, input.operation, input.config as SettingsSnapshot);
    const configLast = input.action === "restore" || input.action === "verify";
    const result = configLast ? undefined : await readConfig();
    const organizations = [];
    for (let i = 0; i < input.installations.length; i++) {
      failedObject = { kind: "organization", index: i };
      const installation = input.installations[i];
      const stub = env.ORGANIZATIONS.get(env.ORGANIZATIONS.idFromName(`organization:v1:${installation}`));
      organizations.push(
        await stub.resetSettings(input.action, input.operation, input.organizations?.[i] as SettingsSnapshot),
      );
    }
    if (configLast) failedObject = { kind: "config" };
    const output = {
      schema: 1,
      config: configLast ? await readConfig() : result,
      installations: input.installations,
      organizations,
    };
    failedObject = { kind: "transfer" };
    if (new TextEncoder().encode(JSON.stringify(output)).length > 2 * 1024 * 1024)
      throw new Error("reset settings exceed the transfer limit");
    return Response.json(output);
  } catch (error) {
    const captured = captureException(error);
    // Settings errors can carry credentials or private rows. Retain bounded
    // cause metadata and correlation, never remote prose or transfer bodies.
    const causeOf = (exception: typeof captured): object => ({
      name: ["TypeError", "RangeError", "SyntaxError"].includes(exception.name) ? exception.name : "Error",
      ...(exception.remote !== undefined ? { remote: exception.remote } : {}),
      ...(exception.retryable !== undefined ? { retryable: exception.retryable } : {}),
      ...(exception.overloaded !== undefined ? { overloaded: exception.overloaded } : {}),
      ...(exception.cause ? { cause: causeOf(exception.cause) } : {}),
    });
    console.error(
      JSON.stringify({
        event: "installation.reset.settings.failure",
        operation: input.operation ?? null,
        action,
        object: failedObject,
        exception: causeOf(captured),
      }),
    );
    return Response.json(
      { code: "reset_settings_held", error: "reset settings refused or unverified; inspect the original operation" },
      { status: 409 },
    );
  }
}
