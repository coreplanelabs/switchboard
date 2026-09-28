/** Dispatch supplies the authorized repository. The first unbound branch is
 * reserved before its create request and confirmed only after Git accepts it.
 * Re-attach restores both facts; an unconfirmed ref remains create-only. */
export interface GitBinding {
  repo?: string;
  ref?: string;
  refConfirmed?: boolean;
}

export type GitPublicationAuthority = { blocked: string } | { ref: string; expectedHeadSha: string };

export interface GitPublicationUpdate {
  ref: string;
  old: string;
  next: string;
}

export interface GitPublicationRecorder {
  /** Commit an uncertain-write marker before a GitHub write token is used. */
  begin(update: GitPublicationUpdate): Promise<boolean>;
  /** A success receipt or a known no-write outcome clears that marker durably. */
  finish(update: GitPublicationUpdate, outcome: "accepted" | "rejected" | "not_forwarded"): Promise<boolean>;
}

export interface GitPublicationClaim {
  finish(outcome: "accepted" | "rejected" | "not_forwarded" | "unknown"): Promise<boolean>;
}

interface Entry {
  /** In-process request fence: unregister/re-register never revives an older request. */
  generation: symbol;
  binding: GitBinding;
  /** Existing-PR writes start blocked and are authorized only after fresh verification. */
  publication?: GitPublicationAuthority;
  recorder?: GitPublicationRecorder;
  branchRecorder?: GitPublicationRecorder;
  pending?: GitPublicationUpdate;
  pendingSettled?: Promise<void>;
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
    existingPr = false,
  ): boolean {
    if (carried?.repo && initial.repo && carried.repo.toLowerCase() !== initial.repo.toLowerCase()) return false;
    if (carried?.ref && initial.ref && branch(carried.ref) !== branch(initial.ref)) return false;
    if (carried?.ref && !carried.repo && !initial.repo) return false;
    this.entries.set(runId, {
      generation: Symbol(),
      binding: {
        repo: carried?.repo ?? initial.repo,
        ref: carried?.ref ? branch(carried.ref) : initial.ref ? branch(initial.ref) : undefined,
        ...(carried?.ref ? { refConfirmed: carried.refConfirmed === true } : {}),
      },
      ...(existingPr ? { publication: { blocked: "existing PR publication is not verified" } } : {}),
      persist,
      queue: Promise.resolve(),
    });
    return true;
  }

  get(runId: string): GitBinding | undefined {
    const binding = this.entries.get(runId)?.binding;
    return binding ? { ...binding } : undefined;
  }

  /** Opaque identity for a door request to reject a replacement registration. */
  generationOf(runId: string): symbol | undefined {
    return this.entries.get(runId)?.generation;
  }

  publicationOf(runId: string): GitPublicationAuthority | undefined {
    const publication = this.entries.get(runId)?.publication;
    return publication ? { ...publication } : undefined;
  }

  /** A trusted coordinator may replace the existing-PR door fence; a model cannot. */
  setPublication(runId: string, authority: GitPublicationAuthority): boolean {
    const entry = this.entries.get(runId);
    if (!entry?.publication) return false;
    if (
      "expectedHeadSha" in authority &&
      (!/^[0-9a-f]{40}$/.test(authority.expectedHeadSha) ||
        !entry.binding.ref ||
        branch(authority.ref) !== entry.binding.ref)
    ) {
      entry.publication = { blocked: "existing PR publication authority is invalid" };
      entry.generation = Symbol();
      return false;
    }
    if (entry.pending && "expectedHeadSha" in authority) return false;
    entry.publication = { ...authority };
    entry.generation = Symbol();
    return true;
  }

  setPublicationRecorder(runId: string, recorder: GitPublicationRecorder): boolean {
    const entry = this.entries.get(runId);
    if (!entry?.publication || entry.pending) return false;
    entry.recorder = recorder;
    return true;
  }

  /** New and non-PR branch writes also need a durable outcome before a run
   * can seal. Existing PRs cannot use this less specific authority. */
  setBranchRecorder(runId: string, recorder: GitPublicationRecorder): boolean {
    const entry = this.entries.get(runId);
    if (!entry || entry.publication || entry.pending || entry.branchRecorder) return false;
    entry.branchRecorder = recorder;
    return true;
  }

  /** End a branch run's write admission before waiting for a forwarded claim.
   * A pending claim can still report its remote outcome. */
  blockBranch(runId: string, reason: string): boolean {
    const entry = this.entries.get(runId);
    if (!entry || entry.publication) return false;
    entry.publication = { blocked: reason };
    entry.generation = Symbol();
    return true;
  }

  async beginBranch(runId: string, update: GitPublicationUpdate): Promise<GitPublicationClaim | undefined> {
    const entry = this.entries.get(runId);
    if (
      !entry?.branchRecorder ||
      entry.publication ||
      entry.pending ||
      entry.binding.ref !== update.ref ||
      !/^[0-9a-f]{40}$/.test(update.next)
    )
      return undefined;
    return this.beginClaim(runId, entry, update, entry.branchRecorder);
  }

  async beginPublication(runId: string, update: GitPublicationUpdate): Promise<GitPublicationClaim | undefined> {
    const entry = this.entries.get(runId);
    const authority = entry?.publication;
    if (
      !entry?.recorder ||
      !authority ||
      "blocked" in authority ||
      entry.pending ||
      branch(authority.ref) !== update.ref ||
      authority.expectedHeadSha !== update.old ||
      !/^[0-9a-f]{40}$/.test(update.next)
    )
      return undefined;
    return this.beginClaim(runId, entry, update, entry.recorder, authority);
  }

  private async beginClaim(
    runId: string,
    entry: Entry,
    update: GitPublicationUpdate,
    recorder: GitPublicationRecorder,
    authority?: { ref: string; expectedHeadSha: string },
  ): Promise<GitPublicationClaim | undefined> {
    entry.pending = update;
    let settlePending!: () => void;
    entry.pendingSettled = new Promise<void>((resolve) => (settlePending = resolve));
    let begun = false;
    try {
      begun = await recorder.begin(update);
    } catch {
      // A failed durable intent never authorizes an upstream write.
    }
    if (!begun || this.entries.get(runId) !== entry || entry.pending !== update) {
      if (begun) await recorder.finish(update, "not_forwarded").catch(() => false);
      if (this.entries.get(runId) === entry) {
        entry.pending = undefined;
        entry.pendingSettled = undefined;
        entry.publication = { blocked: "publication intent could not be committed" };
        entry.generation = Symbol();
      }
      settlePending();
      return undefined;
    }
    let finished = false;
    return {
      finish: async (outcome) => {
        if (finished) return false;
        finished = true;
        let committed = false;
        if (outcome !== "unknown") {
          try {
            committed = await recorder.finish(update, outcome);
          } catch {
            // The durable pending marker is retained for reconciliation.
          }
        }
        if (this.entries.get(runId) === entry && entry.pending === update) {
          entry.pending = undefined;
          entry.pendingSettled = undefined;
          if (
            committed &&
            outcome === "accepted" &&
            authority &&
            entry.publication &&
            "expectedHeadSha" in entry.publication &&
            entry.publication.expectedHeadSha === update.old
          )
            entry.publication = { ref: authority.ref, expectedHeadSha: update.next };
          else if (!committed) entry.publication = { blocked: "publication outcome is uncertain" };
          entry.generation = Symbol();
        }
        settlePending();
        return committed;
      },
    };
  }

  /** Keep the original run record open for an already-forwarded Git result. */
  async waitForPublication(runId: string, timeoutMs: number): Promise<boolean> {
    const pending = this.entries.get(runId)?.pendingSettled;
    if (!pending) return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void pending.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
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
