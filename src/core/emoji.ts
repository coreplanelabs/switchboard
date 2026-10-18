import shortcodes from "emojibase-data/en/shortcodes/iamcal.json" with { type: "json" };
/** Names include aliases; downloaded counts distinct image files. */
export interface EmojiSyncResult {
  status: "complete" | "partial" | "unavailable";
  total: number | null;
  available: number;
  downloaded: number;
  failed: number;
  reason?: "missing_scope" | "invalid_auth" | "source_unavailable";
}

// Slack uses the iamcal set. The server and browser share its Unicode aliases.
const standard = new Map(
  Object.entries(shortcodes).flatMap(([hex, names]) =>
    (Array.isArray(names) ? names : [names]).map(
      (name) => [name, String.fromCodePoint(...hex.split("-").map((point) => Number.parseInt(point, 16)))] as const,
    ),
  ),
);
const unicode = new Set(standard.values());
export const EMOJI_NAME = /^[A-Za-z0-9_+'-]{1,100}$/;
export const standardEmoji = (name: string): string | undefined => standard.get(name);
export const isStandardEmoji = (text: string): boolean => unicode.has(text);
export type EmojiEntry =
  { path: string; text?: never; source?: string } | { text: string; path?: never; source?: never };
