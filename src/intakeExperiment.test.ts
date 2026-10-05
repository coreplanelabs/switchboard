import { describe, expect, it } from "vitest";
import { intakeArm, jevIntakeModel, intakeExperimentReport } from "./intakeExperiment.js";
import { secretsFrom } from "./secrets.js";
import type { IntakeReceipt } from "./core/runLedger/types.js";

describe("intake A/B", () => {
  it("assigns a stable thread arm with explicit zero and full rollout", () => {
    expect(intakeArm("trial", "thread", 0)).toBe("control");
    expect(intakeArm("trial", "thread", 100)).toBe("jev");
    expect(intakeArm("trial", "thread", 50)).toBe(intakeArm("trial", "thread", 50));
    const arms = Array.from({ length: 1000 }, (_, n) => intakeArm("trial", `thread-${n}`, 50));
    expect(arms.filter((a) => a === "jev").length).toBeGreaterThan(400);
    expect(arms.filter((a) => a === "jev").length).toBeLessThan(600);
  });

  it("validates the Jev answer and captures usage without exposing its key", async () => {
    let body: Record<string, unknown> = {};
    const measurements: unknown[] = [];
    const model = jevIntakeModel(
      "jev-1.13.0",
      secretsFrom({ TYPESAFE_API_KEY: "private" }),
      async (_url, init) => {
        body = JSON.parse(init!.body as string);
        return new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              intake: {
                type: "choice",
                choice: "addressed",
                probabilities: { addressed: 0.9, silent: 0.05, unsure: 0.05 },
                confidence: 0.85,
              },
            },
            usage: { input_tokens: 100, output_tokens: 10 },
          }),
        );
      },
      (result, metadata) => measurements.push({ result, metadata }),
    );
    const answer = await model(
      { system: "rules", user: "untrusted reply", tool: { name: "intake", description: "", inputSchema: {} } },
      { maxTokens: 200, signal: new AbortController().signal },
    );
    expect(body).toMatchObject({ model: "jev-1.13.0", state: "untrusted reply" });
    expect(JSON.stringify(body)).not.toContain("private");
    expect(answer).toMatchObject({ tool: "intake", input: { answer: "addressed" } });
    expect(measurements).toMatchObject([
      {
        result: { usage: { inputTokens: 100, outputTokens: 10 } },
        metadata: { servedModel: "typesafe/jev-1.13.0", confidence: 0.85 },
      },
    ]);
  });

  it("rejects missing keys and invalid probabilities without guessing", async () => {
    let called = false;
    const wire = async () => {
      called = true;
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            intake: {
              type: "choice",
              choice: "addressed",
              probabilities: { addressed: 2, silent: 0, unsure: 0 },
              confidence: 1,
            },
          },
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
      );
    };
    const prompt = { system: "rules", user: "reply", tool: { name: "intake", description: "", inputSchema: {} } };
    const options = { maxTokens: 200, signal: new AbortController().signal };
    await expect(jevIntakeModel("jev-1.13.0", secretsFrom({}), wire, () => undefined)(prompt, options)).rejects.toThrow(
      /TYPESAFE_API_KEY/,
    );
    expect(called).toBe(false);
    await expect(
      jevIntakeModel(
        "jev-1.13.0",
        secretsFrom({ TYPESAFE_API_KEY: "private" }),
        wire,
        () => undefined,
      )(prompt, options),
    ).rejects.toThrow(/invalid/i);
  });

  it("reports all measured outcomes, unknown costs and pooled latency by arm", () => {
    const row: IntakeReceipt = {
      verdict: "silent",
      reason: "",
      source: "timeout",
      mode: "classify",
      model: "typesafe/jev-1.13.0",
      gen: 1,
      threadKey: "slack:C:1",
      decidedAt: 1,
      experiment: {
        id: "trial",
        messageKey: "C:2",
        arm: "jev",
        elapsedMs: 1000,
        calls: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        knownCostUsd: 0,
        unpricedCalls: 1,
        missingUsageCalls: 1,
      },
    };
    const report = intakeExperimentReport(
      [
        row,
        {
          ...row,
          source: "model",
          experiment: {
            ...row.experiment!,
            elapsedMs: 100,
            unpricedCalls: 0,
            missingUsageCalls: 0,
            knownCostUsd: 0.001,
          },
        },
        { ...row, experiment: { ...row.experiment!, id: "other" } },
      ],
      "trial",
    );
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({
      arm: "jev",
      events: 2,
      threads: 1,
      timeouts: 1,
      p90Ms: 1000,
      knownCostUsd: 0.001,
      unpricedCalls: 1,
      missingUsageCalls: 1,
    });
  });
});
