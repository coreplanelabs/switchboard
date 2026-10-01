/** The public Git door surface, shared by the bot and its Cloudflare edge. */
export const GIT_DOOR_PATH =
  /^\/(?:git\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Repository prefix for Git's discovery and upload endpoints. */
export function githubDoorRepositoryPath(repo: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split("/").some((part) => part === "." || part === ".."))
    throw new Error("Git door repository is invalid");
  return `/git/${repo}.git`;
}

export function isGithubDoorPath(path: string): boolean {
  return path === "/api/graphql" || path.startsWith("/api/v3/") || GIT_DOOR_PATH.test(path);
}

export function githubDoorMethodAllowed(url: URL, method: string): boolean {
  const path = url.pathname;
  if (path === "/api/graphql") return method === "POST";
  if (path.startsWith("/api/v3/")) return method === "GET" || method === "HEAD";
  const git = GIT_DOOR_PATH.exec(path);
  if (!git) return false;
  if (git[3] === "info/refs")
    return method === "GET" && ["git-upload-pack", "git-receive-pack"].includes(url.searchParams.get("service") ?? "");
  return method === "POST";
}

/** A configured git.* host exposes only the door. A door path on any other
 * host, including workers.dev and the dashboard host, is never forwarded. */
export function githubDoorEdgeRoute(url: URL, method: string, configuredBase?: string): "door" | "other" | "refuse" {
  const doorPath = isGithubDoorPath(url.pathname);
  if (!configuredBase) return doorPath ? "refuse" : "other";
  let base: URL;
  try {
    base = new URL(configuredBase);
  } catch {
    return "refuse";
  }
  if (base.protocol !== "https:" || base.pathname !== "/" || base.search || base.hash) return "refuse";
  if (url.host === base.host) {
    return url.protocol === "https:" && doorPath && githubDoorMethodAllowed(url, method) ? "door" : "refuse";
  }
  return doorPath ? "refuse" : "other";
}
