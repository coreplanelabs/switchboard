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
/** The next release under the config's versioning strategy: next minor for `always-bump-minor`, else next major. */
export function nextRelease(version: string, versioning: string | undefined): string;
export function migrationNoteProblems(input: {
  breaking: boolean;
  version: string;
  migrationsDoc: string | undefined;
  /** `versioning` from release-please-config.json; `always-bump-minor` makes the required heading the next minor. */
  versioning?: string;
}): string[];
