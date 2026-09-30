/** Private, typed authority for a requester's Slack turn. The model and
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
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isRequesterTurnInput(value: unknown): value is RequesterTurnInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Partial<RequesterTurnInput>;
  return (
    typeof v.threadKey === "string" &&
    /^slack:[CDG][A-Za-z0-9]+:\d+(?:\.\d+)?$/.test(v.threadKey) &&
    typeof v.requesterId === "string" &&
    /^slack:[UW][A-Za-z0-9]+$/.test(v.requesterId) &&
    typeof v.messageId === "string" &&
    SLACK_MESSAGE_ID.test(v.messageId) &&
    (v.questionTarget === undefined || (typeof v.questionTarget === "string" && REPO.test(v.questionTarget)))
  );
}

export function isMainTaskAuthority(value: unknown): value is MainTaskAuthority {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Partial<MainTaskAuthority>;
  return (
    typeof v.requesterId === "string" &&
    /^slack:[UW][A-Za-z0-9]+$/.test(v.requesterId) &&
    typeof v.sourceMessageId === "string" &&
    SLACK_MESSAGE_ID.test(v.sourceMessageId) &&
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

/** Compare Slack timestamps without lossy floating-point conversion. */
export function compareSlackMessageId(a: string, b: string): number {
  const order = (id: string) => {
    const [seconds, fraction = ""] = id.split(".");
    return BigInt(seconds!) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0");
  };
  const left = order(a);
  const right = order(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
