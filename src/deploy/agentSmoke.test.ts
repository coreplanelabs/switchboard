import { describe, expect, it, vi } from "vitest";
import { agentSmokeTransport, parseSmokeConfig, runAgentSmoke, SmokeReaderError, smokeProgress } from "./agentSmoke.js";
import { handleMcpRequest } from "../channels/mcp.js";
import { ALL_GRANTS } from "../core/authz/grants.js";
import { CommandRegistry, bindCommands } from "../core/commandRegistry.js";
import { registerRunsCommands, type RunsCommandDeps } from "../core/commands/runs.js";
import type { CoreDeps } from "../core/dispatcher.js";
import { InMemoryOrganizationStore } from "../core/organization/memory.js";
import { OrganizationService } from "../core/organization/service.js";
import { MCP_PROTOCOL_VERSION } from "../mcp/client.js";

import { observeSandboxRun } from "./sandboxRunEvidence.js";
import { commit, config, fixture, head } from "./testing/agentSmoke.js";

/** Existing intake fixtures also serve the bounded read-only reader handshake. */
function withReaderProbe(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  const owners: Array<{ id: string; channelId: string; userId: string; threadKey: string }> = [];
  return async (url, init) => {
    if (String(url) === "https://bot.example.test/ingress") {
      const response = await fetch(url, init);
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      if (body?.admission?.status === "accepted" && body.runId && typeof body.threadKey === "string")
        owners.push({ id: body.runId, channelId: "http:smoke", userId: "http:smoke", threadKey: body.threadKey });
      return response;
    }
    if (String(url) === "https://bot.example.test/mcp") {
      const request = JSON.parse(String(init?.body));
      if (request.method === "initialize")
        return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "tools/call" && request.params.name === "runs_list") {
        const args = request.params.arguments;
        if (args.channel !== "http:smoke" || args.limit !== (args.thread ? 200 : 1) || args.status !== "all")
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32001, message: "fixture scope refused" },
          });
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [
              {
                type: "text",
                text: `runs.list: ok\n${JSON.stringify({ runs: args.thread ? owners.filter((row) => row.threadKey === args.thread) : [], readScope: { channelId: "http:smoke", userId: "http:smoke", repo: "acme/smoke", allowed: true } })}`,
              },
            ],
          },
        });
      }
    }
    return fetch(url, init);
  };
}

describe("bounded agent smoke", () => {
  it("finishes the original Review run after one transient read failure", async () => {
    const { transport } = fixture();
    const request = transport.request;
    transport.request = vi.fn(async (scenario, thread, onIntake) => {
      const response = (await request(scenario, thread, onIntake)) as { run: { id: string }; build: unknown };
      return {
        ...response,
        threadKey: `http:smoke:${thread}`,
        run: { id: response.run.id, status: "started" },
        admission: { status: "accepted", receiptId: `receipt-${scenario.id}`, runId: response.run.id },
      };
    });
    const readRun = transport.readRun;
    let lostRead = false;
    const snapshots: unknown[] = [];
    transport.readRun = async (id, onRecord) => {
      if (id === "run-review" && !lostRead) {
        lostRead = true;
        throw new SmokeReaderError({ code: "mcp_transport_failed", operation: "runs_get" });
      }
      if (id === "run-review")
        expect(snapshots).toContainEqual(
          expect.objectContaining({
            scenarios: expect.arrayContaining([
              expect.objectContaining({
                id: "review",
                runId: "run-review",
                readRetry: { code: "mcp_transport_failed", operation: "runs_get" },
              }),
            ]),
          }),
        );
      return readRun(id, onRecord);
    };

    const receipt = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "release-1",
      transport,
      onReceipt: async (saved) => {
        snapshots.push(saved);
      },
    });

    expect(receipt.capabilityOutcome).toBe("passed");
    expect(receipt.scenarios[2]).toMatchObject({
      id: "review",
      runId: "run-review",
      outcome: "passed",
      reason: "accepted",
      readRetry: { code: "mcp_transport_failed", operation: "runs_get" },
      outputReadback: { kind: "native-persisted-run", runId: "run-review" },
    });
    expect(transport.request).toHaveBeenCalledTimes(3);
  });

  it("keeps a denied run read incomplete without another request", async () => {
    const { transport } = fixture();
    const request = transport.request;
    transport.request = vi.fn(async (scenario, thread, onIntake) => {
      const response = (await request(scenario, thread, onIntake)) as { run: { id: string }; build: unknown };
      return {
        ...response,
        threadKey: `http:smoke:${thread}`,
        run: { id: response.run.id, status: "started" },
        admission: { status: "accepted", receiptId: `receipt-${scenario.id}`, runId: response.run.id },
      };
    });
    const readRun = transport.readRun;
    let deniedReads = 0;
    transport.readRun = async (id, onRecord) => {
      if (id === "run-review") {
        deniedReads++;
        throw new SmokeReaderError({ code: "mcp_read_unauthorized", operation: "runs_get", rpcCode: -32001 });
      }
      return readRun(id, onRecord);
    };

    const receipt = await runAgentSmoke({ config, expectedCommit: commit, thread: "release-1", transport });

    expect(receipt.capabilityOutcome).toBe("incomplete");
    expect(receipt.scenarios[2]).toMatchObject({
      id: "review",
      runId: "run-review",
      outcome: "incomplete",
      reason: "run_record_unproven",
      observationError: { code: "mcp_read_unauthorized", operation: "runs_get", rpcCode: -32001 },
    });
    expect(deniedReads).toBe(1);
    expect(transport.request).toHaveBeenCalledTimes(3);
  });

  it.each(["local", "unavailable"] as const)("retains an explicit %s mapping for the original run", async (mapping) => {
    const original = fixture();
    const receipt = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "mapping",
      transport: {
        ...original.transport,
        readRun: async (id) => {
          const record = (await original.transport.readRun(id)) as {
            events: { type: string; name?: string; attrs?: unknown }[];
          };
          return {
            ...record,
            events: record.events.flatMap((event) =>
              event.name === "dispatch.workspace.attach"
                ? mapping === "unavailable"
                  ? []
                  : [{ ...event, attrs: { backend: "local" } }]
                : [event],
            ),
          };
        },
      },
      observeSandbox: async (target) =>
        observeSandboxRun(target, {
          now: () => 1000,
          readApp: async () => {
            throw new Error("no native read");
          },
          readInstances: async () => {
            throw new Error("no native read");
          },
        }),
    });
    expect(receipt.capabilityOutcome).toBe("passed");
    expect(receipt.scenarios[2]?.sandbox?.ended).toMatchObject({
      thread: "http:smoke:mapping-review",
      backend: mapping === "local" ? "local" : null,
      sandboxKey: null,
      mapping: mapping === "local" ? "not-sandbox" : "unavailable",
      inventory: "unavailable",
      instances: [],
    });
  });
  it.each(["http", "mcp"] as const)(
    "matches %s Review observations to the recorded sandbox, not the conversation",
    async (transport) => {
      const receipt = await runAgentSmoke({
        config: { ...config, model: "openai/gpt-6.1-sol", review: { ...config.review, transport, effort: "high" } },
        expectedCommit: commit,
        thread: "review-key",
        transport: fixture().transport,
        observeSandbox: async (target) =>
          observeSandboxRun(target, {
            now: () => 1000,
            readApp: async () => ({ value: { version: 84, image: null } }),
            readInstances: async () => ({
              value: [
                { id: "review-instance", name: "review:run-review", state: "running", version: 83 },
                { id: "wrong-instance", name: `${transport}:smoke:review-key-review`, state: "running", version: 84 },
              ],
            }),
          }),
      });
      expect(receipt.scenarios[2]?.sandbox?.ended).toMatchObject({
        thread: `${transport}:smoke:review-key-review`,
        sandboxKey: "review:run-review",
        backend: "sandbox",
        mapping: "recorded",
        instances: [{ id: "review-instance", state: "running", version: 83 }],
        inventory: "complete",
      });
    },
  );
  it("retains first and ended instance versions from the same original run", async () => {
    const original = fixture();
    let observations = 0;
    const receipt = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "transition",
      transport: {
        ...original.transport,
        readRun: async (id, onRecord) => {
          const record = (await original.transport.readRun(id)) as Record<string, unknown>;
          if (record.agent === "explore") await onRecord?.({ ...record, finished: false });
          return record;
        },
      },
      observeSandbox: async (target) => ({
        observedAt: 1000,
        finishedAt: 1001,
        ...target,
        mapping: "recorded",
        application: { id: "app-1", version: 84, image: "image-new", activeRolloutId: "rollout-1" },
        instances: [{ id: "instance-1", state: "running", version: ++observations === 1 ? 83 : 84 }],
        inventory: "complete",
        matchingInstances: 1,
        truncated: false,
      }),
    });
    expect(receipt.scenarios[1]?.sandbox?.first?.instances).toEqual([
      { id: "instance-1", state: "running", version: 83 },
    ]);
    expect(receipt.scenarios[1]?.sandbox?.ended?.instances).toEqual([
      { id: "instance-1", state: "running", version: 84 },
    ]);
    expect(vi.mocked(original.transport.request).mock.calls.map(([scenario]) => scenario.id)).toEqual([
      "answer",
      "workspace",
      "review",
    ]);
  });
  it("retains exact-thread provider evidence without letting a failed observation change acceptance", async () => {
    const original = fixture();
    const observation = {
      observedAt: 1000,
      finishedAt: 1001,
      application: null,
      instances: [],
      inventory: "unavailable" as const,
      matchingInstances: 0,
      truncated: false,
    };
    const threads: string[] = [];
    const receipt = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "evidence",
      transport: original.transport,
      observeSandbox: async (target) => {
        threads.push(target.thread);
        return { ...observation, ...target, mapping: "recorded" };
      },
    });
    expect(receipt.capabilityOutcome).toBe("passed");
    expect(receipt.scenarios[1]?.sandbox?.ended).toEqual({
      ...observation,
      thread: "http:smoke:evidence-workspace",
      sandboxKey: "http:smoke:evidence-workspace",
      backend: "sandbox",
      mapping: "recorded",
    });
    expect(threads).toEqual(["http:smoke:evidence-workspace", "http:smoke:evidence-review"]);
    const failed = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "failed-observer",
      transport: fixture().transport,
      observeSandbox: async () => {
        throw new Error("Authorization: Bearer secret");
      },
    });
    expect(failed.capabilityOutcome).toBe("passed");
    expect(failed.scenarios[1]?.sandbox).toEqual({ observationError: "unavailable" });
  });
  it("prints only safe phase and original identity fields while retaining detailed evidence in the receipt", async () => {
    const original = fixture();
    const receipt = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "progress",
      transport: original.transport,
    });
    const row = receipt.scenarios[2]!;
    row.receiptId = "organization:fixture:3";
    row.intake = { request: { method: "POST", path: "/ingress", body: "private request", truncated: false } };
    row.evidence = { identityVerified: true, record: { output: "private output" } };
    expect(smokeProgress(receipt)).toEqual({
      event: "smoke.progress",
      scenario: "review",
      phase: "accepted",
      outcome: "passed",
      requestDeadlineMs: 960000,
      runId: "run-review",
      receiptId: "organization:fixture:3",
    });
    row.receiptId = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(smokeProgress(receipt)?.receiptId).toBe("«redacted-github-token»");
    row.observationError = {
      code: "record_invalid",
      operation: "runs_get",
      fields: [{ path: "private-field-marker", code: "invalid_type" }],
    };
    expect(smokeProgress(receipt)?.observationError).toEqual({ code: "record_invalid", operation: "runs_get" });
  });
  it.each(["workspace", "review"] as const)(
    "keeps native saved output behind the original %s evidence gate",
    async (target) => {
      const original = fixture();
      const request = original.transport.request;
      original.transport.request = vi.fn(async (scenario, thread, onIntake) => {
        const response = (await request(scenario, thread, onIntake)) as {
          run: { id: string; status: string };
          build: unknown;
        };
        const record = original.records.get(response.run.id) as Record<string, unknown>;
        record.replyOk = false;
        if (scenario.id === target) {
          if (target === "workspace") {
            record.events = (record.events as Array<{ type: string }>).filter(
              (e) => !["tool_call", "tool_result"].includes(e.type),
            );
            record.eventCount = (record.events as unknown[]).length;
            if (record.storedEventCount !== undefined) record.storedEventCount = record.eventCount;
          } else record.reviewPost = { ...(record.reviewPost as object), posted: false };
        }
        return {
          ...response,
          threadKey: `${scenario.transport ?? "http"}:smoke:${thread}`,
          run: { id: response.run.id, status: "started" },
          admission: { status: "accepted", receiptId: `receipt-${scenario.id}`, runId: response.run.id },
        };
      });
      const receipt = await runAgentSmoke({
        config,
        expectedCommit: commit,
        thread: "native-gates",
        transport: original.transport,
      });
      expect(receipt.scenarios.find((row) => row.id === target)).toMatchObject({
        outcome: "failed",
        reason: target === "workspace" ? "workspace_execution_unproven" : "review_publication_unproven",
      });
      expect(receipt.scenarios.find((row) => row.id === target)!.outputReadback).toBeUndefined();
      expect(original.transport.request).toHaveBeenCalledTimes(target === "workspace" ? 2 : 3);
    },
  );
  it.each([
    "none",
    "mcp",
    "completed-native",
    "malformed-native",
    "legacy",
    "pending",
    "unsealed",
    "partial",
    "truncated",
    "missing",
    "wrong",
    "foreign",
    "unpersisted",
    "refused",
  ] as const)("requires exact saved native output instead of channel delivery: %s", async (fault) => {
    const original = fixture();
    const request = original.transport.request;
    original.transport.request = vi.fn(async (scenario, thread, onIntake) => {
      const response = (await request(scenario, thread, onIntake)) as {
        run: { id: string; status: string };
        build: unknown;
      };
      const record = original.records.get(response.run.id) as Record<string, unknown>;
      record.replyOk = false;
      if (scenario.id === "answer") {
        if (["completed-native", "malformed-native"].includes(fault)) record.replyOk = true;
        if (fault === "unsealed") delete record.sealedAt;
        if (fault === "partial") record.eventCount = Number(record.eventCount) + 1;
        if (fault === "truncated") record.truncated = true;
        if (fault === "unpersisted") record.persisted = false;
        if (fault === "foreign") record.userId = "http:another-reader";
        if (fault === "wrong")
          (record.events as Array<{ type: string; text?: string }>).find((e) => e.type === "answer")!.text = "5";
        if (fault === "missing") {
          record.events = (record.events as Array<{ type: string }>).filter((e) => e.type !== "answer");
          record.eventCount = (record.events as unknown[]).length;
          if (record.storedEventCount !== undefined) record.storedEventCount = record.eventCount;
        }
      }
      if (scenario.id === "answer" && fault === "legacy") return response;
      return {
        ...response,
        threadKey: `${scenario.transport ?? "http"}:smoke:${thread}`,
        run: {
          id: response.run.id,
          status: scenario.id === "answer" && fault === "completed-native" ? "completed" : "started",
        },
        admission: {
          status:
            scenario.id === "answer" && ["pending", "completed-native"].includes(fault)
              ? "pending"
              : scenario.id === "answer" && fault === "refused"
                ? "rejected"
                : scenario.id === "answer" && fault === "malformed-native"
                  ? "unknown"
                  : "accepted",
          receiptId: `receipt-${scenario.id}`,
          runId: response.run.id,
        },
      };
    });
    const receipt = await runAgentSmoke({
      config:
        fault === "mcp"
          ? { ...config, model: "openai/gpt-6.1-sol", review: { ...config.review, transport: "mcp", effort: "high" } }
          : config,
      expectedCommit: commit,
      thread: "release-native",
      transport: original.transport,
    });
    if (["none", "mcp"].includes(fault)) {
      expect(receipt).toMatchObject({
        version: 1,
        scope: "deployment-capability-smoke",
        capabilityOutcome: "passed",
        productAcceptance: { outcome: "incomplete", reason: "private-question-fix-draft-pr-unproven" },
      });
      expect(receipt.scenarios.map((s) => s.outputReadback?.kind)).toEqual([
        "native-persisted-run",
        "native-persisted-run",
        "native-persisted-run",
      ]);
      expect(receipt.scenarios[0]!.evidence).toMatchObject({ identityVerified: true, record: { replyOk: false } });
    } else {
      const expected =
        fault === "wrong"
          ? "wrong_answer"
          : fault === "foreign"
            ? "run_identity_mismatch"
            : fault === "unpersisted"
              ? "run_record_unproven"
              : fault === "refused"
                ? "admission_refused"
                : "execution_output_unproven";
      expect(receipt.scenarios[0]!.reason).toBe(expected);
      expect(receipt.capabilityOutcome).not.toBe("passed");
      expect(receipt.scenarios[0]!.outputReadback).toBeUndefined();
      expect(original.transport.request).toHaveBeenCalledTimes(1);
      expect(receipt.scenarios[1]!.outcome).toBe("skipped");
    }
  });
  it("sanitizes prefixed and encoded JSON fragments before retaining runless replies", async () => {
    for (const reply of [
      'response={"api_token":"opaque-private-value"} after',
      `response=${JSON.stringify(JSON.stringify({ api_token: "opaque-private-value" }))} after`,
      'response={"api_token":"opaque-private-value',
      `${"x".repeat(15930)} response=${JSON.stringify({ api_token: "opaque-private-value", detail: "z".repeat(2000) })} after`,
    ]) {
      const fetch = vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith("/healthz") ? Response.json({ ok: true, build: { commit } }) : Response.json({ reply }),
      );
      const receipt = await runAgentSmoke({
        config,
        expectedCommit: commit,
        thread: "release-1",
        transport: agentSmokeTransport({
          origin: "https://bot.example.test",
          healthUrl: "https://bot.example.test/healthz",
          token: "fixture-only",
          config,
          fetch: withReaderProbe(fetch),
        }),
      });
      expect(receipt.scenarios[0]).toMatchObject({ outcome: "failed", reason: "no_agent_run" });
      const response = receipt.scenarios[0]?.intake?.response;
      const observed = response?.truncated ? response.preview! : (response?.body as { reply: string }).reply;
      expect(observed).toContain("response=");
      expect(observed).toContain("redacted");
      expect(JSON.stringify(receipt)).not.toContain("opaque-private-value");
      if (reply.length > 16000) {
        expect(response?.truncated).toBe(true);
        expect(observed).toHaveLength(16000);
      } else if (reply.endsWith(" after")) expect(observed).toContain(" after");
      else expect(observed).toBe("response=«redacted-json-fragment»");
    }
  });

  it("excludes transport and canonical credentials used as raw or encoded JSON member names", async () => {
    const detail = { "fixture-only": "diagnostic", ghp_abcdefghijklmnopqrstuvwxy: "diagnostic" };
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/healthz")
        ? Response.json({ ok: true, build: { commit } })
        : Response.json({ detail, reply: JSON.stringify({ detail }) }),
    );
    const receipt = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "release-1",
      transport: agentSmokeTransport({
        origin: "https://bot.example.test",
        healthUrl: "https://bot.example.test/healthz",
        token: "fixture-only",
        config,
        fetch: withReaderProbe(fetch),
      }),
    });
    expect(receipt.scenarios[0]).toMatchObject({ outcome: "failed", reason: "no_agent_run" });
    const body = receipt.scenarios[0]?.intake?.response?.body as { detail: unknown; reply: string };
    expect(body.detail).toEqual({ "«redacted»": "diagnostic", "«redacted-github-token»": "diagnostic" });
    expect(JSON.parse(body.reply)).toEqual({
      detail: { "«redacted»": "diagnostic", "«redacted-github-token»": "diagnostic" },
    });
    for (const secret of ["fixture-only", "ghp_abcdefghijklmnopqrstuvwxy"])
      expect(JSON.stringify(receipt)).not.toContain(secret);
  });

  it("redacts credentials in nested JSON-encoded replies before retaining or truncating intake evidence", async () => {
    for (const detail of ["diagnostic", "x".repeat(20000)]) {
      const fetch = vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith("/healthz")
          ? Response.json({ ok: true, build: { commit } })
          : Response.json({
              reply: JSON.stringify({
                api_token: "opaque-private-value",
                nested: JSON.stringify(
                  JSON.stringify({
                    password: 'private-quoted-"value',
                    authorization: "Basic private-auth",
                    cookie: "private-cookie",
                    callback: "https://auth.example.test/callback?code=private-code#private-state",
                  }),
                ),
                text: "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxy",
                transport: "fixture-only",
                detail,
              }),
            }),
      );
      const receipt = await runAgentSmoke({
        config,
        expectedCommit: commit,
        thread: "release-1",
        transport: agentSmokeTransport({
          origin: "https://bot.example.test",
          healthUrl: "https://bot.example.test/healthz",
          token: "fixture-only",
          config,
          fetch: withReaderProbe(fetch),
        }),
      });
      expect(receipt.scenarios[0]).toMatchObject({
        outcome: "failed",
        reason: "no_agent_run",
        intake: { response: { status: 200, format: "json", truncated: detail.length > 16000 } },
      });
      const response = receipt.scenarios[0]?.intake?.response;
      const serialized = JSON.stringify(response);
      for (const secret of [
        "opaque-private-value",
        "private-quoted",
        "private-auth",
        "private-cookie",
        "private-code",
        "private-state",
        "ghp_abcdefghijklmnopqrstuvwxy",
        "fixture-only",
      ])
        expect(serialized).not.toContain(secret);
      if (detail === "diagnostic") {
        expect(JSON.parse((response?.body as { reply: string }).reply)).toMatchObject({
          api_token: "«redacted»",
          detail: "diagnostic",
          transport: "«redacted»",
        });
      } else {
        expect(response?.preview).toHaveLength(16000);
      }
    }
  });

  it("excludes foreign and invalid identities inside JSON-encoded intake replies", async () => {
    for (const userId of ["http:another-actor", null]) {
      const fetch = vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith("/healthz")
          ? Response.json({ ok: true, build: { commit } })
          : Response.json({
              reply: JSON.stringify({ nested: JSON.stringify({ userId, reply: "foreign private content" }) }),
            }),
      );
      const receipt = await runAgentSmoke({
        config,
        expectedCommit: commit,
        thread: "release-1",
        transport: agentSmokeTransport({
          origin: "https://bot.example.test",
          healthUrl: "https://bot.example.test/healthz",
          token: "fixture-only",
          config,
          fetch: withReaderProbe(fetch),
        }),
      });
      expect(receipt.scenarios[0]).toMatchObject({ outcome: "failed", reason: "no_agent_run" });
      const response = receipt.scenarios[0]?.intake?.response;
      const reply = JSON.parse((response?.body as { reply: string }).reply);
      expect(JSON.parse(reply.nested)).toEqual({ excluded: "foreign_identity" });
      expect(JSON.stringify(receipt)).not.toContain("foreign private content");
    }
  });

  it("retains the sanitized original HTTP request and runless reply before refusing acceptance", async () => {
    const saved: unknown[] = [];
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/healthz")
        ? Response.json({ ok: true, build: { commit } })
        : Response.json({ reply: "Ship budget status", error: "not_an_agent_run" }),
    );
    const receipt = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "release-1",
      transport: agentSmokeTransport({
        origin: "https://bot.example.test",
        healthUrl: "https://bot.example.test/healthz",
        token: "fixture-only",
        config,
        fetch: withReaderProbe(fetch),
      }),
      onReceipt: async (value) => {
        saved.push(value);
      },
    });
    expect(receipt.capabilityOutcome).toBe("failed");
    expect(receipt.scenarios[0]).toMatchObject({
      outcome: "failed",
      reason: "no_agent_run",
      intake: {
        request: {
          method: "POST",
          path: "/ingress",
          body: {
            text: "agent:general What is 2 + 2? Answer only with the number. budget:4",
            channel: "smoke",
            thread: "release-1-answer",
            async: true,
          },
          truncated: false,
        },
        response: {
          status: 200,
          format: "json",
          body: { reply: "Ship budget status", error: "not_an_agent_run" },
          truncated: false,
        },
      },
    });
    expect(saved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarios: expect.arrayContaining([
            expect.objectContaining({
              reason: "request_ack_unknown",
              intake: expect.objectContaining({ response: expect.objectContaining({ status: 200 }) }),
            }),
          ]),
        }),
      ]),
    );
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://bot.example.test/healthz",
      "https://bot.example.test/ingress",
    ]);
  });

  it("retains failed and malformed HTTP evidence without accepting or repeating an admission", async () => {
    for (const response of [
      Response.json({ error: "denied" }, { status: 403 }),
      new Response("private callback body", { status: 502 }),
      Response.json({ runId: "bad id" }, { status: 202 }),
    ]) {
      const fetch = vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith("/healthz") ? Response.json({ ok: true, build: { commit } }) : response,
      );
      const receipt = await runAgentSmoke({
        config,
        expectedCommit: commit,
        thread: "release-1",
        transport: agentSmokeTransport({
          origin: "https://bot.example.test",
          healthUrl: "https://bot.example.test/healthz",
          token: "fixture-only",
          config,
          fetch: withReaderProbe(fetch),
        }),
      });
      expect(receipt.capabilityOutcome).toBe("incomplete");
      expect(receipt.scenarios[0]).toMatchObject({
        outcome: "incomplete",
        intake: { response: { status: response.status, format: response.status === 502 ? "non-json" : "json" } },
      });
      expect(JSON.stringify(receipt)).not.toContain("private callback body");
      expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
        "https://bot.example.test/healthz",
        "https://bot.example.test/ingress",
      ]);
    }
  });

  it("redacts transport secrets and URL callback codes before bounded intake capture", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/healthz")
        ? Response.json({ ok: true, build: { commit } })
        : Response.json({
            reply: "Bearer fixture-only https://auth.example.test/callback?code=private-code&state=private-state",
            api_token: "private-key",
            detail: "x".repeat(20000),
          }),
    );
    const receipt = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "release-1",
      transport: agentSmokeTransport({
        origin: "https://bot.example.test",
        healthUrl: "https://bot.example.test/healthz",
        token: "fixture-only",
        config,
        fetch: withReaderProbe(fetch),
      }),
    });
    expect(receipt.capabilityOutcome).toBe("failed");
    expect(receipt.scenarios[0]).toMatchObject({
      reason: "no_agent_run",
      intake: { response: { status: 200, truncated: true } },
    });
    const serialized = JSON.stringify(receipt);
    for (const secret of ["fixture-only", "private-key", "private-code", "private-state"])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain("redacted");
    expect(serialized.length).toBeLessThan(18000);
  });

  it("excludes a foreign response's content while preserving its refused admission identity", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/healthz")
        ? Response.json({ ok: true, build: { commit } })
        : Response.json(
            {
              runId: "foreign-run",
              threadKey: "http:smoke:foreign-thread",
              build: { commit },
              reply: "foreign private content",
            },
            { status: 202 },
          ),
    );
    const receipt = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "release-1",
      transport: agentSmokeTransport({
        origin: "https://bot.example.test",
        healthUrl: "https://bot.example.test/healthz",
        token: "fixture-only",
        config,
        fetch: withReaderProbe(fetch),
      }),
    });
    expect(receipt.scenarios[0]).toMatchObject({
      runId: "foreign-run",
      outcome: "incomplete",
      reason: "run_identity_mismatch",
      intake: { response: { status: 202, body: { excluded: "foreign_identity" }, truncated: false } },
    });
    expect(JSON.stringify(receipt)).not.toContain("foreign private content");
  });

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
        fetch: withReaderProbe(fetch),
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
        events: [
          ...((await read(id)) as { events: Array<{ type: string }> }).events.filter(
            (event) => event.type !== "run_meta",
          ),
          ...events,
        ],
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

  it("accepts Luna at medium effort over HTTP only with the expected exact-head verdict", async () => {
    const selected = parseSmokeConfig({
      ...config,
      model: "openai/gpt-6-luna",
      review: { ...config.review, transport: "http", effort: "medium", expectedVerdict: "request_changes" },
    });
    const { transport } = fixture();
    const read = transport.readRun;
    transport.readRun = async (id) => {
      const row = (await read(id)) as Record<string, unknown>;
      return id === "run-review"
        ? { ...row, reviewPost: { ...(row.reviewPost as object), verdict: "request_changes" } }
        : row;
    };
    const receipt = await runAgentSmoke({ config: selected, expectedCommit: commit, thread: "light", transport });
    expect(receipt.capabilityOutcome).toBe("passed");
    expect(receipt.scenarios[2]).toMatchObject({
      actualEffort: "medium",
      actualModel: "openai/gpt-6-luna",
      artifact: { repo: "acme/smoke", number: 7, head },
    });
    expect((transport.request as ReturnType<typeof vi.fn>).mock.calls[2][0].text).toContain(
      "model:openai/gpt-6-luna effort:medium",
    );
    const changedRead = transport.readRun;
    transport.readRun = async (id) => {
      const row = (await changedRead(id)) as Record<string, unknown>;
      return id === "run-review" ? { ...row, reviewPost: { ...(row.reviewPost as object), verdict: "approve" } } : row;
    };
    const wrong = await runAgentSmoke({ config: selected, expectedCommit: commit, thread: "light-wrong", transport });
    expect(wrong.scenarios[2]).toMatchObject({ outcome: "failed", reason: "review_verdict_mismatch" });
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
      "agent:general What is 2 + 2? Answer only with the number. budget:4 model:openai/gpt-6.1-sol",
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
        fetch: withReaderProbe(fetch),
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
        fetch: withReaderProbe(fetch),
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
        fetch: withReaderProbe(fetch),
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
      fetch: withReaderProbe(fetch),
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
    for (const [url, init] of fetch.mock.calls) {
      expect(init?.redirect).toBe(String(url).endsWith("/mcp") ? "manual" : "error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    const body = JSON.parse(String(fetch.mock.calls.find(([url]) => String(url).endsWith("/ingress"))?.[1]?.body));
    expect(body).toEqual({
      text: "question",
      channel: "smoke",
      thread: "smoke-1",
      async: true,
      idempotencyKey: "smoke-1",
    });
  });

  it.each(["allowed", "read-only"])(
    "runs MCP Review through the maintained client and real public controller with no HTTP review admission: %s",
    async (access) => {
      const producer = fixture(),
        store = new InMemoryOrganizationStore(() => 1);
      const org = new OrganizationService({
        store,
        directory: store.directory,
        mappings: [{ source: "mcp", issuer: "fixture:mcp", tenant: null, organization: "org:fixture" }],
        limits: {
          pendingPerActor: 5,
          pendingPerSource: 10,
          pendingPerOrganization: 20,
          reservedReconciliation: 1,
          contentTtlMs: 90,
          receiptTtlMs: 365,
        },
        authorize: async () => true,
      });
      const commands = new CommandRegistry<RunsCommandDeps>();
      registerRunsCommands(commands);
      const deps = {
        build: { commit, version: "1.0.0" },
        config: {
          grantsFor: () => (access === "allowed" ? ALL_GRANTS : { ...ALL_GRANTS, actions: new Set(["runs:read"]) }),
          config: {},
        },
      } as unknown as CoreDeps;
      const actual: Array<{ source: string; userId: string; threadKey: string }> = [];
      const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: deps.build });
        const body = String(init?.body);
        if (String(url).endsWith("/ingress")) {
          const args = JSON.parse(body),
            id = args.thread.split("-").at(-1);
          const run = (await producer.transport.request(
            { id, agent: id === "answer" ? "general" : "explore", minutes: id === "answer" ? 4 : 15, text: args.text },
            args.thread,
          )) as { run: { id: string } };
          actual.push({ source: "http", userId: "http:smoke", threadKey: `http:smoke:${args.thread}` });
          return Response.json(
            { runId: run.run.id, threadKey: `http:smoke:${args.thread}`, build: deps.build },
            { status: 202 },
          );
        }
        const response = await handleMcpRequest(
          { method: "POST", headers: { authorization: "Bearer fixture-only" }, body },
          deps,
          {
            auth: { tokens: { "fixture-only": { subject: "smoke", channel: "smoke" } } },
            commands: bindCommands(commands, { runs: async () => producer.service }),
            admit: async (msg, _io, evidence) => {
              actual.push({ source: evidence.source, userId: msg.userId, threadKey: msg.threadKey! });
              const admitted = await org.admit(
                {
                  source: "mcp",
                  kind: "service",
                  organizations: ["org:fixture"],
                  identity: { issuer: "fixture:mcp", tenant: null, subject: evidence.identity.subject },
                },
                {
                  key: msg.messageId!,
                  sourceEvent: msg.messageId!,
                  content: msg.text,
                  destination: { kind: "broad" },
                  context: [],
                  target: null,
                  workload: "message",
                },
              );
              if (admitted.status !== "receipt") return admitted;
              const finished = (await producer.transport.request(
                { id: "review", agent: "review", minutes: 15, text: msg.text, transport: "mcp" },
                "release-1-review",
              )) as { run: { id: string } };
              const lease = await store.execute({
                action: "claim",
                organization: "org:fixture",
                owner: "original",
                leaseMs: 30,
              });
              if (lease.status !== "state" || !lease.state.lease) throw new Error("No original lease");
              return store.execute({
                action: "settle",
                organization: "org:fixture",
                owner: "original",
                generation: lease.state.lease.generation,
                receiptId: admitted.receipt.id,
                status: "accepted",
                ownerRunId: finished.run.id,
                reason: null,
                reply: null,
                contentTtlMs: 90,
              });
            },
          },
        );
        return response.body === undefined
          ? new Response(null, { status: response.status })
          : Response.json(response.body, { status: response.status });
      }) as typeof globalThis.fetch;
      const selected = {
        ...config,
        model: "openai/gpt-6.1-sol",
        review: { ...config.review, transport: "mcp", effort: "high" },
      };
      const result = await runAgentSmoke({
        config: selected,
        expectedCommit: commit,
        thread: "release-1",
        transport: agentSmokeTransport({
          origin: "https://bot.example.test",
          healthUrl: "https://bot.example.test/healthz",
          token: "fixture-only",
          config: selected,
          fetch,
        }),
      });
      if (access === "read-only") {
        expect(result).toMatchObject({
          capabilityOutcome: "incomplete",
          scenarios: [
            { outcome: "passed" },
            { outcome: "passed" },
            { outcome: "incomplete", reason: "mcp_access_unproven", requestKey: "release-1-review" },
          ],
        });
        expect(actual).toEqual([
          { source: "http", userId: "http:smoke", threadKey: "http:smoke:release-1-answer" },
          { source: "http", userId: "http:smoke", threadKey: "http:smoke:release-1-workspace" },
        ]);
        return;
      }
      expect(result.capabilityOutcome).toBe("passed");
      expect(actual).toEqual([
        { source: "http", userId: "http:smoke", threadKey: "http:smoke:release-1-answer" },
        { source: "http", userId: "http:smoke", threadKey: "http:smoke:release-1-workspace" },
        { source: "mcp", userId: "mcp:smoke", threadKey: "mcp:smoke:release-1-review" },
      ]);
      expect(result.scenarios[2]).toMatchObject({
        transport: "mcp",
        requestKey: "release-1-review",
        runId: "run-review",
        userId: "mcp:smoke",
        actualEffort: "high",
        actualModel: "openai/gpt-6.1-sol",
        artifact: { repo: "acme/smoke", number: 7, head },
      });
    },
  );

  it("requires the explicit approved model and effort for MCP Review while retaining default HTTP", () => {
    expect(parseSmokeConfig(config).review.transport).toBeUndefined();
    expect(
      parseSmokeConfig({
        ...config,
        model: "openai/gpt-6.1-sol",
        review: { ...config.review, transport: "mcp", effort: "high" },
      }).review,
    ).toMatchObject({ transport: "mcp", effort: "high" });
    for (const model of [undefined, "anthropic/claude-opus-5-5"])
      expect(() =>
        parseSmokeConfig({ ...config, model, review: { ...config.review, transport: "mcp", effort: "high" } }),
      ).toThrow();
    expect(() =>
      parseSmokeConfig({ ...config, model: "openai/gpt-6.1-sol", review: { ...config.review, transport: "mcp" } }),
    ).toThrow();
  });

  it.each([
    ["matching", "passed", "accepted"],
    ["build", "incomplete", "served_build_mismatch"],
    ["owner", "incomplete", "original_owner_mismatch"],
    ["source", "failed", "run_identity_mismatch"],
    ["effort", "failed", "run_effort_mismatch"],
    ["denied", "incomplete", "mcp_access_unproven"],
    ["lost_ack", "incomplete", "request_ack_unknown"],
  ])(
    "uses genuine MCP Review with explicit Sol/high and proves its own source and recorded effort: %s",
    async (fault, outcome, reason) => {
      const original = fixture();
      const selected = {
        ...config,
        model: "openai/gpt-6.1-sol",
        review: { ...config.review, transport: "mcp", effort: "high" },
      };
      const admits: Array<{ source: string; thread: string; text: string; key: string }> = [];
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit, version: "1.0.0" } });
        const rpc = JSON.parse(String(init?.body));
        if (rpc.method === "initialize")
          return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
        if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (String(url).endsWith("/ingress") || rpc.params.name === "dispatch") {
          const source = String(url).endsWith("/ingress") ? "http" : "mcp";
          const args = source === "http" ? rpc : rpc.params.arguments;
          if (source === "mcp" && fault === "denied")
            return Response.json({
              jsonrpc: "2.0",
              id: rpc.id,
              error: { code: -32001, message: "Current MCP dispatch is not permitted" },
            });
          const id = args.thread.split("-").at(-1);
          const result = (await original.transport.request(
            {
              id,
              agent: id === "answer" ? "general" : id === "workspace" ? "explore" : "review",
              minutes: id === "answer" ? 4 : 15,
              text: args.text,
              transport: source,
            },
            args.thread,
          )) as { run: { id: string }; build: unknown };
          admits.push({ source, thread: args.thread, text: args.text, key: args.idempotencyKey });
          const body = {
            admission: { status: "accepted", receiptId: `receipt-${id}`, runId: result.run.id, duplicate: false },
            runId: result.run.id,
            threadKey: `${source}:smoke:${args.thread}`,
            build: result.build,
          };
          if (source === "mcp" && fault === "build") body.build = { commit: head };
          if (source === "mcp" && fault === "owner") body.admission.runId = "foreign-original-owner";
          if (source === "mcp" && fault === "lost_ack") throw new Error("lost admission acknowledgment");
          return source === "http"
            ? Response.json(body, { status: 202 })
            : Response.json({
                jsonrpc: "2.0",
                id: rpc.id,
                result: { content: [{ type: "text", text: "Request admitted" }], structuredContent: body },
              });
        }
        const record = structuredClone(original.records.get(rpc.params.arguments.id)) as Record<string, unknown>;
        if (rpc.params.arguments.id === "run-review" && fault === "source") record.userId = "http:smoke";
        if (rpc.params.arguments.id === "run-review" && fault === "effort")
          record.events = (record.events as Array<Record<string, unknown>>).map((event) =>
            event.type === "run_meta" ? { ...event, effort: "medium" } : event,
          );
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { content: [{ type: "text", text: `runs.get: ok\n${JSON.stringify(record)}` }] },
        });
      });
      const transport = agentSmokeTransport({
        origin: "https://bot.example.test",
        healthUrl: "https://bot.example.test/healthz",
        token: "fixture-only",
        config: selected,
        fetch: withReaderProbe(fetch),
      });
      const receipt = await runAgentSmoke({ config: selected, expectedCommit: commit, thread: "release-1", transport });
      expect(receipt.scenarios.map((row) => [row.id, row.outcome, row.reason])).toEqual([
        ["answer", "passed", "accepted"],
        ["workspace", "passed", "accepted"],
        ["review", outcome, reason],
      ]);
      expect(receipt.capabilityOutcome).toBe(outcome);
      expect(admits.map((item) => [item.source, item.thread, item.key])).toEqual([
        ["http", "release-1-answer", "release-1-answer"],
        ["http", "release-1-workspace", "release-1-workspace"],
        ...(fault === "denied" ? [] : [["mcp", "release-1-review", "release-1-review"]]),
      ]);
      if (fault === "denied" || fault === "lost_ack") {
        expect(receipt.scenarios[2]).toMatchObject({
          transport: "mcp",
          requestKey: "release-1-review",
          outcome: "incomplete",
        });
        expect(receipt.scenarios[2].receiptId).toBeUndefined();
        return;
      }
      expect(admits[2].text).toContain("model:openai/gpt-6.1-sol effort:high");
      expect(receipt.scenarios[2]).toMatchObject({
        transport: "mcp",
        requestKey: "release-1-review",
        receiptId: "receipt-review",
        runId: fault === "owner" ? "foreign-original-owner" : "run-review",
        ...(fault === "matching"
          ? {
              userId: "mcp:smoke",
              threadKey: "mcp:smoke:release-1-review",
              actualEffort: "high",
              evidence: {
                identityVerified: true,
                record: {
                  id: "run-review",
                  userId: "mcp:smoke",
                  threadKey: "mcp:smoke:release-1-review",
                  profile: { minutes: 15 },
                },
              },
            }
          : {}),
      });
    },
  );

  it.each(["injected", "HTTP202"] as const)(
    "retains a known pending receipt with no owner and stops without replay or further admissions: %s",
    async (source) => {
      const admissions: unknown[] = [];
      const pending = {
        admission: { status: "pending", receiptId: "original-pending", duplicate: false },
        build: { commit },
      };
      const transport =
        source === "injected"
          ? fixture().transport
          : agentSmokeTransport({
              origin: "https://bot.example.test",
              healthUrl: "https://bot.example.test/healthz",
              token: "fixture-only",
              config,
              fetch: withReaderProbe(async (url, init) => {
                if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit } });
                const body = JSON.parse(String(init?.body));
                admissions.push(body.thread);
                return Response.json(pending, { status: 202 });
              }),
            });
      if (source === "injected")
        transport.request = async (_scenario, thread) => {
          admissions.push(thread);
          return pending;
        };
      const receipt = await runAgentSmoke({ config, expectedCommit: commit, thread: "release-1", transport });
      expect(receipt).toMatchObject({
        capabilityOutcome: "incomplete",
        scenarios: [
          {
            outcome: "incomplete",
            reason: "original_owner_pending",
            receiptId: "original-pending",
            requestKey: "release-1-answer",
          },
          { outcome: "skipped" },
          { outcome: "skipped" },
        ],
      });
      expect(admissions).toEqual(["release-1-answer"]);
    },
  );
});

describe("machine MCP reader authentication", () => {
  it.each([
    [true, "mcp_auth_required"],
    [false, "mcp_http_failed"],
  ])("records refused MCP redirects without forwarding credentials: challenge=%s", async (authChallenge, code) => {
    const paths: string[] = [];
    const transport = agentSmokeTransport({
      origin: "https://bot.example.test",
      healthUrl: "https://bot.example.test/healthz",
      token: "fixture-only",
      access: { clientId: "edge-id", clientSecret: "edge-secret" },
      config,
      fetch: async (url, init) => {
        paths.push(String(url));
        if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit } });
        expect(new Headers(init?.headers).get("cf-access-client-id")).toBe("edge-id");
        expect(new Headers(init?.headers).get("cf-access-client-secret")).toBe("edge-secret");
        return new Response("private redirect body", {
          status: 302,
          headers: {
            location: "https://login.example.test/private?token=private-value",
            ...(authChallenge ? { "www-authenticate": "Cloudflare-Access private-value" } : {}),
          },
        });
      },
    });
    const receipt = await runAgentSmoke({ config, expectedCommit: commit, thread: "release-1", transport });
    expect(receipt).toMatchObject({
      capabilityOutcome: "incomplete",
      scenarios: [
        {
          outcome: "incomplete",
          reason: "reader_unproven",
          observationError: { code, http: { status: 302, authChallenge } },
        },
        { outcome: "skipped" },
        { outcome: "skipped" },
      ],
    });
    expect(paths).toEqual(["https://bot.example.test/healthz", "https://bot.example.test/mcp"]);
    expect(JSON.stringify(receipt)).not.toMatch(/private-value|private redirect body|edge-secret|login\.example/);
  });
  it.each([
    ["missing", undefined, "mcp_protocol_mismatch"],
    [
      "denied",
      { channelId: "http:smoke", userId: "http:smoke", repo: "acme/smoke", allowed: false },
      "mcp_read_scope_denied",
    ],
    [
      "foreign channel",
      { channelId: "mcp:smoke", userId: "http:smoke", repo: "acme/smoke", allowed: true },
      "mcp_protocol_mismatch",
    ],
    [
      "foreign user",
      { channelId: "http:smoke", userId: "http:foreign", repo: "acme/smoke", allowed: true },
      "mcp_protocol_mismatch",
    ],
    [
      "foreign repo",
      { channelId: "http:smoke", userId: "http:smoke", repo: "acme/foreign", allowed: true },
      "mcp_protocol_mismatch",
    ],
    [
      "malformed",
      { channelId: "http:smoke", userId: "http:smoke", repo: "acme/smoke", allowed: "yes" },
      "mcp_protocol_mismatch",
    ],
  ])("refuses %s scope proof even when history is empty", async (_name, readScope, code) => {
    const paths: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      paths.push(new URL(String(url)).pathname);
      if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit } });
      const request = JSON.parse(String(init?.body));
      if (String(url).endsWith("/ingress")) return Response.json({ runId: "unexpected-run" }, { status: 202 });
      if (request.method === "initialize")
        return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [
            {
              type: "text",
              text: `runs.list: ok\n${JSON.stringify({ runs: [], readScope, detail: "private-reader-detail" })}`,
            },
          ],
        },
      });
    });
    const receipt = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "release-1",
      transport: agentSmokeTransport({
        origin: "https://bot.example.test",
        healthUrl: "https://bot.example.test/healthz",
        token: "fixture-only",
        config,
        fetch,
      }),
    });
    expect(receipt).toMatchObject({
      capabilityOutcome: "incomplete",
      scenarios: [
        { reason: "reader_unproven", observationError: { code, http: { status: 200, authChallenge: false } } },
        { outcome: "skipped" },
        { outcome: "skipped" },
      ],
    });
    expect(paths).toEqual(["/healthz", "/mcp", "/mcp", "/mcp"]);
    expect(JSON.stringify(receipt)).not.toContain("private-reader-detail");
  });
  it.each(["storeUnavailable", "ledgerUnavailable"])(
    "refuses degraded reader flag %s before starting work",
    async (flag) => {
      const paths: string[] = [];
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        paths.push(new URL(String(url)).pathname);
        if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit } });
        const request = JSON.parse(String(init?.body));
        if (String(url).endsWith("/ingress")) return Response.json({ runId: "unexpected-run" }, { status: 202 });
        if (request.method === "initialize")
          return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [
              {
                type: "text",
                text: `runs.list: ok\n${JSON.stringify({ runs: [], [flag]: true, detail: "private-reader-detail" })}`,
              },
            ],
          },
        });
      });
      const receipt = await runAgentSmoke({
        config,
        expectedCommit: commit,
        thread: "release-1",
        transport: agentSmokeTransport({
          origin: "https://bot.example.test",
          healthUrl: "https://bot.example.test/healthz",
          token: "fixture-only",
          config,
          fetch,
        }),
      });
      expect(receipt).toMatchObject({
        capabilityOutcome: "incomplete",
        scenarios: [
          {
            reason: "reader_unproven",
            observationError: { code: "mcp_reader_unavailable", http: { status: 200, authChallenge: false } },
          },
          { outcome: "skipped" },
          { outcome: "skipped" },
        ],
      });
      expect(paths).toEqual(["/healthz", "/mcp", "/mcp", "/mcp"]);
      expect(JSON.stringify(receipt)).not.toContain("private-reader-detail");
    },
  );
  it("rejects either partial Access credential pair before a request", () => {
    for (const [access, missing] of [
      [{ clientId: "access-client" }, "SMOKE_ACCESS_CLIENT_SECRET"],
      [{ clientSecret: "access-private" }, "SMOKE_ACCESS_CLIENT_ID"],
    ] as const) {
      expect(() =>
        agentSmokeTransport({
          origin: "https://bot.example.test",
          healthUrl: "https://bot.example.test/healthz",
          token: "fixture-only",
          config,
          access,
        }),
      ).toThrow(`${missing} is not set`);
    }
  });
  it("completes the original runs with paired Access auth confined to canonical MCP", async () => {
    const original = fixture();
    const requests: Array<{ path: string; auth: string | null; accessId: string | null; accessSecret: string | null }> =
      [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const headers = new Headers(init?.headers);
      requests.push({
        path,
        auth: headers.get("authorization"),
        accessId: headers.get("cf-access-client-id"),
        accessSecret: headers.get("cf-access-client-secret"),
      });
      if (path === "/healthz") return Response.json({ ok: true, build: { commit, version: "1.0.0" } });
      const request = JSON.parse(String(init?.body));
      if (path === "/ingress") {
        const scenario = request.text.includes("agent:review")
          ? "review"
          : request.text.includes("agent:explore")
            ? "workspace"
            : "answer";
        const admission = (await original.transport.request(
          {
            id: scenario,
            agent: scenario === "workspace" ? "explore" : scenario === "review" ? "review" : "general",
            text: request.text,
            minutes: Number(request.text.match(/budget:(\d+)/)?.[1]),
          },
          request.thread,
        )) as { run: { id: string }; build: unknown };
        return Response.json(
          { runId: admission.run.id, threadKey: `http:smoke:${request.thread}`, build: admission.build },
          { status: 202 },
        );
      }
      if (
        headers.get("cf-access-client-id") !== "access-client" ||
        headers.get("cf-access-client-secret") !== "access-private"
      )
        return Response.json(
          { error: "invalid_token" },
          { status: 401, headers: { "www-authenticate": "Bearer realm=OAuth" } },
        );
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "initialize")
        return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
      if (
        request.params.name === "runs_list" &&
        (request.params.arguments.channel !== "http:smoke" ||
          request.params.arguments.limit !== 1 ||
          request.params.arguments.status !== "all")
      )
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32001, message: "fixture scope refused" },
        });
      const text =
        request.params.name === "runs_list"
          ? 'runs.list: ok\n{"runs":[],"readScope":{"channelId":"http:smoke","userId":"http:smoke","repo":"acme/smoke","allowed":true}}'
          : `runs.get: ok\n${JSON.stringify(original.records.get(request.params.arguments.id))}`;
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text }] } });
    });
    const options = {
      origin: "https://bot.example.test",
      healthUrl: "https://bot.example.test/healthz",
      token: "fixture-only",
      config,
      fetch,
      access: { clientId: "access-client", clientSecret: "access-private" },
    };
    const receipt = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "release-1",
      transport: agentSmokeTransport(options),
    });
    expect(
      receipt.capabilityOutcome,
      JSON.stringify(receipt.scenarios.map(({ reason, observationError }) => ({ reason, observationError }))),
    ).toBe("passed");
    expect(receipt.scenarios.map((row) => [row.runId, row.outcome])).toEqual([
      ["run-answer", "passed"],
      ["run-workspace", "passed"],
      ["run-review", "passed"],
    ]);
    expect(
      requests.filter((row) => row.path === "/mcp").map((row) => [row.auth, row.accessId, row.accessSecret]),
    ).toEqual(expect.arrayContaining([["Bearer fixture-only", "access-client", "access-private"]]));
    expect(
      requests.filter((row) => row.path !== "/mcp").map((row) => [row.path, row.accessId, row.accessSecret]),
    ).toEqual([
      ["/healthz", null, null],
      ["/ingress", null, null],
      ["/healthz", null, null],
      ["/healthz", null, null],
      ["/ingress", null, null],
      ["/healthz", null, null],
      ["/healthz", null, null],
      ["/ingress", null, null],
      ["/healthz", null, null],
    ]);
  });

  it("refuses a reader auth challenge before admission and retains only safe HTTP facts", async () => {
    const paths: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === "/healthz") return Response.json({ ok: true, build: { commit } });
      if (path === "/mcp")
        return new Response("access-private fixture-only", {
          status: 401,
          headers: { "www-authenticate": "Bearer access-private" },
        });
      return Response.json(
        { runId: "admitted-run", threadKey: "http:smoke:release-1-answer", build: { commit } },
        { status: 202 },
      );
    });
    const receipt = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "release-1",
      transport: agentSmokeTransport({
        origin: "https://bot.example.test",
        healthUrl: "https://bot.example.test/healthz",
        token: "fixture-only",
        config,
        fetch,
      }),
    });
    expect(receipt).toMatchObject({
      capabilityOutcome: "incomplete",
      observedUsd: 0,
      scenarios: [
        {
          outcome: "incomplete",
          reason: "reader_unproven",
          observationError: { code: "mcp_auth_required", http: { status: 401, authChallenge: true } },
        },
        { outcome: "skipped" },
        { outcome: "skipped" },
      ],
    });
    expect(paths).toEqual(["/healthz", "/mcp"]);
    expect(JSON.stringify(receipt)).not.toContain("access-private");
    expect(JSON.stringify(receipt)).not.toContain("fixture-only");
  });

  it("distinguishes a denied reader grant from other RPC refusals without retaining remote prose", async () => {
    for (const [code, expected] of [
      [-32001, "mcp_read_unauthorized"],
      [-32602, "mcp_rpc_failed"],
    ] as const) {
      const paths: string[] = [];
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path === "/healthz") return Response.json({ ok: true, build: { commit } });
        const request = JSON.parse(String(init?.body));
        if (request.method === "initialize")
          return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          error: { code, message: "access-private remote prose" },
        });
      });
      const receipt = await runAgentSmoke({
        config,
        expectedCommit: commit,
        thread: "release-1",
        transport: agentSmokeTransport({
          origin: "https://bot.example.test",
          healthUrl: "https://bot.example.test/healthz",
          token: "fixture-only",
          config,
          fetch,
        }),
      });
      expect(receipt).toMatchObject({
        capabilityOutcome: "incomplete",
        scenarios: [
          {
            reason: "reader_unproven",
            observationError: { code: expected, rpcCode: code, http: { status: 200, authChallenge: false } },
          },
          { outcome: "skipped" },
          { outcome: "skipped" },
        ],
      });
      expect(paths).toEqual(["/healthz", "/mcp", "/mcp", "/mcp"]);
      expect(JSON.stringify(receipt)).not.toContain("access-private");
    }
  });

  it("retains an original admission when its MCP read is denied after readiness", async () => {
    let admissions = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit } });
      const request = JSON.parse(String(init?.body));
      if (String(url).endsWith("/ingress")) {
        admissions++;
        return Response.json(
          { runId: "original-run", threadKey: "http:smoke:release-1-answer", build: { commit } },
          { status: 202 },
        );
      }
      if (request.method === "initialize")
        return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.params.name === "runs_list")
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [
              {
                type: "text",
                text: 'runs.list: ok\n{"runs":[],"readScope":{"channelId":"http:smoke","userId":"http:smoke","repo":"acme/smoke","allowed":true}}',
              },
            ],
          },
        });
      return new Response("access-private", { status: 403 });
    });
    const receipt = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "release-1",
      transport: agentSmokeTransport({
        origin: "https://bot.example.test",
        healthUrl: "https://bot.example.test/healthz",
        token: "fixture-only",
        config,
        fetch,
        access: { clientId: "access-client", clientSecret: "access-private" },
      }),
    });
    expect(receipt).toMatchObject({
      capabilityOutcome: "incomplete",
      scenarios: [
        {
          runId: "original-run",
          reason: "run_record_unproven",
          observationError: { code: "mcp_access_denied", http: { status: 403, authChallenge: false } },
        },
        { outcome: "skipped" },
        { outcome: "skipped" },
      ],
    });
    expect(admissions).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain("access-private");
  });

  it("refuses foreign reader metadata before starting a run", async () => {
    for (const identity of [
      { userId: "http:foreign", channelId: "http:smoke" },
      { userId: "http:smoke", channelId: "http:foreign" },
    ]) {
      const paths: string[] = [];
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        paths.push(new URL(String(url)).pathname);
        if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit } });
        const request = JSON.parse(String(init?.body));
        if (request.method === "initialize")
          return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [
              {
                type: "text",
                text: `runs.list: ok\n${JSON.stringify({ runs: [{ ...identity, private: "foreign-private-content" }], readScope: { channelId: "http:smoke", userId: "http:smoke", repo: "acme/smoke", allowed: true } })}`,
              },
            ],
          },
        });
      });
      const receipt = await runAgentSmoke({
        config,
        expectedCommit: commit,
        thread: "release-1",
        transport: agentSmokeTransport({
          origin: "https://bot.example.test",
          healthUrl: "https://bot.example.test/healthz",
          token: "fixture-only",
          config,
          fetch,
        }),
      });
      expect(receipt).toMatchObject({
        capabilityOutcome: "incomplete",
        scenarios: [
          {
            reason: "reader_unproven",
            observationError: { code: "mcp_protocol_mismatch", http: { status: 200, authChallenge: false } },
          },
          { outcome: "skipped" },
          { outcome: "skipped" },
        ],
      });
      expect(paths).toEqual(["/healthz", "/mcp", "/mcp", "/mcp"]);
      expect(JSON.stringify(receipt)).not.toContain("foreign-private-content");
    }
  });
});

describe("native HTTP run readiness", () => {
  const owner = {
    id: "native-run",
    userId: "http:smoke",
    channelId: "http:smoke",
    threadKey: "http:smoke:readiness-answer",
  };
  const scope = { channelId: "http:smoke", userId: "http:smoke", repo: "acme/smoke", allowed: true };
  function setup(
    page: (read: number) => unknown,
    getError?: number,
    record: unknown = { id: "native-run", finished: true, persisted: true },
  ) {
    const operations: string[] = [];
    let lists = 0;
    const transport = agentSmokeTransport({
      origin: "https://bot.example.test",
      healthUrl: "https://bot.example.test/healthz",
      token: "fixture-only",
      config,
      fetch: async (url, init) => {
        if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: { commit } });
        const message = JSON.parse(String(init?.body));
        if (String(url).endsWith("/ingress")) {
          operations.push("admit");
          return Response.json(
            {
              runId: owner.id,
              admission: { status: "accepted", receiptId: "original-receipt", runId: owner.id },
              threadKey: owner.threadKey,
              build: { commit },
            },
            { status: 202 },
          );
        }
        if (message.method === "initialize")
          return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
        if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
        const { name, arguments: args } = message.params;
        operations.push(name);
        if (name === "runs_list") {
          if (!args.thread)
            return Response.json({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                content: [{ type: "text", text: `runs.list: ok\n${JSON.stringify({ runs: [], readScope: scope })}` }],
              },
            });
          expect(args).toEqual({
            status: "all",
            channel: "http:smoke",
            thread: owner.threadKey,
            limit: 200,
            readUser: "http:smoke",
            readRepo: "acme/smoke",
          });
          const result = page(++lists);
          if (result && typeof result === "object" && "rpcCode" in result)
            return Response.json({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: result.rpcCode, message: "private remote error", data: { credential: "private-data" } },
            });
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: `runs.list: ok\n${JSON.stringify(result)}` }] },
          });
        }
        expect(args).toEqual({ id: owner.id, include: "messages" });
        if (getError)
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: getError, message: "private remote error" },
          });
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: `runs.get: ok\n${JSON.stringify(record)}` }],
          },
        });
      },
    });
    return { transport, operations };
  }
  it("waits on a complete authorized empty page for only the original owner", async () => {
    vi.useFakeTimers();
    try {
      const s = setup((n) => ({
        runs: n === 1 ? [{ ...owner, id: "sibling" }] : [owner],
        readScope: scope,
        ...(n === 2 ? { nextBefore: { finishedAt: 1, id: "older" } } : {}),
      }));
      await s.transport.request({ id: "answer", agent: "general", text: "question", minutes: 4 }, "readiness-answer");
      const pending = s.transport.readRun(owner.id);
      await vi.runAllTimersAsync();
      expect(await pending).toEqual({ id: "native-run", finished: true, persisted: true });
      expect(s.operations).toEqual(["admit", "runs_list", "runs_list", "runs_get"]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("reports an original terminal refusal without waiting for a model run or admitting another scenario", async () => {
    const s = setup(() => ({ runs: [owner], readScope: scope }), undefined, {
      ...owner,
      agent: "door",
      finished: true,
      persisted: true,
      events: [{ type: "refusal", code: "agent_allowlist", cause: "policy", text: "private remote prose" }],
    });
    const receipt = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "readiness",
      transport: s.transport,
    });
    expect(receipt.scenarios[0]).toMatchObject({
      runId: "native-run",
      receiptId: "original-receipt",
      outcome: "failed",
      reason: "admission_refused",
      refusal: { code: "agent_allowlist", cause: "policy" },
    });
    expect(receipt.scenarios.slice(1).map((row) => row.reason)).toEqual([
      "prior_scenario_unproven",
      "prior_scenario_unproven",
    ]);
    expect(s.operations).toEqual(["runs_list", "admit", "runs_list", "runs_get"]);
    expect(JSON.stringify(receipt)).not.toContain("private remote prose");
  });
  it.each(["foreign requester", "mismatched cause"])("does not trust a terminal decision with a %s", async (fault) => {
    const s = setup(() => ({ runs: [owner], readScope: scope }), undefined, {
      ...owner,
      ...(fault === "foreign requester" ? { userId: "http:other" } : {}),
      agent: "door",
      finished: true,
      persisted: true,
      events: [{ type: "refusal", code: "agent_allowlist", cause: "system", text: "private remote prose" }],
    });
    const receipt = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "readiness",
      transport: s.transport,
    });
    expect(receipt.scenarios[0]).toMatchObject({
      runId: "native-run",
      outcome: fault === "foreign requester" ? "incomplete" : "failed",
      reason: fault === "foreign requester" ? "run_record_unproven" : "no_agent_run",
    });
    expect(receipt.scenarios[0]!.refusal).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain("private remote prose");
    expect(s.operations).toEqual(["runs_list", "admit", "runs_list", "runs_get"]);
  });
  it.each([
    ["missing scope", { runs: [owner] }, "mcp_protocol_mismatch"],
    ["denied scope", { runs: [owner], readScope: { ...scope, allowed: false } }, "mcp_read_scope_denied"],
    ["foreign scope", { runs: [owner], readScope: { ...scope, repo: "other/repo" } }, "mcp_protocol_mismatch"],
    ["store unavailable", { runs: [owner], readScope: scope, storeUnavailable: true }, "mcp_reader_unavailable"],
    ["ledger unavailable", { runs: [owner], readScope: scope, ledgerUnavailable: true }, "mcp_reader_unavailable"],
    ["foreign owner", { runs: [{ ...owner, userId: "http:other" }], readScope: scope }, "mcp_protocol_mismatch"],
    ["foreign channel", { runs: [{ ...owner, channelId: "http:other" }], readScope: scope }, "mcp_protocol_mismatch"],
    [
      "foreign thread",
      { runs: [{ ...owner, threadKey: "http:smoke:other" }], readScope: scope },
      "mcp_protocol_mismatch",
    ],
    [
      "incomplete page",
      { runs: [], readScope: scope, nextBefore: { finishedAt: 1, id: "older" } },
      "mcp_run_listing_incomplete",
    ],
    ["masked RPC refusal", { rpcCode: -32002 }, "mcp_rpc_failed"],
    ["unauthorized RPC", { rpcCode: -32001 }, "mcp_read_unauthorized"],
  ])("retains the accepted owner and stops on %s", async (_label, page, code) => {
    const s = setup(() => page);
    const receipt = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "readiness",
      transport: s.transport,
    });
    expect(receipt.scenarios[0]).toMatchObject({
      runId: owner.id,
      receiptId: "original-receipt",
      admissionStatus: "accepted",
      outcome: "incomplete",
      reason: "run_record_unproven",
      observationError: { code },
    });
    expect(receipt.scenarios.slice(1).map((r) => r.reason)).toEqual([
      "prior_scenario_unproven",
      "prior_scenario_unproven",
    ]);
    expect(s.operations).toEqual(["runs_list", "admit", "runs_list"]);
    expect(JSON.stringify(receipt)).not.toContain("private remote");
    expect(JSON.stringify(receipt)).not.toContain("private-data");
  });
  it("keeps the original deadline when the owner never becomes visible", async () => {
    vi.useFakeTimers();
    try {
      const s = setup(() => ({ runs: [], readScope: scope }));
      const pending = runAgentSmoke({ config, expectedCommit: commit, thread: "readiness", transport: s.transport });
      await vi.runAllTimersAsync();
      const receipt = await pending;
      expect(receipt.scenarios[0]).toMatchObject({
        runId: owner.id,
        receiptId: "original-receipt",
        admissionStatus: "accepted",
        outcome: "incomplete",
        observationError: { code: "run_deadline_exceeded" },
      });
      expect(s.operations.filter((op) => op === "admit")).toEqual(["admit"]);
      expect(s.operations).not.toContain("runs_get");
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not retry a masked point-read refusal after positive visibility", async () => {
    const s = setup(() => ({ runs: [owner], readScope: scope }), -32002);
    const receipt = await runAgentSmoke({
      config,
      expectedCommit: commit,
      thread: "readiness",
      transport: s.transport,
    });
    expect(receipt.scenarios[0]).toMatchObject({
      runId: owner.id,
      receiptId: "original-receipt",
      outcome: "incomplete",
      observationError: { code: "mcp_rpc_failed", operation: "runs_get", rpcCode: -32002 },
    });
    expect(s.operations).toEqual(["runs_list", "admit", "runs_list", "runs_get"]);
    expect(JSON.stringify(receipt)).not.toContain("private remote");
  });
});
