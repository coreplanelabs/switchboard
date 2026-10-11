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
  const readEpoch = async (context: HomeRuntimeContext): Promise<string | undefined> => {
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
      const observations = new Map<string, string | null>();
      let snapshotRevision: number | undefined;
      let accessRevision: number | undefined;
      let after: string | undefined;
      do {
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
        if (catalogue.revision !== snapshotRevision || catalogue.accessRevision !== accessRevision) return;
        for (const source of catalogue.entries) {
          const decision = source.allowed
            ? await options.authentication.evaluateSourceIdentity(
                source.actor.identity,
                source.sourceReference,
                source.actor.onBehalfOf,
              )
            : { status: "denied" as const };
          if (decision.status === "unavailable") return;
          observations.set(source.authority, decision.status === "allowed" ? decision.policyFingerprint : null);
        }
        if (catalogue.next && after && Buffer.compare(Buffer.from(catalogue.next), Buffer.from(after)) <= 0) return;
        after = catalogue.next;
      } while (after);
      if (snapshotRevision === undefined || accessRevision === undefined || options.policyEpoch() !== nativePolicy)
        return;
      // Register newly authorized scopes without rotating the loss epoch. The
      // store compares retained baselines transactionally across restarts.
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
      const final = await options.store.execute({ action: "get", organization: options.organizationId });
      if (
        final.status !== "state" ||
        final.state.sourcePolicyRevision !== snapshotRevision ||
        final.state.accessRevision !== accessRevision ||
        options.policyEpoch() !== nativePolicy
      )
        return;
      return createHash("sha256")
        .update(JSON.stringify([current.policyFingerprint, accessRevision, nativePolicy]))
        .digest("hex");
    } catch {
      return;
    }
  };
  return async (context: HomeRuntimeContext): Promise<string | undefined> => {
    // A scope may register while its predecessor is being checked. Restart the
    // complete scan, without treating ordinary traffic as permission loss.
    for (let attempt = 0; attempt < 3; attempt++) {
      const epoch = await readEpoch(context);
      if (epoch !== undefined) return epoch;
    }
  };
}
