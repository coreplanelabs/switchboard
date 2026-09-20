import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Secrets } from "../secrets.js";
import type { CommandInput } from "./commandRegistry.js";
import { systemClock } from "./trace/clock.js";
import type { Clock } from "./trace/types.js";
import type { ConfirmationOffer, IncomingMessage } from "./types.js";

// The confirmation a routed write is offered as (docs/decisions/0044-a-routed-write-is-confirmed-in-proportion-to-its-blast-radius.md;
// docs/reference/specs/routing-and-config.md item 25). The router bound a
// state-changing command from prose; the door does not run it, and on a
// channel that can show an offer it stores this row and shows the line, so
// one click runs exactly what was offered, once, for the person who asked. The
// row is bound to the requester (the channel's other members can click a
// button they did not ask for), one-time and expiring (the offer message stays
// in the channel as long as the channel keeps history), and durable across a
// bot restart (the bot rolls on most releases) — so it lives beside the connect
// tickets in the state Worker's config object, never on the host and never in
// the channel, which carries the id alone. Three implementations (AGENTS.md
// invariant 2): `WorkerConfirmationStore` (production), `FileConfirmationStore`
// (the local-dev twin of the overrides file), `InMemoryConfirmationStore`.
//
// Route contract (bearer = MEMORY_TOKEN; `deploy/cloudflare-memory/worker.ts`):
//   POST /config/confirmations/put     {id, threadKey, requester, body, ttlMs} → {ok, expiresAt}   (replaces the thread's older row; the object stamps the expiry)
//   POST /config/confirmations/consume {id, actorIds} → {row: {id, threadKey, requester, expiresAt, body}} | {refused: used | expired | foreign}
//   POST /config/confirmations/cancel  {id, actorIds} → {ok} | {refused: used | foreign}
//   POST /config/confirmations/cancel-by-thread {threadKey, actorIds} → {ok} | {refused: used | foreign}
//   POST /config/confirmations/pending-by-thread {threadKey} → {row: {id, threadKey, requester, expiresAt, body} | null}   (a read; an expired row reads as none and is not deleted)

/** A routed write's pending confirmation as the store holds it (record 0044):
 *  the message the sentence arrived as (its identity, thread and relay fields
 *  — the typed path reads them at the click; the sentence's attachments are
 *  not stored, see `confirmationMessageOf`), the command and its parsed,
 *  validated input, the capped receipt the record keeps, the offer's risk
 *  line, the router's model (for the confirmed run's `route`
 *  event) and the expiry the config object stamped. A row stored before the
 *  union existed carries no `kind`; the parsers read it as this one. */
export interface RunConfirmation {
  kind: "run";
  id: string;
  message: IncomingMessage;
  command: string;
  input: CommandInput;
  receipt: string;
  risk: string;
  model: string;
  expiresAt: number;
}

/** A question's pending Yes (record 0054): the stored proposal — the person's
 *  message with the fix applied, whose `userId` is the requester the store
 *  judges the click against — the line the button shows, the evidence that
 *  names the match, and the question's refusal code, which the redispatched
 *  request's record names ([run-history.md](../../docs/reference/specs/run-history.md)
 *  item 2). Yes hands `message` to `dispatch()` as the requester; No deletes
 *  the row and runs nothing. */
export interface RedispatchConfirmation {
  kind: "redispatch";
  id: string;
  message: IncomingMessage;
  line: string;
  evidence: string;
  code: string;
  expiresAt: number;
}

/** One pending confirmation as the store holds it: the discriminated union of
 *  the routed write's row and the question's Yes. */
export type Confirmation = RunConfirmation | RedispatchConfirmation;

/** What the door mints: the row before the store stamps its expiry. */
export type PendingConfirmation = Omit<RunConfirmation, "expiresAt"> | Omit<RedispatchConfirmation, "expiresAt">;

/** Why a consume or a cancel refused: the row is gone — consumed, cancelled or
 *  never there (`used`); past its expiry (`expired`); someone else's (`foreign`). */
export type ConfirmationRefusal = "used" | "expired" | "foreign";
export const CONFIRMATION_REFUSALS: readonly ConfirmationRefusal[] = ["used", "expired", "foreign"];

/** A refusal carries the row when the store still holds one — `expired` (read,
 *  then deleted) and `foreign` (kept for its requester) — so the click's
 *  refusal can be recorded against the command that was bound (record 0054;
 *  [run-history.md](../../docs/reference/specs/run-history.md) item 2). A
 *  `used` row is gone, so that refusal names nothing. */
export type ConsumeOutcome =
  { ok: true; row: Confirmation } | { ok: false; refused: ConfirmationRefusal; row?: Confirmation };
export type CancelOutcome = { ok: true } | { ok: false; refused: Exclude<ConfirmationRefusal, "expired"> };

export interface ConfirmationStore {
  /** Mint: store the row with `expiresAt = now + ttlMs` on the store's clock,
   *  replacing the thread's older row in the same transaction; answers the
   *  row as stored. Throws when the store cannot be reached. */
  put(row: PendingConfirmation, ttlMs: number): Promise<Confirmation>;
  /** The click: read, judge and delete in one transaction — `used` when the
   *  row is gone, `expired` (and deleted) when past its expiry, `foreign` (and
   *  kept) when none of `actorIds` is the requester, else the row, deleted. */
  consume(id: string, actorIds: readonly string[]): Promise<ConsumeOutcome>;
  /** Delete under the same requester check; a cancel and a consume on one id
   *  cannot both succeed. */
  cancel(id: string, actorIds: readonly string[]): Promise<CancelOutcome>;
  /** Delete the thread's pending row under the same requester check — a typed
   *  answer supersedes the button (record 0054), so a click cannot follow it.
   *  A thread with no row is `used`. */
  cancelByThread(threadKey: string, actorIds: readonly string[]): Promise<CancelOutcome>;
  /** The thread's pending row when one exists and is inside its ttl — the
   *  row's `message.userId` names the person it waits on — else none. A pure
   *  read: expiry is checked by this reader on the store's clock and nothing
   *  is deleted, so a consume still finds the expired row to name `expired`. */
  pendingByThread(threadKey: string): Promise<Confirmation | undefined>;
  describe(): string;
}

/** A fresh confirmation id: a UUID, the one token a channel's affordance carries. */
export function newConfirmationId(): string {
  return randomUUID();
}

// ---- the offer's words -------------------------------------------------------

/** The refusal when the bound line would be altered by redaction — an
 *  argument looks like a secret — so no offer is minted: a line the person
 *  cannot read in full is not a confirmation (record 0069's table: a chat
 *  surface's mint failure is a refusal naming why, never a line to retype). */
export const UNSHOWABLE_LINE =
  "this command carries a value that cannot be shown, so no confirmation can be offered; nothing ran";

/** The refusal when the confirmation store cannot mint the click — the store
 *  threw, or the process holds none — on a chat surface, where the click is
 *  the only way a held write runs (record 0069's table): the refusal names
 *  why and the person's next message re-asks the door; never the line to
 *  retype. */
export const STORE_UNREACHABLE_LINE =
  "this command needs a confirmation click, and the confirmation store could not be reached; nothing ran — ask again for the button";

/** The refusal for a write bind whose thread already holds a pending
 *  confirmation from the same decision (record 0044's one-row-per-thread
 *  invariant; the one-execution-path plan's click unit): the first write
 *  bind minted, and this one is refused naming the pending row — minting it
 *  would silently replace the row the person is looking at. */
export function pendingRowLine(line: string): string {
  return `a confirmation is already pending on this thread (\`${line}\`); click or cancel it first — one write is offered at a time`;
}

/** The offer as text — the line, the risk when the command declares one:
 *  what the record's `answer` keeps, and what a channel shows around its
 *  affordance. A question's offer (record 0054) reads as the question the
 *  renderer would have sent without a button — the producer's sentence, the
 *  marker, the line as one code span, the evidence — so a client without
 *  blocks still shows the line to type. */
export function renderOffer(offer: ConfirmationOffer): string {
  if (offer.question) return `${offer.question.text}\nDid you mean:\n\`${offer.line}\`\n\n${offer.question.evidence}`;
  return [offer.line, ...(offer.risk ? [offer.risk] : [])].join("\n");
}

/** The message as the row stores it: everything the typed path reads at the
 *  click — identity, thread, relay and binding fields, the text and the
 *  platform's message id — without the sentence's attachments (`images`,
 *  `documents`, `staged`), which belong to the sentence, not to the command
 *  it bound, and have no place in a config row. */
export function confirmationMessageOf(msg: IncomingMessage): IncomingMessage {
  const { images: _images, documents: _documents, staged: _staged, ...kept } = msg;
  return kept;
}

// ---- the stored shape ----------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isMessage(v: unknown): v is IncomingMessage {
  return (
    isRecord(v) &&
    typeof v.channelId === "string" &&
    typeof v.userId === "string" &&
    typeof v.threadKey === "string" &&
    typeof v.text === "string"
  );
}

/** The routed write's shape, field by field — `kind` left aside, because a
 *  row stored before the union existed carries none. */
function isRunShape(v: Record<string, unknown>): boolean {
  return (
    typeof v.id === "string" &&
    isMessage(v.message) &&
    typeof v.command === "string" &&
    isRecord(v.input) &&
    typeof v.receipt === "string" &&
    typeof v.risk === "string" &&
    typeof v.model === "string"
  );
}

function isRedispatchShape(v: Record<string, unknown>): boolean {
  return (
    typeof v.id === "string" &&
    isMessage(v.message) &&
    typeof v.line === "string" &&
    typeof v.evidence === "string" &&
    typeof v.code === "string"
  );
}

/** A row the store wrote, read back as the union: a `redispatch` row by its
 *  `kind`, everything else — today's rows and every row stored before the
 *  union existed, which carries no `kind` — as a `run` row, the `kind`
 *  stamped on the way out (record 0054: old rows still parse). */
export function parsePendingConfirmation(v: unknown): PendingConfirmation | undefined {
  if (!isRecord(v)) return undefined;
  if (v.kind === "redispatch")
    return isRedispatchShape(v) ? (v as unknown as Omit<RedispatchConfirmation, "expiresAt">) : undefined;
  if (v.kind !== undefined && v.kind !== "run") return undefined;
  return isRunShape(v) ? ({ ...v, kind: "run" } as unknown as Omit<RunConfirmation, "expiresAt">) : undefined;
}

/** The stored row with the expiry the object stamped, or nothing. */
export function parseConfirmation(v: unknown): Confirmation | undefined {
  if (!isRecord(v) || typeof v.expiresAt !== "number") return undefined;
  const pending = parsePendingConfirmation(v);
  return pending ? ({ ...pending, expiresAt: v.expiresAt } as Confirmation) : undefined;
}

export function isConfirmation(v: unknown): v is Confirmation {
  return parseConfirmation(v) !== undefined;
}

function isRefusal(v: unknown): v is ConfirmationRefusal {
  return typeof v === "string" && (CONFIRMATION_REFUSALS as readonly string[]).includes(v);
}

// ---- the in-memory and file stores ----------------------------------------------

/** The judgement every store makes, over the rows it holds, on its own clock.
 *  Shared by the in-memory and file stores; the config object makes the same
 *  one in SQL. */
function judge(
  rows: Map<string, Confirmation>,
  id: string,
  actorIds: readonly string[],
  now: number,
  kind: "consume" | "cancel",
): ConsumeOutcome | CancelOutcome {
  const row = rows.get(id);
  if (!row) return { ok: false, refused: "used" };
  if (kind === "consume" && row.expiresAt <= now) {
    rows.delete(id);
    return { ok: false, refused: "expired", row };
  }
  if (!actorIds.includes(row.message.userId))
    return kind === "consume" ? { ok: false, refused: "foreign", row } : { ok: false, refused: "foreign" };
  rows.delete(id);
  return kind === "consume" ? { ok: true, row } : { ok: true };
}

function replaceThreadRow(rows: Map<string, Confirmation>, row: Confirmation): void {
  for (const [id, r] of rows) if (r.message.threadKey === row.message.threadKey) rows.delete(id);
  rows.set(row.id, row);
}

/** The thread's pending row's id, for a cancel by thread: at most one exists
 *  (`replaceThreadRow`); none is the cancel's `used`. */
function threadRowId(rows: Map<string, Confirmation>, threadKey: string): string | undefined {
  for (const [id, r] of rows) if (r.message.threadKey === threadKey) return id;
  return undefined;
}

export class InMemoryConfirmationStore implements ConfirmationStore {
  readonly rows = new Map<string, Confirmation>();
  private readonly clock: Clock;
  constructor(opts: { clock?: Clock } = {}) {
    this.clock = opts.clock ?? systemClock;
  }
  async put(row: PendingConfirmation, ttlMs: number): Promise<Confirmation> {
    const stored: Confirmation = structuredClone({ ...row, expiresAt: this.clock() + ttlMs });
    replaceThreadRow(this.rows, stored);
    return structuredClone(stored);
  }
  async consume(id: string, actorIds: readonly string[]): Promise<ConsumeOutcome> {
    const out = judge(this.rows, id, actorIds, this.clock(), "consume") as ConsumeOutcome;
    if (out.ok) return { ok: true, row: structuredClone(out.row) };
    return out.row ? { ...out, row: structuredClone(out.row) } : out;
  }
  async cancel(id: string, actorIds: readonly string[]): Promise<CancelOutcome> {
    return judge(this.rows, id, actorIds, this.clock(), "cancel") as CancelOutcome;
  }
  async cancelByThread(threadKey: string, actorIds: readonly string[]): Promise<CancelOutcome> {
    const id = threadRowId(this.rows, threadKey);
    if (id === undefined) return { ok: false, refused: "used" };
    return judge(this.rows, id, actorIds, this.clock(), "cancel") as CancelOutcome;
  }
  async pendingByThread(threadKey: string): Promise<Confirmation | undefined> {
    const id = threadRowId(this.rows, threadKey);
    const row = id === undefined ? undefined : this.rows.get(id);
    if (!row || row.expiresAt <= this.clock()) return undefined;
    return structuredClone(row);
  }
  describe(): string {
    return "in-memory";
  }
}

/** The rows in one JSON file (`data/confirmations.json`): the dev and
 *  single-host choice, beside the overrides file. Read-check-write on one
 *  process's file: atomic for the single bot that owns it. */
export class FileConfirmationStore implements ConfirmationStore {
  private readonly path: string;
  private readonly clock: Clock;
  constructor(path: string, opts: { clock?: Clock } = {}) {
    this.path = resolve(path);
    this.clock = opts.clock ?? systemClock;
  }
  private read(): Map<string, Confirmation> {
    const rows = new Map<string, Confirmation>();
    if (!existsSync(this.path)) return rows;
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as { confirmations?: unknown };
    for (const v of Array.isArray(raw.confirmations) ? raw.confirmations : []) {
      const row = parseConfirmation(v);
      if (row) rows.set(row.id, row);
    }
    return rows;
  }
  private write(rows: Map<string, Confirmation>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ confirmations: [...rows.values()] }, null, 2));
  }
  async put(row: PendingConfirmation, ttlMs: number): Promise<Confirmation> {
    const rows = this.read();
    const stored: Confirmation = { ...row, expiresAt: this.clock() + ttlMs };
    replaceThreadRow(rows, stored);
    this.write(rows);
    return stored;
  }
  async consume(id: string, actorIds: readonly string[]): Promise<ConsumeOutcome> {
    const rows = this.read();
    const out = judge(rows, id, actorIds, this.clock(), "consume") as ConsumeOutcome;
    this.write(rows);
    return out;
  }
  async cancel(id: string, actorIds: readonly string[]): Promise<CancelOutcome> {
    const rows = this.read();
    const out = judge(rows, id, actorIds, this.clock(), "cancel") as CancelOutcome;
    this.write(rows);
    return out;
  }
  async cancelByThread(threadKey: string, actorIds: readonly string[]): Promise<CancelOutcome> {
    const rows = this.read();
    const id = threadRowId(rows, threadKey);
    if (id === undefined) return { ok: false, refused: "used" };
    const out = judge(rows, id, actorIds, this.clock(), "cancel") as CancelOutcome;
    this.write(rows);
    return out;
  }
  async pendingByThread(threadKey: string): Promise<Confirmation | undefined> {
    const rows = this.read();
    const id = threadRowId(rows, threadKey);
    const row = id === undefined ? undefined : rows.get(id);
    if (!row || row.expiresAt <= this.clock()) return undefined;
    return row;
  }
  describe(): string {
    return `file ${this.path}`;
  }
}

// ---- the config object's client --------------------------------------------------

export const CONFIRMATION_WORKER_TIMEOUT_MS = 8_000;

/** The production store: the `confirmations` table of the state Worker's
 *  config object, reached over the three routes above. The thread and the
 *  requester travel beside the row so the object judges on them without
 *  reading the body; the expiry comes back stamped by the object's clock. */
export class WorkerConfirmationStore implements ConfirmationStore {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: { baseUrl: string; token: string; fetch?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }
  async put(row: PendingConfirmation, ttlMs: number): Promise<Confirmation> {
    const body = await this.post("/config/confirmations/put", {
      id: row.id,
      threadKey: row.message.threadKey,
      requester: row.message.userId,
      body: row,
      ttlMs,
    });
    if (typeof body.expiresAt !== "number")
      throw new Error("confirmation store answered a put without the expiry it stamped");
    return { ...row, expiresAt: body.expiresAt };
  }
  async consume(id: string, actorIds: readonly string[]): Promise<ConsumeOutcome> {
    const body = await this.post("/config/confirmations/consume", { id, actorIds });
    const stored = isRecord(body.row) ? body.row : undefined;
    const row = parseConfirmation(
      stored && isRecord(stored.body) ? { ...stored.body, expiresAt: stored.expiresAt } : undefined,
    );
    if (isRefusal(body.refused))
      // The row beside a refusal is best-effort context (an older object
      // answers without it): absent or malformed, the refusal stands alone.
      return { ok: false, refused: body.refused, ...(row ? { row } : {}) };
    if (!row) throw new Error("confirmation store answered a consume outside its contract");
    return { ok: true, row };
  }
  async cancel(id: string, actorIds: readonly string[]): Promise<CancelOutcome> {
    const body = await this.post("/config/confirmations/cancel", { id, actorIds });
    if (body.ok === true) return { ok: true };
    if (body.refused === "used" || body.refused === "foreign") return { ok: false, refused: body.refused };
    throw new Error("confirmation store answered a cancel outside its contract");
  }
  async cancelByThread(threadKey: string, actorIds: readonly string[]): Promise<CancelOutcome> {
    const body = await this.post("/config/confirmations/cancel-by-thread", { threadKey, actorIds });
    if (body.ok === true) return { ok: true };
    if (body.refused === "used" || body.refused === "foreign") return { ok: false, refused: body.refused };
    throw new Error("confirmation store answered a cancel-by-thread outside its contract");
  }
  async pendingByThread(threadKey: string): Promise<Confirmation | undefined> {
    const body = await this.post("/config/confirmations/pending-by-thread", { threadKey });
    if (body.row === null) return undefined;
    const stored = isRecord(body.row) ? body.row : undefined;
    const row = parseConfirmation(
      stored && isRecord(stored.body) ? { ...stored.body, expiresAt: stored.expiresAt } : undefined,
    );
    if (!row) throw new Error("confirmation store answered a pending-by-thread outside its contract");
    return row;
  }
  describe(): string {
    return `state Worker ${this.baseUrl} (ConfigDO confirmations)`;
  }
  private async post(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CONFIRMATION_WORKER_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`confirmation store unreachable: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    if (!res.ok) throw new Error(`confirmation store answered HTTP ${res.status} on ${path}`);
    const body: unknown = await res.json().catch(() => undefined);
    if (!isRecord(body)) throw new Error(`confirmation store returned a non-JSON body on ${path}`);
    return body;
  }
}

/**
 * Startup wiring (`src/index.ts`): the confirmations go where the runtime
 * overrides go — the state Worker's config object when `runtimeOverrides.worker`
 * is set (its bearer is required there, as it is for the overrides), else a
 * JSON file beside the overrides file.
 */
export function buildConfirmationStore(
  config: { config: { runtimeOverrides?: { worker?: { baseUrl: string; tokenEnv?: string } } } },
  secrets: Pick<Secrets, "named">,
  opts: { path: string; fetch?: typeof fetch },
): ConfirmationStore {
  const worker = config.config.runtimeOverrides?.worker;
  if (!worker) return new FileConfirmationStore(opts.path);
  const tokenEnv = worker.tokenEnv ?? "MEMORY_TOKEN";
  const token = secrets.named(tokenEnv);
  if (!token) throw new Error(`runtimeOverrides.worker is configured but ${tokenEnv} is not set`);
  return new WorkerConfirmationStore({
    baseUrl: worker.baseUrl,
    token: token.reveal(),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}
