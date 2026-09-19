// The structured-answer seam (record 0067; the one-door plan's U19): the loop
// every one-shot structured ask runs through — parse, re-ask a named
// violation with the violation quoted back, bounded retries, the caller's
// declared floor, every attempt on the record. Scripted models throughout;
// the four callers' own migrations are proven in their own test files.
import { describe, expect, it } from "vitest";
import { STRUCTURED_RETRIES_MAX } from "../budgets.js";
import { askStructured, attemptsOfThrow, reAskTurn, StructuredAskError, type StructuredAsk } from "./structured.js";
import type { RouteModel, RoutePrompt, RouteToolCall } from "./route.js";

const prompt: RoutePrompt = {
  system: "the rules",
  user: "the request",
  tool: { name: "decision", description: "decide", inputSchema: { type: "object", properties: {} } },
};

/** A parser accepting only the `decision` tool with a string `word`. */
const ask: StructuredAsk<string> = {
  prompt,
  parse: (answer: RouteToolCall | string) => {
    if (typeof answer === "string") return { ok: false, violation: `not a single JSON object: ${answer}` };
    if (answer.tool !== "decision") return { ok: false, violation: `called tool "${answer.tool}", not decision` };
    const word = (answer.input as { word?: unknown }).word;
    if (typeof word !== "string") return { ok: false, violation: "missing word in the answer" };
    return { ok: true, value: word };
  },
  noun: "a decision",
  tool: "decision",
  floor: (violation) => `floor: ${violation}`,
};

const opts = { maxTokens: 100, signal: AbortSignal.timeout(5_000) };

describe("the structured-answer seam", () => {
  it("the right call first: one attempt, no re-ask, the value accepted", async () => {
    const prompts: RoutePrompt[] = [];
    const out = await askStructured(
      ask,
      async (p) => {
        prompts.push(p);
        return { tool: "decision", input: { word: "yes" } };
      },
      opts,
    );
    expect(out).toEqual({ value: "yes", floored: false, attempts: [{ outcome: "accepted" }] });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.retries).toBeUndefined();
  });

  it("wrong then right: one re-ask whose user turn names the violation verbatim, the second answer accepted, two attempts", async () => {
    const prompts: RoutePrompt[] = [];
    const answers: (RouteToolCall | string)[] = ["I would say yes", { tool: "decision", input: { word: "yes" } }];
    const out = await askStructured(
      ask,
      async (p) => {
        prompts.push(p);
        return answers.shift()!;
      },
      opts,
    );
    expect(out.value).toBe("yes");
    expect(out.floored).toBe(false);
    expect(out.attempts).toEqual([
      { outcome: "violation", violation: "not a single JSON object: I would say yes" },
      { outcome: "accepted" },
    ]);
    // The second ask carries the model's own answer and the re-ask turn — the
    // violation quoted verbatim with the caller's noun and tool interpolated.
    expect(prompts[1]!.retries).toEqual([
      {
        answer: "I would say yes",
        violation:
          "your answer was not a decision: not a single JSON object: I would say yes; answer with the decision tool only",
      },
    ]);
  });

  it("always wrong: the bounded re-asks, then the caller's floor built from the last violation — never a thrown refusal", async () => {
    let calls = 0;
    const out = await askStructured(
      ask,
      async () => {
        calls++;
        return { tool: "other", input: {} };
      },
      opts,
    );
    expect(calls).toBe(STRUCTURED_RETRIES_MAX + 1);
    expect(out.floored).toBe(true);
    expect(out.value).toBe('floor: called tool "other", not decision');
    expect(out.attempts).toHaveLength(STRUCTURED_RETRIES_MAX + 1);
    expect(out.attempts.every((a) => a.outcome === "violation")).toBe(true);
  });

  it("a wrong tool's re-ask names both tools: the one called in the violation, the one to call in the turn", async () => {
    const prompts: RoutePrompt[] = [];
    const answers: (RouteToolCall | string)[] = [
      { tool: "other", input: {} },
      { tool: "decision", input: { word: "no" } },
    ];
    await askStructured(
      ask,
      async (p) => {
        prompts.push(p);
        return answers.shift()!;
      },
      opts,
    );
    const turn = prompts[1]!.retries![0]!.violation;
    expect(turn).toContain('called tool "other"');
    expect(turn).toContain("answer with the decision tool only");
  });

  it("a model that throws (a timeout, a transport failure) propagates to the caller's catch: no re-ask, no floor here", async () => {
    let calls = 0;
    const model: RouteModel = async () => {
      calls++;
      throw new Error("provider down");
    };
    await expect(askStructured(ask, model, opts)).rejects.toThrow("provider down");
    expect(calls).toBe(1);
  });

  it("a throw after a violation carries the collected attempts: the re-ask the record exists to show survives the caller's catch", async () => {
    let calls = 0;
    const model: RouteModel = async () => {
      calls++;
      if (calls === 1) return "prose, not a call";
      throw new Error("the re-ask timed out");
    };
    const err: unknown = await askStructured(ask, model, opts).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StructuredAskError);
    const thrown = err as StructuredAskError;
    // The original error's message and name are kept, so a caller's reason
    // line and its timeout check (`err.name`) read as before the wrap.
    expect(thrown.message).toBe("the re-ask timed out");
    expect(thrown.name).toBe("Error");
    expect(attemptsOfThrow(thrown)).toEqual([
      { outcome: "violation", violation: "not a single JSON object: prose, not a call" },
    ]);
    expect(calls).toBe(2);
  });

  it("reAskTurn interpolates the caller's noun and tool around the violation", () => {
    expect(reAskTurn("a verdict", "verify", "agrees is not a boolean")).toBe(
      "your answer was not a verdict: agrees is not a boolean; answer with the verify tool only",
    );
  });
});
