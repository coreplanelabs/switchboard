import { parseSlug } from "./residentAdmin.js";
import type { BatchPullRequest } from "./prBatch.js";

/** A typed action and exact PR identities selected by the operator. The
 * authored spans are kept for audit; they do not act as another intent parser. */
export interface PrBatchBinding {
  kind: "review" | "ship";
  targets: ReadonlyArray<BatchPullRequest>;
  evidence?: { action: string; targets: ReadonlyArray<string> };
}

function pullRequestOf(raw: string): BatchPullRequest | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "github.com" && url.hostname !== "www.github.com") ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    return undefined;
  const path = url.pathname.split("/");
  if (path.at(-1) === "") path.pop();
  if (path.length !== 5 || path[0] !== "" || path[3] !== "pull") return undefined;
  const repo = parseSlug(`${path[1]}/${path[2]}`);
  const digits = path[4] ?? "";
  if (!repo || digits === "" || ![...digits].every((char) => char >= "0" && char <= "9")) return undefined;
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  return { repo, number, url: `https://github.com/${repo}/pull/${number}` };
}

function gap(char: string | undefined): boolean {
  return char === undefined || char === " " || char === "\t" || char === "\r" || char === "\n";
}

/** Check only the claimed URL span. Its immediate delimiters distinguish a
 * bare link or transport link destination from a suffix inside another URL. */
function authoredTargetSpan(request: string, span: string): boolean {
  if (span.length === 0 || span.length > 2048 || span.trim() !== span) return false;
  let at = request.indexOf(span);
  while (at >= 0) {
    const before = request[at - 1];
    const markup = before === "<" && (gap(request[at - 2]) || request[at - 2] === "•");
    const parenthesized =
      before === "(" && (request[at - 2] === "]" || gap(request[at - 2]) || request[at - 2] === "•");
    const bare = gap(before) || before === "•";
    const after = request[at + span.length];
    const terminal =
      gap(after) ||
      (markup && (after === "|" || after === ">")) ||
      (parenthesized && after === ")") ||
      ((after === "." || after === "," || after === ";") && gap(request[at + span.length + 1]));
    if ((markup || parenthesized || bare) && terminal) return true;
    at = request.indexOf(span, at + 1);
  }
  return false;
}

function actionNamed(quote: string, kind: "review" | "ship"): boolean {
  const lower = quote.toLowerCase();
  const wordChar = (char: string | undefined) =>
    char !== undefined && ((char >= "a" && char <= "z") || (char >= "0" && char <= "9"));
  let at = lower.indexOf(kind);
  while (at >= 0) {
    if (!wordChar(lower[at - 1]) && !wordChar(lower[at + kind.length])) return true;
    at = lower.indexOf(kind, at + 1);
  }
  return false;
}

/** The operator chooses the action and list. Code checks only that each
 * canonical target has complete requester-authored evidence, then child
 * launch holds every effect to this durable binding. */
export function prBatchBindingOf(input: unknown, request: string): { binding: PrBatchBinding } | { error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return { error: "a PR batch needs a typed action and target URLs" };
  const { kind, targets, actionQuote, targetQuotes } = input as Record<string, unknown>;
  if (kind !== "review" && kind !== "ship") return { error: "a PR batch action must be review or ship" };
  if (!Array.isArray(targets) || targets.length < 2 || targets.length > 32)
    return { error: "a PR batch needs 2 to 32 exact target URLs" };
  if (
    typeof actionQuote !== "string" ||
    actionQuote.length === 0 ||
    actionQuote.length > 2048 ||
    actionQuote.trim() !== actionQuote ||
    !request.includes(actionQuote) ||
    !actionNamed(actionQuote, kind)
  )
    return { error: "a PR batch action needs a complete authored span" };
  if (!Array.isArray(targetQuotes) || targetQuotes.length !== targets.length)
    return { error: "each PR batch target needs a complete authored span" };
  const selected: BatchPullRequest[] = [];
  const quotes: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < targets.length; index++) {
    const raw = targets[index];
    const quote = targetQuotes[index];
    const target = typeof raw === "string" ? pullRequestOf(raw) : undefined;
    const quoted = typeof quote === "string" ? pullRequestOf(quote) : undefined;
    if (!target || !quoted || target.url !== quoted.url || !authoredTargetSpan(request, quote))
      return { error: "a PR batch target must have its complete exact link in this request" };
    if (seen.has(target.url)) return { error: "a PR batch cannot repeat a target" };
    seen.add(target.url);
    selected.push(target);
    quotes.push(quote);
  }
  return { binding: { kind, targets: selected, evidence: { action: actionQuote, targets: quotes } } };
}
