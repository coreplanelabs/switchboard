export const TITLE_GRAMMAR: RegExp;
export const CODE_MAP_PATH: string;
export const MIGRATIONS_PATH: string;
export function allowedTypes(releasePleaseConfig: unknown): string[];
export function allowedScopes(codeMapMarkdown: string): string[];
export interface TitleVocabulary {
  types: string[];
  scopes: string[];
}
export type TitleVerdict =
  | { ok: true; type: string; scope: string | null; breaking: boolean; description: string }
  | { ok: false; problems: string[] };
export function checkPrTitle(rawTitle: string | undefined | null, vocabulary: TitleVocabulary): TitleVerdict;
export function nextMajor(version: string): string;
export function migrationNoteProblems(input: {
  breaking: boolean;
  version: string;
  migrationsDoc: string | undefined;
}): string[];
