import type { GithubRoute } from "./githubApi.js";
import { oneLine, redactAndCap } from "../core/redact.js";

export interface GithubRateLimitFacts {
  remaining?: number;
  reset?: number;
  resource?: string;
  retryAfterSeconds?: number;
}

export const GITHUB_RESPONSE_REASONS = [
  "secondary-rate-limit-indicated",
  "primary-rate-limit-indicated",
  "rate-limit-indicated",
  "permission-indicated",
] as const;
export type GithubResponseReason = (typeof GITHUB_RESPONSE_REASONS)[number];

export function safeGithubResponseMessage(message: string): string | undefined {
  const first = oneLine(message);
  if (!first) return undefined;
  return redactAndCap(
    first
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "«redacted-url»")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "«redacted-email»")
      .replace(/\bfor user ID\s+\S+/gi, "for user ID «redacted»"),
    240,
  );
}

/** A GitHub API refusal with only bounded response facts. */
export class GithubApiError extends Error {
  readonly responseMessage?: string;
  constructor(
    readonly status: number,
    message: string,
    readonly requestId?: string,
    readonly route?: GithubRoute,
    readonly rateLimit?: Readonly<GithubRateLimitFacts>,
    readonly responseReason?: GithubResponseReason,
    responseMessage?: string,
  ) {
    super(message);
    this.name = "GithubApiError";
    this.responseMessage = responseMessage === undefined ? undefined : safeGithubResponseMessage(responseMessage);
  }
}

/** Distinguishes a missing local credential from a GitHub HTTP 401. */
export class GithubCredentialUnavailable extends GithubApiError {
  constructor(readonly reason: "missing" | "failed" = "missing") {
    super(
      reason === "missing" ? 401 : 503,
      reason === "missing"
        ? "no GitHub credential available (configure the GitHub App or GH_TOKEN)"
        : "GitHub credential resolution failed",
    );
  }
}
