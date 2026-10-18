import type { RunEvent } from "./runEvents.js";
import { redactAndCap } from "./redact.js";
import { wrapUntrusted } from "./untrusted.js";

/** Display metadata is separate from the legacy label and current activity. */
export interface RunDisplay {
  prompt?: string;
  title?: string;
}

export const RUN_PROMPT_MAX = 16_000;
export const RUN_TITLE_MAX = 60;

/** Native metadata reads omit request and abridging text. */
export function runMetadata<T extends RunDisplay>(run: T): Omit<T, "prompt" | "readingDiffAbridge"> {
  const {
    prompt: _prompt,
    readingDiffAbridge: _readingDiffAbridge,
    ...metadata
  } = run as T & { readingDiffAbridge?: unknown };
  return run.title ? { ...metadata, title: wrapUntrusted(run.title) } : metadata;
}

export function boundedRunTitle(text: string): string {
  return Array.from(redactAndCap(text, RUN_TITLE_MAX * 2))
    .slice(0, RUN_TITLE_MAX)
    .join("");
}

export function runDisplayOf(events: readonly RunEvent[]): RunDisplay {
  const display: RunDisplay = {};
  for (const event of events) {
    if (event.type === "input" && typeof event.text === "string" && display.prompt === undefined)
      display.prompt = redactAndCap(event.text, RUN_PROMPT_MAX);
    if (event.type === "run_title" && typeof event.title === "string") display.title = boundedRunTitle(event.title);
  }
  return display;
}
