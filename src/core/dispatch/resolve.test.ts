import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../config.js";
import { getAgent, type Identity, type MachineClass } from "../../agents/registry.js";
import { declaredProfile } from "../../config/profile.js";
import { resetResidentProbeCache } from "../../execution/factory.js";
import { resolveGithubToken } from "../../execution/githubApp.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import type { RepoContext } from "../repoContext.js";
import type { ChannelIO, HistoryItem, IncomingMessage } from "../types.js";
import type { ResumeContext } from "./admission.js";
import { readRequest, resolveProfile, resolveRun, resolveTarget, type ResolveDeps } from "./resolve.js";

// Feature: docs/reference/specs/routing-and-config.md items 1–3 — the resolve
// stage's own contract: the request read (directives stripped, history
// fetched), the (agent, model, effort) triple through the layers with thread
// stickiness, and the target's resolution started as a promise. What the
// resolved triple does to a run (the card label, the model call, the gates) is
// proven end to end through `dispatch()` in `src/core/dispatcher.test.ts`.

// The repo-cold vet mints the run's credential; the mock answers a scope-tagged
// token so the tests assert the scope asked for without a key or the network.
vi.mock("../../execution/githubApp.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../execution/githubApp.js")>();
  return {
    ...mod,
    resolveGithubToken: vi.fn(async (scope?: "read" | "write") => `ghs_${scope ?? "write"}`),
  };
});

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

/** The same deployment with a Cloudflare sandbox AND a resident fleet configured. */
const RESIDENT_YAML =
  YAML +
  `
execution:
  type: cloudflare
  url: https://sandbox.example
  resident:
    baseUrl: https://resident.example
`;

function configStore(yaml = YAML): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-resolve-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, yaml);
  return new ConfigStore(path, join(dir, "overrides.json"));
}

const msg = (text: string): IncomingMessage => ({
  channelId: "slack:CX",
  userId: "slack:UX",
  threadKey: "slack:CX:1.0",
  text,
});

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
  const deps = (): ResolveDeps => ({ config: configStore() });

  it("a request directive wins over the thread's sticky directive, which wins over the defaults", () => {
    const history: HistoryItem[] = [{ role: "user", text: "effort:low start the work" }];
    const message = msg("agent:review and now review it");
    const { sticky, resolved } = resolveRun(deps(), {
      msg: message,
      directives: { agent: "review", text: "and now review it" },
      history,
      stickyAgent: "coding",
    });
    expect(sticky.agent).toBe("coding");
    expect(sticky.effort).toBe("low");
    expect(resolved.agentName).toBe("review");
    expect(resolved.modelRef).toBe("anthropic/review-model");
    expect(resolved.effort).toBe("low"); // no effort on this message: the thread's sticky effort still applies
  });

  it("a follow-up without directives runs on the agent the thread established — the caller's read of the thread's transcript; an agent: token in the history alone establishes nothing", () => {
    const history: HistoryItem[] = [{ role: "user", text: "agent:coding start the work" }];
    const byTranscript = resolveRun(deps(), {
      msg: msg("continue"),
      directives: { text: "continue" },
      history,
      stickyAgent: "coding",
    });
    expect(byTranscript.resolved.agentName).toBe("coding");
    expect(byTranscript.resolved.modelRef).toBe("anthropic/coding-model");
    expect(byTranscript.agentSource).toBe("sticky");
    const fromHistory = resolveRun(deps(), { msg: msg("continue"), directives: { text: "continue" }, history });
    expect(fromHistory.sticky.agent).toBeUndefined();
    expect(fromHistory.resolved.agentName).toBe("general");
  });

  // routing-and-config item 3: the agent of the thread's newest continuable run
  // is sticky by transcript; the model and the effort are the user turns'.
  it("the thread's sticky agent by transcript joins the user turns' model and effort; a directive still wins over it", () => {
    const history: HistoryItem[] = [{ role: "user", text: "agent:review effort:low look at it" }];
    const byTranscript = resolveRun(deps(), {
      msg: msg("continue"),
      directives: { text: "continue" },
      history,
      stickyAgent: "coding",
    });
    expect(byTranscript.sticky).toEqual({ agent: "coding", effort: "low" });
    expect(byTranscript.resolved.agentName).toBe("coding");
    expect(byTranscript.resolved.modelRef).toBe("anthropic/coding-model");
    expect(byTranscript.resolved.effort).toBe("low");
    expect(byTranscript.agentSource).toBe("sticky");
    const directed = resolveRun(deps(), {
      msg: msg("agent:general summarize"),
      directives: { agent: "general", text: "summarize" },
      history,
      stickyAgent: "coding",
    });
    expect(directed.resolved.agentName).toBe("general");
    expect(directed.agentSource).toBe("directive");
  });

  it("with no directive anywhere the defaults apply, and the effort is unset", () => {
    const { sticky, resolved } = resolveRun(deps(), { msg: msg("hello"), directives: { text: "hello" }, history: [] });
    expect(sticky).toEqual({});
    expect(resolved.agentName).toBe("general");
    expect(resolved.modelRef).toBe("anthropic/general-model");
    expect(resolved.effort).toBeUndefined();
  });
});

describe("resolveTarget — the provider checked, and the target repo/ref/PR started", () => {
  const message = msg("fix the login bug in acme/api");
  const history: HistoryItem[] = [];
  const resolvedFor = (agentName: string) =>
    resolveRun(
      { config: configStore() },
      { msg: message, directives: { agent: agentName, text: message.text }, history },
    ).resolved;

  it("an agent that declares no repository resolves none: the resolver is never asked, the context is empty", async () => {
    const calls: unknown[] = [];
    const deps: ResolveDeps = {
      config: configStore(),
      resolveRepoContext: (m, h) => {
        calls.push([m, h]);
        return { repo: "acme/api" };
      },
    };
    const agent = getAgent("general");
    expect(agent.machine).toBe("none");
    const out = resolveTarget(deps, {
      msg: message,
      history,
      agent,
      profile: declaredProfile(agent),
      resolved: resolvedFor("general"),
      resume: undefined,
      root: root(message).root,
    });
    expect(out.needsRepo).toBe(false);
    expect(await out.repoCtxP).toEqual({});
    expect(calls).toEqual([]);
  });

  // The run's own model calls go through the proxy with the config's key, so
  // a model ref naming a provider the config lacks is refused here, before any
  // card — not at pi's first model call, minutes in.
  it("a model ref naming a provider the config does not have throws by name before any card, listing the configured ones", () => {
    const agent = getAgent("general");
    const resolved = resolveRun(
      { config: configStore() },
      { msg: message, directives: { agent: "general", model: "nope/some-model", text: message.text }, history },
    ).resolved;
    expect(resolved.modelRef).toBe("nope/some-model");
    expect(() =>
      resolveTarget(
        { config: configStore() },
        {
          msg: message,
          history,
          agent,
          profile: declaredProfile(agent),
          resolved,
          resume: undefined,
          root: root(message).root,
        },
      ),
    ).toThrow(/Unknown provider "nope"\. Configured providers: anthropic/);
  });

  // The card (record 0052): resolved here, beside the block check,
  // and every control decided before any ack card, span or model call.
  it("resolves the run's one model card and its decisions beside the block check", () => {
    const agent = getAgent("general");
    const resolved = resolveRun(
      { config: configStore() },
      { msg: message, directives: { agent: "general", effort: "high", text: message.text }, history },
    ).resolved;
    const out = resolveTarget(
      { config: configStore() },
      {
        msg: message,
        history,
        agent,
        profile: declaredProfile(agent),
        resolved,
        resume: undefined,
        root: root(message).root,
      },
    );
    // `general-model` is no registry card, so every field falls to the wire
    // layer and the asked tier goes out unvouched — decided, not refused.
    expect(out.modelCard.ref).toBe("anthropic/general-model");
    expect(out.modelCard.wire).toBe("anthropic-messages");
    expect(out.modelCard.provenance.levels).toBe("wire");
    expect(out.decisions.find((d) => d.control === "effort")).toMatchObject({
      outcome: "degraded",
      asked: "high",
      applied: "high",
      vouched: false,
    });
  });

  it("a control the card refuses ends the run here, naming the model and what it takes", () => {
    const withOverride = YAML.replace(
      "    apiKeyEnv: ANTHROPIC_API_KEY",
      "    apiKeyEnv: ANTHROPIC_API_KEY\n    models:\n      general-model:\n        levels: { max: null }",
    );
    const agent = getAgent("general");
    const resolved = resolveRun(
      { config: configStore(withOverride) },
      { msg: message, directives: { agent: "general", effort: "max", text: message.text }, history },
    ).resolved;
    expect(() =>
      resolveTarget(
        { config: configStore(withOverride) },
        {
          msg: message,
          history,
          agent,
          profile: declaredProfile(agent),
          resolved,
          resume: undefined,
          root: root(message).root,
        },
      ),
    ).toThrow(/Model "anthropic\/general-model" refuses effort "max": general-model does not take effort "max"/);
  });

  // The Responses wire is pi's alone (record 0052, U42): OpenCode's bundled
  // @ai-sdk/openai is unmeasured against the logging fake, so a preset on
  // OpenCode with a Responses block is refused here by name, never a call
  // that fails mid-run. The same block on pi (the default harness) resolves.
  it("a preset on OpenCode with a Responses block is refused at dispatch by name; the same block on pi resolves", () => {
    const withResponses = YAML.replace(
      "    apiKeyEnv: ANTHROPIC_API_KEY",
      "    apiKeyEnv: ANTHROPIC_API_KEY\n  openai:\n    wire: openai-responses\n    baseUrl: https://api.openai.com/v1\n    apiKeyEnv: OPENAI_API_KEY",
    );
    const agent = getAgent("general");
    const resolved = resolveRun(
      { config: configStore(withResponses) },
      { msg: message, directives: { agent: "general", model: "openai/gpt-5.4", text: message.text }, history },
    ).resolved;
    const ctxFor = (harness: typeof resolved.harness) => ({
      msg: message,
      history,
      agent,
      profile: declaredProfile(agent),
      resolved: { ...resolved, ...(harness ? { harness } : {}) },
      resume: undefined,
      root: root(message).root,
    });
    expect(() =>
      resolveTarget({ config: configStore(withResponses) }, ctxFor({ name: "opencode", scope: "user" })),
    ).toThrow(
      /Model "openai\/gpt-5\.4" speaks the openai-responses wire, which the "opencode" harness cannot speak yet/,
    );
    const onPi = resolveTarget({ config: configStore(withResponses) }, ctxFor(undefined));
    expect(onPi.modelCard.wire).toBe("openai-responses");
  });

  it("a repo-needing agent resolves the target through the injected resolver, once, with the message and the history; an empty answer means no repo", async () => {
    const calls: unknown[] = [];
    let answer: RepoContext = { repo: "acme/api", ref: "main" };
    const deps: ResolveDeps = {
      config: configStore(),
      resolveRepoContext: (m, h) => {
        calls.push([m, h]);
        return answer;
      },
    };
    const agent = getAgent("coding");
    expect(agent.machine).toBe("repo-resident");
    const first = resolveTarget(deps, {
      msg: message,
      history,
      agent,
      profile: declaredProfile(agent),
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
      profile: declaredProfile(agent),
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
      profile: declaredProfile(getAgent("coding")),
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
        profile: declaredProfile(getAgent("coding")),
        resolved,
        resume: undefined,
        root: root(message).root,
      }),
    ).toThrow(/Unknown provider "nowhere"/);
    expect(calls).toEqual([]);
  });
});

// Feature: docs/reference/specs/execution.md item 18 — which vet a bare
// `owner/name` gets is the machine class's: `repo-resident` asks the resident
// registry, `repo-cold` asks GitHub with the run's credential and never the
// registry, `blank` resolves no repository at all. Proven against the
// PRODUCTION resolver (no injected seam) with the network stubbed, on a
// deployment that has both a sandbox and a resident fleet configured.
describe("resolveTarget — the vet a machine class gets", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetResidentProbeCache();
  });

  const message = msg("fix the login bug in acme/api");

  /** Every fetch answered by `answer`; the URLs asked for are kept in order. */
  function stubFetch(answer: (url: string) => Response) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        calls.push(String(url));
        return answer(String(url));
      }),
    );
    return calls;
  }

  /** The target for a coding-shaped agent on `machine` (and, when given, another
   *  identity), resolved by the production resolver. */
  function target(machine: MachineClass, identity: Identity = "write") {
    const store = configStore(RESIDENT_YAML);
    const resolved = resolveRun(
      { config: store },
      { msg: message, directives: { agent: "coding", text: message.text }, history: [] },
    ).resolved;
    const agent = { ...getAgent("coding"), machine, identity };
    return resolveTarget(
      { config: store },
      {
        msg: message,
        history: [],
        agent,
        profile: declaredProfile(agent),
        resolved,
        resume: undefined,
        root: root(message).root,
      },
    );
  }

  it("repo-resident: the slug is vetted against the resident registry — one GET /status, no GitHub call", async () => {
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.mocked(resolveGithubToken).mockClear();
    const calls = stubFetch(() => new Response(JSON.stringify({ state: "warm", reason: "" }), { status: 200 }));
    const out = target("repo-resident");
    expect(out.needsRepo).toBe(true);
    expect(await out.repoCtxP).toEqual({ repo: "acme/api" });
    expect(calls).toHaveLength(1);
    const asked = new URL(calls[0]);
    expect(asked.host).toBe("resident.example");
    expect(asked.pathname).toBe("/status");
    expect(asked.searchParams.get("resource")).toBe("repo:acme/api");
    expect(resolveGithubToken).not.toHaveBeenCalled();
  });

  it("repo-cold: the same slug is vetted against GitHub with the run's credential — the resident registry is never asked", async () => {
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.mocked(resolveGithubToken).mockClear();
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const out = target("repo-cold");
    expect(out.needsRepo).toBe(true);
    expect(await out.repoCtxP).toEqual({ repo: "acme/api" });
    expect(calls).toEqual(["https://api.github.com/repos/acme/api"]);
    expect(resolveGithubToken).toHaveBeenCalledWith("write"); // coding's identity is `write`: the credential the sandbox gets
  });

  it("repo-cold on a `read` identity vets with a read token; on `none` it vets anonymously and mints nothing", async () => {
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.mocked(resolveGithubToken).mockClear();
    stubFetch(() => new Response("{}", { status: 200 }));
    expect(await target("repo-cold", "read").repoCtxP).toEqual({ repo: "acme/api" });
    expect(resolveGithubToken).toHaveBeenCalledWith("read");
    vi.mocked(resolveGithubToken).mockClear();
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    expect(await target("repo-cold", "none").repoCtxP).toEqual({ repo: "acme/api" });
    expect(calls).toEqual(["https://api.github.com/repos/acme/api"]);
    expect(resolveGithubToken).not.toHaveBeenCalled();
  });

  it("repo-cold: GitHub's 404 is a rejected slug and an unanswered vet is unverified — nothing binds, the registry stays untouched", async () => {
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    const refused = stubFetch(() => new Response("{}", { status: 404 }));
    expect(await target("repo-cold").repoCtxP).toEqual({ rejectedRepo: "acme/api" });
    expect(refused).toEqual(["https://api.github.com/repos/acme/api"]);
    const silent = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await target("repo-cold").repoCtxP).toEqual({ unverifiedRepo: "acme/api" });
    expect(silent).toEqual(["https://api.github.com/repos/acme/api"]);
  });

  it("blank: no repository is resolved and no vet of any kind runs", async () => {
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.mocked(resolveGithubToken).mockClear();
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const out = target("blank");
    expect(out.needsRepo).toBe(false);
    expect(await out.repoCtxP).toEqual({});
    expect(calls).toEqual([]);
    expect(resolveGithubToken).not.toHaveBeenCalled();
  });
});

// docs/reference/specs/routing-and-config.md item 2: the effective profile is
// preset ∩ boundary, computed once in the resolve stage; the gate judges it.
describe("resolveProfile — the effective profile once the preset is known", () => {
  const BOUNDED_YAML = `${YAML}channels:
  "slack:CX":
    boundary:
      maxMinutes: 10
      maxIdentity: read
`;
  const resolvedIn = (yaml: string, agent: string) => {
    const store = configStore(yaml);
    return store.resolve({ channelId: "slack:CX", userId: "slack:UX", request: { agent } });
  };

  it("with no boundary on the path every preset resolves to its declared profile", () => {
    for (const name of ["general", "coding", "review"]) {
      const agent = getAgent(name);
      expect(resolveProfile({ agent, resolved: resolvedIn(YAML, name), resume: undefined })).toEqual({
        kind: "profile",
        profile: declaredProfile(agent),
      });
    }
  });

  it("a bounded channel clips a budget above its cap naming the scope, and refuses an identity above its cap", () => {
    const review = getAgent("review");
    expect(resolveProfile({ agent: review, resolved: resolvedIn(BOUNDED_YAML, "review"), resume: undefined })).toEqual({
      kind: "profile",
      profile: { machine: "repo-resident", identity: "read", minutes: 10, boundedBy: "channel" },
    });
    const coding = getAgent("coding");
    expect(resolveProfile({ agent: coding, resolved: resolvedIn(BOUNDED_YAML, "coding"), resume: undefined })).toEqual({
      kind: "refused",
      refusal: { axis: "identity", needs: "write", cap: "read", scope: "channel" },
    });
  });

  it("a `budget:` directive is the caller's own boundary: it narrows the preset's minutes as `directive`, a value at or above the preset changes nothing, and a tighter scope boundary wins the attribution", () => {
    const explore = getAgent("explore");
    expect(
      resolveProfile({ agent: explore, resolved: resolvedIn(YAML, "explore"), resume: undefined, budget: 30 }),
    ).toEqual({
      kind: "profile",
      profile: { machine: "repo-cold", identity: "read", minutes: 30, boundedBy: "directive" },
    });
    expect(
      resolveProfile({ agent: explore, resolved: resolvedIn(YAML, "explore"), resume: undefined, budget: 200 }),
    ).toEqual({ kind: "profile", profile: declaredProfile(explore) });
    // The channel caps at 10: below the directive's 30, so the channel is what clipped.
    expect(
      resolveProfile({ agent: explore, resolved: resolvedIn(BOUNDED_YAML, "explore"), resume: undefined, budget: 30 }),
    ).toEqual({
      kind: "profile",
      profile: { machine: "repo-cold", identity: "read", minutes: 10, boundedBy: "channel" },
    });
  });

  it("a lease under the preset's minimum is refused on the minutes axis — a `budget:3` explore (minimum 4) as the directive's, a channel of 3 as the channel's — and one at the minimum runs", () => {
    const explore = getAgent("explore");
    expect(
      resolveProfile({ agent: explore, resolved: resolvedIn(YAML, "explore"), resume: undefined, budget: 3 }),
    ).toEqual({ kind: "refused", refusal: { axis: "minutes", needs: 4, have: 3, scope: "directive" } });
    expect(
      resolveProfile({ agent: explore, resolved: resolvedIn(YAML, "explore"), resume: undefined, budget: 4 }),
    ).toEqual({
      kind: "profile",
      profile: { machine: "repo-cold", identity: "read", minutes: 4, boundedBy: "directive" },
    });
    // Coding's minimum is 9 (write-up 3, post-step 5, one turn): a budget of 8 is refused, 9 runs.
    const coding = getAgent("coding");
    expect(
      resolveProfile({ agent: coding, resolved: resolvedIn(YAML, "coding"), resume: undefined, budget: 8 }),
    ).toEqual({ kind: "refused", refusal: { axis: "minutes", needs: 9, have: 8, scope: "directive" } });
    expect(
      resolveProfile({ agent: coding, resolved: resolvedIn(YAML, "coding"), resume: undefined, budget: 9 }),
    ).toMatchObject({ kind: "profile", profile: { minutes: 9 } });
    // A spawned child whose parent has less left than the minimum is refused as the parent's.
    expect(
      resolveProfile({
        agent: explore,
        resolved: resolvedIn(YAML, "explore"),
        resume: undefined,
        parentRemainingMs: 2.5 * 60_000,
      }),
    ).toEqual({ kind: "refused", refusal: { axis: "minutes", needs: 4, have: 2, scope: "parent" } });
  });

  it("a resume keeps the profile its row was admitted with — the clipped budget and what clipped it — rather than re-reading the preset; the current boundaries still refuse an identity or class above their cap", () => {
    const coding = getAgent("coding");
    const carried = {
      machine: "repo-resident" as const,
      identity: "write" as const,
      minutes: 12,
      boundedBy: "channel" as const,
    };
    const resume = { row: { meta: { profile: carried } } } as unknown as ResumeContext;
    // The channel's boundary is gone by the resume: the row's clip stands.
    expect(resolveProfile({ agent: coding, resolved: resolvedIn(YAML, "coding"), resume })).toEqual({
      kind: "profile",
      profile: carried,
    });
    // A boundary tightened meanwhile: the identity cap refuses the resume by name like a fresh request.
    expect(resolveProfile({ agent: coding, resolved: resolvedIn(BOUNDED_YAML, "coding"), resume })).toEqual({
      kind: "refused",
      refusal: { axis: "identity", needs: "write", cap: "read", scope: "channel" },
    });
    // A row written before profiles existed resolves like a fresh request.
    const legacy = { row: { meta: {} } } as unknown as ResumeContext;
    expect(resolveProfile({ agent: coding, resolved: resolvedIn(YAML, "coding"), resume: legacy })).toEqual({
      kind: "profile",
      profile: declaredProfile(coding),
    });
  });

  // docs/reference/specs/routing-and-config.md item 20: a spawned child takes the
  // wall clock its parent had left as one more boundary — on the minutes alone.
  it("a spawning parent's remaining wall clock is one more boundary: it clips the child's minutes as `parent`, a parent with more time left changes nothing, and a tighter scope boundary keeps the attribution", () => {
    const research = getAgent("research");
    expect(
      resolveProfile({
        agent: research,
        resolved: resolvedIn(YAML, "research"),
        resume: undefined,
        parentRemainingMs: 5 * 60_000 + 30_000,
      }),
    ).toEqual({ kind: "profile", profile: { machine: "none", identity: "none", minutes: 5, boundedBy: "parent" } });
    expect(
      resolveProfile({
        agent: research,
        resolved: resolvedIn(YAML, "research"),
        resume: undefined,
        parentRemainingMs: 60 * 60_000,
      }),
    ).toEqual({ kind: "profile", profile: declaredProfile(research) });
    // The channel caps at 10, under the parent's 30: the channel is what clipped the review preset's 25.
    expect(
      resolveProfile({
        agent: getAgent("review"),
        resolved: resolvedIn(BOUNDED_YAML, "review"),
        resume: undefined,
        parentRemainingMs: 30 * 60_000,
      }),
    ).toEqual({
      kind: "profile",
      profile: { machine: "repo-resident", identity: "read", minutes: 10, boundedBy: "channel" },
    });
  });
});
