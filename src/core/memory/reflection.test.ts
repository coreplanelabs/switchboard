import { describe, expect, it } from "vitest";
import type { CompletionRequest, CompletionResult, Provider } from "../../providers/types.js";
import { actor } from "../authz/testing.js";
import type { ChannelVisibility } from "../authz/types.js";
import type { HistoryItem } from "../types.js";
import { InMemoryMemoryStore } from "./stores.js";
import type { MemoryQuery, MemoryRecord, MemoryStore } from "./types.js";
import {
  buildReflectionInput,
  MAX_REFLECTION_FACTS,
  MIN_REFLECTION_CONFIDENCE,
  parseReflection,
  pendingReflectionCount,
  reflect,
  REFLECT_MIN_TURNS,
  REFLECTION_SYSTEM,
  reflectionActor,
  shouldReflect,
  trackReflection,
} from "./reflection.js";

// Feature: features/memory.md — cross-session memory WRITE path (PR2, #85).
// The reflection pass distills a finished run into MemoryCandidates via one
// cheap model call. Everything here is pure or fake-provider-driven.

function fakeProvider(reply: string | (() => string)): Provider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    name: "fake",
    requests,
    async complete(req): Promise<CompletionResult> {
      requests.push(req);
      const text = typeof reply === "function" ? reply() : reply;
      return { content: [{ type: "text", text }], stopReason: "end_turn" };
    },
  };
}

const SCOPE = "org:acme";
const PROVENANCE = { sourceThreadKey: "slack:CX:1.0", sourceRunId: "run-1" };
/** The requesting user, as every routing test below sees them: a plain Slack
 *  user speaking from a PUBLIC channel — the origin under which org writes are
 *  allowed (authorization.md item 8, R11), so the routing tests keep today's
 *  expectations. The write-gate suite varies the origin. */
const PRINCIPAL = actor("user", "slack:UALICE");
const PUBLIC_ORIGIN = { actor: PRINCIPAL, originChannelVisibility: "public" as ChannelVisibility };

function existing(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem:org:acme:0",
    scopeKey: SCOPE,
    kind: "fact",
    text: "the deploy command is npm run deploy",
    keywords: ["deploy", "command", "npm"],
    sourceThreadKey: "slack:CX:9.9",
    createdAt: 1_000,
    useCount: 0,
    status: "active",
    ...over,
  };
}

describe("shouldReflect", () => {
  it("qualifies a run that used tools", () => {
    expect(shouldReflect({ toolCalls: 1, historyTurns: 0 })).toBe(true);
  });

  it("qualifies a long thread even with no tool use", () => {
    expect(shouldReflect({ toolCalls: 0, historyTurns: REFLECT_MIN_TURNS })).toBe(true);
  });

  it("skips a short, toolless chat run", () => {
    expect(shouldReflect({ toolCalls: 0, historyTurns: REFLECT_MIN_TURNS - 1 })).toBe(false);
    expect(shouldReflect({ toolCalls: 0, historyTurns: 0 })).toBe(false);
  });

  // #292: a review run's output already lands on the PR; distilling it floods
  // the org scope with per-PR ephemera ("PR #285 approved at c233364 …").
  it("never qualifies a `review` run, however much work it did (#292)", () => {
    expect(shouldReflect({ toolCalls: 9, historyTurns: 9, agentName: "review" })).toBe(false);
  });

  // features/agent-ship.md item 12 (KTD10): a ship run's report is per-PR
  // findings ephemera — the exact content #292 excluded for `review`.
  it("never qualifies a `ship` run either (agent-ship KTD10)", () => {
    expect(shouldReflect({ toolCalls: 9, historyTurns: 9, agentName: "ship" })).toBe(false);
  });

  it("other agents (and an unnamed agent) keep the work-based gate (#292)", () => {
    expect(shouldReflect({ toolCalls: 1, historyTurns: 0, agentName: "coding" })).toBe(true);
    expect(shouldReflect({ toolCalls: 1, historyTurns: 0, agentName: "general" })).toBe(true);
    expect(shouldReflect({ toolCalls: 0, historyTurns: 0, agentName: "coding" })).toBe(false);
  });
});

describe("REFLECTION_SYSTEM — ephemera (#292)", () => {
  it("tells the extractor that PR-specific state is ephemeral and must not become facts", () => {
    expect(REFLECTION_SYSTEM).toMatch(/PR[^\n]*ephemeral|ephemeral[^\n]*PR/i);
    expect(REFLECTION_SYSTEM).toMatch(/SHA/);
    expect(REFLECTION_SYSTEM).toMatch(/test counts?/i);
  });
});

describe("buildReflectionInput", () => {
  const history: HistoryItem[] = [
    { role: "user", text: "how do we deploy?" },
    { role: "assistant", text: "run npm run deploy" },
  ];

  it("includes the thread, the request, the answer, and existing records with their ids", () => {
    const text = buildReflectionInput({
      history,
      request: "and staging?",
      answer: "npm run deploy:staging",
      existing: [existing()],
    });
    expect(text).toContain("how do we deploy?");
    expect(text).toContain("and staging?");
    expect(text).toContain("npm run deploy:staging");
    expect(text).toContain("mem:org:acme:0");
    expect(text).toContain("the deploy command is npm run deploy");
  });

  it("redacts secrets in the transcript before it reaches the extractor model", () => {
    const text = buildReflectionInput({
      history: [{ role: "assistant", text: "set GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123" }],
      request: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      answer: "done",
      existing: [],
    });
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(text).not.toContain("Bearer abcdefghijklmnopqrstuvwxyz");
    expect(text).toContain("«redacted");
  });

  it("caps a huge transcript, keeping the tail (the decision usually lives at the end)", () => {
    const big: HistoryItem[] = Array.from({ length: 400 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `turn ${i} ` + "x".repeat(200),
    }));
    const text = buildReflectionInput({ history: big, request: "final request", answer: "final answer", existing: [] });
    expect(text.length).toBeLessThan(40_000);
    expect(text).toContain("turn 399");
    expect(text).not.toContain("turn 0 ");
    expect(text).toContain("final answer");
  });

  it("images are dropped — only text is distilled", () => {
    const text = buildReflectionInput({
      history: [{ role: "user", text: "see attached", images: [{ mediaType: "image/png", data: "AAAA" }] }],
      request: "",
      answer: "ok",
      existing: [],
    });
    expect(text).not.toContain("AAAA");
    expect(text).toContain("see attached");
  });
});

describe("parseReflection", () => {
  const knownIds = new Set(["mem:org:acme:0"]);

  it("accepts a well-formed reply and yields ≤5 facts + 1 summary as candidates", () => {
    const raw = JSON.stringify({
      facts: [
        { text: "the deploy command is npm run deploy", keywords: ["deploy"], confidence: 0.9 },
        { text: "CI runs typecheck and tests on every PR", confidence: 0.8 },
      ],
      summary: "User asked how deploys work; the deploy and CI commands were confirmed.",
    });
    const out = parseReflection(raw, PROVENANCE, knownIds);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.candidates).toHaveLength(3);
    const facts = out.candidates.filter((c) => c.kind === "fact");
    const summaries = out.candidates.filter((c) => c.kind === "summary");
    expect(facts).toHaveLength(2);
    expect(summaries).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      text: "the deploy command is npm run deploy",
      keywords: ["deploy"],
      confidence: 0.9,
      ...PROVENANCE,
    });
    expect(summaries[0]).toMatchObject({ kind: "summary", ...PROVENANCE });
  });

  it("tolerates a ```json fence around the object", () => {
    const out = parseReflection('```json\n{"facts":[],"summary":"s"}\n```', PROVENANCE, knownIds);
    expect(out.ok).toBe(true);
  });

  it("rejects non-JSON and non-object replies with an error, never throwing", () => {
    expect(parseReflection("not json", PROVENANCE, knownIds).ok).toBe(false);
    expect(parseReflection("[]", PROVENANCE, knownIds).ok).toBe(false);
    expect(parseReflection(JSON.stringify({ facts: "nope", summary: "s" }), PROVENANCE, knownIds).ok).toBe(false);
  });

  it(`caps facts at ${MAX_REFLECTION_FACTS}`, () => {
    const facts = Array.from({ length: 12 }, (_, i) => ({ text: `fact ${i}`, confidence: 1 }));
    const out = parseReflection(JSON.stringify({ facts, summary: "s" }), PROVENANCE, knownIds);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.candidates.filter((c) => c.kind === "fact")).toHaveLength(MAX_REFLECTION_FACTS);
  });

  it(`drops facts below the confidence gate (${MIN_REFLECTION_CONFIDENCE}) or with no/invalid confidence`, () => {
    const out = parseReflection(
      JSON.stringify({
        facts: [
          { text: "kept", confidence: MIN_REFLECTION_CONFIDENCE },
          { text: "low", confidence: MIN_REFLECTION_CONFIDENCE - 0.01 },
          { text: "missing" },
          { text: "bogus", confidence: "high" },
          { text: "over", confidence: 1.5 },
        ],
        summary: "s",
      }),
      PROVENANCE,
      knownIds,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.candidates.filter((c) => c.kind === "fact").map((c) => c.text)).toEqual(["kept"]);
  });

  it("drops empty/whitespace/non-string facts and an empty summary", () => {
    const out = parseReflection(
      JSON.stringify({ facts: [{ text: "   ", confidence: 1 }, { text: 42, confidence: 1 }, "str"], summary: "  " }),
      PROVENANCE,
      knownIds,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.candidates).toEqual([]);
  });

  it("redacts secrets in fact text, summary, and keywords", () => {
    const out = parseReflection(
      JSON.stringify({
        facts: [
          {
            text: "the token is ghp_abcdefghijklmnopqrstuvwxyz0123",
            keywords: ["sk-ant-abcdefghijklmnopqrst"],
            confidence: 1,
          },
        ],
        summary: "set ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz",
      }),
      PROVENANCE,
      knownIds,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const all = JSON.stringify(out.candidates);
    expect(all).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(all).not.toContain("sk-ant-abcdefghijklmnopqrst");
    expect(all).toContain("«redacted");
  });

  it("keeps `supersedes` only when it names a record the extractor was shown; unknown ids are dropped", () => {
    const out = parseReflection(
      JSON.stringify({
        facts: [
          { text: "the deploy command is now npm run ship", confidence: 1, supersedes: "mem:org:acme:0" },
          { text: "something else", confidence: 1, supersedes: "mem:org:acme:999" },
        ],
        summary: "s",
      }),
      PROVENANCE,
      knownIds,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const facts = out.candidates.filter((c) => c.kind === "fact");
    expect(facts[0].supersedes).toBe("mem:org:acme:0");
    expect(facts[1].supersedes).toBeUndefined();
  });

  it("normalizes keywords: strings only, lowercased, trimmed, deduped, capped; invalid → omitted", () => {
    const out = parseReflection(
      JSON.stringify({
        facts: [
          { text: "a", confidence: 1, keywords: [" Deploy", "deploy", 3, "", "CI"] },
          { text: "b", confidence: 1, keywords: "deploy" },
        ],
        summary: "s",
      }),
      PROVENANCE,
      knownIds,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const facts = out.candidates.filter((c) => c.kind === "fact");
    expect(facts[0].keywords).toEqual(["deploy", "ci"]);
    expect(facts[1].keywords).toBeUndefined();
  });
});

describe("reflect (one extractor call → store.write)", () => {
  const goodReply = JSON.stringify({
    facts: [{ text: "the deploy command is now npm run ship", confidence: 0.9, supersedes: "mem:org:acme:0" }],
    summary: "Deploy command changed to npm run ship.",
  });
  const base = {
    scopeKeys: { org: SCOPE },
    model: "cheap-model",
    history: [] as HistoryItem[],
    request: "how do we deploy now?",
    answer: "npm run ship",
    ...PROVENANCE,
    ...PUBLIC_ORIGIN,
  };

  it("makes exactly one model call on the configured cheap model with the reflection system prompt", async () => {
    const provider = fakeProvider(goodReply);
    const store = new InMemoryMemoryStore();
    await reflect({ ...base, provider, store });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].model).toBe("cheap-model");
    expect(provider.requests[0].system).toBe(REFLECTION_SYSTEM);
    expect(provider.requests[0].tools).toBeUndefined();
  });

  it("shows the extractor the scope's relevant existing records, then writes with supersede applied", async () => {
    const provider = fakeProvider(goodReply);
    const store = new InMemoryMemoryStore([existing()]);
    await reflect({ ...base, provider, store });
    const text = (provider.requests[0].messages[0].content[0] as { text: string }).text;
    expect(text).toContain("mem:org:acme:0");

    const active = await store.retrieve({ scopeKey: SCOPE, query: "deploy command ship", limit: 10 });
    expect(active.map((r) => r.text)).toContain("the deploy command is now npm run ship");
    expect(active.map((r) => r.text)).not.toContain("the deploy command is npm run deploy");
    const summary = await store.retrieve({ scopeKey: SCOPE, query: "deploy command changed ship", limit: 10 });
    expect(summary.some((r) => r.kind === "summary")).toBe(true);
    expect(active.every((r) => r.sourceThreadKey === PROVENANCE.sourceThreadKey && r.sourceRunId === "run-1")).toBe(
      true,
    );
  });

  it("an unparseable reply writes nothing and resolves (never throws) — one call, no retry", async () => {
    const provider = fakeProvider("I could not do that.");
    const store = new InMemoryMemoryStore();
    const warnings: string[] = [];
    await expect(reflect({ ...base, provider, store, onWarn: (m) => warnings.push(m) })).resolves.toBeUndefined();
    expect(provider.requests).toHaveLength(1);
    expect(await store.retrieve({ scopeKey: SCOPE, query: "deploy ship", limit: 10 })).toEqual([]);
    expect(warnings.join("\n")).toMatch(/not valid JSON|not an object/);
  });

  it("a provider failure is swallowed and reported through onWarn", async () => {
    const provider: Provider = {
      name: "boom",
      async complete() {
        throw new Error("rate limited");
      },
    };
    const warnings: string[] = [];
    await expect(
      reflect({ ...base, provider, store: new InMemoryMemoryStore(), onWarn: (m) => warnings.push(m) }),
    ).resolves.toBeUndefined();
    expect(warnings.join("\n")).toContain("rate limited");
  });

  it("a reply with nothing durable (no facts, empty summary) writes nothing", async () => {
    const provider = fakeProvider(JSON.stringify({ facts: [], summary: "" }));
    const store = new InMemoryMemoryStore();
    await reflect({ ...base, provider, store });
    expect(await store.retrieve({ scopeKey: SCOPE, query: "deploy ship", limit: 10 })).toEqual([]);
  });

  it("bounds the existing-records lookup query so a long answer can never overrun the Worker's query cap", async () => {
    // The Worker caps `query` at MAX_QUERY_CHARS; an over-long query 400s and
    // the store swallows it to [], so reflection would run blind. Regression
    // guard: a substantive answer must still produce a bounded retrieve query.
    const queries: string[] = [];
    const store: MemoryStore = {
      async retrieve(q: MemoryQuery): Promise<MemoryRecord[]> {
        queries.push(q.query);
        return [];
      },
      async write(): Promise<void> {},
      async list(): Promise<MemoryRecord[]> {
        return [];
      },
      async forget(): Promise<boolean> {
        return false;
      },
    };
    const provider = fakeProvider(goodReply);
    await reflect({ ...base, answer: "x".repeat(10_000), provider, store });
    expect(queries).toHaveLength(1);
    expect(queries[0].length).toBeLessThanOrEqual(2000);
  });
});

// Feature: features/memory.md (#107 PR B) — reflection writes user records
// alongside org records: the extractor tags each fact with an `audience`;
// `user` facts land in the requesting user's scope, everything else (and the
// summary) in the org scope; a supersede follows the superseded record's scope.
// Feature: features/memory.md §23 (#253) — repo/channel audiences route to the
// run's repo/channel scope when present, else fall back to org; the summary
// follows user > repo > channel > org.
describe("reflect — repo / channel routing (#253)", () => {
  const USER = "user:slack:UALICE";
  const REPO = "repo:acme/api";
  const CHAN = "channel:slack:C1";
  const base = {
    scopeKeys: { org: SCOPE, user: USER, repo: REPO, channel: CHAN },
    model: "cheap-model",
    history: [] as HistoryItem[],
    request: "how does acme/api deploy here?",
    answer: "make release",
    ...PROVENANCE,
    ...PUBLIC_ORIGIN,
    // The run's principal as the dispatcher hands it to reflection: a member of the run's own channel and repo.
    actor: reflectionActor(PRINCIPAL, { channelId: "slack:C1", repo: "acme/api" }),
  };
  const reply = JSON.stringify({
    facts: [
      { text: "acme/api deploys with make release", confidence: 0.9, audience: "repo" },
      { text: "this channel coordinates deploys", confidence: 0.9, audience: "channel" },
      { text: "the org standup is at 10am", confidence: 0.9, audience: "org" },
    ],
    summary: "Explained how acme/api deploys from this channel.",
  });

  it("routes repo/channel facts to their scopes and org facts to org; with no user fact the summary follows the repo", async () => {
    const provider = fakeProvider(reply);
    const store = new InMemoryMemoryStore();
    await reflect({ ...base, provider, store });
    expect(provider.requests).toHaveLength(1);
    expect((await store.list(REPO, 10)).map((r) => r.text).sort()).toEqual(
      ["Explained how acme/api deploys from this channel.", "acme/api deploys with make release"].sort(),
    );
    expect((await store.list(CHAN, 10)).map((r) => r.text)).toEqual(["this channel coordinates deploys"]);
    expect((await store.list(SCOPE, 10)).map((r) => r.text)).toEqual(["the org standup is at 10am"]);
    expect(await store.list(USER, 10)).toEqual([]);
  });

  it("summary inheritance order is user > repo > channel > org", async () => {
    const withUser = JSON.stringify({
      facts: [
        { text: "acme/api deploys with make release", confidence: 0.9, audience: "repo" },
        { text: "this user wants terse deploy answers", confidence: 0.9, audience: "user" },
      ],
      summary: "S1",
    });
    const s1 = new InMemoryMemoryStore();
    await reflect({ ...base, provider: fakeProvider(withUser), store: s1 });
    expect((await s1.list(USER, 10)).map((r) => r.text)).toContain("S1");
    expect((await s1.list(REPO, 10)).map((r) => r.text)).not.toContain("S1");

    const channelOnly = JSON.stringify({
      facts: [{ text: "this channel coordinates deploys", confidence: 0.9, audience: "channel" }],
      summary: "S2",
    });
    const s2 = new InMemoryMemoryStore();
    await reflect({ ...base, provider: fakeProvider(channelOnly), store: s2 });
    expect((await s2.list(CHAN, 10)).map((r) => r.text)).toContain("S2");
    expect((await s2.list(SCOPE, 10)).map((r) => r.text)).not.toContain("S2");
  });

  it("a repo/channel fact on a run without that scope falls back to org (never dropped)", async () => {
    const provider = fakeProvider(reply);
    const store = new InMemoryMemoryStore();
    await reflect({ ...base, scopeKeys: { org: SCOPE, user: USER }, provider, store });
    const org = (await store.list(SCOPE, 10)).map((r) => r.text);
    expect(org).toContain("acme/api deploys with make release");
    expect(org).toContain("this channel coordinates deploys");
    expect(await store.list(REPO, 10)).toEqual([]);
    expect(await store.list(CHAN, 10)).toEqual([]);
  });

  it("shows the extractor existing records from every scope the run has, and a supersede follows the record's scope", async () => {
    const stale = existing({ id: "mem:repo:acme/api:0", scopeKey: REPO, text: "acme/api deploys with make ship" });
    const provider = fakeProvider(
      JSON.stringify({
        facts: [
          {
            text: "acme/api deploys with make release",
            confidence: 0.9,
            audience: "org",
            supersedes: "mem:repo:acme/api:0",
          },
        ],
        summary: "",
      }),
    );
    const store = new InMemoryMemoryStore([stale]);
    await reflect({ ...base, provider, store });
    const shown = (provider.requests[0].messages[0].content[0] as { text: string }).text;
    expect(shown).toContain("mem:repo:acme/api:0");
    expect((await store.list(REPO, 10)).map((r) => r.text)).toEqual(["acme/api deploys with make release"]);
    expect(await store.list(SCOPE, 10)).toEqual([]);
  });
});

describe("parseReflection — repo / channel audiences (#253)", () => {
  it("keeps repo and channel audiences; summary inherits user > repo > channel > org", () => {
    const out = parseReflection(
      JSON.stringify({
        facts: [
          { text: "a", confidence: 0.9, audience: "repo" },
          { text: "b", confidence: 0.9, audience: "channel" },
        ],
        summary: "s",
      }),
      PROVENANCE,
      new Set(),
    );
    expect(out.ok && out.candidates.map((c) => [c.text, c.audience])).toEqual([
      ["a", "repo"],
      ["b", "channel"],
      ["s", "repo"],
    ]);
  });
});

describe("reflect — user scope routing (#107 PR B)", () => {
  const USER = "user:slack:UALICE";
  const base = {
    scopeKeys: { org: SCOPE, user: USER },
    model: "cheap-model",
    history: [] as HistoryItem[],
    request: "deploy it the way I like",
    answer: "done",
    ...PROVENANCE,
    ...PUBLIC_ORIGIN,
  };
  const reply = JSON.stringify({
    facts: [
      { text: "the deploy command is npm run deploy", confidence: 0.9, audience: "org" },
      { text: "this user wants a deploy preview link before prod", confidence: 0.9, audience: "user" },
      { text: "CI runs vitest on deploy", confidence: 0.8 },
    ],
    summary: "User asked for a deploy; it ran with a preview link.",
  });

  it("routes `user` facts to the user scope and `org` facts to the org scope; the summary follows the user when a user fact exists (#205)", async () => {
    const provider = fakeProvider(reply);
    const store = new InMemoryMemoryStore();
    await reflect({ ...base, provider, store });
    expect(provider.requests).toHaveLength(1); // still ONE extractor call
    const org = await store.retrieve({ scopeKey: SCOPE, query: "deploy preview vitest ran", limit: 10 });
    const user = await store.retrieve({ scopeKey: USER, query: "deploy preview vitest ran", limit: 10 });
    expect(org.map((r) => r.text).sort()).toEqual(
      ["CI runs vitest on deploy", "the deploy command is npm run deploy"].sort(),
    );
    expect(user.map((r) => r.text).sort()).toEqual(
      [
        "User asked for a deploy; it ran with a preview link.",
        "this user wants a deploy preview link before prod",
      ].sort(),
    );
    expect(user.every((r) => r.id.startsWith("mem:user:slack:UALICE:"))).toBe(true);
    expect(user.every((r) => r.sourceThreadKey === PROVENANCE.sourceThreadKey)).toBe(true);
  });

  it("a reflection with only `org` facts keeps its summary in the org scope (#205)", async () => {
    const provider = fakeProvider(
      JSON.stringify({
        facts: [{ text: "CI runs vitest on deploy", confidence: 0.8, audience: "org" }],
        summary: "User asked how CI runs; vitest on deploy was confirmed.",
      }),
    );
    const store = new InMemoryMemoryStore();
    await reflect({ ...base, provider, store });
    const org = await store.retrieve({ scopeKey: SCOPE, query: "ci vitest deploy confirmed", limit: 10 });
    expect(org.some((r) => r.kind === "summary")).toBe(true);
    expect(await store.retrieve({ scopeKey: USER, query: "ci vitest deploy confirmed", limit: 10 })).toEqual([]);
  });

  it("the extractor is told to keep the summary impersonal (personal details belong in `user` facts) (#205)", () => {
    expect(REFLECTION_SYSTEM).toMatch(/summary[^\n]*impersonal|impersonal[^\n]*summary/i);
  });

  it("without a user scope, `user` facts fall back to the org scope (nothing is dropped)", async () => {
    const provider = fakeProvider(reply);
    const store = new InMemoryMemoryStore();
    await reflect({ ...base, scopeKeys: { org: SCOPE }, provider, store });
    const org = await store.retrieve({ scopeKey: SCOPE, query: "deploy preview", limit: 10 });
    expect(org.map((r) => r.text)).toContain("this user wants a deploy preview link before prod");
    expect(await store.retrieve({ scopeKey: USER, query: "deploy preview", limit: 10 })).toEqual([]);
  });

  it("shows the extractor the user's existing records too, and a supersede lands in the superseded record's scope", async () => {
    const stale = existing({
      id: "mem:user:slack:UALICE:0",
      scopeKey: USER,
      text: "this user wants deploys announced in #ops",
    });
    const provider = fakeProvider(
      JSON.stringify({
        facts: [
          {
            text: "this user wants deploys announced in #releases",
            confidence: 0.9,
            audience: "org", // mislabeled on purpose — the supersede target decides the scope
            supersedes: "mem:user:slack:UALICE:0",
          },
        ],
        summary: "",
      }),
    );
    const store = new InMemoryMemoryStore([stale]);
    await reflect({ ...base, request: "announce deploys in #releases from now on", provider, store });
    const shown = (provider.requests[0].messages[0].content[0] as { text: string }).text;
    expect(shown).toContain("mem:user:slack:UALICE:0");
    const user = await store.retrieve({ scopeKey: USER, query: "user deploys announced", limit: 10 });
    expect(user.map((r) => r.text)).toEqual(["this user wants deploys announced in #releases"]);
    expect(user[0].supersedes).toBe("mem:user:slack:UALICE:0");
    expect(await store.retrieve({ scopeKey: SCOPE, query: "user deploys announced", limit: 10 })).toEqual([]);
  });

  it("never writes into a user scope the request did not name (another user's bucket stays untouched)", async () => {
    const provider = fakeProvider(reply);
    const store = new InMemoryMemoryStore();
    await reflect({ ...base, provider, store });
    expect(await store.retrieve({ scopeKey: "user:slack:UBOB", query: "deploy preview", limit: 10 })).toEqual([]);
  });
});

// Feature: features/authorization.md item 8, features/memory.md §23 (R11,
// deliberate change (c)): every candidate's write is a policy decision —
// `authorize(runActor, "memory:write", memory-scope{kind, key,
// originChannelVisibility})` — and a fact from a private, DM, or unknown origin
// never reaches `org`: it is NARROWED (dm → the user's own scope, else the
// channel's, then the user's), never widened, never silently dropped.
describe("reflect — write gate (authorization R11, deliberate change c)", () => {
  const USER = "user:slack:UALICE";
  const CHAN = "channel:slack:C1";
  const REPO = "repo:acme/api";
  const orgFact = { text: "the org standup is at 10am", confidence: 0.9, audience: "org" };
  const reply = JSON.stringify({ facts: [orgFact], summary: "Standup time was confirmed." });
  const runActor = reflectionActor(PRINCIPAL, { channelId: "slack:C1", repo: "acme/api" });
  const base = {
    scopeKeys: { org: SCOPE, user: USER, repo: REPO, channel: CHAN },
    model: "cheap-model",
    history: [] as HistoryItem[],
    request: "when is standup?",
    answer: "10am",
    actor: runActor,
    ...PROVENANCE,
  };
  const texts = async (store: InMemoryMemoryStore, scope: string) =>
    (await store.list(scope, 10)).map((r) => r.text).sort();

  it("a dm-origin org fact is written to the user scope, never org — and its summary follows it", async () => {
    const store = new InMemoryMemoryStore();
    const warnings: string[] = [];
    await reflect({
      ...base,
      scopeKeys: { org: SCOPE, user: USER, channel: "channel:slack:D1" },
      actor: reflectionActor(PRINCIPAL, { channelId: "slack:D1" }),
      originChannelVisibility: "dm",
      provider: fakeProvider(reply),
      store,
      onWarn: (m) => warnings.push(m),
    });
    expect(await texts(store, SCOPE)).toEqual([]);
    expect(await texts(store, USER)).toEqual(["Standup time was confirmed.", "the org standup is at 10am"]);
    expect(await texts(store, "channel:slack:D1")).toEqual([]);
    // One line, the reason token, never the fact text.
    expect(warnings).toEqual([expect.stringContaining("org → user (origin-visibility)")]);
    expect(warnings[0]).toContain("2×");
    expect(warnings[0]).not.toContain("standup");
  });

  it("a private-channel org fact narrows to the channel scope — the origin's own audience; without a channel scope, to the user", async () => {
    const withChannel = new InMemoryMemoryStore();
    await reflect({ ...base, originChannelVisibility: "private", provider: fakeProvider(reply), store: withChannel });
    expect(await texts(withChannel, SCOPE)).toEqual([]);
    expect(await texts(withChannel, CHAN)).toEqual(["Standup time was confirmed.", "the org standup is at 10am"]);
    expect(await texts(withChannel, REPO)).toEqual([]); // repo is never a narrowing target: its readers span every channel
    expect(await texts(withChannel, USER)).toEqual([]);

    const noChannel = new InMemoryMemoryStore();
    await reflect({
      ...base,
      scopeKeys: { org: SCOPE, user: USER, repo: REPO },
      originChannelVisibility: "private",
      provider: fakeProvider(reply),
      store: noChannel,
    });
    expect(await texts(noChannel, SCOPE)).toEqual([]);
    expect(await texts(noChannel, USER)).toEqual(["Standup time was confirmed.", "the org standup is at 10am"]);
  });

  it("an unstamped run (no origin visibility → `unknown`) never writes org: the fact narrows like a private origin (fail-closed, R7)", async () => {
    const store = new InMemoryMemoryStore();
    await reflect({ ...base, provider: fakeProvider(reply), store });
    expect(await texts(store, SCOPE)).toEqual([]);
    expect(await texts(store, CHAN)).toEqual(["Standup time was confirmed.", "the org standup is at 10am"]);
  });

  it("a public-channel or machine-channel org fact keeps today's routing — written to org, nothing logged", async () => {
    for (const origin of ["public", "machine"] as const) {
      const store = new InMemoryMemoryStore();
      const warnings: string[] = [];
      await reflect({
        ...base,
        originChannelVisibility: origin,
        provider: fakeProvider(reply),
        store,
        onWarn: (m) => warnings.push(m),
      });
      expect(await texts(store, SCOPE), origin).toEqual(["Standup time was confirmed.", "the org standup is at 10am"]);
      expect(warnings, origin).toEqual([]);
    }
  });

  it("the audience is a hint the policy narrows and never widens: user / channel / repo facts from a public origin stay where the extractor put them", async () => {
    const mixed = JSON.stringify({
      facts: [
        { text: "this user likes terse answers", confidence: 0.9, audience: "user" },
        { text: "this channel coordinates deploys", confidence: 0.9, audience: "channel" },
        { text: "acme/api deploys with make release", confidence: 0.9, audience: "repo" },
      ],
      summary: "",
    });
    const store = new InMemoryMemoryStore();
    await reflect({ ...base, originChannelVisibility: "public", provider: fakeProvider(mixed), store });
    expect(await texts(store, USER)).toEqual(["this user likes terse answers"]);
    expect(await texts(store, CHAN)).toEqual(["this channel coordinates deploys"]);
    expect(await texts(store, REPO)).toEqual(["acme/api deploys with make release"]);
    expect(await texts(store, SCOPE)).toEqual([]);
  });

  it("a correction of an org record from a DM cannot follow it into org: the fact is written narrowed WITHOUT `supersedes`, and the org record stands", async () => {
    const stale = existing({ id: "mem:org:acme:0", scopeKey: SCOPE, text: "the org standup is at 9am" });
    const correction = JSON.stringify({ facts: [{ ...orgFact, supersedes: "mem:org:acme:0" }], summary: "" });
    const store = new InMemoryMemoryStore([stale]);
    await reflect({ ...base, originChannelVisibility: "dm", provider: fakeProvider(correction), store });
    expect(await texts(store, SCOPE)).toEqual(["the org standup is at 9am"]);
    const user = await store.list(USER, 10);
    expect(user.map((r) => r.text)).toEqual(["the org standup is at 10am"]);
    expect(user[0].supersedes).toBeUndefined();
  });

  it("a write the table denies for any other reason is dropped with the reason — never rerouted wider, never logged with the fact text", async () => {
    // The run's own channel scope, but an actor that is NOT a member of it (the dispatcher's `reflectionActor` makes this impossible; the gate still holds).
    const channelFact = JSON.stringify({
      facts: [{ text: "this channel coordinates deploys", confidence: 0.9, audience: "channel" }],
      summary: "",
    });
    const store = new InMemoryMemoryStore();
    const warnings: string[] = [];
    await reflect({
      ...base,
      actor: PRINCIPAL,
      originChannelVisibility: "public",
      provider: fakeProvider(channelFact),
      store,
      onWarn: (m) => warnings.push(m),
    });
    expect(await texts(store, CHAN)).toEqual([]);
    expect(await texts(store, SCOPE)).toEqual([]);
    expect(await texts(store, USER)).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining("channel (not-member)")]);
    expect(warnings[0]).not.toContain("deploys");
  });

  it("with no narrower scope allowed, the fact is dropped and said so — never written to org", async () => {
    const store = new InMemoryMemoryStore();
    const warnings: string[] = [];
    await reflect({
      ...base,
      scopeKeys: { org: SCOPE },
      originChannelVisibility: "private",
      provider: fakeProvider(reply),
      store,
      onWarn: (m) => warnings.push(m),
    });
    expect(await texts(store, SCOPE)).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining("org (origin-visibility)")]);
    expect(warnings[0]).toContain("2 candidate(s) dropped");
  });

  it("reflectionActor: the run's principal holding the run's own channel and repo as memberships — no action added, `all` left alone, nothing else changed", () => {
    const plain = actor(
      "user",
      "slack:UALICE",
      { actions: new Set(["memory:write"]), channels: new Set(["slack:C9"]) },
      { origin: { channelId: "slack:C1", threadKey: "slack:C1:1" } },
    );
    const scoped = reflectionActor(plain, { channelId: "slack:C1", repo: "acme/api" });
    expect(scoped.grants.actions).toEqual(new Set(["memory:write"]));
    expect(scoped.grants.channels).toEqual(new Set(["slack:C9", "slack:C1"]));
    expect(scoped.grants.repos).toEqual(new Set(["acme/api"]));
    expect(scoped.id).toBe("slack:UALICE");
    expect(scoped.kind).toBe("user");
    expect(scoped.origin).toEqual(plain.origin);
    expect(plain.grants.channels).toEqual(new Set(["slack:C9"])); // the principal is not mutated

    const admin = actor("user", "slack:UADMIN", { actions: "all", channels: "all", repos: "all" });
    expect(reflectionActor(admin, { channelId: "slack:C1", repo: "acme/api" }).grants).toEqual(admin.grants);
    expect(reflectionActor(plain, {}).grants).toEqual(plain.grants);
  });
});

describe("parseReflection — audience (#107 PR B, #205)", () => {
  it("keeps a valid audience, defaults anything else to org; the summary is `user` when any fact is", () => {
    const out = parseReflection(
      JSON.stringify({
        facts: [
          { text: "a", confidence: 0.9, audience: "user" },
          { text: "b", confidence: 0.9, audience: "org" },
          { text: "c", confidence: 0.9 },
          { text: "d", confidence: 0.9, audience: "everyone" },
        ],
        summary: "s",
      }),
      PROVENANCE,
      new Set(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.candidates.map((c) => [c.text, c.audience])).toEqual([
      ["a", "user"],
      ["b", "org"],
      ["c", "org"],
      ["d", "org"],
      ["s", "user"],
    ]);
  });

  it("the summary stays `org` when no fact is `user`", () => {
    const out = parseReflection(
      JSON.stringify({ facts: [{ text: "b", confidence: 0.9, audience: "org" }], summary: "s" }),
      PROVENANCE,
      new Set(),
    );
    expect(out.ok && out.candidates.map((c) => [c.text, c.audience])).toEqual([
      ["b", "org"],
      ["s", "org"],
    ]);
  });
});

describe("trackReflection / pendingReflectionCount (shutdown drain)", () => {
  it("counts an in-flight reflection until it settles — resolved or rejected", async () => {
    expect(pendingReflectionCount()).toBe(0);
    let finish!: () => void;
    let fail!: (e: Error) => void;
    trackReflection(new Promise<void>((r) => (finish = r)));
    trackReflection(new Promise<void>((_, j) => (fail = j)));
    expect(pendingReflectionCount()).toBe(2);
    finish();
    await Promise.resolve();
    expect(pendingReflectionCount()).toBe(1);
    fail(new Error("x"));
    await Promise.resolve();
    await Promise.resolve();
    expect(pendingReflectionCount()).toBe(0);
  });
});
