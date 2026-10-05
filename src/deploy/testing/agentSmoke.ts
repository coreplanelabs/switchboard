import { vi } from "vitest";
import { getAgent } from "../../agents/registry.js";
import { effectiveProfile } from "../../config/profile.js";
import { leaseMinimum } from "../../core/budgets.js";
import { parseDirectives } from "../../directives.js";
import { captureAnswerOutcome } from "../../core/answerOutcome.js";
import { assembleRunRecord } from "../../core/dispatch/record.js";
import { analyzeRunFriction } from "../../core/runFriction.js";
import { RunRegistry } from "../../core/runRegistry.js";
import { InMemoryRunStore } from "../../core/runStore.js";
import { createRunsService } from "../../core/runsService.js";
import type { SmokeTransport } from "../agentSmoke.js";

export const commit = "a".repeat(40);
export const head = "b".repeat(40);
export const config = {
  disposable: true,
  channel: "smoke",
  subject: "smoke",
  repo: "acme/smoke",
  workspace: { path: "SMOKE.md", answer: "smoke fixture" },
  review: { number: 7, head },
  maxObservedUsd: 1,
};

/** Admission, record assembly and fresh final-run projection use the real seams. */
export function fixture() {
  const records = new Map<string, unknown>();
  const registry = new RunRegistry({ now: () => 10 });
  const store = new InMemoryRunStore({ now: () => 10 });
  const service = createRunsService({ registry, store, clock: () => 10 });
  const transport: SmokeTransport = {
    health: vi.fn(async () => ({ commit, version: "1.0.0" })),
    request: vi.fn(async (scenario, thread) => {
      const agent = getAgent(scenario.agent);
      const directives = parseDirectives(scenario.text);
      if (directives.budget !== scenario.minutes) throw new Error("request and receipt lease differ");
      const admission = effectiveProfile(agent, directives, undefined, leaseMinimum(agent.name));
      if (admission.kind !== "profile") throw new Error("smoke lease was refused");
      const id = `run-${scenario.id}`;
      const identity = { userId: "http:smoke", channelId: "http:smoke", threadKey: `http:smoke:${thread}` };
      const repo = scenario.id === "answer" ? undefined : config.repo;
      const run = registry.create(
        "fixture",
        { ...identity, agent: agent.name, repo, channelVisibility: "machine" },
        { id },
      );
      registry.publish(id, { type: "answer", text: scenario.id === "answer" ? "4" : "smoke fixture" });
      registry.publish(id, { type: "tool_call", tool: "read", callId: "read-1", summary: "fixture read" });
      registry.publish(id, { type: "tool_result", tool: "read", callId: "read-1", ok: true, summary: "fixture read" });
      registry.publish(id, {
        type: "span_end",
        name: "model.turn",
        spanId: "fixture-turn",
        startedAt: 10,
        durationMs: 0,
        status: "ok",
        attrs: { model: "fixture/model", inputTokens: 1, outputTokens: 1, usd: 0.1 },
      });
      registry.finish(id, "completed");
      const seal = registry.seal(id, { replyOk: true });
      const snap = registry.snapshotById(id)!;
      const record = assembleRunRecord({
        run,
        snap,
        seal,
        agent: agent.name,
        repo,
        msg: identity,
        channelVisibility: "machine",
        finishedAt: 10,
        status: "completed",
        diagnosis: analyzeRunFriction(snap.events),
        profile: { ...admission.profile, preset: agent.name },
        answerOutcome: captureAnswerOutcome(undefined, false, undefined),
        ...(scenario.id === "review"
          ? { reviewHead: head, reviewPost: { posted: true as const, target: { repo: config.repo, number: 7 }, head } }
          : {}),
      });
      const saved = await store.put(record);
      if (!saved.ok || !saved.stored) throw new Error("fixture final record not stored");
      registry.markPersisted(id);
      const view = await service.getRun(id, { include: "messages" });
      if (!view.ok) throw new Error("fixture final projection unavailable");
      records.set(id, view.value);
      return { reply: "ignored display text", build: { commit, version: "1.0.0" }, run: { id, status: "completed" } };
    }),
    readRun: vi.fn(async (id) => records.get(id)),
  };
  return { transport, records };
}
