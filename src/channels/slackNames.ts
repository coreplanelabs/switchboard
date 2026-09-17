import type { NameDirectory } from "../core/names.js";
import { resolveChannelName, resolveUserName, type NameLookupClient } from "./slack/lookups.js";

// The Slack `NameDirectory`: the adapter's own cached, best-effort lookups
// (`users.info`, `conversations.info` — the ones the runs index labels ride on)
// behind the core seam, keyed by platform-namespaced ids. Only a Slack id is
// this adapter's to name: a `slack:U…` person, a `slack:C…` or `slack:G…`
// channel. A DM (`slack:D…`) has no name and answers undefined, like every
// non-Slack id, so the surface shows what it has.

const PERSON = /^slack:U/;
const CHANNEL = /^slack:[CG]/;

export function slackNames(client: NameLookupClient): NameDirectory {
  return {
    person: (id) => (PERSON.test(id) ? resolveUserName(client, id.slice("slack:".length)) : Promise.resolve(undefined)),
    channel: (id) =>
      CHANNEL.test(id) ? resolveChannelName(client, id.slice("slack:".length)) : Promise.resolve(undefined),
  };
}
