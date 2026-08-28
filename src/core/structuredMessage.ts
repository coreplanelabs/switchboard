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

// Upper bounds so pathological input is rejected (→ self-heal feedback, then a
// safe fallback) rather than silently accepted. Chosen generous enough never to
// clip a real answer, small enough to stop abuse (a megabyte of text, thousands
// of bullets): any text/code/label string ≤ 12000 chars, a URL ≤ 2048 chars,
// ≤ 100 bullet items in a list, ≤ 50 blocks in a message.
const MAX_TEXT = 12_000;
const MAX_URL = 2048;
const MAX_BULLETS = 100;
const MAX_BLOCKS = 50;
// A code fence's language tag is a short identifier ("bash", "typescript"), never
// prose — bound it like the other fields so an unbounded string can't ride in.
const MAX_LANGUAGE = 40;

// Every block object is `.strict()`: an unknown/extra key is REJECTED, not
// silently stripped, so the self-heal loop gets corrective feedback on a misnamed
// field (e.g. `txt` instead of `text`) instead of a block that quietly lost it.
const headingBlock = z
  .object({
    type: z.literal("heading"),
    text: z.string().min(1).max(MAX_TEXT),
  })
  .strict();

const paragraphBlock = z
  .object({
    type: z.literal("paragraph"),
    text: z.string().min(1).max(MAX_TEXT),
  })
  .strict();

const bulletsBlock = z
  .object({
    type: z.literal("bullets"),
    items: z.array(z.string().min(1).max(MAX_TEXT)).min(1).max(MAX_BULLETS),
  })
  .strict();

const codeBlock = z
  .object({
    type: z.literal("code"),
    code: z.string().max(MAX_TEXT),
    language: z.string().max(MAX_LANGUAGE).optional(),
  })
  .strict();

const linkBlock = z
  .object({
    type: z.literal("link"),
    url: z.url().max(MAX_URL),
    text: z.string().max(MAX_TEXT).optional(),
  })
  .strict();

const statusBlock = z
  .object({
    type: z.literal("status"),
    state: z.enum(STATUS_STATES),
    text: z.string().min(1).max(MAX_TEXT),
  })
  .strict();

/** One block of a structured message; a discriminated union on `type` so an
 *  unknown `type` is rejected with a legible error (fed back on self-heal). Each
 *  member is `.strict()`, so unknown keys within a block are rejected too. */
export const messageBlockSchema = z.discriminatedUnion("type", [
  headingBlock,
  paragraphBlock,
  bulletsBlock,
  codeBlock,
  linkBlock,
  statusBlock,
]);

/** A whole agent answer: an ordered, non-empty, bounded list of blocks. Also
 *  `.strict()` so an unknown top-level key is rejected, not silently ignored. */
export const structuredMessageSchema = z
  .object({
    blocks: z.array(messageBlockSchema).min(1).max(MAX_BLOCKS),
  })
  .strict();

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
