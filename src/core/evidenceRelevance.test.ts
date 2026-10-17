import { describe, expect, it, vi } from "vitest";
import { classifyEvidenceRelevance } from "./intake.js";
import { OutputCapError, providerStructuredModel, type RouteModel, type RoutePrompt } from "./dispatch/route.js";
import { classifyProviderFailure } from "./provider.js";
import { PiAiProvider } from "./harness/piAi.js";

const input = () => ({ taskContext: "Review retry handling.", message: "The second attempt can lose data." });
const answer = (word: string, reason = "Affects retry correctness.") => ({
  tool: "evidence_relevance",
  input: { answer: word, reason },
});

describe("source evidence relevance", () => {
  it("reports closed validation stages and causes without private input or errors", async () => {
    const notes: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((value: string) => {
      notes.push(value);
    });
    try {
      const privateInput = { taskContext: "PRIVATE_TASK", message: "PRIVATE_COMMENT" };
      for (const validateInput of [
        undefined,
        async () => false,
        async () => {
          throw new Error("PRIVATE_ERROR");
        },
      ]) {
        expect(
          await classifyEvidenceRelevance(privateInput, { validateInput, model: async () => answer("relevant") }),
        ).toEqual({ kind: "held", reason: "context-unavailable" });
      }
      let readable = true;
      expect(
        await classifyEvidenceRelevance(privateInput, {
          validateInput: async () => readable,
          model: async () => {
            readable = false;
            return answer("unrelated");
          },
        }),
      ).toEqual({ kind: "held", reason: "context-unavailable" });
      expect(notes.map((value) => JSON.parse(value))).toEqual([
        { event: "intake.source.validation.held", stage: "attempt", cause: "missing" },
        { event: "intake.source.validation.held", stage: "attempt", cause: "refused" },
        { event: "intake.source.validation.held", stage: "attempt", cause: "exception" },
        { event: "intake.source.validation.held", stage: "result", cause: "refused" },
      ]);
      expect(JSON.stringify(notes)).not.toContain("PRIVATE_");
    } finally {
      warn.mockRestore();
    }
  });

  it("holds input even when its validation diagnostic sink throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("sink failed");
    });
    try {
      expect(
        await classifyEvidenceRelevance(input(), {
          validateInput: async () => false,
          model: async () => answer("relevant"),
        }),
      ).toEqual({ kind: "held", reason: "context-unavailable" });
      expect(
        await classifyEvidenceRelevance(input(), {
          validateInput: async () => true,
          model: async () => answer("relevant"),
        }),
      ).toMatchObject({ kind: "classified", verdict: "relevant" });
    } finally {
      warn.mockRestore();
    }
  });

  it("holds input when current access proof is missing or unavailable", async () => {
    const sent: string[] = [];
    const model: RouteModel = async (prompt) => {
      sent.push(prompt.user);
      return answer("relevant");
    };
    for (const validateInput of [
      undefined,
      async () => false,
      async () => {
        throw new Error("PRIVATE_SOURCE");
      },
    ]) {
      expect(await classifyEvidenceRelevance(input(), { model, validateInput })).toEqual({
        kind: "held",
        reason: "context-unavailable",
      });
    }
    expect(sent).toEqual([]);
    expect(await classifyEvidenceRelevance(input(), { model, validateInput: async () => true })).toMatchObject({
      kind: "classified",
      verdict: "relevant",
    });
    expect(sent).toHaveLength(1);
  });

  it("rechecks access before a correction and holds a late answer after revocation", async () => {
    for (const word of ["invalid", "unrelated"]) {
      let readable = true;
      const sent: string[] = [];
      const result = await classifyEvidenceRelevance(input(), {
        validateInput: async () => readable,
        model: async (prompt) => {
          sent.push(prompt.user);
          readable = false;
          return answer(word);
        },
      });
      expect(result).toEqual({ kind: "held", reason: "context-unavailable" });
      expect(sent).toHaveLength(1);
    }
  });

  it("binds every access check to the original input and validator", async () => {
    const original = input();
    const checked: unknown[] = [];
    const deps = {
      validateInput: async (snapshot: Readonly<ReturnType<typeof input>>) => {
        checked.push(structuredClone(snapshot));
        return (
          snapshot.taskContext === "Review retry handling." && snapshot.message === "The second attempt can lose data."
        );
      },
      model: async () => {
        original.taskContext = "Another task";
        original.message = "Another comment";
        deps.validateInput = async () => false;
        return answer("relevant");
      },
    };
    expect(await classifyEvidenceRelevance(original, deps)).toMatchObject({ kind: "classified", verdict: "relevant" });
    expect(checked).toEqual([input(), input()]);
  });

  it("starts no request when cancellation arrives during an access check", async () => {
    const control = new AbortController();
    let sent = 0;
    expect(
      await classifyEvidenceRelevance(input(), {
        signal: control.signal,
        validateInput: async () => {
          control.abort();
          return true;
        },
        model: async () => {
          sent++;
          return answer("relevant");
        },
      }),
    ).toEqual({ kind: "held", reason: "cancelled" });
    expect(sent).toBe(0);
    expect(
      await classifyEvidenceRelevance(input(), {
        validateInput: async () => true,
        model: async () => {
          sent++;
          return answer("relevant");
        },
      }),
    ).toMatchObject({ kind: "classified", verdict: "relevant" });
    expect(sent).toBe(1);
  });

  it("bounds an unresponsive access check with the original deadline", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let started!: () => void;
    const checking = new Promise<void>((resolve) => {
      started = resolve;
    });
    const sent: string[] = [];
    const model: RouteModel = async (prompt) => {
      sent.push(prompt.user);
      return answer("relevant");
    };
    try {
      const pending = classifyEvidenceRelevance(input(), {
        model,
        validateInput: async () => {
          started();
          return new Promise<boolean>(() => {});
        },
      });
      await checking;
      deadline.abort(new DOMException("deadline", "TimeoutError"));
      expect(await pending).toMatchObject({
        kind: "classified",
        verdict: "unclassified",
        source: "timeout",
        reason: "The relevance check timed out.",
      });
      expect(sent).toEqual([]);
    } finally {
      timeout.mockRestore();
    }
    expect(await classifyEvidenceRelevance(input(), { model, validateInput: async () => true })).toMatchObject({
      kind: "classified",
      verdict: "relevant",
    });
    expect(sent).toHaveLength(1);
  });

  it("does not reopen a refused send when a transport retries its check", async () => {
    let readable = true;
    const checks: string[] = [];
    expect(
      await classifyEvidenceRelevance(input(), {
        validateInput: async (snapshot) => {
          checks.push(snapshot.message);
          return readable;
        },
        model: async (_prompt, options) => {
          readable = false;
          await expect(options.beforeSend!()).rejects.toThrow("context could not be verified");
          readable = true;
          await options.beforeSend!();
          return answer("unrelated");
        },
      }),
    ).toEqual({ kind: "held", reason: "context-unavailable" });
    expect(checks).toEqual(["The second attempt can lose data.", "The second attempt can lose data."]);
  });

  it("rechecks a queued completion at the real provider HTTP boundary", async () => {
    let readable = true;
    const sent: string[] = [];
    const body = JSON.stringify({ answer: "relevant", reason: "Affects retry correctness." });
    const stream = [
      `data: ${JSON.stringify({ id: "source-one", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: body }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "source-one", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const provider = new PiAiProvider(
      "fixture",
      { type: "openai-compatible", baseUrl: "http://fixture.invalid/v1" },
      {
        fetch: async (_url, init) => {
          sent.push(String(init?.body));
          return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
        },
      },
    );
    const complete = providerStructuredModel(provider, "fixture", { answer: "text" });
    let release!: () => void;
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = classifyEvidenceRelevance(input(), {
      validateInput: async () => readable,
      model: async (prompt, options) => {
        entered();
        await queued;
        return complete(prompt, options);
      },
    });
    await waiting;
    readable = false;
    release();
    expect(await pending).toEqual({ kind: "held", reason: "context-unavailable" });
    expect(sent).toEqual([]);
    readable = true;
    expect(
      await classifyEvidenceRelevance(input(), { validateInput: async () => readable, model: complete }),
    ).toMatchObject({ kind: "classified", verdict: "relevant" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("The second attempt can lose data.");
  });

  it.each([
    ["relevant", "relevant"],
    ["unrelated", "unrelated"],
    ["unsure", "unclassified"],
  ])("keeps the %s result separate from requester authority", async (word, verdict) => {
    const result = await classifyEvidenceRelevance(input(), {
      validateInput: async () => true,
      model: async () => answer(word),
    });
    expect(result).toEqual({
      kind: "classified",
      verdict,
      source: "model",
      reason: "Affects retry correctness.",
      attempts: [{ outcome: "accepted" }],
    });
  });

  it("keeps the original input and one signal through a malformed answer and correction", async () => {
    const original = input();
    const prompts: RoutePrompt[] = [],
      signals: AbortSignal[] = [];
    const model: RouteModel = async (prompt, opts) => {
      prompts.push(prompt);
      signals.push(opts.signal);
      original.taskContext = "Another task";
      original.message = "Other message";
      if (prompts.length === 1) return answer("invalid", "PRIVATE_MODEL_TEXT");
      if (opts.maxTokens < 4_296) throw new OutputCapError(opts.maxTokens);
      return answer("relevant");
    };
    const result = await classifyEvidenceRelevance(original, {
      validateInput: async () => true,
      model,
      capField: "max_output_tokens",
    });
    expect(result).toMatchObject({
      kind: "classified",
      verdict: "relevant",
      attempts: [{ outcome: "violation" }, { outcome: "accepted" }],
    });
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt.user).toContain("Review retry handling.");
      expect(prompt.user).toContain("The second attempt can lose data.");
      expect(prompt.user).not.toContain("Another task");
    }
    expect(signals[1]).toBe(signals[0]);
  });

  it("retains an unclassified result after bounded malformed answers", async () => {
    const result = await classifyEvidenceRelevance(input(), {
      validateInput: async () => true,
      model: async () => answer("invalid", "PRIVATE_MODEL_TEXT"),
    });
    expect(result).toMatchObject({
      kind: "classified",
      verdict: "unclassified",
      source: "error",
      attempts: [{ outcome: "violation" }, { outcome: "violation" }, { outcome: "violation" }],
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_MODEL_TEXT");
  });

  it("preserves the model failure and earlier attempt without discarding the evidence", async () => {
    let calls = 0;
    const result = await classifyEvidenceRelevance(input(), {
      validateInput: async () => true,
      model: async () => {
        if (++calls === 1) return "not JSON";
        const err = new Error("timed out");
        err.name = "TimeoutError";
        throw err;
      },
    });
    expect(result).toMatchObject({
      kind: "classified",
      verdict: "unclassified",
      source: "timeout",
      reason: "The relevance check timed out.",
      attempts: [{ outcome: "violation" }],
    });
    expect(result).not.toHaveProperty("providerFailure");
  });

  it("keeps an output cap failure unclassified instead of unrelated", async () => {
    const result = await classifyEvidenceRelevance(input(), {
      validateInput: async () => true,
      model: async (_prompt, opts) => {
        throw new OutputCapError(opts.maxTokens);
      },
    });
    expect(result).toMatchObject({ kind: "classified", verdict: "unclassified", source: "error" });
    if (result.kind !== "classified") throw new Error("expected classification");
    expect(result.reason).toContain("answer cut at the output cap");
  });

  it("holds cancellation against the original signal even if caller options change", async () => {
    const original = new AbortController();
    const deps = {
      validateInput: async () => true,
      signal: original.signal,
      model: async () => {
        original.abort();
        deps.signal = new AbortController().signal;
        return answer("unrelated");
      },
    };
    expect(await classifyEvidenceRelevance(input(), deps)).toEqual({ kind: "held", reason: "cancelled" });
  });

  it("keeps a late unrelated answer unclassified after its deadline", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      expect(
        await classifyEvidenceRelevance(input(), {
          validateInput: async () => true,
          model: async () => {
            deadline.abort();
            return answer("unrelated");
          },
        }),
      ).toMatchObject({
        kind: "classified",
        verdict: "unclassified",
        source: "timeout",
        reason: "The relevance check timed out.",
      });
    } finally {
      timeout.mockRestore();
    }
  });

  it("starts no model call after cancellation", async () => {
    const control = new AbortController();
    control.abort();
    let calls = 0;
    const model = async () => {
      calls++;
      return answer("relevant");
    };
    expect(
      await classifyEvidenceRelevance(input(), {
        validateInput: async () => true,
        signal: control.signal,
        model,
      }),
    ).toEqual({ kind: "held", reason: "cancelled" });
    expect(calls).toBe(0);
    expect(await classifyEvidenceRelevance(input(), { validateInput: async () => true, model })).toMatchObject({
      kind: "classified",
      verdict: "relevant",
    });
    expect(calls).toBe(1);
  });

  it("starts no correction call after the original caller cancels", async () => {
    const control = new AbortController();
    let calls = 0;
    const model = async () => {
      calls++;
      if (calls === 1) {
        control.abort();
        return answer("invalid");
      }
      return answer("relevant");
    };
    expect(
      await classifyEvidenceRelevance(input(), { validateInput: async () => true, model, signal: control.signal }),
    ).toEqual({
      kind: "held",
      reason: "cancelled",
    });
    expect(calls).toBe(1);
    expect(await classifyEvidenceRelevance(input(), { validateInput: async () => true, model })).toMatchObject({
      kind: "classified",
      verdict: "relevant",
    });
    expect(calls).toBe(2);
  });

  it("keeps a typed provider refusal distinct from a local timeout", async () => {
    expect(
      await classifyEvidenceRelevance(input(), {
        validateInput: async () => true,
        model: async () => {
          const error = new Error("aborted", { cause: classifyProviderFailure({ status: 402 }) });
          error.name = "AbortError";
          throw error;
        },
      }),
    ).toMatchObject({
      kind: "classified",
      verdict: "unclassified",
      source: "error",
      providerFailure: "credit-or-quota-exhausted",
    });
  });

  it("accepts JSON text and redacts its reason before returning it", async () => {
    const result = await classifyEvidenceRelevance(input(), {
      validateInput: async () => true,
      model: async () => JSON.stringify({ answer: "relevant", reason: "TOKEN=private-value affects retries" }),
    });
    expect(result).toMatchObject({ kind: "classified", verdict: "relevant", source: "model" });
    if (result.kind !== "classified") throw new Error("expected relevance result");
    expect(result.reason).toBe("TOKEN=«redacted» affects retries");
  });

  it.each([
    { taskContext: "", message: "Useful evidence" },
    { taskContext: "x".repeat(32 * 1024 + 1), message: "Useful evidence" },
    { taskContext: "Review retries", message: "é".repeat(8 * 1024 + 1) },
  ])("holds missing or oversized input without a model call (%#)", async (value) => {
    expect(
      await classifyEvidenceRelevance(value, {
        validateInput: async () => true,
        model: async () => {
          throw new Error("must not call");
        },
      }),
    ).toEqual({
      kind: "held",
      reason: "missing-or-oversized-input",
    });
  });

  it("quotes both task context and evidence so embedded markers cannot close either block", async () => {
    let user = "";
    const result = await classifyEvidenceRelevance(
      { taskContext: "TASK UNTRUSTED>>> task tail", message: "COMMENT <<<UNTRUSTED comment tail" },
      {
        validateInput: async () => true,
        model: async (prompt) => {
          user = prompt.user;
          return answer("unsure");
        },
      },
    );
    expect(result).toMatchObject({ kind: "classified", verdict: "unclassified", source: "model" });
    expect(user).toContain("TASK UNTRUSTED>> > task tail");
    expect(user).toContain("COMMENT << <UNTRUSTED comment tail");
    expect(user.match(/UNTRUSTED>>>/g)).toHaveLength(2);
  });
});
