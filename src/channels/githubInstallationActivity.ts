import { prepareSourceEvent, sourceSnapshot } from "../core/runLedger/sourceEvents.js";
import { sourceHash } from "../core/references/receipts.js";
import type { GithubActivitySource, GithubActivityResult } from "./githubActivity.js";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
function repositoryIds(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return;
  const ids: number[] = [];
  for (const item of value) {
    if (!object(item) || !id(item.id)) return;
    ids.push(item.id);
  }
  return ids;
}

/** Installation-wide source facts. A missing repository list is unknown;
 * an empty list is retained data, never proof of current access. */
export async function normalizeGithubInstallationActivity(
  source: Pick<GithubActivitySource, "host" | "appId" | "installationId">,
  headers: { event?: string; delivery?: string },
  value: unknown,
): Promise<GithubActivityResult> {
  const { host, appId, installationId } = source;
  const { event, delivery } = headers;
  const refused = (reason: Extract<GithubActivityResult, { kind: "refused" }>["reason"]): GithubActivityResult => ({
    kind: "refused",
    reason,
  });
  try {
    const url = new URL(`https://${host}`);
    if (
      url.host !== host ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !id(appId) ||
      !id(installationId)
    )
      return refused("invalid-source");
  } catch {
    return refused("invalid-source");
  }
  if (event !== "installation" && event !== "installation_repositories") return { kind: "ignored", reason: "event" };
  if (typeof delivery !== "string" || !delivery) return refused("invalid-payload");
  let native;
  try {
    native = sourceSnapshot(value);
  } catch {
    return refused("invalid-event");
  }
  if (!object(native) || typeof native.action !== "string") return refused("invalid-payload");
  const actions =
    event === "installation"
      ? ["created", "deleted", "new_permissions_accepted", "suspend", "unsuspend"]
      : ["added", "removed"];
  if (!actions.includes(native.action)) return { kind: "ignored", reason: "action" };
  const installation = native.installation;
  if (!object(installation)) return refused("invalid-payload");
  if (installation.id !== installationId || installation.app_id !== appId) return refused("source-mismatch");
  const selection = event === "installation" ? installation.repository_selection : native.repository_selection;
  if (
    (selection !== "all" && selection !== "selected") ||
    (installation.repository_selection !== "all" && installation.repository_selection !== "selected") ||
    !object(installation.permissions) ||
    !Object.values(installation.permissions).every((level) => typeof level === "string" && level.length > 0)
  )
    return refused("invalid-payload");
  const actor = native.sender ?? null;
  if (actor !== null && (!object(actor) || !id(actor.id))) return refused("invalid-payload");
  const repositories = native.repositories === undefined ? null : repositoryIds(native.repositories);
  const added = event === "installation_repositories" ? repositoryIds(native.repositories_added) : null;
  const removed = event === "installation_repositories" ? repositoryIds(native.repositories_removed) : null;
  if (repositories === undefined || added === undefined || removed === undefined) return refused("invalid-payload");
  try {
    const prepared = await prepareSourceEvent({
      version: 1,
      sourceId: `github:${host}:app:${appId}:installation:${installationId}`,
      deliveryId: delivery,
      objectId: `github:${host}:installation:${installationId}`,
      changeId: await sourceHash({ surface: "installation-access", event, native }),
      kind: "source-fact",
      ...(actor ? { authorId: `github:${host}:user:${actor.id}` } : {}),
      payload: {
        version: 1,
        installation: { id: installationId, appId },
        activity: {
          surface: "installation-access",
          event,
          action: native.action,
          repositorySelection: selection,
          installationRepositorySelection: installation.repository_selection,
          repositoryIds: repositories,
          addedRepositoryIds: added,
          removedRepositoryIds: removed,
          permissions: installation.permissions,
          actorId: actor?.id ?? null,
        },
        native,
      },
    });
    return prepared ? { kind: "normalized", event: prepared.event } : refused("invalid-event");
  } catch {
    return refused("invalid-event");
  }
}
