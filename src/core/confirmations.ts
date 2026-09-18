import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ConfirmScope } from "../config/profile.js";
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

/** One pending confirmation as the store holds it: the message the sentence
 *  arrived as (its identity, thread and relay fields — the typed path reads
 *  them at the click; the sentence's attachments are not stored, see
 *  `confirmationMessageOf`), the command and its parsed, validated input, the
 *  capped receipt the record keeps, the offer's risk line and footer, the
 *  router's model (for the confirmed run's `route` event) and the expiry the
 *  config object stamped. */
export interface Confirmation {
  id: string;
  message: IncomingMessage;
  command: string;
  input: CommandInput;
  receipt: string;
  risk: string;
  footer: string;
  model: string;
  expiresAt: number;
}

/** What the door mints: the row before the store stamps its expiry. */
export type PendingConfirmation = Omit<Confirmation, "expiresAt">;

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
  describe(): string;
}

/** A fresh confirmation id: a UUID, the one token a channel's affordance carries. */
export function newConfirmationId(): string {
  return randomUUID();
}

// ---- the offer's words -------------------------------------------------------

/** The reply when the bound line would be altered by redaction — an argument
 *  looks like a secret — so no offer is minted: a line the person cannot read
 *  in full is not a confirmation. */
export const UNSHOWABLE_LINE = "this command carries a value that cannot be shown; type the line yourself";

/** The sentence appended to the hand-back when the store could not be reached
 *  at mint time: the person loses the button and nothing else. */
export const STORE_UNREACHABLE_NOTE = "(the confirmation store could not be reached, so there is no button to press)";

/** The offer's footer: which scope on the request's path asked for the
 *  confirmation (`effectiveConfirm`'s scope), the built-in default included. */
export function confirmationFooter(scope: ConfirmScope): string {
  switch (scope) {
    case "channel":
      return "confirmation required by this channel's boundary";
    case "user":
      return "confirmation required by your boundary";
    case "defaults":
      return "confirmation required by the defaults' boundary";
    case "built-in":
      return "confirmation required by the built-in default";
    default:
      // `effectiveConfirm` walks the config layers alone, so a directive or a
      // parent never reaches here; the word is still named rather than dropped.
      return `confirmation required by the ${scope} boundary`;
  }
}

/** The offer as text — the line, the risk when the command declares one, the
 *  footer: what the record's `answer` keeps, and what a channel shows around
 *  its affordance. */
export function renderOffer(offer: ConfirmationOffer): string {
  return [offer.line, ...(offer.risk ? [offer.risk] : []), offer.footer].join("\n");
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

/** A row the store wrote: the shape above, field by field. */
export function isPendingConfirmation(v: unknown): v is PendingConfirmation {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    isMessage(v.message) &&
    typeof v.command === "string" &&
    isRecord(v.input) &&
    typeof v.receipt === "string" &&
    typeof v.risk === "string" &&
    typeof v.footer === "string" &&
    typeof v.model === "string"
  );
}

export function isConfirmation(v: unknown): v is Confirmation {
  return isPendingConfirmation(v) && typeof (v as { expiresAt?: unknown }).expiresAt === "number";
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
    for (const v of Array.isArray(raw.confirmations) ? raw.confirmations : []) if (isConfirmation(v)) rows.set(v.id, v);
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
    const row = stored && isRecord(stored.body) ? { ...stored.body, expiresAt: stored.expiresAt } : undefined;
    if (isRefusal(body.refused))
      // The row beside a refusal is best-effort context (an older object
      // answers without it): absent or malformed, the refusal stands alone.
      return { ok: false, refused: body.refused, ...(isConfirmation(row) ? { row } : {}) };
    if (!isConfirmation(row)) throw new Error("confirmation store answered a consume outside its contract");
    return { ok: true, row };
  }
  async cancel(id: string, actorIds: readonly string[]): Promise<CancelOutcome> {
    const body = await this.post("/config/confirmations/cancel", { id, actorIds });
    if (body.ok === true) return { ok: true };
    if (body.refused === "used" || body.refused === "foreign") return { ok: false, refused: body.refused };
    throw new Error("confirmation store answered a cancel outside its contract");
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
