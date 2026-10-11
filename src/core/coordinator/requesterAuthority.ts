/** Private, typed authority for a requester's admitted turn. The model and
 * session log may quote a message but cannot create or change this record. */
export interface RequesterTurnInput {
  threadKey: string;
  requesterId: string;
  messageId: string;
  /** A single repository addressed by a question in this verified turn. */
  questionTarget?: string;
}

export interface RequesterTurn extends RequesterTurnInput {
  revision: number;
  /** Only the immediately preceding verified turn may supply `fix it`'s target. */
  priorQuestionTarget?: string;
}

export interface RequesterKey {
  threadKey: string;
  requesterId: string;
}

export interface MainTaskAuthority {
  requesterId: string;
  sourceMessageId: string;
  revision: number;
  repo: string;
}

export type RecordRequesterTurnResult =
  { ok: true; turn: RequesterTurn } | { ok: false; reason: "conflict" | "unavailable" };

const SLACK_MESSAGE_ID = /^\d{1,20}(?:\.\d{1,6})?$/;
const BROWSER_MESSAGE_ID = /^browser:([1-9]\d{0,15}):[!-~]{1,2048}$/;
const namespaced = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9_-]*:\S{1,500}$/.test(value);
/** A protected store lookup is identity-neutral; it never proves a sender or grants. */
export function isRequesterKey(value: unknown): value is RequesterKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const key = value as Partial<RequesterKey>;
  return namespaced(key.threadKey) && namespaced(key.requesterId);
}
const browserSequence = (value: string): number | undefined => {
  const match = BROWSER_MESSAGE_ID.exec(value);
  const sequence = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : undefined;
};
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isRequesterTurnInput(value: unknown): value is RequesterTurnInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Partial<RequesterTurnInput>;
  return (
    typeof v.threadKey === "string" &&
    (/^slack:[CDG][A-Za-z0-9]+:\d+(?:\.\d+)?$/.test(v.threadKey) ||
      (namespaced(v.threadKey) && typeof v.messageId === "string" && browserSequence(v.messageId) !== undefined)) &&
    typeof v.requesterId === "string" &&
    (/^slack:[UW][A-Za-z0-9]+$/.test(v.requesterId) ||
      (namespaced(v.requesterId) && typeof v.messageId === "string" && browserSequence(v.messageId) !== undefined)) &&
    typeof v.messageId === "string" &&
    (SLACK_MESSAGE_ID.test(v.messageId) || browserSequence(v.messageId) !== undefined) &&
    (v.questionTarget === undefined || (typeof v.questionTarget === "string" && REPO.test(v.questionTarget)))
  );
}

export function isMainTaskAuthority(value: unknown): value is MainTaskAuthority {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Partial<MainTaskAuthority>;
  return (
    typeof v.requesterId === "string" &&
    (/^slack:[UW][A-Za-z0-9]+$/.test(v.requesterId) ||
      (namespaced(v.requesterId) &&
        typeof v.sourceMessageId === "string" &&
        browserSequence(v.sourceMessageId) !== undefined)) &&
    typeof v.sourceMessageId === "string" &&
    (SLACK_MESSAGE_ID.test(v.sourceMessageId) || browserSequence(v.sourceMessageId) !== undefined) &&
    typeof v.revision === "number" &&
    Number.isSafeInteger(v.revision) &&
    v.revision > 0 &&
    typeof v.repo === "string" &&
    REPO.test(v.repo)
  );
}

export function sameMainTaskAuthority(a: MainTaskAuthority | undefined, b: MainTaskAuthority): boolean {
  return (
    a !== undefined &&
    a.requesterId === b.requesterId &&
    a.sourceMessageId === b.sourceMessageId &&
    a.revision === b.revision &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

/** Compare native Slack timestamps or server-ordered browser tokens without losing precision. */
export function compareSlackMessageId(a: string, b: string): number {
  const leftBrowser = browserSequence(a),
    rightBrowser = browserSequence(b);
  if (leftBrowser !== undefined || rightBrowser !== undefined) {
    if (leftBrowser === undefined || rightBrowser === undefined) throw new Error("Mismatched requester source order");
    return leftBrowser < rightBrowser ? -1 : leftBrowser > rightBrowser ? 1 : 0;
  }
  const order = (id: string) => {
    const [seconds, fraction = ""] = id.split(".");
    return BigInt(seconds!) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0");
  };
  const left = order(a);
  const right = order(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
