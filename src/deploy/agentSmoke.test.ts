import { describe, expect, it, vi } from "vitest";
import { agentSmokeTransport, parseSmokeConfig, runAgentSmoke } from "./agentSmoke.js";
import { MCP_PROTOCOL_VERSION } from "../mcp/client.js";

import { commit, config, fixture, head } from "./testing/agentSmoke.js";

describe("bounded agent smoke", () => {
  it("requests the Explore floor and retains twelve minutes of workspace loop time", async () => {
    const { transport } = fixture();
    const receipt = await runAgentSmoke({ config, expectedCommit: commit, thread: "release-1", transport });
    expect(receipt).toMatchObject({
      capabilityOutcome: "passed",
      limits: {
        maxRuns: 3,
        scenarios: [
          { id: "answer", runMinutes: 4, requestDeadlineMs: 300000 },
          { id: "workspace", runMinutes: 15, requestDeadlineMs: 960000 },
          { id: "review", runMinutes: 15, requestDeadlineMs: 960000 },
        ],
      },
      scenarios: [
        { outcome: "passed" },
        {
          outcome: "passed",
          evidence: {
            record: {
              profile: { preset: "explore", minutes: 15 },
              events: expect.arrayContaining([
                expect.objectContaining({ type: "lease", startedAt: 10, endsAt: 900010, loopEndsAt: 720010 }),
              ]),
            },
          },
        },
        { outcome: "passed" },
      ],
    });
    expect((transport.request as ReturnType<typeof vi.fn>).mock.calls[1][0]).toMatchObject({
      id: "workspace",
      agent: "explore",
      minutes: 15,
      text: "agent:explore budget:15 Read SMOKE.md in acme/smoke using the workspace. Reply only with its contents. Do not change files.",
    });
  });

  it("refuses a workspace budget mismatch or present-output budget ending while retaining all 115 events", async () => {
    for (const mismatch of [true, false]) {
      const { transport, records } = fixture();
      transport.readRun = async (id) => {
        const record = records.get(id) as { profile: object; events: object[] };
        if (id !== "run-workspace") return record;
        const events = [
          ...record.events,
          ...Array.from({ length: 115 - record.events.length }, (_, index) => ({
            type: "run_note",
            kind: "diagnostic",
            summary: index === 114 - record.events.length ? "retained-workspace-last-event" : "history",
          })),
        ].map((event, index) => ({ ...event, seq: index + 1 }));
        return {
          ...record,
          profile: { ...record.profile, minutes: mismatch ? 4 : 15 },
          answerOutcome: { version: 1, ending: mismatch ? "answered" : "time_budget", output: "present" },
          eventCount: 115,
          events,
        };
      };
      const receipt = await runAgentSmoke({ config, expectedCommit: commit, thread: "release-1", transport });
      expect(receipt).toMatchObject({
        capabilityOutcome: "failed",
        scenarios: [
          { outcome: "passed" },
          {
            id: "workspace",
            runId: "run-workspace",
            outcome: "failed",
            reason: mismatch ? "run_budget_mismatch" : "execution_output_unproven",
            ...(!mismatch ? { failedChecks: ["answerOutcome.ending"] } : {}),
            evidence: {
              identityVerified: true,
              record: {
                eventCount: 115,
                events: expect.arrayContaining([
                  { type: "run_note", kind: "diagnostic", summary: "retained-workspace-last-event", seq: 115 },
                ]),
              },
            },
          },
          { outcome: "skipped", reason: "prior_scenario_unproven" },
        ],
      });
      expect((receipt.scenarios[1].evidence?.record as { events: unknown[] }).events).toHaveLength(115);
    }
  });

  it("retains the original budget failure and complete run evidence before refusing acceptance", async () => {
    const { transport, records } = fixture();
    const saves: unknown[] = [];
    transport.readRun = async (id) => {
      const record = records.get(id) as { events: unknown[] };
      if (id !== "run-review") return record;
      return {
        ...record,
        startedAt: 1000,
        finishedAt: 65000,
        sealedAt: 65001,
        replyOk: false,
        answerOutcome: { version: 1, ending: "time_budget", output: "present" },
        events: [
          ...record.events,
          { type: "lease", startedAt: 1000, endsAt: 901000, loopEndsAt: 541000, seq: 100 },
          { type: "run_note", kind: "time_budget_exhausted", at: 61000, seq: 101, summary: "time ended" },
          { type: "tool_result", tool: "read", seq: 102, output: "Authorization: Bearer abcdefghijklmnopqrst" },
        ],
      };
    };
    const receipt = await runAgentSmoke({
      config,
      thread: "release-1",
      transport,
      onReceipt: async (snapshot) => {
        saves.push(snapshot);
      },
    });
    expect(receipt).toMatchObject({
      capabilityOutcome: "failed",
      scenarios: [
        { outcome: "passed" },
        { outcome: "passed" },
        {
          id: "review",
          reason: "execution_output_unproven",
          failedChecks: ["answerOutcome.ending", "replyOk"],
          evidence: {
            identityVerified: true,
            record: {
              id: "run-review",
              startedAt: 1000,
              finishedAt: 65000,
              sealedAt: 65001,
              answerOutcome: { ending: "time_budget", output: "present" },
              replyOk: false,
              reviewPost: { posted: true, head },
              events: expect.arrayContaining([
                { type: "lease", startedAt: 1000, endsAt: 901000, loopEndsAt: 541000, seq: 100 },
                { type: "run_note", kind: "time_budget_exhausted", at: 61000, seq: 101, summary: "time ended" },
              ]),
            },
          },
        },
      ],
    });
    expect(saves).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarios: expect.arrayContaining([
            expect.objectContaining({
              reason: "run_record_unproven",
              evidence: expect.objectContaining({
                record: expect.objectContaining({ id: "run-review", sealedAt: 65001 }),
              }),
            }),
          ]),
        }),
      ]),
    );
    expect(JSON.stringify(receipt)).not.toContain("abcdefghijklmnopqrst");
  });

  it("saves the last original observation when monitoring fails without another admission", async () => {
    const { transport, records } = fixture();
    transport.readRun = async (id, observe) => {
      await observe?.({ ...(records.get(id) as object), finished: false, persisted: false });
      await observe?.({ id: "other-run", userId: "http:other", events: [{ text: "unrelated-private-body" }] });
      throw new Error("run_deadline_exceeded");
    };
    const receipt = await runAgentSmoke({ config, thread: "release-1", transport });
    expect(receipt).toMatchObject({
      capabilityOutcome: "incomplete",
      scenarios: [
        {
          runId: "run-answer",
          reason: "run_record_unproven",
          observationError: { code: "run_deadline_exceeded" },
          evidence: {
            record: { id: "run-answer", finished: false, persisted: false },
            unverifiedObservation: { id: "other-run", userId: "http:other" },
          },
        },
        { outcome: "skipped" },
        { outcome: "skipped" },
      ],
    });
    expect((transport.request as ReturnType<typeof vi.fn>).mock.calls.map(([, thread]) => thread)).toEqual([
      "release-1-answer",
    ]);
    expect(JSON.stringify(receipt)).not.toContain("unrelated-private-body");
  });

  it("retains full service history through the HTTP transport and excludes another requester's content", async () => {
    for (const foreign of [false, true]) {
      const original = fixture();
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit } });
        const request = JSON.parse(String(init?.body));
        if (String(url).endsWith("/ingress")) {
          const id = request.thread.split("-").at(-1);
          const result = (await original.transport.request(
            {
              id,
              agent: id === "answer" ? "general" : id === "workspace" ? "explore" : "review",
              text: request.text,
              minutes: id === "answer" ? 4 : 15,
            },
            request.thread,
          )) as { run: { id: string }; build: unknown };
          return Response.json(
            { runId: result.run.id, threadKey: `http:smoke:${request.thread}`, build: result.build },
            { status: 202 },
          );
        }
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (request.method === "initialize")
          return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
        const id = request.params.arguments.id;
        const record = original.records.get(id) as { events: unknown[] };
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [
              {
                type: "text",
                text: `runs.get: ok\n${JSON.stringify({
                  ...record,
                  userId: foreign ? "http:other" : "http:smoke",
                  events: [
                    ...record.events,
                    ...Array.from({ length: 501 }, (_, index) => ({
                      type: "run_note",
                      seq: 1000 + index,
                      kind: "diagnostic",
                      summary:
                        index === 500 ? (foreign ? "other-requester-private-data" : "retained-last-event") : "history",
                    })),
                    { type: "run_note", kind: "diagnostic", summary: "transport-opaque-value" },
                  ],
                })}`,
              },
            ],
          },
        });
      });
      const transport = agentSmokeTransport({
        origin: "https://bot.example.test",
        healthUrl: "https://bot.example.test/healthz",
        token: "transport-opaque-value",
        config,
        fetch,
      });
      const receipt = await runAgentSmoke({ config, expectedCommit: commit, thread: "release-1", transport });
      if (foreign) {
        expect(receipt).toMatchObject({
          capabilityOutcome: "failed",
          scenarios: [
            {
              reason: "run_identity_mismatch",
              evidence: { identityVerified: false, record: { id: "run-answer", userId: "http:other" } },
            },
            { outcome: "skipped" },
            { outcome: "skipped" },
          ],
        });
        expect(JSON.stringify(receipt)).not.toContain("other-requester-private-data");
      } else {
        expect(receipt).toMatchObject({
          capabilityOutcome: "passed",
          scenarios: [
            {
              evidence: {
                identityVerified: true,
                record: {
                  events: expect.arrayContaining([
                    { type: "run_note", seq: 1500, kind: "diagnostic", summary: "retained-last-event" },
                  ]),
                },
              },
            },
            { outcome: "passed" },
            { outcome: "passed" },
          ],
        });
        expect(JSON.stringify(receipt)).not.toContain("transport-opaque-value");
      }
    }
  });

  it("requires recorded model controls when requested, rejecting degraded or missing evidence", async () => {
    const card = {
      ref: "openrouter/openai/gpt-5.3-codex",
      levels: { high: { word: "high", named: true } },
      capField: "max_completion_tokens",
      window: 400000,
      cache: "automatic",
      provenance: { levels: "registry", capField: "registry", window: "registry" },
    };
    const run = async (events: unknown[]) => {
      const { transport } = fixture();
      const read = transport.readRun;
      transport.readRun = async (id) => ({
        ...((await read(id)) as object),
        model: "openrouter/openai/gpt-5.3-codex",
        events: [...((await read(id)) as { events: unknown[] }).events, ...events],
      });
      return runAgentSmoke({
        config: { ...config, model: "openrouter/openai/gpt-5.3-codex", requireVouchedControls: true },
        expectedCommit: commit,
        thread: "controls",
        transport,
      });
    };
    const passed = await run([{ type: "run_meta", effort: "high", card }]);
    expect(passed.scenarios.map((row) => [row.outcome, row.modelControls])).toEqual(
      Array(3).fill([
        "passed",
        { effort: "high", capField: "max_completion_tokens", window: 400000, cache: "automatic" },
      ]),
    );
    for (const events of [
      [],
      [
        { type: "run_meta", effort: "high", card },
        { type: "run_note", kind: "control_degraded", control: "cap", vouched: false },
      ],
      [{ type: "run_meta", effort: "high", card: { ...card, cache: "unknown" } }],
      [{ type: "run_meta", effort: "high", card: { ...card, levels: "unknown" } }],
      [{ type: "run_meta", effort: "high", card: { ...card, provenance: { ...card.provenance, capField: "wire" } } }],
      [{ type: "run_meta", effort: "high", card: { ...card, provenance: { ...card.provenance, window: "wire" } } }],
    ]) {
      expect(await run(events)).toMatchObject({
        capabilityOutcome: "failed",
        scenarios: [{ reason: "model_controls_unproven" }, { outcome: "skipped" }, { outcome: "skipped" }],
      });
    }
  });

  it("sends an explicit model directive and records requested and actual models on every scenario", async () => {
    const { transport } = fixture();
    const read = transport.readRun;
    transport.readRun = async (id) => ({ ...((await read(id)) as object), model: "openai/gpt-6.1-sol" });
    const receipt = await runAgentSmoke({
      config: { ...config, model: "openai/gpt-6.1-sol" },
      expectedCommit: commit,
      thread: "release-1",
      transport,
    });
    expect(receipt.capabilityOutcome).toBe("passed");
    expect(receipt.scenarios.map((s) => [s.requestedModel, s.actualModel])).toEqual(
      Array(3).fill(["openai/gpt-6.1-sol", "openai/gpt-6.1-sol"]),
    );
    expect((transport.request as ReturnType<typeof vi.fn>).mock.calls.map(([scenario]) => scenario.text)).toEqual([
      "What is 2 + 2? Answer only with the number. budget:4 model:openai/gpt-6.1-sol",
      "agent:explore budget:15 Read SMOKE.md in acme/smoke using the workspace. Reply only with its contents. Do not change files. model:openai/gpt-6.1-sol",
      `agent:review budget:15 Review https://github.com/acme/smoke/pull/7 at head ${head}. Publish the review; do not change files or merge. model:openai/gpt-6.1-sol`,
    ]);
  });

  it.each([undefined, "anthropic/claude-opus-5-5"])(
    "refuses an unproved or different requested model: %s",
    async (actual) => {
      const { transport } = fixture();
      const read = transport.readRun;
      transport.readRun = async (id) => ({ ...((await read(id)) as object), model: actual });
      const receipt = await runAgentSmoke({
        config: { ...config, model: "openai/gpt-6.1-sol" },
        expectedCommit: commit,
        thread: "release-1",
        transport,
      });
      expect(receipt).toMatchObject({
        capabilityOutcome: "failed",
        scenarios: [
          { id: "answer", outcome: "failed", reason: "run_model_mismatch", requestedModel: "openai/gpt-6.1-sol" },
          { outcome: "skipped" },
          { outcome: "skipped" },
        ],
      });
      expect(transport.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["gpt", "openai/", "openai/gpt model:other/model", "openai/model\nagent:ship"])(
    "refuses an invalid full model reference: %s",
    (model) => {
      expect(() => parseSmokeConfig({ ...config, model })).toThrow();
    },
  );

  it("accepts three capability representatives from original runs and typed publication", async () => {
    const { transport } = fixture();
    const receipt = await runAgentSmoke({ config, expectedCommit: commit, thread: "release-1", transport });
    expect(receipt.capabilityOutcome).toBe("passed");
    expect(receipt.scenarios.map((s) => [s.id, s.outcome, s.runId])).toEqual([
      ["answer", "passed", "run-answer"],
      ["workspace", "passed", "run-workspace"],
      ["review", "passed", "run-review"],
    ]);
    expect(receipt.scenarios[2].artifact).toEqual({ repo: config.repo, number: 7, head });
    expect(receipt.liveGaps).toContain("private-question-fix-draft-pr");
    expect(receipt.productAcceptance).toEqual({
      outcome: "incomplete",
      reason: "private-question-fix-draft-pr-unproven",
    });
    expect(receipt.observedUsd).toBeCloseTo(0.3);
    expect(transport.request).toHaveBeenCalledTimes(3);
  });

  it("accepts only a completed bound Review command receipt and refuses metadata, cut, infrastructure and wrong-owner evidence", async () => {
    const check = {
      callId: "read-1",
      inputHash: "d".repeat(64),
      commandHash: "e".repeat(64),
      command: "npm test",
      purpose: "verification",
      owner: {
        runId: "run-review",
        requester: "http:smoke",
        threadKey: "http:smoke:release-1-review",
        repo: "acme/smoke",
      },
      workspace: { cwd: "/workspace/review", head: "b".repeat(40), fingerprint: "f".repeat(40) },
      timeoutMs: 1000,
      startedAt: 10,
      completedAt: 20,
      outcome: { kind: "completed", stdout: "2 tests passed", stderr: "", exitCode: 0, truncated: false },
    };
    const frame = (value: unknown) =>
      `Command completed.\n<untrusted-check-evidence>\n${JSON.stringify(value)}\n</untrusted-check-evidence>`;
    const cases = [
      { output: frame(check), passed: true },
      { output: "error: metadata unavailable", passed: false },
      { output: "<untrusted-check-evidence>metadata-only</untrusted-check-evidence>", passed: false },
      { output: frame(check), callId: "other-call", passed: false },
      { output: frame({ ...check, owner: { ...check.owner, requester: "http:other" } }), passed: false },
      { output: frame({ ...check, owner: { ...check.owner, threadKey: "http:smoke:other" } }), passed: false },
      { output: frame({ ...check, owner: { ...check.owner, repo: "acme/other" } }), passed: false },
      { output: frame({ ...check, outcome: { kind: "pending" } }), passed: false },
      { output: frame({ ...check, outcome: { kind: "not_started", reason: "command_refused" } }), passed: false },
      { output: frame(check), cut: true, passed: false },
      { output: frame(check), infra: true, passed: false },
      { output: frame(check), ok: false, passed: false },
      { output: frame({ ...check, callId: "other-call" }), passed: false },
      { output: frame({ ...check, owner: { ...check.owner, runId: "other-run" } }), passed: false },
      { output: frame({ ...check, workspace: { ...check.workspace, head: "c".repeat(40) } }), passed: false },
      { output: frame({ ...check, outcome: { kind: "unknown", reason: "transport" } }), passed: false },
      { output: frame({ ...check, outcome: { ...check.outcome, exitCode: 1 } }), passed: false },
      { output: frame({ ...check, outcome: { ...check.outcome, truncated: true } }), passed: false },
      { output: frame({ ...check, completedAt: undefined }), passed: false },
    ];
    for (const { passed, ...change } of cases) {
      const { transport, records } = fixture();
      transport.readRun = vi.fn(async (id) => {
        const record = records.get(id) as { events: Array<{ type: string; tool?: string }> };
        if (id !== "run-review") return record;
        return {
          ...record,
          events: record.events.map((event) =>
            event.tool === "read"
              ? { ...event, tool: "run_check", ...(event.type === "tool_result" ? change : {}) }
              : event,
          ),
        };
      });
      const receipt = await runAgentSmoke({ config, expectedCommit: commit, thread: "release-1", transport });
      expect(receipt.capabilityOutcome).toBe(passed ? "passed" : "failed");
      if (!passed) expect(receipt.scenarios[2].reason).toBe("workspace_execution_unproven");
    }
  });

  it("requires Slack connection before and after runs when configured", async () => {
    for (const connected of [false, undefined]) {
      const { transport } = fixture();
      transport.health = vi.fn(async () => ({ commit, version: "1.0.0", slackConnected: connected }));
      const receipt = await runAgentSmoke({
        config,
        expectedCommit: commit,
        thread: "release-1",
        transport,
        requireSlackConnection: true,
      });
      expect(receipt.scenarios[0]).toMatchObject({ outcome: "incomplete", reason: "slack_connection_unproven" });
      expect(receipt.scenarios[1].outcome).toBe("skipped");
      expect(transport.request).not.toHaveBeenCalled();
    }
    const before = fixture();
    before.transport.health = vi.fn(async () => ({ commit, version: "1.0.0", slackConnected: true }));
    const passed = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "release-1",
      transport: before.transport,
      requireSlackConnection: true,
    });
    expect(passed.capabilityOutcome).toBe("passed");
    expect(passed.slackConnection).toEqual({ required: true, connected: true, checks: 6 });
    const lost = fixture();
    lost.transport.health = vi
      .fn()
      .mockResolvedValueOnce({ commit, version: "1.0.0", slackConnected: true })
      .mockResolvedValue({ commit, version: "1.0.0", slackConnected: false });
    const failed = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "release-1",
      transport: lost.transport,
      requireSlackConnection: true,
    });
    expect(failed.scenarios[0]).toMatchObject({
      runId: "run-answer",
      outcome: "incomplete",
      reason: "slack_connection_unproven",
    });
    expect(failed.slackConnection).toEqual({ required: true, connected: false, checks: 2 });
    expect(lost.transport.request).toHaveBeenCalledTimes(1);
  });

  it("refuses health-only, fallback output, missing execution and mismatched publication", async () => {
    for (const change of [
      { answerOutcome: undefined },
      { answerOutcome: { version: 1, ending: "answered", output: "absent" } },
      { answerOutcome: { version: 1, ending: "time_budget", output: "present" } },
      { usage: { turns: 0 } },
      { userId: "http:another" },
      { threadKey: "http:smoke:old" },
      { replyOk: false },
      { persisted: false },
      { cost: { usd: null } },
    ]) {
      const { transport, records } = fixture();
      transport.readRun = vi.fn(async (id) => ({ ...(records.get(id) as object), ...change }));
      const receipt = await runAgentSmoke({ config, thread: "release-1", transport });
      expect(receipt.capabilityOutcome).not.toBe("passed");
      expect(transport.request).toHaveBeenCalledTimes(1);
      expect(receipt.scenarios[1].outcome).toBe("skipped");
    }
    for (const change of [{ events: [] }, { reviewPost: { posted: false } }, { reviewHead: "c".repeat(40) }]) {
      const { transport, records } = fixture();
      transport.readRun = vi.fn(async (id) => ({
        ...(records.get(id) as object),
        ...(id === "run-review" ? change : {}),
      }));
      expect((await runAgentSmoke({ config, thread: "release-1", transport })).capabilityOutcome).not.toBe("passed");
    }
    const { transport } = fixture();
    transport.request = vi.fn(async () => ({ reply: "4" }));
    expect((await runAgentSmoke({ config, thread: "release-1", transport })).capabilityOutcome).toBe("failed");
  });

  it("requires the configured fixture verdict and refuses a missing or wrong posted verdict", async () => {
    for (const verdict of [undefined, "approve", "request_changes"] as const) {
      const { transport, records } = fixture();
      transport.readRun = vi.fn(async (id) => {
        const record = records.get(id) as { reviewPost?: object };
        return id === "run-review" ? { ...record, reviewPost: { ...record.reviewPost, verdict } } : record;
      });
      const receipt = await runAgentSmoke({
        config: { ...config, review: { ...config.review, expectedVerdict: "request_changes" } },
        thread: "release-1",
        transport,
      });
      expect(receipt.capabilityOutcome).toBe(verdict === "request_changes" ? "passed" : "failed");
      if (verdict !== "request_changes") expect(receipt.scenarios[2].reason).toBe("review_verdict_mismatch");
    }
  });

  it("retains an admitted identity on monitoring failure and never retries or rolls back", async () => {
    const { transport } = fixture();
    transport.readRun = vi.fn(async () => {
      throw new Error("unavailable");
    });
    const receipt = await runAgentSmoke({ config, thread: "release-1", transport });
    expect(receipt.capabilityOutcome).toBe("incomplete");
    expect(receipt.scenarios[0]).toMatchObject({ runId: "run-answer", outcome: "incomplete" });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it("stops new admissions on spend or build mismatch and keeps exact served-build evidence", async () => {
    const { transport } = fixture();
    const receipt = await runAgentSmoke({
      config: { ...config, maxObservedUsd: 0.05 },
      thread: "release-1",
      transport,
    });
    expect(receipt.capabilityOutcome).toBe("failed");
    expect(receipt.scenarios[0].build?.commit).toBe(commit);
    expect(transport.request).toHaveBeenCalledTimes(1);
    const wrong = fixture();
    expect(
      (await runAgentSmoke({ config, expectedCommit: head, thread: "release-1", transport: wrong.transport }))
        .capabilityOutcome,
    ).toBe("incomplete");
    expect(wrong.transport.request).not.toHaveBeenCalled();
    const changed = fixture();
    changed.transport.health = vi
      .fn()
      .mockResolvedValueOnce({ commit, version: "1.0.0" })
      .mockResolvedValue({ commit: head, version: "1.0.0" });
    expect((await runAgentSmoke({ config, thread: "release-1", transport: changed.transport })).capabilityOutcome).toBe(
      "incomplete",
    );
    expect(changed.transport.request).toHaveBeenCalledTimes(1);
  });

  it("requires a disposable fixture and bounded configuration before any request", () => {
    expect(parseSmokeConfig(config).repo).toBe("acme/smoke");
    for (const changed of [
      { disposable: false },
      { repo: "" },
      { maxObservedUsd: 0 },
      { review: { number: 7, head: "short" } },
      { workspace: { path: "../private", answer: "x" } },
    ]) {
      expect(() => parseSmokeConfig({ ...config, ...changed })).toThrow();
    }
  });

  it("waits for the original asynchronous runs to be saved without another admission", async () => {
    vi.useFakeTimers();
    try {
      const original = fixture();
      const polls = new Map<string, number>();
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit, version: "1.0.0" } });
        const request = JSON.parse(String(init?.body));
        if (String(url).endsWith("/ingress")) {
          expect(request.async).toBe(true);
          const id = request.thread.split("-").at(-1);
          const agent = id === "answer" ? "general" : id === "workspace" ? "explore" : "review";
          const result = (await original.transport.request(
            { id, agent, text: request.text, minutes: id === "answer" ? 4 : 15 },
            request.thread,
          )) as { run: { id: string }; build: unknown };
          return Response.json(
            { runId: result.run.id, threadKey: `http:smoke:${request.thread}`, build: result.build },
            { status: 202 },
          );
        }
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (request.method === "initialize")
          return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
        const id = request.params.arguments.id;
        const count = (polls.get(id) ?? 0) + 1;
        polls.set(id, count);
        const record =
          count === 1
            ? { id, finished: false, persisted: false }
            : count === 2
              ? { id, finished: true, persisted: false }
              : original.records.get(id);
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: { content: [{ type: "text", text: `runs.get: ok\n${JSON.stringify(record)}` }] },
        });
      });
      const transport = agentSmokeTransport({
        origin: "https://bot.example.test",
        healthUrl: "https://bot.example.test/healthz",
        token: "fixture-only",
        config,
        fetch,
      });
      const pending = runAgentSmoke({ config, expectedCommit: commit, thread: "release-1", transport });
      await vi.runAllTimersAsync();
      const receipt = await pending;
      expect(receipt.capabilityOutcome).toBe("passed");
      expect(receipt.scenarios.map((row) => [row.runId, row.outcome])).toEqual([
        ["run-answer", "passed"],
        ["run-workspace", "passed"],
        ["run-review", "passed"],
      ]);
      expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/ingress"))).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains an asynchronous admission when its build or thread evidence is refused", async () => {
    for (const change of [
      { build: undefined },
      { build: { commit: "wrong" } },
      { build: { commit: head } },
      { threadKey: "http:smoke:other" },
      { threadKey: undefined },
      { threadKey: 99 },
    ]) {
      const fetch = vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit } });
        if (String(url).endsWith("/ingress"))
          return Response.json(
            { runId: "admitted-run", threadKey: "http:smoke:release-1-answer", build: { commit }, ...change },
            { status: 202 },
          );
        throw new Error("refused admission must not be monitored");
      });
      const transport = agentSmokeTransport({
        origin: "https://bot.example.test",
        healthUrl: "https://bot.example.test/healthz",
        token: "fixture-only",
        config,
        fetch,
      });
      const receipt = await runAgentSmoke({ config, expectedCommit: commit, thread: "release-1", transport });
      expect(receipt.scenarios[0]).toMatchObject({
        runId: "admitted-run",
        outcome: "incomplete",
        reason: "threadKey" in change ? "run_identity_mismatch" : "served_build_mismatch",
      });
      expect(receipt.scenarios[1].outcome).toBe("skipped");
      expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/ingress"))).toHaveLength(1);
    }
  });

  it("keeps the admitted identity when asynchronous completion exceeds the deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit } });
        if (String(url).endsWith("/ingress"))
          return Response.json(
            { runId: "slow-run", threadKey: "http:smoke:release-1-answer", build: { commit } },
            { status: 202 },
          );
        const request = JSON.parse(String(init?.body));
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (request.method === "initialize")
          return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [{ type: "text", text: 'runs.get: ok\n{"id":"slow-run","finished":false,"persisted":false}' }],
          },
        });
      });
      const transport = agentSmokeTransport({
        origin: "https://bot.example.test",
        healthUrl: "https://bot.example.test/healthz",
        token: "fixture-only",
        config,
        fetch,
      });
      const pending = runAgentSmoke({ config, expectedCommit: commit, thread: "release-1", transport });
      await vi.runAllTimersAsync();
      const receipt = await pending;
      expect(receipt.capabilityOutcome).toBe("incomplete");
      expect(receipt.scenarios.map((row) => [row.runId, row.outcome, row.reason])).toEqual([
        ["slow-run", "incomplete", "run_record_unproven"],
        [undefined, "skipped", "prior_scenario_unproven"],
        [undefined, "skipped", "prior_scenario_unproven"],
      ]);
      expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/ingress"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses bounded ingress and the existing MCP JSON envelope with redirects refused", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit } });
      if (String(url).endsWith("/ingress"))
        return Response.json(
          { runId: "native-run", threadKey: "http:smoke:smoke-1", build: { commit } },
          { status: 202 },
        );
      const request = JSON.parse(String(init?.body));
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "initialize")
        return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
      expect(request.params).toEqual({ name: "runs_get", arguments: { id: "native-run", include: "messages" } });
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: 'runs.get: ok\n{"id":"native-run","finished":true,"persisted":true}' }],
        },
      });
    });
    const transport = agentSmokeTransport({
      origin: "https://bot.example.test",
      healthUrl: "https://bot.example.test/healthz",
      token: "fixture-only",
      config,
      fetch,
    });
    expect(await transport.health()).toEqual({ commit });
    expect(
      await transport.request({ id: "answer", agent: "general", text: "question", minutes: 4 }, "smoke-1"),
    ).toEqual({
      run: { id: "native-run", status: "started" },
      build: { commit },
      threadKey: "http:smoke:smoke-1",
    });
    expect(await transport.readRun("native-run")).toEqual({ id: "native-run", finished: true, persisted: true });
    for (const [, init] of fetch.mock.calls) {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    const body = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(body).toEqual({ text: "question", channel: "smoke", thread: "smoke-1", async: true });
  });
});
