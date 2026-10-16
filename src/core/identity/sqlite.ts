import { executeNotices, type NoticeCommand, type NoticeResult, type NoticeQuery } from "./notices.js";
import {
  changeSchema,
  bindingSchema,
  identitySchema,
  type BindingChange,
  type BindingResolution,
  type ChangeResult,
  type CreatePersonResult,
  type ExternalIdentity,
  type PersonDirectory,
  type PersonBinding,
  type ReceiptsResult,
} from "./contract.js";
import type { LinkCommand, LinkResult } from "./linkContract.js";
import { executeLink } from "./linkEngine.js";
import { decideChange, identityKey, mintPerson, readBinding, readReceipts, resolution } from "./engine.js";

/** Structural subset of Durable Object storage. The owner supplies one
 * authoritative database; transactionSync must serialize read/write work and
 * roll back on throw. No host filesystem or network access lives in this seam. */
export interface DirectorySqlStorage {
  sql: {
    exec<T extends Record<string, string | number | null>>(
      query: string,
      ...bindings: (string | number | null)[]
    ): Iterable<T>;
  };
  transactionSync<T>(body: () => T): T;
}
function decode(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Durable implementation over the authoritative directory database.
 * Primary keys and the transaction fence arbitrate writers, not a process lock.
 * Reads never use an in-process positive cache. */
export class SqlitePersonDirectory implements PersonDirectory {
  constructor(
    private readonly storage: DirectorySqlStorage,
    private readonly now: () => number,
    private readonly onBindingChanged?: (binding: PersonBinding) => void,
  ) {
    try {
      storage.transactionSync(() => {
        storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS directory_people (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)",
        );
        storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS person_bindings (identity_key TEXT PRIMARY KEY, body TEXT NOT NULL)",
        );
        storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS person_binding_receipts (identity_key TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (identity_key, revision))",
        );
        storage.sql.exec("CREATE TABLE IF NOT EXISTS person_link_intents (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
        storage.sql.exec("CREATE TABLE IF NOT EXISTS person_link_outcomes (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
        storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS person_identity_notices (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
        );
        storage.sql.exec(
          "CREATE INDEX IF NOT EXISTS person_identity_notice_queue ON person_identity_notices (json_extract(body, '$.organization'), json_extract(body, '$.deliveredAt'))",
        );
      });
    } catch {
      throw new Error("person directory unavailable");
    }
  }
  private personExists = (id: string): boolean => {
    return [...this.storage.sql.exec("SELECT id FROM directory_people WHERE id = ?", id)].length === 1;
  };
  private current(identity: ExternalIdentity) {
    const rows = [
      ...this.storage.sql.exec<{ body: string }>(
        "SELECT body FROM person_bindings WHERE identity_key = ?",
        identityKey(identity),
      ),
    ];
    return readBinding(rows.length ? decode(rows[0].body) : undefined, identity, this.personExists);
  }
  async createPerson(): Promise<CreatePersonResult> {
    try {
      return this.storage.transactionSync(() => {
        const person = mintPerson(this.now());
        this.storage.sql.exec(
          "INSERT INTO directory_people (id, created_at) VALUES (?, ?)",
          person.id,
          person.createdAt,
        );
        return { status: "created", person };
      });
    } catch {
      return { status: "unavailable" };
    }
  }
  async resolve(identity: ExternalIdentity): Promise<BindingResolution> {
    const parsed = identitySchema.safeParse(identity);
    if (!parsed.success) return { status: "invalid" };
    try {
      return this.storage.transactionSync(() => resolution(this.current(parsed.data)));
    } catch {
      return { status: "unavailable" };
    }
  }
  async change(input: BindingChange): Promise<ChangeResult> {
    const parsed = changeSchema.safeParse(input);
    if (!parsed.success) return { status: "invalid" };
    const change = parsed.data;
    try {
      return this.storage.transactionSync(() => {
        const current = this.current(change.identity);
        if (current.status === "conflict") return current;
        if (!this.personExists(change.personId)) return { status: "unknown_person" };
        const result = decideChange(current, change, this.now());
        if (result.status !== "changed") return result;
        const key = identityKey(change.identity);
        this.storage.sql.exec(
          "INSERT INTO person_bindings (identity_key, body) VALUES (?, ?) ON CONFLICT(identity_key) DO UPDATE SET body = excluded.body",
          key,
          JSON.stringify(result.binding),
        );
        this.storage.sql.exec(
          "INSERT INTO person_binding_receipts (identity_key, revision, body) VALUES (?, ?, ?)",
          key,
          result.binding.revision,
          JSON.stringify({ action: change.action, actor: change.actor, binding: result.binding }),
        );
        this.onBindingChanged?.(result.binding);
        return result;
      });
    } catch {
      return { status: "unavailable" };
    }
  }
  async link(command: LinkCommand): Promise<LinkResult> {
    try {
      return this.storage.transactionSync(() =>
        executeLink(
          {
            bindings: (personId) =>
              [
                ...this.storage.sql.exec<{ body: string }>(
                  "SELECT body FROM person_bindings WHERE json_extract(body, '$.personId') = ? ORDER BY identity_key",
                  personId,
                ),
              ].map((row) => bindingSchema.parse(decode(row.body))),
            notices: (query) => this.noticeRows(query),
            putNotice: (notice) => {
              this.storage.sql.exec(
                "INSERT INTO person_identity_notices (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
                notice.id,
                JSON.stringify(notice),
              );
            },
            intent: (id) => this.linkRow("person_link_intents", id),
            audit: (id) => this.linkRow("person_link_outcomes", id),
            current: (identity) => this.current(identity),
            putIntent: (intent, create) => {
              this.storage.sql.exec(
                create
                  ? "INSERT INTO person_link_intents (id, body) VALUES (?, ?)"
                  : "UPDATE person_link_intents SET body = ?2 WHERE id = ?1",
                intent.id,
                JSON.stringify(intent),
              );
            },
            putPerson: (person) => {
              this.storage.sql.exec(
                "INSERT INTO directory_people (id, created_at) VALUES (?, ?)",
                person.id,
                person.createdAt,
              );
            },
            putBinding: (receipt) => {
              const key = identityKey(receipt.binding.identity);
              this.storage.sql.exec(
                "INSERT INTO person_bindings (identity_key, body) VALUES (?, ?) ON CONFLICT(identity_key) DO UPDATE SET body = excluded.body",
                key,
                JSON.stringify(receipt.binding),
              );
              this.storage.sql.exec(
                "INSERT INTO person_binding_receipts (identity_key, revision, body) VALUES (?, ?, ?)",
                key,
                receipt.binding.revision,
                JSON.stringify(receipt),
              );
              this.onBindingChanged?.(receipt.binding);
            },
            putAudit: (audit) => {
              this.storage.sql.exec(
                "INSERT INTO person_link_outcomes (id, body) VALUES (?, ?)",
                audit.id,
                JSON.stringify(audit),
              );
            },
          },
          command,
          this.now(),
        ),
      );
    } catch {
      return { status: "unavailable" };
    }
  }
  private linkRow(table: "person_link_intents" | "person_link_outcomes", id: string): unknown {
    const rows = [...this.storage.sql.exec<{ body: string }>(`SELECT body FROM ${table} WHERE id = ?`, id)];
    return rows.length ? decode(rows[0].body) : undefined;
  }
  async receipts(identity: ExternalIdentity): Promise<ReceiptsResult> {
    const parsed = identitySchema.safeParse(identity);
    if (!parsed.success) return { status: "invalid" };
    try {
      const rows = [
        ...this.storage.sql.exec<{ body: string }>(
          "SELECT body FROM person_binding_receipts WHERE identity_key = ? ORDER BY revision",
          identityKey(parsed.data),
        ),
      ];
      return readReceipts(
        rows.map((row) => decode(row.body)),
        parsed.data,
      );
    } catch {
      return { status: "unavailable" };
    }
  }
  private noticeRows(query: NoticeQuery = {}) {
    const where: string[] = [],
      values: (string | number)[] = [];
    if (query.organization) {
      where.push("json_extract(body, '$.organization') = ?");
      values.push(query.organization);
    }
    if (query.actor) {
      where.push("json_extract(body, '$.actor') = ?");
      values.push(JSON.stringify(query.actor));
    }
    if (query.recipient) {
      where.push("json_extract(body, '$.identity') = ?");
      values.push(JSON.stringify(query.recipient));
    }
    if (query.id) {
      where.push("id = ?");
      values.push(query.id);
    }
    if (query.slack)
      where.push(
        "json_extract(body, '$.identity.issuer') = 'https://slack.com' AND json_extract(body, '$.identity.tenant') IS NOT NULL",
      );
    if (query.pending) where.push("json_extract(body, '$.deliveredAt') IS NULL");
    const sql = `SELECT body FROM person_identity_notices${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${query.retryOrder ? "COALESCE(json_extract(body, '$.attempts'), 0), COALESCE(json_extract(body, '$.attemptedAt'), 0), rowid" : "rowid"}${query.limit ? " LIMIT ?" : ""}`;
    if (query.limit) values.push(query.limit);
    return [...this.storage.sql.exec<{ body: string }>(sql, ...values)].map((row) => decode(row.body));
  }
  private async notice(command: NoticeCommand): Promise<NoticeResult> {
    try {
      return this.storage.transactionSync(() =>
        executeNotices(
          {
            notices: (query) => this.noticeRows(query),
            putNotice: (notice) => {
              this.storage.sql.exec(
                "UPDATE person_identity_notices SET body = ? WHERE id = ?",
                JSON.stringify(notice),
                notice.id,
              );
            },
          },
          command,
          this.now(),
        ),
      );
    } catch {
      return { status: "unavailable" };
    }
  }
  pendingNotices(organization: string, limit: number) {
    return this.notice({ action: "pending", organization, limit });
  }
  markNoticeAttempted(organization: string, id: string) {
    return this.notice({ action: "attempted", organization, id });
  }
  markNoticeDelivered(organization: string, id: string) {
    return this.notice({ action: "delivered", organization, id });
  }
}
