import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../config.js";
import { secretsFrom } from "../../secrets.js";
import { bindCommands, CommandRegistry } from "../commandRegistry.js";
import { registerCoreCommands, type CoreCommandDeps } from "../commands/all.js";
import { PiAiProviders } from "../harness/piAi.js";
import { shapeToolSchemasForWire } from "../providerToolSchemas.js";
import type { IncomingMessage } from "../types.js";
import {
  operatorMaxOutputTokens,
  operatorPresets,
  operatorProjection,
  operatorStage,
  operatorTools,
} from "./operator.js";
import { routableCommands } from "./route.js";

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

function bindReviewStream(): string {
  const input = JSON.stringify({
    preset: "review",
    repo: "acme/api",
    reason: "the request names a pull request",
  });
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

function configStore(): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-operator-responses-"));
  const path = join(dir, "config.yaml");
  writeFileSync(
    path,
    `organization: acme
providers:
  openai:
    wire: openai-responses
    baseUrl: https://api.openai.invalid/v1
    models:
      gpt-5.6-sol:
        capField: max_output_tokens
defaults:
  agent: general
  models:
    general: openai/gpt-5.6-sol
  efforts:
    general: high
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
    text: "review the pull request in acme/api",
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

    expect(tools).toHaveLength(52);
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
      text: "review the pull request in acme/api",
      threadKey: "slack:CX:1.0",
    };

    const result = await operatorStage({ config, completions, commands }, { msg, mode: "on" });

    expect(result).toMatchObject({
      outcome: "binds",
      binds: [
        {
          line: "agent:review review the pull request in acme/api",
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
