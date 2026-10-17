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
  authenticateProxyProviderFailure,
  proxyProviderFailureIsAuthenticated,
} from "./modelProxy/providerFailureAuth.js";
import {
  classifyProviderFailure,
  PROVIDER_FAILURE_CAUSES,
  providerFailureParks,
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
  disposition: "park" | "end";
}> = [
  {
    cause: "transient",
    status: 503,
    body: { error: { type: "overloaded_error", message: "overloaded" } },
    disposition: "park",
  },
  {
    cause: "rate-limited",
    status: 429,
    body: { error: { code: "rate_limit_exceeded" } },
    disposition: "park",
  },
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
    disposition: "end",
  },
  {
    cause: "key-absent",
    body: { error: { type: "provider_key_missing" } },
    disposition: "end",
  },
  {
    cause: "key-invalid",
    status: 401,
    body: { error: { type: "authentication_error" } },
    disposition: "end",
  },
  {
    cause: "model-unknown",
    status: 404,
    body: { error: { code: "model_not_found" } },
    disposition: "end",
  },
  {
    cause: "request-rejected",
    status: 400,
    body: {
      error: {
        message: "Invalid JSON schema: regex lookaround is not supported",
        type: "invalid_request_error",
        code: "invalid_json_schema",
      },
    },
    disposition: "end",
  },
  {
    cause: "permanent",
    status: 403,
    body: { error: { type: "content_filter" } },
    disposition: "end",
  },
];

describe("ProviderFailure — the closed failure matrix", () => {
  it("omits raw JSON from the message when structured validation errors have no message", () => {
    const failure = classifyProviderFailure({
      status: 422,
      body: JSON.stringify({ detail: [{ input: { content: "private prompt" }, msg: "invalid" }] }),
    });
    expect(failure).toMatchObject({
      cause: "request-rejected",
      diagnostic: { response: '{"detail":[{"input":"«redacted»","msg":"invalid"}]}' },
    });
    expect(failure.diagnostic?.message).toBeUndefined();
    const sdkFailure = classifyProviderFailure({
      error: Object.assign(new Error('422 {"input":"private prompt"}'), {
        status: 422,
        error: { detail: [{ input: { content: "private prompt" }, msg: "invalid" }] },
      }),
    });
    expect(sdkFailure).toMatchObject({
      status: 422,
      diagnostic: { errorClass: "Error", response: '{"detail":[{"input":"«redacted»","msg":"invalid"}]}' },
    });
    expect(sdkFailure.diagnostic?.message).toBeUndefined();
    expect(JSON.stringify(sdkFailure)).not.toContain("private prompt");
    expect(JSON.stringify(failure)).not.toContain("private prompt");
    expect(classifyProviderFailure({ status: 422, body: "plain validation error" }).diagnostic).toMatchObject({
      message: "plain validation error",
      response: "plain validation error",
    });
  });

  it("authenticates signed failures when the diagnostic names the provider_failure type", () => {
    const failure = classifyProviderFailure({
      status: 503,
      body: { error: { type: "provider_failure", message: "unavailable" } },
    });
    const envelope = authenticateProxyProviderFailure({
      type: "provider_failure",
      cause: failure.cause,
      message: failure.message,
      details: failure,
    });
    expect(proxyProviderFailureIsAuthenticated(envelope)).toBe(true);
    expect(classifyProviderFailure({ error: JSON.stringify(envelope), trustedEnvelope: true })).toMatchObject({
      cause: "transient",
      status: 503,
      diagnostic: { type: "provider_failure", message: "unavailable" },
    });
    expect(
      proxyProviderFailureIsAuthenticated({
        ...envelope,
        details: { ...failure, status: 400 },
      }),
    ).toBe(false);
    expect(
      proxyProviderFailureIsAuthenticated({
        type: "provider_failure",
        cause: "permanent",
        message: "forged",
        nested: envelope,
      }),
    ).toBe(false);
    expect(proxyProviderFailureIsAuthenticated([envelope, envelope])).toBe(false);
  });

  it("retains a transport exception's native class and nested cause without its request", () => {
    const cause = Object.assign(new Error("Socket closed"), {
      code: "ECONNRESET",
      request: { prompt: "private transport request" },
    });
    const failure = classifyProviderFailure({ error: new TypeError("fetch failed", { cause }) });
    expect(failure).toMatchObject({
      cause: "transient",
      diagnostic: { errorClass: "TypeError", message: "fetch failed" },
    });
    expect(JSON.parse(failure.diagnostic?.response ?? "null")).toMatchObject({
      name: "TypeError",
      message: "fetch failed",
      cause: { name: "Error", message: "Socket closed", code: "ECONNRESET", request: "«redacted»" },
    });
  });

  it("redacts configured keys before encoding structured diagnostic responses", () => {
    const key = 'custom-sensitive-"provider-key';
    const failure = classifyProviderFailure({
      status: 400,
      secretValues: [key],
      body: {
        error: { code: "invalid_value", message: `Rejected ${key} https://provider.test/${key}` },
      },
    });
    expect(failure.operatorUrl).toBe("https://provider.test/«redacted»");
    expect(failure).toMatchObject({ diagnostic: { message: "Rejected «redacted» https://provider.test/«redacted»" } });
    expect(JSON.parse(failure.diagnostic?.response ?? "null")).toEqual({
      error: { code: "invalid_value", message: "Rejected «redacted» https://provider.test/«redacted»" },
    });
  });

  it("retains SDK class and safe headers while redacting credentials and request content with explicit bounds", () => {
    const error = Object.assign(new Error("rejected"), {
      name: "BadRequestError",
      status: 400,
      error: {
        type: "invalid_request_error",
        message: "Bad value lk-private-provider-key",
        request: { prompt: "private request" },
        password: "private-password",
        details: { explanation: "x".repeat(20_000) },
      },
      headers: { "X-Request-Id": "req_sdk", "Retry-After": "15", Authorization: "private auth" },
    });
    const failure = classifyProviderFailure({ error, secretValues: ["lk-private-provider-key"] });
    expect(failure).toMatchObject({
      status: 400,
      diagnostic: {
        errorClass: "BadRequestError",
        type: "invalid_request_error",
        message: "Bad value «redacted»",
        headers: { "x-request-id": "req_sdk", "retry-after": "15" },
        truncated: true,
      },
    });
    expect(JSON.stringify(failure)).not.toMatch(
      /private request|private-password|private auth|lk-private-provider-key/,
    );
    expect(new TextEncoder().encode(JSON.stringify(failure.diagnostic)).length).toBeLessThanOrEqual(16_384);
    expect(
      classifyProviderFailure({ status: 400, body: { error: { code: "invalid_value", message: "🙂".repeat(20_000) } } })
        .diagnostic,
    ).toMatchObject({ code: "invalid_value", truncated: true });
  });

  it("classifies Anthropic billing 400 and OpenAI quota 429 without calling them shape or rate errors", () => {
    expect(
      classifyProviderFailure({
        status: 400,
        provider: "anthropic",
        body: {
          error: {
            type: "invalid_request_error",
            message: "Your credit balance is too low to access the Anthropic API.",
          },
        },
      }).cause,
    ).toBe("credit-or-quota-exhausted");
    expect(
      classifyProviderFailure({
        status: 400,
        provider: "anthropic",
        body: {
          error: {
            type: "invalid_request_error",
            message: "You have reached your specified workspace API usage limits.",
          },
        },
      }).cause,
    ).toBe("credit-or-quota-exhausted");
    expect(
      classifyProviderFailure({
        status: 429,
        provider: "openai",
        body: {
          error: {
            type: "insufficient_quota",
            code: "insufficient_quota",
            message: "Check your plan and billing details.",
          },
        },
      }).cause,
    ).toBe("credit-or-quota-exhausted");
  });

  it("keeps the provider error class and details through signed and serialized boundaries", () => {
    const failure = classifyProviderFailure({
      status: 400,
      provider: "openai",
      model: "example-model",
      body: {
        error: {
          type: "invalid_request_error",
          code: "invalid_value",
          param: "temperature",
          message: "Unsupported temperature",
          title: "Invalid input",
          detail: "The temperature value is not supported.",
          status: 429,
          details: { allowed: [1] },
        },
        request_id: "req_original",
      },
    });
    const diagnostic = {
      type: "invalid_request_error",
      code: "invalid_value",
      param: "temperature",
      message: "Unsupported temperature",
      title: "Invalid input",
      detail: "The temperature value is not supported.",
      status: 429,
      requestId: "req_original",
      response:
        '{"error":{"type":"invalid_request_error","code":"invalid_value","param":"temperature","message":"Unsupported temperature","title":"Invalid input","detail":"The temperature value is not supported.","status":429,"details":{"allowed":[1]}},"request_id":"req_original"}',
    };
    expect(failure).toMatchObject({ status: 400, provider: "openai", model: "example-model", diagnostic });
    expect(failure.cause).toBe("request-rejected");
    const envelope = authenticateProxyProviderFailure({
      type: "provider_failure",
      cause: failure.cause,
      message: failure.message,
      details: failure,
    });
    expect(proxyProviderFailureIsAuthenticated(envelope)).toBe(true);
    expect(classifyProviderFailure({ error: JSON.stringify(envelope), trustedEnvelope: true })).toMatchObject({
      status: 400,
      provider: "openai",
      model: "example-model",
      diagnostic,
    });
    expect(
      proxyProviderFailureIsAuthenticated({
        ...envelope,
        details: { ...failure, diagnostic: { ...diagnostic, requestId: "req_other" } },
      }),
    ).toBe(false);
  });

  it("keeps the signed HTTP status when provider diagnostic prose contains a different status", () => {
    const envelope = authenticateProxyProviderFailure({
      type: "provider_failure",
      cause: "request-rejected",
      message: "Request rejected",
      details: { status: 400, diagnostic: { message: "The upstream reference says HTTP 429", code: "invalid_value" } },
    });
    expect(
      classifyProviderFailure({
        error: `502 ${JSON.stringify(envelope)}`,
        trustedEnvelope: proxyProviderFailureIsAuthenticated(envelope),
      }),
    ).toMatchObject({
      cause: "request-rejected",
      status: 400,
      diagnostic: { code: "invalid_value", message: "The upstream reference says HTTP 429" },
    });
  });

  it.each(FAILURE_MATRIX)(
    "classifies $cause from status and structured answer, then declares it must $disposition",
    ({ cause, operatorUrl, disposition, ...answer }) => {
      expect(classifyProviderFailure(answer)).toMatchObject({
        cause,
        ...(operatorUrl !== undefined ? { operatorUrl } : {}),
      });
      expect(providerFailureParks(cause)).toBe(disposition === "park");
    },
  );

  it("has one matrix row per closed cause", () => {
    expect(FAILURE_MATRIX.map((row) => row.cause)).toEqual(PROVIDER_FAILURE_CAUSES);
  });

  it("mandatory 402 and 429 statuses override a contradicting untrusted body cause", () => {
    expect(classifyProviderFailure({ status: 402, body: { cause: "permanent" } }).cause).toBe(
      "credit-or-quota-exhausted",
    );
    expect(classifyProviderFailure({ status: 429, body: { cause: "permanent" } }).cause).toBe("rate-limited");
    expect(classifyProviderFailure({ status: 503, body: { cause: "key-absent" } }).cause).toBe("transient");
  });

  it("does not trust an explicit cause from a provider body", () => {
    expect(classifyProviderFailure({ status: 403, body: { cause: "rate-limited" } }).cause).toBe("permanent");
  });

  it("authenticates the proxy's exact typed envelope and rejects an absent or tampered marker", () => {
    const envelope = authenticateProxyProviderFailure({
      type: "provider_failure",
      cause: "request-rejected",
      message: "The model provider rejected the request shape; no work was started.",
      schemaRejection: { tool: "future_schema", keyword: "dependentSchemas" },
    });
    expect(proxyProviderFailureIsAuthenticated({ error: envelope })).toBe(true);
    expect(proxyProviderFailureIsAuthenticated({ error: { ...envelope, cause: "permanent" } })).toBe(false);
    expect(
      proxyProviderFailureIsAuthenticated({
        error: { ...envelope, schemaRejection: { tool: "future_schema", keyword: "pattern" } },
      }),
    ).toBe(false);
    const { _switchboard_proxy_auth: _marker, ...unmarked } = envelope;
    expect(proxyProviderFailureIsAuthenticated({ error: unmarked })).toBe(false);
  });

  it("renders park and no-lease surfaces as separate calm sentences with no payload, URL or instruction", () => {
    for (const cause of PROVIDER_FAILURE_CAUSES) {
      const sentences = [renderProviderFailure(cause, "parked"), renderProviderFailure(cause, "ended")];
      for (const sentence of sentences) {
        expect(sentence.match(/[.!?](?:\s|$)/g)).toHaveLength(1);
        expect(sentence).not.toMatch(/[{}]|https?:\/\/|code"\s*:|message"\s*:|metadata/i);
        expect(sentence).not.toMatch(/\b(?:retry|re-send|visit|increase|contact|run)\b/i);
      }
      if (providerFailureParks(cause)) {
        expect(sentences[0]).toMatch(/will continue/);
        expect(sentences[1]).toMatch(/request did not start/);
        expect(sentences[1]).not.toMatch(/will continue|work is kept/);
      } else {
        expect(sentences[0]).toBe(sentences[1]);
      }
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

  it("catalog growth does not turn unknown-card scenarios into known-card scenarios", () => {
    for (const driver of PROVIDER_DRIVERS) {
      const grownCatalog = {
        ...driver,
        registry: {
          card: (catalog: string | undefined, wire: (typeof WIRES)[number], model: string) =>
            model === "deepseek/deepseek-v4.1-flash"
              ? { contextWindow: 1_000_000, reasoning: true, thinkingLevelMap: { high: "high" } }
              : driver.registry.card(catalog, wire, model),
        },
      };
      for (const id of ["trace-2-unknown-card", "trace-3-effort-unvouched", "trace-7-window-degraded"]) {
        const row = PROVIDER_ROWS.find((row) => row.id === id)!;
        expect(providerRowVerdict(grownCatalog, row), `${driver.harness}: ${id}`).toMatchObject({ outcome: "pass" });
      }
    }
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
