import { observeAdmission, type AdmissionObservation } from "../core/organization/admissionTrace.js";
import type { TraceOptions } from "../core/trace/types.js";
import { mapLimit } from "../core/mapLimit.js";
import { HOME_PRIVATE_READ_CONCURRENCY } from "../core/budgets.js";
import { createHash } from "node:crypto";
import { authorize } from "../core/authz/authorize.js";
import type { createOrganizationAuthentication } from "./organizationAuthentication.js";
import type { OrganizationService } from "../core/organization/service.js";
import type { OrganizationStore } from "../core/organization/contract.js";
import type { HomeRuntimeContext } from "./homeRuntime.js";
export interface HomeAccessEpochOptions {
  organizationId: string;
  organization: OrganizationService;
  store: OrganizationStore;
  authentication: ReturnType<typeof createOrganizationAuthentication>;
  policyEpoch(): string;
}
/** Each frame fences all retained source authorities, including older windows.
 * Bounded pages cover the complete catalogue, never just recent messages. */
export function createHomeAccessEpoch(options: HomeAccessEpochOptions) {
  const readEpoch = async (
    context: HomeRuntimeContext,
    note: (gap: AdmissionObservation) => void,
    trace?: TraceOptions,
  ): Promise<string | undefined> => {
    let gap: AdmissionObservation = { reason: "receiver-unavailable" };
    let complete = false;
    try {
      const reference = context.authentication.sourceReference;
      if (!reference) return;
      const addressed = await options.organization.resolve(context.authentication);
      if (!addressed || addressed.organization !== options.organizationId) return;
      const current = await options.authentication.resolveAuthorization({
        ...addressed,
        source: context.authentication.source,
        sourceReference: reference,
        destination: { kind: "broad" },
        target: null,
        context: [],
        action: "read",
      });
      if (
        current.status !== "resolved" ||
        !authorize(current.actor, "organization:read", { type: "organization", id: options.organizationId }).allow
      )
        return;
      const resolved = await options.organization.resolve(current.authentication);
      if (!resolved || resolved.organization !== options.organizationId || !resolved.actor.stream) return;
      const nativePolicy = options.policyEpoch();
      if (reference.contextMode === "request") {
        if (
          current.authentication.source !== "mcp" ||
          current.authentication.kind !== "human" ||
          !current.privateSource ||
          current.actor.viewingAs ||
          current.actor.onBehalfOf
        )
          return;
        const repo = reference.sourceRepository?.split("/");
        if (
          !repo ||
          repo.length !== 2 ||
          !authorize(current.actor, "repo:use", { type: "repo", owner: repo[0]!, name: repo[1]! }).allow
        )
          return;
        // This frame consumes no historical source. Recheck the exact current
        // receiver and binding after awaits without observing the catalogue.
        const receiver = await options.authentication.resolveAuthorization({
          ...resolved,
          source: current.authentication.source,
          sourceReference: reference,
          destination: { kind: "broad" },
          target: null,
          context: [],
          action: "read",
        });
        if (
          receiver.status !== "resolved" ||
          receiver.policyFingerprint !== current.policyFingerprint ||
          !receiver.privateSource ||
          options.policyEpoch() !== nativePolicy
        )
          return;
        const final = await options.organization.resolve(receiver.authentication);
        if (
          !final ||
          final.organization !== resolved.organization ||
          final.actor.stream !== resolved.actor.stream ||
          final.actor.bindingRevision !== resolved.actor.bindingRevision ||
          options.policyEpoch() !== nativePolicy
        )
          return;
        complete = true;
        return createHash("sha256")
          .update(
            JSON.stringify([
              "request-context-v1",
              current.policyFingerprint,
              nativePolicy,
              resolved.actor.stream,
              resolved.actor.bindingRevision,
              reference.sourceRepository,
            ]),
          )
          .digest("hex");
      }
      const observations = new Map<string, string | null>();
      let scopeExcluded = 0;
      let snapshotRevision: number | undefined;
      let accessRevision: number | undefined;
      let after: string | undefined;
      do {
        gap = { reason: "catalogue-unavailable" };
        const catalogue = await options.store.execute({
          action: "source-catalogue",
          ...resolved,
          limit: 200,
          paged: true,
          ...(after ? { after } : {}),
        });
        if (catalogue.status !== "source-catalogue" || catalogue.revision === undefined) return;
        snapshotRevision ??= catalogue.revision;
        accessRevision ??= catalogue.accessRevision;
        gap = { reason: "catalogue-changed" };
        if (catalogue.revision !== snapshotRevision || catalogue.accessRevision !== accessRevision) return;
        const decisions = await mapLimit(catalogue.entries, HOME_PRIVATE_READ_CONCURRENCY, async (source) => {
          if (
            !options.authentication.sourceInReadScope(
              source.actor.identity,
              source.sourceReference,
              current.authentication,
            )
          )
            return;
          const decision = source.allowed
            ? await options.authentication.evaluateSourceIdentity(
                source.actor.identity,
                source.sourceReference,
                source.actor.onBehalfOf,
                current.authentication,
              )
            : { status: "denied" as const };
          return { source, decision };
        });
        for (const checked of decisions) {
          if (!checked) {
            scopeExcluded++;
            continue;
          }
          const { source, decision } = checked;
          if (decision.status === "unavailable") {
            const original = source.sourceReference?.credentialDigest;
            const receiver = context.authentication.sourceReference?.credentialDigest;
            const sameIdentity =
              source.actor.identity.issuer === context.authentication.identity.issuer &&
              source.actor.identity.tenant === context.authentication.identity.tenant &&
              source.actor.identity.subject === context.authentication.identity.subject;
            gap = {
              reason: "native-source-unavailable",
              source: source.source,
              credentialRelation:
                source.source === context.authentication.source && original && receiver
                  ? sameIdentity && original === receiver
                    ? "same"
                    : "different"
                  : "unknown",
            };
            return;
          }
          observations.set(source.authority, decision.status === "allowed" ? decision.policyFingerprint : null);
        }
        if (catalogue.next && after && Buffer.compare(Buffer.from(catalogue.next), Buffer.from(after)) <= 0) return;
        after = catalogue.next;
      } while (after);
      if (snapshotRevision === undefined || accessRevision === undefined || options.policyEpoch() !== nativePolicy)
        return;
      // Register newly authorized scopes without rotating the loss epoch. The
      // store compares retained baselines transactionally across restarts.
      gap = { reason: "policy-observe-unavailable" };
      const updates = [...observations].map(([authority, fingerprint]) => ({ authority, fingerprint }));
      for (let offset = 0; offset < updates.length; offset += 200) {
        const observed = await options.store.execute({
          action: "source-policy-observe",
          ...resolved,
          expectedRevision: snapshotRevision,
          observations: updates.slice(offset, offset + 200),
        });
        if (observed.status !== "source-policies-observed") return;
        snapshotRevision = observed.revision;
        accessRevision = observed.accessRevision;
      }
      // Native catalogue checks can outlive the viewer's signed credential.
      // Reprove this receiver after those awaits before publishing its epoch.
      gap = { reason: "receiver-unavailable" };
      const receiver = await options.authentication.resolveAuthorization({
        ...resolved,
        source: context.authentication.source,
        sourceReference: reference,
        destination: { kind: "broad" },
        target: null,
        context: [],
        action: "read",
      });
      if (
        receiver.status !== "resolved" ||
        receiver.policyFingerprint !== current.policyFingerprint ||
        !authorize(receiver.actor, "organization:read", { type: "organization", id: options.organizationId }).allow ||
        options.policyEpoch() !== nativePolicy
      )
        return;
      gap = { reason: "catalogue-changed" };
      const final = await options.store.execute({ action: "get", organization: options.organizationId });
      if (
        final.status !== "state" ||
        final.state.sourcePolicyRevision !== snapshotRevision ||
        final.state.accessRevision !== accessRevision ||
        options.policyEpoch() !== nativePolicy
      )
        return;
      const epoch = createHash("sha256")
        .update(
          JSON.stringify([
            ...(current.authentication.source === "mcp" && current.authentication.kind === "human"
              ? ["mcp-thread-context-v1", reference.channelId, reference.threadKey]
              : []),
            current.policyFingerprint,
            accessRevision,
            nativePolicy,
          ]),
        )
        .digest("hex");
      complete = true;
      observeAdmission(trace, { epochScopeExcluded: scopeExcluded });
      return epoch;
    } catch {
      gap = { reason: "epoch-exception" };
      return;
    } finally {
      if (!complete) note(gap);
    }
  };
  return async (context: HomeRuntimeContext, trace?: TraceOptions): Promise<string | undefined> => {
    let lastGap: AdmissionObservation | undefined;
    // A scope may register while its predecessor is being checked. Restart the
    // complete scan, without treating ordinary traffic as permission loss.
    for (let attempt = 0; attempt < 3; attempt++) {
      const epoch = await readEpoch(
        context,
        (gap) => {
          lastGap = gap;
        },
        trace,
      );
      if (epoch !== undefined) return epoch;
    }
    observeAdmission(trace, lastGap ?? { reason: "epoch-unavailable" });
  };
}
