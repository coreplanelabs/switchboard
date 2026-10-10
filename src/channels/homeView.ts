import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor } from "../core/authz/types.js";
import { predicateFor } from "../core/authz/predicate.js";
import type { createHomeService } from "../core/home/service.js";
import type { PageSender } from "./webShell.js";

type HomeService = ReturnType<typeof createHomeService>;
type Route = { kind: "home" | "snapshot" | "history" } | { kind: "pipeline"; id: string };
function route(path: string): Route | undefined {
  if (path === "/home") return { kind: "home" };
  if (path === "/home/snapshot") return { kind: "snapshot" };
  if (path === "/home/history") return { kind: "history" };
  const match = /^\/pipelines\/([^/]+)$/.exec(path);
  if (!match) return;
  try {
    const id = decodeURIComponent(match[1]);
    if (/^[A-Za-z0-9_-]{1,100}$/.test(id)) return { kind: "pipeline", id };
  } catch {
    /* A malformed key is unknown. */
  }
}
const plain = (res: ServerResponse, status: number, value: string) => {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(value);
};

/** The host supplies tenant and attention recipient after authenticated admission.
 * A proved person can receive attention without replacing the credential's authority. */
export function createHomeViewHandler(service: HomeService, page: PageSender, organizationId: string) {
  return (
    req: IncomingMessage,
    res: ServerResponse,
    context: { actor?: Actor; organization?: string; attentionRecipient?: string } = {},
  ): boolean => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const selected = route(url.pathname);
    if (!selected) return false;
    if (!context.actor || context.organization !== organizationId) {
      plain(res, 404, "not found");
      return true;
    }
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      plain(res, 405, "method not allowed");
      return true;
    }
    const actor = context.actor;
    const reader = {
      actorId: context.attentionRecipient ?? actor.id,
      visibleTo: predicateFor(actor, "runs:read", "run"),
    };
    void (async () => {
      if (selected.kind === "history") {
        const history = await service.history(reader, {
          ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
        });
        if (history.organizationId !== organizationId) {
          plain(res, 404, "not found");
          return;
        }
        page(req, res, 200, actor, "Completed work", { page: "fleetHistory", history });
        return;
      }
      if (selected.kind === "pipeline") {
        const found = await service.pipeline(reader, selected.id);
        if (found.status === "not_found") {
          plain(res, 404, "not found");
          return;
        }
        if (found.status === "unavailable") {
          plain(res, 503, "Work is unavailable.");
          return;
        }
        if (found.organizationId !== organizationId) {
          plain(res, 404, "not found");
          return;
        }
        const moving = new Set(found.movingUnitKeys);
        const units = found.pipeline.units.map((row) =>
          moving.has(row.unit.unit) ? { ...row, activity: "moving" as const } : row,
        );
        page(req, res, 200, actor, "Pipeline", {
          page: "fleetPipeline",
          status: found.status,
          attentionRecipient: reader.actorId,
          pipeline: { ...found.pipeline, units },
        });
        return;
      }
      const snapshot = await service.snapshot(reader);
      if (snapshot.organizationId !== organizationId) {
        plain(res, 404, "not found");
        return;
      }
      if (selected.kind === "snapshot") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ...snapshot, attentionRecipient: reader.actorId }));
      } else page(req, res, 200, actor, "Home", { page: "fleetHome", snapshot, attentionRecipient: reader.actorId });
    })().catch(() => plain(res, 503, "Work is unavailable."));
    return true;
  };
}
