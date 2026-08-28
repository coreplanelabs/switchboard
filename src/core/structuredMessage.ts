import { z } from "zod";

// The channel-agnostic structured representation of an agent's output. Instead
// of the model guessing a channel's markup (Slack mrkdwn, Discord markdown, …)
// — which it gets wrong across channels — it emits this shape, and each channel
// owns a ChannelFormatter that renders it to its own guaranteed-correct format.
//
// This is the MINIMAL block set that covers today's messages: headings,
// paragraphs, bullet lists, code, links, and status/verdict lines. Richer
// inline spans (bold/italic inside a paragraph) and channel-native rich payloads
// (Slack Block Kit) are deliberately out of scope for the first cut — see
// features/channel-formatter.md ("Deferred").

/** Status/verdict flavor — the small closed set every formatter maps to its own
 *  glyph/prefix (Slack ✅/⚠️/❌/ℹ️, plain [OK]/[WARN]/…). Covers review verdicts. */
export const STATUS_STATES = ["ok", "warn", "error", "info"] as const;
export type StatusState = (typeof STATUS_STATES)[number];

const headingBlock = z.object({
  type: z.literal("heading"),
  text: z.string().min(1),
});

const paragraphBlock = z.object({
  type: z.literal("paragraph"),
  text: z.string().min(1),
});

const bulletsBlock = z.object({
  type: z.literal("bullets"),
  items: z.array(z.string().min(1)).min(1),
});

const codeBlock = z.object({
  type: z.literal("code"),
  code: z.string(),
  language: z.string().optional(),
});

const linkBlock = z.object({
  type: z.literal("link"),
  url: z.url(),
  text: z.string().optional(),
});

const statusBlock = z.object({
  type: z.literal("status"),
  state: z.enum(STATUS_STATES),
  text: z.string().min(1),
});

/** One block of a structured message; a discriminated union on `type` so an
 *  unknown `type` is rejected with a legible error (fed back on self-heal). */
export const messageBlockSchema = z.discriminatedUnion("type", [
  headingBlock,
  paragraphBlock,
  bulletsBlock,
  codeBlock,
  linkBlock,
  statusBlock,
]);

/** A whole agent answer: an ordered, non-empty list of blocks. */
export const structuredMessageSchema = z.object({
  blocks: z.array(messageBlockSchema).min(1),
});

export type MessageBlock = z.infer<typeof messageBlockSchema>;
export type StructuredMessage = z.infer<typeof structuredMessageSchema>;

/** Zod validation of an already-parsed value against the message schema.
 *  Returns the typed message or a single human-readable error string (the
 *  string is what self-heal feeds back to the model). Never throws. */
export function validateStructuredMessage(
  raw: unknown,
): { ok: true; message: StructuredMessage } | { ok: false; error: string } {
  const result = structuredMessageSchema.safeParse(raw);
  if (result.success) return { ok: true, message: result.data };
  return { ok: false, error: formatZodError(result.error) };
}

/** Flatten a ZodError into one compact line per issue: `path: message`. Kept
 *  small and stable so it reads well both in logs and when fed back to the
 *  model as a correction. */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/** The graceful fallback: wrap raw text as a single paragraph so a malformed
 *  model output still renders as a safe plain message instead of failing the
 *  run. Empty/whitespace text becomes an honest placeholder (paragraph text is
 *  schema-required to be non-empty). */
export function fallbackMessage(text: string): StructuredMessage {
  const trimmed = text.trim();
  return { blocks: [{ type: "paragraph", text: trimmed || "(no response)" }] };
}

/** Renders a validated structured message to one channel's native payload.
 *  The seam that stops the LLM guessing per-channel markup (AGENTS.md invariant
 *  2: ≥2 implementations — SlackFormatter + PlainTextFormatter). The payload is
 *  a string for both current channels; a Slack Block Kit payload is deferred. */
export interface ChannelFormatter {
  /** Human name for logs, e.g. "slack" / "plain". */
  readonly name: string;
  /** Render the structured message to this channel's native string payload. */
  format(message: StructuredMessage): string;
}

/**
 * Plain-text formatter for channels with no rich markup: CLI, HTTP, MCP. Also
 * the core's safe default when a channel declares no formatter of its own.
 * Deterministic: blocks separated by a blank line, no markup guessing.
 */
export class PlainTextFormatter implements ChannelFormatter {
  readonly name = "plain";

  format(message: StructuredMessage): string {
    return message.blocks.map((block) => renderPlainBlock(block)).join("\n\n");
  }
}

const PLAIN_STATUS_PREFIX: Record<StatusState, string> = {
  ok: "[OK]",
  warn: "[WARN]",
  error: "[ERROR]",
  info: "[INFO]",
};

function renderPlainBlock(block: MessageBlock): string {
  switch (block.type) {
    case "heading":
      return block.text;
    case "paragraph":
      return block.text;
    case "bullets":
      return block.items.map((item) => `- ${item}`).join("\n");
    case "code":
      return "```" + (block.language ?? "") + "\n" + block.code + "\n```";
    case "link":
      return block.text ? `${block.text} (${block.url})` : block.url;
    case "status":
      return `${PLAIN_STATUS_PREFIX[block.state]} ${block.text}`;
  }
}
