import { isConfigPublicationSnapshotKey } from "../../src/configPublicationProtocol.js";
import { stateSchema } from "../../src/core/organization/contract.js";

import type { SettingsKind, SettingsSnapshot } from "../../src/deploy/installationSettings.js";
export type { SettingsKind, SettingsSnapshot } from "../../src/deploy/installationSettings.js";
type Row = Record<string, string | number | null>;

const columns = {
  documents: ["key", "version", "body", "updated_at"],
  secrets: ["server_id", "sealed"],
  personal_tokens: ["digest", "subject", "email", "user_id", "approval", "created_at"],
  directory_people: ["id", "created_at"],
  person_bindings: ["identity_key", "body"],
  person_binding_receipts: ["identity_key", "revision", "body"],
  organization_rows: ["organization", "kind", "row_key", "partition_key", "ordinal", "expires_at", "body"],
} as const;
const retained = {
  config: ["documents", "secrets", "personal_tokens"],
  organization: ["directory_people", "person_bindings", "person_binding_receipts", "organization_rows"],
} as const;
const allTables = {
  config: [...retained.config, "tickets", "confirmations"],
  organization: [...retained.organization, "person_link_intents", "person_link_outcomes", "person_identity_notices"],
};
const accessKinds = [
  "state",
  "binding-cutoff",
  "revoked-source",
  "source-delete",
  "source-policy",
  "source-policy-index",
];
const lockTable = "installation_reset";

export function resetSettingsStatus(storage: DurableObjectStorage): { operation: string; phase: string } | null {
  const exists = storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", lockTable).toArray();
  if (!exists.length) return null;
  return (
    storage.sql
      .exec<{ operation: string; phase: string }>(`SELECT operation, phase FROM ${lockTable} WHERE id = 1`)
      .toArray()[0] ?? null
  );
}

function activeEpisodeId(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("episode" in body)) return;
  const episode = body.episode;
  if (
    !episode ||
    typeof episode !== "object" ||
    !("phase" in episode) ||
    episode.phase !== "active" ||
    !("scopes" in episode) ||
    !Array.isArray(episode.scopes) ||
    episode.scopes.length !== 1 ||
    episode.scopes[0] !== "all" ||
    !("id" in episode) ||
    typeof episode.id !== "string"
  )
    return;
  return episode.id;
}

export function resetConfigWriteAllowed(storage: DurableObjectStorage, key: string, document: unknown) {
  const reset = resetSettingsStatus(storage);
  if (reset?.phase === "frozen") return false;
  if (reset?.phase !== "restoring" || key !== "maintenance") return true;
  const row = storage.sql.exec<{ body: string }>("SELECT body FROM documents WHERE key = 'maintenance'").toArray()[0];
  return !!row && !!activeEpisodeId(document) && activeEpisodeId(document) === activeEpisodeId(JSON.parse(row.body));
}

function publicationKey(key: unknown) {
  return (
    typeof key === "string" &&
    (key === "base" || /^base-[a-f0-9]{40}$/.test(key) || isConfigPublicationSnapshotKey(key))
  );
}
function checkedRows(kind: SettingsKind, tables: Record<string, Row[]>): Record<string, Row[]> {
  const expected = retained[kind];
  if (Object.keys(tables).length !== expected.length || expected.some((table) => !Array.isArray(tables[table])))
    throw new Error("reset settings table roster differs");
  for (const table of expected) {
    const names = columns[table];
    for (const row of tables[table]) {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).length !== names.length ||
        names.some((name) => !Object.hasOwn(row, name)) ||
        Object.values(row).some(
          (value) =>
            value !== null && typeof value !== "string" && (typeof value !== "number" || !Number.isSafeInteger(value)),
        )
      )
        throw new Error("reset settings row differs");
      if (table === "documents" && publicationKey(row.key))
        throw new Error("reset settings include publication history");
      if (table === "organization_rows" && !accessKinds.includes(String(row.kind)))
        throw new Error("reset settings include organization history");
    }
  }
  if (new TextEncoder().encode(JSON.stringify(tables)).length > 2 * 1024 * 1024)
    throw new Error("reset settings exceed the transfer limit");
  return tables;
}

/** Keep access and settings only. History and pending actions do not cross the reset. */
export function readResetSettings(storage: DurableObjectStorage, kind: SettingsKind): SettingsSnapshot {
  const known = new Set([...allTables[kind], lockTable, "__cf_kv"]);
  for (const row of storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table'")) {
    if (!known.has(row.name) && !row.name.startsWith("sqlite_"))
      throw new Error("reset settings schema is unrecognized");
  }
  const tables: Record<string, Row[]> = {};
  for (const table of retained[kind]) {
    const names = columns[table];
    const actual = storage.sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .map((column) => column.name)
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify([...names].sort()))
      throw new Error("reset settings columns are unrecognized");
    tables[table] = storage.sql
      .exec<Row>(`SELECT ${names.join(", ")} FROM ${table} ORDER BY ${names.join(", ")}`)
      .toArray();
    if (table === "documents") tables[table] = tables[table].filter((row) => !publicationKey(row.key));
    if (table === "organization_rows") {
      tables[table] = tables[table]
        .filter((row) => accessKinds.includes(String(row.kind)))
        .flatMap((row) => {
          if (row.kind !== "state") return [row];
          const state = stateSchema.parse(JSON.parse(String(row.body)));
          if (state.organization !== row.organization || state.orchestrator !== `organization:${state.organization}`)
            throw new Error("reset organization state is unrecognized");
          // Claims, completions and startup can create or revise an otherwise
          // empty state. Access revisions and stream cutoffs remain settings.
          if (state.accessRevision === 0 && state.sourcePolicyRevision === 0 && state.streamSequence === 0) return [];
          return [
            {
              ...row,
              body: JSON.stringify({
                ...state,
                revision: 0,
                wakeSequence: 0,
                reconciledSequence: 0,
                laneCursor: null,
                lease: null,
              }),
            },
          ];
        });
    }
  }
  return { schema: 1, kind, tables: checkedRows(kind, tables) };
}

function resetRecord(storage: DurableObjectStorage) {
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS ${lockTable} (id INTEGER PRIMARY KEY CHECK (id = 1), operation TEXT NOT NULL, phase TEXT NOT NULL)`,
  );
  return storage.sql
    .exec<{ operation: string; phase: string }>(`SELECT operation, phase FROM ${lockTable} WHERE id = 1`)
    .toArray()[0];
}

/** SQL triggers also fence a request which resumed after the freeze. */
export function freezeResetSettings(
  storage: DurableObjectStorage,
  kind: SettingsKind,
  operation: string,
): SettingsSnapshot {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operation)) throw new Error("invalid reset operation");
  return storage.transactionSync(() => {
    if (kind === "config") {
      const row = storage.sql
        .exec<{ body: string }>("SELECT body FROM documents WHERE key = 'maintenance'")
        .toArray()[0];
      const episode = row ? JSON.parse(row.body).episode : undefined;
      if (episode?.phase !== "active" || episode.scopes?.length !== 1 || episode.scopes[0] !== "all")
        throw new Error("reset requires active all-scope maintenance");
    }
    const current = resetRecord(storage);
    if (current && current.phase !== "verified" && (current.operation !== operation || current.phase !== "frozen"))
      throw new Error("another reset owns the settings");
    if (current?.phase === "verified" && current.operation === operation)
      throw new Error("reset operation already completed");
    storage.sql.exec(
      `INSERT INTO ${lockTable} (id, operation, phase) VALUES (1, ?, 'frozen')
      ON CONFLICT (id) DO UPDATE SET operation = excluded.operation, phase = excluded.phase`,
      operation,
    );
    for (const table of allTables[kind])
      for (const action of ["INSERT", "UPDATE", "DELETE"]) {
        storage.sql.exec(
          `CREATE TRIGGER IF NOT EXISTS reset_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT, 'settings frozen for installation reset'); END`,
        );
      }
    return readResetSettings(storage, kind);
  });
}

/** Only an empty target accepts settings, once, before the Bot is created. */
export function restoreResetSettings(
  storage: DurableObjectStorage,
  snapshot: SettingsSnapshot,
  operation: string,
): SettingsSnapshot {
  if (snapshot.schema !== 1 || !["config", "organization"].includes(snapshot.kind))
    throw new Error("invalid reset settings");
  const tables = checkedRows(snapshot.kind, snapshot.tables);
  return storage.transactionSync(() => {
    if (
      resetRecord(storage) ||
      allTables[snapshot.kind].some(
        (table) => storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n !== 0,
      )
    )
      throw new Error("reset settings target is not empty");
    if (snapshot.kind === "config") {
      const maintenance = tables.documents.find((row) => row.key === "maintenance");
      if (!maintenance || !activeEpisodeId(JSON.parse(String(maintenance.body))))
        throw new Error("restored reset settings must keep maintenance closed");
    }
    for (const table of retained[snapshot.kind]) {
      const names = columns[table];
      for (const row of tables[table])
        storage.sql.exec(
          `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
          ...names.map((name) => row[name]),
        );
    }
    storage.sql.exec(`INSERT INTO ${lockTable} (id, operation, phase) VALUES (1, ?, 'restoring')`, operation);
    if (snapshot.kind === "config")
      for (const action of ["INSERT", "UPDATE"])
        storage.sql.exec(`
      CREATE TRIGGER reset_maintenance_end_${action} BEFORE ${action} ON documents
      WHEN NEW.key = 'maintenance' AND EXISTS (SELECT 1 FROM ${lockTable} WHERE phase != 'verified')
        AND (json_extract(NEW.body, '$.episode.phase') IS NOT 'active'
          OR json_extract(NEW.body, '$.episode.scopes') IS NOT '["all"]'
          OR json_extract(NEW.body, '$.episode.id') IS NOT
            (SELECT json_extract(body, '$.episode.id') FROM documents WHERE key = 'maintenance'))
      BEGIN SELECT RAISE(ABORT, 'installation reset is not verified'); END
    `);
    return readResetSettings(storage, snapshot.kind);
  });
}

export function verifyResetSettings(storage: DurableObjectStorage, operation: string) {
  const current = resetRecord(storage);
  if (current?.operation !== operation || current.phase !== "restoring")
    throw new Error("reset restoration is not current");
  storage.sql.exec(`UPDATE ${lockTable} SET phase = 'verified' WHERE id = 1`);
  return { operation, phase: "verified" as const };
}
