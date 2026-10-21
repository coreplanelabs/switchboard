import { authorize, effectiveGrants } from "../core/authz/authorize.js";
import { CLI_ACTOR, resolveActor, resolveChatActor } from "../core/authz/actor.js";
import { authorizeSteerOwner } from "../core/dispatch/authorize.js";
import { holdsAll } from "../core/authz/viewAs.js";
import { identityKey } from "../core/identity/engine.js";
import { isSlackProfileId } from "../core/names.js";
import { envelopeSchema, sourceReferenceSchema } from "../core/organization/contract.js";
import { accessActor } from "./commandHttp.js";
import { connectionIdentity, mcpRequester, type McpIdentity } from "./mcpApproval.js";
import { toCaller } from "./mcp.js";
import { digestBearer } from "../mcp/personalTokens.js";
import { personalTokenForAuthentication } from "../core/personalToken.js";
import type { Actor, Grants } from "../core/authz/types.js";
import type { ExternalIdentity, PersonDirectory } from "../core/identity/contract.js";
import type {
  OrganizationEnvelope,
  OrganizationSource,
  OrganizationSourceReference,
  OrganizationStore,
} from "../core/organization/contract.js";
import type { OrganizationAuthentication, OrganizationMapping } from "../core/organization/service.js";
import type { RunLedger } from "../core/runLedger/ledger.js";
import type { IncomingMessage, SlackDirectAudience } from "../core/types.js";
import type { AccessIdentity } from "./accessAuth.js";
import type { IngressConfig, IngressIdentity } from "./http.js";
import type { PersonalTokenStore } from "../mcp/personalTokens.js";
import type { PersonLookup } from "./requester.js";
import { warnRequesterLabel } from "./runRequester.js";

/** A current native authentication result. The host verifies the issuer and
 * membership; neither a saved subject nor a directory link can supply it. */
export interface VerifiedOrganizationSource {
  status: "verified";
  identity: ExternalIdentity;
  actorId: string;
  kind: "human" | "service";
  organizationMember: boolean;
  privateSource: boolean;
  epoch: string;
  access?: AccessIdentity;
  directAudience?: SlackDirectAudience;
  name?: string;
}
export type NativeOrganizationProof = VerifiedOrganizationSource | { status: "fenced" | "unavailable" };
export interface OrganizationNativeEvidence {
  source: OrganizationSource;
  identity: ExternalIdentity | IngressIdentity;
  credentialDigest?: string;
  /** Server-attested explicit delegation, never an incoming body field. */
  onBehalfOf?: ExternalIdentity;
  /** Kept only in the current authenticated host request, never persisted. */
  attestation?: unknown;
}
export interface ResolvedOrganizationAuthentication {
  status: "resolved";
  actor: Actor;
  msg: IncomingMessage;
  authentication: OrganizationAuthentication;
  privateSource: boolean;
  policyFingerprint: string;
  /** Current read policy, independent of the credential that proves the reader. */
  readPolicyFingerprint: string;
}
export type OrganizationAuthenticationResult =
  ResolvedOrganizationAuthentication | { status: "fenced" | "unavailable" };
/** Canonical requester provenance; the current gate digest is needed only
 * when issuing a new answer scope, never to re-credit an admitted reply. */
export type OrganizationQuestionOwner =
  | {
      status: "proved";
      requester: ExternalIdentity;
      sourceReference: OrganizationSourceReference;
      repo: string;
      questionDigest?: string;
    }
  | { status: "fenced" | "unavailable" };
export interface OrganizationMetadataAuthentication {
  resolveEnvelope(envelope: OrganizationEnvelope): Promise<OrganizationAuthenticationResult>;
  resolveAuthorization(
    input: import("../core/organization/service.js").OrganizationAuthorization,
  ): Promise<OrganizationAuthenticationResult>;
}

export interface OrganizationAuthenticationOptions {
  organization: string;
  mappings: readonly OrganizationMapping[];
  grantsFor(id: string): Grants;
  auth(): IngressConfig;
  personalTokens?: PersonalTokenStore;
  /** Fixed installation pin for protected standing device delegation. */
  personalApproval?: { issuer: string; audience: string };
  directory: PersonDirectory;
  /** Current Slack profile lookup for an email proved by this MCP credential. */
  personByEmail?: PersonLookup;
  store: OrganizationStore;
  ledger?: Pick<RunLedger, "readIngressByRun">;
  channelsOf?(actorId: string): Promise<ReadonlySet<string> | "unknown">;
  currentBrowser(
    identity: ExternalIdentity,
    attestation?: unknown,
    reference?: OrganizationSourceReference,
  ): Promise<NativeOrganizationProof>;
  currentSlack(
    identity: ExternalIdentity,
    attestation?: unknown,
    reference?: OrganizationSourceReference,
  ): Promise<NativeOrganizationProof>;
  currentGithub?(
    identity: ExternalIdentity,
    attestation?: unknown,
    reference?: OrganizationSourceReference,
  ): Promise<NativeOrganizationProof>;
  currentCli?(
    identity: ExternalIdentity,
    attestation?: unknown,
    reference?: OrganizationSourceReference,
  ): Promise<NativeOrganizationProof>;
  currentMcp?(
    identity: ExternalIdentity | IngressIdentity,
    attestation?: unknown,
    reference?: OrganizationSourceReference,
  ): Promise<NativeOrganizationProof>;
  questionOwner?(unitKey: string): Promise<OrganizationQuestionOwner>;
  verifyDelegation?(
    source: OrganizationSource,
    identity: ExternalIdentity,
    person: ExternalIdentity,
  ): Promise<boolean | "unknown">;
}

/** Current source lookup and policy inputs for the host's one authorization table. */
export function createOrganizationAuthentication(options: OrganizationAuthenticationOptions) {
  const denied = (status: "fenced" | "unavailable" = "fenced"): OrganizationAuthenticationResult => ({ status });
  function mapped(source: OrganizationSource, identity: ExternalIdentity): boolean {
    const matches = options.mappings.filter(
      (m) => m.source === source && m.issuer === identity.issuer && m.tenant === identity.tenant,
    );
    return matches.length > 0 && matches.every((m) => m.organization === options.organization);
  }
  function external(
    source: OrganizationSource,
    identity: ExternalIdentity | IngressIdentity,
  ): ExternalIdentity | undefined {
    if ("issuer" in identity) return mapped(source, identity) ? identity : undefined;
    const all = options.mappings.filter((m) => m.source === source && m.organization === options.organization);
    // The added SSO realm must not make existing raw device/static keys ambiguous.
    const installed = all.filter((m) => m.issuer === `installation:${options.organization}:${source}`);
    const mappings = source === "mcp" && installed.length ? installed : all;
    const realms = new Map(mappings.map((m) => [JSON.stringify([m.issuer, m.tenant]), m]));
    if (realms.size !== 1) return;
    const realm = [...realms.values()][0]!;
    return { issuer: realm.issuer, tenant: realm.tenant, subject: identity.subject };
  }
  function personIdentity(userId: string): ExternalIdentity | undefined {
    const source = userId.startsWith("access:") ? "browser" : userId.startsWith("slack:") ? "slack" : undefined;
    if (!source) return;
    return external(source, { subject: userId.slice(userId.indexOf(":") + 1) });
  }
  async function human(
    identity: ExternalIdentity,
    attestation?: unknown,
    reference?: OrganizationSourceReference,
  ): Promise<NativeOrganizationProof> {
    if (mapped("browser", identity)) return options.currentBrowser(identity, attestation, reference);
    if (mapped("slack", identity)) return options.currentSlack(identity, attestation, reference);
    if (mapped("github", identity))
      return options.currentGithub?.(identity, attestation, reference) ?? { status: "unavailable" };
    return { status: "fenced" };
  }
  async function actorFor(
    proof: VerifiedOrganizationSource,
    reference: OrganizationSourceReference,
  ): Promise<Actor | undefined> {
    let actor: Actor;
    if (proof.access) {
      actor = accessActor(proof.access, options.grantsFor);
      if (actor.id !== proof.actorId || actor.kind !== "user") return;
      if (proof.access.viewAs && holdsAll(actor)) {
        const viewedIdentity = personIdentity(proof.access.viewAs);
        if (!viewedIdentity) return;
        const viewed = await human(viewedIdentity, undefined, reference);
        if (viewed.status !== "verified" || viewed.kind !== "human") return;
        const person = await actorFor({ ...viewed, access: undefined }, reference);
        if (!person) return;
        actor = { ...actor, onBehalfOf: person, viewingAs: { id: person.id }, asUser: { id: person.id } };
      }
    } else if (proof.actorId === CLI_ACTOR.id)
      actor = resolveActor({ surface: "cli", subjectId: "local" }, options.grantsFor);
    else
      actor = resolveChatActor(
        { userId: proof.actorId, channelId: reference.channelId, threadKey: reference.threadKey },
        options.grantsFor,
      );
    const memberOf = proof.kind === "human" && options.channelsOf ? await options.channelsOf(proof.actorId) : "unknown";
    return {
      ...actor,
      kind: proof.kind === "service" && proof.actorId !== CLI_ACTOR.id ? "service" : actor.kind,
      self: [actor.id],
      origin: { channelId: reference.channelId, threadKey: reference.threadKey },
      ...(proof.organizationMember && proof.kind === "human"
        ? { memberOfOrganizations: new Set([options.organization]) }
        : {}),
      ...(memberOf === "unknown" ? {} : { memberOf }),
    };
  }
  async function resolve(
    msg: IncomingMessage,
    evidence: OrganizationNativeEvidence,
    original?: OrganizationSourceReference,
  ): Promise<OrganizationAuthenticationResult> {
    try {
      let identity = external(evidence.source, evidence.identity);
      if (!identity) return denied();
      const reference: OrganizationSourceReference = {
        actorId:
          original?.actorId ??
          (evidence.source === "http" || evidence.source === "mcp"
            ? evidence.source === "mcp" && "session" in evidence.identity
              ? (msg.authenticatedAs ?? `${evidence.source}:${identity.subject}`)
              : `${evidence.source}:${identity.subject}`
            : evidence.source === "cli"
              ? CLI_ACTOR.id
              : (msg.postedBy ?? msg.userId)),
        userId: msg.userId,
        channelId: msg.channelId,
        threadKey: msg.threadKey,
        ...(msg.authenticatedAs ? { authenticatedAs: msg.authenticatedAs } : {}),
        ...(msg.postedBy ? { postedBy: msg.postedBy } : {}),
        ...(msg.messageId ? { messageId: msg.messageId } : {}),
        ...(msg.approvalConnection ? { approvalConnection: msg.approvalConnection } : {}),
        ...(evidence.credentialDigest ? { credentialDigest: evidence.credentialDigest } : {}),
        ...(original?.questionOwnership ? { questionOwnership: original.questionOwnership } : {}),
        ...(original?.browserRevision !== undefined ? { browserRevision: original.browserRevision } : {}),
        ...(original?.privateSource ? { privateSource: true as const } : {}),
        ...(original?.capturedPrivateEpoch ? { capturedPrivateEpoch: original.capturedPrivateEpoch } : {}),
        ...(original?.contextMode ? { contextMode: original.contextMode } : {}),
        ...(original?.sourceRepository ? { sourceRepository: original.sourceRepository } : {}),
      };
      if (!sourceReferenceSchema.safeParse(reference).success) return denied();
      let actor: Actor,
        kind: "human" | "service",
        privateSource: boolean,
        nativeEpoch = "",
        requesterEmail: string | undefined;
      let token: McpIdentity | IngressIdentity | undefined;
      let approvedPrincipal: Actor | undefined;
      if (evidence.source === "mcp" && ("session" in evidence.identity || original?.actorId.startsWith("access:"))) {
        const proof = await options.currentMcp?.(evidence.identity, evidence.attestation, reference);
        if (!proof) return denied("unavailable");
        if (proof.status !== "verified") return denied(proof.status);
        if (!mapped("mcp", proof.identity) || proof.actorId !== reference.actorId) return denied();
        identity = proof.identity;
        const resolved = await actorFor(proof, reference);
        if (!resolved) return denied("unavailable");
        actor = resolved;
        kind = proof.kind;
        privateSource = proof.privateSource;
        nativeEpoch = proof.epoch;
        requesterEmail = proof.access?.email;
      } else if (evidence.source === "http" || evidence.source === "mcp") {
        const digest = evidence.credentialDigest;
        if (!digest || !/^[0-9a-f]{64}$/.test(digest)) return denied();
        if (evidence.source === "mcp") {
          token = await connectionIdentity(digest, { auth: options.auth(), personalTokens: options.personalTokens });
          const personal = token?.subject.startsWith("personal:")
            ? personalTokenForAuthentication(await options.personalTokens?.get(digest))
            : null;
          if (
            token?.subject.startsWith("personal:") &&
            (!personal ||
              personal.subject !== token.subject ||
              personal.userId !== ("verifiedUserId" in token ? token.verifiedUserId : undefined))
          )
            return denied();
          if (personal?.approval) {
            const approval = personal.approval;
            const pin = options.personalApproval;
            const principalIdentity = personIdentity(personal.userId!);
            if (
              !pin ||
              approval.issuer !== pin.issuer ||
              approval.audience !== pin.audience ||
              approval.organization !== options.organization ||
              !principalIdentity ||
              principalIdentity.issuer !== approval.issuer ||
              principalIdentity.subject !== approval.subject ||
              personal.subject !== token?.subject ||
              personal.userId !== msg.userId ||
              (evidence.onBehalfOf && identityKey(evidence.onBehalfOf) !== identityKey(principalIdentity))
            )
              return denied();
            // A protected, revocable device approval establishes this delegation.
            // It supplies no browser session or account-link authentication proof.
            const current = resolveChatActor(
              { userId: personal.userId!, channelId: msg.channelId, threadKey: msg.threadKey },
              options.grantsFor,
            );
            approvedPrincipal = { ...current, self: [current.id] };
            nativeEpoch = digestBearer(JSON.stringify([digest, approval]));
          }
          if (
            msg.approvalConnection &&
            (msg.approvalConnection.id !== digest || msg.approvalConnection.credentialId !== reference.actorId)
          )
            return denied();
        } else {
          const matches = Object.entries(options.auth().tokens).filter(([bearer]) => digestBearer(bearer) === digest);
          if (matches.length !== 1) return denied();
          token = matches[0]![1];
        }
        if (
          !token ||
          token.subject !== identity.subject ||
          reference.actorId !== `${evidence.source}:${token.subject}` ||
          msg.postedBy
        )
          return denied();
        requesterEmail = token.email;
        if (token.channel && msg.channelId !== `${evidence.source}:${token.channel}`) return denied();
        if (msg.authenticatedAs && msg.authenticatedAs !== reference.actorId) return denied();
        actor = resolveActor(
          { surface: evidence.source, subjectId: token.subject, channelId: msg.channelId, threadKey: msg.threadKey },
          options.grantsFor,
        );
        kind = "service";
        privateSource = true;
      } else {
        const callback =
          evidence.source === "browser"
            ? options.currentBrowser
            : evidence.source === "slack"
              ? options.currentSlack
              : evidence.source === "github"
                ? options.currentGithub
                : options.currentCli;
        const proof = callback
          ? await callback(identity, evidence.attestation, reference)
          : { status: "unavailable" as const };
        if (proof.status !== "verified") return denied(proof.status);
        if (identityKey(proof.identity) !== identityKey(identity) || proof.actorId !== reference.actorId)
          return denied();
        const resolved = await actorFor(proof, reference);
        if (!resolved) return denied("unavailable");
        actor = resolved;
        kind = proof.kind;
        privateSource = proof.privateSource;
        if (reference.privateSource && !privateSource) return denied();
        nativeEpoch = proof.epoch;
        if (
          proof.directAudience &&
          (proof.directAudience.userId !== msg.userId ||
            proof.directAudience.channelId !== msg.channelId ||
            proof.directAudience.threadKey !== msg.threadKey)
        )
          return denied();
        msg = { ...msg, directAudience: proof.directAudience, ...(proof.name ? { userName: proof.name } : {}) };
      }
      let principalIdentity = evidence.onBehalfOf;
      const verifiedUserId = token && "verifiedUserId" in token ? token.verifiedUserId : undefined;
      if (!principalIdentity && verifiedUserId) principalIdentity = personIdentity(verifiedUserId);
      if (reference.questionOwnership) {
        if (evidence.source !== "browser" || principalIdentity || actor.onBehalfOf || actor.viewingAs) return denied();
        const scope = await checkQuestion(actor, identity, reference.questionOwnership);
        if (scope.status !== "proved") return denied(scope.status);
        if (scope.owner.sourceReference.userId !== msg.userId || msg.authenticatedAs !== actor.id) return denied();
        nativeEpoch += `:${scope.fingerprint}`;
      } else if (msg.userId !== actor.id) {
        if (!principalIdentity || (verifiedUserId && verifiedUserId !== msg.userId)) return denied();
        const principalProof = approvedPrincipal
          ? undefined
          : await human(principalIdentity, evidence.attestation, reference);
        if (principalProof && principalProof.status !== "verified") return denied(principalProof.status);
        if (
          principalProof &&
          (principalProof.kind !== "human" ||
            principalProof.actorId !== msg.userId ||
            identityKey(principalProof.identity) !== identityKey(principalIdentity))
        )
          return denied();
        if (
          !verifiedUserId &&
          (await options.verifyDelegation?.(evidence.source, identity, principalIdentity)) !== true
        )
          return denied();
        const person =
          approvedPrincipal ??
          (principalProof?.status === "verified" ? await actorFor(principalProof, reference) : undefined);
        if (!person) return denied("unavailable");
        if (evidence.source === "mcp") {
          const requester = verifiedUserId?.startsWith("access:")
            ? await mcpRequester(token!, { auth: options.auth(), personByEmail: options.personByEmail })
            : { userId: person.id, authenticatedAs: actor.id };
          if (!requester || requester.userId !== person.id) return denied();
          if (isSlackProfileId(requester.requesterProfileId)) {
            msg = {
              ...msg,
              requesterProfileId: requester.requesterProfileId,
              ...(requester.userName ? { userName: requester.userName } : {}),
            };
          }
          actor = { ...toCaller(token!, options.grantsFor, requester).actor, onBehalfOf: person };
        } else actor = { ...actor, onBehalfOf: person };
        actor = {
          ...actor,
          self: [actor.id],
          asUser: { id: person.id },
          origin: { channelId: msg.channelId, threadKey: msg.threadKey },
        };
        nativeEpoch += principalProof?.status === "verified" ? `:${principalProof.epoch}` : "";
      } else if (principalIdentity || msg.postedBy || (msg.authenticatedAs && msg.authenticatedAs !== actor.id))
        return denied();
      const target = { type: "organization" as const, id: options.organization };
      const organizations =
        authorize(actor, "organization:read", target).allow || authorize(actor, "organization:send", target).allow
          ? [options.organization]
          : [];
      if (approvedPrincipal && organizations.length === 0) return denied();
      const binding = await options.directory.resolve(principalIdentity ?? identity);
      if (binding.status === "conflict") return denied();
      if (binding.status === "unavailable" || binding.status === "invalid") return denied("unavailable");
      if (evidence.source === "mcp" && !isSlackProfileId(msg.requesterProfileId) && requesterEmail) {
        const profile = await options.personByEmail?.(requesterEmail).catch(() => {
          warnRequesterLabel(msg.channelId, "failed");
          return undefined;
        });
        if (isSlackProfileId(profile?.id))
          msg = {
            ...msg,
            requesterProfileId: profile.id,
            ...(profile.name ? { userName: msg.userName ?? profile.name } : {}),
          };
      }
      const authentication: OrganizationAuthentication = {
        source: evidence.source,
        identity,
        kind,
        sourceReference: reference,
        ...(kind === "service" || ["http", "mcp", "cli"].includes(evidence.source) ? { organizations } : {}),
        // A verified delegation owns its native private source before linking.
        // The directory alone may join that source to a person's other sources.
        ...(principalIdentity && (binding.status === "bound" || approvedPrincipal)
          ? { onBehalfOf: principalIdentity }
          : {}),
      };
      const sets = (value: Actor["grants"]["actions"] | undefined) =>
        value === "all" ? "all" : [...(value ?? [])].sort();
      const policy = (current: Actor): unknown => ({
        kind: current.kind,
        id: current.id,
        actions: sets(current.grants.actions),
        channels: sets(current.grants.channels),
        repos: sets(current.grants.repos),
        organizations: sets(current.grants.organizations),
        repoAccess:
          current.grants.repoAccess &&
          typeof current.grants.repoAccess === "object" &&
          "except" in current.grants.repoAccess
            ? { except: [...current.grants.repoAccess.except].sort() }
            : sets(current.grants.repoAccess),
        memberOf: [...(current.memberOf ?? [])].sort(),
        memberOfOrganizations: [...(current.memberOfOrganizations ?? [])].sort(),
        viewingAs: current.viewingAs?.id,
        standingConsent: sets(current.standingConsent),
        principal: current.onBehalfOf ? policy(current.onBehalfOf) : null,
      });
      return {
        status: "resolved",
        actor,
        msg,
        authentication,
        privateSource,
        // Match the source-authority group: request-specific repository selections
        // still get their own access check, but must not rotate the group policy.
        readPolicyFingerprint: digestBearer(
          JSON.stringify([
            "source-read-policy-v1",
            evidence.source,
            identity,
            reference.channelId,
            reference.threadKey,
            policy(actor),
            privateSource,
            msg.directAudience ?? null,
            binding.status === "bound" ? [binding.binding.personId, binding.binding.revision] : binding.status,
          ]),
        ),
        policyFingerprint: digestBearer(
          JSON.stringify([
            policy(actor),
            nativeEpoch,
            privateSource,
            msg.directAudience ?? null,
            binding.status === "bound" ? [binding.binding.personId, binding.binding.revision] : binding.status,
          ]),
        ),
      };
    } catch {
      return denied("unavailable");
    }
  }
  async function checkQuestion(
    actor: Actor,
    identity: ExternalIdentity,
    scope: NonNullable<OrganizationSourceReference["questionOwnership"]>,
    issuing = false,
  ): Promise<
    | { status: "proved"; owner: Extract<OrganizationQuestionOwner, { status: "proved" }>; fingerprint: string }
    | { status: "fenced" | "unavailable" }
  > {
    if (actor.kind !== "user" || actor.viewingAs || actor.onBehalfOf) return { status: "fenced" };
    const owner = await options.questionOwner?.(scope.unitKey);
    if (!owner) return { status: "unavailable" };
    if (owner.status !== "proved") return owner;
    if (
      identityKey(owner.requester) !== identityKey(scope.requester) ||
      (issuing && owner.questionDigest !== scope.questionDigest) ||
      owner.sourceReference.questionOwnership ||
      owner.sourceReference.actorId !== owner.sourceReference.userId
    )
      return { status: "fenced" };
    const pair = await Promise.all([options.directory.resolve(identity), options.directory.resolve(owner.requester)]);
    if (pair.some((b) => b.status === "unavailable" || b.status === "invalid")) return { status: "unavailable" };
    const [actual, requester] = pair;
    const sameNativeUnknown =
      identityKey(identity) === identityKey(owner.requester) &&
      actual!.status === "unknown" &&
      requester!.status === "unknown";
    if (
      !sameNativeUnknown &&
      !(
        actual!.status === "bound" &&
        requester!.status === "bound" &&
        actual.binding.personId === requester.binding.personId
      )
    )
      return { status: "fenced" };
    const sources = [
      ...new Set(options.mappings.filter((m) => mapped(m.source, owner.requester)).map((m) => m.source)),
    ];
    if (sources.length !== 1) return { status: "fenced" };
    const native = await resolve(
      { ...owner.sourceReference, text: "" },
      {
        source: sources[0]!,
        identity: owner.requester,
        credentialDigest: owner.sourceReference.credentialDigest,
      },
      owner.sourceReference,
    );
    if (native.status !== "resolved") return native;
    const [repoOwner, repoName, ...extra] = owner.repo.split("/");
    if (!repoOwner || !repoName || extra.length) return { status: "fenced" };
    for (const current of [actor, native.actor]) {
      if (
        !authorize(current, "organization:send", { type: "organization", id: options.organization }).allow ||
        !authorize(current, "steer:write", { type: "command", id: "work.steer" }).allow ||
        !authorize(current, "repo:use", { type: "repo", owner: repoOwner, name: repoName }).allow
      )
        return { status: "fenced" };
    }
    if (
      authorizeSteerOwner({
        caller: { ids: [actor.id, owner.sourceReference.userId], grants: effectiveGrants(actor) },
        target: { requesterId: owner.sourceReference.userId },
      }).kind !== "allowed"
    )
      return { status: "fenced" };
    return {
      status: "proved",
      owner,
      fingerprint: digestBearer(
        JSON.stringify([
          native.policyFingerprint,
          actual!.status === "bound" ? actual.binding.revision : actual!.status,
          requester!.status === "bound" ? requester.binding.revision : requester!.status,
        ]),
      ),
    };
  }
  const resolveNative = (msg: IncomingMessage, evidence: OrganizationNativeEvidence) => resolve(msg, evidence);
  const resolveEnvelope = (envelope: OrganizationEnvelope): Promise<OrganizationAuthenticationResult> => {
    const parsed = envelopeSchema.safeParse(envelope);
    if (!parsed.success || parsed.data.organization !== options.organization || !parsed.data.sourceReference)
      return Promise.resolve(denied());
    const e = parsed.data,
      ref = e.sourceReference!;
    return resolve(
      { ...ref, text: e.content },
      {
        source: e.source,
        identity: e.actor.identity,
        credentialDigest: ref.credentialDigest,
        ...(e.actor.onBehalfOf ? { onBehalfOf: e.actor.onBehalfOf } : {}),
      },
      ref,
    );
  };
  return {
    resolveNative,
    resolveEnvelope,
    sourceInReadScope(
      identity: ExternalIdentity,
      reference: OrganizationSourceReference | undefined,
      reader: OrganizationAuthentication,
    ): boolean {
      const receiver = reader.sourceReference;
      if (reader.source !== "mcp" || reader.kind !== "human" || !reference || !receiver) return true;
      return (
        identityKey(identity) === identityKey(reader.identity) &&
        reference.userId === receiver.userId &&
        reference.channelId === receiver.channelId &&
        reference.threadKey === receiver.threadKey
      );
    },
    /** Only underlying native reads are shared within this metadata phase.
     * Policy and message attribution are rebuilt for each exact original source.
     * A new phase must be created for the final emission fence. */
    metadataPhase(): OrganizationMetadataAuthentication {
      function memo<A extends unknown[], R>(key: (...args: A) => string, read: (...args: A) => Promise<R>) {
        const reads = new Map<string, Promise<R>>();
        return (...args: A) => {
          const id = key(...args);
          let value = reads.get(id);
          if (!value) {
            value = read(...args);
            reads.set(id, value);
          }
          return value;
        };
      }
      const nativeKey = (identity: ExternalIdentity, attestation?: unknown, ref?: OrganizationSourceReference) => {
        // A message identifier is attribution, not native-source authority.
        // Keep the exact address, credential, delegated requester, saved choice
        // and question proof; unrelated private sources cannot share a result.
        const { messageId: _message, browserRevision: _revision, ...authority } = ref ?? {};
        return JSON.stringify([identity, attestation ?? null, authority]);
      };
      const phase = createOrganizationAuthentication({
        ...options,
        currentBrowser: memo(nativeKey, options.currentBrowser),
        currentSlack: memo(nativeKey, options.currentSlack),
        ...(options.currentMcp
          ? {
              currentMcp: memo(
                (
                  identity: ExternalIdentity | IngressIdentity,
                  attestation?: unknown,
                  ref?: OrganizationSourceReference,
                ) => JSON.stringify([identity, attestation ?? null, ref]),
                options.currentMcp,
              ),
            }
          : {}),
        ...(options.currentGithub ? { currentGithub: memo(nativeKey, options.currentGithub) } : {}),
        ...(options.currentCli ? { currentCli: memo(nativeKey, options.currentCli) } : {}),
        ...(options.channelsOf ? { channelsOf: memo((id: string) => id, options.channelsOf) } : {}),
        directory: Object.assign(Object.create(options.directory) as PersonDirectory, {
          resolve: memo(identityKey, (identity: ExternalIdentity) => options.directory.resolve(identity)),
        }),
        ...(options.personalTokens
          ? {
              personalTokens: Object.assign(Object.create(options.personalTokens) as PersonalTokenStore, {
                get: memo(
                  (digest: string) => digest,
                  (digest: string) => options.personalTokens!.get(digest),
                ),
              }),
            }
          : {}),
      });
      return { resolveEnvelope: phase.resolveEnvelope, resolveAuthorization: phase.resolveAuthorization };
    },
    resolveQuestion: async (
      current: ResolvedOrganizationAuthentication,
      unitKey: string,
      questionDigest: string,
    ): Promise<OrganizationAuthenticationResult> => {
      try {
        const reference = current.authentication.sourceReference;
        if (current.authentication.source !== "browser" || !reference || !/^[0-9a-f]{64}$/.test(questionDigest))
          return denied();
        const owner = await options.questionOwner?.(unitKey);
        if (!owner) return denied("unavailable");
        if (owner.status !== "proved") return denied(owner.status);
        const questionOwnership = { unitKey, questionDigest, requester: owner.requester };
        const checked = await checkQuestion(current.actor, current.authentication.identity, questionOwnership, true);
        if (checked.status !== "proved") return denied(checked.status);
        const ref = {
          ...reference,
          userId: owner.sourceReference.userId,
          authenticatedAs: current.actor.id,
          questionOwnership,
        };
        return resolve(
          { ...current.msg, userId: ref.userId, authenticatedAs: ref.authenticatedAs },
          { source: "browser", identity: current.authentication.identity },
          ref,
        );
      } catch {
        return denied("unavailable");
      }
    },
    /** Current-reader proof is read-only. Original execution authentication never uses it. */
    evaluateSourceIdentity: async (
      identity: ExternalIdentity,
      reference?: OrganizationSourceReference,
      onBehalfOf?: ExternalIdentity | null,
      reader?: OrganizationAuthentication,
    ): Promise<{ status: "allowed"; policyFingerprint: string } | { status: "denied" | "unavailable" }> => {
      const sources = [
        ...new Set(
          options.mappings
            .filter(
              (m) =>
                m.issuer === identity.issuer && m.tenant === identity.tenant && m.organization === options.organization,
            )
            .map((m) => m.source),
        ),
      ];
      if (sources.length !== 1) return { status: "denied" };
      const source = sources[0]!;
      // A bare saved subject cannot prove the original private reply address
      // or exact credential. The retained server origin supplies both.
      if (!reference) return { status: "unavailable" };
      let ref = reference;
      if (
        source === "mcp" &&
        reader?.source === "mcp" &&
        reader.kind === "human" &&
        !onBehalfOf &&
        !reader.onBehalfOf &&
        identityKey(reader.identity) === identityKey(identity)
      ) {
        const receiver = reader.sourceReference;
        if (!receiver || !sourceReferenceSchema.safeParse(reference).success) return { status: "unavailable" };
        const proof = await resolve(
          { ...receiver, text: "" },
          { source: "mcp", identity: reader.identity, credentialDigest: receiver.credentialDigest },
          receiver,
        );
        if (proof.status !== "resolved") return { status: proof.status === "fenced" ? "denied" : "unavailable" };
        if (
          !proof.privateSource ||
          proof.actor.viewingAs ||
          proof.actor.onBehalfOf ||
          proof.actor.id !== reference.actorId ||
          reference.userId !== proof.actor.id ||
          reference.authenticatedAs !== proof.actor.id ||
          reference.postedBy ||
          reference.questionOwnership
        )
          return { status: "denied" };
        // Check the historical scope with today's credential, without changing
        // the saved origin or registering a verifier for its old credential.
        ref = {
          ...reference,
          credentialDigest: receiver.credentialDigest,
          approvalConnection: receiver.approvalConnection,
        };
      }
      const current = await resolve(
        { ...ref, text: "" },
        { source, identity, credentialDigest: ref.credentialDigest, ...(onBehalfOf ? { onBehalfOf } : {}) },
        ref,
      );
      if (current.status !== "resolved") return { status: current.status === "fenced" ? "denied" : "unavailable" };
      if (ref.sourceRepository) {
        const [owner, name] = ref.sourceRepository.split("/");
        if (!owner || !name || !authorize(current.actor, "repo:use", { type: "repo", owner, name }).allow)
          return { status: "denied" };
      }
      return authorize(current.actor, "organization:read", { type: "organization", id: options.organization }).allow
        ? { status: "allowed", policyFingerprint: current.readPolicyFingerprint }
        : { status: "denied" };
    },
    resolveBrowser: (identity: ExternalIdentity, msg: IncomingMessage, attestation?: unknown) =>
      resolveNative(msg, { source: "browser", identity, attestation }),
    resolveAuthorization: (
      input: import("../core/organization/service.js").OrganizationAuthorization,
    ): Promise<OrganizationAuthenticationResult> => {
      const ref = input.sourceReference;
      if (input.organization !== options.organization || !ref) return Promise.resolve(denied());
      return resolve(
        { ...ref, text: "" },
        {
          source: input.source,
          identity: input.actor.identity,
          credentialDigest: ref.credentialDigest,
          ...(input.actor.onBehalfOf ? { onBehalfOf: input.actor.onBehalfOf } : {}),
        },
        ref,
      );
    },
    restoreOriginalRun: async (
      runId: string,
      organizationOrigin = true,
    ): Promise<OrganizationAuthenticationResult | { status: "legacy" }> => {
      if (!options.ledger) return denied("unavailable");
      try {
        const original = await options.ledger.readIngressByRun(runId);
        if (original.status === "not_found") return organizationOrigin ? denied() : { status: "legacy" };
        if (original.status !== "record") return denied(original.status === "fenced" ? "fenced" : "unavailable");
        if (
          original.record.runId !== runId ||
          !original.record.origin ||
          original.record.origin.sourceReference?.userId !== original.record.requester ||
          original.record.origin.sourceReference?.threadKey !== original.record.threadKey
        )
          return denied();
        return resolveEnvelope(original.record.origin);
      } catch {
        return denied("unavailable");
      }
    },
  };
}
