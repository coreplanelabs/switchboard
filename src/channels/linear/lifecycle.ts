import { object, type LinearApi } from "./api.js";
import { linearThread } from "./session.js";
import type { LinearStore } from "./store.js";
import type { LinearWebhookEvent } from "./webhook.js";

/** Called only after signature and installation validation, before acknowledging
 * the delivery. CAS fences a refresh; the original installation time fences a
 * delayed revocation delivered after a workspace installed the app again. */
export async function revokeLinearInstallation(store: LinearStore, event: LinearWebhookEvent): Promise<boolean> {
  if (event.payload.type !== "OAuthApp" || event.payload.action !== "revoked") return false;
  const createdAt = typeof event.payload.createdAt === "string" ? Date.parse(event.payload.createdAt) : NaN;
  if (!Number.isFinite(createdAt)) throw new Error("linear_invalid_revocation");
  for (;;) {
    const current = await store.getInstallation(event.payload.organizationId);
    if (!current) return true;
    if (current.installedAt !== undefined && current.installedAt > createdAt) return false;
    if (await store.replaceInstallation(current.organizationId, current.version, undefined)) return true;
  }
}

export interface LinearLiveWork {
  id: string;
  threadKey?: string;
  channelId?: string;
  userId?: string;
  startedAt: number;
}

/** These are infrastructure cancellations following signed lifecycle events,
 * not human stop requests. They can remove authority, never confer it. */
export async function handleLinearLifecycle(
  deps: { live(): Promise<LinearLiveWork[]>; halt(id: string): Promise<void>; api(org: string): LinearApi },
  event: LinearWebhookEvent,
): Promise<void> {
  const p = event.payload;
  const revoked = p.type === "OAuthApp" && p.action === "revoked";
  const permissions = p.type === "PermissionChange" && p.action === "teamAccessChanged";
  const unassigned = p.type === "AppUserNotification" && p.action === "issueUnassignedFromYou";
  // Session webhooks own dispatch. The inbox also echoes mentions, assignments
  // and comments; routing those again would create a second task.
  if (!revoked && !permissions && !unassigned) return;
  const removed = new Set(
    Array.isArray(p.removedTeamIds) ? p.removedTeamIds.filter((id) => typeof id === "string") : [],
  );
  for (const run of await deps.live()) {
    const thread = linearThread(run.threadKey ?? "");
    if (!thread || thread.organizationId !== p.organizationId || run.startedAt > event.receivedAt) continue;
    let stop =
      revoked || (permissions && [...removed].some((id) => run.channelId === `linear:${p.organizationId}:${id}`));
    const scopedOrigin =
      run.channelId?.startsWith(`linear:${p.organizationId}:project:`) ||
      run.channelId?.startsWith(`linear:${p.organizationId}:document:`);
    if (!stop && permissions && scopedOrigin && (removed.size > 0 || p.canAccessAllPublicTeams === false)) {
      // A project may retain access through another team. Re-evaluate its
      // current origin and requester rather than treating a removed team as
      // either an unconditional stop or permission to keep running.
      try {
        stop = !run.userId || !(await deps.api(thread.organizationId).canRead(thread.sessionId, run.userId));
      } catch {
        stop = true;
      }
    }
    if (!stop && (unassigned || (permissions && p.canAccessAllPublicTeams === false && !scopedOrigin))) {
      try {
        const session = await deps.api(thread.organizationId).session(thread.sessionId);
        if (session.appUserId !== p.appUserId) continue;
        stop =
          !!session.dismissedAt ||
          !!(
            unassigned &&
            session.issue &&
            session.issue.id === object(p.notification).issueId &&
            session.issue.delegateId !== session.appUserId
          );
      } catch {
        // A permission contraction whose current scope cannot be established
        // must not leave an executor running on formerly accessible context.
        stop = true;
      }
    }
    if (stop) await deps.halt(run.id);
  }
}
