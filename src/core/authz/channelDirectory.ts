import type { ChannelDirectory, ChannelVisibility } from "./types.js";

// The channel-facts seam (plan KTD4, U3): where dispatch learns a channel's
// visibility before stamping it on the run (KTD7), and — later, U5 — where
// membership facts come from. `authorize` never calls it: decisions read the
// stamped resource and the actor's grants only, so a read costs no Slack call.
//
// This file holds the static first cut: what a platform-namespaced id says on
// its own. Machine channels are `machine`; a Slack DM (`D…`) is `dm`, a Slack
// private group (`G…`) is `private`; a Slack `C…` channel may be public or
// private and only `conversations.info` can tell, so it is `unknown` here —
// and `unknown` is never public (R7): until the Slack adapter supplies a real
// directory, a `slack:C…` run is readable through channel grants only.
// Membership is `unknown` for everyone: the static directory proves nothing
// about who is in a channel.

/** The visibility a channel id alone establishes. Pure; the one mapping. */
export function visibilityOf(channelId: string): ChannelVisibility {
  if (channelId.startsWith("http:") || channelId.startsWith("mcp:")) return "machine";
  if (channelId.startsWith("slack:D")) return "dm";
  if (channelId.startsWith("slack:G")) return "private";
  return "unknown";
}

/** `ChannelDirectory` over `visibilityOf`: resolves at once, never fails, knows no members. */
export class StaticChannelDirectory implements ChannelDirectory {
  async info(channelId: string): Promise<{ visibility: ChannelVisibility }> {
    return { visibility: visibilityOf(channelId) };
  }

  async isMember(_actorId: string, _channelId: string): Promise<boolean | "unknown"> {
    return "unknown";
  }
}

/** The process-wide default a dispatcher without an adapter-supplied directory uses. */
export const STATIC_CHANNEL_DIRECTORY: ChannelDirectory = new StaticChannelDirectory();
