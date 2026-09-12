import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The ship coordinator's Workflow (docs/reference/specs/http-ingress.md item 9)
// lives in coordinator.ts, not in the shim's entry — and the Workflows binding
// resolves its class by name on the entry module (`class_name` in
// wrangler.template.jsonc), so the entry must re-export it. This scan over the
// sources holds that boundary, and the coordinator's credential boundary: the
// class may see the container binding and the token map and nothing else the
// shim holds for the container. Plain Node, like the resident's refresh.test.ts:
// worker.ts is read as text, never loaded.

const read = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");

/** The class the binding names, read from the template so the test follows a rename. */
function boundClassName(): string {
  const m = /"workflows":\s*\[[^\]]*"class_name":\s*"([A-Za-z_$][\w$]*)"/.exec(read("wrangler.template.jsonc"));
  if (!m) throw new Error("wrangler.template.jsonc declares no workflows binding");
  return m[1];
}

/** Every secret the shim forwards into the container that the coordinator must never name. */
const CREDENTIALS = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GH_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_ID",
  "MEMORY_TOKEN",
  "SANDBOX_TOKEN",
  "RESIDENT_OPERATOR_TOKEN",
  "RESIDENT_ADMIN_TOKEN",
  "DASHBOARD_TOKEN",
  "CF_ANALYTICS_TOKEN",
  "ANTHROPIC_ADMIN_KEY",
  "MCP_CREDENTIAL_KEY",
  "BRAVE_SEARCH_API_KEY",
  "E2B_API_KEY",
];

describe("the coordinator module — the Workflow entrypoint leaves worker.ts, which re-exports it for the binding", () => {
  const name = boundClassName();
  it("the binding is same-script (no script_name) under the shim's own name", () => {
    const block = /"workflows":\s*\[([^\]]*)\]/.exec(read("wrangler.template.jsonc"))![1];
    expect(block).toContain('"binding": "SHIP_COORDINATOR"');
    expect(block).not.toContain("script_name");
  });
  it("worker.ts declares no class by the binding's name", () => {
    expect(read("worker.ts")).not.toMatch(new RegExp(`\\bclass ${name}\\b`));
  });
  it("coordinator.ts declares it as the exported WorkflowEntrypoint over the narrowed env", () => {
    expect(read("coordinator.ts")).toMatch(
      new RegExp(`^export class ${name} extends WorkflowEntrypoint<CoordinatorEnv,`, "m"),
    );
    expect(read("coordinator.ts")).toMatch(
      /^export type CoordinatorEnv = Pick<Env, "SWITCHBOARD" \| "SWITCHBOARD_INGRESS_TOKENS">;/m,
    );
  });
  it("worker.ts re-exports it under the binding's class_name", () => {
    expect(read("worker.ts")).toMatch(new RegExp(`^export \\{[^}]*\\b${name}\\b[^}]*\\} from "\\./coordinator";`, "m"));
  });
  it("coordinator.ts imports worker.ts type-only — the split is not a cycle", () => {
    for (const statement of read("coordinator.ts").match(/^import[^;]*from "\.\/worker";/gm) ?? []) {
      expect(statement).toMatch(/^import type\b/);
    }
  });
});

describe("the coordinator holds no credential", () => {
  const source = read("coordinator.ts");
  it("names none of the secrets the shim forwards into the container, and makes no fetch of its own", () => {
    for (const name of CREDENTIALS) expect(source, name).not.toContain(name);
    expect(source).not.toMatch(/\bfetch\(/);
  });
});

describe("the state Worker's template binds this class across scripts", () => {
  it("names the same class and the same Workflow name pattern as the shim's own binding, by the bot's script", () => {
    const memory = readFileSync(
      fileURLToPath(new URL("../cloudflare-memory/wrangler.template.jsonc", import.meta.url)),
      "utf8",
    );
    const block = /"workflows":\s*\[([^\]]*)\]/.exec(memory)?.[1] ?? "";
    expect(block).toContain('"binding": "SHIP_COORDINATOR"');
    expect(block).toContain(`"class_name": "${boundClassName()}"`);
    expect(block).toContain('"script_name": "{{bot.script}}"');
    expect(block).toContain('"name": "{{bot.script}}-ship-coordinator"');
    // The shim names its Workflow `{{script}}-ship-coordinator` under its own script — the same name once rendered.
    expect(read("wrangler.template.jsonc")).toContain('"name": "{{script}}-ship-coordinator"');
  });
});
