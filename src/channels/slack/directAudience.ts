import type { AudienceCheck } from "../../core/audienceDecision.js";
import type { SlackDirectAudience } from "../../core/types.js";

export interface SlackDirectAudienceClient {
  auth: { test(): Promise<{ team_id?: string }> };
  users: { info(args: { user: string }): Promise<{ user?: { team_id?: string } }> };
  conversations: {
    info(args: { channel: string }): Promise<{
      channel?: {
        user?: string;
        is_im?: boolean;
        is_mpim?: boolean;
        is_private?: boolean;
        is_member?: boolean;
        is_shared?: boolean;
        is_ext_shared?: boolean;
        is_org_shared?: boolean;
        is_pending_ext_shared?: boolean;
        num_members?: number;
        shared_team_ids?: string[];
        pending_connected_team_ids?: string[];
      };
    }>;
  };
}

/** Verify this reply address with Slack now; a D prefix alone can name a shared DM. */
export async function verifySlackDirectAudience(
  client: SlackDirectAudienceClient,
  audience: SlackDirectAudience,
): Promise<AudienceCheck> {
  if (
    audience.kind !== "slack-unshared-im" ||
    !/^slack:D[A-Z0-9_]+$/.test(audience.channelId) ||
    !/^slack:[UW][A-Z0-9_]+$/.test(audience.userId) ||
    !audience.threadKey.startsWith(`${audience.channelId}:`)
  )
    return { ok: false, code: "direct-address-unproved" };
  try {
    const channel = audience.channelId.slice("slack:".length);
    const peer = audience.userId.slice("slack:".length);
    const [c, installation, person] = await Promise.all([
      client.conversations.info({ channel }).then((result) => result.channel),
      client.auth.test(),
      client.users.info({ user: peer }).then((result) => result.user),
    ]);
    const team = installation.team_id;
    const allowed =
      typeof team === "string" &&
      team.length > 0 &&
      person?.team_id === team &&
      c?.user === peer &&
      c.is_im === true &&
      c.is_mpim !== true &&
      c.is_private !== false &&
      c.is_member !== false &&
      c.is_shared !== true &&
      c.is_ext_shared !== true &&
      c.is_org_shared === false &&
      c.is_pending_ext_shared !== true &&
      (c.num_members === undefined || c.num_members === 2) &&
      (c.shared_team_ids === undefined || (c.shared_team_ids.length === 1 && c.shared_team_ids[0] === team)) &&
      (c.pending_connected_team_ids === undefined || c.pending_connected_team_ids.length === 0);
    if (allowed) return { ok: true };
    const missing =
      !team || !person?.team_id || !c?.user || typeof c.is_im !== "boolean" || typeof c.is_org_shared !== "boolean";
    return { ok: false, code: missing ? "direct-audience-unavailable" : "direct-audience-denied" };
  } catch {
    return { ok: false, code: "direct-audience-unavailable" };
  }
}
