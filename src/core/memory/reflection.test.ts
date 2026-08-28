import { describe, expect, it } from "vitest";
import type { CompletionRequest, CompletionResult, Provider } from "../../providers/types.js";
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

const SCOPE = "org:coreplanelabs";
const PROVENANCE = { sourceThreadKey: "slack:CX:1.0", sourceRunId: "run-1" };

function existing(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem:org:coreplanelabs:0",
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
    expect(text).toContain("mem:org:coreplanelabs:0");
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
  const knownIds = new Set(["mem:org:coreplanelabs:0"]);

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
        facts: [{ text: "the token is ghp_abcdefghijklmnopqrstuvwxyz0123", keywords: ["sk-ant-abcdefghijklmnopqrst"], confidence: 1 }],
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
          { text: "the deploy command is now npm run ship", confidence: 1, supersedes: "mem:org:coreplanelabs:0" },
          { text: "something else", confidence: 1, supersedes: "mem:org:coreplanelabs:999" },
        ],
        summary: "s",
      }),
      PROVENANCE,
      knownIds,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const facts = out.candidates.filter((c) => c.kind === "fact");
    expect(facts[0].supersedes).toBe("mem:org:coreplanelabs:0");
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
    facts: [{ text: "the deploy command is now npm run ship", confidence: 0.9, supersedes: "mem:org:coreplanelabs:0" }],
    summary: "Deploy command changed to npm run ship.",
  });
  const base = {
    scopeKey: SCOPE,
    model: "cheap-model",
    history: [] as HistoryItem[],
    request: "how do we deploy now?",
    answer: "npm run ship",
    ...PROVENANCE,
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
    expect(text).toContain("mem:org:coreplanelabs:0");

    const active = await store.retrieve({ scopeKey: SCOPE, query: "deploy command ship", limit: 10 });
    expect(active.map((r) => r.text)).toContain("the deploy command is now npm run ship");
    expect(active.map((r) => r.text)).not.toContain("the deploy command is npm run deploy");
    const summary = await store.retrieve({ scopeKey: SCOPE, query: "deploy command changed ship", limit: 10 });
    expect(summary.some((r) => r.kind === "summary")).toBe(true);
    expect(active.every((r) => r.sourceThreadKey === PROVENANCE.sourceThreadKey && r.sourceRunId === "run-1")).toBe(true);
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
    await expect(reflect({ ...base, provider, store: new InMemoryMemoryStore(), onWarn: (m) => warnings.push(m) })).resolves.toBeUndefined();
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
    };
    const provider = fakeProvider(goodReply);
    await reflect({ ...base, answer: "x".repeat(10_000), provider, store });
    expect(queries).toHaveLength(1);
    expect(queries[0].length).toBeLessThanOrEqual(2000);
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
