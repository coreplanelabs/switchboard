/** A question is a typed turn outcome, never inferred from punctuation. */
export function questionText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= 4000 ? text : undefined;
}
