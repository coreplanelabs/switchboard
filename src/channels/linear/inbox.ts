import type { LinearWebhookEvent } from "./webhook.js";
import { object } from "./api.js";

export interface LinearDelivery {
  event: LinearWebhookEvent;
  lease: string;
  attempts: number;
  /** Set before entering dispatch, including commands without a run record. */
  begun?: boolean;
  /** A reconciliation hint, not proof that ledger admission succeeded. */
  runId?: string;
}

export interface LinearInbox {
  accept(event: LinearWebhookEvent, options?: { acknowledge?: boolean }): Promise<boolean>;
  claim(now: number, leaseMs: number, lease: string): Promise<LinearDelivery | undefined>;
  claimAck(now: number, leaseMs: number, lease: string): Promise<LinearDelivery | undefined>;
  acknowledge(key: string, lease: string, at: number): Promise<boolean>;
  hasPendingAcks(): Promise<boolean>;
  begin(key: string, lease: string): Promise<boolean>;
  bind(key: string, lease: string, runId: string): Promise<boolean>;
  renew(key: string, lease: string, until: number): Promise<boolean>;
  retry(key: string, lease: string, at: number): Promise<boolean>;
  /** Clear dispatch entry only after an explicit no-effects admission deferral. */
  defer(key: string, lease: string, at: number): Promise<boolean>;
  complete(key: string, lease: string, at: number): Promise<boolean>;
  cancelOrganization(organizationId: string, at: number): Promise<void>;
  prune(completedBefore: number): Promise<void>;
}

/** Cloudflare's SQLite cursor, narrowed so real SQLite can exercise the same queries locally. */
export interface LinearSql {
  exec<T extends Record<string, string | number | null>>(
    query: string,
    ...params: (string | number | null)[]
  ): { toArray(): T[] };
}

type Row = {
  event_key: string;
  payload: string;
  received_at: number;
  lease: string;
  attempts: number;
  run_id: string | null;
  begun: number;
};

/** Each mutation is one atomic SQL statement. Payloads live in SQLite, not
 *  Durable Object KV values, whose smaller ceiling would truncate issue context. */
export class SqlLinearInbox implements LinearInbox {
  constructor(private readonly sql: LinearSql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS linear_deliveries (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      payload TEXT,
      received_at INTEGER NOT NULL,
      phase TEXT NOT NULL DEFAULT 'pending',
      available_at INTEGER NOT NULL DEFAULT 0,
      lease TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      run_id TEXT,
      begun INTEGER NOT NULL DEFAULT 0,
      finished_at INTEGER
    )`);
    if (
      !sql
        .exec("PRAGMA table_info(linear_deliveries)")
        .toArray()
        .some((column) => column.name === "begun")
    )
      sql.exec("ALTER TABLE linear_deliveries ADD COLUMN begun INTEGER NOT NULL DEFAULT 0");
    sql.exec(
      "CREATE INDEX IF NOT EXISTS linear_deliveries_pending ON linear_deliveries(phase, available_at, sequence)",
    );
  }

  async accept(event: LinearWebhookEvent, options: { acknowledge?: boolean } = {}): Promise<boolean> {
    return (
      this.sql
        .exec(
          "INSERT INTO linear_deliveries (event_key, payload, received_at, phase) VALUES (?, ?, ?, ?) ON CONFLICT(event_key) DO NOTHING RETURNING event_key",
          event.key,
          JSON.stringify(event.payload),
          event.receivedAt,
          options.acknowledge ? "pending_ack" : "pending",
        )
        .toArray().length === 1
    );
  }

  claim(now: number, leaseMs: number, lease: string): Promise<LinearDelivery | undefined> {
    return this.take(now, leaseMs, lease, false);
  }
  claimAck(now: number, leaseMs: number, lease: string): Promise<LinearDelivery | undefined> {
    return this.take(now, leaseMs, lease, true);
  }
  private async take(now: number, leaseMs: number, lease: string, ack: boolean): Promise<LinearDelivery | undefined> {
    const [row] = this.sql
      .exec<Row>(
        `UPDATE linear_deliveries
      SET phase = ?, lease = ?, available_at = ?, attempts = attempts + 1
      WHERE sequence = (SELECT candidate.sequence FROM linear_deliveries candidate
        WHERE candidate.phase IN (?, ?) AND candidate.available_at <= ?
        AND (? = 1 OR json_extract(candidate.payload, '$.type') != 'AgentSessionEvent'
          OR json_extract(candidate.payload, '$.agentActivity.signal') = 'stop' OR NOT EXISTS (
          SELECT 1 FROM linear_deliveries prior WHERE prior.sequence < candidate.sequence
          AND prior.phase != 'done' AND prior.begun = 0
          AND json_extract(prior.payload, '$.type') = 'AgentSessionEvent'
          AND json_extract(prior.payload, '$.organizationId') = json_extract(candidate.payload, '$.organizationId')
          AND json_extract(prior.payload, '$.agentSession.id') = json_extract(candidate.payload, '$.agentSession.id')
        )) ORDER BY candidate.sequence LIMIT 1)
      RETURNING event_key, payload, received_at, lease, attempts, run_id, begun`,
        ack ? "processing_ack" : "processing",
        lease,
        now + leaseMs,
        ack ? "pending_ack" : "pending",
        ack ? "processing_ack" : "processing",
        now,
        ack ? 1 : 0,
      )
      .toArray();
    if (!row) return undefined;
    return {
      event: {
        key: row.event_key,
        receivedAt: row.received_at,
        payload: JSON.parse(row.payload) as LinearWebhookEvent["payload"],
      },
      lease: row.lease,
      attempts: row.attempts,
      ...(row.begun ? { begun: true } : {}),
      ...(row.run_id ? { runId: row.run_id } : {}),
    };
  }

  async acknowledge(key: string, lease: string, at: number): Promise<boolean> {
    return (
      this.sql
        .exec(
          "UPDATE linear_deliveries SET phase = 'pending', lease = NULL, available_at = ? WHERE event_key = ? AND lease = ? AND phase = 'processing_ack' RETURNING event_key",
          at,
          key,
          lease,
        )
        .toArray().length === 1
    );
  }
  async hasPendingAcks(): Promise<boolean> {
    return (
      this.sql
        .exec("SELECT 1 FROM linear_deliveries WHERE phase IN ('pending_ack', 'processing_ack') LIMIT 1")
        .toArray().length > 0
    );
  }

  async begin(key: string, lease: string): Promise<boolean> {
    return (
      this.sql
        .exec(
          "UPDATE linear_deliveries SET begun = 1 WHERE event_key = ? AND lease = ? AND phase = 'processing' AND begun = 0 RETURNING event_key",
          key,
          lease,
        )
        .toArray().length === 1
    );
  }

  async bind(key: string, lease: string, runId: string): Promise<boolean> {
    return (
      this.sql
        .exec(
          "UPDATE linear_deliveries SET run_id = ? WHERE event_key = ? AND lease = ? AND phase = 'processing' AND (run_id IS NULL OR run_id = ?) RETURNING event_key",
          runId,
          key,
          lease,
          runId,
        )
        .toArray().length === 1
    );
  }
  async renew(key: string, lease: string, until: number): Promise<boolean> {
    return (
      this.sql
        .exec(
          "UPDATE linear_deliveries SET available_at = MAX(available_at, ?) WHERE event_key = ? AND lease = ? AND phase = 'processing' RETURNING event_key",
          until,
          key,
          lease,
        )
        .toArray().length === 1
    );
  }
  async defer(key: string, lease: string, at: number): Promise<boolean> {
    return (
      this.sql
        .exec(
          "UPDATE linear_deliveries SET phase = 'pending', begun = 0, lease = NULL, available_at = ? WHERE event_key = ? AND lease = ? AND phase = 'processing' AND run_id IS NULL RETURNING event_key",
          at,
          key,
          lease,
        )
        .toArray().length === 1
    );
  }
  async retry(key: string, lease: string, at: number): Promise<boolean> {
    return (
      this.sql
        .exec(
          "UPDATE linear_deliveries SET phase = CASE phase WHEN 'processing_ack' THEN 'pending_ack' ELSE 'pending' END, lease = NULL, available_at = ? WHERE event_key = ? AND lease = ? AND phase IN ('processing', 'processing_ack') RETURNING event_key",
          at,
          key,
          lease,
        )
        .toArray().length === 1
    );
  }
  async complete(key: string, lease: string, at: number): Promise<boolean> {
    return (
      this.sql
        .exec(
          "UPDATE linear_deliveries SET phase = 'done', payload = NULL, lease = NULL, finished_at = ? WHERE event_key = ? AND lease = ? AND phase IN ('processing', 'processing_ack') RETURNING event_key",
          at,
          key,
          lease,
        )
        .toArray().length === 1
    );
  }
  async prune(completedBefore: number): Promise<void> {
    this.sql.exec("DELETE FROM linear_deliveries WHERE phase = 'done' AND finished_at < ?", completedBefore);
  }
  async cancelOrganization(organizationId: string, at: number): Promise<void> {
    this.sql.exec(
      `UPDATE linear_deliveries SET phase = 'done', payload = NULL, lease = NULL, finished_at = ?
       WHERE phase != 'done' AND received_at <= ? AND json_extract(payload, '$.organizationId') = ?
       AND json_extract(payload, '$.type') = 'AgentSessionEvent'`,
      at,
      at,
      organizationId,
    );
  }
}

type MemoryRow = {
  event?: LinearWebhookEvent;
  phase: "pending" | "processing" | "pending_ack" | "processing_ack" | "done";
  availableAt: number;
  lease?: string;
  attempts: number;
  begun?: boolean;
  runId?: string;
  finishedAt?: number;
};

export class InMemoryLinearInbox implements LinearInbox {
  private readonly rows = new Map<string, MemoryRow>();

  async accept(event: LinearWebhookEvent, options: { acknowledge?: boolean } = {}): Promise<boolean> {
    if (this.rows.has(event.key)) return false;
    this.rows.set(event.key, {
      event: structuredClone(event),
      phase: options.acknowledge ? "pending_ack" : "pending",
      availableAt: 0,
      attempts: 0,
    });
    return true;
  }
  claim(now: number, leaseMs: number, lease: string): Promise<LinearDelivery | undefined> {
    return this.take(now, leaseMs, lease, false);
  }
  claimAck(now: number, leaseMs: number, lease: string): Promise<LinearDelivery | undefined> {
    return this.take(now, leaseMs, lease, true);
  }
  private async take(now: number, leaseMs: number, lease: string, ack: boolean): Promise<LinearDelivery | undefined> {
    const blocked = new Set<string>();
    for (const row of this.rows.values()) {
      if (row.phase === "done" || !row.event) continue;
      const session =
        row.event.payload.type === "AgentSessionEvent"
          ? `${row.event.payload.organizationId}:${String(object(row.event.payload.agentSession).id)}`
          : undefined;
      const follows =
        session !== undefined && blocked.has(session) && object(row.event.payload.agentActivity).signal !== "stop";
      if (session && !row.begun) blocked.add(session);
      if (
        row.availableAt > now ||
        (ack
          ? !["pending_ack", "processing_ack"].includes(row.phase)
          : follows || !["pending", "processing"].includes(row.phase))
      )
        continue;
      row.phase = ack ? "processing_ack" : "processing";
      row.lease = lease;
      row.availableAt = now + leaseMs;
      row.attempts++;
      return {
        event: structuredClone(row.event),
        lease,
        attempts: row.attempts,
        ...(row.begun ? { begun: true } : {}),
        ...(row.runId ? { runId: row.runId } : {}),
      };
    }
    return undefined;
  }
  private owned(key: string, lease: string, ack = false): MemoryRow | undefined {
    const row = this.rows.get(key);
    return (row?.phase === "processing" || (ack && row?.phase === "processing_ack")) && row.lease === lease
      ? row
      : undefined;
  }
  async acknowledge(key: string, lease: string, at: number): Promise<boolean> {
    const row = this.owned(key, lease, true);
    if (row?.phase !== "processing_ack") return false;
    row.phase = "pending";
    row.lease = undefined;
    row.availableAt = at;
    return true;
  }
  async hasPendingAcks(): Promise<boolean> {
    return [...this.rows.values()].some((row) => row.phase === "pending_ack" || row.phase === "processing_ack");
  }
  async begin(key: string, lease: string): Promise<boolean> {
    const row = this.owned(key, lease);
    if (!row || row.begun) return false;
    row.begun = true;
    return true;
  }
  async bind(key: string, lease: string, runId: string): Promise<boolean> {
    const row = this.owned(key, lease);
    if (!row || (row.runId && row.runId !== runId)) return false;
    row.runId = runId;
    return true;
  }
  async renew(key: string, lease: string, until: number): Promise<boolean> {
    const row = this.owned(key, lease);
    if (!row) return false;
    row.availableAt = Math.max(row.availableAt, until);
    return true;
  }
  async defer(key: string, lease: string, at: number): Promise<boolean> {
    const row = this.owned(key, lease);
    if (!row || row.runId) return false;
    row.begun = false;
    row.phase = "pending";
    row.lease = undefined;
    row.availableAt = at;
    return true;
  }
  async retry(key: string, lease: string, at: number): Promise<boolean> {
    const row = this.owned(key, lease, true);
    if (!row) return false;
    row.phase = row.phase === "processing_ack" ? "pending_ack" : "pending";
    row.lease = undefined;
    row.availableAt = at;
    return true;
  }
  async complete(key: string, lease: string, at: number): Promise<boolean> {
    const row = this.owned(key, lease, true);
    if (!row) return false;
    row.phase = "done";
    row.event = undefined;
    row.lease = undefined;
    row.finishedAt = at;
    return true;
  }
  async prune(completedBefore: number): Promise<void> {
    for (const [key, row] of this.rows)
      if (row.phase === "done" && row.finishedAt !== undefined && row.finishedAt < completedBefore)
        this.rows.delete(key);
  }
  async cancelOrganization(organizationId: string, at: number): Promise<void> {
    for (const row of this.rows.values()) {
      if (
        row.event?.payload.organizationId !== organizationId ||
        row.event.payload.type !== "AgentSessionEvent" ||
        row.event.receivedAt > at
      )
        continue;
      row.phase = "done";
      row.event = undefined;
      row.lease = undefined;
      row.finishedAt = at;
    }
  }
}
