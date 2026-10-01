/** Source-read recovery is separate from whether an answer may publish. */
export type SlackSourceDenialReason = "cross_dm_forbidden" | "temporarily_unavailable" | "unavailable";

const RECOVERY = {
  cross_dm_forbidden: {
    action: "provide_content_here",
    instruction:
      "Reading another DM is not supported. Changing permissions cannot enable this read. Ask the requester to paste the relevant text or upload the file here if they may share it.",
  },
  temporarily_unavailable: {
    action: "retry_later",
    instruction: "The source read is temporarily unavailable. Retry later; no permission change is indicated.",
  },
  unavailable: {
    action: "provide_content_here",
    instruction:
      "The source is unavailable; its existence and access are unconfirmed. Ask the requester to paste the relevant text or upload the file here if they may share it.",
  },
} as const;

export type SlackSourceDenial = {
  readonly kind: "refused";
  readonly content: string;
} & (
  | {
      readonly reason: "cross_dm_forbidden" | "unavailable";
      readonly recovery: typeof RECOVERY.cross_dm_forbidden | typeof RECOVERY.unavailable;
    }
  | { readonly reason: "temporarily_unavailable"; readonly recovery: typeof RECOVERY.temporarily_unavailable }
);

/** A fixed recovery per reason; provider messages cannot prescribe a remedy. */
export function slackSourceDenial(reason: SlackSourceDenialReason, file = false): SlackSourceDenial {
  return {
    kind: "refused",
    ...(reason === "temporarily_unavailable"
      ? { reason, recovery: RECOVERY.temporarily_unavailable }
      : { reason, recovery: RECOVERY[reason] }),
    content: file
      ? "slack_context: I can't read that file from the linked message."
      : "slack_context: I can't read that Slack source.",
  };
}
