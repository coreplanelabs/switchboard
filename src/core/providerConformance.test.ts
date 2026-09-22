import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildProviderMatrix,
  providerGaps,
  providerRowVerdict,
  PROVIDER_BLOCKS,
  PROVIDER_CONTROLS,
  PROVIDER_DRIVERS,
  PROVIDER_ROWS,
  renderProviderMatrix,
  type ProviderScenarioRow,
} from "./testing/providerConformance.js";
import {
  classifyProviderFailure,
  PROVIDER_FAILURE_CAUSES,
  renderProviderFailure,
  WIRES,
  type ProviderFailureCause,
} from "./provider.js";

// Feature: docs/reference/specs/model-proxy.md item 11 — the card and the
// block's declaration, and its matrix (record 0052): controls × outcomes
// as rows over pi and OpenCode as drivers, each cell scripted against the
// card, the lint naming a wire, an example-config block or a control with no
// row, the printer the pull request carries.

const EXAMPLE_BLOCKS = ["anthropic", "openai", "openrouter"];

// Feature: docs/reference/specs/model-proxy.md item 12b — every model call
// classifies a provider answer through one closed ProviderFailure seam.
const FAILURE_MATRIX: ReadonlyArray<{
  cause: ProviderFailureCause;
  status?: number;
  body?: unknown;
  error?: unknown;
  operatorUrl?: string;
}> = [
  { cause: "transient", status: 503, body: { error: { type: "overloaded_error", message: "overloaded" } } },
  { cause: "rate-limited", status: 429, body: { error: { code: "rate_limit_exceeded" } } },
  {
    cause: "credit-or-quota-exhausted",
    status: 402,
    body: {
      message:
        "This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 12789. To increase, visit https://openrouter.ai/workspaces/default/keys/key-test and adjust the key's total limit",
      code: 402,
      metadata: { limit_source: "openrouter_key_limit" },
    },
    operatorUrl: "https://openrouter.ai/workspaces/default/keys/key-test",
  },
  { cause: "key-absent", status: 503, body: { error: { type: "provider_key_missing" } } },
  { cause: "key-invalid", status: 401, body: { error: { type: "authentication_error" } } },
  { cause: "model-unknown", status: 404, body: { error: { code: "model_not_found" } } },
  { cause: "permanent", status: 400, body: { error: { type: "invalid_request_error" } } },
];

describe("ProviderFailure — the closed failure matrix", () => {
  it.each(FAILURE_MATRIX)(
    "classifies $cause from status and structured answer",
    ({ cause, operatorUrl, ...answer }) => {
      expect(classifyProviderFailure(answer)).toMatchObject({
        cause,
        ...(operatorUrl !== undefined ? { operatorUrl } : {}),
      });
    },
  );

  it("has one matrix row per closed cause", () => {
    expect(FAILURE_MATRIX.map((row) => row.cause)).toEqual(PROVIDER_FAILURE_CAUSES);
  });

  it("renders every typed cause as one calm sentence with no payload, provider URL or instruction", () => {
    for (const cause of PROVIDER_FAILURE_CAUSES) {
      const sentence = renderProviderFailure(cause);
      expect(sentence.match(/[.!?](?:\s|$)/g)).toHaveLength(1);
      expect(sentence).not.toMatch(/[{}]|https?:\/\/|code\"\s*:|message\"\s*:|metadata/i);
      expect(sentence).not.toMatch(/\b(?:retry|re-send|visit|increase|contact|run)\b/i);
    }
  });
});

describe.each(PROVIDER_DRIVERS.map((d) => [d.harness, d] as const))("provider conformance — %s", (_name, driver) => {
  for (const row of PROVIDER_ROWS) {
    const declared = driver.cannot?.[row.id] ?? row.needsHarnessWrite;
    if (declared === undefined) {
      it(`${row.control}: ${row.title}`, () => {
        expect(providerRowVerdict(driver, row).outcome).toBe("pass");
      });
    } else {
      it(`${row.control}: ${row.title} — declared cannot (${declared})`, () => {
        expect(providerRowVerdict(driver, row).outcome).toBe("cannot");
      });
    }
  }
});

describe("the provider table", () => {
  it("every row id is unique and every control has a row", () => {
    expect(new Set(PROVIDER_ROWS.map((r) => r.id)).size).toBe(PROVIDER_ROWS.length);
    for (const control of PROVIDER_CONTROLS)
      expect(
        PROVIDER_ROWS.some((r) => r.control === control),
        control,
      ).toBe(true);
  });

  it("the lint is empty for the full table and names the wire, the block or the control a row set dropped", () => {
    const full = { wires: WIRES, blocks: EXAMPLE_BLOCKS, controls: PROVIDER_CONTROLS };
    expect(providerGaps(PROVIDER_ROWS, full, PROVIDER_BLOCKS)).toEqual([]);

    const withoutWire = PROVIDER_ROWS.filter((r) => !r.ref.startsWith("openai/"));
    expect(providerGaps(withoutWire, full, PROVIDER_BLOCKS)).toEqual(["wire openai-responses", "block openai"]);

    const withoutBlock = PROVIDER_ROWS.filter((r) => !r.ref.startsWith("anthropic/"));
    expect(providerGaps(withoutBlock, full, PROVIDER_BLOCKS)).toContain("block anthropic");

    const withoutControl = PROVIDER_ROWS.filter((r) => r.control !== "inputs");
    expect(providerGaps(withoutControl, full, PROVIDER_BLOCKS)).toEqual(["control inputs"]);
  });

  it("a row that reads no decision fails rather than passing silently", () => {
    const row: ProviderScenarioRow = {
      id: "reads-nothing",
      control: "effort",
      title: "a row with no asked control",
      ref: "anthropic/claude-opus-4-6",
      asked: {},
      expect: { outcome: "native" },
    };
    expect(providerRowVerdict(PROVIDER_DRIVERS[0]!, row).outcome).toBe("fail");
  });

  it("the printer renders a column per driver and the declared cannot reasons", () => {
    const matrix = renderProviderMatrix(buildProviderMatrix(PROVIDER_DRIVERS, PROVIDER_ROWS), PROVIDER_ROWS);
    expect(matrix).toContain("| Control | Row | pi | opencode |");
    expect(matrix).toContain("trace-12-effort-refused");
    // The harness-write rows are green on both drivers since the card reaches
    // the harnesses (U39) — the aggregator marker row too, riding OpenRouter's
    // top-level `cache_control` through `settings.extraBody` (U44); the one
    // declared cannot left is the unmeasured Responses provider (U42's
    // dispatch refusal).
    expect(matrix).not.toContain("cannot `harness-write-effort-map`");
    expect(matrix).not.toContain("cannot `harness-write-cap-field`");
    expect(matrix).not.toContain("cannot `harness-write-cache-markers`");
    expect(matrix).toContain("✖ opencode cannot `openai-responses-cap`");
  });

  // Feature: docs/reference/specs/model-proxy.md item 11 — one parser for a ref.
  it("the grammar: no by-hand split of a model ref survives outside parseModelRef and vendorOf", () => {
    const root = new URL("../../", import.meta.url).pathname;
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          const text = readFileSync(path, "utf8");
          if (/indexOf\((["'])\/(["'])\)/.test(text)) hits.push(path.slice(root.length));
        }
      }
    };
    walk(join(root, "src"));
    expect(hits).toEqual(["src/core/provider.ts"]);
  });
});
