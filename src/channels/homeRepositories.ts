import type { ConfigStore } from "../config.js";
import type { Actor } from "../core/authz/types.js";
import { githubCapabilityFor } from "../core/dispatch/run.js";
import type { GithubApi } from "../execution/githubApi.js";

/** Current eligible choices, never installation-wide private repository metadata. */
export type HomeRepositories =
  { status: "complete"; repositories: { repo: string }[] } | { status: "unavailable"; repositories: [] };

export interface HomeRepositoryChoice {
  selected?: string;
  /** Read context never selects or conflicts with the execution repository. */
  attached?: readonly string[];
  configured?: string;
}
const repoSlug = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 2048 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);

/** One existing GitHub capability and policy table; no saved preference or new grant. */
export function createHomeRepositories(options: { config: ConfigStore; github: GithubApi }) {
  async function read(actor: Actor): Promise<HomeRepositories> {
    try {
      // Without a separately verified native private-read capability, the existing
      // helper permits public repositories only. A directory link lends no access.
      const rows = await githubCapabilityFor(
        { config: options.config, githubApi: options.github },
        actor,
      ).readableRepos?.();
      if (!rows || rows.some((row) => !row || !repoSlug(row.fullName)))
        return { status: "unavailable", repositories: [] };
      const repositories = rows
        .filter((row) => row.private === false && options.config.canUseRepo(actor, row.fullName))
        .map((row) => ({ repo: row.fullName }))
        .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
      const seen = new Set<string>();
      return {
        status: "complete",
        repositories: repositories.filter((row) => {
          const key = row.repo.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      };
    } catch {
      return { status: "unavailable", repositories: [] };
    }
  }
  async function currentChoice(actor: Actor, repo: string): Promise<string | undefined> {
    if (!repoSlug(repo) || !options.config.canUseRepo(actor, repo)) return;
    const choices = await read(actor);
    if (choices.status !== "complete") return;
    const chosen = choices.repositories.find((row) => row.repo.toLowerCase() === repo.toLowerCase());
    return chosen && options.config.canUseRepo(actor, chosen.repo) ? chosen.repo : undefined;
  }
  async function sourceChoice(actor: Actor, choice: HomeRepositoryChoice): Promise<string | undefined> {
    const target = choice.selected ?? choice.configured;
    return target === undefined ? undefined : currentChoice(actor, target);
  }
  return {
    read,
    authorize: async (actor: Actor, repo: string) => (await currentChoice(actor, repo)) !== undefined,
    sourceChoice,
  };
}
