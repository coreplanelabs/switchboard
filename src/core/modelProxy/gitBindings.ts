/** Dispatch supplies the authorized repository. The first unbound branch is
 * reserved before its create request and confirmed only after Git accepts it.
 * Re-attach restores both facts; an unconfirmed ref remains create-only. */
export interface GitBinding {
  repo?: string;
  ref?: string;
  refConfirmed?: boolean;
}

interface Entry {
  binding: GitBinding;
  persist?: (binding: GitBinding) => Promise<boolean>;
  queue: Promise<unknown>;
}

function branch(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref : `refs/heads/${ref}`;
}

export class GitBindings {
  private readonly entries = new Map<string, Entry>();

  register(
    runId: string,
    initial: GitBinding,
    carried: GitBinding | undefined,
    persist?: (binding: GitBinding) => Promise<boolean>,
  ): boolean {
    if (carried?.repo && initial.repo && carried.repo.toLowerCase() !== initial.repo.toLowerCase()) return false;
    if (carried?.ref && initial.ref && branch(carried.ref) !== branch(initial.ref)) return false;
    if (carried?.ref && !carried.repo && !initial.repo) return false;
    this.entries.set(runId, {
      binding: {
        repo: carried?.repo ?? initial.repo,
        ref: carried?.ref ? branch(carried.ref) : initial.ref ? branch(initial.ref) : undefined,
        ...(carried?.ref ? { refConfirmed: carried.refConfirmed === true } : {}),
      },
      persist,
      queue: Promise.resolve(),
    });
    return true;
  }

  get(runId: string): GitBinding | undefined {
    const binding = this.entries.get(runId)?.binding;
    return binding ? { ...binding } : undefined;
  }

  async bindRepo(runId: string, repo: string): Promise<boolean> {
    return this.change(runId, (binding) => {
      if (binding.repo) return binding.repo.toLowerCase() === repo.toLowerCase() ? binding : undefined;
      return { ...binding, repo };
    });
  }

  async bindRef(runId: string, ref: string): Promise<boolean> {
    return this.change(runId, (binding) => {
      if (!binding.repo) return undefined;
      if (binding.ref) return binding.ref === ref ? binding : undefined;
      return { ...binding, ref, refConfirmed: false };
    });
  }

  async confirmRef(runId: string, ref: string): Promise<boolean> {
    return this.change(runId, (binding) => {
      if (binding.ref !== ref) return undefined;
      return binding.refConfirmed ? binding : { ...binding, refConfirmed: true };
    });
  }

  unregister(runId: string): void {
    this.entries.delete(runId);
  }

  private change(runId: string, decide: (binding: GitBinding) => GitBinding | undefined): Promise<boolean> {
    const entry = this.entries.get(runId);
    if (!entry) return Promise.resolve(false);
    const action = entry.queue.then(async () => {
      if (this.entries.get(runId) !== entry) return false;
      const next = decide(entry.binding);
      if (!next) return false;
      if (next === entry.binding) return true;
      if (!entry.persist || !(await entry.persist(next))) return false;
      if (this.entries.get(runId) !== entry) return false;
      entry.binding = next;
      return true;
    });
    entry.queue = action.catch(() => false);
    return action.catch(() => false);
  }
}
