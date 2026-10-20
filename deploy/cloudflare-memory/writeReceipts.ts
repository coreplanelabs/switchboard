import {
  WRITE_RECEIPT_BYTES,
  WRITE_RECEIPT_LIMIT,
  storedWriteReceiptSchema,
  sameWriteReceipt,
  type StoredWriteReceipt,
  type WriteReceiptSelector,
} from "../../src/core/runLedger/writeReceipt.js";

/** All callers own the effect transaction. This helper never opens another one. */
export class WriteReceipts {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS original_write_receipts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE NOT NULL, run_id TEXT NOT NULL,
      json TEXT NOT NULL CHECK(length(CAST(json AS BLOB)) <= 4096)
    ); CREATE INDEX IF NOT EXISTS original_write_receipts_run ON original_write_receipts(run_id);`);
  }
  seen(requestId: string): boolean {
    return this.sql.exec("SELECT seq FROM original_write_receipts WHERE request_id=?", requestId).toArray().length > 0;
  }
  save(record: StoredWriteReceipt): void {
    const checked = storedWriteReceiptSchema.parse(record);
    const json = JSON.stringify(checked);
    if (new TextEncoder().encode(json).byteLength > WRITE_RECEIPT_BYTES)
      throw new Error("Write receipt exceeds its byte limit");
    this.sql.exec(
      "INSERT INTO original_write_receipts(request_id,run_id,json) VALUES(?,?,?)",
      checked.requestId,
      checked.runId,
      json,
    );
    this.sql.exec(
      "DELETE FROM original_write_receipts WHERE seq NOT IN (SELECT seq FROM original_write_receipts ORDER BY seq DESC LIMIT ?)",
      WRITE_RECEIPT_LIMIT,
    );
  }
  read(selector: WriteReceiptSelector): StoredWriteReceipt | "corrupt" | undefined {
    const row = this.sql
      .exec<{ json: string | null }>(
        "SELECT CASE WHEN length(CAST(json AS BLOB))<=? AND json_valid(json) THEN json END AS json FROM original_write_receipts WHERE request_id=?",
        WRITE_RECEIPT_BYTES,
        selector.requestId,
      )
      .toArray()[0];
    if (!row) return;
    const parsed = row.json === null ? undefined : storedWriteReceiptSchema.safeParse(JSON.parse(row.json));
    if (!parsed?.success) return "corrupt";
    return sameWriteReceipt(parsed.data, selector) ? parsed.data : undefined;
  }
  remove(runId: string): void {
    this.sql.exec("DELETE FROM original_write_receipts WHERE run_id=?", runId);
  }
}
