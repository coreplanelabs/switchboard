import type { PersonProfile } from "../core/names.js";
import { WORK_VIEW_ENRICHMENT_TIMEOUT_MS } from "../core/budgets.js";
import type { ExternalIdentity } from "../core/identity/contract.js";
import type { OrganizationStore } from "../core/organization/contract.js";
import type { PersonDirectory } from "../core/identity/contract.js";
import type { IngressTokenMap } from "../core/ingressTokens.js";
import type { PersonLookup } from "./requester.js";

interface RequesterNames {
  organization: string;
  store?: OrganizationStore & { directory: PersonDirectory };
  browserIssuer?: string;
  mcpIssuer?: string;
  slackTeam: string;
  name(id: string): Promise<string | undefined>;
  profile?(id: string): Promise<PersonProfile | undefined>;
  tokens: IngressTokenMap;
  personByEmail?: PersonLookup;
}

/** Keep diagnostics queryable without logging identities or provider payloads. */
function warnRequesterLabel(id: string, reason: "failed" | "timeout" | "unavailable"): void {
  const kind = /^(slack|access|http|mcp|cli|web|person):/.exec(id)?.[1] ?? "unknown";
  console.warn(JSON.stringify({ event: "runs.requester_label.degraded", kind, reason }));
}

/** Display-only account grouping. Original ids still control access and attribution. */
export async function requesterProfile(id: string, options: RequesterNames): Promise<PersonProfile | undefined> {
  const profileOf = async (userId: string): Promise<PersonProfile | undefined> => {
    if (options.profile) return options.profile(userId);
    const name = await options.name(userId);
    return name ? { name } : undefined;
  };
  try {
    if (id.startsWith("slack:")) return await profileOf(id);
    if (/^(http|mcp):/.test(id)) {
      const subject = id.slice(id.indexOf(":") + 1);
      const matches = Object.values(options.tokens).filter((token) => token.subject === subject);
      const emails = new Set(matches.map((token) => token.email));
      if (emails.size !== 1 || emails.has(undefined)) return;
      const person = await options.personByEmail?.(matches[0]!.email!);
      return person ? ((await profileOf(person.id)) ?? (person.name ? { name: person.name } : undefined)) : undefined;
    }
    if (!id.startsWith("access:") || !options.store) return;
    // SSO over MCP and the browser have distinct issuers. Only active links
    // to the same person can supply a common display label.
    const identities: ExternalIdentity[] = [options.browserIssuer, options.mcpIssuer]
      .filter((issuer): issuer is string => !!issuer)
      .map((issuer) => ({ issuer, tenant: null, subject: id.slice(7) }));
    const bindings = await Promise.all(identities.map((identity) => options.store!.directory.resolve(identity)));
    if (bindings.some((binding) => binding.status === "unavailable")) {
      warnRequesterLabel(id, "unavailable");
      return;
    }
    if (bindings.some((binding) => ["invalid", "conflict", "revoked"].includes(binding.status))) return;
    const people = new Set(
      bindings.flatMap((binding) => (binding.status === "bound" ? [binding.binding.personId] : [])),
    );
    if (people.size !== 1) return;
    const personId = [...people][0]!;
    const peers = await options.store.execute({ action: "identities", organization: options.organization, personId });
    if (peers.status !== "identities") {
      if (peers.status === "unavailable") warnRequesterLabel(id, "unavailable");
      return;
    }
    const profiles = new Map<string, PersonProfile>();
    for (const peer of peers.identities) {
      if (peer.issuer !== "https://slack.com" || peer.tenant !== options.slackTeam) continue;
      const current = await options.store.directory.resolve(peer);
      if (current.status === "unavailable") warnRequesterLabel(id, "unavailable");
      if (current.status !== "bound" || current.binding.personId !== personId) continue;
      const profile = await profileOf(`slack:${peer.subject}`);
      if (profile?.name.trim()) profiles.set(profile.name.trim(), profile);
    }
    // Conflicting profiles must not select an arbitrary person's name.
    return profiles.size === 1 ? [...profiles.values()][0] : undefined;
  } catch {
    warnRequesterLabel(id, "failed");
    return undefined;
  }
}

export async function requesterName(id: string, options: RequesterNames): Promise<string | undefined> {
  return (await requesterProfile(id, options))?.name;
}

/** Optional labels have one deadline, including directory and provider reads. */
async function readRequester<T>(
  lookup: ((id: string) => Promise<T | undefined>) | undefined,
  id: string,
): Promise<T | undefined> {
  if (!lookup) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => lookup(id)),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          warnRequesterLabel(id, "timeout");
          resolve(undefined);
        }, WORK_VIEW_ENRICHMENT_TIMEOUT_MS);
      }),
    ]);
  } catch {
    warnRequesterLabel(id, "failed");
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function readRequesterName(
  lookup: ((id: string) => Promise<string | undefined>) | undefined,
  id: string,
): Promise<string | undefined> {
  return readRequester(lookup, id);
}

export async function readRequesterProfile(
  lookup: ((id: string) => Promise<string | PersonProfile | undefined>) | undefined,
  id: string,
): Promise<PersonProfile | undefined> {
  const profile = await readRequester(lookup, id);
  return typeof profile === "string" ? { name: profile } : profile;
}
