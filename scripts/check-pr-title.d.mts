export const TITLE_GRAMMAR: RegExp;
export const CODE_MAP_PATH: string;
export const MIGRATIONS_PATH: string;
/** The most characters a title may run to, the whole line counted; `PR_DESCRIPTION_CAPS.title` holds the same number. */
export const TITLE_MAX_VISIBLE: number;
/** The scopes only bots write (`deps`, `main`); their titles are not held to the cap. */
export const BOT_SCOPES: readonly string[];
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
  /** `release-as` from release-please-config.json when the next version is pinned; a `!` title is then refused. */
  releaseAs?: string;
}): string[];
