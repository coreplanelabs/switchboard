import { identityKey, readBinding, resolution } from "../identity/engine.js";
import { SqlitePersonDirectory, type DirectorySqlStorage } from "../identity/sqlite.js";
import { bindingSchema, type PersonDirectory } from "../identity/contract.js";
import { executeOrganization, type OrganizationRows } from "./engine.js";
import type { OrganizationCommand, OrganizationResult, OrganizationStore } from "./contract.js";

function decode(body: string): unknown {
  return JSON.parse(body);
}
/** One authoritative SQLite database owns bindings and organization rows. */
export class SqliteOrganizationStore implements OrganizationStore {
  readonly directory: PersonDirectory;
  constructor(
    private readonly storage: DirectorySqlStorage,
    private readonly now: () => number,
  ) {
    this.directory = new SqlitePersonDirectory(storage, now);
    storage.transactionSync(() => {
      storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS organization_rows (organization TEXT NOT NULL, kind TEXT NOT NULL, row_key TEXT NOT NULL, partition_key TEXT NOT NULL, ordinal INTEGER NOT NULL, expires_at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (organization, kind, row_key))",
      );
      storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS organization_stream_order ON organization_rows (organization, kind, partition_key, ordinal)",
      );
      storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS organization_stream_receipt ON organization_rows (organization, kind, json_extract(body, '$.receiptId'))",
      );
      storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS organization_person_binding ON person_bindings (json_extract(body, '$.personId'))",
      );
      storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS organization_row_expiry ON organization_rows (organization, kind, expires_at)",
      );
    });
  }
  async execute(command: OrganizationCommand): Promise<OrganizationResult> {
    try {
      return this.storage.transactionSync(() => {
        const rows: OrganizationRows = {
          get: (kind, org, key) => {
            const row = [
              ...this.storage.sql.exec<{ body: string }>(
                "SELECT body FROM organization_rows WHERE organization = ? AND kind = ? AND row_key = ?",
                org,
                kind,
                key,
              ),
            ][0];
            return row ? decode(row.body) : undefined;
          },
          put: (kind, org, key, value, partition = "", ordinal = 0, expiry = Number.MAX_SAFE_INTEGER) => {
            this.storage.sql.exec(
              "INSERT INTO organization_rows (organization, kind, row_key, partition_key, ordinal, expires_at, body) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (organization, kind, row_key) DO UPDATE SET partition_key = excluded.partition_key, ordinal = excluded.ordinal, expires_at = excluded.expires_at, body = excluded.body",
              org,
              kind,
              key,
              partition,
              ordinal,
              expiry,
              JSON.stringify(value),
            );
          },
          remove: (kind, org, key) => {
            this.storage.sql.exec(
              "DELETE FROM organization_rows WHERE organization = ? AND kind = ? AND row_key = ?",
              org,
              kind,
              key,
            );
          },
          list: (kind, org, options = {}) => {
            let query = "SELECT body FROM organization_rows WHERE organization = ? AND kind = ?";
            const params: (string | number | null)[] = [org, kind];
            if (options.partition !== undefined) {
              query += " AND partition_key = ?";
              params.push(options.partition);
            }
            if (options.after !== undefined) {
              query += " AND ordinal > ?";
              params.push(options.after);
            }
            if (options.receiptId !== undefined) {
              query += " AND json_extract(body, '$.receiptId') = ?";
              params.push(options.receiptId);
            }
            if (options.expiresBefore !== undefined) {
              query += " AND expires_at <= ?";
              params.push(options.expiresBefore);
            }
            query += " ORDER BY ordinal";
            if (options.limit !== undefined) {
              query += " LIMIT ?";
              params.push(options.limit);
            }
            return [...this.storage.sql.exec<{ body: string }>(query, ...params)].map((row) => decode(row.body));
          },
          identities: (personId) =>
            [
              ...this.storage.sql.exec<{ body: string }>(
                "SELECT body FROM person_bindings WHERE json_extract(body, '$.personId') = ?",
                personId,
              ),
            ]
              .map((row) => bindingSchema.parse(decode(row.body)))
              .filter((binding) => binding.state === "active" && binding.personId === personId)
              .map((binding) => binding.identity),
          binding: (identity) => {
            const row = [
              ...this.storage.sql.exec<{ body: string }>(
                "SELECT body FROM person_bindings WHERE identity_key = ?",
                identityKey(identity),
              ),
            ][0];
            return resolution(
              readBinding(
                row ? decode(row.body) : undefined,
                identity,
                (id) => [...this.storage.sql.exec("SELECT id FROM directory_people WHERE id = ?", id)].length === 1,
              ),
            );
          },
        };
        return executeOrganization(rows, command, this.now());
      });
    } catch {
      return { status: "unavailable" };
    }
  }
}
