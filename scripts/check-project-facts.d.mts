export interface ProjectFacts {
  name: string;
  displayName: string;
  /** The one-sentence pitch: the README's first line, the repository's GitHub description, package.json's `description`. ≤ 350 characters. */
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
