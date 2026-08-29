import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { CostReport, CostsService, DailyCost } from "../core/costs.js";
import { escapeHtml, HTML_PAGE_HEADERS } from "./liveView.js";
import { NAV_CSS, renderNav } from "./nav.js";

// Costs dash: an Access-gated, read-only browser view of what a group of
// deployed pieces costs per day — `GET /costs` (first group), `/costs/<group>`,
// and a JSON twin at `/costs/<group>.json` for agents. Reads both billing
// sources LIVE on every request (nothing cached, nothing stored).
//
// Auth: like /runs and /residents this surface has no token of its own —
// Cloudflare Access is the "who" gate, re-verified fail-closed in
// src/index.ts. The page renders no secrets and no capability links.
//
// Pure server render: the chart is inline SVG with a <title> per segment, so
// the page needs no script and works under the strict shared CSP. Every
// dynamic string is HTML-escaped.

export type CostsRoute = { kind: "page" | "json"; group: string | null };

const GROUP_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function parseCostsRoute(pathname: string): CostsRoute | null {
  if (pathname === "/costs" || pathname === "/costs/") return { kind: "page", group: null };
  if (pathname === "/costs.json") return { kind: "json", group: null };
  const m = /^\/costs\/([^/]+?)(\.json)?\/?$/.exec(pathname);
  if (!m || !GROUP_RE.test(m[1])) return null;
  return { kind: m[2] ? "json" : "page", group: m[1] };
}

// ---- rendering ----------------------------------------------------------------------

const usd = (v: number, digits = 2): string => `$${v.toFixed(digits)}`;

/** Series palette (validated categorical set, light + dark stepped). Order is
 *  fixed by first appearance in the report, never re-ranked. */
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7", "#e34948", "#008300"];
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9", "#e66767", "#008300"];
const DO_LABEL = "Durable Objects";
const LLM_LABEL = "LLM (Anthropic)";

/** Every stackable series in a report, in a stable order: containers (config
 *  order of first appearance), then DOs as one series, then LLM. */
function seriesOf(report: CostReport): string[] {
  const names: string[] = [];
  for (const d of report.days) for (const k of Object.keys(d.containers)) if (!names.includes(k)) names.push(k);
  if (report.days.some((d) => Object.keys(d.durableObjects).length > 0)) names.push(DO_LABEL);
  if (report.llmAvailable) names.push(LLM_LABEL);
  return names;
}

function valueOf(d: DailyCost, series: string): number {
  if (series === DO_LABEL) return Object.values(d.durableObjects).reduce((s, v) => s + v, 0);
  if (series === LLM_LABEL) return d.llmUsd;
  return d.containers[series]?.total ?? 0;
}

function chartSvg(report: CostReport, series: string[]): string {
  const W = 960;
  const H = 260;
  const m = { t: 12, r: 12, b: 30, l: 48 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const days = report.days;
  const max = Math.max(1e-9, ...days.map((d) => d.total)) * 1.08;
  const bw = iw / Math.max(1, days.length);
  const gap = Math.min(10, bw * 0.28);
  const y = (v: number) => m.t + ih - (v / max) * ih;
  let out = "";
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    out += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${m.l - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="tick">${usd(v)}</text>`;
  }
  days.forEach((d, i) => {
    let acc = 0;
    const x = m.l + i * bw + gap / 2;
    const w = bw - gap;
    series.forEach((s, si) => {
      const v = valueOf(d, s);
      if (v <= 0) return;
      const y0 = y(acc + v);
      const y1 = y(acc);
      const h = Math.max(0, y1 - y0 - 2);
      out += `<rect class="seg s${si}" x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"><title>${escapeHtml(d.date)} · ${escapeHtml(s)} · ${usd(v)}</title></rect>`;
      acc += v;
    });
    if (days.length <= 16 || i % Math.ceil(days.length / 16) === 0) {
      out += `<text x="${(x + w / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" class="tick">${escapeHtml(d.date.slice(5))}</text>`;
    }
  });
  out += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="axis"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily cost, stacked by component">${out}</svg>`;
}

function seriesCss(): string {
  const light = SERIES.map((c, i) => `.s${i}{fill:${c}}`).join("");
  const dark = SERIES_DARK.map((c, i) => `.s${i}{fill:${c}}`).join("");
  return `${light}@media (prefers-color-scheme: dark){${dark}}`;
}

function tiles(report: CostReport): string {
  const full = report.range.partialLastDay ? report.days.slice(0, -1) : report.days;
  const yesterday = full[full.length - 1];
  const last7 = full.slice(-7);
  const avg7 = last7.length ? last7.reduce((s, d) => s + d.total, 0) / last7.length : 0;
  const llmShare = report.totals.total > 0 ? Math.round((report.totals.llmUsd / report.totals.total) * 100) : 0;
  const tile = (label: string, value: string, detail: string) => `<div class="tile"><span class="eyebrow">${label}</span><span class="v">${value}</span><span class="d">${detail}</span></div>`;
  return (
    `<section class="tiles">` +
    tile("Yesterday", yesterday ? usd(yesterday.total) : "—", yesterday ? `${escapeHtml(yesterday.date)} · last full day` : "no full day in range") +
    tile("7-day average", usd(avg7), "per day, full days only") +
    tile("Projected month", usd(avg7 * 30.4, 0), "7-day rate × 30.4, before plan fees and included allowances") +
    tile(report.llmAvailable ? "LLM share" : "LLM spend", report.llmAvailable ? `${llmShare}%` : "—", report.llmAvailable ? "of the range total" : "LLM spend not configured") +
    `</section>`
  );
}

function resourceSplit(report: CostReport): string {
  const b = report.totals.byResource;
  const parts: [string, number][] = [
    ["Memory (provisioned while awake)", b.memory],
    ["vCPU (active use only)", b.cpu],
    ["Durable Object duration + requests", b.durableObjects],
    ["Disk (provisioned while awake)", b.disk],
  ];
  const tot = parts.reduce((s, p) => s + p[1], 0) || 1;
  return `<table class="data split">${parts
    .map(([k, v]) => `<tr><td>${k}</td><td class="num">${usd(v)}</td><td class="num">${Math.round((v / tot) * 100)}%</td><td class="bar"><i style="width:${((v / tot) * 100).toFixed(1)}%"></i></td></tr>`)
    .join("")}</table>`;
}

function dataTable(report: CostReport, series: string[]): string {
  const head = `<tr><th>Date</th>${series.map((s) => `<th class="num">${escapeHtml(s)}</th>`).join("")}<th class="num">Total</th></tr>`;
  const rows = report.days
    .map((d) => `<tr><td>${escapeHtml(d.date)}${report.range.partialLastDay && d.date === report.range.to ? ` <span class="muted">(partial day)</span>` : ""}</td>${series.map((s) => `<td class="num">${usd(valueOf(d, s), 3)}</td>`).join("")}<td class="num"><b>${usd(d.total, 3)}</b></td></tr>`)
    .join("");
  return `<table class="data"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

export function renderCostsPage(report: CostReport, groups: string[]): string {
  const series = seriesOf(report);
  const legend = series.map((s, i) => `<span><i class="sw s${i}"></i>${escapeHtml(s)}</span>`).join("");
  const siblings = groups.filter((g) => g !== report.group);
  const nav = siblings.length ? `<nav class="groups">Other groups: ${siblings.map((g) => `<a href="/costs/${escapeHtml(g)}">${escapeHtml(g)}</a>`).join(" · ")}</nav>` : "";
  const ranges = [7, 30, 90].map((n) => (n === report.range.days ? `<b>${n}d</b>` : `<a href="/costs/${escapeHtml(report.group)}?days=${n}">${n}d</a>`)).join(" · ");
  const llmNote = report.llmAvailable
    ? `LLM spend is the Anthropic Admin API cost report for this group's workspace (gross, USD).`
    : `LLM spend not configured — set <code>ANTHROPIC_ADMIN_KEY</code> and the group's <code>anthropicWorkspaceId</code> to layer it in.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(report.label)} spend</title>
<style>
:root{color-scheme:light dark;--bg:#f5f7fa;--surface:#fff;--line:#dbe1ea;--grid:#e8ecf2;--ink:#141a22;--ink-2:#4f5966;--ink-3:#7b8593;--accent:#2a78d6}
@media (prefers-color-scheme: dark){:root{--bg:#12161c;--surface:#1a1f27;--line:#2e3542;--grid:#242b36;--ink:#eef1f5;--ink-2:#aeb6c2;--ink-3:#7d8794;--accent:#3987e5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1080px;margin:0 auto;padding:28px 24px 48px;display:grid;gap:22px}
header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:8px 24px;border-bottom:1px solid var(--line);padding-bottom:14px}
h1{font-size:21px;font-weight:600;margin:0}h2{font-size:15px;font-weight:600;margin:0 0 6px}.sub{color:var(--ink-2);margin:0}
.eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);font-weight:500}
.groups a,.ranges a{color:var(--accent);text-decoration:none}.groups a:hover,.ranges a:hover{text-decoration:underline}
.side{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}.ranges{font-size:12.5px;color:var(--ink-2)}
${NAV_CSS}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:14px 16px;display:grid;gap:2px}
.tile .v{font-size:26px;font-weight:500;line-height:1.1;font-variant-numeric:tabular-nums}.tile .d{color:var(--ink-2);font-size:12.5px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:18px 20px;display:grid;gap:12px}
.card-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:8px 16px}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12.5px;color:var(--ink-2)}.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{width:10px;height:10px;border-radius:2px;display:inline-block}
.chart{overflow-x:auto}svg{display:block;width:100%;height:auto}.grid{stroke:var(--grid)}.axis{stroke:var(--line)}.tick{font-size:11px;fill:var(--ink-3);font-variant-numeric:tabular-nums}
.seg:hover{opacity:.85}
table.data{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
table.data th,table.data td{padding:6px 10px;border-bottom:1px solid var(--grid);text-align:left}table.data th{font-weight:500;color:var(--ink-2);font-size:12px}
table.data .num{text-align:right}.muted{color:var(--ink-3);font-size:12px}
table.split td.bar{width:40%}table.split td.bar i{display:block;height:10px;background:var(--accent);border-radius:2px;opacity:.75}
.note{font-size:12.5px;color:var(--ink-2);margin:0}code{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--bg);padding:1px 5px;border-radius:3px}
details summary{cursor:pointer;color:var(--ink-2);font-size:13px}
.foot{color:var(--ink-3);font-size:12px;border-top:1px solid var(--line);padding-top:14px;display:grid;gap:4px}
${seriesCss()}
</style>
</head>
<body>
<main>
<header>
  <div><h1>${escapeHtml(report.label)} spend</h1><p class="sub">Cost per day by component · ${report.range.days} days · ${escapeHtml(report.range.from)} → ${escapeHtml(report.range.to)}${report.range.partialLastDay ? " (today is a partial day)" : ""}</p></div>
  <div class="side"><span class="ranges">${ranges}</span>${renderNav("costs")}</div>
</header>
${nav}
${tiles(report)}
<section class="card">
  <div class="card-head"><div><h2>Daily cost</h2><p class="sub">Stacked by component · USD at list price · read live from both billing sources</p></div><div class="legend">${legend}</div></div>
  <div class="chart">${chartSvg(report, series)}</div>
  <p class="note">Cloudflare bills vCPU on active use only; memory and disk bill on the provisioned size for every second a container is awake. ${llmNote}</p>
</section>
<section class="card">
  <div class="card-head"><div><h2>What each cloud dollar buys</h2><p class="sub">Cloudflare spend in range, split by billed resource</p></div></div>
  ${resourceSplit(report)}
</section>
<section class="card">
  <details open><summary>Table view — daily cost by component (USD)</summary><div style="overflow-x:auto;margin-top:10px">${dataTable(report, series)}</div></details>
  <p class="note">Machine-readable twin: <code>GET /costs/${escapeHtml(report.group)}.json</code> (same Access gate).</p>
</section>
<footer class="foot">
  <div><b>Method.</b> Cloudflare GraphQL Analytics <code>containersUsageAdaptiveGroups</code> (cpuTimeSec, allocatedMemory, allocatedDisk per app per UTC day) and <code>durableObjectsInvocationsAdaptiveGroups</code> (wallTime, requests per Worker). Prices: vCPU $0.000020/s, memory $0.0000025/GiB-s, disk $0.00000007/GB-s, DO duration $12.50 per million GB-s at 128 MB, DO requests $0.15/M. Gross list price — plan fees and included allowances are not subtracted.</div>
  <div><b>Scope.</b> Only the container apps and Workers mapped to this group in <code>costs.groups.${escapeHtml(report.group)}</code>; everything else in the account is excluded.</div>
</footer>
</main>
</body>
</html>`;
}

// ---- handler ----------------------------------------------------------------------------

const UPSTREAM_REASON_MAX = 400;

function plain(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(body);
}

/**
 * Node http handler for `/costs*`. Returns false for other paths so the server
 * falls through. GET-only. `service` undefined = not configured → 503. Both
 * billing sources are read live per request; an upstream failure is a 502
 * carrying a capped reason, never a 500.
 */
export function createCostsViewHandler(service: CostsService | undefined): (req: HttpRequest, res: ServerResponse) => boolean {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = parseCostsRoute(url.pathname);
    if (!route) return false;

    if ((req.method ?? "GET").toUpperCase() !== "GET") {
      plain(res, 405, "method not allowed", { allow: "GET" });
      return true;
    }
    if (!service) {
      plain(res, 503, "Cost reporting isn't configured — set costs.cloudflareAccountId + costs.groups in config and the CF_ANALYTICS_TOKEN secret to enable this view.");
      return true;
    }
    const groups = service.groups();
    const group = route.group ?? groups[0];
    if (!group || !groups.includes(group)) {
      plain(res, 404, `no cost group named ${route.group ?? "(none)"}`);
      return true;
    }
    service
      .report(group, url.searchParams.get("days"))
      .then((report) => {
        if (route.kind === "json") {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(report));
          return;
        }
        res.writeHead(200, HTML_PAGE_HEADERS);
        res.end(renderCostsPage(report, groups));
      })
      .catch((err: unknown) => {
        const reason = (err instanceof Error ? err.message : String(err)).slice(0, UPSTREAM_REASON_MAX);
        plain(res, 502, `cost sources unavailable: ${reason}`);
      });
    return true;
  };
}
