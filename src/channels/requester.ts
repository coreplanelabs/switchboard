import type { IncomingMessage } from "../core/types.js";

// Who a credential's request is FOR (docs/reference/specs/authorization.md item 15,
// record 0042's amendment). An ingress token, an MCP token or the local CLI
// authenticates a credential, not a person; when the operator bound the
// credential to an email, the adapter resolves that email to the Slack person
// the dashboard link already resolves (`resolvePersonByEmail`) and the message
// names the person as `userId` and the credential as `authenticatedAs`. The
// resolution is identity, never authority: every gate keeps asking about the
// credential (`grantsSubject`), so a bound token holds exactly what config
// grants it — no more because a person is named, no less because a person is
// narrower. Fail-open to the credential alone: no email, no lookup, no match,
// a bot, a deleted user, a failure or a timeout leave the message exactly as
// it was before the binding existed.

/** The person a verified email names (record 0042): `slack:U…` and a display
 *  name, or undefined when nobody, a bot, a deleted user, or a lookup that
 *  failed or timed out — the Slack adapter's `resolvePersonByEmail`. */
export type PersonLookup = (email: string) => Promise<{ id: string; name?: string } | undefined>;

/** The identity fields of the message a bound credential sends. */
export type Requester = Pick<IncomingMessage, "userId" | "userName" | "authenticatedAs">;

/** The requester for `credentialId` (`http:<subject>`, `mcp:<subject>`,
 *  `cli:local`): the person `email` names when the lookup finds one, else the
 *  credential itself. Never throws. */
export async function boundRequester(
  credentialId: string,
  email: string | undefined,
  personByEmail: PersonLookup | undefined,
): Promise<Requester> {
  if (!email || !personByEmail) return { userId: credentialId };
  const person = await personByEmail(email).catch(() => undefined);
  if (!person || !person.id.startsWith("slack:") || person.id === credentialId) return { userId: credentialId };
  return {
    userId: person.id,
    ...(person.name ? { userName: person.name } : {}),
    authenticatedAs: credentialId,
  };
}
