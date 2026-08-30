import { createServer } from "node:http";
import { join } from "node:path";
import { loadWebAssets } from "../src/channels/webAssets.js";
import { makeShellRenderer, WEB_HTML_HEADERS } from "../src/channels/webShell.js";
import type { RunIndexRowSeed, WebSeed } from "../src/channels/webSeed.js";
import { FAVICON_ICO_SVG } from "../src/channels/favicon.js";

// Local visual preview of the web app (web/) with fixture data — no Slack, no
// config.yaml, no credentials. Build the app first (`npm run build` in web/),
// then `npx tsx scripts/web-preview.ts` and open http://localhost:8788/runs.
//
//   /runs            index with a mixed set of rows       /runs?all=1  incl. finished
//   /runs/live-1     a live run fed by a scripted SSE stream (loops forever)
//   /runs/hist-1     a finished run in history mode        /runs/nope   the 404
//   /runs/scheduled  the Scheduled tab                     /residents   /costs

const PORT = Number(process.env.PORT ?? 8788);
const NOW = Date.now();

const assets = loadWebAssets(process.env.SWITCHBOARD_WEB_DIST ?? join(process.cwd(), "web", "dist"));
const shell = makeShellRenderer(assets.entry);

const row = (over: Partial<RunIndexRowSeed>): RunIndexRowSeed => ({
  id: "run-x",
  label: 'coding · acme/web · "fix the build"',
  channelId: "slack:C1",
  userId: "slack:U1",
  finished: false,
  startedAt: NOW - 252_000,
  eventCount: 17,
  ...over,
});

const INDEX_ROWS: RunIndexRowSeed[] = [
  row({ id: "live-1", token: "tok-live-1", label: 'review · coreplanelabs/switchboard · "re-review PR #268 after the repush"', activity: "$ npm test", userName: "justin", sourceUrl: "https://example.slack.com/archives/C1/p1", startedAt: NOW - 252_000 }),
  row({ id: "live-2", token: "tok-live-2", label: 'general · #dev · justin · "what changed in the last deploy?"', startedAt: NOW - 61_000, eventCount: 3 }),
  row({ id: "hist-1", label: 'coding · acme/web · "add retry logic to the webhook sender"', finished: true, persisted: true, startedAt: NOW - 4 * 3_600_000, finishedAt: NOW - 4 * 3_600_000 + 754_000, status: "completed", eventCount: 214, channelId: "cli:local", userId: "cli:justin" }),
  row({ id: "hist-2", label: 'research · #ops · sam · "why did the deploy roll back?"', finished: true, persisted: true, startedAt: NOW - 26 * 3_600_000, finishedAt: NOW - 26 * 3_600_000 + 121_000, status: "failed", activity: "⚠️ resident not onboarded: acme/web", eventCount: 41, channelId: "http:hooks", userId: "http:svc" }),
  row({ id: "hist-3", label: 'coding · acme/api · "bump the SDK"', finished: true, persisted: true, startedAt: NOW - 29.6 * 86_400_000, finishedAt: NOW - 29.5 * 86_400_000, status: "stopped_soft", eventCount: 12, channelId: "mcp:claude", userId: "mcp:justin" }),
];

const HIST_EVENTS = [
  { type: "input", text: "Add **retry logic** to the webhook sender:\n\n- exponential backoff\n- max 5 attempts\n- give up on 4xx", at: NOW - 900_000, seq: 1, source: { channel: "dev", user: "justin", url: "https://example.slack.com/archives/C1/p1" } },
  { type: "context", text: "earlier: we agreed the sender should never retry a 4xx", at: NOW - 900_000, seq: 2 },
  { type: "run_meta", agent: "coding", model: "anthropic/claude-fable-5", effort: "high", repo: "acme/web", ref: "main", pr: 42, at: NOW - 899_000, seq: 3 },
  { type: "turn", durationMs: 74_000, at: NOW - 890_000, seq: 4, usage: { inputTokens: 12_300, outputTokens: 810, cacheReadTokens: 11_200 } },
  { type: "assistant", text: "I'll look at the current sender first, then write the failing tests.", at: NOW - 889_000, seq: 5 },
  { type: "tool_call", callId: "c1", tool: "bash", summary: "$ rg -n 'sendWebhook' src", at: NOW - 888_000, seq: 6 },
  { type: "tool_result", callId: "c1", tool: "bash", ok: true, summary: "(3 chars, 2 lines)", output: "src/webhooks.ts:41:export async function sendWebhook(", at: NOW - 887_000, seq: 7 },
  { type: "tool_call", callId: "c2", tool: "bash", summary: "$ npm test -- webhooks", at: NOW - 886_000, seq: 8 },
  { type: "tool_result", callId: "c2", tool: "bash", ok: false, exitCode: 1, summary: "(120 chars, 9 lines)", output: "FAIL webhooks.test.ts\n  ✗ retries with backoff (new)\n  expected 5 attempts, got 1", at: NOW - 850_000, seq: 9 },
  { type: "skill_use", skill: "http-retries", description: "Backoff patterns for flaky endpoints", agent: "coding", bodyBytes: 2048, source: "https://example.com/skills/http-retries", at: NOW - 840_000, seq: 10 },
  { type: "assistant", text: "Tests are red as expected — implementing the backoff now.", at: NOW - 830_000, seq: 11 },
  { type: "tool_call", callId: "c3", tool: "update_status", summary: "update_status implementing backoff", at: NOW - 829_000, seq: 12 },
  { type: "tool_result", callId: "c3", tool: "update_status", ok: true, summary: "", at: NOW - 829_000, seq: 13 },
  { type: "tool_call", callId: "c4", tool: "bash", summary: "$ npm test", at: NOW - 800_000, seq: 14 },
  { type: "tool_result", callId: "c4", tool: "bash", ok: true, summary: "(400 chars, 31 lines)", output: "PASS webhooks.test.ts (12 tests)", at: NOW - 760_000, seq: 15 },
  { type: "answer", text: "Done — `sendWebhook` now retries with exponential backoff (5 attempts, 4xx gives up immediately). PR updated.", at: NOW - 750_000, seq: 16 },
];

/** The live stream: replays the history script slowly, then keeps the run open. */
function serveLiveStream(res: import("node:http").ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
  res.write("retry: 3000\n\n");
  let i = 0;
  const timer = setInterval(() => {
    if (i < HIST_EVENTS.length - 1) {
      // hold the answer back so the run stays visibly live
      const e = { ...HIST_EVENTS[i], at: Date.now() };
      res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
      i++;
    } else {
      res.write(": hb\n\n");
    }
  }, 1500);
  res.on("close", () => clearInterval(timer));
}

const RESIDENTS = {
  cap: 6,
  count: 2,
  residents: [
    {
      resource: "repo:acme/web",
      commands: { install: "npm ci", build: "npm run build", test: "npm test" },
      effects: { test: "readonly" },
      defaultRef: "main",
      provisioningTimeoutMs: 900000,
      worktreeTtlDays: 7,
      onboardedAt: "2026-08-26T01:02:03.000Z",
      updatedAt: "2026-08-26T01:02:03.000Z",
      live: {
        state: "warm",
        reason: "",
        sha: "0123456789abcdef0123456789abcdef01234567",
        lockfileHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e46",
        provisionedAt: "2026-08-26T01:05:00.000Z",
        lastRefreshAt: "2026-08-30T19:30:00.000Z",
        snapshot: { ref: "main", sha: "0123456789abcdef0123456789abcdef01234567", createdAt: "2026-08-30T19:31:00.000Z", mirrorBackupId: "bk_1", checkoutBackupId: "bk_2" },
        schedules: { refresh: 1, provisionRun: 0, provisionDeadline: 0 },
        threads: [
          { threadKey: "slack:C1:1787954209.398379", ref: "feat/retries", sha: "abcdef1234567890abcdef1234567890abcdef12", user: "worker3", deps: "hardlink", boundAt: "2026-08-30T21:40:00.000Z", lastAttachAt: "2026-08-30T21:45:00.000Z", evicted: false },
          { threadKey: "slack:C1:1787900000.000001", ref: "main", user: "", deps: "install", boundAt: "2026-08-20T10:00:00.000Z", lastAttachAt: "2026-08-20T10:05:00.000Z", evicted: true, evictedAt: "2026-08-27T10:00:00.000Z", evictedWhy: "merged #12" },
        ],
      },
    },
    {
      resource: "repo:acme/api",
      commands: { test: "npm test" },
      defaultRef: "main",
      live: { state: "down", reason: "provision-failed at clone: fatal: could not read Username" },
    },
  ],
};

const day = (date: string, bot: number, llm: number) => ({
  date,
  containers: { "switchboard bot": { cpu: bot * 0.1, memory: bot * 0.8, disk: bot * 0.1, total: bot }, "thread sandboxes": { cpu: 0.1, memory: 0.2, disk: 0.02, total: 0.32 } },
  durableObjects: { RunHistoryDO: 0.12 },
  doRequestsUsd: 0.05,
  cloudUsd: bot + 0.49,
  llmUsd: llm,
  total: bot + 0.49 + llm,
});
const COSTS_DAYS = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(NOW - (29 - i) * 86_400_000);
  return day(d.toISOString().slice(0, 10), 0.6 + Math.sin(i / 3) * 0.3 + i * 0.01, 6 + Math.cos(i / 2) * 4 + (i % 7 === 3 ? 9 : 0));
});
const COSTS = {
  group: "switchboard",
  label: "Switchboard",
  range: { from: COSTS_DAYS[0].date, to: COSTS_DAYS[29].date, days: 30, partialLastDay: true },
  llmAvailable: true,
  days: COSTS_DAYS,
  totals: {
    cloudUsd: COSTS_DAYS.reduce((s, d) => s + d.cloudUsd, 0),
    llmUsd: COSTS_DAYS.reduce((s, d) => s + d.llmUsd, 0),
    total: COSTS_DAYS.reduce((s, d) => s + d.total, 0),
    byResource: { cpu: 2.1, memory: 14.4, disk: 0.8, durableObjects: 3.6 },
  },
};

const SCHEDULED = {
  page: "scheduled" as const,
  now: NOW,
  rows: [
    {
      name: "self-improvement",
      worker: "bot" as const,
      action: { type: "run" as const, command: "friction propose", identity: "cron" },
      cron: "0 14 * * 1",
      description: "Weekly self-improvement pass over recent runs.",
      nextFireAt: NOW + 2 * 86_400_000 + 3 * 3_600_000,
      last: { firedAt: NOW - 5 * 86_400_000, outcome: "completed" as const, runId: "hist-1abcdef", runHref: "/runs/hist-1", detail: "🔍 *Friction proposals* — 244 runs analyzed · 23 recurring patterns · 1 filed" },
    },
    {
      name: "resident-watchdog",
      worker: "resident" as const,
      action: { type: "watchdog" as const },
      cron: "*/10 * * * *",
      description: "Sweep resident refresh stalls.",
      nextFireAt: NOW + 480_000,
      last: { firedAt: NOW - 130_000, outcome: "completed" as const, detail: "3/10 residents · 0 re-armed · 0 timed out · 0 errors" },
    },
  ],
};

function page(pathname: string, all: boolean): { title: string; seed: WebSeed; status?: number } | null {
  if (pathname === "/runs")
    return {
      title: all ? "All runs" : "(2) Live runs",
      seed: { page: "runs", all, retentionDays: 30, now: NOW, rows: all ? INDEX_ROWS : INDEX_ROWS.filter((r) => !r.finished) },
    };
  if (pathname === "/runs/scheduled") return { title: "Scheduled runs", seed: SCHEDULED };
  if (pathname === "/runs/live-1")
    return { title: "Live run", seed: { page: "run", mode: "live", id: "live-1", eventsUrl: "/runs/live-1/events?t=tok-live-1", stopUrl: "/runs/live-1/stop?t=tok-live-1" } };
  if (pathname === "/runs/hist-1")
    return { title: "Run", seed: { page: "run", mode: "history", id: "hist-1", events: HIST_EVENTS as never, status: "completed", eventCount: HIST_EVENTS.length + 3, durationMs: 754_000 } };
  if (pathname.startsWith("/runs/")) return { title: "Run not found", seed: { page: "runNotFound", retentionDays: 30 }, status: 404 };
  if (pathname === "/residents") return { title: "Resident repos", seed: { page: "residents", ...RESIDENTS } };
  if (pathname.startsWith("/residents/")) return { title: "acme/web", seed: { page: "resident", slug: "acme/web", record: RESIDENTS.residents[0] } };
  if (pathname.startsWith("/costs")) return { title: "Switchboard spend", seed: { page: "costs", report: COSTS as never, groups: ["switchboard", "polylane"] } };
  return null;
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (assets.serve(req, res)) return;
  if (url.pathname === "/favicon.ico") {
    res.writeHead(200, { "content-type": "image/svg+xml" });
    res.end(FAVICON_ICO_SVG);
    return;
  }
  if (url.pathname === "/runs/live-1/events") return serveLiveStream(res);
  if (url.pathname === "/runs" && url.searchParams.get("stream") === "1") {
    // The index feed: open + heartbeats (rows stay as seeded).
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    res.write("retry: 3000\n\n");
    const hb = setInterval(() => res.write(": hb\n\n"), 15_000);
    res.on("close", () => clearInterval(hb));
    return;
  }
  if (url.pathname.endsWith("/stop") && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ state: "stopping" }));
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(302, { location: "/runs" });
    res.end();
    return;
  }
  // Phone-viewport harness (preview only): fixed-width iframes so responsive
  // layouts can be screenshotted regardless of the browser window/zoom.
  if (url.pathname === "/preview") {
    const w = Number(url.searchParams.get("w") ?? 390);
    const pages = (url.searchParams.get("pages") ?? "/runs?all=1,/runs/hist-1").split(",");
    const frames = pages.map((p) => `<iframe src="${p.replace(/"/g, "")}" style="width:${w}px;height:800px;border:1px solid #666;margin:8px;vertical-align:top;background:#0b0d12"></iframe>`).join("");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body style="background:#333;margin:0">${frames}</body></html>`);
    return;
  }
  const p = page(url.pathname, url.searchParams.get("all") === "1");
  if (!p) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not a preview route");
    return;
  }
  // Preview-only: framing allowed so a fixed-width <iframe> can emulate a
  // phone viewport for screenshots. Production keeps frame-ancestors 'none'.
  const { "x-frame-options": _xfo, ...headers } = WEB_HTML_HEADERS;
  res.writeHead(p.status ?? 200, { ...headers, "content-security-policy": headers["content-security-policy"].replace("frame-ancestors 'none'", "frame-ancestors 'self'") });
  res.end(shell(p.title, p.seed));
}).listen(PORT, "127.0.0.1", () => console.log(`web preview on http://localhost:${PORT}/runs (fixtures only, no bot)`));
