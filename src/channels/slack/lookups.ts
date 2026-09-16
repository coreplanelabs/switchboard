// The cached, best-effort reads the adapter makes off the Slack Web API — the
// channel's and the sender's display names, a user's email, the workspace URL —
// and the permalink built from that URL. A failed read is never cached and
// never fails a dispatch.

/** The slice of the Slack Web API the team-URL read uses. */
interface TeamUrlClient {
  auth: { test(): Promise<{ url?: string }> };
}

/** The slice of the Slack Web API the name resolvers use — declared structurally
 *  so both the real WebClient and a test mock satisfy it. */
interface SlackUserRecord {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  profile?: { display_name?: string; real_name?: string; email?: string };
}

export interface NameLookupClient {
  conversations: { info(args: { channel: string }): Promise<{ channel?: { name?: string } }> };
  users: {
    info(args: { user: string }): Promise<{ user?: SlackUserRecord }>;
    /** The reverse lookup the dashboard link uses (record 0042); the same `users:read.email` scope as `info`. */
    lookupByEmail?(args: { email: string }): Promise<{ user?: SlackUserRecord }>;
  };
}

/** The person a verified email names, as the dashboard link resolves it (record 0042). */
export interface LinkedPerson {
  /** Platform-namespaced: `slack:U…`. */
  id: string;
  name?: string;
}

/** How long a person link (a hit or a miss) is held before Slack is asked again. */
export const PERSON_LINK_TTL_MS = 10 * 60_000;
/** The longest a gate pass waits on the reverse lookup; past it the session is unlinked for that request. */
export const PERSON_LINK_TIMEOUT_MS = 1500;

const personByEmailCache = new Map<string, { person: LinkedPerson | undefined; expiresAt: number }>();
const personByEmailInFlight = new Map<string, Promise<LinkedPerson | undefined>>();

const displayNameOf = (u: SlackUserRecord | undefined): string | undefined =>
  u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || undefined;

/**
 * The Slack person whose profile email is `email` (lower-cased, exact), or
 * undefined: no `lookupByEmail` on the client, no such user, a deleted user, a
 * bot or app user, an API failure, or a lookup slower than the timeout. Cached
 * per process for `PERSON_LINK_TTL_MS`, hits and misses alike, and
 * single-flighted, so a page's fan-out (HTML, stream, `/api` calls) costs one
 * lookup per email per window. Never throws.
 */
export function resolvePersonByEmail(
  client: NameLookupClient,
  email: string,
  opts: { now?: () => number; timeoutMs?: number } = {},
): Promise<LinkedPerson | undefined> {
  const key = email.trim().toLowerCase();
  if (!key.includes("@") || typeof client.users.lookupByEmail !== "function") return Promise.resolve(undefined);
  const now = opts.now ?? Date.now;
  const cached = personByEmailCache.get(key);
  if (cached && cached.expiresAt > now()) return Promise.resolve(cached.person);
  const inFlight = personByEmailInFlight.get(key);
  if (inFlight) return inFlight;
  const lookup = (async (): Promise<LinkedPerson | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const call = client.users.lookupByEmail!({ email: key }).then(
        (r) => r.user,
        () => undefined,
      );
      const timedOut = Symbol("person lookup timed out");
      const answer = await Promise.race([
        call,
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), opts.timeoutMs ?? PERSON_LINK_TIMEOUT_MS);
        }),
      ]);
      if (answer === timedOut) return undefined; // not cached: the next request asks again
      const u = answer;
      const person =
        u?.id && !u.deleted && !u.is_bot && !u.is_app_user
          ? { id: `slack:${u.id}`, ...(displayNameOf(u) ? { name: displayNameOf(u) } : {}) }
          : undefined;
      personByEmailCache.set(key, { person, expiresAt: now() + PERSON_LINK_TTL_MS });
      if (personByEmailCache.size > NAME_CACHE_MAX) {
        const oldest = personByEmailCache.keys().next().value;
        if (oldest !== undefined) personByEmailCache.delete(oldest);
      }
      return person;
    } finally {
      if (timer) clearTimeout(timer);
      personByEmailInFlight.delete(key);
    }
  })();
  personByEmailInFlight.set(key, lookup);
  return lookup;
}

// Bounded so a long-lived process can't grow them without limit. On overflow the
// oldest-inserted entry is dropped (Map preserves insertion order) — names are
// cheap to re-resolve, so a simple FIFO bound suffices; no LRU is warranted.
const NAME_CACHE_MAX = 1000;
const channelNameCache = new Map<string, string>();
const userNameCache = new Map<string, string>();

function cachePut(cache: Map<string, string>, key: string, value: string): void {
  cache.set(key, value);
  if (cache.size > NAME_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Resolve a channel's human name (cached, best-effort). Undefined on any API
 *  error or when the channel has no name — the caller falls back to the raw id. A
 *  failed lookup is NOT cached, so a transient error can be retried next time.
 *  Exported for tests. */
export async function resolveChannelName(client: NameLookupClient, channel: string): Promise<string | undefined> {
  const hit = channelNameCache.get(channel);
  if (hit !== undefined) return hit;
  try {
    const info = await client.conversations.info({ channel });
    const name = info.channel?.name;
    if (name) cachePut(channelNameCache, channel, name);
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a user's display name (cached, best-effort): profile.display_name,
 *  then real_name, then the handle. Same failure/caching contract as
 *  `resolveChannelName`. Exported for tests. */
export async function resolveUserName(client: NameLookupClient, user: string): Promise<string | undefined> {
  const hit = userNameCache.get(user);
  if (hit !== undefined) return hit;
  try {
    const u = (await client.users.info({ user })).user;
    const name = u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name;
    if (name) cachePut(userNameCache, user, name);
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** A user's email (`profile.email`), present only when the app holds
 *  `users:read.email`; undefined otherwise or on any failure. Uncached: it is
 *  read once per `mcp add`/`mcp connect` to bind the connect ticket
 *  (docs/reference/specs/mcp-tools.md item 15), never on the message path. */
export async function resolveUserEmail(client: NameLookupClient, user: string): Promise<string | undefined> {
  try {
    const u = (await client.users.info({ user })).user;
    const email = u?.profile?.email;
    return typeof email === "string" && email.includes("@") ? email : undefined;
  } catch {
    return undefined;
  }
}

/** Clear the name caches and the person-link cache — for tests, so cache-hit assertions start clean. */
export function resetSlackNameCaches(): void {
  channelNameCache.clear();
  userNameCache.clear();
  personByEmailCache.clear();
  personByEmailInFlight.clear();
}

/** The permalink Slack itself would mint for a message: `<team url>archives/
 *  <channel>/p<ts sans dot>`, plus the thread qualifier when the message is a
 *  reply. Pure — built from the cached `auth.test` URL, no extra API call. */
export function slackPermalink(teamUrl: string, channel: string, ts: string, threadTs: string): string {
  const base = `${teamUrl.replace(/\/+$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
}

// The workspace URL from auth.test (e.g. https://acme.slack.com/), resolved once
// per process — the permalink on every run's Request block is built from it.
let teamUrl: string | undefined;
export async function resolveTeamUrl(client: TeamUrlClient): Promise<string | undefined> {
  if (teamUrl) return teamUrl;
  try {
    teamUrl = (await client.auth.test()).url ?? undefined;
  } catch (err) {
    console.warn(`[slack] auth.test for the team URL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return teamUrl;
}
