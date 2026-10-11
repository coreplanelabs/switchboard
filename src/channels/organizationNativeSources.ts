import { createHash } from "node:crypto";
import type { ExternalIdentity } from "../core/identity/contract.js";
import { identityKey } from "../core/identity/engine.js";
import type { OrganizationSourceReference } from "../core/organization/contract.js";
import type { NativeOrganizationProof } from "./organizationAuthentication.js";
import type { AccessConfig, AccessIdentity } from "./accessAuth.js";
import { isServiceToken } from "./accessAuth.js";
import type { DashboardRequest, DashboardVerifier } from "./dashboardAuth.js";
import { verifySlackDirectAudience, type SlackDirectAudienceClient } from "./slack/directAudience.js";

export interface OrganizationNativeSourcesOptions {
  organization: string;
  dashboard: DashboardVerifier;
  access: AccessConfig | null;
  slack: Omit<SlackDirectAudienceClient, "users"> & {
    users: {
      info(args: {
        user: string;
      }): Promise<{ user?: { team_id?: string; deleted?: boolean; is_bot?: boolean; real_name?: string } }>;
    };
  };
  slackTeamId?: string | (() => string | undefined);
}
/** Live credentials are retained only by their adapter, outside the model and
 * durable envelope. A restart holds browser work until a fresh session arrives. */
export function createOrganizationNativeSources(options: OrganizationNativeSourcesOptions) {
  const browserIssuer =
    options.dashboard.mode === "access" && options.access
      ? `https://${options.access.teamDomain}`
      : `installation:${options.organization}:dashboard:${options.dashboard.mode}`;
  const browserIdentity = (identity: AccessIdentity): ExternalIdentity => ({
    issuer: browserIssuer,
    tenant: null,
    subject: isServiceToken(identity) ? `service:${identity.commonName}` : identity.sub,
  });
  const sessions = new Map<string, DashboardRequest>();
  const rememberBrowser = (request: DashboardRequest, identity: AccessIdentity) => {
    if (isServiceToken(identity)) return;
    const key = identityKey(browserIdentity(identity));
    sessions.delete(key);
    sessions.set(key, { headers: { ...request.headers }, socket: { remoteAddress: request.socket?.remoteAddress } });
    if (sessions.size > 1000) sessions.delete(sessions.keys().next().value!);
  };
  const currentBrowser = async (
    identity: ExternalIdentity,
    attestation?: unknown,
  ): Promise<NativeOrganizationProof> => {
    // A shared dashboard bearer names a credential, not a proved human.
    if (options.dashboard.mode === "token") return { status: "fenced" };
    if (identity.issuer !== browserIssuer || identity.tenant !== null) return { status: "fenced" };
    const request = sessions.get(identityKey(identity));
    if (!request) return { status: "unavailable" };
    const gate = await options.dashboard.verify(request);
    if (!gate.ok) return { status: gate.status >= 500 ? "unavailable" : "fenced" };
    if (isServiceToken(gate.identity) || identityKey(browserIdentity(gate.identity)) !== identityKey(identity))
      return { status: "fenced" };
    // View-as comes only from the authenticated host context, never saved
    // source metadata. Background owners retain their actual caller.
    const viewAs =
      attestation &&
      typeof attestation === "object" &&
      "viewAs" in attestation &&
      typeof attestation.viewAs === "string"
        ? attestation.viewAs
        : undefined;
    return {
      status: "verified",
      identity,
      actorId: `access:${identity.subject}`,
      kind: "human",
      organizationMember: true,
      privateSource: true,
      access: { ...gate.identity, ...(viewAs ? { viewAs } : {}) },
      epoch: createHash("sha256")
        .update(JSON.stringify([browserIssuer, identity.subject, options.dashboard.mode]))
        .digest("hex"),
    };
  };
  const currentSlack = async (
    identity: ExternalIdentity,
    _attestation?: unknown,
    reference?: OrganizationSourceReference,
  ): Promise<NativeOrganizationProof> => {
    const team = typeof options.slackTeamId === "function" ? options.slackTeamId() : options.slackTeamId;
    if (!team) return { status: "unavailable" };
    if (
      identity.issuer !== "https://slack.com" ||
      identity.tenant !== team ||
      !/^[UW][A-Z0-9_]+$/.test(identity.subject)
    )
      return { status: "fenced" };
    try {
      const [installation, result] = await Promise.all([
        options.slack.auth.test(),
        options.slack.users.info({ user: identity.subject }),
      ]);
      const person = result.user;
      if (!installation.team_id || !person?.team_id) return { status: "unavailable" };
      if (installation.team_id !== team || person.team_id !== team || person.deleted) return { status: "fenced" };
      const actorId = `slack:${identity.subject}`;
      let privateSource = false;
      let directAudience;
      if (
        reference &&
        reference.actorId === actorId &&
        reference.userId === actorId &&
        !reference.postedBy &&
        !reference.authenticatedAs &&
        reference.channelId.startsWith("slack:D")
      ) {
        const address = {
          kind: "slack-unshared-im" as const,
          channelId: reference.channelId,
          userId: actorId,
          threadKey: reference.threadKey,
        };
        const proof = await verifySlackDirectAudience(options.slack, address);
        if (!proof.ok) return { status: proof.code === "direct-audience-unavailable" ? "unavailable" : "fenced" };
        privateSource = true;
        directAudience = address;
      }
      const finalTeam = typeof options.slackTeamId === "function" ? options.slackTeamId() : options.slackTeamId;
      if (!finalTeam) return { status: "unavailable" };
      if (finalTeam !== team) return { status: "fenced" };
      return {
        status: "verified",
        identity,
        actorId,
        kind: person.is_bot ? "service" : "human",
        organizationMember: !person.is_bot,
        privateSource,
        ...(directAudience ? { directAudience } : {}),
        ...(person.real_name ? { name: person.real_name } : {}),
        epoch: createHash("sha256")
          .update(JSON.stringify([team, actorId, person.is_bot === true, privateSource]))
          .digest("hex"),
      };
    } catch {
      return { status: "unavailable" };
    }
  };
  return { browserIdentity, browserIssuer, rememberBrowser, currentBrowser, currentSlack };
}
