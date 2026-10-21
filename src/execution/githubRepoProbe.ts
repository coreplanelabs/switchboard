import { resolveGithubToken, type GithubTokenScope } from "./githubApp.js";
import { classificationOf } from "../core/trace/classify.js";
import { tracedFetch } from "../core/trace/tracedFetch.js";
import type { Span } from "../core/trace/types.js";

// The repository vet of a `repo-cold` run (docs/reference/specs/execution.md item 18):
// the resolver's probe for bare `owner/name` tokens on the machine class that
// never touches the resident registry. One GET /repos/{owner}/{name} with the
// run's own credential — the token its sandbox will hold — so the answer is
// what the run itself will see: 200 is a repository it can reach, 404 is one
// it cannot (outside the App installation, or no such repository), and
// anything GitHub did not settle — another status, a transport failure, a
// credential that could not be minted — is "unreachable": could not verify,
// never a bind and never a refusal. Without a credential — the run's identity
// mints none, or the mint answered null — the vet is anonymous, so a private
// repository reads as 404, as it would to the run.

const REQUEST_TIMEOUT_MS = 10_000;
/** An `owner/name` and nothing else: the slug becomes a URL path segment. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

export interface GithubRepoProbeOptions {
  /** The scope of the credential the run holds (`githubTokenScopeFor` of its
   *  identity): the vet sees what the run sees. Absent — an identity that
   *  mints nothing — the vet is anonymous and the resolver is never asked. */
  scope?: GithubTokenScope;
  fetch?: typeof fetch;
  /** The request's repository-resolution span, when one exists. */
  span?: Span;
  /** The credential resolver; default: the App's installation token (or GH_TOKEN). */
  token?: (scope: GithubTokenScope) => Promise<string | null>;
}

/** The probe `resolveRepoContext` takes: `true` binds, `false` refuses, `"unreachable"` reports. */
export function githubRepoProbe(opts: GithubRepoProbeOptions): (slug: string) => Promise<boolean | "unreachable"> {
  const fetchImpl = opts.fetch ?? fetch;
  const probe = async (slug: string, span?: Span): Promise<boolean | "unreachable"> => {
    if (!SLUG.test(slug)) {
      span?.setAttrs({ outcome: "invalid_slug" });
      return false;
    }
    let bearer: string | null;
    try {
      bearer =
        opts.scope === undefined
          ? null
          : await (opts.token ?? ((scope) => resolveGithubToken(scope, span)))(opts.scope);
    } catch {
      span?.setAttrs({ outcome: "credential_unverified" });
      return "unreachable";
    }
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "switchboard" };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    let res: Response;
    try {
      res = await tracedFetch(
        span,
        `https://api.github.com/repos/${slug}`,
        { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        { route: "repository", name: "github.rest", fetchImpl },
      );
    } catch (error) {
      span?.setAttrs({
        outcome:
          classificationOf(error)?.kind === "timeout" ||
          (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
            ? "timeout_unverified"
            : "transport_unverified",
      });
      return "unreachable";
    }
    if (res.ok) {
      span?.setAttrs({ outcome: "verified" });
      return true;
    }
    if (res.status === 404) {
      span?.setAttrs({ outcome: "not_visible" });
      return false;
    }
    span?.setAttrs({ outcome: "http_unverified" });
    return "unreachable";
  };
  return (slug) =>
    opts.span
      ? opts.span.span("github.repo_probe", (span) => probe(slug, span), {
          ...(opts.scope ? { attrs: { scope: opts.scope } } : {}),
        })
      : probe(slug);
}
