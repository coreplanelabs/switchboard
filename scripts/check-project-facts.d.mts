export interface ProjectFacts {
  /** The identifier: package names, the CLI, the bot's mention, config keys, Worker script names, the repository. */
  name: string;
  /** The name a reader sees: the README's first heading, the docs site's title and hero, the GitHub description's subject. */
  displayName: string;
  /** The package the project publishes: `@scope/<name>` — scoped, its unscoped part `name`; every package a checked file mentions under that scope is this one. */
  npmPackage: string;
  /** The one-sentence pitch: the repository's GitHub description and package.json's `description` (both checked against this); the README's opening line says the same thing by hand. ≤ 350 characters. */
  description: string;
  organization: string;
  repository: string;
  /** The container image every release publishes: `ghcr.io/<owner>/<repo>`, the repository path lowercased. */
  image: string;
  docs: string;
  /** The repository's GitHub topics: 1–20 of `[a-z0-9-]{1,50}`. */
  topics: string[];
  contact: string;
  steward: { name: string; url: string };
  commands: Record<string, { does: string; when: string } | string>;
}
export const CHECKED_FILES: string[];
export function factsProblems(facts: ProjectFacts, files: Record<string, string>): { file: string; what: string }[];
