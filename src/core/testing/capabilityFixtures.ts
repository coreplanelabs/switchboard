import { ALL_CAPABILITIES, NO_CAPABILITIES, type Capabilities } from "../capabilities.js";

// Three installations, as configurations (features/capabilities.md item 4):
// the config.yaml and the environment that PRODUCE each `Capabilities` value
// through `capabilitiesFrom`, plus the value itself. The capability suite
// (`src/core/capabilitySurfaces.test.ts`) asserts the round trip — so a
// fixture here is a real shape an operator can copy, never a hand-typed set
// of flags that could drift from the rules in src/core/capabilities.ts — and
// then snapshots every surface under each one.
//
// Hostnames are under `example.test` like `TEST_PROFILE`'s; the env values
// are placeholders whose only property is being non-empty.

export type CapabilityFixtureName = "minimal" | "local-full" | "cloud-full";

export interface CapabilityFixture {
  name: CapabilityFixtureName;
  /** What this shape is, in one line — for the matrix docs and the suite's titles. */
  summary: string;
  /** A complete config.yaml. */
  yaml: string;
  /** The process environment the config's `*Env` names point at, plus the env-only switches. */
  env: Readonly<Record<string, string>>;
  /** What `capabilitiesFrom(yaml, env)` must compute. */
  capabilities: Readonly<Capabilities>;
}

/** Slack plus one provider — the three required blocks and nothing else. */
const BASE_YAML = `organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
`;

const STATE_WORKER = "https://switchboard-memory.example.test";

export const MINIMAL: CapabilityFixture = {
  name: "minimal",
  summary: "Slack and one provider; tools run on the bot host; nothing optional configured.",
  yaml: `${BASE_YAML}execution:
  type: local
`,
  env: {
    // No Access configured and no `dashboard` block → dashboard auth `none`:
    // the dashboards for loopback callers of this localhost deployment only.
    ANTHROPIC_API_KEY: "sk-ant-placeholder",
  },
  capabilities: NO_CAPABILITIES,
};

export const LOCAL_FULL: CapabilityFixture = {
  name: "local-full",
  summary:
    "Everything a laptop can turn on: memory (in-process), run history on disk, GitHub via a personal token, MCP servers, bearer ingress, a local docs site. No Workers, so no residents, costs, schedules or ledger.",
  yaml: `${BASE_YAML}execution:
  type: local
memory:
  enabled: true
runHistory:
  store: file
  retentionDays: 7
mcp:
  credentialKeyEnv: MCP_CREDENTIAL_KEY
`,
  env: {
    ANTHROPIC_API_KEY: "sk-ant-placeholder",
    GH_TOKEN: "ghp_placeholder",
    MCP_CREDENTIAL_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    SWITCHBOARD_INGRESS_TOKENS: JSON.stringify({ "local-token": { subject: "local" } }),
    DOCS_BASE_URL: "http://localhost:5173",
  },
  capabilities: {
    execution: "local",
    residents: false,
    memory: true,
    runHistory: true,
    runLedger: false,
    mcp: true,
    costs: false,
    schedules: false,
    github: true,
    ingress: true,
    dashboardAuth: "none",
    docs: true,
  },
};

export const CLOUD_FULL: CapabilityFixture = {
  name: "cloud-full",
  summary:
    "Everything on: the four Workers, tools in a Cloudflare sandbox, resident repos, memory, run history and the ledger on the state Worker, MCP, costs, schedules, the GitHub App, bearer ingress, Access in front of the dashboards, a docs site.",
  yaml: `${BASE_YAML}execution:
  type: cloudflare
  url: https://switchboard-sandbox.example.test
  apiKeyEnv: SANDBOX_TOKEN
  resident:
    baseUrl: https://switchboard-resident.example.test
memory:
  enabled: true
  worker:
    baseUrl: ${STATE_WORKER}
runHistory:
  retentionDays: 30
  worker:
    baseUrl: ${STATE_WORKER}
runtimeOverrides:
  worker:
    baseUrl: ${STATE_WORKER}
schedules:
  worker:
    baseUrl: ${STATE_WORKER}
mcp:
  credentialKeyEnv: MCP_CREDENTIAL_KEY
costs:
  cloudflareAccountId: acct-fixture
  cloudflareTokenEnv: CF_ANALYTICS_TOKEN
  groups:
    switchboard:
      label: Switchboard
      workers: [switchboard, switchboard-memory, switchboard-resident, switchboard-sandbox]
`,
  env: {
    ANTHROPIC_API_KEY: "sk-ant-placeholder",
    SANDBOX_TOKEN: "sandbox-placeholder",
    RESIDENT_OPERATOR_TOKEN: "resident-operator-placeholder",
    RESIDENT_ADMIN_TOKEN: "resident-admin-placeholder",
    MEMORY_TOKEN: "memory-placeholder",
    MCP_CREDENTIAL_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    CF_ANALYTICS_TOKEN: "cf-analytics-placeholder",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nplaceholder\n-----END RSA PRIVATE KEY-----",
    GITHUB_APP_INSTALLATION_ID: "67890",
    SWITCHBOARD_INGRESS_TOKENS: JSON.stringify({ "ci-token": { subject: "ci" }, "cron-token": { subject: "cron" } }),
    ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64),
    DOCS_BASE_URL: "https://docs.switchboard.example.test",
  },
  capabilities: ALL_CAPABILITIES,
};

export const CAPABILITY_FIXTURES: readonly CapabilityFixture[] = [MINIMAL, LOCAL_FULL, CLOUD_FULL];
