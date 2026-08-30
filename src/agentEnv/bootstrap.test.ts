import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_ENVS,
  assertAllowedEnv,
  buildAgentEnv,
  buildPlan,
  parseManifest,
  parseOpRef,
  renderEnvFile,
  runBootstrap,
  stripJsonc,
  type AgentEnvManifest,
  type BootstrapDeps,
  type EnvSink,
  type OpReader,
} from "./bootstrap.js";

// Feature: features/agent-env-bootstrap.md — materialize a DOWNSTREAM service's
// UAT environment variables into the agent's execution environment, resolved
// from 1Password via a READ-ONLY, UAT-vault-scoped service account. UAT-only by
// an env-name allowlist (never prod), dry-run shows NAMES + op:// refs (never
// values), apply resolves each ref and writes a chmod-600 env file the
// toolchain sources, missing token fails closed.

const MANIFEST: AgentEnvManifest = {
  uat: {
    billing: {
      DATABASE_URL: "op://Downstream UAT/billing/database-url",
      STRIPE_API_KEY: "op://Downstream UAT/billing/stripe-key",
    },
    checkout: {
      REDIS_URL: "op://Downstream UAT/checkout/redis-url",
    },
  },
};

function mockDeps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps & {
  logs: string[];
  reader: OpReader & { read: ReturnType<typeof vi.fn> };
  sink: EnvSink & { writeEnvFile: ReturnType<typeof vi.fn> };
} {
  const logs: string[] = [];
  const reader = { read: vi.fn(async (ref: string) => `VALUE::${ref}`) };
  const sink = { writeEnvFile: vi.fn(async () => {}) };
  const deps: BootstrapDeps = {
    manifest: MANIFEST,
    env: { OP_SERVICE_ACCOUNT_TOKEN: "ops_test-token" },
    opReader: reader,
    sink,
    log: (line) => logs.push(line),
    ...overrides,
  };
  return Object.assign(deps, { logs, reader, sink });
}

// ---------------------------------------------------------------------------
// JSONC parsing — string-aware so op:// (which contains //) survives.
// ---------------------------------------------------------------------------

describe("stripJsonc", () => {
  it("preserves op:// (with its //) inside string values", () => {
    const src = '{ "K": "op://Vault/Item/field" }';
    expect(JSON.parse(stripJsonc(src))).toEqual({ K: "op://Vault/Item/field" });
  });

  it("strips line comments outside strings but not the op:// inside them", () => {
    const src = `{
      // a comment about the database url
      "DATABASE_URL": "op://V/billing/db" // trailing note
    }`;
    expect(JSON.parse(stripJsonc(src))).toEqual({ DATABASE_URL: "op://V/billing/db" });
  });

  it("strips block comments and trailing commas", () => {
    const src = `{
      /* block */ "A": "op://V/a/f",
      "B": "op://V/b/f",
    }`;
    expect(JSON.parse(stripJsonc(src))).toEqual({ A: "op://V/a/f", B: "op://V/b/f" });
  });
});

describe("parseManifest", () => {
  it("parses a JSONC manifest with comments into env -> service -> NAME -> ref", () => {
    const m = parseManifest(`{
      // UAT only
      "uat": { "billing": { "DATABASE_URL": "op://V/i/f" } }
    }`);
    expect(m.uat.billing.DATABASE_URL).toBe("op://V/i/f");
  });

  it("throws on malformed JSON", () => {
    expect(() => parseManifest("{ not json")).toThrow(/not valid JSONC/);
  });

  it("throws when a ref is not a string", () => {
    expect(() => parseManifest('{ "uat": { "billing": { "DATABASE_URL": 5 } } }')).toThrow(
      /must be a string op:\/\/ ref/,
    );
  });

  it("throws when a service is not an object", () => {
    expect(() => parseManifest('{ "uat": { "billing": "op://V/i/f" } }')).toThrow(/must be an object/);
  });

  it("throws on an invalid env var name", () => {
    expect(() => parseManifest('{ "uat": { "svc": { "BAD NAME": "op://v/i/f" } } }')).toThrow(
      /not a valid env var name/,
    );
    expect(() => parseManifest('{ "uat": { "svc": { "1BAD": "op://v/i/f" } } }')).toThrow(/not a valid env var name/);
    expect(() => parseManifest('{ "uat": { "svc": { "X;rm": "op://v/i/f" } } }')).toThrow(/not a valid env var name/);
  });

  it("accepts valid env var names", () => {
    expect(() =>
      parseManifest('{ "uat": { "svc": { "API_TOKEN": "op://v/i/f", "_x": "op://v/i/f", "A1_B2": "op://v/i/f" } } }'),
    ).not.toThrow();
  });
});

describe("parseOpRef", () => {
  it("splits vault/item/field", () => {
    expect(parseOpRef("op://My Vault/my-item/my-field")).toEqual({
      vault: "My Vault",
      item: "my-item",
      field: "my-field",
    });
  });

  it("folds a trailing section path into field", () => {
    expect(parseOpRef("op://V/item/section/field")).toEqual({ vault: "V", item: "item", field: "section/field" });
  });

  it("rejects a non-op ref and a too-short ref", () => {
    expect(() => parseOpRef("https://example.com")).toThrow(/must start with op:\/\//);
    expect(() => parseOpRef("op://V/only-item")).toThrow(/malformed op:\/\//);
  });
});

// ---------------------------------------------------------------------------
// env-name allowlist — the UAT-only guard.
// ---------------------------------------------------------------------------

describe("assertAllowedEnv — UAT-only allowlist", () => {
  it("permits uat", () => {
    expect(ALLOWED_ENVS).toContain("uat");
    expect(() => assertAllowedEnv("uat")).not.toThrow();
  });

  it("refuses prod", () => {
    expect(() => assertAllowedEnv("prod")).toThrow(/REFUSING env "prod"/);
  });

  it("refuses any non-allowlisted env or alias (staging, production, uat-alias)", () => {
    expect(() => assertAllowedEnv("staging")).toThrow(/REFUSING env "staging"/);
    expect(() => assertAllowedEnv("production")).toThrow(/REFUSING env "production"/);
    expect(() => assertAllowedEnv("prod-uat")).toThrow(/REFUSING env "prod-uat"/);
  });
});

describe("buildPlan", () => {
  it("builds one entry per var for the selected env+service, only from that section", () => {
    const plan = buildPlan(MANIFEST, { env: "uat", service: "billing" });
    expect(plan.map((e) => e.name)).toEqual(["DATABASE_URL", "STRIPE_API_KEY"]);
    expect(plan.every((e) => e.vault === "Downstream UAT")).toBe(true);
    // the other service's var is never in the plan
    expect(plan.some((e) => e.name === "REDIS_URL")).toBe(false);
  });

  it("refuses a non-uat env (allowlist enforced in the plan, before any resolve)", () => {
    expect(() => buildPlan({ prod: { billing: { X: "op://V/i/f" } } }, { env: "prod", service: "billing" })).toThrow(
      /REFUSING env "prod"/,
    );
  });

  it("throws on an unknown service", () => {
    expect(() => buildPlan(MANIFEST, { env: "uat", service: "nope" })).toThrow(/no vars for uat\.nope/);
  });

  it("throws when the env section is missing entirely", () => {
    expect(() => buildPlan({} as AgentEnvManifest, { env: "uat", service: "billing" })).toThrow(
      /manifest has no "uat" section/,
    );
  });
});

// ---------------------------------------------------------------------------
// env-file rendering — sourceable, shell-safe, never invents values.
// ---------------------------------------------------------------------------

describe("renderEnvFile", () => {
  it("emits `export NAME='value'` lines that survive sourcing", () => {
    const text = renderEnvFile({ DATABASE_URL: "postgres://u:p@h/db", API: "a b'c" }, { env: "uat", service: "billing" });
    expect(text).toContain("export DATABASE_URL='postgres://u:p@h/db'");
    // single quotes inside a value are escaped so `source` keeps them intact
    expect(text).toContain(`export API='a b'\\''c'`);
  });

  it("carries a do-not-commit header naming the env+service", () => {
    const text = renderEnvFile({ A: "1" }, { env: "uat", service: "billing" });
    expect(text).toMatch(/uat/);
    expect(text).toMatch(/billing/);
    expect(text.toLowerCase()).toMatch(/do not commit|chmod 600/);
  });
});

// ---------------------------------------------------------------------------
// runBootstrap — dry-run (the default).
// ---------------------------------------------------------------------------

describe("runBootstrap — dry-run", () => {
  it("prints NAMES + refs, and calls neither the resolver nor the sink", async () => {
    const deps = mockDeps();
    const res = await runBootstrap(
      { env: "uat", service: "billing", apply: false, outFile: "/tmp/x.env" },
      deps,
    );

    expect(res.applied).toBe(false);
    expect(deps.reader.read).not.toHaveBeenCalled();
    expect(deps.sink.writeEnvFile).not.toHaveBeenCalled();

    const text = deps.logs.join("\n");
    expect(text).toContain("DRY RUN");
    expect(text).toContain("DATABASE_URL");
    expect(text).toContain("op://Downstream UAT/billing/database-url");
    // no resolved value ever appears
    expect(text).not.toContain("VALUE::");
  });
});

// ---------------------------------------------------------------------------
// runBootstrap — apply.
// ---------------------------------------------------------------------------

describe("runBootstrap — apply", () => {
  it("resolves each var once and writes the env file exactly once, mode 600", async () => {
    const deps = mockDeps();
    const res = await runBootstrap(
      { env: "uat", service: "billing", apply: true, outFile: "/secure/billing.uat.env" },
      deps,
    );

    expect(res.applied).toBe(true);
    expect(deps.reader.read).toHaveBeenCalledTimes(2);
    expect(deps.reader.read).toHaveBeenCalledWith("op://Downstream UAT/billing/database-url");
    expect(deps.reader.read).toHaveBeenCalledWith("op://Downstream UAT/billing/stripe-key");

    expect(deps.sink.writeEnvFile).toHaveBeenCalledTimes(1);
    const call = deps.sink.writeEnvFile.mock.calls[0][0];
    expect(call.path).toBe("/secure/billing.uat.env");
    expect(call.mode).toBe(0o600);
    // resolved values live ONLY in the file contents handed to the sink
    expect(call.contents).toContain("VALUE::op://Downstream UAT/billing/database-url");

    // returns the env map (the integration-hook payload)
    expect(res.envMap).toEqual({
      DATABASE_URL: "VALUE::op://Downstream UAT/billing/database-url",
      STRIPE_API_KEY: "VALUE::op://Downstream UAT/billing/stripe-key",
    });
  });

  it("NEVER logs a resolved value on apply", async () => {
    const deps = mockDeps();
    await runBootstrap({ env: "uat", service: "billing", apply: true, outFile: "/secure/x.env" }, deps);
    const text = deps.logs.join("\n");
    expect(text).not.toContain("VALUE::");
    // it still reports what it did — names/counts/path only
    expect(text).toContain("DATABASE_URL");
    expect(text).toContain("/secure/x.env");
  });

  it("fails closed when OP_SERVICE_ACCOUNT_TOKEN is unset — before any resolve or write", async () => {
    const deps = mockDeps({ env: {} });
    await expect(
      runBootstrap({ env: "uat", service: "billing", apply: true, outFile: "/secure/x.env" }, deps),
    ).rejects.toThrow(/OP_SERVICE_ACCOUNT_TOKEN is not set/);
    expect(deps.reader.read).not.toHaveBeenCalled();
    expect(deps.sink.writeEnvFile).not.toHaveBeenCalled();
  });

  it("refuses apply for a non-uat env before resolving or writing", async () => {
    const deps = mockDeps({ manifest: { prod: { billing: { X: "op://V/i/f" } } } });
    await expect(
      runBootstrap({ env: "prod", service: "billing", apply: true, outFile: "/secure/x.env" }, deps),
    ).rejects.toThrow(/REFUSING env "prod"/);
    expect(deps.reader.read).not.toHaveBeenCalled();
    expect(deps.sink.writeEnvFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildAgentEnv — the integration hook (returns the env map, writes nothing).
// ---------------------------------------------------------------------------

describe("buildAgentEnv — integration hook", () => {
  it("returns the resolved downstream UAT env map for injection into the sandbox env", async () => {
    const reader = { read: vi.fn(async (ref: string) => `V::${ref}`) };
    const map = await buildAgentEnv({
      manifest: MANIFEST,
      env: "uat",
      service: "checkout",
      opReader: reader,
      processEnv: { OP_SERVICE_ACCOUNT_TOKEN: "ops_test" },
    });
    expect(map).toEqual({ REDIS_URL: "V::op://Downstream UAT/checkout/redis-url" });
    expect(reader.read).toHaveBeenCalledTimes(1);
  });

  it("enforces the UAT-only allowlist", async () => {
    const reader = { read: vi.fn(async () => "x") };
    await expect(
      buildAgentEnv({
        manifest: { prod: { checkout: { X: "op://V/i/f" } } },
        env: "prod",
        service: "checkout",
        opReader: reader,
        processEnv: { OP_SERVICE_ACCOUNT_TOKEN: "ops_test" },
      }),
    ).rejects.toThrow(/REFUSING env "prod"/);
    expect(reader.read).not.toHaveBeenCalled();
  });

  it("fails closed with no service-account token", async () => {
    const reader = { read: vi.fn(async () => "x") };
    await expect(
      buildAgentEnv({ manifest: MANIFEST, env: "uat", service: "checkout", opReader: reader, processEnv: {} }),
    ).rejects.toThrow(/OP_SERVICE_ACCOUNT_TOKEN is not set/);
    expect(reader.read).not.toHaveBeenCalled();
  });
});
