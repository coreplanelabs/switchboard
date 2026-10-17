import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigStore } from "../../config.js";
import { secretsFrom } from "../../secrets.js";
import { bindCommands, CommandRegistry } from "../commandRegistry.js";
import { registerCoreCommands, type CoreCommandDeps } from "../commands/all.js";
import { PiAiProviders } from "../harness/piAi.js";
import { shapeToolSchemasForWire } from "../providerToolSchemas.js";
import type { IncomingMessage } from "../types.js";
import {
  OPERATOR_ASK_REPO_TOOL,
  OPERATOR_READ_TOOLS,
  OPERATOR_BATCH_TOOL,
  operatorMaxOutputTokens,
  operatorPresets,
  operatorProjection,
  operatorStage,
  operatorTools,
} from "./operator.js";
import { routableCommands } from "./route.js";
import { operatorSettingsEvidence } from "../testing/operatorSettings.js";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const rejectsLookaround = (pattern: string): boolean => /\(\?(?:[=!]|<[=!])/.test(pattern);

function lookaroundPatterns(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) lookaroundPatterns(item, into);
    return into;
  }
  if (typeof value !== "object" || value === null) return into;
  for (const [key, item] of Object.entries(value)) {
    if (key === "pattern" && typeof item === "string" && rejectsLookaround(item)) into.push(item);
    lookaroundPatterns(item, into);
  }
  return into;
}

/** A credential-free reconstruction of the measured Responses rejection. It
 * proves the formerly emitted payload trips this local validator, not that an
 * upstream service returned this response. */
function validateResponsesPayload(body: Record<string, unknown>): Response {
  const rejected = lookaroundPatterns(body.tools);
  if (rejected.length > 0) {
    return new Response(
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          code: "invalid_json_schema",
          message: "the credential-free test validator rejects Responses tool-schema lookaround",
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(bindReviewStream(), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function bindReviewStream(
  arguments_: Record<string, unknown> = {
    preset: "review",
    repo: "acme/api",
    prTarget: { number: 7, source: "request", quote: "https://github.com/acme/api/pull/7" },
    reason: "the request names a pull request",
    settingsEvidence: operatorSettingsEvidence(),
  },
): string {
  const input = JSON.stringify(arguments_);
  const call = {
    id: "fc_bind_review",
    type: "function_call",
    call_id: "call_bind_review",
    name: "bind_preset",
    arguments: input,
    status: "completed",
  };
  const events = [
    { type: "response.created", response: { id: "resp_operator", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: input },
    { type: "response.output_item.done", output_index: 0, item: call },
    {
      type: "response.completed",
      response: {
        id: "resp_operator",
        status: "completed",
        output: [call],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      },
    },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function configStore(dsl = false): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-operator-responses-"));
  const path = join(dir, "config.yaml");
  writeFileSync(
    path,
    `${dsl ? "extends: builtin\nprofiles:\n  standard: { model: openai/work, modelSettings: { reasoning: { effort: low } } }\n  review: { model: openai/work }\n  light: { model: openai/front-door, modelSettings: { reasoning: { effort: high } } }\n" : ""}organization: acme
providers:
  openai:
    wire: openai-responses
    baseUrl: https://api.openai.invalid/v1
    models:
      gpt-5.6-sol:
        capField: max_output_tokens
      front-door:
        capField: max_output_tokens
        levels: { high: high }
${
  dsl
    ? ""
    : `defaults:
  agent: general
  models:
    general: openai/gpt-5.6-sol
  efforts:
    general: high
`
}
`,
  );
  return new ConfigStore(path, join(dir, "overrides.json"));
}

function fullCatalogue() {
  const registry = new CommandRegistry<CoreCommandDeps>({ audit: () => {} });
  registerCoreCommands(registry);
  const commands = bindCommands(registry, {} as CoreCommandDeps);
  const presets = operatorPresets();
  const tools = operatorTools({
    text: "review https://github.com/acme/api/pull/7",
    tail: [],
    projection: operatorProjection({
      presets,
      commands: routableCommands(commands),
      allowedPresets: presets.map((preset) => preset.name),
    }),
  });
  return { commands, tools };
}

describe("the direct operator on the Responses wire", () => {
  it("repairs a missing formal model without changing the requested review", async () => {
    const target = { number: 7, source: "request", quote: "https://github.com/acme/api/pull/7" };
    const missing = {
      preset: "review",
      repo: "acme/api",
      prTarget: target,
      effort: "high",
      reason: "Review the requested pull request.",
      settingsEvidence: operatorSettingsEvidence({ effort: { intent: "requested", quote: "effort:high" } }),
    };
    const supplied = { ...missing, model: "openai/gpt-5.6-sol" };
    const replies = [missing, supplied];
    const calls: Record<string, unknown>[] = [];
    const config = configStore();
    const completions = new PiAiProviders(config.config.providers, {
      secrets: secretsFrom({}),
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        const reply = replies.shift();
        if (!reply) throw new Error("Unexpected additional operator model call");
        return new Response(bindReviewStream(reply), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const { commands } = fullCatalogue();
    const result = await operatorStage(
      { config, completions, commands },
      {
        msg: {
          channelId: "slack:CX",
          userId: "slack:UX",
          text: "agent:review model:openai/gpt-5.6-sol effort:high Review https://github.com/acme/api/pull/7",
          threadKey: "slack:CX:1.0",
        },
        mode: "on",
      },
    );
    const violation = "the authored formal model needs its typed model field; preserve the requested model";
    expect(result).toMatchObject({
      outcome: "binds",
      binds: [{ preset: "review", repo: "acme/api", prTarget: target, model: "openai/gpt-5.6-sol", effort: "high" }],
      attempts: [{ outcome: "violation", violation }, { outcome: "accepted" }],
    });
    expect(calls).toHaveLength(2);
    const bind = (calls[0]!.tools as { name: string; parameters: Record<string, unknown> }[]).find(
      (tool) => tool.name === "bind_preset",
    )!;
    const schema = z.fromJSONSchema(bind.parameters);
    expect(schema.safeParse(missing).success).toBe(false);
    expect(schema.parse(supplied)).toEqual(supplied);
    expect(JSON.stringify(calls[1]!.input)).toContain(violation);
  });

  it.each([
    {
      evidence: { intent: "default", quote: "including nits" },
      violation:
        "settingsEvidence.severity.intent must be requested, incidental or unrequested; keep the requested action and controls",
    },
    {
      evidence: { intent: "requested" },
      violation:
        "settingsEvidence.severity.quote must be nonempty text for requested or incidental intent; copy the exact request text",
    },
    {
      evidence: { intent: "requested", quote: "all actionable findings including nits" },
      violation:
        "settingsEvidence.severity.quote is not an exact authored phrase; copy one contiguous span from the current request",
    },
  ])(
    "repairs the specific severity evidence failure without changing the review: $evidence",
    async ({ evidence, violation }) => {
      const target = { number: 7, source: "request", quote: "https://github.com/acme/api/pull/7" };
      const request =
        "agent:review model:openai/gpt-5.6-sol effort:high review-head:1111111111111111111111111111111111111111\nReview https://github.com/acme/api/pull/7. Return all actionable findings, including nits.";
      const valid = {
        preset: "review",
        repo: "acme/api",
        prTarget: target,
        model: "openai/gpt-5.6-sol",
        effort: "high",
        severity: "nit",
        reason: "Review the requested pull request with all findings.",
        settingsEvidence: operatorSettingsEvidence({
          effort: { intent: "requested", quote: "effort:high" },
          severity: { intent: "requested", quote: "including nits" },
        }),
      };
      const replies = [{ ...valid, settingsEvidence: { ...valid.settingsEvidence, severity: evidence } }, valid];
      const calls: Record<string, unknown>[] = [];
      const config = configStore();
      const completions = new PiAiProviders(config.config.providers, {
        secrets: secretsFrom({}),
        fetch: async (_url, init) => {
          calls.push(JSON.parse(String(init?.body)));
          const reply = replies.shift();
          if (!reply) throw new Error("Unexpected additional operator model call");
          return new Response(bindReviewStream(reply), { headers: { "content-type": "text/event-stream" } });
        },
      });
      const { commands } = fullCatalogue();
      const result = await operatorStage(
        { config, completions, commands },
        {
          msg: { channelId: "slack:CX", userId: "slack:UX", text: request, threadKey: "slack:CX:1.0" },
          mode: "on",
        },
      );
      expect(result).toMatchObject({
        outcome: "binds",
        binds: [
          {
            preset: "review",
            repo: "acme/api",
            prTarget: target,
            model: "openai/gpt-5.6-sol",
            effort: "high",
            severity: "nit",
          },
        ],
        attempts: [{ outcome: "violation", violation }, { outcome: "accepted" }],
      });
      expect(calls).toHaveLength(2);
      expect(calls.map((call) => call.parallel_tool_calls)).toEqual([false, false]);
      expect(calls.map((call) => call.tool_choice)).toEqual([undefined, undefined]);
      expect(JSON.stringify(calls[1]!.input)).toContain(violation);
    },
  );

  it("repairs an omitted control assessment through the actual Responses wire before starting Ship review", async () => {
    const target = { number: 7, source: "request", quote: "https://github.com/acme/api/pull/7" };
    const replies = [
      {
        preset: "review",
        repo: "acme/api",
        prTarget: target,
        reason: "Review the specified pull request and provide high-quality findings.",
      },
      {
        preset: "ship",
        shipEntry: "review",
        repo: "acme/api",
        prTarget: target,
        renewals: 2,
        settingsEvidence: operatorSettingsEvidence({ renewals: { intent: "requested", quote: "two renewals" } }),
        reason: "Review the exact PR with the requested renewals.",
      },
    ];
    const calls: Record<string, unknown>[] = [];
    const config = configStore();
    const completions = new PiAiProviders(config.config.providers, {
      secrets: secretsFrom({}),
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        const reply = replies.shift();
        if (!reply) throw new Error("Unexpected additional operator model call");
        return new Response(bindReviewStream(reply), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const { commands } = fullCatalogue();
    const result = await operatorStage(
      { config, completions, commands },
      {
        msg: {
          channelId: "slack:CX",
          userId: "slack:UX",
          text: "Review https://github.com/acme/api/pull/7 with two renewals.",
          threadKey: "slack:CX:1.0",
        },
        mode: "on",
      },
    );
    expect(result).toMatchObject({
      outcome: "binds",
      binds: [{ preset: "ship", shipEntry: "review", repo: "acme/api", prTarget: target, renewals: 2 }],
      attempts: [
        { outcome: "violation", violation: expect.stringContaining("settingsEvidence") },
        { outcome: "accepted" },
      ],
    });
    expect(calls).toHaveLength(2);
    const bind = (
      calls[0]!.tools as Array<{
        name: string;
        parameters: { required: string[]; properties: { settingsEvidence: { required: string[] } } };
      }>
    ).find((tool) => tool.name === "bind_preset")!;
    expect(bind.parameters.required).toContain("settingsEvidence");
    expect(bind.parameters.properties.settingsEvidence.required).toEqual([
      "effort",
      "budget",
      "severity",
      "renewals",
      "verbosity",
    ]);
    expect(JSON.stringify(bind.parameters.properties.settingsEvidence)).toContain('"unrequested"');
    expect(JSON.stringify(calls[1]!.input)).toContain("settingsEvidence");
    expect(calls.every((call) => call.model === "gpt-5.6-sol")).toBe(true);
  });
  it("uses the independent operator profile on the actual Responses request", async () => {
    const calls: Record<string, unknown>[] = [];
    const config = configStore(true);
    const completions = new PiAiProviders(config.config.providers, {
      secrets: secretsFrom({}),
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return new Response(bindReviewStream(), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const { commands } = fullCatalogue();
    const msg: IncomingMessage = {
      channelId: "slack:CX",
      userId: "slack:UX",
      userName: "UX",
      text: "review https://github.com/acme/api/pull/7",
      threadKey: "slack:CX:1.0",
    };
    await operatorStage({ config, completions, commands }, { msg, mode: "on" });
    expect(calls[0]).toMatchObject({ model: "front-door", reasoning: { effort: "high" } });
  });

  it("shapes the fully authorized catalogue before Pi serializes it and binds review", async () => {
    const { commands, tools } = fullCatalogue();
    const canonical = JSON.stringify(tools);
    const unpatchedWire = {
      tools: tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
    };

    expect(tools.map((tool) => tool.name)).toContain("metrics_feedback");
    expect(tools.map((tool) => tool.name)).toContain("review_status");
    expect(tools.filter((tool) => tool.name === OPERATOR_READ_TOOLS.repositoryBrief)).toHaveLength(1);
    expect(tools.map((tool) => tool.name)).toContain(OPERATOR_BATCH_TOOL);
    expect(tools.map((tool) => tool.name)).not.toContain(OPERATOR_ASK_REPO_TOOL);
    expect(lookaroundPatterns(unpatchedWire.tools)).toHaveLength(4);
    expect(validateResponsesPayload(unpatchedWire).status).toBe(400);

    const calls: CapturedRequest[] = [];
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body,
      });
      return validateResponsesPayload(body);
    };
    const config = configStore();
    const completions = new PiAiProviders(config.config.providers, { secrets: secretsFrom({}), fetch: fetchImpl });
    const msg: IncomingMessage = {
      channelId: "slack:CX",
      userId: "slack:UX",
      userName: "UX",
      text: "review https://github.com/acme/api/pull/7",
      threadKey: "slack:CX:1.0",
    };

    const result = await operatorStage({ config, completions, commands }, { msg, mode: "on" });

    expect(result).toMatchObject({
      outcome: "binds",
      binds: [
        {
          line: "agent:review review https://github.com/acme/api/pull/7",
          repo: "acme/api",
        },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.invalid/v1/responses");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect((calls[0].body.tools as unknown[]).map((tool) => (tool as { name: string }).name)).toEqual(
      tools.map((tool) => tool.name),
    );
    expect(lookaroundPatterns(calls[0].body.tools)).toHaveLength(0);
    expect((calls[0].body.tools as Array<{ strict?: boolean }>).every((tool) => tool.strict === false)).toBe(true);
    expect(calls[0].body.max_output_tokens).toBe(operatorMaxOutputTokens({ capField: "max_output_tokens" }));
    expect(calls[0].body.reasoning).toMatchObject({ effort: "high" });
    expect(JSON.stringify(tools)).toBe(canonical);
  });

  it("leaves canonical schemas, local validators, and non-Responses requests unchanged", () => {
    const { commands, tools } = fullCatalogue();
    const localValidator = commands.get("delivery.report")?.options;
    expect(localValidator?.safeParse({ repo: "../escape" }).success).toBe(false);
    const canonicalBefore = JSON.stringify(tools);
    const responsesBody = {
      tools: tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
    };
    const responsesBefore = JSON.stringify(responsesBody);
    const chatBody = {
      tools: tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      })),
    };
    const messagesBody = {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
    };
    const chatBefore = JSON.stringify(chatBody);
    const messagesBefore = JSON.stringify(messagesBody);

    const shapedResponses = shapeToolSchemasForWire("openai-responses", responsesBody);
    expect(lookaroundPatterns(shapedResponses.body.tools)).toHaveLength(0);
    expect(JSON.stringify(responsesBody)).toBe(responsesBefore);
    expect(JSON.stringify(tools)).toBe(canonicalBefore);
    expect(lookaroundPatterns(tools)).toHaveLength(4);
    expect(commands.get("delivery.report")?.options).toBe(localValidator);
    expect(localValidator?.safeParse({ repo: "../escape" }).success).toBe(false);

    expect(shapeToolSchemasForWire("openai-chat", chatBody)).toEqual({ body: chatBody, degradations: [] });
    expect(shapeToolSchemasForWire("anthropic-messages", messagesBody)).toEqual({
      body: messagesBody,
      degradations: [],
    });
    expect(JSON.stringify(chatBody)).toBe(chatBefore);
    expect(JSON.stringify(messagesBody)).toBe(messagesBefore);
    expect(lookaroundPatterns(chatBody.tools)).toHaveLength(4);
    expect(lookaroundPatterns(messagesBody.tools)).toHaveLength(4);
  });
});
