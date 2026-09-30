import { parseSlug } from "./residentAdmin.js";
import type { BatchPullRequest } from "./prBatch.js";

/** The operator's typed choice of exact PRs for one conductor request. */
export interface PrBatchBinding {
  kind: "review" | "ship";
  targets: ReadonlyArray<BatchPullRequest>;
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
    url.port !== ""
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

type RequestToken =
  | { kind: "word"; value: string }
  | { kind: "link"; target: BatchPullRequest; excluded?: true }
  | { kind: "separator" }
  | { kind: "boundary" };

const LABEL_EXCLUSIONS = new Set([
  "background",
  "context",
  "don't",
  "don’t",
  "dont",
  "exclude",
  "excluded",
  "instead",
  "never",
  "not",
  "reference",
  "skip",
]);

function excludedLabel(label: string): boolean {
  let word = "";
  for (const char of `${label.toLowerCase()} `) {
    if ((char >= "a" && char <= "z") || char === "'" || char === "’") word += char;
    else {
      if (LABEL_EXCLUSIONS.has(word)) return true;
      word = "";
    }
  }
  return false;
}

function urlSchemeLength(text: string, index: number): number {
  const first = text[index];
  if (!first || !((first >= "a" && first <= "z") || (first >= "A" && first <= "Z"))) return 0;
  let end = index + 1;
  while (end < text.length) {
    const char = text[end]!;
    if (!(
      (char >= "a" && char <= "z") ||
      (char >= "A" && char <= "Z") ||
      (char >= "0" && char <= "9") ||
      char === "+" ||
      char === "." ||
      char === "-"
    ))
      break;
    end++;
  }
  return text.startsWith("://", end) ? end + 3 - index : 0;
}

/** Only URL destinations become links. Consuming a whole foreign URL keeps a
 * GitHub-looking suffix after its pipe from becoming separate evidence. */
function requestTokens(text: string): RequestToken[] {
  const request = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
  const tokens: RequestToken[] = [];
  const add = (raw: string, label?: string) => {
    const target = pullRequestOf(raw);
    tokens.push(
      target
        ? { kind: "link", target, ...(label && excludedLabel(label) ? { excluded: true as const } : {}) }
        : { kind: "boundary" },
    );
  };
  let fenced = false;
  let inlineCode = false;
  let quoted = false;
  for (let index = 0; index < request.length;) {
    if (!quoted && request.startsWith("```", index)) {
      fenced = !fenced;
      index += 3;
      continue;
    }
    const char = request[index]!;
    if ((char === '"' || char === "“" || char === "”") && !fenced && !inlineCode) {
      quoted = !quoted;
      index++;
      continue;
    }
    if (char === "`" && !fenced && !quoted) {
      inlineCode = !inlineCode;
      index++;
      continue;
    }
    if (fenced || inlineCode || quoted) {
      index++;
      continue;
    }
    if (char === "[") {
      const labelEnd = request.indexOf("](", index + 1);
      const destinationEnd = labelEnd < 0 ? -1 : request.indexOf(")", labelEnd + 2);
      if (labelEnd >= 0 && destinationEnd >= 0 && !request.slice(index, destinationEnd).includes("\n")) {
        add(request.slice(labelEnd + 2, destinationEnd), request.slice(index + 1, labelEnd));
        index = destinationEnd + 1;
        continue;
      }
    }
    if (char === "<") {
      const end = request.indexOf(">", index + 1);
      if (end >= 0 && !request.slice(index, end).includes("\n")) {
        const link = request.slice(index + 1, end);
        const pipe = link.indexOf("|");
        add(pipe < 0 ? link : link.slice(0, pipe), pipe < 0 ? undefined : link.slice(pipe + 1));
        index = end + 1;
        continue;
      }
    }
    const schemeLength = urlSchemeLength(request, index);
    if (schemeLength > 0) {
      let end = index + schemeLength;
      while (end < request.length && !" \t\r\n<>)]},;`".includes(request[end]!)) end++;
      let raw = request.slice(index, end);
      const sentenceEnd = raw.endsWith(".");
      while (raw.endsWith(".") || raw.endsWith(":")) raw = raw.slice(0, -1);
      add(raw);
      if (sentenceEnd) tokens.push({ kind: "boundary" });
      index = end;
      continue;
    }
    if ((char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || (char >= "0" && char <= "9")) {
      let end = index + 1;
      while (end < request.length) {
        const next = request[end]!;
        if (!(
          (next >= "a" && next <= "z") ||
          (next >= "A" && next <= "Z") ||
          (next >= "0" && next <= "9") ||
          next === "'" ||
          next === "’"
        ))
          break;
        end++;
      }
      tokens.push({ kind: "word", value: request.slice(index, end).toLowerCase() });
      index = end;
      continue;
    }
    if (
      char === ";" ||
      char === "!" ||
      char === "?" ||
      (char === "." && !(index > 0 && request[index - 1]! >= "0" && request[index - 1]! <= "9"))
    )
      tokens.push({ kind: "boundary" });
    else tokens.push({ kind: "separator" });
    index++;
  }
  return tokens;
}

/** Link destinations in the author's words, independent of bullet layout. */
export function linkedPullRequestsOf(text: string): BatchPullRequest[] {
  const targets = new Map<string, BatchPullRequest>();
  for (const token of requestTokens(text)) if (token.kind === "link") targets.set(token.target.url, token.target);
  return [...targets.values()];
}

const INTRO_WORDS = new Set([
  "all",
  "and",
  "both",
  "following",
  "links",
  "of",
  "pr",
  "prs",
  "pull",
  "requests",
  "the",
  "these",
  "those",
]);
const PREAMBLE_WORDS = new Set([
  "and",
  "ahead",
  "can",
  "could",
  "go",
  "i",
  "let's",
  "lets",
  "please",
  "re",
  "to",
  "want",
  "you",
]);
const NEGATION_WORDS = new Set(["don't", "don’t", "dont", "n't", "never", "no", "not", "without"]);
const TAIL_EXCLUSIONS = new Set([
  "background",
  "context",
  "don't",
  "don’t",
  "dont",
  "except",
  "exclude",
  "excluded",
  "never",
  "not",
  "reference",
  "skip",
]);
const digitsWord = (word: string) => [...word].every((char) => char >= "0" && char <= "9");

/** The positive action and complete contiguous list are evidence for a typed
 * choice. Anything this small grammar cannot prove stays outside the batch. */
export function explicitPrBatchOf(text: string): PrBatchBinding | undefined {
  let phase: "preamble" | "intro" | "list" | "tail" = "preamble";
  let kind: PrBatchBinding["kind"] | undefined;
  const targets: BatchPullRequest[] = [];
  let invalid = false;
  let tailExcluded = false;
  let tailWordsPending = false;
  let preambleWords: string[] = [];
  let recentWords: string[] = [];
  for (const token of requestTokens(text)) {
    if (token.kind === "boundary") {
      if (phase === "tail" && tailWordsPending) invalid = true;
      if (phase === "intro") invalid = true;
      if (phase === "list") phase = "tail";
      if (phase === "preamble") preambleWords = [];
      if (phase === "tail") tailExcluded = false;
      tailWordsPending = false;
      recentWords = [];
      continue;
    }
    if (token.kind === "separator") continue;
    if (token.kind === "link") {
      if (phase === "intro" || phase === "list") {
        if (token.excluded) {
          if (phase === "intro") invalid = true;
          phase = "tail";
          tailExcluded = true;
        } else {
          phase = "list";
          targets.push(token.target);
        }
      } else if (phase === "tail" && !tailExcluded) invalid = true;
      else if (phase === "tail") tailWordsPending = false;
      else if (phase === "preamble") invalid = true;
      recentWords = [];
      continue;
    }
    const word = token.value;
    const action = word === "review" || word === "ship";
    const negated = recentWords.slice(-3).some((previous) => NEGATION_WORDS.has(previous));
    if (phase === "preamble") {
      if (action && !negated) {
        if (
          !preambleWords.every((previous) => PREAMBLE_WORDS.has(previous)) ||
          (preambleWords.includes("re") && word !== "review")
        )
          invalid = true;
        kind = word as PrBatchBinding["kind"];
        phase = "intro";
      } else {
        preambleWords.push(word);
      }
    } else if (phase === "intro") {
      if (action || (!INTRO_WORDS.has(word) && !digitsWord(word))) invalid = true;
    } else if (phase === "list") {
      if (word !== "and" && word !== "pr" && !digitsWord(word)) {
        phase = "tail";
        tailExcluded = TAIL_EXCLUSIONS.has(word) || (action && negated);
        invalid = true;
      }
    } else {
      tailWordsPending = true;
      if (TAIL_EXCLUSIONS.has(word) || (action && negated)) tailExcluded = true;
      if (action && !negated) invalid = true;
    }
    recentWords = [...recentWords.slice(-3), word];
  }
  if (invalid || tailWordsPending || !kind || targets.length < 2 || targets.length > 32) return undefined;
  return { kind, targets };
}

/** The model proposes a batch; code holds its action and complete list to
 * explicit author evidence before any child can start. */
export function prBatchBindingOf(input: unknown, request: string): { binding: PrBatchBinding } | { error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return { error: "a PR batch needs a typed action and target URLs" };
  const { kind, targets } = input as Record<string, unknown>;
  if (kind !== "review" && kind !== "ship") return { error: "a PR batch action must be review or ship" };
  if (!Array.isArray(targets) || targets.length < 2 || targets.length > 32)
    return { error: "a PR batch needs 2 to 32 exact target URLs" };
  const evidence = new Set(linkedPullRequestsOf(request).map((target) => target.url));
  const selected: BatchPullRequest[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const target = typeof raw === "string" ? pullRequestOf(raw) : undefined;
    if (!target || !evidence.has(target.url))
      return { error: "a PR batch target must be an exact link in this request" };
    if (seen.has(target.url)) return { error: "a PR batch cannot repeat a target" };
    seen.add(target.url);
    selected.push(target);
  }
  const explicit = explicitPrBatchOf(request);
  if (
    !explicit ||
    explicit.kind !== kind ||
    explicit.targets.length !== selected.length ||
    explicit.targets.some((target, index) => target.url !== selected[index]?.url)
  )
    return { error: "a PR batch must match one explicit Review or Ship list in this request" };
  return { binding: { kind, targets: selected } };
}
