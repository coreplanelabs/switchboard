import { homeOverview, HOME_VIEWS, type HomeView, type HomeOverview } from "../src/core/home/overview.js";
import { reviewReportFixture, reviewComparisonFixture } from "./web-review-fixture.js";
import { DAY_MS } from "../src/core/budgets.js";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HomeSession, HomeConversationEntry } from "../src/channels/homeSeed.js";
import type { WebSeed, HomeSeed, PageSeed, UnitSeed } from "../src/channels/webSeed.js";
import type { HomeSnapshot, HomeUnit } from "../src/core/home/service.js";
import type { Actor } from "../src/core/authz/types.js";
import { homeWeek } from "../src/core/home/week.js";

/** Local fiction only. No dispatcher, credential, model or external request is used. */
export const GREEN_PREVIEW_NOTICE = "Preview data · Fictional local fixtures. No agents or external actions run.";
const ORGANIZATION = "organization:preview";
const ACTOR = "access:preview";
type PreviewPage = {
  title: string;
  seed: PageSeed & Pick<WebSeed, "asUser"> & { preview?: string };
  status?: number;
  viewer?: Actor;
};
export function createGreenPreview(options: { now: number; unit: UnitSeed["view"]; thread: HomeSeed }) {
  const reviewReport = reviewReportFixture(options.now - (options.now % DAY_MS) - 6 * DAY_MS);
  const reviewComparison = reviewComparisonFixture(options.now - (options.now % DAY_MS) - 6 * DAY_MS);
  let revision = 1;
  let sequence = 0;
  const transcripts = new Map<string, HomeConversationEntry[]>();
  const issued = new Set<string>();
  const receipts = new Map<string, { payload: string; receipt: unknown }>();
  const subscribers = new Map<ServerResponse, string | null>();
  const unit = options.unit;
  const canonicalThread = unit.threads.coding ?? "web:a1:conv-1";
  const allowedThreads = new Set(
    [canonicalThread, unit.threads.review, "web:a1:conv-1", "web:a1:conv-live"].filter(
      (value): value is string => !!value,
    ),
  );
  const streamKey = (thread: string | null) => thread ?? "broad";
  const append = (thread: string | null, entry: Omit<HomeConversationEntry, "id" | "at">) => {
    const key = streamKey(thread);
    transcripts.set(key, [
      ...(transcripts.get(key) ?? []),
      { ...entry, id: `preview:entry:${++sequence}`, at: options.now },
    ]);
  };
  append(null, { role: "user", isViewer: true, source: "browser", content: "What needs my attention?" });
  append(null, {
    role: "assistant",
    isViewer: false,
    authorLabel: "Switchboard",
    source: "browser",
    content:
      "**Preview:** one unit awaits your decision, two units are moving, and another is waiting for checks. These are fictional work records.",
  });
  for (const thread of allowedThreads) {
    append(thread, {
      role: "user",
      isViewer: false,
      authorLabel: "Morgan",
      source: "slack",
      content: "Preview: a teammate asked about this unit.",
    });
    append(thread, {
      role: "user",
      isViewer: false,
      source: "slack",
      content: "Preview: this retained message has no known author.",
    });
    append(thread, {
      role: "assistant",
      isViewer: false,
      authorLabel: "Build bot",
      source: "slack",
      content: "Preview: an external integration reported its check result.",
    });
    append(thread, {
      role: "user",
      isViewer: false,
      authorLabel: "Automation on your behalf",
      source: "http",
      content: "Preview: an automation submitted this message on your behalf.",
    });
  }
  const issue = () => {
    const key = `preview:${randomUUID()}`;
    issued.add(key);
    return key;
  };
  const session = (thread: string | null): HomeSession => ({
    version: 1,
    organization: ORGANIZATION,
    actor: ACTOR,
    stream: "person:preview",
    bindingRevision: 0,
    accessEpoch: "fixture:current-source",
    revision,
    ...(!thread
      ? { repositories: { status: "complete" as const, repositories: [{ repo: "acme/api" }, { repo: "acme/web" }] } }
      : {}),
    entries: transcripts.get(streamKey(thread)) ?? [],
    history: { cursor: transcripts.get(streamKey(thread))?.length ?? 0, hasMore: false, status: "complete" },
    destination: thread
      ? {
          kind: "thread",
          label: thread === canonicalThread ? "Confirm the review before merging" : "Messages in this thread",
          thread,
          revision: 1,
          canWrite: true,
          ...(thread === canonicalThread ? { primaryAction: { label: "Merge", text: "merge" } } : {}),
        }
      : { kind: "broad", label: "Messages", thread: null, revision: 1, canWrite: true },
    sendUrl: "/home/send",
    eventsUrl: `/home/events${thread ? `?thread=${encodeURIComponent(thread)}` : ""}`,
    commands: options.thread.commands,
    submissionKey: issue(),
  });
  const publish = () => {
    for (const [response, thread] of subscribers) response.write(`data: ${JSON.stringify(session(thread))}\n\n`);
  };
  const homeUnit = (id: number): HomeUnit => {
    const original = id === 13;
    const key = original ? unit.unit : `${unit.instance.id}:U${id}`;
    return {
      unit: {
        unit: key,
        instanceId: unit.instance.id,
        id: `U${id}`,
        title: original
          ? "Confirm the review before merging"
          : id === 14
            ? "Build the next delivery view"
            : id === 15
              ? "Check repository access"
              : id === 16
                ? "Wait for pull request checks"
                : `Preview work ${id}`,
        branch: original ? unit.branch : `preview/u${id}`,
        threads: original ? unit.threads : {},
        sourceUrls: {},
        rounds: original ? unit.rounds : [],
        ...(original && unit.pr ? { pr: unit.pr } : {}),
      },
      instance: unit.instance,
      conditions:
        id === 13 || id === 16
          ? [
              {
                id: `preview:condition:${id}`,
                unitKey: key,
                revision: 1,
                state: "open",
                owner: id === 13 ? { kind: "person", id: ACTOR } : { kind: "external", label: "GitHub checks" },
                summary:
                  id === 13
                    ? "Review is complete. Confirm whether to merge this change."
                    : "The pull request checks are still running.",
                nextAction: id === 13 ? "Answer here" : "Wait for the checks to finish",
              },
            ]
          : [],
      nextAction:
        id === 13
          ? { kind: "recorded", text: "Answer here" }
          : id === 16
            ? { kind: "recorded", text: "Wait for the checks to finish" }
            : { kind: "unknown" },
    };
  };
  const snapshot = (scale: boolean): HomeSnapshot & { attentionRecipient: string } => {
    const needsYou = [homeUnit(13)];
    const moving = [homeUnit(14), homeUnit(15)];
    const waiting = [homeUnit(16), ...(scale ? Array.from({ length: 997 }, (_, index) => homeUnit(index + 17)) : [])];
    return {
      organizationId: ORGANIZATION,
      attentionRecipient: ACTOR,
      status: "complete",
      access: "authorized",
      needsYou,
      moving,
      waiting,
      pipelines: [
        {
          instance: unit.instance,
          unresolved: needsYou.length + moving.length + waiting.length,
          needsYou: needsYou.length,
          moving: moving.length,
          waiting: waiting.length,
        },
      ],
    };
  };
  const dashboard = (url: URL): { snapshot: HomeSnapshot; overview?: HomeOverview } => {
    const source = snapshot(url.searchParams.get("scale") === "1001");
    if (url.searchParams.get("scale") === "backlog") {
      source.waiting = Array.from({ length: 1040 }, (_, i) => {
        const row = homeUnit(i + 17);
        const id = `pipeline-${String(i % 1011).padStart(4, "0")}`;
        row.instance = { ...row.instance, id };
        row.unit = { ...row.unit, unit: `${id}:U${i + 17}`, instanceId: id };
        return row;
      });
      const groups = new Map<string, HomeSnapshot["pipelines"][number]>();
      for (const row of [...source.needsYou, ...source.moving, ...source.waiting]) {
        const current = groups.get(row.instance.id) ?? {
          instance: row.instance,
          unresolved: 0,
          needsYou: 0,
          moving: 0,
          waiting: 0,
        };
        current.unresolved++;
        current.waiting++;
        groups.set(row.instance.id, current);
      }
      source.pipelines = [...groups.values()];
    }
    // Compare the same local fixture with the previous unbounded page shape.
    if (url.searchParams.get("unbounded") === "1") return { snapshot: source };
    const raw = url.searchParams.get("view");
    const view = HOME_VIEWS.includes(raw as HomeView) ? (raw as HomeView) : "attention";
    const page = Number(url.searchParams.get("page") ?? 1);
    return homeOverview(
      source,
      [
        {
          id: "live-1",
          label: "Review the API change",
          agent: "review",
          repo: "acme/api",
          startedAt: options.now - 60_000,
          finished: false,
          eventCount: 14,
          liveState: { state: "working", since: options.now - 60_000, bound: options.now + 60_000 },
        },
      ],
      { view, page: Number.isSafeInteger(page) && page > 0 ? page : 1 },
      options.now,
    );
  };
  const marked = (page: PreviewPage): PreviewPage => ({
    ...page,
    seed: { ...page.seed, asUser: { id: ACTOR, name: "Your account" }, preview: GREEN_PREVIEW_NOTICE },
  });
  function page(url: URL): PreviewPage | null {
    if (url.pathname === "/home" || url.pathname === "/plane")
      return marked({
        title: "Home preview",
        seed: {
          page: "fleetHome",
          attentionRecipient: ACTOR,
          answers: {
            [unit.unit]: {
              thread: canonicalThread,
              revision: 1,
              question: "Review is complete. Confirm whether to merge this change.",
              primaryAction: { label: "Merge", text: "merge" },
            },
          },
          ...dashboard(url),
        },
      });
    if (url.pathname === "/home/history") {
      let week;
      try {
        week = homeWeek(options.now, url.searchParams.get("week") ?? undefined, url.searchParams.get("tz") ?? "UTC");
      } catch {
        return marked({ title: "Week unavailable", status: 400, seed: { page: "runNotFound", retentionDays: 30 } });
      }
      const row = homeUnit(12);
      row.unit.ending = { kind: "merged", at: options.now, report: "Preview: this fictional unit was merged." };
      return marked({
        title: "Completed work preview",
        seed: {
          page: "fleetHistory",
          history: {
            organizationId: ORGANIZATION,
            status: "complete",
            now: options.now,
            week,
            units: row.unit.ending.at >= week.start && row.unit.ending.at < week.end ? [row] : [],
          },
        },
      });
    }
    if (url.pathname.startsWith("/pipelines/")) {
      if (decodeURIComponent(url.pathname.slice("/pipelines/".length)) !== unit.instance.id)
        return marked({ title: "Pipeline unavailable", seed: { page: "runNotFound", retentionDays: 30 }, status: 404 });
      const view = snapshot(false);
      const completed = homeUnit(12);
      completed.unit.ending = { kind: "merged", at: options.now, report: "Preview: this fictional unit was merged." };
      return marked({
        title: "Pipeline preview",
        seed: {
          page: "fleetPipeline",
          status: view.status,
          attentionRecipient: ACTOR,
          pipeline: {
            ...view.pipelines[0],
            units: [
              ...view.needsYou,
              ...view.moving.map((row) => ({ ...row, activity: "moving" as const })),
              ...view.waiting,
              completed,
            ],
          },
        },
      });
    }
    if (url.pathname.startsWith("/runs/unit/")) {
      const key = decodeURIComponent(url.pathname.slice("/runs/unit/".length));
      if (key.startsWith(`${unit.instance.id}:U`) && key !== unit.unit && key !== `${unit.instance.id}:U14`) {
        const id = Number(key.split(":U")[1]);
        if (!Number.isSafeInteger(id) || id < 12 || id > 1013) return null;
        const row = homeUnit(id);
        return marked({
          title: `Unit U${id} preview`,
          seed: {
            page: "unit",
            view: { ...row.unit, instance: row.instance, runs: [] },
            now: options.now,
            retentionDays: 30,
          },
        });
      }
    }
    if (url.pathname.startsWith("/threads/")) {
      const thread = decodeURIComponent(url.pathname.slice("/threads/".length));
      if (allowedThreads.has(thread))
        return marked({
          title: "Unit thread preview",
          seed: { ...options.thread, conversation: thread, elsewhere: { surface: "slack" } },
        });
    }
    if (url.pathname === "/metrics" || url.pathname === "/metrics/health" || url.pathname === "/metrics/week")
      return marked({
        title: {
          "/metrics": "Review usage preview",
          "/metrics/health": "System health preview",
          "/metrics/week": "Week over week preview",
        }[url.pathname],
        seed: {
          page: "reviewsMetrics",
          report: reviewReport,
          ...(url.pathname === "/metrics/week" ? { comparison: reviewComparison } : {}),
          requesterNames: { [ACTOR]: "Your account" },
        },
      });
    // These source integrations are intentionally unavailable in the preview.
    if (url.pathname === "/settings/identities")
      return marked({
        title: "Identities preview",
        seed: {
          page: "settings",
          viewer: ACTOR,
          tab: "installation",
          vocabulary: { agents: [], efforts: [], identities: [], machines: [] },
        },
      });
    return null;
  }
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  async function body(request: IncomingMessage): Promise<Record<string, unknown> | null> {
    let value = "";
    for await (const chunk of request) {
      value += String(chunk);
      if (Buffer.byteLength(value) > 65_536) return null;
    }
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  async function handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === "/" || url.pathname === "/plane") {
      response.writeHead(302, { location: "/home" });
      response.end();
      return true;
    }
    if (url.pathname === "/metrics.json") {
      if ((request.method ?? "GET").toUpperCase() !== "GET") json(response, 405, { status: "invalid", preview: true });
      else json(response, 200, reviewReport);
      return true;
    }
    if (url.pathname === "/metrics/week.json") {
      if ((request.method ?? "GET").toUpperCase() !== "GET") json(response, 405, { status: "invalid", preview: true });
      else json(response, 200, { ...reviewReport, comparison: reviewComparison });
      return true;
    }
    if (url.pathname === "/home/session") {
      const thread = url.searchParams.get("thread");
      if (thread !== null && !allowedThreads.has(thread)) json(response, 404, { status: "not_found", preview: true });
      else json(response, 200, session(thread));
      return true;
    }
    if (url.pathname === "/home/key") {
      json(response, 200, { key: issue(), preview: true });
      return true;
    }
    if (url.pathname === "/home/snapshot") {
      const current = dashboard(url);
      json(response, 200, { ...current.snapshot, overview: current.overview });
      return true;
    }
    if (url.pathname === "/home/events") {
      const thread = url.searchParams.get("thread");
      if (thread && !allowedThreads.has(thread)) {
        json(response, 404, { status: "not_found", preview: true });
        return true;
      }
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
      response.write(`data: ${JSON.stringify(session(thread))}\n\n`);
      if (request.headers?.["x-switchboard-preview-snapshot"] === "1") {
        response.end();
        return true;
      }
      subscribers.set(response, thread);
      const heartbeat = setInterval(() => response.write(": preview heartbeat\n\n"), 15_000);
      response.on("close", () => {
        clearInterval(heartbeat);
        subscribers.delete(response);
      });
      return true;
    }
    if (url.pathname !== "/home/focus" && url.pathname !== "/home/send") return false;
    if (request.method !== "POST") {
      json(response, 405, { status: "invalid", preview: true });
      return true;
    }
    const input = await body(request);
    if (!input) {
      json(response, 400, { status: "invalid", preview: true });
      return true;
    }
    if (url.pathname === "/home/focus") {
      if (typeof input.thread !== "string" || !allowedThreads.has(input.thread))
        json(response, 404, { status: "not_found", preview: true });
      else json(response, 200, session(input.thread));
      return true;
    }
    const destination = input.destination as { kind?: string; thread?: string } | undefined;
    const thread =
      destination?.kind === "broad"
        ? null
        : destination?.kind === "thread" && typeof destination.thread === "string"
          ? destination.thread
          : undefined;
    if (thread === undefined || (thread && !allowedThreads.has(thread))) {
      json(response, 404, { status: "not_found", preview: true });
      return true;
    }
    if (
      typeof input.key !== "string" ||
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.length > 32_768 ||
      input.revision !== 1 ||
      !Array.isArray(input.context) ||
      input.context.length > 8
    ) {
      json(response, 400, { status: "invalid", preview: true });
      return true;
    }
    const payload = JSON.stringify({
      text: input.text,
      destination: input.destination,
      revision: input.revision,
      context: input.context,
    });
    const previous = receipts.get(input.key);
    if (previous) {
      json(
        response,
        previous.payload === payload ? 200 : 409,
        previous.payload === payload
          ? { ...(previous.receipt as object), duplicate: true }
          : { status: "conflict", reason: "Preview key was already used with different content.", preview: true },
      );
      return true;
    }
    if (!issued.has(input.key)) {
      json(response, 403, { status: "not_found", preview: true });
      return true;
    }
    issued.delete(input.key);
    revision++;
    append(thread, { role: "user", isViewer: true, source: "browser", content: input.text });
    append(thread, {
      role: "receipt",
      isViewer: false,
      authorLabel: "Preview receipt",
      source: "browser",
      content: "Preview receipt: message recorded locally. No model, agent or external action ran.",
    });
    const receipt = {
      status: "accepted",
      revision,
      duplicate: false,
      preview: true,
      reason: "Fixture acceptance only. No agent ran.",
    };
    receipts.set(input.key, { payload, receipt });
    publish();
    json(response, 200, receipt);
    return true;
  }
  return { page, handle, marked, snapshot };
}
