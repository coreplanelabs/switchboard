import { describe, expect, it } from "vitest";
import { configAwarenessBlock } from "./configAwareness.js";

// Feature: features/routing-and-config.md — config awareness (behavior 8): the
// model is told the RESOLVED agent/model/scope and that config is tunable, so
// no agent can truthfully-sounding claim it is "stateless" or "untunable".

const base = {
  agentName: "general",
  modelRef: "anthropic/general-model",
  channel: {},
  user: {},
  messageDirective: {},
  threadDirective: {},
  canEditChannelConfig: true,
};

describe("configAwarenessBlock", () => {
  it("names the resolved agent and model, and says defaults are in use when no scope overrides exist", () => {
    const block = configAwarenessBlock(base);
    expect(block).toContain("agent `general`");
    expect(block).toContain("model `anthropic/general-model`");
    expect(block).toMatch(/using defaults/i);
    expect(block).not.toMatch(/(channel|user) override:/);
  });

  it("reports channel and user overrides by scope, verbatim from the resolved scopes", () => {
    const block = configAwarenessBlock({
      ...base,
      agentName: "review",
      modelRef: "openai/gpt-5",
      channel: { agent: "review" },
      user: { model: "openai/gpt-5", models: { coding: "anthropic/opus" } },
    });
    expect(block).toContain("channel override: agent `review`");
    expect(block).toContain("user override: model `openai/gpt-5`, models coding=`anthropic/opus`");
    expect(block).not.toMatch(/using defaults/i);
  });

  it("attributes a per-message directive to this message, and a sticky one to the thread", () => {
    const fromMessage = configAwarenessBlock({ ...base, agentName: "review", messageDirective: { agent: "review" } });
    expect(fromMessage).toMatch(/this message's `agent:review` directive/i);
    expect(fromMessage).not.toMatch(/earlier in this thread/i);

    const fromThread = configAwarenessBlock({
      ...base,
      modelRef: "anthropic/x-model",
      threadDirective: { model: "anthropic/x-model" },
    });
    expect(fromThread).toMatch(/`model:anthropic\/x-model` directive earlier in this thread/i);

    // A message directive wins over the thread one and the block says so once.
    const both = configAwarenessBlock({
      ...base,
      agentName: "coding",
      messageDirective: { agent: "coding" },
      threadDirective: { agent: "review" },
    });
    expect(both).toMatch(/this message's `agent:coding` directive/i);
    expect(both).not.toContain("agent:review");
  });

  it("always tells the model how settings are inspected and tuned, with channel gating stated truthfully", () => {
    const open = configAwarenessBlock(base);
    expect(open).toContain("`config show`");
    expect(open).toContain("`config set me");
    expect(open).toContain("`config set channel");
    expect(open).toMatch(/agent:<name>/);
    expect(open).toMatch(/model:<provider>\/<model>/);
    expect(open).not.toMatch(/restricted for this user/i);

    const gated = configAwarenessBlock({ ...base, canEditChannelConfig: false });
    expect(gated).toMatch(/config set channel[^\n]*restricted for this user/i);
  });

  it("is short: a handful of lines, never a wall of text (it rides on every turn)", () => {
    const block = configAwarenessBlock({
      ...base,
      channel: { agent: "review", models: { review: "a/b", coding: "c/d" } },
      user: { model: "e/f" },
      messageDirective: { agent: "coding", model: "g/h" },
    });
    expect(block.split("\n").length).toBeLessThanOrEqual(6);
    expect(block.length).toBeLessThan(900);
  });
});

describe("configAwarenessBlock — custom instructions (#107 phase 2)", () => {
  const base = {
    agentName: "general",
    modelRef: "anthropic/m",
    channel: {},
    user: {},
    messageDirective: {},
    threadDirective: {},
    canEditChannelConfig: true,
  };

  it("notes which scopes have custom instructions active, as advisory content, without dumping the text", () => {
    const both = configAwarenessBlock({
      ...base,
      channel: { instructions: "Channel rules." },
      user: { instructions: "My rules." },
    });
    expect(both).toMatch(/Custom instructions are active for this run \(channel, user\)/);
    expect(both).toMatch(/advisory/i);
    expect(both).toContain("`config set me instructions");
    const channelOnly = configAwarenessBlock({ ...base, channel: { instructions: "Channel rules." } });
    expect(channelOnly).toMatch(/active for this run \(channel\)/);
    expect(channelOnly).not.toContain("Channel rules.");
  });

  it("says nothing about instructions when none are set", () => {
    expect(configAwarenessBlock(base)).not.toMatch(/custom instructions are active/i);
  });
});
