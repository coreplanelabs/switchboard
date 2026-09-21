import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CompletionResult, Provider } from "../provider.js";
import { InMemoryConfirmationStore } from "../confirmations.js";
import { configSet } from "../commands/config.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import { mintConfirmationOffer, MultiToolCallError, providerStructuredModel, type RoutePrompt } from "./route.js";

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the readers' router is retired", () => {
  it("has no prompt, parse or dispatch stage; the dispatcher calls only the operator", () => {
    const route = source("./route.ts");
    expect(route).not.toMatch(/export (async )?function (buildRoutePrompt|parseRouteAnswer|routeRequest|route)\b/);
    expect(route).not.toContain('name: "route"');
    expect(source("../dispatcher.ts")).not.toContain("routeRequest(");
  });

  it("keeps multi-call answers typed so the operator can re-ask them", async () => {
    const result: CompletionResult = {
      content: [
        { type: "tool_use", id: "t1", name: "bind_preset", input: { preset: "general", reason: "a" } },
        { type: "tool_use", id: "t2", name: "thread_state", input: {} },
      ],
      stopReason: "tool_use",
    };
    const provider: Provider = { name: "fake", complete: async () => result };
    const prompt: RoutePrompt = {
      system: "system",
      user: "user",
      tool: { name: "bind_preset", description: "bind a preset", inputSchema: { type: "object" } },
      open: true,
    };

    const thrown = await providerStructuredModel(provider, "model")(prompt, {
      maxTokens: 50,
      signal: new AbortController().signal,
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(MultiToolCallError);
    expect((thrown as MultiToolCallError).calls.map((call) => call.tool)).toEqual(["bind_preset", "thread_state"]);
  });
});

describe("mintConfirmationOffer — risk projection", () => {
  it("renders config risk from accepted input and the caller origin, then stores and offers the same line", async () => {
    const msg: IncomingMessage = {
      channelId: "slack:CX",
      userId: "slack:UREQ",
      threadKey: "slack:CX:1.0",
      text: "set my verbosity to verbose",
      channelName: "release-planning",
    };
    const origin = {
      channelId: msg.channelId,
      threadKey: msg.threadKey,
      channelName: msg.channelName,
    };
    const store = new InMemoryConfirmationStore({ clock: () => 1_000 });
    const io = { reply: async () => {}, offer: async () => {} } as unknown as ChannelIO;
    const input = { args: ["me"], options: { verbosity: "verbose" } };

    const minted = await mintConfirmationOffer({
      io,
      store,
      msg,
      origin,
      def: configSet,
      input,
      receipt: "config set me --verbosity verbose",
      model: "anthropic/general-model",
    });

    expect(minted).toMatchObject({
      kind: "offered",
      shown: { risk: "changes your own settings until you reset them" },
    });
    expect(await store.pendingByThread(msg.threadKey)).toMatchObject({
      kind: "run",
      risk: "changes your own settings until you reset them",
    });
  });
});
