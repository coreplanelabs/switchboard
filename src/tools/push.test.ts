import { describe, expect, it } from "vitest";
import type { EffectEnvelope, EffectResult, RunEffects } from "../core/runEffects.js";
import type { ToolContext } from "./runnableTool.js";
import { pushTool } from "./push.js";
import { TOOLSETS } from "./toolsets.js";

const INPUT = {
  effectId: "effect-directive",
  repository: "acme/api",
  branch: "fix/open-pr-head",
  expectedHead: "a".repeat(40),
  base: "main",
  gateSet: "changed-set",
};

function context(execute: (envelope: EffectEnvelope) => Promise<EffectResult>): ToolContext {
  return {
    executor: {} as ToolContext["executor"],
    effects: { execute } satisfies RunEffects,
  };
}

describe("push tool — the typed publication command", () => {
  it("is a coding capability only", () => {
    expect(TOOLSETS.full.map((tool) => tool.name)).toContain("push");
    for (const name of ["readonly", "web", "assistant", "explore", "conductor", "orchestrator", "none"])
      expect(
        TOOLSETS[name]!.map((tool) => tool.name),
        name,
      ).not.toContain("push");
  });

  it("turns a directive run on an open pull request head into the same exact branch command", async () => {
    const seen: EffectEnvelope[] = [];
    const result = await pushTool.run(
      INPUT,
      context(async (envelope) => {
        seen.push(envelope);
        return {
          effectId: envelope.effectId,
          kind: "push",
          outcome: "succeeded",
          actor: "chat:user",
          repository: envelope.command.repository,
          resource: `${envelope.command.repository}#refs/heads/${envelope.command.branch}`,
          destination: `refs/heads/${envelope.command.branch}`,
          after: envelope.command.expectedHead,
          tree: "b".repeat(40),
          endpoint: "https://github.com/acme/api.git",
          gates: [],
          by: "runner",
          occurredAt: 1,
        };
      }),
    );
    expect(seen).toEqual([
      {
        effectId: "effect-directive",
        command: {
          kind: "push",
          repository: "acme/api",
          branch: "fix/open-pr-head",
          expectedHead: "a".repeat(40),
          base: "main",
          gateSet: "changed-set",
        },
      },
    ]);
    expect(JSON.parse(String(result))).toMatchObject({
      outcome: "succeeded",
      destination: "refs/heads/fix/open-pr-head",
    });
  });

  it("refuses malformed or transport-shaped input before the effect port", async () => {
    let calls = 0;
    const ctx = context(async () => {
      calls++;
      throw new Error("not reached");
    });
    for (const input of [
      { ...INPUT, expectedHead: "HEAD" },
      { ...INPUT, branch: "-mirror" },
      { ...INPUT, repository: "https://github.com/acme/api" },
      { ...INPUT, remote: "upstream" },
      { ...INPUT, refspec: "HEAD:main" },
      { ...INPUT, flags: ["--mirror"] },
    ]) {
      expect(String(await pushTool.run(input, ctx)), JSON.stringify(input)).toMatch(/^error: push refused:/);
    }
    expect(calls).toBe(0);
  });

  it("refuses honestly when no runner effect capability is bound", async () => {
    expect(String(await pushTool.run(INPUT, { executor: {} as ToolContext["executor"] }))).toContain(
      "runner effects are unavailable",
    );
  });
});
