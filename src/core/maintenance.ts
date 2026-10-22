import { z } from "zod";
import { maintenancePageResponse, maintenancePageRoute } from "../channels/maintenancePage.js";
import { systemClock } from "./trace/clock.js";
import { tracedFetch } from "./trace/tracedFetch.js";
import { internalHostsOf } from "./trace/internalHosts.js";
import { SECOND_MS } from "./budgets.js";
import { stateWorkerOf, type SecretReader, type StateWorkerBlocks } from "./stateWorkerRef.js";

export const maintenanceScopeSchema = z.enum(["all", "agents", "residents", "web"]);
export type MaintenanceScope = z.infer<typeof maintenanceScopeSchema>;
const threadSchema = z.object({
  channel: z.string().min(1),
  ts: z.string().min(1),
  url: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname.endsWith(".slack.com") && url.pathname.startsWith("/archives/");
    }),
});
const episodeSchema = z.object({
  id: z.string().uuid(),
  phase: z.enum(["announced", "active", "ended"]),
  scopes: z.array(maintenanceScopeSchema).min(1).max(4),
  reason: z.string().max(500),
  channel: z.string().min(1).max(128),
  startsAt: z.string().datetime({ offset: true }).optional(),
  timing: z.string().max(120),
  actor: z.string().min(1),
  updatedAt: z.number().finite(),
  thread: threadSchema.optional(),
  notice: z.object({ status: z.enum(["sending", "sent", "unverified"]), detail: z.string().optional() }),
});
const documentSchema = z.object({ episode: episodeSchema.nullable() });
export type MaintenanceEpisode = z.infer<typeof episodeSchema>;
export interface MaintenanceSnapshot {
  version: number;
  episode: MaintenanceEpisode | null;
}
export interface MaintenanceStore {
  read(): Promise<MaintenanceSnapshot>;
  write(expectedVersion: number, document: { episode: MaintenanceEpisode | null }): Promise<MaintenanceSnapshot>;
}
export class MaintenanceConflict extends Error {}
export class InMemoryMaintenanceStore implements MaintenanceStore {
  private state: MaintenanceSnapshot = { version: 0, episode: null };
  async read(): Promise<MaintenanceSnapshot> {
    return structuredClone(this.state);
  }
  async write(expectedVersion: number, document: { episode: MaintenanceEpisode | null }): Promise<MaintenanceSnapshot> {
    if (expectedVersion !== this.state.version)
      throw new MaintenanceConflict("Maintenance changed. Read status before retrying.");
    this.state = { ...documentSchema.parse(document), version: expectedVersion + 1 };
    return this.read();
  }
}

/** Reuse ConfigDO's compare-and-swap document API; maintenance has no process cache or expiry. */
export class WorkerMaintenanceStore implements MaintenanceStore {
  constructor(private readonly options: { baseUrl: string; token: string; fetch?: typeof fetch }) {}
  private async post(path: string, body: object): Promise<Record<string, unknown>> {
    const response = await tracedFetch(
      undefined,
      `${this.options.baseUrl.replace(/\/+$/, "")}${path}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" },
        body: JSON.stringify({ key: "maintenance", ...body }),
        signal: AbortSignal.timeout(10 * SECOND_MS),
      },
      { route: path, fetchImpl: this.options.fetch ?? fetch, hosts: internalHostsOf([this.options.baseUrl]) },
    );
    if (response.status === 409) throw new MaintenanceConflict("Maintenance changed. Read status before retrying.");
    if (!response.ok) throw new Error(`Maintenance store HTTP ${response.status}.`);
    return (await response.json()) as Record<string, unknown>;
  }
  async read(): Promise<MaintenanceSnapshot> {
    try {
      const data = await this.post("/config/get", {});
      if (!Number.isSafeInteger(data.version) || (data.version as number) < 0)
        throw new Error("Invalid maintenance version.");
      if (data.version === 0 && data.document === null) return { version: 0, episode: null };
      const parsed = documentSchema.safeParse(data.document);
      if (!parsed.success) throw new Error("Invalid maintenance document. Access remains closed.");
      return { ...parsed.data, version: data.version as number };
    } catch (error) {
      const status = error instanceof Error ? /^Maintenance store HTTP (\d{3})\.$/.exec(error.message)?.[1] : undefined;
      console.warn("[maintenance.read]", {
        stateWorker: new URL(this.options.baseUrl).origin,
        kind: status ? "http" : error instanceof SyntaxError ? "invalid_json" : "unavailable",
        ...(status ? { status: Number(status) } : {}),
      });
      throw error;
    }
  }
  async write(expectedVersion: number, document: { episode: MaintenanceEpisode | null }): Promise<MaintenanceSnapshot> {
    const parsed = documentSchema.parse(document);
    const data = await this.post("/config/put", { expectedVersion, document: parsed });
    if (data.ok !== true || data.version !== expectedVersion + 1) throw new Error("Unverified maintenance write.");
    return { ...parsed, version: data.version as number };
  }
}

export function buildMaintenanceStore(config: StateWorkerBlocks, secrets: SecretReader): MaintenanceStore | undefined {
  const worker = stateWorkerOf(config);
  if (!worker) return undefined;
  const token = secrets.named(worker.tokenEnv ?? "MEMORY_TOKEN");
  // A configured store must never turn a missing credential into open admission.
  if (!token) throw new Error(`Missing ${worker.tokenEnv ?? "MEMORY_TOKEN"} for maintenance state.`);
  return new WorkerMaintenanceStore({ baseUrl: worker.baseUrl, token: token.reveal() });
}

export const MAINTENANCE_UNAVAILABLE = "Maintenance status is unavailable. No new work can start.";
const actions: Record<MaintenanceScope, string> = {
  all: "use Switchboard agents or web pages",
  agents: "start or continue agent work",
  residents: "start or continue agent work or run repository tests and builds",
  web: "use Switchboard web pages",
};
export function maintenanceRefusal(
  state: MaintenanceSnapshot,
  scope: Exclude<MaintenanceScope, "all">,
): string | undefined {
  const episode = state.episode;
  if (
    !episode ||
    episode.phase !== "active" ||
    !episode.scopes.some((s) => s === "all" || s === scope || (scope === "agents" && s === "residents"))
  )
    return;
  return `Down for maintenance. You cannot ${episode.scopes.map((s) => actions[s]).join("; ")}.${episode.reason ? ` ${episode.reason}` : ""}${episode.thread ? ` Follow this thread for updates: ${episode.thread.url}` : ""}`;
}
export async function agentMaintenanceRefusal(store?: MaintenanceStore): Promise<string | undefined> {
  if (!store) return;
  try {
    return maintenanceRefusal(await store.read(), "agents");
  } catch {
    return MAINTENANCE_UNAVAILABLE;
  }
}

/** These routes retain their own authentication. They do not admit new agent work. */
export function maintenanceControlPath(path: string): boolean {
  return (
    path === "/healthz" ||
    path === "/mcp" ||
    path === "/settings/approve" ||
    /^\/api\/[a-z]+\.[a-z]+$/.test(path) ||
    /^\/admin\/coordinator\/(?:authorize|instances|plan|unit-progress|unit-start|branch|spawn|read-record|steer|pr-check|recover-unit|round|unit-end|unit-wake|checks|merge|rebase|finish)$/.test(
      path,
    ) ||
    /^\/admin\/coordinator\/instances\/[A-Za-z0-9_-]+(?:\/events)?$/.test(path) ||
    [
      "/admin/restart",
      "/admin/restart/hard",
      "/admin/crash",
      "/admin/model-proxy/bearer",
      "/admin/reply-probe",
      "/admin/trace/log",
      "/harness/tools",
      "/harness/authorize",
      "/harness/tool",
      "/harness/compaction",
      "/v1/messages",
      "/v1/chat/completions",
      "/v1/responses",
      "/plane/effects",
      "/artifacts/copy",
      "/artifacts/publish-pr-image",
      "/internal/depot-ci",
      "/internal/depot-ci/authorization",
    ].includes(path) ||
    /^\/(?:git\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(path) ||
    path === "/api/graphql" ||
    path.startsWith("/api/v3/")
  );
}
export async function maintenanceGate(request: Request, store?: MaintenanceStore): Promise<Response | undefined> {
  if (!store || maintenanceControlPath(new URL(request.url).pathname)) return;
  try {
    return maintenanceResponse(request, await store.read());
  } catch {
    if (maintenancePageRoute(request))
      return maintenancePageResponse(
        request,
        "Switchboard web pages are temporarily unavailable.",
        MAINTENANCE_UNAVAILABLE,
      );
    return Response.json(
      { error: "maintenance_unavailable", message: MAINTENANCE_UNAVAILABLE },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
export function maintenanceResponse(request: Request, state: MaintenanceSnapshot): Response | undefined {
  const path = new URL(request.url).pathname;
  if (maintenanceControlPath(path)) return;
  const page = maintenanceRefusal(state, "web");
  const ingress = ["/ingress", "/webhooks/github"].includes(path) ? maintenanceRefusal(state, "agents") : undefined;
  const message = page ?? ingress;
  if (!message) return;
  const headers = { "cache-control": "no-store" };
  if (!["GET", "HEAD"].includes(request.method) || request.headers.get("accept")?.includes("application/json"))
    return Response.json({ error: "maintenance", message, episodeId: state.episode?.id }, { status: 503, headers });
  const thread = state.episode?.thread;
  return maintenancePageResponse(
    request,
    `You cannot ${state.episode!.scopes.map((s) => actions[s]).join("; ")}.`,
    state.episode!.reason,
    thread?.url,
  );
}

export interface MaintenanceNotice {
  channel: string;
  threadTs?: string;
  text: string;
}
export interface MaintenanceInput {
  scopes?: MaintenanceScope[];
  reason?: string;
  channel?: string;
  startsAt?: string;
  timing?: string;
  id?: string;
}
export class MaintenanceService {
  constructor(
    private readonly options: {
      store: MaintenanceStore;
      clock?: () => number;
      id?: () => string;
      post?: (notice: MaintenanceNotice) => Promise<NonNullable<MaintenanceEpisode["thread"]>>;
    },
  ) {}
  private changed(episode: MaintenanceEpisode): MaintenanceEpisode {
    return {
      ...episode,
      updatedAt: (this.options.clock ?? systemClock)(),
      notice: {
        status: this.options.post ? "sending" : "unverified",
        detail: "Notice delivery has not been verified. Do not repost automatically.",
      },
    };
  }
  private async create(
    input: MaintenanceInput,
    actor: string,
    phase: "announced" | "active",
  ): Promise<MaintenanceSnapshot> {
    const before = await this.options.store.read();
    if (before.episode?.notice.status === "sending")
      throw new MaintenanceConflict(
        "A maintenance notice is still sending. Read status before creating another episode.",
      );
    if (before.episode && before.episode.phase !== "ended")
      throw new MaintenanceConflict("A maintenance episode is already open. Use its episode ID.");
    const episode = episodeSchema.parse(
      this.changed({
        id: (this.options.id ?? (() => crypto.randomUUID()))(),
        phase,
        scopes: input.scopes ?? ["all"],
        reason: input.reason ?? "",
        channel: input.channel ?? "switchboard-dev",
        timing: input.timing ?? "in a few minutes",
        ...(input.startsAt ? { startsAt: input.startsAt } : {}),
        actor,
        updatedAt: 0,
        notice: { status: "unverified" },
      }),
    );
    return this.options.store.write(before.version, { episode });
  }
  private async publish(state: MaintenanceSnapshot, text: string, root = false): Promise<MaintenanceSnapshot> {
    const episode = state.episode!;
    const unverified = async () => {
      try {
        return await this.options.store.write(state.version, {
          episode: {
            ...episode,
            notice: {
              status: "unverified",
              detail: "Notice outcome is unverified. Check Slack before any new notice.",
            },
          },
        });
      } catch {
        return this.options.store.read().catch(() => state);
      }
    };
    if (!this.options.post || (!episode.thread && !root))
      return episode.notice.status === "sending" ? unverified() : state;
    try {
      const receipt = threadSchema.parse(
        await this.options.post({
          channel: episode.thread?.channel ?? episode.channel,
          ...(episode.thread ? { threadTs: episode.thread.ts } : {}),
          text,
        }),
      );
      // The committed phase reserves its notice. A retry must not send it twice,
      // even if delivery or this receipt write has an unknown outcome.
      return await this.options.store.write(state.version, {
        episode: { ...episode, thread: episode.thread ?? receipt, notice: { status: "sent" } },
      });
    } catch {
      return unverified();
    }
  }
  private unavailableActions(episode: MaintenanceEpisode): string {
    return episode.scopes.map((s) => actions[s]).join("; ");
  }
  async announce(input: MaintenanceInput, actor: string): Promise<MaintenanceSnapshot> {
    const state = await this.create(input, actor, "announced");
    const episode = state.episode!;
    const when = episode.startsAt
      ? `at ${new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(episode.startsAt))}`
      : episode.timing;
    return this.publish(
      state,
      `Switchboard will be under maintenance ${when}. You will not be able to ${this.unavailableActions(episode)}.${episode.reason ? ` ${episode.reason}` : ""} Follow this thread for updates.`,
      true,
    );
  }
  async start(input: MaintenanceInput, actor: string): Promise<MaintenanceSnapshot> {
    if (!input.id) {
      const state = await this.create(input, actor, "active");
      return this.publish(
        state,
        `Switchboard is down for maintenance now. You cannot ${this.unavailableActions(state.episode!)}.${input.reason ? ` ${input.reason}` : ""} Follow this thread for updates.`,
        true,
      );
    }
    const before = await this.options.store.read();
    const episode = before.episode;
    if (!episode || episode.id !== input.id)
      throw new MaintenanceConflict("The maintenance episode does not match. Read status.");
    if (episode.phase === "ended") throw new MaintenanceConflict("This maintenance episode has ended.");
    if (episode.phase === "active") return before;
    if (episode.notice.status === "sending")
      throw new MaintenanceConflict("A maintenance notice is still sending. Read status before activation.");
    const state = await this.options.store.write(before.version, {
      episode: this.changed({ ...episode, phase: "active", actor }),
    });
    return this.publish(
      state,
      `Maintenance has started. You cannot ${this.unavailableActions(episode)}. Follow this thread for updates.`,
    );
  }
  async end(id: string, actor: string, withoutNotice = false): Promise<MaintenanceSnapshot> {
    const before = await this.options.store.read();
    const episode = before.episode;
    if (!episode || episode.id !== id)
      throw new MaintenanceConflict("The maintenance episode does not match. Read status.");
    if (episode.phase === "ended" && !(withoutNotice && episode.notice.status === "sending")) return before;
    if (episode.notice.status === "sending" && !withoutNotice)
      throw new MaintenanceConflict(
        "A maintenance notice is still sending. Read status, or end with --without-notice and own the Slack correction.",
      );
    const state = await this.options.store.write(before.version, {
      episode: {
        ...this.changed({ ...episode, phase: "ended", actor }),
        ...(withoutNotice
          ? {
              notice: {
                status: "unverified" as const,
                detail:
                  "Operator ended without a notice. An earlier notice can still arrive; the operator owns Slack correction.",
              },
            }
          : {}),
      },
    });
    if (withoutNotice) return state;
    return this.publish(
      state,
      episode.phase === "announced"
        ? "Planned maintenance is cancelled. Access remains open."
        : "Maintenance is complete. The affected Switchboard features are available again.",
    );
  }
  async update(id: string, message: string, actor: string): Promise<MaintenanceSnapshot> {
    const before = await this.options.store.read();
    if (!before.episode || before.episode.id !== id || !before.episode.thread)
      throw new MaintenanceConflict(
        "The maintenance episode has no verified notice thread. Reconcile the Slack notice first.",
      );
    if (before.episode.notice.status === "sending")
      throw new MaintenanceConflict("A maintenance notice is still sending. Read status before another update.");
    const state = await this.options.store.write(before.version, {
      episode: this.changed({ ...before.episode, actor }),
    });
    return this.publish(state, message);
  }
}
