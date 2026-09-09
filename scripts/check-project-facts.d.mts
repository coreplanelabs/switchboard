export interface ProjectFacts {
  name: string;
  displayName: string;
  organization: string;
  repository: string;
  /** The container image every release publishes: `ghcr.io/<owner>/<repo>`, the repository path lowercased. */
  image: string;
  docs: string;
  contact: string;
  steward: { name: string; url: string };
  commands: Record<string, { does: string; when: string } | string>;
}
export const CHECKED_FILES: string[];
export function factsProblems(facts: ProjectFacts, files: Record<string, string>): { file: string; what: string }[];
