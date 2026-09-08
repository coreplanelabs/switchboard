// The hosts our own Workers answer on (features/tracing.md item 21): the one
// set `tracedFetch` consults before it puts a `traceparent` on a request. It is
// computed once at startup from the configured URLs — the resident, the state
// Worker, the sandbox, the public shim — and named in one log line, so the
// header can never leave for GitHub, Slack, a model provider or an MCP server.
// Exact host match (`hostname[:port]`), never a suffix.

export interface InternalHosts {
  readonly hosts: readonly string[];
  has(host: string): boolean;
}

/** The set from the configured URLs; anything unparseable or absent is skipped. */
export function internalHostsOf(urls: ReadonlyArray<string | undefined | null>): InternalHosts {
  const set = new Set<string>();
  for (const u of urls) {
    if (typeof u !== "string" || u === "") continue;
    try {
      const host = new URL(u).host.toLowerCase();
      if (host) set.add(host);
    } catch {
      // not a URL: not a host
    }
  }
  const hosts = [...set].sort();
  return { hosts, has: (host) => set.has(host.toLowerCase()) };
}

export const NO_INTERNAL_HOSTS: InternalHosts = internalHostsOf([]);

let configured: InternalHosts = NO_INTERNAL_HOSTS;

/** The process's set, installed once at startup; `tracedFetch` reads it by default. */
export function configureInternalHosts(hosts: InternalHosts): void {
  configured = hosts;
}

export function internalHosts(): InternalHosts {
  return configured;
}
