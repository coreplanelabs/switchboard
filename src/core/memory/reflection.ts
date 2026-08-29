import type { Provider } from "../../providers/types.js";
import { redactSecrets } from "../runEvents.js";
import { stripJsonFence } from "../structuredOutput.js";
import type { HistoryItem } from "../types.js";
import type { MemoryCandidate, MemoryRecord, MemoryStore } from "./types.js";
import { listScopeKeys, type RequestScopeKeys } from "./scope.js";

// Cross-session memory WRITE path (Area 7c, #85, PR2): the post-run reflection
// pass. After a run's reply has landed, ONE cheap model call distills the thread
// into ≤MAX_REFLECTION_FACTS durable facts + 1 episodic summary, validated and
// secret-redacted here, then handed to `store.write` (dedup/supersede inside the
// store). Everything is fire-and-forget from the dispatcher's point of view —
// awaited only by the shutdown drain — so reflection latency and failures never
// touch the user reply. Pure pieces (gate, input builder, parser) are exported
// for unit tests; `reflect` composes them around a Provider.
//
// User scope (#107 PR B): the extractor tags each fact with an `audience` —
// `user` for knowledge about the requesting person (preferences, habits, their
// own setup), `org` for shared knowledge. `user` facts are written to the
// requesting user's own scope; everything else (and the summary) to the org
// scope. Still ONE extractor call per run.

/** Toolless threads shorter than this many prior turns are not worth an
 *  extractor call (a one-shot Q&A rarely yields a durable fact). */
export const REFLECT_MIN_TURNS = 4;
/** Cap on facts per run — the whole point is a small, general store. */
export const MAX_REFLECTION_FACTS = 5;
/** Facts below this extractor confidence are dropped (anti-poisoning gate). */
export const MIN_REFLECTION_CONFIDENCE = 0.6;
/** Max keywords kept per candidate. */
const MAX_KEYWORDS = 10;
/** Transcript budget (chars) sent to the extractor; the tail is kept because
 *  the decision usually lives at the end of a thread. */
const MAX_TRANSCRIPT_CHARS = 24_000;
/** Existing records shown to the extractor so it can emit `supersedes`. */
const EXISTING_LIMIT = 8;
/** Output budget for the extractor reply (≤5 short facts + 1 summary as JSON). */
const REFLECTION_MAX_TOKENS = 1024;
/** Bound on the existing-records lookup query. The Memory Worker caps `query`
 *  at MAX_QUERY_CHARS (deploy/cloudflare-memory/worker.ts); an over-long query
 *  400s, the store swallows non-ok to [], and reflection then runs blind (never
 *  dedups/supersedes). 2000 sits well under that cap and loses nothing —
 *  retrieval only tokenizes the query for an FTS prefilter, so truncation is
 *  semantically fine. */
const MAX_RETRIEVE_QUERY_CHARS = 2000;

/** Signals that a run did real work worth distilling. */
export interface ReflectGateInput {
  /** Tool calls the run made (from the run-event stream). */
  toolCalls: number;
  /** Prior turns in the thread (`io.history().length`). */
  historyTurns: number;
}

/** Only runs that did real work reflect: used a tool, or sit in a thread that
 *  already carries some back-and-forth. Config/deterministic fast-paths never
 *  reach this — they return before the run. */
export function shouldReflect(input: ReflectGateInput): boolean {
  return input.toolCalls > 0 || input.historyTurns >= REFLECT_MIN_TURNS;
}

export const REFLECTION_SYSTEM = [
  "You distill a finished assistant thread into durable, reusable memory for the resource it concerns.",
  "Return ONLY a JSON object of the form:",
  '{"facts":[{"text":"...","keywords":["..."],"confidence":0.0-1.0,"audience":"org"|"user","supersedes":"<existing id, optional>"}],"summary":"..."}',
  `Rules: at most ${MAX_REFLECTION_FACTS} facts. Each fact is ONE self-contained sentence that will still be true and useful in a future, unrelated thread`,
  "(commands, conventions, decisions, preferences, architecture). Ignore ephemeral or one-off details (timestamps, transient errors, chit-chat).",
  "Never include secrets, tokens, passwords, or keys — omit the fact instead.",
  '`audience` is "user" when the fact is about the requesting person specifically (their preferences, habits, personal conventions, their own setup — write it as "this user …"),',
  'and "org" (the default) when it is shared knowledge about the codebase, tooling, or team. Only the requesting user will ever see "user" facts.',
  "`confidence` is how sure you are the fact is durable and correct. If a fact contradicts one of the EXISTING records you were shown, set `supersedes` to that record's id.",
  "`summary` is one or two sentences: what was asked and what was concluded. Output raw JSON with no code fence and no prose.",
].join("\n");

export interface ReflectionInput {
  history: HistoryItem[];
  request: string;
  answer: string;
  existing: MemoryRecord[];
}

/** The single user message for the extractor: existing records (with ids, so
 *  the model can supersede), then the redacted, tail-capped transcript. Images
 *  are dropped — only text is distilled. Redaction happens BEFORE the text
 *  leaves the process (the extractor is a third-party model too). */
export function buildReflectionInput(input: ReflectionInput): string {
  const turns = input.history
    .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.text}`)
    .concat([`User: ${input.request}`, `Assistant: ${input.answer}`]);
  let transcript = turns.join("\n\n");
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = `…(earlier turns omitted)…\n\n${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
  }
  const existing =
    input.existing.length === 0
      ? "(none)"
      : input.existing.map((r) => `- ${r.id} [${r.kind}]: ${r.text}`).join("\n");
  return redactSecrets(`EXISTING records for this resource:\n${existing}\n\nTHREAD:\n${transcript}`);
}

export interface ReflectionProvenance {
  sourceThreadKey: string;
  sourceRunId?: string;
}

/** Who a distilled fact is for: the shared org scope, or the requesting user's
 *  own scope (#107 PR B). Decided by the extractor, defaulting to `org`. */
export type MemoryAudience = "org" | "user";

/** A validated candidate plus its routing tag. The tag is reflection-internal:
 *  `reflect` resolves it to a scope key and strips it before `store.write`, so
 *  the `MemoryStore` contract and the Worker's wire format are unchanged. */
export type RoutedCandidate = MemoryCandidate & { audience: MemoryAudience };

export type ParsedReflection = { ok: true; candidates: RoutedCandidate[] } | { ok: false; error: string };

/** Validate + sanitize the extractor's reply into routed MemoryCandidates.
 *  Lenient on shape inside the object (bad facts are dropped, not fatal), strict
 *  on the envelope (non-JSON / non-object → error). Every text field is
 *  redacted; `supersedes` survives only when it names a record the extractor was
 *  shown; `audience` is `user` only when it says exactly that, else `org` (the
 *  summary is always `org`). */
export function parseReflection(raw: string, prov: ReflectionProvenance, knownIds: Set<string>): ParsedReflection {
  let value: unknown;
  try {
    value = JSON.parse(stripJsonFence(raw));
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "not an object" };
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.facts)) return { ok: false, error: "`facts` is not an array" };

  const candidates: RoutedCandidate[] = [];
  for (const f of obj.facts) {
    if (candidates.length >= MAX_REFLECTION_FACTS) break;
    const fact = parseFact(f, prov, knownIds);
    if (fact) candidates.push(fact);
  }
  const summary = cleanText(obj.summary);
  if (summary) candidates.push({ kind: "summary", text: summary, audience: "org", ...prov });
  return { ok: true, candidates };
}

function parseFact(raw: unknown, prov: ReflectionProvenance, knownIds: Set<string>): RoutedCandidate | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const f = raw as Record<string, unknown>;
  const text = cleanText(f.text);
  if (!text) return undefined;
  const confidence = f.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < MIN_REFLECTION_CONFIDENCE || confidence > 1) {
    return undefined;
  }
  const keywords = parseKeywords(f.keywords);
  const supersedes = typeof f.supersedes === "string" && knownIds.has(f.supersedes) ? f.supersedes : undefined;
  return {
    kind: "fact",
    text,
    ...(keywords ? { keywords } : {}),
    confidence,
    audience: f.audience === "user" ? "user" : "org",
    ...(supersedes ? { supersedes } : {}),
    ...prov,
  };
}

/** Redacted, whitespace-collapsed text; undefined when not a non-empty string. */
function cleanText(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = redactSecrets(v).replace(/\s+/g, " ").trim();
  return t || undefined;
}

/** Strings only, redacted, lowercased, trimmed, deduped, capped; non-array or
 *  empty → undefined (the store tokenizes the text instead). */
function parseKeywords(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const k of v) {
    if (typeof k !== "string") continue;
    const t = redactSecrets(k).trim().toLowerCase();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out.length > 0 ? out : undefined;
}

export interface ReflectDeps extends ReflectionProvenance {
  provider: Provider;
  /** Bare model id (provider prefix already stripped) — resolved by the caller
   *  from `memory.model` (AGENTS.md invariant 7: never hardcoded here). */
  model: string;
  store: MemoryStore;
  /** The run's scopes: the org's, plus the requesting user's own when known. */
  scopeKeys: RequestScopeKeys;
  history: HistoryItem[];
  request: string;
  answer: string;
  onWarn?: (message: string) => void;
}

/** Which scope a routed candidate lands in: a supersede follows the record it
 *  corrects (the id was validated against the shown records, whose scopes we
 *  know); otherwise `user` facts go to the user's scope when the run has one,
 *  and everything else to the org scope. A `user` fact with no user scope falls
 *  back to org rather than being dropped. */
function routeCandidate(cand: RoutedCandidate, keys: RequestScopeKeys, scopeOf: Map<string, string>): string {
  const superseded = cand.supersedes ? scopeOf.get(cand.supersedes) : undefined;
  if (superseded) return superseded;
  return cand.audience === "user" && keys.user ? keys.user : keys.org;
}

/** One extractor call → validate → `store.write` per scope. Never throws and
 *  never retries: reflection is best-effort background work, and a failed pass
 *  simply writes nothing (the thread history still holds the raw material). */
export async function reflect(deps: ReflectDeps): Promise<void> {
  const warn = deps.onWarn ?? (() => {});
  try {
    const query = `${deps.request} ${deps.answer}`.slice(0, MAX_RETRIEVE_QUERY_CHARS);
    const existing = (
      await Promise.all(
        listScopeKeys(deps.scopeKeys).map((scopeKey) => deps.store.retrieve({ scopeKey, query, limit: EXISTING_LIMIT })),
      )
    ).flat();
    const text = buildReflectionInput({ history: deps.history, request: deps.request, answer: deps.answer, existing });
    const result = await deps.provider.complete({
      model: deps.model,
      system: REFLECTION_SYSTEM,
      messages: [{ role: "user", content: [{ type: "text", text }] }],
      maxTokens: REFLECTION_MAX_TOKENS,
    });
    const reply = result.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    const prov: ReflectionProvenance = { sourceThreadKey: deps.sourceThreadKey, sourceRunId: deps.sourceRunId };
    const parsed = parseReflection(reply, prov, new Set(existing.map((r) => r.id)));
    if (!parsed.ok) {
      warn(`reflection output rejected (${parsed.error}); nothing written`);
      return;
    }
    if (parsed.candidates.length === 0) return;
    const scopeOf = new Map(existing.map((r) => [r.id, r.scopeKey]));
    const byScope = new Map<string, MemoryCandidate[]>();
    for (const cand of parsed.candidates) {
      const { audience: _audience, ...plain } = cand;
      const scopeKey = routeCandidate(cand, deps.scopeKeys, scopeOf);
      let batch = byScope.get(scopeKey);
      if (!batch) byScope.set(scopeKey, (batch = []));
      batch.push(plain);
    }
    for (const [scopeKey, records] of byScope) await deps.store.write(scopeKey, records);
  } catch (err) {
    warn(`reflection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- background tracking (shutdown drain) -----------------------------------
// Reflections are fire-and-forget from dispatch(); the process drain (index.ts)
// waits on this count alongside activeRunCount() so a restart doesn't drop a
// distillation that was mid-flight.

const pending = new Set<Promise<void>>();

/** Register an in-flight reflection; it is removed when it settles either way. */
export function trackReflection(p: Promise<void>): void {
  const tracked: Promise<void> = p.then(
    () => void pending.delete(tracked),
    () => void pending.delete(tracked),
  );
  pending.add(tracked);
}

export function pendingReflectionCount(): number {
  return pending.size;
}

/** Resolve once every currently-pending reflection has settled. */
export async function drainReflections(): Promise<void> {
  await Promise.all([...pending]);
}
