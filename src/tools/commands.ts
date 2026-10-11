import type { ChatCommands, ChatCommandResult } from "../core/commandChat.js";
import { jsonSchemaFor, namedToInput } from "../core/commandSurface.js";
import { CommandRegistry, type CommandInput } from "../core/commandRegistry.js";
import type { RunnableTool } from "./runnableTool.js";

export type ConversationCommand = (
  sourceMessage: string,
  id: string,
  input: CommandInput,
) => Promise<ChatCommandResult>;

/** Project the existing registry; the model never supplies an actor or authority. */
export function conversationCommandTools(commands: ChatCommands | undefined): RunnableTool[] {
  const catalog = (commands?.list() ?? []).filter((command) => CommandRegistry.exposedTo(command, "chat"));
  if (!catalog.length) return [];
  const commandName = { type: "string", enum: catalog.map(({ id }) => id) };
  return [
    {
      name: "command_schema",
      description:
        "Read the registered command's description and exact named parameter schema. Schema discovery grants no authority.",
      inputSchema: {
        type: "object",
        properties: { command: commandName },
        required: ["command"],
        additionalProperties: false,
      },
      sideEffectFree: true,
      failsInText: true,
      async run(input) {
        const command = catalog.find(({ id }) => id === input.command);
        return command
          ? JSON.stringify({ description: command.describe, parameters: jsonSchemaFor(command) })
          : "error: This command is unavailable.";
      },
    },
    {
      name: "command_run",
      description:
        "Run one registered command using named parameters from command_schema. Copy an exact quote from the latest requester turn into sourceMessage. The registry validates parameters, authorizes the requester, and applies its approval policy. Pending approval is not execution.",
      inputSchema: {
        type: "object",
        properties: {
          command: commandName,
          parameters: { type: "object", additionalProperties: true },
          sourceMessage: { type: "string", description: "Exact quote from the latest requester turn" },
        },
        required: ["command", "parameters", "sourceMessage"],
        additionalProperties: false,
      },
      failsInText: true,
      async run(input, ctx) {
        if (!ctx.command) return "error: Commands are unavailable in this conversation.";
        const command = catalog.find(({ id }) => id === input.command);
        if (!command) return "error: This command is unavailable.";
        if (typeof input.sourceMessage !== "string" || !input.sourceMessage.trim())
          return "error: Copy an exact quote from the latest requester turn into sourceMessage.";
        if (!input.parameters || typeof input.parameters !== "object" || Array.isArray(input.parameters))
          return "error: Parameters must be an object matching command_schema.";
        const bound = namedToInput(command, input.parameters as Record<string, unknown>, "camel");
        if ("error" in bound) return `error: ${bound.error}`;
        const result = await ctx.command(input.sourceMessage, command.id, bound);
        return result.ok ? result.text : `error: ${result.text}`;
      },
    },
  ];
}
