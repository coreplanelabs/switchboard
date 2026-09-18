import type { LinearStorage } from "./store.js";

export interface LinearChildIntent {
  organizationId: string;
  appUserId: string;
  parentSessionId: string;
  requesterId: string;
  issueId: string;
  commentId: string;
  lead: string;
}
export interface LinearChildRecord extends LinearChildIntent {
  sessionStarted?: true;
  session?: { id: string; url?: string };
}

/** The intent precedes either external write; an uncertain session create is
 * reconciled by reading the comment, never by repeating that mutation. */
export interface LinearChildStore {
  ensure(intent: LinearChildIntent): Promise<LinearChildRecord>;
  get(organizationId: string, commentId: string): Promise<LinearChildRecord | undefined>;
  beginSession(organizationId: string, commentId: string): Promise<boolean>;
  finish(organizationId: string, commentId: string, session: NonNullable<LinearChildRecord["session"]>): Promise<void>;
}

const keyOf = (org: string, comment: string) => `child:${JSON.stringify([org, comment])}`;
function matching(current: LinearChildRecord | undefined, intent: LinearChildIntent): LinearChildRecord {
  if (
    current &&
    Object.keys(intent).some(
      (key) => current[key as keyof LinearChildIntent] !== intent[key as keyof LinearChildIntent],
    )
  )
    throw new Error("linear_child_conflict");
  return current ?? { ...intent };
}
function completed(
  current: LinearChildRecord | undefined,
  session: NonNullable<LinearChildRecord["session"]>,
): LinearChildRecord {
  if (!current?.sessionStarted) throw new Error("linear_child_not_started");
  if (current.session && current.session.id !== session.id) throw new Error("linear_child_conflict");
  return { ...current, session };
}

export class StoredLinearChildStore implements LinearChildStore {
  constructor(private readonly storage: LinearStorage) {}
  ensure(intent: LinearChildIntent): Promise<LinearChildRecord> {
    return this.storage.transaction(async (tx) => {
      const key = keyOf(intent.organizationId, intent.commentId);
      const current = await tx.get<LinearChildRecord>(key);
      const record = matching(current, intent);
      if (!current) await tx.put(key, record);
      return record;
    });
  }
  get(org: string, comment: string): Promise<LinearChildRecord | undefined> {
    return this.storage.get(keyOf(org, comment));
  }
  beginSession(org: string, comment: string): Promise<boolean> {
    return this.storage.transaction(async (tx) => {
      const key = keyOf(org, comment),
        current = await tx.get<LinearChildRecord>(key);
      if (!current || current.sessionStarted) return false;
      await tx.put(key, { ...current, sessionStarted: true });
      return true;
    });
  }
  async finish(org: string, comment: string, session: NonNullable<LinearChildRecord["session"]>): Promise<void> {
    await this.storage.transaction(async (tx) => {
      const key = keyOf(org, comment);
      await tx.put(key, completed(await tx.get<LinearChildRecord>(key), session));
    });
  }
}

export class InMemoryLinearChildStore implements LinearChildStore {
  private readonly records = new Map<string, LinearChildRecord>();
  async ensure(intent: LinearChildIntent): Promise<LinearChildRecord> {
    const key = keyOf(intent.organizationId, intent.commentId);
    const record = matching(this.records.get(key), intent);
    this.records.set(key, structuredClone(record));
    return structuredClone(record);
  }
  async get(org: string, comment: string): Promise<LinearChildRecord | undefined> {
    return structuredClone(this.records.get(keyOf(org, comment)));
  }
  async beginSession(org: string, comment: string): Promise<boolean> {
    const current = this.records.get(keyOf(org, comment));
    if (!current || current.sessionStarted) return false;
    current.sessionStarted = true;
    return true;
  }
  async finish(org: string, comment: string, session: NonNullable<LinearChildRecord["session"]>): Promise<void> {
    const key = keyOf(org, comment);
    this.records.set(key, structuredClone(completed(this.records.get(key), session)));
  }
}
