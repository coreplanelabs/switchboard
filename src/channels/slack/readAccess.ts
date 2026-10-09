import { webApi } from "@slack/bolt";
import type { Actor } from "../../core/authz/types.js";
import type { IncomingMessage } from "../../core/types.js";
import type { Secret } from "../../secrets.js";
import { SlackChannelDirectory, type SlackDirectoryClient } from "../slackChannelDirectory.js";
import { createSlackContextCapability, type SlackContextClient } from "./context.js";
import { SlackConversationReader } from "./references.js";

const PUBLIC_READ_SCOPES = ["channels:read", "channels:history", "users:read"];
const READ_SCOPES = new Set([...PUBLIC_READ_SCOPES, "groups:read", "groups:history", "files:read"]);

/** One workspace read identity, separate from the bot's listener and writer.
 * Only HTTP read methods use this account; no user or source channel subscribes. */
export async function createSlackReadAccess(input: {
  listener: SlackContextClient;
  directory: SlackChannelDirectory;
  token?: Secret;
  /** Tests supply the external API boundary. Production uses the configured read token. */
  sourceClient?: SlackContextClient & SlackDirectoryClient;
}) {
  let sourceReader: SlackConversationReader | undefined;
  if (input.token) {
    const client =
      input.sourceClient ??
      new webApi.WebClient(input.token.reveal(), {
        rejectRateLimitedCalls: true,
        retryConfig: { retries: 0 },
      });
    try {
      const [listener, source] = await Promise.all([input.listener.auth.test(), client.auth.test()]);
      const scopes = source.response_metadata?.scopes;
      if (
        !listener.team_id ||
        source.team_id !== listener.team_id ||
        source.bot_id ||
        !source.user_id ||
        !Array.isArray(scopes) ||
        PUBLIC_READ_SCOPES.some((scope) => !scopes.includes(scope)) ||
        scopes.some((scope) => !READ_SCOPES.has(scope))
      )
        throw new Error("invalid read identity");
      const user = (await client.users.info({ user: source.user_id })).user;
      if (!user || user.is_restricted || user.is_ultra_restricted || user.team_id !== listener.team_id)
        throw new Error("invalid read account");
      sourceReader = new SlackConversationReader(client, Date.now, {
        workspacePublicRead: true,
        workspaceTeamId: listener.team_id,
        directory: new SlackChannelDirectory(client),
        token: input.token,
      });
      await sourceReader.ready();
    } catch (cause) {
      throw new Error("Slack readerTokenEnv requires a read-only user token for a full member of this workspace.", {
        cause,
      });
    }
  }
  const reader = new SlackConversationReader(input.listener, Date.now, {
    directory: input.directory,
    ...(sourceReader ? { crossChannel: sourceReader } : {}),
  });
  return {
    reader,
    context: (actor: Actor, msg: IncomingMessage) =>
      createSlackContextCapability({
        client: input.listener,
        reader,
        actor,
        msg,
        directory: input.directory,
      }),
  };
}
