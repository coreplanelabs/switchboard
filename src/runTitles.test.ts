// Feature: docs/reference/specs/live-view.md — background titles and prompt fallback.
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAppConfigText } from "./config.js";
import { ProviderFailure, type CompletionRequest, type Provider } from "./core/provider.js";
import { runTitleGenerator, type TitleDiagnostic } from "./runTitles.js";
import { testRegistry } from "./core/runRegistry/testing.js";
import { createRunEnding } from "./core/runEnding.js";
import { interruptedRunRecord, assembleRunRecord } from "./core/dispatch/record.js";
import type { RunRecord } from "./core/runRecord.js";
import type { IndexEvent } from "./core/runRegistry/indexFeed.js";
import { assignRunLiveState } from "./core/runLiveState.js";

const meta = { agent: "general", channelId: "web:test", userId: "access:test", threadKey: "web:test:thread" };
const config = () =>
  parseAppConfigText(
    "organization: test\nproviders:\n  openai:\n    wire: openai-responses\ndefaults:\n  agent: general\n  models:\n    general: openai/gpt-6.1-sol\n",
  );
const table = (provider: Provider) => ({ get: () => provider, names: () => [provider.name] });
afterEach(() => vi.useRealTimers());

describe("Run titles", () => {
  it.each([
    {
      source: "created",
      expected: [
        ["run_state", 1],
        ["run_title", 2],
      ],
    },
    {
      source: "input",
      expected: [
        ["run_state", 2],
        ["run_title", 3],
      ],
    },
    {
      source: "replayed",
      expected: [
        ["run_state", 8],
        ["run_title", 9],
      ],
    },
    {
      source: "hosted",
      expected: [
        ["run_state", 1],
        ["run_title", 2],
      ],
    },
  ])("keeps a completed title behind an in-flight durable state write ($source)", async ({ source, expected }) => {
    const { reg } = testRegistry();
    let titleReady!: (title: string) => void;
    reg.configureTitles(
      () =>
        new Promise((resolve) => {
          titleReady = resolve;
        }),
    );
    const run = reg.create(
      "label",
      {
        ...meta,
        ...(source === "created" || source === "hosted" ? { prompt: "Inspect deployment" } : {}),
        ...(source === "hosted" ? { hosted: true as const } : {}),
      },
      source === "replayed"
        ? { replay: [{ type: "input", text: "Inspect deployment", messageId: "first", seq: 7 }] }
        : {},
    );
    if (source === "input") reg.publish(run.id, { type: "input", text: "Inspect deployment", messageId: "first" });
    const events = reg.eventLane(run.id);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const write = events.write(async () => {
      const sequence = reg.getById(run.id)!.eventCount + 1;
      const assigned = assignRunLiveState(undefined, 0, {
        expectedSeq: 0,
        state: "admitted",
        at: 1000,
        bound: 5000,
        detail: "waiting",
      });
      if (!assigned.ok || !assigned.event) throw new Error("assignment failed");
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      expect(
        reg.commitLiveState(run.id, {
          ...assigned,
          event: { ...assigned.event, seq: sequence },
          liveStateSeq: sequence,
        }),
      ).toBe(true);
    });
    await waiting;
    titleReady("Inspect deployment");
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await write;
    await reg.titleSettled(run.id);
    expect(
      reg
        .snapshotById(run.id)!
        .events.filter((event) => event.type === "run_state" || event.type === "run_title")
        .map((event) => [event.type, event.seq]),
    ).toEqual(expected);
    expect(reg.getById(run.id)).toMatchObject({ title: "Inspect deployment", liveState: { state: "admitted" } });
  });
  it.each(["sealed", "discarded", "replaced"])("does not publish a late title into a %s run", async (ending) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const { reg } = testRegistry();
      let ready!: (title: string) => void;
      reg.configureTitles(
        () =>
          new Promise((resolve) => {
            ready = resolve;
          }),
      );
      const run = reg.create("old", { ...meta, prompt: "Old request" });
      await Promise.resolve();
      const settled = reg.titleSettled(run.id);
      if (ending === "sealed") {
        reg.finish(run.id);
        reg.seal(run.id);
      }
      if (ending === "discarded") reg.discard(run.id);
      if (ending === "replaced") reg.create("replacement", { ...meta, prompt: "Replacement request" }, { id: run.id });
      ready("Old title");
      await settled;
      expect(reg.getById(run.id)?.title).toBeUndefined();
      reg.configureTitles(async () => "Fresh title");
      const fresh = reg.create("fresh", { ...meta, prompt: "Fresh request" });
      await reg.titleSettled(fresh.id);
      expect(reg.getById(fresh.id)).toMatchObject({ prompt: "Fresh request", title: "Fresh title" });
      expect(
        info.mock.calls.map(([line]) => JSON.parse(line)).filter((event) => event.event === "run.title.dropped"),
      ).toEqual([
        {
          event: "run.title.dropped",
          runId: "id-1",
          ms: 0,
          queueMs: 0,
          reason: ending === "discarded" ? "missing" : ending,
        },
      ]);
    } finally {
      info.mockRestore();
    }
  });
  it.each(["generation", "publication"] as const)(
    "reports a %s title-job failure without raw errors and keeps the run usable",
    async (stage) => {
      const { reg } = testRegistry();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const publish = reg.publish.bind(reg);
      const publication = vi.spyOn(reg, "publish").mockImplementation((id, event) => {
        if (stage === "publication" && id === "id-1" && event.type === "run_title")
          throw new TypeError("private publication payload");
        publish(id, event);
      });
      try {
        reg.configureTitles(async () => {
          if (stage === "generation") throw new Error("private title job payload");
          return "Inspect deployment";
        });
        const failed = reg.create("label", { ...meta, prompt: "Inspect deployment" });
        await reg.titleSettled(failed.id);
        reg.finish(failed.id, "completed");
        expect(reg.getById(failed.id)).toMatchObject({ prompt: "Inspect deployment", status: "completed" });
        reg.configureTitles(async () => "Check deployment");
        const next = reg.create("next", { ...meta, prompt: "Check deployment" });
        await reg.titleSettled(next.id);
        expect(reg.getById(next.id)?.title).toBe("Check deployment");
        expect(warn.mock.calls).toEqual([
          [
            JSON.stringify({
              event: "run.title.job_failed",
              runId: "id-1",
              stage,
              errorKind: stage === "generation" ? "error" : "type_error",
            }),
          ],
        ]);
      } finally {
        warn.mockRestore();
        publication.mockRestore();
      }
    },
  );
  it("reports generation and publication-queue time separately when a state write delays the title", async () => {
    const { reg, tick } = testRegistry();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      let ready!: (title: string) => void;
      reg.configureTitles(() => new Promise((resolve) => (ready = resolve)));
      const run = reg.create("label", { ...meta, prompt: "Inspect deployment" });
      await Promise.resolve();
      let release!: () => void;
      const write = reg.eventLane(run.id).write(() => new Promise<void>((resolve) => (release = resolve)));
      await Promise.resolve();
      tick(20);
      ready("Inspect deployment");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      tick(7);
      release();
      await write;
      await reg.titleSettled(run.id);
      expect(reg.getById(run.id)?.title).toBe("Inspect deployment");
      expect(info.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
        { event: "run.title.saved", runId: "id-1", ms: 20, queueMs: 7 },
      ]);
    } finally {
      info.mockRestore();
    }
  });
  it("reports a closed failure reason without request text or provider errors", async () => {
    const { reg } = testRegistry();
    const diagnostics: TitleDiagnostic[] = [];
    let broken = true;
    let now = 1000;
    const generate = runTitleGenerator(
      config(),
      table({
        name: "openai",
        complete: async () => {
          now += 23;
          if (broken) throw new Error("private provider payload and credentials");
          return { stopReason: "end_turn", content: [{ type: "text", text: "Inspect deployment" }] };
        },
      }),
      (diagnostic) => diagnostics.push(diagnostic),
      () => now,
    );
    reg.configureTitles(generate);
    const failed = reg.create("failed", { ...meta, prompt: "private request" });
    await reg.titleSettled(failed.id);
    expect(reg.getById(failed.id)).toMatchObject({ prompt: "private request" });
    broken = false;
    const next = reg.create("next", { ...meta, prompt: "Inspect deployment" });
    await reg.titleSettled(next.id);
    expect(reg.getById(next.id)?.title).toBe("Inspect deployment");
    expect(diagnostics).toEqual([
      {
        event: "run.title.failed",
        outcome: "failed",
        reason: "provider_error",
        stage: "generation",
        model: "openai/gpt-6-luna",
        runId: "id-1",
        providerInvoked: true,
        sendAttempts: 0,
        errorKind: "error",
        ms: 23,
      },
      {
        event: "run.title.generated",
        outcome: "generated",
        reason: "generated",
        stage: "generation",
        model: "openai/gpt-6-luna",
        runId: "id-2",
        providerInvoked: true,
        sendAttempts: 0,
        stopReason: "end_turn",
        outputChars: 18,
        ms: 23,
      },
    ]);
  });
  it("keeps a safe title failure diagnostic in the finished run stream", async () => {
    const { reg } = testRegistry();
    const generate = runTitleGenerator(
      config(),
      table({
        name: "openai",
        complete: async () => {
          throw new Error("private provider response");
        },
      }),
      () => {},
      () => 1000,
    );
    reg.configureTitles(generate);
    const run = reg.create("label", { ...meta, prompt: "private request" });
    reg.finish(run.id, "completed");

    await reg.titleSettled(run.id);

    const diagnostic = reg.snapshotById(run.id)?.events.find((event) => event.type === "run_title_diagnostic");
    expect(diagnostic).toMatchObject({
      type: "run_title_diagnostic",
      outcome: "failed",
      reason: "provider_error",
      model: "openai/gpt-6-luna",
      stage: "generation",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private request");
    expect(JSON.stringify(diagnostic)).not.toContain("private provider response");
    expect(reg.seal(run.id).events).toContainEqual({
      type: "run_title_diagnostic",
      outcome: "failed",
      reason: "provider_error",
      model: "openai/gpt-6-luna",
      stage: "generation",
      providerInvoked: true,
      sendAttempts: 0,
      errorKind: "error",
      ms: 0,
      seq: 1,
      at: 1000,
    });
  });
  it("retains the title provider's request, usage and price beside a generated title", async () => {
    const { reg } = testRegistry();
    let now = 1000;
    const priced = {
      ...config(),
      costs: {
        prices: {
          "openai/gpt-6-luna": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
        },
      },
    };
    reg.configureTitles(
      runTitleGenerator(
        priced,
        table({
          name: "openai",
          complete: async (request) => {
            await request.beforeSend?.();
            now += 7;
            request.observer?.onHttpResponse?.(200, "req_123");
            now += 10;
            return {
              stopReason: "end_turn",
              content: [{ type: "text", text: "Review the patch" }],
              usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2 },
            };
          },
        }),
        () => {},
        () => now,
      ),
    );
    const run = reg.create("label", { ...meta, prompt: "private request" });

    await reg.titleSettled(run.id);

    const events = reg.snapshotById(run.id)?.events ?? [];
    expect(events).toMatchObject([
      {
        type: "run_title_diagnostic",
        outcome: "generated",
        reason: "generated",
        model: "openai/gpt-6-luna",
        providerInvoked: true,
        sendAttempts: 1,
        requestId: "req_123",
        responseMs: 7,
        providerStatus: 200,
        stopReason: "end_turn",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        priceSource: "operator",
        usd: 0.000053,
        outputChars: 16,
        ms: 17,
        seq: 1,
      },
      { type: "run_title", title: "Review the patch", seq: 2 },
    ]);
    expect(JSON.stringify(events[0])).not.toContain("private request");
    expect(JSON.stringify(events[0])).not.toContain("Review the patch");
  });
  it("retains a typed provider failure and request ID without its response text", async () => {
    const { reg } = testRegistry();
    let now = 1000;
    reg.configureTitles(
      runTitleGenerator(
        config(),
        table({
          name: "openai",
          complete: async (request) => {
            await request.beforeSend?.();
            now += 3;
            request.observer?.onHttpResponse?.(429, "req_429\nprivate provider response");
            now += 5;
            throw new ProviderFailure("rate-limited", {
              status: 429,
              provider: "openai",
              model: "gpt-6-luna",
              diagnostic: { message: "private provider response" },
            });
          },
        }),
        () => {},
        () => now,
      ),
    );
    const run = reg.create("label", { ...meta, prompt: "private request" });

    await reg.titleSettled(run.id);

    const diagnostic = reg.snapshotById(run.id)?.events.find((event) => event.type === "run_title_diagnostic");
    expect(diagnostic).toMatchObject({
      type: "run_title_diagnostic",
      outcome: "failed",
      reason: "provider_error",
      providerInvoked: true,
      sendAttempts: 1,
      requestId: "req_429",
      responseMs: 3,
      providerCause: "rate-limited",
      providerStatus: 429,
      errorKind: "error",
      ms: 8,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private request");
    expect(JSON.stringify(diagnostic)).not.toContain("private provider response");
  });
  it.each([
    { stopReason: "max_tokens" as const, text: "", reason: "incomplete_output", invalidOutputKind: undefined },
    { stopReason: "end_turn" as const, text: "Bad\nTitle", reason: "invalid_output", invalidOutputKind: "format" },
  ])("records the title model's $reason result without raw output", async (answer) => {
    const { reg } = testRegistry();
    reg.configureTitles(
      runTitleGenerator(
        config(),
        table({
          name: "openai",
          complete: async () => ({ stopReason: answer.stopReason, content: [{ type: "text", text: answer.text }] }),
        }),
        () => {},
      ),
    );
    const run = reg.create("label", { ...meta, prompt: "Inspect deployment" });

    await reg.titleSettled(run.id);

    const diagnostic = reg.snapshotById(run.id)?.events.find((event) => event.type === "run_title_diagnostic");
    expect(diagnostic).toMatchObject({
      type: "run_title_diagnostic",
      outcome: "failed",
      reason: answer.reason,
      stopReason: answer.stopReason,
      ...(answer.invalidOutputKind ? { invalidOutputKind: answer.invalidOutputKind } : {}),
    });
    expect(JSON.stringify(diagnostic)).not.toContain("Bad\nTitle");
  });
  it("records when the configured title model has no provider", async () => {
    const { reg } = testRegistry();
    const noOpenAiProvider = { ...config(), providers: {} };
    reg.configureTitles(
      runTitleGenerator(
        noOpenAiProvider,
        table({
          name: "openai",
          complete: async () => {
            throw new Error("must not be called");
          },
        }),
        () => {},
      ),
    );
    const run = reg.create("label", { ...meta, prompt: "Inspect deployment" });

    await reg.titleSettled(run.id);

    const diagnostic = reg.snapshotById(run.id)?.events.find((event) => event.type === "run_title_diagnostic");
    expect(diagnostic).toMatchObject({
      type: "run_title_diagnostic",
      outcome: "skipped",
      reason: "model_unavailable",
      stage: "configuration",
    });
  });
  it("keeps runs without title generation free of title diagnostics", async () => {
    const { reg } = testRegistry();
    const run = reg.create("label", { ...meta, prompt: "Inspect deployment" });

    await reg.titleSettled(run.id);

    expect(reg.getById(run.id)).toMatchObject({ id: run.id, label: "label", eventCount: 0 });
    expect(reg.snapshotById(run.id)?.events).toEqual([]);
  });
  it("times saved titles and counts pending and completed jobs at the post-reply seal", async () => {
    const { reg, tick } = testRegistry();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      reg.configureTitles(async () => {
        tick(20);
        return "Inspect deployment";
      });
      const fast = reg.create("fast", { ...meta, prompt: "Inspect deployment" });
      await reg.titleSettled(fast.id);
      const fastEnding = createRunEnding({ registry: reg });
      reg.finish(fast.id, "completed");
      fastEnding.finished(fast.id);
      await fastEnding.sealAfterReply(
        async () => {},
        async () => {},
      );

      let ready!: (title: string) => void;
      reg.configureTitles(() => new Promise((resolve) => (ready = resolve)));
      const slow = reg.create("slow", { ...meta, prompt: "Check deployment" });
      await Promise.resolve();
      const slowEnding = createRunEnding({ registry: reg });
      reg.finish(slow.id, "completed");
      slowEnding.finished(slow.id);
      let replied = false;
      const end = slowEnding.sealAfterReply(
        async () => {},
        async () => {
          replied = true;
        },
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(replied).toBe(true);
      expect(reg.getById(slow.id)?.sealedAt).toBeUndefined();
      tick(17);
      ready("Check deployment");
      await end;
      expect(reg.getById(slow.id)).toMatchObject({ title: "Check deployment", replyOk: true, sealedAt: 1037 });
      const untitled = reg.create("No display prompt", meta);
      const untitledEnding = createRunEnding({ registry: reg });
      reg.finish(untitled.id, "completed");
      untitledEnding.finished(untitled.id);
      await untitledEnding.sealAfterReply(
        async () => {},
        async () => {},
      );
      expect(info.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
        { event: "run.title.saved", runId: "id-1", ms: 20, queueMs: 0 },
        { event: "run.title.seal_wait", runId: "id-1", pending: false, ms: 0 },
        { event: "run.title.saved", runId: "id-2", ms: 17, queueMs: 0 },
        { event: "run.title.seal_wait", runId: "id-2", pending: true, ms: 17 },
        { event: "run.title.seal_wait", runId: "id-3", pending: false, ms: 0 },
      ]);
    } finally {
      info.mockRestore();
    }
  });
  it("shows the full prompt immediately and persists a title that finishes after the reply", async () => {
    const { reg } = testRegistry();
    let complete!: (title: string) => void;
    let calls = 0;
    reg.configureTitles(async () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const prompt = "Check the release. Then inspect every deployment and explain the remaining work. ".repeat(6);
    const changes: IndexEvent[] = [];
    reg.subscribeIndex((event) => changes.push(event));
    const run = reg.create("legacy label", { ...meta, prompt });
    expect(reg.getById(run.id)?.prompt).toBe(prompt);
    const ending = createRunEnding({ registry: reg });
    const snap = reg.snapshotById(run.id)!;
    const initial = interruptedRunRecord(reg.getById(run.id)!, snap, 2000);
    let record: RunRecord | undefined;
    ending.register({
      runId: run.id,
      flipOnPostFinishFailure: true,
      write: (seal) => {
        record = assembleRunRecord({
          ...initial,
          run,
          snap,
          msg: meta,
          channelVisibility: "public",
          status: "completed",
          seal,
        });
      },
    });
    reg.finish(run.id, "completed");
    ending.finished(run.id);
    let replied = false;
    const end = ending.sealAfterReply(
      async () => {},
      async () => {
        replied = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(replied).toBe(true);
    complete("Check release deployment");
    await end;
    expect(record).toMatchObject({ prompt, title: "Check release deployment" });
    expect(reg.getById(run.id)?.replyOk).toBe(true);
    expect(changes.filter((e) => e.type === "upsert").at(-1)).toMatchObject({
      run: { title: "Check release deployment" },
    });
    expect(calls).toBe(1);
  });

  it("replays saved titles without another model call and keeps the original prompt on follow-ups", async () => {
    const { reg } = testRegistry();
    let calls = 0;
    reg.configureTitles(async () => {
      calls++;
      return "Wrong new title";
    });
    const run = reg.create("label", meta, {
      replay: [
        { type: "input", text: "Repair the build", messageId: "first", seq: 1 },
        { type: "run_title", title: "Repair build", seq: 2 },
      ],
    });
    reg.publish(run.id, { type: "input", text: "Also check lint", messageId: "second" });
    await reg.titleSettled(run.id);
    expect(reg.getById(run.id)).toMatchObject({ prompt: "Repair the build", title: "Repair build" });
    expect(calls).toBe(0);
  });

  it("uses the cheap configured model with bounded input and no tools", async () => {
    const requests: CompletionRequest[] = [];
    const generate = runTitleGenerator(
      config(),
      table({
        name: "openai",
        complete: async (request) => {
          requests.push(request);
          return { stopReason: "end_turn", content: [{ type: "text", text: "Inspect deployment" }] };
        },
      }),
    );
    expect(await generate("Inspect deployment ".repeat(500))).toBe("Inspect deployment");
    expect(requests[0]).toMatchObject({ model: "gpt-6-luna", maxTokens: 256, effort: "low" });
    expect(JSON.stringify(requests[0].messages).length).toBeLessThan(1100);
    expect(requests[0].tools).toBeUndefined();
    expect(await generate("Already stopped", AbortSignal.abort())).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it("times out once and retains the prompt without blocking a reply or using another model", async () => {
    vi.useFakeTimers();
    const { reg } = testRegistry();
    let calls = 0;
    reg.configureTitles(
      runTitleGenerator(
        config(),
        table({
          name: "openai",
          complete: async () => {
            calls++;
            return new Promise(() => {});
          },
        }),
      ),
    );
    const run = reg.create("label", { ...meta, prompt: "Inspect deployment" });
    await vi.advanceTimersByTimeAsync(10_000);
    await reg.titleSettled(run.id);
    reg.publish(run.id, { type: "input", text: "New request", messageId: "next" });
    expect(reg.getById(run.id)).toMatchObject({ prompt: "Inspect deployment" });
    expect(reg.getById(run.id)?.title).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("does not send a private main request to the title model", async () => {
    const { reg } = testRegistry();
    let calls = 0;
    reg.configureTitles(async () => {
      calls++;
      return "Inspect deployment";
    });
    const privateRun = reg.create("main · private conversation", {
      ...meta,
      agent: "orchestrator",
      privateConversation: true,
      prompt: "Private plan",
    });
    reg.publish(privateRun.id, { type: "input", text: "Private plan", messageId: "private" });
    const publicRun = reg.create("public", { ...meta, prompt: "Inspect deployment" });
    await reg.titleSettled(publicRun.id);
    expect(reg.getById(privateRun.id)?.prompt).toBe("Private request");
    expect(reg.getById(publicRun.id)?.title).toBe("Inspect deployment");
    expect(calls).toBe(1);
  });
});
