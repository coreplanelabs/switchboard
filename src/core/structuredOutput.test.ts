import { describe, expect, it, vi } from "vitest";
import type { CompletionRequest, CompletionResult, Provider } from "../providers/types.js";
import {
  MAX_STRUCTURE_RETRIES,
  parseStructured,
  produceStructured,
  providerProducer,
  STRUCTURING_SYSTEM,
  type StructuredProducer,
} from "./structuredOutput.js";

// Feature: features/channel-formatter.md — schema-validated, self-healing output.
// The produce → validate → feed-error-back → re-ask loop with a FIXED retry
// budget (never exponential), and a graceful plain fallback after exhaustion.

const VALID = { blocks: [{ type: "paragraph", text: "ok" }] };

describe("produceStructured (fixed-retry self-heal)", () => {
  it("returns the validated message on a first-try success (one attempt)", async () => {
    const produce = vi.fn<StructuredProducer>(async () => VALID);
    const result = await produceStructured(produce);
    expect(result.fellBack).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.message).toEqual(VALID);
    expect(produce).toHaveBeenCalledTimes(1);
    // first attempt gets no feedback
    expect(produce).toHaveBeenNthCalledWith(1, undefined);
  });

  it("feeds the validation error back each time and succeeds on a later attempt", async () => {
    // Fail schema twice, then succeed on the third attempt.
    const produce = vi
      .fn<StructuredProducer>()
      .mockResolvedValueOnce({ blocks: [] }) // empty blocks -> invalid
      .mockResolvedValueOnce({ blocks: [{ type: "bogus" }] }) // unknown type -> invalid
      .mockResolvedValueOnce(VALID);
    const result = await produceStructured(produce, { maxRetries: 2 });
    expect(result.fellBack).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.message).toEqual(VALID);
    expect(produce).toHaveBeenCalledTimes(3);
    // re-asks carry a non-empty correction string (the fed-back error)
    const secondArg = produce.mock.calls[1][0];
    const thirdArg = produce.mock.calls[2][0];
    expect(secondArg).toBeTruthy();
    expect(thirdArg).toBeTruthy();
    expect(secondArg).toMatch(/JSON/i);
  });

  it("falls back to plain text after the fixed retry budget is exhausted", async () => {
    const produce = vi.fn<StructuredProducer>(async () => ({ nonsense: true }));
    const onWarn = vi.fn();
    const result = await produceStructured(produce, { maxRetries: 2, fallbackText: "raw answer", onWarn });
    expect(result.fellBack).toBe(true);
    expect(result.attempts).toBe(3); // 1 initial + 2 retries, all failed
    expect(produce).toHaveBeenCalledTimes(3);
    expect(result.message).toEqual({ blocks: [{ type: "paragraph", text: "raw answer" }] });
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn.mock.calls[0][0]).toMatch(/fall(ing)? back/i);
  });

  it("honors the default MAX_STRUCTURE_RETRIES when none is passed", async () => {
    const produce = vi.fn<StructuredProducer>(async () => ({ bad: true }));
    const result = await produceStructured(produce);
    expect(result.fellBack).toBe(true);
    expect(produce).toHaveBeenCalledTimes(MAX_STRUCTURE_RETRIES + 1);
    expect(result.attempts).toBe(MAX_STRUCTURE_RETRIES + 1);
  });

  it("treats a thrown producer error as a failed attempt and retries, then falls back", async () => {
    const produce = vi.fn<StructuredProducer>(async () => {
      throw new Error("model exploded");
    });
    const result = await produceStructured(produce, { maxRetries: 1, fallbackText: "safe" });
    expect(result.fellBack).toBe(true);
    expect(produce).toHaveBeenCalledTimes(2); // 1 + 1 retry
    expect(result.message).toEqual({ blocks: [{ type: "paragraph", text: "safe" }] });
  });

  it("recovers when a thrown attempt is followed by a valid one", async () => {
    const produce = vi
      .fn<StructuredProducer>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(VALID);
    const result = await produceStructured(produce, { maxRetries: 2 });
    expect(result.fellBack).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.message).toEqual(VALID);
  });
});

describe("parseStructured", () => {
  it("accepts an already-parsed object", () => {
    expect(parseStructured(VALID)).toEqual({ ok: true, message: VALID });
  });

  it("parses a JSON string", () => {
    expect(parseStructured(JSON.stringify(VALID))).toEqual({ ok: true, message: VALID });
  });

  it("strips a ```json fence the model may wrap around the JSON", () => {
    const fenced = "```json\n" + JSON.stringify(VALID) + "\n```";
    expect(parseStructured(fenced)).toEqual({ ok: true, message: VALID });
  });

  it("reports invalid JSON as a (non-throwing) error", () => {
    const result = parseStructured("{ not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/JSON/i);
  });

  it("reports a schema violation as an error", () => {
    const result = parseStructured({ blocks: [] });
    expect(result.ok).toBe(false);
  });
});

describe("providerProducer", () => {
  function capturingProvider(): Provider & { requests: CompletionRequest[] } {
    const requests: CompletionRequest[] = [];
    return {
      name: "fake",
      requests,
      async complete(req): Promise<CompletionResult> {
        requests.push(req);
        return { content: [{ type: "text", text: JSON.stringify(VALID) }], stopReason: "end_turn" };
      },
    };
  }

  it("asks the model with the structuring system prompt and returns its text", async () => {
    const provider = capturingProvider();
    const produce = providerProducer({ provider, model: "m", answer: "the answer", maxTokens: 1000 });
    const raw = await produce(undefined);
    expect(raw).toBe(JSON.stringify(VALID));
    expect(provider.requests[0].system).toBe(STRUCTURING_SYSTEM);
    expect(provider.requests[0].model).toBe("m");
    // the answer to convert is in the user message
    const userText = provider.requests[0].messages[0].content
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    expect(userText).toContain("the answer");
  });

  it("includes the feedback string in the re-ask", async () => {
    const provider = capturingProvider();
    const produce = providerProducer({ provider, model: "m", answer: "A", maxTokens: 10 });
    await produce("FIX THIS: blocks must be non-empty");
    const userText = provider.requests[0].messages[0].content
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    expect(userText).toContain("FIX THIS");
  });

  it("drives the full loop end-to-end with a real provider (validates then returns)", async () => {
    const provider = capturingProvider();
    const produce = providerProducer({ provider, model: "m", answer: "A", maxTokens: 10 });
    const result = await produceStructured(produce);
    expect(result.fellBack).toBe(false);
    expect(result.message).toEqual(VALID);
  });
});
