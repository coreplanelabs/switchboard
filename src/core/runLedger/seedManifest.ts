import { SESSION_KEY_PATTERN } from "../runRecord.js";
import type { ChatMessage } from "../chatMessage.js";
import type { ClaimRequest, TranscriptAttachment, TranscriptRow } from "./types.js";
import { GEN_PATTERN } from "./types.js";
import { RUN_ID_PATTERN } from "../runIdentity.js";
import { turnRows, assembleTranscript } from "./transcript.js";
import { requestIndex, attachmentRefsOf, projectSessionMessages } from "./sessionLog.js";
import {
  contextDependenciesHash,
  contextDependenciesContain,
  isContextDependencies,
  type ContextDependencies,
} from "../references/contextDependencies.js";
import { minutesToMs } from "../budgets.js";
import { promotionBodyOf, promotionBodyHash } from "./promotion.js";

/** Expected input only. No receipt here authorizes model execution or disposal. */
export interface ExpectedSeedManifest {
  version: 1;
  runId: string;
  threadKey: string;
  gen: string;
  startedAt: number;
  namespace: string;
  requester: string;
  authenticatedAs?: string;
  postedBy?: string;
  bodySha256: string;
  mode: "session" | "transcript";
  key?: string;
  from: number;
  through: number;
  count: number;
  request: number;
  observedTail: number;
  reusedCount: number;
  budgetMs: number;
  messagesHash: string;
  /** Exact resolved model messages, independently of the raw source hash. */
  modelMessagesHash?: string;
  rowsHash: string;
  attachmentsHash: string;
  actorsHash: string;
  contextHash: string;
  notepadHash: string;
  systemHash: string;
  reused?: {
    key: string;
    from: number;
    through: number;
    count: number;
    owner: { runId: string; gen: string } | null;
    rowsHash: string;
    attachmentsHash: string;
    contextHash: string;
    notepadHash: string;
  };
}
/** The resolved OpenRunRequest input shape; kept free of producer/controller imports. */
export interface ResolvedExpectedSeedInput {
  runId: string;
  threadKey: string;
  startedAt: number;
  system: string;
  seed?: {
    messages: readonly ChatMessage[];
    actors?: readonly (string | undefined)[];
    context?: ContextDependencies;
    notepad?: string;
    budgetMs: number;
    log?: { from: number; turns: number };
    refusedRequests?: readonly number[];
  };
}
export interface ExpectedSeedObservation {
  key?: string;
  next: number;
  reused?: {
    key: string;
    from: number;
    through: number;
    next: number;
    rows: readonly TranscriptRow[];
    attachments: readonly TranscriptAttachment[];
    context: ContextDependencies;
    notepad: string;
    owner?: { runId: string; gen: string };
  };
}
export type ExpectedSeedBuildResult =
  | { kind: "built"; manifest: ExpectedSeedManifest; digest: string }
  | { kind: "held"; reason: "missing" | "mismatch" | "source" | "unrepresentable" };
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 512): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const index = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
/** Same JSON data canonicalization used by context receipts; ordering of turns stays significant. */
export function canonicalSeedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSeedJson).join(",")}]`;
  if (object(value))
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalSeedJson(v)}`)
      .join(",")}}`;
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("nonfinite expected input");
  if (["function", "symbol", "bigint"].includes(typeof value)) throw new Error("unrepresentable expected input");
  return JSON.stringify(value) ?? "null";
}
export const seedContentHash = (value: unknown): Promise<string> => promotionBodyHash(canonicalSeedJson(value));
const closed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
export function expectedSeedManifestOf(value: unknown): ExpectedSeedManifest | undefined {
  if (
    !object(value) ||
    !closed(value, [
      "version",
      "runId",
      "threadKey",
      "gen",
      "startedAt",
      "namespace",
      "requester",
      "authenticatedAs",
      "postedBy",
      "bodySha256",
      "mode",
      "key",
      "from",
      "through",
      "count",
      "request",
      "observedTail",
      "reusedCount",
      "budgetMs",
      "messagesHash",
      "modelMessagesHash",
      "rowsHash",
      "attachmentsHash",
      "actorsHash",
      "contextHash",
      "notepadHash",
      "systemHash",
      "reused",
    ]) ||
    value.version !== 1 ||
    !text(value.runId) ||
    !RUN_ID_PATTERN.test(value.runId) ||
    !text(value.threadKey, 256) ||
    !text(value.gen, 128) ||
    !GEN_PATTERN.test(value.gen) ||
    !Number.isFinite(value.startedAt) ||
    !text(value.namespace) ||
    !text(value.requester) ||
    (value.authenticatedAs !== undefined && !text(value.authenticatedAs)) ||
    (value.postedBy !== undefined && !text(value.postedBy)) ||
    ![
      value.bodySha256,
      value.messagesHash,
      value.rowsHash,
      value.attachmentsHash,
      value.actorsHash,
      value.contextHash,
      value.notepadHash,
      value.systemHash,
    ].every(hash) ||
    (value.modelMessagesHash !== undefined && !hash(value.modelMessagesHash)) ||
    !index(value.from) ||
    !index(value.through) ||
    !index(value.count) ||
    !index(value.request) ||
    !index(value.observedTail) ||
    !index(value.reusedCount) ||
    !index(value.budgetMs) ||
    value.count === 0 ||
    value.budgetMs === 0 ||
    value.through !== value.from + value.count - 1 ||
    value.request < value.from ||
    value.request > value.through ||
    value.reusedCount > value.count ||
    value.observedTail !== value.from + value.reusedCount ||
    (value.mode !== "session" && value.mode !== "transcript") ||
    (value.mode === "session"
      ? !text(value.key, 512) || !SESSION_KEY_PATTERN.test(value.key)
      : value.key !== undefined || value.from !== 0 || value.reusedCount !== 0) ||
    (value.reusedCount === 0) !== (value.reused === undefined)
  )
    return;
  if (value.reused !== undefined) {
    const r = value.reused;
    if (
      !object(r) ||
      !index(r.from) ||
      !index(r.through) ||
      !index(r.count) ||
      !closed(r, [
        "key",
        "from",
        "through",
        "count",
        "owner",
        "rowsHash",
        "attachmentsHash",
        "contextHash",
        "notepadHash",
      ]) ||
      r.key !== value.key ||
      r.from !== value.from ||
      r.count !== value.reusedCount ||
      r.through !== r.from + r.count - 1 ||
      ![r.rowsHash, r.attachmentsHash, r.contextHash, r.notepadHash].every(hash) ||
      (r.owner !== null &&
        (!object(r.owner) ||
          !closed(r.owner, ["runId", "gen"]) ||
          !text(r.owner.runId) ||
          !RUN_ID_PATTERN.test(r.owner.runId) ||
          !text(r.owner.gen, 128) ||
          !GEN_PATTERN.test(r.owner.gen)))
    )
      return;
  }
  return structuredClone(value) as unknown as ExpectedSeedManifest;
}
export function expectedSeedMatchesClaim(value: ExpectedSeedManifest, req: ClaimRequest, digest: string): boolean {
  const session = req.meta.session;
  return (
    value.bodySha256 === digest &&
    value.runId === req.runId &&
    value.threadKey === req.threadKey &&
    value.gen === req.gen &&
    value.startedAt === req.startedAt &&
    value.namespace === req.meta.channelId &&
    value.requester === req.meta.userId &&
    value.authenticatedAs === req.meta.authenticatedAs &&
    value.postedBy === req.meta.postedBy &&
    value.budgetMs === minutesToMs(req.meta.profile?.minutes ?? 0) &&
    (session
      ? session.range !== "broken" &&
        value.mode === "session" &&
        value.key === session.key &&
        value.from === session.seedFrom &&
        value.request === session.request &&
        value.observedTail === session.range.from
      : value.mode === "transcript" && value.key === undefined && value.from === 0)
  );
}
const normalizedRows = (rows: readonly TranscriptRow[]) =>
  [...rows]
    .sort((a, b) => a.idx - b.idx || a.part - b.part)
    .map((row) => ({ ...row, json: canonicalSeedJson(JSON.parse(row.json)) }));
const normalizedAttachments = (attachments: readonly TranscriptAttachment[]) =>
  [...attachments].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
function actorOf(row: TranscriptRow): unknown {
  return (JSON.parse(row.json) as { actor?: unknown }).actor;
}

/** Consumes the actual resolved open input and its actual observed claim range, without effects. */
export async function buildExpectedSeedManifest(input: {
  bodyJson: string;
  open: ResolvedExpectedSeedInput;
  observation: ExpectedSeedObservation;
}): Promise<ExpectedSeedBuildResult> {
  try {
    input = structuredClone(input);
    const req = promotionBodyOf(input.bodyJson),
      seed = input.open.seed,
      observed = input.observation;
    if (
      !req ||
      !seed ||
      !isContextDependencies(seed.context) ||
      typeof seed.notepad !== "string" ||
      !Array.isArray(seed.messages) ||
      !seed.messages.length
    )
      return { kind: "held", reason: "missing" };
    if (
      input.open.runId !== req.runId ||
      input.open.threadKey !== req.threadKey ||
      input.open.startedAt !== req.startedAt ||
      input.open.system !== req.system ||
      !index(seed.budgetMs) ||
      seed.budgetMs === 0 ||
      seed.budgetMs !== minutesToMs(req.meta.profile?.minutes ?? 0) ||
      !index(observed.next)
    )
      return { kind: "held", reason: "mismatch" };
    const session = req.meta.session;
    if (session && (session.range === "broken" || session.key !== observed.key))
      return { kind: "held", reason: "mismatch" };
    if (!session && (observed.key !== undefined || observed.next !== 0 || seed.log !== undefined))
      return { kind: "held", reason: "mismatch" };
    if (
      seed.actors !== undefined &&
      (!Array.isArray(seed.actors) ||
        seed.actors.length !== seed.messages.length ||
        seed.actors.some((actor) => actor !== undefined && (!text(actor) || !actor.includes(":"))))
    )
      return { kind: "held", reason: "missing" };
    const count = seed.messages.length,
      reusedCount = seed.log?.turns ?? 0,
      from = seed.log?.from ?? observed.next,
      through = from + count - 1;
    if (
      !index(from) ||
      !index(through) ||
      !index(reusedCount) ||
      reusedCount > count ||
      observed.next !== from + reusedCount
    )
      return { kind: "held", reason: "source" };
    if (
      session &&
      (session.seedFrom !== from ||
        session.request !== from + requestIndex(seed.messages) ||
        (session.range !== "broken" && session.range.from !== observed.next))
    )
      return { kind: "held", reason: "mismatch" };
    const rows: TranscriptRow[] = [],
      attachments: TranscriptAttachment[] = [];
    for (const [i, message] of seed.messages.entries()) {
      if (
        !message ||
        !["user", "assistant"].includes(message.role) ||
        !Array.isArray(message.content) ||
        !message.content.length
      )
        return { kind: "held", reason: "missing" };
      const turn = turnRows(from + i, message, {}, seed.actors?.[i]);
      rows.push(...turn.rows);
      attachments.push(...turn.attachments);
    }
    let reused: ExpectedSeedManifest["reused"];
    if (reusedCount) {
      const source = observed.reused;
      if (
        !source ||
        source.key !== observed.key ||
        source.from !== from ||
        source.through !== from + reusedCount - 1 ||
        source.next !== observed.next ||
        !isContextDependencies(source.context) ||
        typeof source.notepad !== "string" ||
        source.notepad !== seed.notepad
      )
        return { kind: "held", reason: "source" };
      const assembly = assembleTranscript(source.rows, source.attachments, from);
      if (
        !assembly.complete ||
        assembly.turns !== reusedCount ||
        assembly.compactions.length ||
        canonicalSeedJson(projectSessionMessages(assembly.messages, from, seed.refusedRequests)) !==
          canonicalSeedJson(seed.messages.slice(0, reusedCount)) ||
        ((await contextDependenciesHash(source.context)) !== (await contextDependenciesHash(seed.context)) &&
          !contextDependenciesContain(seed.context, source.context))
      )
        return { kind: "held", reason: "source" };
      if (
        source.rows.some((row) => row.idx < from || row.idx > source.through) ||
        new Set(source.rows.map((r) => `${r.idx}:${r.part}`)).size !== source.rows.length ||
        source.rows.some(
          (row) => seed.actors?.[row.idx - from] !== undefined && actorOf(row) !== seed.actors[row.idx - from],
        )
      )
        return { kind: "held", reason: "source" };
      const prefixRefs = new Set(
        rows.filter((row) => row.idx < observed.next).flatMap((row) => attachmentRefsOf(row.json)),
      );
      const actualRefs = new Set(source.rows.flatMap((row) => attachmentRefsOf(row.json)));
      if (
        source.attachments.some((a) => !actualRefs.has(a.ref)) ||
        new Set(source.attachments.map((a) => a.ref)).size !== source.attachments.length
      )
        return { kind: "held", reason: "source" };
      rows.splice(0, rows.filter((row) => row.idx < observed.next).length, ...source.rows);
      const newAttachments = attachments.filter((a) => !prefixRefs.has(a.ref));
      attachments.splice(0, attachments.length, ...source.attachments, ...newAttachments);
      reused = {
        key: source.key,
        from,
        through: source.through,
        count: reusedCount,
        owner: source.owner ?? null,
        rowsHash: await seedContentHash(normalizedRows(source.rows)),
        attachmentsHash: await seedContentHash(normalizedAttachments(source.attachments)),
        contextHash: await contextDependenciesHash(source.context),
        notepadHash: await seedContentHash(source.notepad),
      };
    } else if (observed.reused !== undefined) return { kind: "held", reason: "source" };
    const assembled = assembleTranscript(rows, attachments, from);
    if (!assembled.complete || assembled.turns !== count || assembled.compactions.length)
      return { kind: "held", reason: "unrepresentable" };
    const manifest: ExpectedSeedManifest = {
      version: 1,
      runId: req.runId,
      threadKey: req.threadKey,
      gen: req.gen,
      startedAt: req.startedAt,
      namespace: req.meta.channelId,
      requester: req.meta.userId,
      ...(req.meta.authenticatedAs !== undefined ? { authenticatedAs: req.meta.authenticatedAs } : {}),
      ...(req.meta.postedBy !== undefined ? { postedBy: req.meta.postedBy } : {}),
      bodySha256: await promotionBodyHash(input.bodyJson),
      mode: session ? "session" : "transcript",
      ...(session ? { key: session.key } : {}),
      from,
      through,
      count,
      request: from + requestIndex(seed.messages),
      observedTail: observed.next,
      reusedCount,
      budgetMs: seed.budgetMs,
      messagesHash: await seedContentHash(assembled.messages),
      modelMessagesHash: await seedContentHash(seed.messages),
      rowsHash: await seedContentHash(normalizedRows(rows)),
      attachmentsHash: await seedContentHash(normalizedAttachments(attachments)),
      actorsHash: await seedContentHash(
        rows.map((row) => ({ idx: row.idx, part: row.part, actor: actorOf(row) ?? null })),
      ),
      contextHash: await contextDependenciesHash(seed.context),
      notepadHash: await seedContentHash(seed.notepad),
      systemHash: await seedContentHash(input.open.system),
      ...(reused ? { reused } : {}),
    };
    if (!expectedSeedManifestOf(manifest) || !expectedSeedMatchesClaim(manifest, req, manifest.bodySha256))
      return { kind: "held", reason: "mismatch" };
    return { kind: "built", manifest, digest: await seedContentHash(manifest) };
  } catch {
    return { kind: "held", reason: "unrepresentable" };
  }
}

export const EXPECTED_SEED_HEADER = "x-switchboard-expected-seed";
/** Cloudflare's existing total request-header fence; unrelated to the claim body fence. */
export const WORKER_REQUEST_HEADER_BYTES = 128 * 1024;
/** Fixed-schema upper bound: JSON escapes need at most six bytes per UTF-16 unit. */
const maxText = "\u0000".repeat(512);
const maxThread = "\u0000".repeat(256);
const maxKey = "a".repeat(512);
const maxGen = "a".repeat(128);
const maxRun = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const maxIndex = Number.MAX_SAFE_INTEGER;
const maxHash = "a".repeat(64);
const maximumShape = {
  version: 1,
  runId: maxRun,
  threadKey: maxThread,
  gen: maxGen,
  startedAt: -0.0000010000000000000002,
  namespace: maxText,
  requester: maxText,
  authenticatedAs: maxText,
  postedBy: maxText,
  bodySha256: maxHash,
  mode: "session",
  key: maxKey,
  from: maxIndex,
  through: maxIndex,
  count: maxIndex,
  request: maxIndex,
  observedTail: maxIndex,
  reusedCount: maxIndex,
  budgetMs: maxIndex,
  messagesHash: maxHash,
  modelMessagesHash: maxHash,
  rowsHash: maxHash,
  attachmentsHash: maxHash,
  actorsHash: maxHash,
  contextHash: maxHash,
  notepadHash: maxHash,
  systemHash: maxHash,
  reused: {
    key: maxKey,
    from: maxIndex,
    through: maxIndex,
    count: maxIndex,
    owner: { runId: maxRun, gen: maxGen },
    rowsHash: maxHash,
    attachmentsHash: maxHash,
    contextHash: maxHash,
    notepadHash: maxHash,
  },
};
export const EXPECTED_SEED_MAX_JSON_BYTES = canonicalSeedJson(maximumShape).length;
export const EXPECTED_SEED_MAX_HEADER_BYTES = Math.ceil(EXPECTED_SEED_MAX_JSON_BYTES / 3) * 4;
export function encodeExpectedSeedHeader(value: ExpectedSeedManifest): string {
  const manifest = expectedSeedManifestOf(value);
  if (!manifest) throw new Error("invalid expected seed manifest");
  const json = canonicalSeedJson(manifest),
    bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > EXPECTED_SEED_MAX_JSON_BYTES) throw new Error("expected seed manifest exceeds fixed schema");
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}
export function decodeExpectedSeedHeader(value: unknown): ExpectedSeedManifest | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > EXPECTED_SEED_MAX_HEADER_BYTES ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    return;
  try {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
      json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    const manifest = expectedSeedManifestOf(JSON.parse(json));
    if (!manifest || canonicalSeedJson(manifest) !== json || encodeExpectedSeedHeader(manifest) !== value) return;
    return manifest;
  } catch {
    return;
  }
}
export function requestHeaderBytes(headers: Headers): number {
  return [...headers.entries()].reduce(
    (total, [name, value]) => total + new TextEncoder().encode(`${name}: ${value}\r\n`).byteLength,
    2,
  );
}
