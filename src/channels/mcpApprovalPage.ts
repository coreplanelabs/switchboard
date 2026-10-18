import { escapeHtml } from "./liveView/html.js";
import { FAVICON_DEFAULT } from "./favicon.js";

export interface ApprovalOffer {
  action: string;
  line: string;
  risk: string;
  expiresAt: number;
  run?: {
    label?: string;
    repo?: string;
    agent?: string;
    pr?: number;
  };
}

/** Native forms keep consent available without the dashboard's JavaScript. */
export function renderMcpApprovalPage(text: string, stylesheets: readonly string[], offer?: ApprovalOffer): string {
  const title = offer ? "Approve action" : "Approval status";
  const expiry = offer
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      }).format(offer.expiresAt)
    : "";
  const run = offer?.run;
  const context = run
    ? `<div class="approval-context">
        <h2>Run</h2>${run.label ? `<p class="approval-run-label">${escapeHtml(run.label)}</p>` : ""}
        <dl>${run.repo ? `<dt>${run.pr ? "Pull request" : "Repository"}</dt><dd>${escapeHtml(run.repo)}${run.pr ? `#${escapeHtml(String(run.pr))}` : ""}</dd>` : ""}${run.agent ? `<dt>Agent</dt><dd>${escapeHtml(run.agent)}</dd>` : ""}</dl>
      </div>`
    : "";
  const content = offer
    ? `<p class="approval-description">Review the saved action before you confirm.</p>
      <section class="approval-details" aria-label="Saved action">
        ${context}
        <div class="approval-command"><h2>Action</h2><pre><code>${escapeHtml(offer.line)}</code></pre></div>
        ${offer.risk ? `<div class="approval-risk"><h2>What will happen</h2><p>${escapeHtml(offer.risk)}</p></div>` : ""}
        <div class="approval-expiry"><span>Expires</span><time datetime="${new Date(offer.expiresAt).toISOString()}">${escapeHtml(expiry)}</time></div>
      </section>
      <form method="post" action="${escapeHtml(offer.action)}">
        <button type="submit" name="action" value="approve" class="approval-confirm">Confirm saved action<span aria-hidden="true">&#8594;</span></button>
        <button type="submit" name="action" value="cancel">Cancel</button>
      </form>
      <p class="approval-hint">Approve only an action you requested.</p>`
    : `<div class="approval-result" role="status"><p>${escapeHtml(text)}</p></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Switchboard</title>
<link rel="icon" href="${escapeHtml(FAVICON_DEFAULT)}">
${stylesheets.map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join("\n")}
<style>
  .approval-page { margin: 0; min-height: 100dvh; background: var(--ui-bg, #fff); color: var(--ui-text, #35363a); font: 14px/1.6 var(--font-sans, system-ui, sans-serif); -webkit-font-smoothing: antialiased; }
  .approval-page * { box-sizing: border-box; }
  .approval-brand { display: flex; align-items: center; gap: 10px; padding: 24px 32px; color: var(--ui-text-highlighted, #131416); font-size: 16px; font-weight: 650; text-decoration: none; width: fit-content; }
  .approval-brand img { width: 36px; height: 36px; }
  .approval-main { width: min(100%, 624px); margin: clamp(24px, 8vh, 96px) auto 48px; padding: 0 24px; }
  .approval-eyebrow { display: flex; align-items: center; gap: 7px; margin: 0 0 16px; color: var(--ui-text-muted, #6c6f73); font-size: 11px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; }
  .approval-eyebrow svg { width: 16px; height: 16px; }
  .approval-main h1 { margin: 0; color: var(--ui-text-highlighted, #131416); font-size: 32px; font-weight: 600; line-height: 1.25; letter-spacing: -.04em; }
  .approval-description { margin: 12px 0 28px; color: var(--ui-text-muted, #6c6f73); }
  .approval-details { border: 1px solid var(--ui-border, #e5e5e8); border-radius: 8px; overflow: hidden; }
  .approval-context, .approval-command, .approval-risk { padding: 20px 24px; }
  .approval-context { border-bottom: 1px solid var(--ui-border, #e5e5e8); }
  .approval-run-label { margin: 0; color: var(--ui-text-highlighted, #131416); font-weight: 500; overflow-wrap: anywhere; }
  .approval-context dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 16px; margin: 12px 0 0; font-size: 12px; }
  .approval-context dl:empty { display: none; }
  .approval-context dt { color: var(--ui-text-muted, #6c6f73); }
  .approval-context dd { margin: 0; overflow-wrap: anywhere; }
  .approval-details h2 { margin: 0 0 10px; font-size: 12px; font-weight: 600; color: var(--ui-text-muted, #6c6f73); }
  .approval-command pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .approval-command code { color: var(--ui-text-highlighted, #131416); font: 13px/1.8 var(--font-mono, ui-monospace, monospace); }
  .approval-risk { border-top: 1px solid var(--ui-border, #e5e5e8); background: color-mix(in srgb, var(--ui-warning, #796315) 6%, var(--ui-bg, #fff)); }
  .approval-risk h2 { color: var(--ui-warning, #796315); }
  .approval-risk p, .approval-result p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .approval-expiry { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 16px; padding: 14px 24px; border-top: 1px solid var(--ui-border, #e5e5e8); color: var(--ui-text-muted, #6c6f73); font-size: 12px; }
  .approval-expiry time { font-variant-numeric: tabular-nums; }
  .approval-main form { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
  .approval-main button { display: inline-flex; align-items: center; justify-content: center; gap: 16px; min-height: 44px; padding: 10px 18px; border: 1px solid var(--ui-border, #e5e5e8); border-radius: 6px; background: var(--ui-bg, #fff); color: var(--ui-text, #35363a); font: inherit; font-weight: 500; cursor: pointer; }
  .approval-main button:hover { background: var(--green-hover, #f4f5f6); }
  .approval-main .approval-confirm { border-color: var(--green-accent, #a8e840); background: var(--green-accent, #a8e840); color: var(--green-accent-text, #212c12); }
  .approval-main .approval-confirm:hover { background: #99d33a; }
  .approval-page :focus-visible { outline: 2px solid var(--ui-primary, #3c6519); outline-offset: 4px; }
  .approval-hint { margin: 16px 0 0; color: var(--ui-text-muted, #6c6f73); font-size: 12px; }
  .approval-result { margin-top: 28px; padding: 24px; border: 1px solid var(--ui-border, #e5e5e8); border-radius: 8px; }
  /* The native page follows the system appearance without executable scripts. */
  @media (prefers-color-scheme: dark) {
    .approval-page { color-scheme: dark; --ui-bg: #131416; --ui-border: #35363a; --ui-text: #d1d2d6; --ui-text-highlighted: #fafafa; --ui-text-muted: #a7a9b1; --ui-warning: #ffd53c; --ui-primary: #a8e840; --green-hover: #222326; }
  }
  @media (max-width: 480px) {
    .approval-brand { padding: 20px; }
    .approval-main { padding: 0 20px; }
    .approval-context, .approval-command, .approval-risk, .approval-result { padding: 20px; }
    .approval-expiry { padding: 14px 20px; }
    .approval-main form { flex-direction: column; }
  }
</style>
</head>
<body class="approval-page">
<header><a class="approval-brand" href="/home"><img src="${escapeHtml(FAVICON_DEFAULT)}" alt="">Switchboard</a></header>
<main class="approval-main" aria-labelledby="approval-heading">
  <p class="approval-eyebrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/></svg>Action approval</p>
  <h1 id="approval-heading">${title}</h1>
  ${content}
</main>
</body>
</html>`;
}
