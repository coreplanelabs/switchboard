import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../config.js";
import { getAgent } from "../../agents/registry.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { Provider } from "../../providers/types.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import type { RepoContext } from "../repoContext.js";
import type { ChannelIO, HistoryItem, IncomingMessage } from "../types.js";
import type { ResumeContext } from "./admission.js";
import { readRequest, resolveRun, resolveTarget, type ResolveDeps } from "./resolve.js";

// Feature: docs/reference/specs/routing-and-config.md items 1–3 — the resolve
// stage's own contract: the request read (directives stripped, history
// fetched), the (agent, model, effort) triple through the layers with thread
// stickiness, and the target's resolution started as a promise. What the
// resolved triple does to a run (the card label, the model call, the gates) is
// proven end to end through `dispatch()` in `src/core/dispatcher.test.ts`.

const NOW = 10_000;

const YAML = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
    coding: anthropic/coding-model
    review: anthropic/review-model
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
`;

function configStore(): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-resolve-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, YAML);
  return new ConfigStore(path, join(dir, "overrides.json"));
}

const msg = (text: string): IncomingMessage => ({
  channelId: "slack:CX",
  userId: "slack:UX",
  threadKey: "slack:CX:1.0",
  text,
});

/** A provider registry that hands out one fake provider and remembers what it was asked for. */
function providers(): { registry: ProviderRegistry; asked: string[]; provider: Provider } {
  const asked: string[] = [];
  const provider: Provider = {
    name: "fake",
    async complete() {
      return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
    },
  };
  const registry = {
    get: (name: string) => {
      asked.push(name);
      if (name !== "anthropic") throw new Error(`Unknown provider "${name}"`);
      return provider;
    },
  } as unknown as ProviderRegistry;
  return { registry, asked, provider };
}

function root(message: IncomingMessage) {
  return startRequestRoot({ clock: () => NOW }, { channel: channelOf(message.channelId), receivedAt: NOW });
}

describe("readRequest — the request as the model will see it", () => {
  it("parses and strips the directives, and fetches the thread's history under its own span", async () => {
    const message = msg("agent:review look at this");
    const history: HistoryItem[] = [{ role: "user", text: "earlier" }];
    let fetched = 0;
    const io: ChannelIO = {
      reply: async () => {},
      status: async () => ({ update: () => {}, done: async () => {} }),
      history: async () => {
        fetched++;
        return history;
      },
    };
    const trace = root(message);
    const out = await readRequest({ msg: message, io, root: trace.root });
    expect(out.directives.agent).toBe("review");
    expect(out.directives.text).toBe("look at this");
    expect(out.history).toBe(history);
    expect(fetched).toBe(1);
    expect(trace.spansSoFar().map((s) => s.name)).toContain("dispatch.history");
  });
});

describe("resolveRun — the (agent, model, effort) triple", () => {
  const deps = (): ResolveDeps => ({ config: configStore(), providers: providers().registry });

  it("a request directive wins over the thread's sticky directive, which wins over the defaults", () => {
    const history: HistoryItem[] = [{ role: "user", text: "agent:coding effort:low start the work" }];
    const message = msg("agent:review and now review it");
    const { sticky, resolved } = resolveRun(deps(), {
      msg: message,
      directives: { agent: "review", text: "and now review it" },
      history,
    });
    expect(sticky.agent).toBe("coding");
    expect(sticky.effort).toBe("low");
    expect(resolved.agentName).toBe("review");
    expect(resolved.modelRef).toBe("anthropic/review-model");
    expect(resolved.effort).toBe("low"); // no effort on this message: the thread's sticky effort still applies
  });

  it("a follow-up without directives runs on the agent the thread established", () => {
    const history: HistoryItem[] = [{ role: "user", text: "agent:coding start the work" }];
    const { resolved } = resolveRun(deps(), { msg: msg("continue"), directives: { text: "continue" }, history });
    expect(resolved.agentName).toBe("coding");
    expect(resolved.modelRef).toBe("anthropic/coding-model");
  });

  it("with no directive anywhere the defaults apply, and the effort is unset", () => {
    const { sticky, resolved } = resolveRun(deps(), { msg: msg("hello"), directives: { text: "hello" }, history: [] });
    expect(sticky).toEqual({});
    expect(resolved.agentName).toBe("general");
    expect(resolved.modelRef).toBe("anthropic/general-model");
    expect(resolved.effort).toBeUndefined();
  });
});

describe("resolveTarget — the provider, and the target repo/ref/PR started", () => {
  const message = msg("fix the login bug in acme/api");
  const history: HistoryItem[] = [];
  const resolvedFor = (agentName: string) =>
    resolveRun(
      { config: configStore(), providers: providers().registry },
      { msg: message, directives: { agent: agentName, text: message.text }, history },
    ).resolved;

  it("an agent that declares no repository resolves none: the resolver is never asked, the context is empty", async () => {
    const p = providers();
    const calls: unknown[] = [];
    const deps: ResolveDeps = {
      config: configStore(),
      providers: p.registry,
      resolveRepoContext: (m, h) => {
        calls.push([m, h]);
        return { repo: "acme/api" };
      },
    };
    const agent = getAgent("general");
    expect(agent.resources?.repo).toBeUndefined();
    const out = resolveTarget(deps, {
      msg: message,
      history,
      agent,
      resolved: resolvedFor("general"),
      resume: undefined,
      root: root(message).root,
    });
    expect(out.provider).toBe(p.provider);
    expect(out.model).toBe("general-model");
    expect(p.asked).toEqual(["anthropic"]);
    expect(out.needsRepo).toBe(false);
    expect(await out.repoCtxP).toEqual({});
    expect(calls).toEqual([]);
  });

  it("a repo-needing agent resolves the target through the injected resolver, once, with the message and the history; an empty answer means no repo", async () => {
    const calls: unknown[] = [];
    let answer: RepoContext = { repo: "acme/api", ref: "main" };
    const deps: ResolveDeps = {
      config: configStore(),
      providers: providers().registry,
      resolveRepoContext: (m, h) => {
        calls.push([m, h]);
        return answer;
      },
    };
    const agent = getAgent("coding");
    expect(agent.resources?.repo).toBe("required");
    const first = resolveTarget(deps, {
      msg: message,
      history,
      agent,
      resolved: resolvedFor("coding"),
      resume: undefined,
      root: root(message).root,
    });
    expect(first.needsRepo).toBe(true);
    expect(await first.repoCtxP).toEqual({ repo: "acme/api", ref: "main" });
    expect(calls).toEqual([[message, history]]);
    answer = {};
    const second = resolveTarget(deps, {
      msg: message,
      history,
      agent,
      resolved: resolvedFor("coding"),
      resume: undefined,
      root: root(message).root,
    });
    expect(await second.repoCtxP).toEqual({});
  });

  it("a resume carries the repo context its row was reclaimed with: the resolver is not asked", async () => {
    const calls: unknown[] = [];
    const deps: ResolveDeps = {
      config: configStore(),
      providers: providers().registry,
      resolveRepoContext: () => {
        calls.push(1);
        return { repo: "acme/other" };
      },
    };
    const resume = { repoCtx: { repo: "acme/api", ref: "main", pr: 41 } } as unknown as ResumeContext;
    const out = resolveTarget(deps, {
      msg: message,
      history,
      agent: getAgent("coding"),
      resolved: resolvedFor("coding"),
      resume,
      root: root(message).root,
    });
    expect(await out.repoCtxP).toEqual({ repo: "acme/api", ref: "main", pr: 41 });
    expect(calls).toEqual([]);
  });

  it("an unknown provider throws before anything is resolved", () => {
    const store = configStore();
    const resolved = { ...resolvedFor("general"), modelRef: "nowhere/model" };
    const calls: unknown[] = [];
    const deps: ResolveDeps = {
      config: store,
      providers: providers().registry,
      resolveRepoContext: () => {
        calls.push(1);
        return {};
      },
    };
    expect(() =>
      resolveTarget(deps, {
        msg: message,
        history,
        agent: getAgent("coding"),
        resolved,
        resume: undefined,
        root: root(message).root,
      }),
    ).toThrow(/Unknown provider "nowhere"/);
    expect(calls).toEqual([]);
  });
});
