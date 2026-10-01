/** A PR identity selected by the operator, with the requester's own words
 *  retained as evidence for the deterministic target gate. */
export interface PrTargetEvidence {
  number: number;
  source: "request" | "thread";
  quote: string;
}

interface QuotedPr {
  repo?: string;
  number: number;
}

function positiveNumber(text: string): number | undefined {
  if (text.length === 0) return undefined;
  for (const char of text) if (char < "0" || char > "9") return undefined;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/** Parse only the short span the operator claimed, never a whole chat turn. */
function quotedPr(text: string): QuotedPr | undefined {
  if (text.startsWith("https://") || text.startsWith("http://")) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return undefined;
    }
    const path = url.pathname.split("/").filter(Boolean);
    const number = path.length === 4 && path[2] === "pull" ? positiveNumber(path[3]!) : undefined;
    if (url.hostname !== "github.com" || url.username || url.password || number === undefined) return undefined;
    return { repo: `${path[0]}/${path[1]}`.toLowerCase(), number };
  }
  const hash = text.lastIndexOf("#");
  if (hash < 0) return undefined;
  const number = positiveNumber(text.slice(hash + 1));
  if (number === undefined) return undefined;
  const prefix = text.slice(0, hash);
  if (prefix === "" || prefix.toLowerCase() === "pr ") return { number };
  const parts = prefix.split("/");
  return parts.length === 2 && parts.every(Boolean) ? { repo: prefix.toLowerCase(), number } : undefined;
}

function tokenContinuation(char: string | undefined, next?: string): boolean {
  return (
    char !== undefined &&
    ((char >= "0" && char <= "9") ||
      (char >= "A" && char <= "Z") ||
      (char >= "a" && char <= "z") ||
      "/?#_-:%".includes(char) ||
      (char === "." &&
        next !== undefined &&
        ((next >= "0" && next <= "9") || (next >= "A" && next <= "Z") || (next >= "a" && next <= "z"))))
  );
}

function completeSpan(text: string, quote: string): boolean {
  let at = text.indexOf(quote);
  while (at >= 0) {
    if (
      !tokenContinuation(text[at - 1], text[at]) &&
      !tokenContinuation(text[at + quote.length], text[at + quote.length + 1])
    )
      return true;
    at = text.indexOf(quote, at + 1);
  }
  return false;
}

/** A model's target is usable only when the same actor authored the complete
 *  quoted identity and it resolves to the same PR and repository. */
export function verifyPrTargetEvidence(
  raw: unknown,
  context: {
    requestText: string;
    requesterId?: string;
    tail?: readonly { actor?: string; text: string }[];
    repo?: string;
  },
): PrTargetEvidence | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.number !== "number" ||
    !Number.isSafeInteger(value.number) ||
    value.number <= 0 ||
    (value.source !== "request" && value.source !== "thread") ||
    typeof value.quote !== "string" ||
    value.quote.length === 0 ||
    value.quote.length > 512 ||
    value.quote.trim() !== value.quote
  )
    return undefined;
  const quote = value.quote;
  const authored =
    value.source === "request"
      ? completeSpan(context.requestText, quote)
      : context.requesterId !== undefined &&
        context.tail?.some((turn) => turn.actor === context.requesterId && completeSpan(turn.text, quote)) === true;
  if (!authored) return undefined;
  const target = quotedPr(quote);
  if (target === undefined || target.number !== value.number) return undefined;
  if (target.repo !== undefined && context.repo?.toLowerCase() !== target.repo) return undefined;
  return { number: target.number, source: value.source, quote };
}
