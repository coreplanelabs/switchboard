import { oneLine, redactAndCap } from "../../src/core/redact.js";

/** Keep GitHub token-mint response evidence without a raw body or header bag. */
export async function residentGithubFailureFacts(res: Response): Promise<string> {
  const facts: string[] = [];
  const requestId = res.headers.get("x-github-request-id");
  if (requestId && /^[0-9A-Fa-f:]{1,64}$/.test(requestId)) facts.push(`request ${requestId}`);
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining && /^(?:0|[1-9][0-9]{0,9})$/.test(remaining) && Number(remaining) <= 1_000_000_000)
    facts.push(`remaining ${Number(remaining)}`);
  try {
    const body: unknown = JSON.parse(await res.text());
    const message =
      body && typeof body === "object" && !Array.isArray(body) ? (body as { message?: unknown }).message : null;
    if (typeof message === "string") {
      const safe = redactAndCap(
        oneLine(message)
          .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "«redacted-url»")
          .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "«redacted-email»")
          .replace(/\bfor user ID\s+\S+/gi, "for user ID «redacted»"),
        240,
      );
      if (safe) facts.push(`message ${safe}`);
    }
  } catch {
    // An unreadable or unstructured response has no safe message; keep the observed status and headers.
  }
  return facts.length ? `; ${facts.join("; ")}` : "";
}
