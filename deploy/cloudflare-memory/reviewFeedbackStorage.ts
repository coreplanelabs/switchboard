import {
  reviewFeedbackPublicationOf,
  mergeFeedbackSnapshot,
  type ReviewFeedbackEntry,
  type ReviewFeedbackClaim,
  type ReviewFeedbackSnapshot,
} from "../../src/core/reviewFeedback.js";
import type { ReviewPublicationReceipt } from "../../src/core/reviewPublication.js";
import {
  REVIEW_FEEDBACK_RETAIN_MS,
  REVIEW_FEEDBACK_RECENT_MS,
  REVIEW_FEEDBACK_HOURLY_MS,
  REVIEW_FEEDBACK_DAILY_MS,
  REVIEW_FEEDBACK_LEASE_MS,
} from "../../src/core/budgets.js";
import { parseStoredJson } from "../../src/core/storedJson.js";

type Row = { run_id: string; receipt_json: string; snapshot_json: string | null; lease: number };

/** Compact journal retention is independent of run deletion. Snapshot writes never touch run state. */
export class ReviewFeedbackStorage {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS review_feedback_publications (
      run_id TEXT PRIMARY KEY, published_at INTEGER NOT NULL, receipt_json TEXT NOT NULL,
      snapshot_json TEXT, checked_at INTEGER NOT NULL DEFAULT 0,
      lease INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS review_feedback_published ON review_feedback_publications(published_at);
    CREATE UNIQUE INDEX IF NOT EXISTS review_feedback_native ON review_feedback_publications(
      lower(json_extract(receipt_json,'$.target.repo')), json_extract(receipt_json,'$.nativeReview.id')
    ) WHERE json_extract(receipt_json,'$.nativeReview.id') IS NOT NULL;
    CREATE TABLE IF NOT EXISTS review_feedback_control (key TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
  }
  /** Called only inside the existing fenced acceptance transaction. */
  retain(receipt: ReviewPublicationReceipt): void {
    const publication = reviewFeedbackPublicationOf(receipt);
    if (!publication) return;
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO review_feedback_publications (run_id,published_at,receipt_json) VALUES (?,?,?)",
      receipt.runId,
      publication.publishedAt,
      JSON.stringify(receipt),
    );
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO review_feedback_control (key,value) VALUES ('collection_started_at',?)",
      receipt.feedback!.at,
    );
  }
  private entry(row: Row): ReviewFeedbackEntry {
    const publication = reviewFeedbackPublicationOf(parseStoredJson(row.receipt_json));
    if (!publication) throw new Error("Invalid retained review publication");
    return {
      publication,
      ...(row.snapshot_json ? { snapshot: parseStoredJson(row.snapshot_json) as ReviewFeedbackSnapshot } : {}),
    };
  }
  list(
    sinceMs: number,
    untilMs: number,
    now: number,
    after = "",
  ): { entries: ReviewFeedbackEntry[]; nextCursor?: string; collectionStartedAt?: number } {
    const rows = this.storage.sql
      .exec<Row>(
        "SELECT run_id, receipt_json, snapshot_json, lease FROM review_feedback_publications WHERE published_at>=? AND published_at<? AND run_id>? ORDER BY run_id LIMIT 201",
        Math.max(sinceMs, now - REVIEW_FEEDBACK_RETAIN_MS),
        untilMs,
        after,
      )
      .toArray();
    const page = rows.slice(0, 200);
    const collectionStartedAt = this.storage.sql
      .exec<{ value: number }>("SELECT value FROM review_feedback_control WHERE key='collection_started_at'")
      .toArray()[0]?.value;
    return {
      entries: page.map((row) => this.entry(row)),
      ...(collectionStartedAt ? { collectionStartedAt } : {}),
      ...(rows.length > 200 ? { nextCursor: page.at(-1)!.run_id } : {}),
    };
  }
  claim(now: number, limit: number): ReviewFeedbackClaim[] {
    return this.storage.transactionSync(() => {
      const blocked =
        this.storage.sql
          .exec<{ value: number }>("SELECT value FROM review_feedback_control WHERE key='blocked_until'")
          .toArray()[0]?.value ?? 0;
      if (blocked > now) return [];
      const rows = this.storage.sql
        .exec<Row>(
          `SELECT run_id, receipt_json, snapshot_json, lease FROM review_feedback_publications
        WHERE published_at>=? AND lease_until<=? AND
        (checked_at=0 OR checked_at<=? - CASE WHEN published_at>=? THEN ? ELSE ? END)
        ORDER BY checked_at, run_id LIMIT ?`,
          now - REVIEW_FEEDBACK_RETAIN_MS,
          now,
          now,
          now - REVIEW_FEEDBACK_RECENT_MS,
          REVIEW_FEEDBACK_HOURLY_MS,
          REVIEW_FEEDBACK_DAILY_MS,
          limit,
        )
        .toArray();
      return rows.map((row) => {
        this.storage.sql.exec(
          "UPDATE review_feedback_publications SET lease=lease+1,lease_until=? WHERE run_id=?",
          now + REVIEW_FEEDBACK_LEASE_MS,
          row.run_id,
        );
        return { publication: this.entry(row).publication, lease: row.lease + 1 };
      });
    });
  }
  complete(runId: string, lease: number, update: ReviewFeedbackSnapshot, now: number): boolean {
    return this.storage.transactionSync(() => {
      const row = this.storage.sql
        .exec<Row>(
          "SELECT run_id,receipt_json,snapshot_json,lease FROM review_feedback_publications WHERE run_id=? AND lease=? AND lease_until>?",
          runId,
          lease,
          now,
        )
        .toArray()[0];
      if (!row) return false;
      const previous = this.entry(row).snapshot;
      const snapshot = mergeFeedbackSnapshot(previous, { ...update, checkedAt: now });
      this.storage.sql.exec(
        "UPDATE review_feedback_publications SET snapshot_json=?,checked_at=?,lease_until=0 WHERE run_id=? AND lease=?",
        JSON.stringify(snapshot),
        now,
        runId,
        lease,
      );
      return true;
    });
  }
  cooldown(untilMs: number): void {
    this.storage.sql.exec(
      "INSERT INTO review_feedback_control (key,value) VALUES ('blocked_until',?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)",
      untilMs,
    );
  }
  /** Physical cleanup follows the existing maintenance gate; reads always enforce the reporting window. */
  prune(now: number): void {
    this.storage.sql.exec(
      "DELETE FROM review_feedback_publications WHERE run_id IN (SELECT run_id FROM review_feedback_publications WHERE published_at<? LIMIT 200)",
      now - REVIEW_FEEDBACK_RETAIN_MS,
    );
  }
}
