import { resolveGithubToken } from "./githubApp.js";
import type { Scope } from "../config.js";

// The author binding's read side (record 0062; docs/reference/specs/
// authorization.md item 18): a person's `users.<id>.github` scope key resolved
// to the exact `{ login, id }` pair their commits are authored as. Identity,
// never authority — no gate calls anything here; the writers are `config set
// user` (resolveLogin, over the read credential) and a config.yaml author (a
// bare login, resolved once per process). The numeric id is the durable key
// (record 0062: the numeric id is the durable key): a login can be renamed and re-registered, `GET /user/<id>` follows
// the account — so a stored pair whose id no longer answers the stored login
// is refused with one `[identity]` line and yields no pair, never followed.
//
// Nothing wires a run to this yet: the identity rewrite reads the stored
// binding, and a later unit wires `bindingOf` into `githubEnvs`.

/** One resolved binding: the exact pair (record 0062: exact pairs) later units build the git
 *  author identity from (`<login>`, `<id>+<login>@users.noreply.github.com`). */
export interface GithubBinding {
  login: string;
  id: number;
}

/** Where a stored binding is read from — `ConfigStore.userGithubBinding`. */
export interface BindingSource {
  userGithubBinding(userId: string): Scope["github"];
}

/** One GitHub read over the read credential: the parsed user object, undefined
 *  on 404 (no such login or id — an answer, not an error), a throw naming the
 *  status on anything else, so an outage never reads as "unbound". */
async function githubUser(path: string): Promise<GithubBinding | undefined> {
  const token = await resolveGithubToken("read");
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      accept: "application/vnd.github+json",
      "user-agent": "switchboard",
    },
  });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path}: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const user = (await res.json()) as { login?: unknown; id?: unknown };
  if (typeof user.login !== "string" || !Number.isInteger(user.id))
    throw new Error(`GET ${path} answered without login and id`);
  return { login: user.login, id: user.id as number };
}

/** `GET /users/<login>` — what `config set user` stores the answer of.
 *  Undefined is a 404: the login does not exist, refused by name at the caller. */
export function resolveLogin(login: string): Promise<GithubBinding | undefined> {
  return githubUser(`/users/${encodeURIComponent(login)}`);
}

/** `GET /user/<id>` — the durable read: the account's CURRENT login for an
 *  immutable id, through any rename. Undefined is a 404 (a deleted account). */
export function resolveById(id: number): Promise<GithubBinding | undefined> {
  return githubUser(`/user/${id}`);
}

/** Bare config.yaml logins resolved once per process: login (lowercased)
 *  → pair. A failure is not cached — the next read asks again. */
const loginCache = new Map<string, GithubBinding>();

/**
 * The pair `person`'s commits are authored as, from the STORED binding only:
 * a `{ login, id }` pair an identity admin wrote is re-read by id and
 * refused on a rename; a bare login a config.yaml author wrote is resolved
 * once and cached for the process. No binding, a failed read, or a mismatch →
 * no pair (fail closed: the caller falls back to the bot pair, never guesses).
 */
export async function bindingOf(person: string, store: BindingSource): Promise<GithubBinding | undefined> {
  const stored = store.userGithubBinding(person);
  if (stored === undefined) return undefined;
  if (typeof stored === "string") {
    const key = stored.toLowerCase();
    const cached = loginCache.get(key);
    if (cached) return cached;
    const resolved = await resolveLogin(stored).catch((err: unknown) => {
      console.warn(
        `[identity] resolving login for ${person} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    });
    if (!resolved) return undefined;
    loginCache.set(key, resolved);
    return resolved;
  }
  const current = await resolveById(stored.id).catch((err: unknown) => {
    console.warn(`[identity] resolving id for ${person} failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  });
  if (!current) return undefined;
  if (current.login.toLowerCase() !== stored.login.toLowerCase()) {
    console.warn(
      `[identity] the binding for ${person} names ${stored.login}, but GitHub id ${stored.id} now answers ` +
        `${current.login}; refusing the pair — rebind with \`config set user\``,
    );
    return undefined;
  }
  return { login: stored.login, id: stored.id };
}
