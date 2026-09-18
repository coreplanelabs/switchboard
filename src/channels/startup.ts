/** Startup checks presence only; credentials remain in the secret store. */
export function channelsToStart(present: ReadonlySet<string>): { slack: boolean; linear: boolean } {
  const bot = present.has("SLACK_BOT_TOKEN"),
    app = present.has("SLACK_APP_TOKEN");
  if (bot !== app) throw new Error(`Missing required env var ${bot ? "SLACK_APP_TOKEN" : "SLACK_BOT_TOKEN"}`);
  const linear = present.has("LINEAR_BRIDGE_TOKEN");
  if (!bot && !linear) throw new Error("No channel configured: set Slack tokens or LINEAR_BRIDGE_TOKEN");
  return { slack: bot, linear };
}

/** The edge can run separately from the server that hosts run pages. */
export function linearBridgeBaseUrl(env: { LINEAR_BRIDGE_URL?: string; PUBLIC_BASE_URL?: string }): string {
  const value = env.LINEAR_BRIDGE_URL ?? env.PUBLIC_BASE_URL;
  if (!value) throw new Error("LINEAR_BRIDGE_TOKEN requires LINEAR_BRIDGE_URL or PUBLIC_BASE_URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("LINEAR_BRIDGE_URL must be an HTTPS or HTTP loopback origin");
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "LINEAR_BRIDGE_URL must be an HTTPS or HTTP loopback origin without credentials, a path, query or fragment",
    );
  return url.origin;
}
