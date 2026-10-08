/** The loop's read tools: ground truth the model may ask for before acting —
 *  the thread's owner and pending question, the repository's facts, the
 *  registry's help — answered from the turn's own state, never a side effect. */
export const OPERATOR_READ_TOOLS = {
  repositoryBrief: "repository_brief",
  threadState: "thread_state",
  repoFacts: "repo_facts",
  registryHelp: "registry_help",
  /** The providers catalogue (issue 2088): the refs this deployment can run,
   *  so a write proposal names a real one — `openai` resolves to the
   *  openrouter OpenAI refs that exist, never a provider the config lacks. */
  providerModels: "provider_models",
} as const;

/** Grounding helpers and terminal-command fulfillment verdicts share this
 *  read allowance. Structural action repairs spend their own bounded slots. */
export const OPERATOR_READS_MAX = 4;
