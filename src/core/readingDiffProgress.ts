import { redactSecrets, stripAnsi } from "./redact.js";

export const MEAT_PROGRESS_LINES = 32;
export const MEAT_PROGRESS_CHARS = 512;

/** The latest attempt, kept with the review so refreshes and restarts retain evidence. */
export interface ReadingDiffAttempt {
  state: "running" | "done" | "failed";
  startedAt: number;
  at: number;
  progress: string[];
  reason?: string;
}

export function safeMeatText(text: string): string {
  return redactSecrets(stripAnsi(text)).replace(/\s+/g, " ").trim();
}

export function retainMeatProgress(progress: readonly string[], message: string): string[] {
  const safe = safeMeatText(message).slice(0, MEAT_PROGRESS_CHARS);
  return safe ? [...progress, safe].slice(-MEAT_PROGRESS_LINES) : [...progress];
}

export function isReadingDiffAttempt(value: unknown): value is ReadingDiffAttempt {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.state === "running" || v.state === "done" || v.state === "failed") &&
    typeof v.startedAt === "number" &&
    Number.isFinite(v.startedAt) &&
    typeof v.at === "number" &&
    Number.isFinite(v.at) &&
    Array.isArray(v.progress) &&
    v.progress.length <= MEAT_PROGRESS_LINES &&
    v.progress.every((line) => typeof line === "string" && line.length <= MEAT_PROGRESS_CHARS) &&
    (v.reason === undefined || (typeof v.reason === "string" && v.reason.length <= 4000)) &&
    (v.state !== "failed" || typeof v.reason === "string")
  );
}
