import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "./config.js";
import { ALL_GRANTS } from "./core/authz/grants.js";
import { NO_GRANTS, type Grants } from "./core/authz/types.js";
import { chatCallerFor } from "./core/commandChat.js";
import { bindCommands, CommandRegistry, type CommandInvoker } from "./core/commandRegistry.js";
import { coreCommandGroups } from "./core/commands/all.js";
import { registerConfigCommands, type ConfigCommandDeps } from "./core/commands/config.js";
import type { IngressTokenMap } from "./core/ingressTokens.js";

// Feature: features/authorization.md item 9 — production runs on the native
// `grants` shape (authz U7 step 1, #452). This is the differential proof for
// the shipped file: every production actor resolves to the grants captured
// below, which are the grants the SAME actors held under the legacy
// `permissions` block the file carried before. The goldens are literals on
// purpose — a new agent or command group changes what an unlisted Slack user
// or browser session holds in prod, and that is a change to acknowledge here,
// not to inherit silently.

const PROD_CONFIG = fileURLToPath(new URL("../config/config.production.yaml", import.meta.url));

/** The ingress token map's SHAPE, as the shim uses it: the `cron` entry is the
 *  only token the bot's schedules fire with (src/core/schedules.ts
 *  CRON_IDENTITY). The real map is a Worker secret no test can read, so its
 *  `channel` / `scopes` are assumed here; neither matters for `http:cron`,
 *  whose native `grants` entry REPLACES the token's translation whole. */
const INGRESS_TOKENS: IngressTokenMap = { "not-a-real-token": { subject: "cron", channel: "cron", scopes: ["dispatch"] } };

const set = (...names: string[]) => new Set(names);
const grants = (g: Partial<Grants>): Grants => ({ actions: set(), channels: set(), repos: set(), ...g });

/** The fleet's actors and what each holds in production. */
const ADMIN = "slack:U0BMRFRLT1P";
const OPS_TOKEN = "access:svc:b4a6ef75a577c499ca50844d1a85a67d.access";
const SCHEDULED_RUN = grants({ actions: set("friction:read", "friction:write", "repo:write"), channels: "all" });
const GOLDEN: Record<string, Grants> = {
  [ADMIN]: ALL_GRANTS,
  "http:cron": SCHEDULED_RUN,
  "schedule:self-improvement": SCHEDULED_RUN,
  [OPS_TOKEN]: grants({ actions: set("runs:read", "friction:read", "repo:read", "memory:read", "schedule:read", "config:read", "help:read", "deploy:read"), channels: "all" }),
  // An unlisted Slack user: the open chat commands and every registered agent — never `config:write` (channel config is admins only), never a run read.
  "slack:U_OTHER": grants({ actions: set("help:read", "config:read", "repo:read", "friction:read", "memory:read", "mcp:read", "schedule:read", "memory:write", "mcp:write", "agent:run:general", "agent:run:coding", "agent:run:review", "agent:run:ship", "agent:run:research") }),
  // An unlisted Access browser session: every registered group's read, no channel (a private-channel run is `not_found`).
  "access:someone@coreplane.ai": grants({ actions: set("config:read", "deploy:read", "env:read", "friction:read", "help:read", "mcp:read", "memory:read", "repo:read", "runs:read", "schedule:read") }),
  // The same token over MCP is the token map's translation, untouched by the file.
  "mcp:cron": grants({ actions: set("dispatch"), channels: set("mcp:cron") }),
};

function openProd(): { store: ConfigStore; warnings: string[] } {
  const warnings: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "swb-prod-config-"));
  const store = new ConfigStore(PROD_CONFIG, join(dir, "overrides.json"), (m) => warnings.push(m), { ingressTokens: INGRESS_TOKENS, commandGroups: coreCommandGroups() });
  return { store, warnings };
}

describe("config/config.production.yaml — native grants, one shape (authorization.md item 9, #452 step 1)", () => {
  it("carries no legacy `permissions` block and loads without a dual-shape warning", () => {
    const { store, warnings } = openProd();
    expect(warnings).toEqual([]);
    expect(store.config.permissions).toBeUndefined();
    expect(Object.keys(store.config.grants ?? {}).sort()).toEqual([ADMIN, OPS_TOKEN, "http:cron", "schedule:self-improvement"].sort());
  });

  it("every production actor resolves to exactly the grants it held under the legacy block", () => {
    const { store } = openProd();
    for (const [id, expected] of Object.entries(GOLDEN)) expect(store.grantsFor(id), id).toEqual(expected);
    // A credential nothing names holds nothing (R7) — the very object, not a lookalike.
    expect(store.grantsFor("http:other")).toBe(NO_GRANTS);
    expect(store.grantsFor("access:svc:unlisted")).toBe(NO_GRANTS);
  });

  it("the helpers that used to read `permissions.*` answer from the grants: who to ask, who manages repos, who edits channel config", () => {
    const { store } = openProd();
    expect(store.adminsHint()).toBe(`<@${ADMIN}>`);
    expect([store.canManageRepos(ADMIN), store.canManageRepos("slack:U_OTHER")]).toEqual([true, false]);
    expect([store.canEditChannelConfig(ADMIN), store.canEditChannelConfig("slack:U_OTHER")]).toEqual([true, false]);
    // No agent is restricted in prod: every Slack user may run every agent (the goldens above say the same as grants).
    expect(store.canRunAgent("slack:U_OTHER", "coding")).toBe(true);
  });

  it("`config set channel` stays admins only end to end: the chat adapter's actor for an unlisted user is refused, the admin's is served", async () => {
    const { store } = openProd();
    const commands = bindConfigCommands(store);
    const other = chatCallerFor({ userId: "slack:U_OTHER", channelId: "slack:C_ANY", threadKey: "slack:C_ANY:1.0" }, store);
    expect(await commands.invoke("config.set", { args: ["channel"], options: { agent: "review" } }, other)).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "handler", message: "Channel config changes are restricted." });
    expect(store.scopes("slack:C_ANY", "slack:U_OTHER").channel).toEqual({});
    // A person always has their own scope.
    expect((await commands.invoke("config.set", { args: ["me"], options: { agent: "review" } }, other)).ok).toBe(true);
    const admin = chatCallerFor({ userId: ADMIN, channelId: "slack:C_ANY", threadKey: "slack:C_ANY:1.0" }, store);
    expect((await commands.invoke("config.set", { args: ["channel"], options: { agent: "review" } }, admin)).ok).toBe(true);
    expect(store.scopes("slack:C_ANY", ADMIN).channel).toEqual({ agent: "review" });
  });
});

function bindConfigCommands(config: ConfigStore): CommandInvoker {
  const registry = new CommandRegistry<ConfigCommandDeps>({ audit: () => {} });
  registerConfigCommands(registry);
  return bindCommands(registry, {
    config: {
      describeConfig: async (c, u) => config.describeConfig(c, u),
      scopes: async (c, u) => config.scopes(c, u),
      setChannelOverride: (c, p) => config.setChannelOverride(c, p),
      setUserOverride: (u, p) => config.setUserOverride(u, p),
      clearChannelOverride: (c) => config.clearChannelOverride(c),
      clearUserOverride: (u) => config.clearUserOverride(u),
      agentNames: () => ["general", "coding", "review", "ship", "research"],
    },
  });
}
