/** Startup checks presence only; credentials remain in the secret store. */
export function channelsToStart(present: ReadonlySet<string>): { slack: boolean; linear: boolean } {
  const bot = present.has("SLACK_BOT_TOKEN"),
    app = present.has("SLACK_APP_TOKEN");
  if (bot !== app) throw new Error(`Missing required env var ${bot ? "SLACK_APP_TOKEN" : "SLACK_BOT_TOKEN"}`);
  const linear = present.has("LINEAR_BRIDGE_TOKEN");
  if (!bot && !linear) throw new Error("No channel configured: set Slack tokens or LINEAR_BRIDGE_TOKEN");
  return { slack: bot, linear };
}
