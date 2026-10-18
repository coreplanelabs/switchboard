import type { ExternalIdentity, PersonDirectory } from "../identity/contract.js";
import { identitySchema } from "../identity/contract.js";
import { identityKey } from "../identity/engine.js";
import { redactSecrets } from "../redact.js";
import {
  envelopeSchema,
  type OrganizationActor,
  type OrganizationEnvelope,
  type OrganizationLimits,
  type OrganizationResult,
  type OrganizationSource,
  type OrganizationStore,
  type OrganizationSourceReference,
} from "./contract.js";

/** Facts from an authenticated adapter, never values taken from a message body. */
export interface OrganizationAuthentication {
  /** Set by the trusted adapter. Never copied from admission input. */
  sourceReference?: OrganizationSourceReference;
  source: OrganizationSource;
  identity: ExternalIdentity;
  kind: "human" | "service";
  /** Explicit organization grants from the authenticated CLI/HTTP/MCP credential. */
  organizations?: readonly string[];
  /** Set only after the caller's explicit delegation grant was verified. */
  onBehalfOf?: ExternalIdentity;
}
export interface OrganizationMapping {
  source: OrganizationSource;
  issuer: string;
  tenant: string | null;
  organization: string;
}
export interface OrganizationAuthorization {
  source: OrganizationSource;
  sourceReference?: OrganizationSourceReference;
  organization: string;
  actor: OrganizationActor;
  destination: OrganizationEnvelope["destination"];
  target: OrganizationEnvelope["target"];
  continuation?: OrganizationEnvelope["continuation"];
  action: "read" | "send" | "effect";
  context: OrganizationEnvelope["context"];
}
export type OrganizationAdmissionInput = Pick<
  OrganizationEnvelope,
  | "sourceEvent"
  | "key"
  | "destination"
  | "workload"
  | "target"
  | "content"
  | "context"
  | "continuation"
  | "nativeMedia"
  | "nativeMediaDigest"
>;
export type ResolvedOrganization = { organization: string; actor: OrganizationActor };
function sourceFacts(authentication: OrganizationAuthentication) {
  return {
    source: authentication.source,
    ...(authentication.sourceReference ? { sourceReference: authentication.sourceReference } : {}),
  };
}
async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function payloadDigest(envelope: OrganizationEnvelope): Promise<string> {
  const { credentialDigest: _credentialDigest, ...browserReference } = envelope.sourceReference ?? {};
  const reference =
    envelope.source === "browser"
      ? envelope.sourceReference
        ? browserReference
        : undefined
      : envelope.sourceReference;
  return hash(
    JSON.stringify({
      organization: envelope.organization,
      source: envelope.source,
      identity: envelope.actor.identity,
      kind: envelope.actor.kind,
      onBehalfOf: envelope.actor.onBehalfOf,
      sourceEvent: envelope.sourceEvent,
      key: envelope.key,
      destination: envelope.destination,
      workload: envelope.workload,
      target: envelope.target,
      content: envelope.content,
      ...(envelope.nativeMediaDigest ? { nativeMediaDigest: envelope.nativeMediaDigest } : {}),
      context: envelope.context,
      ...(reference ? { sourceReference: reference } : {}),
      ...(envelope.continuation ? { continuation: envelope.continuation } : {}),
    }),
  );
}
/** The logical identity is shared; model runs and unit owners remain replaceable evidence. */
export class OrganizationService {
  constructor(
    private readonly options: {
      store: OrganizationStore;
      directory: PersonDirectory;
      mappings: readonly OrganizationMapping[];
      limits: OrganizationLimits;
      authorize: (input: OrganizationAuthorization) => Promise<boolean>;
      admissionAvailable?: () => Promise<boolean>;
      currentIdentityRead?: (
        identity: ExternalIdentity,
        reference?: OrganizationSourceReference,
        onBehalfOf?: ExternalIdentity | null,
      ) => Promise<
        | "allowed"
        | "denied"
        | "unavailable"
        | { status: "allowed" | "denied" | "unavailable"; policyFingerprint?: string }
      >;
    },
  ) {}
  get receiptRetentionMs(): number {
    return this.options.limits.receiptTtlMs;
  }
  async resolve(
    authentication: OrganizationAuthentication,
    requireProof = false,
  ): Promise<ResolvedOrganization | undefined> {
    return this.resolveCurrent(authentication, requireProof);
  }
  private async resolveCurrent(
    authentication: OrganizationAuthentication,
    requireProof: boolean,
  ): Promise<ResolvedOrganization | undefined> {
    const parsed = identitySchema.safeParse(authentication.identity);
    if (!parsed.success) return undefined;
    const matches = this.options.mappings.filter(
      (mapping) =>
        mapping.source === authentication.source &&
        mapping.issuer === parsed.data.issuer &&
        mapping.tenant === parsed.data.tenant,
    );
    const orgs = new Set(matches.map((mapping) => mapping.organization));
    if (orgs.size !== 1) return undefined;
    const organization = [...orgs][0];
    if (["cli", "http", "mcp"].includes(authentication.source) && !authentication.organizations?.includes(organization))
      return undefined;
    if (authentication.onBehalfOf && authentication.kind !== "service") return undefined;
    const principal = `${authentication.source}:${identityKey(parsed.data)}`;
    const actor: OrganizationActor = {
      identity: parsed.data,
      kind: authentication.kind,
      principal,
      stream: authentication.kind === "human" || authentication.onBehalfOf ? principal : null,
      bindingRevision: 0,
      onBehalfOf: authentication.onBehalfOf ?? null,
    };
    if (authentication.kind === "human" || authentication.onBehalfOf) {
      let binding;
      try {
        binding = await this.options.directory.resolve(authentication.onBehalfOf ?? parsed.data);
      } catch {
        if (requireProof) throw new Error("Current organization identity proof is unavailable.");
        return undefined;
      }
      if (requireProof && binding.status === "unavailable")
        throw new Error("Current organization identity proof is unavailable.");
      if (binding.status === "bound") {
        actor.stream = binding.binding.personId;
        actor.bindingRevision = binding.binding.revision;
      } else if (binding.status === "revoked") {
        actor.bindingRevision = binding.revision;
      } else if (binding.status !== "unknown") return undefined;
    }
    return { organization, actor };
  }
  async issue(authentication: OrganizationAuthentication, ttlMs: number): Promise<OrganizationResult> {
    if (this.options.admissionAvailable && !(await this.options.admissionAvailable())) return { status: "unavailable" };
    const resolved = await this.resolve(authentication);
    if (
      !resolved ||
      !(await this.options.authorize({
        ...resolved,
        ...sourceFacts(authentication),
        destination: { kind: "broad" },
        target: null,
        context: [],
        action: "send",
      }))
    )
      return { status: "not_found" };
    return this.options.store.execute({ action: "issue", ...resolved, source: authentication.source, ttlMs });
  }
  async admit(
    authentication: OrganizationAuthentication,
    input: OrganizationAdmissionInput,
  ): Promise<OrganizationResult> {
    if (this.options.admissionAvailable && !(await this.options.admissionAvailable())) return { status: "unavailable" };
    const resolved = await this.resolve(authentication);
    if (!resolved) return { status: "not_found" };
    // Reserved fleet reconciliation comes from the internal owner, never an ingress payload.
    if (input.workload === "reconciliation") return { status: "invalid" };
    let envelope: OrganizationEnvelope = {
      sourceEvent: input.sourceEvent,
      key: input.key,
      destination: input.destination,
      workload: input.workload,
      target: input.target,
      context: input.context,
      ...(input.continuation ? { continuation: input.continuation } : {}),
      ...resolved,
      version: 1,
      source: authentication.source,
      content: input.content,
      ...(input.nativeMedia ? { nativeMedia: input.nativeMedia } : {}),
      ...(input.nativeMediaDigest ? { nativeMediaDigest: input.nativeMediaDigest } : {}),
      digest: "0".repeat(64),
      ...(authentication.sourceReference ? { sourceReference: authentication.sourceReference } : {}),
    };
    const parsed = envelopeSchema.safeParse(envelope);
    if (!parsed.success) return { status: "invalid" };
    const sanitized = envelopeSchema.safeParse({ ...parsed.data, content: redactSecrets(parsed.data.content) });
    if (!sanitized.success) return { status: "invalid" };
    envelope = sanitized.data;
    // GitHub is a bound human's unit-answer surface, never broad organization chat.
    if (
      authentication.source === "github" &&
      (input.destination.kind !== "thread" ||
        !input.target ||
        resolved.actor.bindingRevision === 0 ||
        authentication.kind !== "human")
    )
      return { status: "not_found" };

    if (
      !(await this.options.authorize({
        ...resolved,
        ...sourceFacts(authentication),
        destination: input.destination,
        target: parsed.data.target,
        ...(parsed.data.continuation ? { continuation: parsed.data.continuation } : {}),
        context: input.context,
        action: "send",
      }))
    )
      return { status: "not_found" };
    // Identity-link changes never alter this retry scope or the historical actor.
    envelope.digest = await payloadDigest(parsed.data);
    return this.options.store.execute({ action: "admit", envelope, limits: this.options.limits });
  }
  /** Browser receipt lookup for its exact credential identity, never person aliases or a replay. */
  async receiptStatus(authentication: OrganizationAuthentication, key: string): Promise<OrganizationResult> {
    if (authentication.source !== "browser" || authentication.kind !== "human" || authentication.onBehalfOf)
      return { status: "not_found" };
    if (!envelopeSchema.shape.key.safeParse(key).success) return { status: "invalid" };
    const resolved = await this.resolve(authentication, true);
    const canRead = (value: ResolvedOrganization) =>
      this.options.authorize({
        ...value,
        ...sourceFacts(authentication),
        destination: { kind: "broad" },
        target: null,
        context: [],
        action: "read",
      });
    if (!resolved || !(await canRead(resolved))) return { status: "not_found" };
    const original = await this.options.store.execute({
      action: "submission",
      ...resolved,
      source: authentication.source,
      key,
    });
    if (original.status !== "submission") return original;
    if (
      original.receipt.organization !== resolved.organization ||
      original.receipt.source !== authentication.source ||
      identityKey(original.receipt.actor.identity) !== identityKey(authentication.identity) ||
      original.receipt.actor.kind !== authentication.kind ||
      JSON.stringify(original.receipt.actor.onBehalfOf) !== JSON.stringify(authentication.onBehalfOf ?? null)
    )
      return { status: "not_found" };
    const fresh = await this.resolve(authentication, true);
    if (
      !fresh ||
      fresh.organization !== resolved.organization ||
      fresh.actor.principal !== resolved.actor.principal ||
      !(await canRead(fresh))
    )
      return { status: "not_found" };
    return { status: "receipt", receipt: original.receipt, duplicate: true };
  }
  /** Replay is a read of the original disposition, not a new question admission. */
  async replay(
    authentication: OrganizationAuthentication,
    input: Pick<
      OrganizationAdmissionInput,
      "key" | "content" | "context" | "destination" | "continuation" | "nativeMediaDigest"
    > & {
      revision?: number;
    },
  ): Promise<OrganizationResult | undefined> {
    const resolved = await this.resolve(authentication);
    if (!resolved) return { status: "not_found" };
    const original = await this.options.store.execute({
      action: "submission",
      ...resolved,
      source: authentication.source,
      key: input.key,
    });
    if (original.status === "not_found") return undefined;
    if (original.status !== "submission") return original;
    if (
      original.envelope.sourceReference?.browserRevision !== undefined &&
      input.revision !== original.envelope.sourceReference.browserRevision
    )
      return { status: "conflict" };
    if (
      !(await this.options.authorize({
        ...resolved,
        ...sourceFacts(authentication),
        destination: original.envelope.destination,
        target: null,
        context: original.envelope.context,
        action: "read",
      }))
    )
      return { status: "not_found" };
    if (
      authentication.kind !== original.envelope.actor.kind ||
      JSON.stringify(authentication.onBehalfOf ?? null) !== JSON.stringify(original.envelope.actor.onBehalfOf)
    )
      return { status: "conflict" };
    if (
      authentication.source !== "browser" &&
      authentication.sourceReference?.credentialDigest !== original.envelope.sourceReference?.credentialDigest
    )
      return { status: "conflict" };
    const compared = envelopeSchema.safeParse({
      ...original.envelope,
      content: input.content,
      nativeMediaDigest: input.nativeMediaDigest,
      context: input.context,
      destination: input.destination,
      continuation: input.continuation,
    });
    if (!compared.success) return { status: "invalid" };
    if ((await payloadDigest(compared.data)) !== original.receipt.digest) return { status: "conflict" };
    return { status: "receipt", receipt: original.receipt, duplicate: true };
  }
  private async filterSources(resolved: ResolvedOrganization, result: OrganizationResult): Promise<OrganizationResult> {
    if (result.status !== "stream" && result.status !== "stream_tail") return result;
    if (!this.options.currentIdentityRead) return { status: "unavailable" };
    const entries: typeof result.entries = [];
    for (const entry of result.entries) {
      const original = await this.options.store.execute({
        action: "provenance",
        ...resolved,
        receiptId: entry.receiptId,
      });
      if (original.status !== "provenance") return { status: "unavailable" };
      const decision = await this.options.currentIdentityRead(
        original.provenance.actor.identity,
        original.provenance.sourceReference,
        original.provenance.actor.onBehalfOf,
      );
      const status = typeof decision === "string" ? decision : decision.status;
      if (status === "unavailable") return { status: "unavailable" };
      if (status === "allowed") {
        const { authorId: _suppliedAuthor, ...stored } = entry;
        const authorId = entry.role === "user" ? original.provenance.sourceReference?.userId : undefined;
        entries.push({ ...stored, ...(authorId ? { authorId } : {}) });
      }
    }
    return { ...result, entries };
  }
  async stream(authentication: OrganizationAuthentication, after = 0, limit = 100): Promise<OrganizationResult> {
    return this.readStream(authentication, "stream", after, limit);
  }
  async streamTail(
    authentication: OrganizationAuthentication,
    limit = 100,
    before?: number,
  ): Promise<OrganizationResult> {
    return this.readStream(authentication, "tail", before, limit);
  }
  private async readStream(
    authentication: OrganizationAuthentication,
    action: "stream" | "tail",
    position: number | undefined,
    limit: number,
  ): Promise<OrganizationResult> {
    const resolved = await this.resolve(authentication);
    if (!resolved || !resolved.actor.stream) return { status: "not_found" };
    if (
      !(await this.options.authorize({
        ...resolved,
        ...sourceFacts(authentication),
        destination: { kind: "broad" },
        target: null,
        context: [],
        action: "read",
      }))
    )
      return { status: "not_found" };
    let identities = [authentication.onBehalfOf ?? authentication.identity];
    if (resolved.actor.bindingRevision > 0 && resolved.actor.stream !== resolved.actor.principal) {
      const result = await this.options.store.execute({
        action: "identities",
        organization: resolved.organization,
        personId: resolved.actor.stream,
      });
      if (result.status !== "identities") return { status: "unavailable" };
      identities = result.identities;
    }
    const result = await this.options.store.execute({
      ...(action === "tail"
        ? { action: "tail", ...(position !== undefined ? { before: position } : {}) }
        : { action: "stream", after: position ?? 0 }),
      organization: resolved.organization,
      stream: resolved.actor.stream,
      actor: resolved.actor,
      limit,
      identities,
    });
    return this.filterSources(resolved, result);
  }
  async streamForIdentities(
    authentication: OrganizationAuthentication,
    identities: readonly ExternalIdentity[],
    after = 0,
    limit = 100,
  ): Promise<OrganizationResult> {
    const resolved = await this.resolve(authentication);
    if (!resolved || !resolved.actor.stream) return { status: "not_found" };
    if (
      !(await this.options.authorize({
        ...resolved,
        ...sourceFacts(authentication),
        destination: { kind: "broad" },
        target: null,
        context: [],
        action: "read",
      }))
    )
      return { status: "not_found" };
    const eligible: ExternalIdentity[] = [];
    for (const identity of identities) {
      const binding = await this.options.directory.resolve(identity);
      if (
        (binding.status === "bound" && binding.binding.personId === resolved.actor.stream) ||
        ((binding.status === "unknown" ||
          (binding.status === "revoked" && resolved.actor.stream === resolved.actor.principal)) &&
          identityKey(identity) === identityKey(authentication.onBehalfOf ?? authentication.identity))
      )
        eligible.push(identity);
    }
    const result = await this.options.store.execute({
      action: "stream",
      organization: resolved.organization,
      stream: resolved.actor.stream,
      actor: resolved.actor,
      after,
      limit,
      identities: eligible,
    });
    return this.filterSources(resolved, result);
  }
  async delete(authentication: OrganizationAuthentication, receiptId: string): Promise<OrganizationResult> {
    const resolved = await this.resolve(authentication);
    if (
      !resolved ||
      !resolved.actor.stream ||
      !(await this.options.authorize({
        ...resolved,
        ...sourceFacts(authentication),
        destination: { kind: "broad" },
        target: null,
        context: [],
        action: "send",
      }))
    )
      return { status: "not_found" };
    return this.options.store.execute({
      action: "delete",
      organization: resolved.organization,
      stream: resolved.actor.stream,
      actor: resolved.actor,
      receiptId,
    });
  }
  private async authorizePreserved(envelope: OrganizationEnvelope, action: "read" | "effect"): Promise<boolean> {
    const current = await this.resolveCurrent(
      {
        source: envelope.source,
        identity: envelope.actor.identity,
        kind: envelope.actor.kind,
        organizations: [envelope.organization],
        ...(envelope.actor.onBehalfOf ? { onBehalfOf: envelope.actor.onBehalfOf } : {}),
      },
      true,
    );
    return (
      !!current &&
      current.organization === envelope.organization &&
      current.actor.stream === envelope.actor.stream &&
      current.actor.bindingRevision === envelope.actor.bindingRevision &&
      (await this.options.authorize({
        ...current,
        source: envelope.source,
        ...(envelope.sourceReference ? { sourceReference: envelope.sourceReference } : {}),
        destination: envelope.destination,
        target: envelope.target,
        ...(envelope.continuation ? { continuation: envelope.continuation } : {}),
        context: envelope.context,
        action,
      }))
    );
  }
  /** Delayed owner output still needs current recipient permission. */
  async authorizeReply(envelope: OrganizationEnvelope): Promise<boolean> {
    return this.authorizePreserved(envelope, "read");
  }
  /** Scheduling never saves organization authority for a later execution. */
  async authorizeExecution(envelope: OrganizationEnvelope): Promise<boolean> {
    return this.authorizePreserved(envelope, "effect");
  }
  /** Reauthorize the preserved actor immediately before the existing owner consumes its effect key. */
  async authorizeEffect(
    envelope: OrganizationEnvelope,
    lease: { owner: string; generation: number },
  ): Promise<boolean> {
    const current = await this.resolveCurrent(
      {
        source: envelope.source,
        identity: envelope.actor.identity,
        kind: envelope.actor.kind,
        organizations: [envelope.organization],
        ...(envelope.actor.onBehalfOf ? { onBehalfOf: envelope.actor.onBehalfOf } : {}),
      },
      true,
    );
    if (
      !current ||
      current.organization !== envelope.organization ||
      current.actor.stream !== envelope.actor.stream ||
      current.actor.bindingRevision !== envelope.actor.bindingRevision
    )
      return false;
    if (
      !(await this.options.authorize({
        organization: envelope.organization,
        source: envelope.source,
        ...(envelope.sourceReference ? { sourceReference: envelope.sourceReference } : {}),
        actor: envelope.actor,
        destination: envelope.destination,
        target: envelope.target,
        ...(envelope.continuation ? { continuation: envelope.continuation } : {}),
        context: envelope.context,
        action: "effect",
      }))
    )
      return false;
    const result = await this.options.store.execute({
      action: "effect",
      organization: envelope.organization,
      source: envelope.source,
      key: envelope.key,
      actor: envelope.actor,
      ...lease,
    });
    if (result.status === "unavailable") throw new Error("Current organization effect proof is unavailable.");
    return result.status === "receipt" && result.receipt.status === "pending" && result.receipt.effectKey !== null;
  }
}
