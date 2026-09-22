// Runner-owned side effects (record 0074, the push unit): a child supplies one
// closed command, while the runner resolves current facts, authorizes and
// fences them, prepares the exact object, performs at most one write, and
// records the typed outcome. Push is the first command on the port.

export type PushGateSet = "changed-set";

export interface PushCommand {
  kind: "push";
  repository: string;
  branch: string;
  expectedHead: string;
  base: string;
  gateSet: PushGateSet;
}

export interface EffectEnvelope {
  /** Minted and persisted by the caller before the first dispatch, then reused. */
  effectId: string;
  command: PushCommand;
}

export interface PushFacts {
  /** Canonical `owner/name` resolved from the admitted checkout. */
  repository: string;
  /** The effective endpoint resolved by the runner, never supplied by the child. */
  endpoint: string;
  /** The one local source and run-owned remote destination branch. */
  branch: string;
  head: string;
  tree: string;
  clean: boolean;
  /** The destination's current sha, used as the publication lease. */
  remoteHead?: string;
}

export interface PushGateReceipt {
  name: string;
  exitCode: number;
  tree: string;
  clean: boolean;
  tool?: string;
}

export type EffectRefusalReason =
  | "wrong_repository"
  | "wrong_ref"
  | "stale_head"
  | "dirty_tree"
  | "gates_missing"
  | "gate_failed"
  | "base_moved"
  | "not_owner"
  | "not_authorized"
  | "credential_unavailable"
  | "transport_refused"
  | "effect_id_reused";

export interface PushReceipt {
  effectId: string;
  kind: "push";
  outcome: "succeeded";
  actor: string;
  repository: string;
  resource: string;
  destination: string;
  before?: string;
  after: string;
  tree: string;
  endpoint: string;
  gates: PushGateReceipt[];
  by: "runner";
  occurredAt: number;
  /** Recording/shadow receipts are observations and never publication authority. */
  shadow?: true;
}

export interface EffectRefusal {
  effectId: string;
  kind: "push";
  outcome: "refused";
  reason: EffectRefusalReason;
  actor: string;
  repository?: string;
  resource?: string;
  expected?: string;
  current?: string;
  occurredAt: number;
}

export interface EffectRetryable {
  effectId: string;
  kind: "push";
  outcome: "retryable";
  reason: "reconciliation_unavailable";
  actor: string;
  repository?: string;
  resource?: string;
  occurredAt: number;
}

export type EffectResult = PushReceipt | EffectRefusal | EffectRetryable;

export interface PublishPushRequest {
  endpoint: string;
  source: string;
  destination: string;
  lease?: string;
}

/** Operation adapters owned by the runner. Tests and dry runs provide fakes;
 * production binds them to the admitted checkout, policy table, gate runner,
 * git transport and durable run ledger. */
export interface RunEffectsDeps {
  /** Atomically stores the first envelope for this id and returns that standing envelope. */
  persistEnvelope(envelope: EffectEnvelope): Promise<EffectEnvelope>;
  priorResult(effectId: string): Promise<unknown>;
  resolvePush(command: PushCommand): Promise<PushFacts>;
  authorizePush(facts: PushFacts, command: PushCommand): Promise<boolean>;
  rebasePush(facts: PushFacts, command: PushCommand): Promise<PushFacts>;
  runPushGates(facts: PushFacts, gateSet: PushGateSet): Promise<PushGateReceipt[]>;
  publishPush(request: PublishPushRequest): Promise<{ previous?: string; published: string }>;
  /** Reads the destination after an ambiguous transport result; undefined means it did not match. */
  reconcilePush(request: PublishPushRequest): Promise<string | undefined>;
  /** Durably stores an authoritative success or refusal. Retryable outcomes are never stored. */
  recordResult(result: PushReceipt | EffectRefusal): Promise<void>;
  /** Appends a non-authoritative audit event without replacing the standing result. */
  auditResult?(result: EffectRefusal): Promise<void>;
  occurredAt(): number;
  actor: string;
}

export interface RunEffects {
  execute(envelope: EffectEnvelope): Promise<EffectResult>;
}

function isStoredEffectResult(value: unknown, effectId: string): value is PushReceipt | EffectRefusal {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<EffectResult>;
  return (
    result.effectId === effectId &&
    result.kind === "push" &&
    (result.outcome === "succeeded" || result.outcome === "refused")
  );
}

function sameCommand(a: PushCommand, b: PushCommand): boolean {
  return (
    a.kind === b.kind &&
    a.repository === b.repository &&
    a.branch === b.branch &&
    a.expectedHead === b.expectedHead &&
    a.base === b.base &&
    a.gateSet === b.gateSet
  );
}

function endpointRepository(endpoint: string): string | undefined {
  const scp = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(endpoint.trim());
  if (scp) return scp[1];
  try {
    const url = new URL(endpoint);
    if (url.hostname.toLowerCase() !== "github.com") return undefined;
    return url.pathname.replace(/^\//, "").replace(/\.git$/, "");
  } catch {
    return undefined;
  }
}

function resolutionRefusal(command: PushCommand, facts: PushFacts): EffectRefusalReason | undefined {
  if (facts.repository !== command.repository || endpointRepository(facts.endpoint) !== command.repository)
    return "wrong_repository";
  if (facts.branch !== command.branch) return "wrong_ref";
  return undefined;
}

abstract class BaseRunEffects implements RunEffects {
  constructor(protected readonly deps: RunEffectsDeps) {}

  protected priorIsAuthoritative(_result: PushReceipt | EffectRefusal): boolean {
    return true;
  }

  protected abstract perform(
    facts: PushFacts,
    command: PushCommand,
    gates: PushGateReceipt[],
  ): Promise<{ before?: string; after: string; shadow?: true }>;

  protected async reconcileAfterFailure(_facts: PushFacts): Promise<string | undefined> {
    return undefined;
  }

  async execute(envelope: EffectEnvelope): Promise<EffectResult> {
    // The durable store keeps the first envelope immutable. No fact resolution,
    // gate or transport may run until that write has been acknowledged.
    const standing = await this.deps.persistEnvelope(envelope);
    if (!sameCommand(standing.command, envelope.command)) {
      const reuse = this.refusal(envelope, "effect_id_reused");
      await this.deps.auditResult?.(reuse);
      return reuse;
    }
    const prior = await this.deps.priorResult(envelope.effectId);
    if (isStoredEffectResult(prior, envelope.effectId) && this.priorIsAuthoritative(prior)) return prior;

    const { command } = envelope;
    const initial = await this.deps.resolvePush(command);
    const resolutionReason = resolutionRefusal(command, initial);
    if (resolutionReason) return this.refuse(envelope, resolutionReason, initial);
    if (initial.head !== command.expectedHead)
      return this.refuse(envelope, "stale_head", initial, command.expectedHead, initial.head);
    if (!initial.clean) return this.refuse(envelope, "dirty_tree", initial);

    if (!(await this.deps.authorizePush(initial, command))) return this.refuse(envelope, "not_authorized", initial);

    const prepared = await this.deps.rebasePush(initial, command);
    const preparedReason = resolutionRefusal(command, prepared);
    if (preparedReason) return this.refuse(envelope, preparedReason, prepared);
    if (!prepared.clean) return this.refuse(envelope, "dirty_tree", prepared);

    const gates = await this.deps.runPushGates(prepared, command.gateSet);
    const failed = gates.find((gate) => gate.exitCode !== 0);
    if (failed) return this.refuse(envelope, "gate_failed", prepared, "0", String(failed.exitCode));
    if (gates.length === 0 || gates.some((gate) => gate.tree !== prepared.tree || gate.clean !== true))
      return this.refuse(envelope, "gates_missing", prepared);

    // Resolve every publication fact again after the gates. A gate may run a
    // formatter or another mutating command; its successful exit is not proof
    // that the checkout still names the tree it received.
    const current = await this.deps.resolvePush(command);
    const currentReason = resolutionRefusal(command, current);
    if (currentReason) return this.refuse(envelope, currentReason, current);
    if (!current.clean) return this.refuse(envelope, "dirty_tree", current);
    if (current.head !== prepared.head || current.tree !== prepared.tree)
      return this.refuse(envelope, "gates_missing", current, prepared.tree, current.tree);
    if (current.remoteHead !== prepared.remoteHead)
      return this.refuse(envelope, "base_moved", current, prepared.remoteHead, current.remoteHead);

    let performed: { before?: string; after: string; shadow?: true };
    try {
      performed = await this.perform(current, command, gates);
    } catch {
      // A transport can update the ref and lose its response. The ref and
      // intended commit are canonical reconciliation facts for git effects.
      // An unavailable read proves nothing and remains retryable under this id;
      // only a successful mismatching read is authoritative refusal evidence.
      let reconciled: string | undefined;
      try {
        reconciled = await this.reconcileAfterFailure(current);
      } catch {
        return this.retryable(envelope, current);
      }
      if (reconciled?.toLowerCase() === current.head.toLowerCase())
        return this.succeed(envelope, current, gates, {
          ...(current.remoteHead !== undefined ? { before: current.remoteHead } : {}),
          after: reconciled,
        });
      return this.refuse(envelope, "transport_refused", current);
    }
    // Receipt persistence is intentionally outside the transport catch. Once
    // publication succeeded, a ledger failure must propagate unrecorded so
    // recovery reconciles it; it must never be rewritten as transport_refused.
    return this.succeed(envelope, current, gates, performed);
  }

  private async succeed(
    envelope: EffectEnvelope,
    facts: PushFacts,
    gates: PushGateReceipt[],
    performed: { before?: string; after: string; shadow?: true },
  ): Promise<PushReceipt> {
    const receipt: PushReceipt = {
      effectId: envelope.effectId,
      kind: "push",
      outcome: "succeeded",
      actor: this.deps.actor,
      repository: facts.repository,
      resource: `${facts.repository}#refs/heads/${facts.branch}`,
      destination: `refs/heads/${facts.branch}`,
      ...(performed.before !== undefined ? { before: performed.before } : {}),
      after: performed.after,
      tree: facts.tree,
      endpoint: facts.endpoint,
      gates,
      by: "runner",
      occurredAt: this.deps.occurredAt(),
      ...(performed.shadow ? { shadow: true as const } : {}),
    };
    await this.deps.recordResult(receipt);
    return receipt;
  }

  private retryable(envelope: EffectEnvelope, facts?: PushFacts): EffectRetryable {
    return {
      effectId: envelope.effectId,
      kind: "push",
      outcome: "retryable",
      reason: "reconciliation_unavailable",
      actor: this.deps.actor,
      ...(facts?.repository ? { repository: facts.repository } : {}),
      ...(facts?.branch ? { resource: `${facts.repository}#refs/heads/${facts.branch}` } : {}),
      occurredAt: this.deps.occurredAt(),
    };
  }

  private refusal(
    envelope: EffectEnvelope,
    reason: EffectRefusalReason,
    facts?: PushFacts,
    expected?: string,
    current?: string,
  ): EffectRefusal {
    return {
      effectId: envelope.effectId,
      kind: "push",
      outcome: "refused",
      reason,
      actor: this.deps.actor,
      ...(facts?.repository ? { repository: facts.repository } : {}),
      ...(facts?.branch ? { resource: `${facts.repository}#refs/heads/${facts.branch}` } : {}),
      ...(expected !== undefined ? { expected } : {}),
      ...(current !== undefined ? { current } : {}),
      occurredAt: this.deps.occurredAt(),
    };
  }

  private async refuse(
    envelope: EffectEnvelope,
    reason: EffectRefusalReason,
    facts?: PushFacts,
    expected?: string,
    current?: string,
  ): Promise<EffectRefusal> {
    const refusal = this.refusal(envelope, reason, facts, expected, current);
    await this.deps.recordResult(refusal);
    return refusal;
  }
}

export class ProductionRunEffects extends BaseRunEffects {
  protected override priorIsAuthoritative(result: PushReceipt | EffectRefusal): boolean {
    return result.outcome !== "succeeded" || result.shadow !== true;
  }

  protected override async reconcileAfterFailure(facts: PushFacts): Promise<string | undefined> {
    return this.deps.reconcilePush({
      endpoint: facts.endpoint,
      source: facts.head,
      destination: `refs/heads/${facts.branch}`,
      ...(facts.remoteHead !== undefined ? { lease: facts.remoteHead } : {}),
    });
  }

  protected async perform(facts: PushFacts): Promise<{ before?: string; after: string }> {
    const published = await this.deps.publishPush({
      endpoint: facts.endpoint,
      source: facts.head,
      destination: `refs/heads/${facts.branch}`,
      ...(facts.remoteHead !== undefined ? { lease: facts.remoteHead } : {}),
    });
    return { ...(published.previous !== undefined ? { before: published.previous } : {}), after: published.published };
  }
}

/** Shadow implementation: it runs the same finite resolve/authorize/fence/gate
 * lifecycle, records the decision, and deliberately has no transport call. */
export class RecordingRunEffects extends BaseRunEffects {
  protected async perform(facts: PushFacts): Promise<{ before?: string; after: string; shadow: true }> {
    return { ...(facts.remoteHead !== undefined ? { before: facts.remoteHead } : {}), after: facts.head, shadow: true };
  }
}
