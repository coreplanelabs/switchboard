export const TITLE_GRAMMAR: RegExp;
export function allowedTypes(releasePleaseConfig: unknown): string[];
export type TitleVerdict =
  | { ok: true; type: string; scope: string | null; breaking: boolean; description: string }
  | { ok: false; problems: string[] };
export function checkPrTitle(rawTitle: string | undefined | null, types: string[]): TitleVerdict;
