import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";
import { createSlackEmojiCache, FileEmojiStore } from "../src/channels/slackEmoji.js";
import { HOSTED_MCP_PROBE_TIMEOUT_MS } from "../src/core/budgets.js";

type Stage = "arguments" | "token_file" | "onepassword" | "environment" | "token" | "slack_catalog" | "cache";
let stage: Stage = "arguments";
let httpStatus: number | undefined;
let slackError: string | undefined;
const slackErrors = new Set([
  "missing_scope",
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "not_allowed_token_type",
  "access_denied",
  "account_inactive",
  "ratelimited",
  "request_timeout",
  "service_unavailable",
  "internal_error",
  "team_access_not_granted",
  "unable_to_fetch_custom_emojis",
  "org_login_required",
  "enterprise_is_restricted",
]);

// A manual export uses the same downloader and on-disk format as the bot.
// A token is read from one named source and is never a CLI argument or output.
async function main() {
  const { values } = parseArgs({
    options: {
      directory: { type: "string" },
      "token-file": { type: "string" },
      "token-item": { type: "string" },
      "token-field": { type: "string", default: "Bot token" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !values.directory) {
    console.log(
      'Usage: npm run emoji:sync -- --directory <private-cache-directory> [--token-file <path> | --token-item <1Password-item-id> [--token-field "Bot token"]]',
    );
    if (!values.help) process.exitCode = 1;
    return;
  }
  if (values["token-file"] && values["token-item"]) throw new Error("Choose one token source.");
  stage = values["token-file"] ? "token_file" : values["token-item"] ? "onepassword" : "environment";
  const token = values["token-file"]
    ? (await readFile(values["token-file"], "utf8")).trim()
    : values["token-item"]
      ? (
          await promisify(execFile)("op", [
            "item",
            "get",
            values["token-item"],
            "--fields",
            `label=${values["token-field"]}`,
            "--reveal",
          ])
        ).stdout.trim()
      : (process.env.SLACK_EMOJI_TOKEN ?? process.env.SLACK_BOT_TOKEN)?.trim();
  if (!token) {
    console.error("Set SLACK_EMOJI_TOKEN or provide --token-file or --token-item. The token needs emoji:read.");
    process.exitCode = 1;
    return;
  }
  stage = "token";
  // Only an explicitly supplied Slack credential may leave the machine.
  // The request destination is fixed and redirects are refused below.
  if (!/^(?:xox[bp]-|xoxe\.xox[bp]-)[A-Za-z0-9-]+$/.test(token)) {
    console.error(JSON.stringify({ event: "emoji.sync.failed", stage, reason: "invalid_token_format" }));
    process.exitCode = 1;
    return;
  }
  process.umask(0o077);
  stage = "cache";
  const cache = createSlackEmojiCache({ store: new FileEmojiStore(values.directory) });
  const result = await cache.refresh({
    emoji: {
      list: async () => {
        stage = "slack_catalog";
        const response = await fetch("https://slack.com/api/emoji.list", {
          headers: { authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(HOSTED_MCP_PROBE_TIMEOUT_MS),
        });
        httpStatus = response.status;
        if (!response.ok) return { ok: false };
        const payload = await response.json();
        if (payload.ok !== true) slackError = slackErrors.has(payload.error) ? payload.error : "unknown_slack_error";
        else stage = "cache";
        return payload;
      },
    },
  });
  console.log(
    JSON.stringify({
      ...result,
      ...(result.status !== "complete" ? { stage } : {}),
      httpStatus,
      slackError,
      directory: values.directory,
    }),
  );
  if (result.status !== "complete") process.exitCode = 1;
}

main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const errorCode =
    typeof code === "string" && ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT"].includes(code) ? code : undefined;
  const exitCode = typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255 ? code : undefined;
  console.error(
    JSON.stringify({
      event: "emoji.sync.failed",
      stage,
      httpStatus,
      slackError,
      errorCode,
      exitCode,
      reason: "operation_failed",
    }),
  );
  console.error("Emoji sync failed. Check the token source, Slack access, and output directory.");
  process.exitCode = 1;
});
