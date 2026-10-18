import { FAVICON_DEFAULT } from "./favicon.js";
import { escapeHtml } from "./liveView/html.js";

/** Match the native approval page without depending on a running asset server. */
export function renderMaintenancePage(unavailable: string, reason: string, threadUrl?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Maintenance · Switchboard</title>
<link rel="icon" href="${escapeHtml(FAVICON_DEFAULT)}">
<style>
  .maintenance-page { margin: 0; min-height: 100dvh; background: var(--ui-bg, #fff); color: var(--ui-text, #35363a); font: 14px/1.6 var(--font-sans, "DM Sans Variable", system-ui, sans-serif); -webkit-font-smoothing: antialiased; }
  .maintenance-page * { box-sizing: border-box; }
  .maintenance-brand { display: flex; align-items: center; gap: 10px; padding: 24px 32px; color: var(--ui-text-highlighted, #131416); font-size: 16px; font-weight: 650; }
  .maintenance-brand img { width: 36px; height: 36px; }
  .maintenance-main { width: min(100%, 624px); margin: clamp(24px, 8vh, 96px) auto 48px; padding: 0 24px; }
  .maintenance-eyebrow { display: flex; align-items: center; gap: 7px; margin: 0 0 16px; color: var(--ui-text-muted, #6c6f73); font-size: 11px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; }
  .maintenance-eyebrow svg { width: 16px; height: 16px; }
  .maintenance-main h1 { margin: 0; color: var(--ui-text-highlighted, #131416); font-size: 32px; font-weight: 600; line-height: 1.25; letter-spacing: -.04em; }
  .maintenance-description { margin: 12px 0 28px; color: var(--ui-text-muted, #6c6f73); }
  .maintenance-details { border: 1px solid var(--ui-border, #e5e5e8); border-radius: 8px; overflow: hidden; }
  .maintenance-capabilities, .maintenance-reason { padding: 20px 24px; }
  .maintenance-details h2 { margin: 0 0 10px; font-size: 12px; font-weight: 600; color: var(--ui-text-muted, #6c6f73); }
  .maintenance-details p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .maintenance-reason { border-top: 1px solid var(--ui-border, #e5e5e8); background: color-mix(in srgb, var(--ui-warning, #796315) 6%, var(--ui-bg, #fff)); }
  .maintenance-reason h2 { color: var(--ui-warning, #796315); }
  .maintenance-updates { display: inline-flex; align-items: center; justify-content: center; gap: 16px; min-height: 44px; margin-top: 24px; padding: 10px 18px; border: 1px solid var(--green-accent, #a8e840); border-radius: 6px; background: var(--green-accent, #a8e840); color: var(--green-accent-text, #212c12); font: inherit; font-weight: 500; text-decoration: none; }
  .maintenance-updates:hover { background: #99d33a; }
  .maintenance-page :focus-visible { outline: 2px solid var(--ui-primary, #3c6519); outline-offset: 4px; }
  .maintenance-hint { margin: 16px 0 0; color: var(--ui-text-muted, #6c6f73); font-size: 12px; }
  @media (prefers-color-scheme: dark) {
    .maintenance-page { color-scheme: dark; --ui-bg: #131416; --ui-border: #35363a; --ui-text: #d1d2d6; --ui-text-highlighted: #fafafa; --ui-text-muted: #a7a9b1; --ui-warning: #ffd53c; --ui-primary: #a8e840; }
  }
  @media (max-width: 480px) {
    .maintenance-brand { padding: 20px; }
    .maintenance-main { padding: 0 20px; }
    .maintenance-capabilities, .maintenance-reason { padding: 20px; }
    .maintenance-updates { width: 100%; }
  }
</style>
</head>
<body class="maintenance-page">
<header><div class="maintenance-brand"><img src="${escapeHtml(FAVICON_DEFAULT)}" alt="">Switchboard</div></header>
<main class="maintenance-main" aria-labelledby="maintenance-heading">
  <p class="maintenance-eyebrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m14.7 6.3 3 3M6 18l-2 2m14.6-9.4a6 6 0 0 0 1.1-6.3l-4 4-3-3 4-4a6 6 0 0 0-7.4 7.4L3 15a3.5 3.5 0 0 0 5 5l6.3-6.3a6 6 0 0 0 4.3-3.1Z"/></svg>Service maintenance</p>
  <h1 id="maintenance-heading">Down for maintenance</h1>
  <p class="maintenance-description">The features below are temporarily unavailable.</p>
  <section class="maintenance-details" aria-label="Maintenance details">
    <div class="maintenance-capabilities"><h2>Unavailable during maintenance</h2><p>${escapeHtml(unavailable)}</p></div>
    ${reason ? `<div class="maintenance-reason"><h2>Maintenance note</h2><p>${escapeHtml(reason)}</p></div>` : ""}
  </section>
  ${threadUrl ? `<a class="maintenance-updates" href="${escapeHtml(threadUrl)}">Follow updates in Slack<span aria-hidden="true">&#8594;</span></a><p class="maintenance-hint">Follow the thread for maintenance updates.</p>` : ""}
</main>
</body>
</html>`;
}
