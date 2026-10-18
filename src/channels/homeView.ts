import { homeOverview, HOME_VIEWS, type HomeView, type HomeOverview } from "../core/home/overview.js";
import type { RunsService } from "../core/runsService.js";
import type { Predicate } from "../core/authz/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor } from "../core/authz/types.js";
import { predicateFor } from "../core/authz/predicate.js";
import type { createHomeService, HomeReader } from "../core/home/service.js";
import type { PageSender } from "./webShell.js";
import { homeWeek } from "../core/home/week.js";
import { systemClock } from "../core/trace/clock.js";
import { workReadPredicate, workViewScopeOf } from "./workViewScope.js";
import type { HomeFleetSeed, HomeAnswerTarget, HomeMergeAction } from "./homeSeed.js";
import type { HomeRuntimeContext, HomeThreadProjection } from "./homeRuntime.js";
import { parsePrivateWorkerThreadKey } from "../core/privateWorkerLog.js";
import { parseUnitKey } from "../core/coordinator/contract.js";

type HomeService = ReturnType<typeof createHomeService>;
export interface HomePrivateReadGuard {
  begin(): Promise<boolean>;
  readMany: NonNullable<HomeReader["readPrivateUnits"]>;
  include?(unitKeys: readonly string[]): void;
  canEmit(): Promise<boolean>;
}
type PrivateUnitReader = NonNullable<HomeReader["readPrivateUnit"]>;
export interface HomeViewContext {
  actor?: Actor;
  organization?: string;
  attentionRecipient?: string;
  attentionRecipients?: readonly string[];
  home?: HomeRuntimeContext;
}
type Route =
  { kind: "home" | "snapshot" | "history" } | { kind: "pipeline"; id: string } | { kind: "thread"; key: string };
function route(path: string): Route | undefined {
  if (path === "/home") return { kind: "home" };
  if (path === "/home/snapshot") return { kind: "snapshot" };
  if (path === "/home/history") return { kind: "history" };
  const thread = /^\/threads\/([^/]+)$/.exec(path);
  if (thread) {
    try {
      const key = decodeURIComponent(thread[1]);
      if (parsePrivateWorkerThreadKey(key)) return { kind: "thread", key };
    } catch {
      /* A malformed key cannot name a private unit. */
    }
  }
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
export function createHomeViewHandler(
  service: HomeService,
  page: PageSender,
  organizationId: string,
  options: {
    now?: () => number;
    liveRuns?: (visibleTo: Predicate) => ReturnType<RunsService["listRuns"]>;
    liveTokens?: () => ReadonlyMap<string, string>;
    privateUnit?: (context: HomeViewContext, ...unit: Parameters<PrivateUnitReader>) => Promise<boolean>;
    privateEpoch?: (context: HomeViewContext) => Promise<string | undefined>;
    privateRead?: (context: HomeViewContext) => HomePrivateReadGuard | undefined;
    thread?: (context: HomeViewContext, key: string) => Promise<HomeThreadProjection | undefined>;
    answers?: (
      context: HomeViewContext,
      snapshot: HomeFleetSeed["snapshot"],
    ) => Promise<Record<string, HomeAnswerTarget>>;
    actions?: (
      context: HomeViewContext,
      snapshot: HomeFleetSeed["snapshot"],
    ) => Promise<Record<string, HomeMergeAction>>;
    /** Schedules a bounded supervised read after the initial attention frame. */
    observe?: (context: HomeViewContext, snapshot: HomeFleetSeed["snapshot"]) => void;
    /** One explicit read after a known command result, under the same bounded observer. */
    observeUnit?: (context: HomeViewContext, key: string) => Promise<"observed" | "held" | "unchanged">;
  } = {},
) {
  return (req: IncomingMessage, res: ServerResponse, context: HomeViewContext = {}): boolean => {
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
    const scope = workViewScopeOf(actor);
    const observeKey = url.searchParams.get("observe");
    if (observeKey !== null && (selected.kind !== "snapshot" || actor.viewingAs || scope.mode === "person")) {
      plain(res, 404, "not found");
      return true;
    }
    if (observeKey !== null && (url.searchParams.getAll("observe").length !== 1 || !parseUnitKey(observeKey))) {
      plain(res, 400, "The work key is invalid.");
      return true;
    }
    const privateReads: Parameters<PrivateUnitReader>[] = [];
    let guard: HomePrivateReadGuard | undefined;
    const beginReadPhase = async () => {
      guard = options.privateRead?.(context);
      privateReads.length = 0;
      return guard ? guard.begin() : !options.privateRead;
    };
    const reader = {
      actorId: context.attentionRecipient ?? actor.viewingAs?.id ?? actor.id,
      scopeKey: JSON.stringify([scope.mode, scope.person?.id ?? null, [...scope.ownerIds].sort()]),
      attentionRecipients: context.attentionRecipients ?? [
        ...new Set([context.attentionRecipient ?? actor.viewingAs?.id ?? actor.id, ...scope.ownerIds]),
      ],
      readableTo: predicateFor(actor, "runs:read", "run"),
      visibleTo: workReadPredicate(actor, predicateFor(actor, "runs:read", "run")),
      ...(options.privateRead
        ? {
            readPrivateUnits: (groups: Parameters<NonNullable<HomeReader["readPrivateUnits"]>>[0]) =>
              guard!.readMany(groups),
          }
        : {}),
      ...(options.privateUnit
        ? {
            readPrivateUnit: async (...unit: Parameters<PrivateUnitReader>) => {
              const readable = await options.privateUnit!(context, ...unit);
              if (readable) privateReads.push(unit);
              return readable;
            },
          }
        : {}),
    };
    void (async () => {
      if (!(await beginReadPhase())) {
        plain(res, 404, "not found");
        return;
      }
      const initialEpoch = guard ? undefined : await options.privateEpoch?.(context);
      const canEmit = async (unitKeys: readonly string[] = []) => {
        if (guard) {
          guard.include?.(unitKeys);
          if (await guard.canEmit()) return true;
          plain(res, 404, "not found");
          return false;
        }
        // Legacy private sources need an exact current recipient proof even
        // when they do not participate in the organization's access epoch.
        for (const unit of privateReads) {
          let readable = false;
          try {
            readable = await options.privateUnit!(context, ...unit);
          } catch {
            /* Unavailable proof cannot certify private output. */
          }
          if (!readable) {
            plain(res, 404, "not found");
            return false;
          }
        }
        if (options.privateEpoch && (!initialEpoch || initialEpoch !== (await options.privateEpoch(context)))) {
          plain(res, 404, "not found");
          return false;
        }
        return true;
      };
      if (!guard && options.privateEpoch && !initialEpoch) {
        plain(res, 404, "not found");
        return;
      }
      if (selected.kind === "thread") {
        const projection = await options.thread?.(context, selected.key);
        if (!projection) {
          plain(res, 404, "not found");
          return;
        }
        if (!(await canEmit())) return;
        // The page is only the route shell. Its observer reads current recorded
        // messages; no private input or fabricated run is placed in the seed.
        page(req, res, 200, actor, "Thread", {
          page: "home",
          conversation: selected.key,
          turns: [],
          conversations: [],
          viewer: { name: actor.id },
          lane: selected.key,
          sendUrl: "",
          now: (options.now ?? systemClock)(),
          retentionDays: null,
          suggestions: [],
          commands: [],
        });
        return;
      }
      if (selected.kind === "history") {
        const now = (options.now ?? systemClock)();
        let week;
        try {
          week = homeWeek(now, url.searchParams.get("week") ?? undefined, url.searchParams.get("tz") ?? "UTC");
        } catch {
          plain(res, 400, "Choose a current or past Sunday and a valid time zone.");
          return;
        }
        const history = await service.history(reader, {
          week,
          ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
        });
        if (history.organizationId !== organizationId) {
          plain(res, 404, "not found");
          return;
        }
        if (await canEmit(history.units.map((row) => row.unit.unit)))
          page(req, res, 200, actor, "Completed work", { page: "fleetHistory", history: { ...history, now } });
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
        if (!(await canEmit(units.map((row) => row.unit.unit)))) return;
        page(req, res, 200, actor, "Pipeline", {
          page: "fleetPipeline",
          status: found.status,
          attentionRecipient: reader.actorId,
          attentionRecipients: [...reader.attentionRecipients],
          pipeline: { ...found.pipeline, units },
        });
        return;
      }
      let snapshot = await service.snapshot(reader);
      let observation: "observed" | "held" | "unchanged" | undefined;
      if (observeKey !== null) {
        const needsObservation = snapshot.needsYou.some(
          (row) =>
            row.unit.unit === observeKey && row.conditions.some((condition) => condition.id === `${observeKey}:merge`),
        );
        if (!needsObservation) {
          // A background read can finish this unit before the explicit read.
          // Confirm current readable metadata without another native lookup.
          const key = parseUnitKey(observeKey)!;
          const found = await service.pipeline({ ...reader, visibleTo: reader.readableTo }, key.instanceId);
          if (
            (found.status === "complete" || found.status === "partial") &&
            found.pipeline.units.some(
              (row) => row.unit.unit === observeKey && row.unit.mergeCompletion && row.mergeCompletionForReader,
            )
          ) {
            observation = "observed";
          } else {
            plain(
              res,
              snapshot.status === "complete" ? 404 : 503,
              snapshot.status === "complete" ? "not found" : "Work is unavailable.",
            );
            return;
          }
        }
        if (
          !(await canEmit([
            ...new Set([
              observeKey,
              ...[...snapshot.needsYou, ...snapshot.moving, ...snapshot.waiting].map((row) => row.unit.unit),
            ]),
          ]))
        )
          return;
        if (needsObservation)
          observation = (await options.observeUnit?.(context, observeKey).catch(() => "held" as const)) ?? "held";
        // This is a second current read. No response or private bytes from the
        // pre-observation phase are used as completion evidence.
        if (!(await beginReadPhase())) {
          plain(res, 404, "not found");
          return;
        }
        snapshot = await service.snapshot(reader);
      }
      const disclosedUnitKeys = [...snapshot.needsYou, ...snapshot.moving, ...snapshot.waiting].map(
        (row) => row.unit.unit,
      );
      let overview: HomeOverview | undefined;
      if (options.liveRuns) {
        const listed = await options.liveRuns(reader.visibleTo).catch(() => {
          console.warn(JSON.stringify({ event: "home.runs.unavailable", reason: "read_failed" }));
          return { runs: [], ledgerUnavailable: true };
        });
        const requested = url.searchParams.get("view");
        const requestedView = HOME_VIEWS.includes(requested as HomeView) ? (requested as HomeView) : undefined;
        const rawPage = Number(url.searchParams.get("page") ?? 1);
        const pageNumber = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
        if (listed.runs.length >= 200) console.warn(JSON.stringify({ event: "home.runs.limit_reached", limit: 200 }));
        if (listed.ledgerUnavailable || listed.runs.length >= 200)
          snapshot = { ...snapshot, status: snapshot.status === "unavailable" ? "unavailable" : "partial" };
        const now = (options.now ?? systemClock)();
        let paged = homeOverview(snapshot, listed.runs, { view: requestedView ?? "attention", page: pageNumber }, now);
        if (!requestedView && !paged.overview.counts.attention) {
          const view = paged.overview.counts.moving
            ? "moving"
            : paged.overview.counts.waiting
              ? "waiting"
              : "investigation";
          paged = homeOverview(snapshot, listed.runs, { view, page: pageNumber }, now);
        }
        snapshot = paged.snapshot;
        overview = {
          ...paged.overview,
          ...(listed.ledgerUnavailable || listed.runs.length >= 200 ? { runsPartial: true as const } : {}),
        };
        const tokens = options.liveTokens?.();
        overview.runs = overview.runs.map((run) => {
          const token = tokens?.get(run.id);
          return {
            ...run,
            viewPath: `/runs/${encodeURIComponent(run.id)}${token === undefined ? "" : `?t=${encodeURIComponent(token)}`}`,
          };
        });
      }
      if (snapshot.organizationId !== organizationId) {
        plain(res, 404, "not found");
        return;
      }
      if (selected.kind === "snapshot") {
        if (!(await canEmit(disclosedUnitKeys))) return;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(
          JSON.stringify({
            ...snapshot,
            ...(overview ? { overview } : {}),
            attentionRecipient: reader.actorId,
            attentionRecipients: reader.attentionRecipients,
            ...(observation ? { observation } : {}),
          }),
        );
      } else {
        const answers =
          options.answers && !actor.viewingAs && scope.mode !== "person"
            ? await options.answers(context, snapshot)
            : undefined;
        const actions =
          options.actions && !actor.viewingAs && scope.mode !== "person"
            ? await options.actions(context, snapshot)
            : undefined;
        if (!(await canEmit(disclosedUnitKeys))) return;
        page(req, res, 200, actor, "Home", {
          page: "fleetHome",
          snapshot,
          ...(overview ? { overview } : {}),
          attentionRecipient: reader.actorId,
          attentionRecipients: [...reader.attentionRecipients],
          ...(answers ? { answers } : {}),
          ...(actions ? { actions } : {}),
        });
      }
      options.observe?.(context, snapshot);
    })().catch(() => plain(res, 503, "Work is unavailable."));
    return true;
  };
}
