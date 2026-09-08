import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { parseAccessConfig, parseAccessDevBypass } from "../channels/accessAuth.js";
import { parseMcpSettings } from "../mcp/config.js";
import { ALL_CAPABILITIES, capabilitiesFrom, NO_CAPABILITIES, type Capabilities } from "./capabilities.js";
import { buildRunLedger } from "./runLedgerWorker.js";
import { buildRunStore } from "./runStore.js";
import { buildScheduleStore } from "./scheduleStore.js";

// Feature: features/routing-and-config.md item 16 — one Capabilities value,
// computed once from the config and the environment. Every axis is exercised
// with the config/env that turns it on and off, and each axis that mirrors a
// builder's selection is pinned to that builder so the two rules cannot drift.

const BASE: AppConfig = {
  organization: "acme",
  providers: { anthropic: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" } },
  defaults: { agent: "general", models: { general: "anthropic/m" } },
};

const STATE = { baseUrl: "https://state.example" };
const COSTS = { cloudflareAccountId: "acct", groups: { sb: { workers: ["switchboard"] } } };

const caps = (config: Partial<AppConfig> = {}, env: NodeJS.ProcessEnv = {}): Capabilities =>
  capabilitiesFrom({ ...BASE, ...config }, env);

describe("capabilitiesFrom — every axis, on and off", () => {
  it("a bare config in an empty environment is the minimal installation: everything off, tools on the bot host, the dashboards fail-closed", () => {
    expect(caps()).toEqual(NO_CAPABILITIES);
  });

  it("execution follows execution.type; local when unset", () => {
    expect(caps().execution).toBe("local");
    expect(caps({ execution: { type: "e2b" } }).execution).toBe("e2b");
    expect(caps({ execution: { type: "cloudflare", url: "https://sb.example" } }).execution).toBe("cloudflare");
  });

  it("residents: the resident Worker's base URL is configured (the admin bearer is the commands' own concern)", () => {
    expect(caps({ execution: { resident: { baseUrl: "https://res.example" } } }).residents).toBe(true);
    expect(caps({ execution: { type: "cloudflare" } }).residents).toBe(false);
    expect(caps({ execution: { resident: { baseUrl: "  " } } }).residents).toBe(false);
  });

  it("memory: memory.enabled is true — a block with enabled false is off", () => {
    expect(caps({ memory: { enabled: true } }).memory).toBe(true);
    expect(caps({ memory: { enabled: false } }).memory).toBe(false);
  });

  it("runHistory / runLedger mirror buildRunStore / buildRunLedger: a file store is history without a ledger; a Worker store needs its bearer and carries a ledger; a token env can be renamed", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "swb-caps-"));
    // No real sweep timer for the file store the pin creates.
    const deps = { dataDir, warn: () => {}, setInterval: (() => 0) as unknown as typeof setInterval };
    const cases: Array<{ runHistory: AppConfig["runHistory"]; env: NodeJS.ProcessEnv }> = [
      { runHistory: undefined, env: {} },
      { runHistory: { store: "file" }, env: {} },
      { runHistory: { worker: STATE }, env: {} },
      { runHistory: { worker: STATE }, env: { MEMORY_TOKEN: "t" } },
      { runHistory: { worker: { ...STATE, tokenEnv: "RUNS_TOKEN" } }, env: { MEMORY_TOKEN: "t" } },
      { runHistory: { worker: { ...STATE, tokenEnv: "RUNS_TOKEN" } }, env: { RUNS_TOKEN: "t" } },
      { runHistory: { store: "worker" }, env: { MEMORY_TOKEN: "t" } },
    ];
    for (const c of cases) {
      const got = caps({ runHistory: c.runHistory }, c.env);
      const label = JSON.stringify(c);
      expect(got.runHistory, label).toBe(buildRunStore(c.runHistory, c.env, deps) !== null);
      expect(got.runLedger, label).toBe(buildRunLedger(c.runHistory, c.env) !== null);
    }
    expect(caps({ runHistory: { store: "file" } })).toMatchObject({ runHistory: true, runLedger: false });
    expect(caps({ runHistory: { worker: STATE } }, { MEMORY_TOKEN: "t" })).toMatchObject({
      runHistory: true,
      runLedger: true,
    });
  });

  it("mcp mirrors parseMcpSettings: an `mcp` block (even empty) is on; absent is off; a malformed block throws like startup does", () => {
    for (const mcp of [undefined, {}, { credentialKeyEnv: "K" }]) {
      expect(caps({ mcp }).mcp, JSON.stringify(mcp)).toBe(parseMcpSettings(mcp) !== undefined);
    }
    expect(caps({ mcp: {} }).mcp).toBe(true);
    expect(() => caps({ mcp: { servers: [] } })).toThrow(/mcp\.servers moved/);
  });

  it("costs: a costs block AND its Cloudflare token (the default env or the named one); a malformed block throws", () => {
    expect(caps({ costs: COSTS }).costs).toBe(false);
    expect(caps({ costs: COSTS }, { CF_ANALYTICS_TOKEN: "t" }).costs).toBe(true);
    expect(caps({ costs: { ...COSTS, cloudflareTokenEnv: "CF_T" } }, { CF_ANALYTICS_TOKEN: "t" }).costs).toBe(false);
    expect(caps({ costs: { ...COSTS, cloudflareTokenEnv: "CF_T" } }, { CF_T: "t" }).costs).toBe(true);
    expect(() => caps({ costs: { groups: {} } })).toThrow(/cloudflareAccountId/);
  });

  it("schedules mirrors buildScheduleStore: the firing store's URL and its bearer", () => {
    const cases: Array<{ schedules: AppConfig["schedules"]; env: NodeJS.ProcessEnv }> = [
      { schedules: undefined, env: {} },
      { schedules: { worker: STATE }, env: {} },
      { schedules: { worker: STATE }, env: { MEMORY_TOKEN: "t" } },
      { schedules: { worker: { ...STATE, tokenEnv: "S_TOKEN" } }, env: { MEMORY_TOKEN: "t" } },
      { schedules: { worker: { ...STATE, tokenEnv: "S_TOKEN" } }, env: { S_TOKEN: "t" } },
    ];
    for (const c of cases) {
      expect(caps({ schedules: c.schedules }, c.env).schedules, JSON.stringify(c)).toBe(
        buildScheduleStore(c.schedules, c.env, () => {}) !== undefined,
      );
    }
    expect(caps({ schedules: { worker: STATE } }, { MEMORY_TOKEN: "t" }).schedules).toBe(true);
  });

  it("github: the App triple, or the static GH_TOKEN; two of three App vars is nothing", () => {
    const app = { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "pem", GITHUB_APP_INSTALLATION_ID: "2" };
    expect(caps({}, app).github).toBe(true);
    expect(caps({}, { GH_TOKEN: "ghp" }).github).toBe(true);
    expect(caps({}, { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "pem" }).github).toBe(false);
    expect(caps({}, { GH_TOKEN: "" }).github).toBe(false);
  });

  it("ingress: at least one bearer in SWITCHBOARD_INGRESS_TOKENS; an empty map or malformed JSON is off", () => {
    expect(caps({}, { SWITCHBOARD_INGRESS_TOKENS: JSON.stringify({ tok: { subject: "ci" } }) }).ingress).toBe(true);
    expect(caps({}, { SWITCHBOARD_INGRESS_TOKENS: "{}" }).ingress).toBe(false);
    expect(caps({}, { SWITCHBOARD_INGRESS_TOKENS: "not json" }).ingress).toBe(false);
    expect(caps({}, {}).ingress).toBe(false);
  });

  it("dashboardAuth mirrors the Access gate: `access` when parseAccessConfig answers, `none` under the dev bypass, `token` (fail-closed pages) otherwise; Access wins over a stray bypass", () => {
    const access = { ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64) };
    const envs: NodeJS.ProcessEnv[] = [
      {},
      access,
      { ACCESS_DEV_BYPASS: "1" },
      { ACCESS_DEV_BYPASS: "true" },
      { ACCESS_DEV_BYPASS: "yes" },
      { ...access, ACCESS_DEV_BYPASS: "1" },
      { ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com" },
    ];
    for (const env of envs) {
      const expected = parseAccessConfig(env) ? "access" : parseAccessDevBypass(env) ? "none" : "token";
      expect(caps({}, env).dashboardAuth, JSON.stringify(env)).toBe(expected);
    }
    expect(caps({}, access).dashboardAuth).toBe("access");
    expect(caps({}, { ACCESS_DEV_BYPASS: "1" }).dashboardAuth).toBe("none");
    expect(caps({}, {}).dashboardAuth).toBe("token");
  });

  it("docs: DOCS_BASE_URL names this installation's docs site", () => {
    expect(caps({}, { DOCS_BASE_URL: "https://docs.example" }).docs).toBe(true);
    expect(caps({}, { DOCS_BASE_URL: "" }).docs).toBe(false);
  });

  it("the full configuration reaches ALL_CAPABILITIES — the two fixtures are real states, not shapes", () => {
    const full = caps(
      {
        execution: { type: "cloudflare", url: "https://sb.example", resident: { baseUrl: "https://res.example" } },
        memory: { enabled: true },
        runHistory: { worker: STATE },
        schedules: { worker: STATE },
        mcp: {},
        costs: COSTS,
      },
      {
        MEMORY_TOKEN: "t",
        CF_ANALYTICS_TOKEN: "t",
        GH_TOKEN: "ghp",
        SWITCHBOARD_INGRESS_TOKENS: JSON.stringify({ tok: { subject: "ci" } }),
        ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com",
        ACCESS_AUD: "a".repeat(64),
        DOCS_BASE_URL: "https://docs.example",
      },
    );
    expect(full).toEqual(ALL_CAPABILITIES);
    expect(Object.keys(full).sort()).toEqual(Object.keys(NO_CAPABILITIES).sort());
  });
});
