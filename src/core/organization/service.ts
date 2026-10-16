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
} from "./contract.js";

/** Facts from an authenticated adapter, never values taken from a message body. */
export interface OrganizationAuthentication {
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
  organization: string;
  actor: OrganizationActor;
  destination: OrganizationEnvelope["destination"];
  action: "read" | "send" | "effect";
  context: OrganizationEnvelope["context"];
}
export type OrganizationAdmissionInput = Pick<
  OrganizationEnvelope,
  "sourceEvent" | "key" | "destination" | "workload" | "target" | "content" | "context"
>;
export type ResolvedOrganization = { organization: string; actor: OrganizationActor };
async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
    },
  ) {}
  async resolve(authentication: OrganizationAuthentication): Promise<ResolvedOrganization | undefined> {
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
      stream: authentication.kind === "human" ? principal : null,
      bindingRevision: 0,
      onBehalfOf: authentication.onBehalfOf ?? null,
    };
    if (authentication.kind === "human" || authentication.onBehalfOf) {
      let binding;
      try {
        binding = await this.options.directory.resolve(authentication.onBehalfOf ?? parsed.data);
      } catch {
        return undefined;
      }
      if (binding.status === "bound") {
        actor.stream = binding.binding.personId;
        actor.bindingRevision = binding.binding.revision;
      } else if (binding.status !== "unknown" || authentication.onBehalfOf) return undefined;
    }
    return { organization, actor };
  }
  async issue(authentication: OrganizationAuthentication, ttlMs: number): Promise<OrganizationResult> {
    const resolved = await this.resolve(authentication);
    if (
      !resolved ||
      !(await this.options.authorize({ ...resolved, destination: { kind: "broad" }, context: [], action: "send" }))
    )
      return { status: "not_found" };
    return this.options.store.execute({ action: "issue", ...resolved, source: authentication.source, ttlMs });
  }
  async admit(
    authentication: OrganizationAuthentication,
    input: OrganizationAdmissionInput,
  ): Promise<OrganizationResult> {
    const resolved = await this.resolve(authentication);
    if (!resolved) return { status: "not_found" };
    // Reserved fleet reconciliation comes from the internal owner, never an ingress payload.
    if (input.workload === "reconciliation") return { status: "invalid" };
    let envelope: OrganizationEnvelope = {
      ...input,
      ...resolved,
      version: 1,
      source: authentication.source,
      content: input.content,
      digest: "0".repeat(64),
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
        destination: input.destination,
        context: input.context,
        action: "send",
      }))
    )
      return { status: "not_found" };
    // Identity-link changes never alter this retry scope or the historical actor.
    envelope.digest = await hash(
      JSON.stringify({
        organization: parsed.data.organization,
        source: parsed.data.source,
        identity: parsed.data.actor.identity,
        kind: parsed.data.actor.kind,
        onBehalfOf: parsed.data.actor.onBehalfOf,
        sourceEvent: parsed.data.sourceEvent,
        key: parsed.data.key,
        destination: parsed.data.destination,
        workload: parsed.data.workload,
        target: parsed.data.target,
        content: parsed.data.content,
        context: parsed.data.context,
      }),
    );
    return this.options.store.execute({ action: "admit", envelope, limits: this.options.limits });
  }
  async stream(authentication: OrganizationAuthentication, after = 0, limit = 100): Promise<OrganizationResult> {
    const resolved = await this.resolve(authentication);
    if (!resolved || !resolved.actor.stream) return { status: "not_found" };
    if (!(await this.options.authorize({ ...resolved, destination: { kind: "broad" }, context: [], action: "read" })))
      return { status: "not_found" };
    let identities = [authentication.onBehalfOf ?? authentication.identity];
    if (resolved.actor.bindingRevision > 0) {
      const result = await this.options.store.execute({
        action: "identities",
        organization: resolved.organization,
        personId: resolved.actor.stream,
      });
      if (result.status !== "identities") return { status: "unavailable" };
      identities = result.identities;
    }
    return this.options.store.execute({
      action: "stream",
      organization: resolved.organization,
      stream: resolved.actor.stream,
      actor: resolved.actor,
      after,
      limit,
      identities,
    });
  }
  async streamForIdentities(
    authentication: OrganizationAuthentication,
    identities: readonly ExternalIdentity[],
    after = 0,
    limit = 100,
  ): Promise<OrganizationResult> {
    const resolved = await this.resolve(authentication);
    if (!resolved || !resolved.actor.stream) return { status: "not_found" };
    if (!(await this.options.authorize({ ...resolved, destination: { kind: "broad" }, context: [], action: "read" })))
      return { status: "not_found" };
    const eligible: ExternalIdentity[] = [];
    for (const identity of identities) {
      const binding = await this.options.directory.resolve(identity);
      if (
        (binding.status === "bound" && binding.binding.personId === resolved.actor.stream) ||
        (binding.status === "unknown" && identityKey(identity) === identityKey(authentication.identity))
      )
        eligible.push(identity);
    }
    return this.options.store.execute({
      action: "stream",
      organization: resolved.organization,
      stream: resolved.actor.stream,
      actor: resolved.actor,
      after,
      limit,
      identities: eligible,
    });
  }
  async delete(authentication: OrganizationAuthentication, receiptId: string): Promise<OrganizationResult> {
    const resolved = await this.resolve(authentication);
    if (
      !resolved ||
      !resolved.actor.stream ||
      !(await this.options.authorize({ ...resolved, destination: { kind: "broad" }, context: [], action: "send" }))
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
  /** Reauthorize the preserved actor immediately before the existing owner consumes its effect key. */
  async authorizeEffect(
    envelope: OrganizationEnvelope,
    lease: { owner: string; generation: number },
  ): Promise<boolean> {
    const current = await this.resolve({
      source: envelope.source,
      identity: envelope.actor.identity,
      kind: envelope.actor.kind,
      organizations: [envelope.organization],
      ...(envelope.actor.onBehalfOf ? { onBehalfOf: envelope.actor.onBehalfOf } : {}),
    });
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
        actor: envelope.actor,
        destination: envelope.destination,
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
    return result.status === "receipt" && result.receipt.status === "pending" && result.receipt.effectKey !== null;
  }
}
