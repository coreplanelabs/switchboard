import { describe, expect, it } from "vitest";
import type { CompletionRequest, Provider } from "../core/provider.js";
import type { ContentPart } from "../core/chatMessage.js";
import { contextTasks } from "./contextTasks.js";
import { runContextTrial } from "./contextTrials.js";
import { scoreContextTrial } from "./contextEvaluation.js";

const revision = "a".repeat(40);
const call = (id: string, name: string, input: unknown): ContentPart => ({ type: "tool_use", id, name, input });
const output = (text: string): ContentPart => ({ type: "text", text });

/** This model extracts facts from received recall results, not grading labels. */
function reader(taskId: string) {
  const requests: CompletionRequest[] = [];
  let answer: { value: string; source: string };
  let key: string;
  let step = 0;
  const provider: Provider = {
    name: "scripted",
    async complete(request) {
      requests.push(structuredClone(request));
      const usage = { inputTokens: 11, outputTokens: 7 };
      if (step++ === 0)
        return {
          content: [
            call("original", "recall", { turn: 1, ...(taskId === "child-source" ? { source: "parent" } : {}) }),
          ],
          stopReason: "tool_use",
          usage,
        };
      if (step === 2) {
        const result = request.messages.at(-1)!.content[0];
        if (result.type !== "tool_result" || typeof result.content !== "string")
          throw new Error("original result missing");
        const recalled = JSON.parse(result.content) as {
          turn: number;
          source?: string;
          content: Array<{ type: string; text?: string; content?: string }>;
        };
        const text = recalled.content.map((p) => p.text ?? p.content ?? "").join("\n");
        const parsed =
          taskId === "corrected-goal"
            ? text.match(/investigate (\w+) only/)
            : taskId === "original-failure"
              ? text.match(/> (\w+)/)
              : taskId === "rejected-approach"
                ? text.match(/Accepted approach: ([\w-]+)/)
                : text.match(/Authorized receipt: ([\w-]+)/);
        if (!parsed) throw new Error("original source fact missing");
        key =
          taskId === "corrected-goal"
            ? "environment"
            : taskId === "original-failure"
              ? "failure"
              : taskId === "rejected-approach"
                ? "approach"
                : "receipt";
        answer = { value: parsed[1], source: `${recalled.source === "parent" ? "parent:" : ""}turn:${recalled.turn}` };
        if (taskId === "rejected-approach")
          return {
            content: [
              call("save", "notes", {
                text: `Rejected force-rebuild because it loses evidence. Next: ${answer.value}. Source ${answer.source}.`,
              }),
            ],
            stopReason: "tool_use",
            usage,
          };
        if (taskId === "child-source")
          return {
            content: [
              call("outside", "recall", { source: "parent", turn: 2 }),
              call("parent-write", "notes", { source: "parent", text: "replace parent evidence" }),
              call("own-write", "notes", { text: `Authorized receipt ${answer.value}; source ${answer.source}.` }),
            ],
            stopReason: "tool_use",
            usage,
          };
      }
      return { content: [output(JSON.stringify({ facts: { [key]: answer } }))], stopReason: "end_turn", usage };
    },
  };
  return { provider, requests };
}

describe("local context task trials", () => {
  it("retains a failed trial without retrying or exposing provider failure text", async () => {
    let calls = 0;
    const trial = await runContextTrial({
      task: contextTasks()[2],
      provider: {
        name: "scripted",
        complete: async () => {
          calls++;
          throw new Error("SECRET_PROVIDER_DETAIL");
        },
      },
      model: "failing",
      sourceRevision: revision,
      targetRevision: revision,
    });
    expect(calls).toBe(1);
    expect(trial.run.status).toBe("failed");
    expect(trial.run.events.filter((event) => event.type === "notes").at(-1)?.text).toBe(
      "Rejected force-rebuild because it loses evidence. Accepted preserve-and-inspect. Source: turn:1.",
    );
    expect(trial.run.events.find((event) => event.kind === "provider-failed")?.text).toBe(
      "Provider call failed; no retry was attempted.",
    );
    expect(JSON.stringify(trial)).not.toContain("SECRET_PROVIDER_DETAIL");
    expect((await scoreContextTrial(trial)).passed).toBe(false);
    expect((await scoreContextTrial(trial)).tokens).toBeNull();
    expect(trial.run.finishedAt).toBeGreaterThanOrEqual(trial.run.startedAt);
  });

  it("retains observed counters and original tool results when a later provider call aborts", async () => {
    const controller = new AbortController();
    let calls = 0;
    const trial = await runContextTrial({
      task: contextTasks()[1],
      provider: {
        name: "scripted",
        async complete() {
          if (++calls === 1)
            return {
              content: [call("original", "recall", { turn: 1 })],
              stopReason: "tool_use",
              usage: { inputTokens: 11, outputTokens: 7 },
            };
          controller.abort();
          throw new Error("SECRET_ABORT_DETAIL");
        },
      },
      model: "interrupted",
      sourceRevision: revision,
      targetRevision: revision,
      signal: controller.signal,
    });
    expect(calls).toBe(2);
    expect(trial.run.status).toBe("interrupted");
    expect(trial.run.observedUsage).toEqual({
      attemptedCalls: 2,
      reportedCalls: 1,
      complete: false,
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(trial.run.events.find((event) => event.type === "tool_result")?.raw).toContain(
      "Expected staging; received production.",
    );
    expect(JSON.stringify(trial)).not.toContain("SECRET_ABORT_DETAIL");
    expect((await scoreContextTrial(trial)).passed).toBe(false);
    expect((await scoreContextTrial(trial)).tokens).toBeNull();
  });

  it("stamps authored source turns but leaves pure tool-result rows without a human actor", async () => {
    const pure = await runContextTrial({
      task: contextTasks()[1],
      provider: reader("original-failure").provider,
      model: "reader",
      sourceRevision: revision,
      targetRevision: revision,
    });
    expect(pure.run.events.find((event) => event.type === "source_actors")?.raw).toBe("[null,null]");
    const mixed = contextTasks()[1];
    mixed.source[1].content.push({ type: "text", text: "Correction: keep the original failing test." });
    const withSteer = await runContextTrial({
      task: mixed,
      provider: reader("original-failure").provider,
      model: "reader",
      sourceRevision: revision,
      targetRevision: revision,
    });
    expect(withSteer.run.events.find((event) => event.type === "source_actors")?.raw).toBe(
      '[null,"cli:context-owner"]',
    );
    expect((await scoreContextTrial(pure)).passed).toBe(true);
    expect((await scoreContextTrial(withSteer)).passed).toBe(true);
  });

  it("uses original recall results across simulated compaction and context reload", async () => {
    const trials = [];
    for (const task of contextTasks()) {
      const { provider } = reader(task.id);
      trials.push(
        await runContextTrial({
          task,
          provider,
          model: "local-reader",
          sourceRevision: revision,
          targetRevision: revision,
        }),
      );
    }
    expect(trials.map((trial) => JSON.parse(trial.run.events.find((event) => event.type === "answer")!.raw!))).toEqual([
      { facts: { environment: { value: "staging", source: "turn:1" } } },
      { facts: { failure: { value: "retained_correction", source: "turn:1" } } },
      { facts: { approach: { value: "preserve-and-inspect", source: "turn:1" } } },
      { facts: { receipt: { value: "staging-check-17", source: "parent:turn:1" } } },
    ]);
    expect(
      (await Promise.all(trials.map(scoreContextTrial))).map((score) => [score.passed, score.qualification, score.usd]),
    ).toEqual([
      [true, "synthetic", null],
      [true, "synthetic", null],
      [true, "synthetic", null],
      [true, "synthetic", null],
    ]);
    expect(trials[1].run.events.find((event) => event.type === "tool_result")!.raw).toContain(
      "Expected staging; received production.",
    );
    expect(trials[2].run.events.filter((event) => event.type === "notes").at(-1)?.text).toBe(
      "Rejected force-rebuild because it loses evidence. Next: preserve-and-inspect. Source turn:1.",
    );
    expect(trials[2].run.events.find((event) => event.kind === "notes-fenced")?.text).toBe(
      "The stale local notes capability was refused after a simulated generation reload.",
    );
    expect(trials[3].run.events.filter((event) => event.type === "tool_result").map((event) => event.raw)).toContain(
      "no turn 2 in this session's log.",
    );
    expect(trials[3].run.events.filter((event) => event.type === "tool_result").map((event) => event.raw)).toContain(
      "parent notes are a read-only handoff snapshot; write your own notes instead.",
    );
    expect(trials[3].run.events.filter((event) => event.type === "notes").at(-1)?.text).toBe(
      "Authorized receipt staging-check-17; source parent:turn:1.",
    );
    expect((await scoreContextTrial(trials[0])).tokens).toEqual({ input: 22, output: 14, cacheRead: 0, cacheWrite: 0 });
  });

  it("keeps grading labels out of requests and compares actual raw and managed inputs", async () => {
    const task = contextTasks()[0];
    task.expected = { hidden_grading_key: { value: "SECRET_GRADING_CANARY", source: "hidden:label" } };
    task.expectedNotes = ["SECRET_NOTES_CANARY"];
    const managed = reader(task.id);
    const raw = reader(task.id);
    const managedTrial = await runContextTrial({
      task,
      provider: managed.provider,
      model: "local-reader",
      sourceRevision: revision,
      targetRevision: revision,
      arm: "managed",
    });
    const rawTrial = await runContextTrial({
      task,
      provider: raw.provider,
      model: "local-reader",
      sourceRevision: revision,
      targetRevision: revision,
      arm: "raw",
    });
    expect((await scoreContextTrial(managedTrial)).missingFacts).toEqual(["hidden_grading_key"]);
    expect((await scoreContextTrial(rawTrial)).missingFacts).toEqual(["hidden_grading_key"]);
    const requests = JSON.stringify([...managed.requests, ...raw.requests]);
    expect(requests).not.toContain("SECRET_GRADING_CANARY");
    expect(requests).not.toContain("hidden_grading_key");
    expect(requests).not.toContain("SECRET_NOTES_CANARY");
    expect(managed.requests[0].messages).toEqual([
      { role: "user", content: [{ type: "text", text: task.task }] },
      { role: "user", content: [{ type: "text", text: task.task }] },
    ]);
    expect(raw.requests[0].messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Investigate production." }],
    });
    expect(managed.requests[0].system).toContain("exact correction is retained at turn:1");
    expect(raw.requests[0].system).not.toContain("exact correction is retained at turn:1");
  });

  it("fails when an otherwise correct answer discards the rejected approach from saved notes", async () => {
    const task = contextTasks()[2];
    const model = reader(task.id);
    const provider: Provider = {
      name: "scripted",
      async complete(request) {
        const response = await model.provider.complete(request);
        for (const part of response.content) {
          if (part.type === "tool_use" && part.name === "notes") part.input = { text: "Work completed." };
        }
        return response;
      },
    };
    const trial = await runContextTrial({
      task,
      provider,
      model: "local-reader",
      sourceRevision: revision,
      targetRevision: revision,
    });
    expect(trial.run.events.filter((event) => event.type === "notes").at(-1)?.text).toBe("Work completed.");
    const score = await scoreContextTrial(trial);
    expect(score.wrongFacts).toEqual([]);
    expect(score.passed).toBe(false);
  });

  it("caps provider turns and preserves unknown usage when a provider omits counters", async () => {
    const provider: Provider = {
      name: "scripted",
      complete: async () => ({ content: [call("again", "recall", { turn: 1 })], stopReason: "tool_use" }),
    };
    const trial = await runContextTrial({
      task: contextTasks()[0],
      provider,
      model: "loop",
      sourceRevision: revision,
      targetRevision: revision,
      maxTurns: 2,
    });
    expect(trial.run.status).toBe("stopped_cap");
    expect(trial.run.events.filter((event) => event.type === "tool_result").length).toBe(2);
    expect((await scoreContextTrial(trial)).tokens).toBeNull();
    expect((await scoreContextTrial(trial)).completed).toBe(false);
  });
});
