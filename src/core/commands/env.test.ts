import { describe, expect, it } from "vitest";
import { DEFAULT_MANIFEST_PATH } from "../../agentEnv/bootstrap.js";
import { CommandRegistry, bindCommands, renderText, type Caller } from "../commandRegistry.js";
import { callerWith } from "../testing/callers.js";
import { parseInvocation } from "../commandSurface.js";
import { envBootstrap, registerEnvCommands, type EnvCommandDeps } from "./env.js";

// Feature: docs/reference/specs/agent-env-bootstrap.md / docs/reference/specs/command-registry.md (phase
// 4b): `env bootstrap` — the former `agent-env-bootstrap` script as a CLI-only
// registry command. The host half (op read, the 600 file) is injected; the
// command owns the option grammar, the log lines, and never lets a value out.

const cli: Caller = callerWith("cli", "cli:local", "all");

function bind() {
  const registry = new CommandRegistry<EnvCommandDeps>({ audit: () => {} });
  registerEnvCommands(registry);
  const calls: Array<Parameters<EnvCommandDeps["env"]["bootstrap"]>[0]> = [];
  const commands = bindCommands(registry, {
    env: {
      bootstrap: async (opts, log) => {
        calls.push(opts);
        if (opts.env !== "uat") throw new Error(`env "${opts.env}" is not allowed (UAT only)`);
        log(`PLAN (${opts.apply ? "apply" : "dry-run"}) env=${opts.env} service=${opts.service}`);
        log("  DATABASE_URL <- op://uat/db/url");
        return {
          applied: opts.apply,
          entries: [
            {
              env: opts.env,
              service: opts.service,
              name: "DATABASE_URL",
              ref: "op://uat/db/url",
              vault: "uat",
              item: "db",
              field: "url",
            },
          ],
          ...(opts.apply ? { envMap: { DATABASE_URL: "s3cret-value" } } : {}),
        };
      },
    },
  });
  return { commands, calls };
}

describe("env.bootstrap", () => {
  it("--env and --service are required; --apply/--out/--manifest are optional and reach the host half with the manifest default", async () => {
    const { commands, calls } = bind();
    expect(parseInvocation(commands.get("env.bootstrap")!, ["--service", "api"])).toMatchObject({ kind: "invoke" });
    expect(await commands.invoke("env.bootstrap", { options: { service: "api" } }, cli)).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: "env: expected string",
    });
    expect(await commands.invoke("env.bootstrap", { options: { env: "uat" } }, cli)).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: "service: expected string",
    });
    const dry = await commands.invoke("env.bootstrap", { options: { env: "uat", service: "api" } }, cli);
    expect(dry.ok).toBe(true);
    expect(calls[0]).toEqual({ env: "uat", service: "api", apply: false, manifest: DEFAULT_MANIFEST_PATH });
    const bound = parseInvocation(commands.get("env.bootstrap")!, [
      "--env",
      "uat",
      "--service",
      "api",
      "--apply",
      "--out",
      "x.env",
      "--manifest",
      "m.jsonc",
    ]);
    await commands.invoke("env.bootstrap", bound.kind === "invoke" ? bound.input : {}, cli);
    expect(calls[1]).toEqual({ env: "uat", service: "api", apply: true, out: "x.env", manifest: "m.jsonc" });
  });

  it("the output is the plan lines + entries (names and refs) — never a resolved value; the text is the log", async () => {
    const { commands } = bind();
    const res = await commands.invoke("env.bootstrap", { options: { env: "uat", service: "api", apply: "true" } }, cli);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.value).toEqual({
      applied: true,
      entries: [{ name: "DATABASE_URL", ref: "op://uat/db/url" }],
      lines: ["PLAN (apply) env=uat service=api", "  DATABASE_URL <- op://uat/db/url"],
    });
    expect(JSON.stringify(res.value)).not.toContain("s3cret");
    expect(renderText(commands.get("env.bootstrap")!, res.value)).toBe(
      "PLAN (apply) env=uat service=api\n  DATABASE_URL <- op://uat/db/url",
    );
  });

  it("a refused env, a missing token, an unreadable manifest — anything the host half throws — is `unavailable` with its text", async () => {
    const { commands } = bind();
    expect(await commands.invoke("env.bootstrap", { options: { env: "prod", service: "api" } }, cli)).toMatchObject({
      ok: false,
      error: "unavailable",
      message: 'env "prod" is not allowed (UAT only)',
    });
  });

  it("is CLI-only and operator-gated: absent from chat, MCP, and HTTP", async () => {
    const { commands } = bind();
    expect(envBootstrap).toMatchObject({
      action: "env:write",
      effect: "write",
      surfaces: { chat: false, mcp: false, http: false },
    });
    expect(
      await commands.invoke(
        "env.bootstrap",
        { options: { env: "uat", service: "api" } },
        callerWith("chat", "slack:U", "all"),
      ),
    ).toMatchObject({ ok: false, error: "not_found" });
    expect(
      await commands.invoke(
        "env.bootstrap",
        { options: { env: "uat", service: "api" } },
        callerWith("mcp", "mcp:a", ["env:write"]),
      ),
    ).toMatchObject({ ok: false, error: "not_found" });
  });
});
