// Every Worker's wrangler.jsonc is GENERATED: the template next to it
// (wrangler.template.jsonc) plus the deployment profile give the file wrangler
// reads. The template is itself valid JSONC — placeholders sit inside string
// values (`"account_id": "{{account}}"`) and an optional block is fenced by two
// comment-line directives (`// {{#if access}}` … `// {{/if}}`) — so editors,
// prettier, and wrangler's own `$schema` all read the template as the config it
// describes. What the operator changes is the profile or the template, then
// `deploy init` re-renders; a hand edit to the rendered file is drift that
// `deploy init --check` (the `deploy:check` gate) reports.
//
// The project's docs site (deploy/cloudflare-docs/) is rendered by the same
// machinery from a different view: it is the project's website, not a Worker an
// installation runs, so its script name and hostname are project facts
// (project.json `name` + `docs`), and the only thing the profile contributes is
// the account the project's own CI deploys it to (`siteView`).
//
// Pure: the view a profile gives a Worker, the view the facts give the site, and
// the text → text render. Reading and writing files is the command's job
// (src/core/commands/deploy.ts) through its injected file access.

import { WORKER_DIRS } from "./plan.js";
import { profileUrls, WORKER_KINDS, type DeploymentProfile, type WorkerKind } from "./profile.js";

export const TEMPLATE_FILE = "wrangler.template.jsonc";
export const RENDERED_FILE = "wrangler.jsonc";
/** The project's docs site — the one config under deploy/ that is not a Worker of the installation. */
export const SITE_DIR = "deploy/cloudflare-docs";
/** The facts file the site's view reads (project.json), repo-relative — the path `deploy init` asks its file access for. */
export const PROJECT_FACTS_FILE = "project.json";

/** The first lines of every rendered file: what it is and how it changes. */
export const GENERATED_HEADER: readonly string[] = [
  "// GENERATED — do not edit. `npm run deploy:gen` (the CLI's `deploy init`) renders this file from",
  "// wrangler.template.jsonc in this directory and the deployment profile (deploy/profile.json) —",
  "// the docs site's from project.json and the profile's account.",
  "// Change the template or the profile and re-render; `npm run deploy:check` fails on a hand edit.",
];

/** What a Worker's template may name: `{{account}}`, `{{zone}}`, `{{script}}`, `{{hostname}}`,
 *  `{{urls.publicBaseUrl}}`, `{{urls.stateWorkerUrl}}` (inside an `{{#if urls.stateWorkerUrl}}`
 *  block — the state Worker is optional), and inside an `{{#if access}}` block
 *  `{{access.teamDomain}}` / `{{access.aud}}`. */
export interface TemplateView {
  account: string;
  zone: string;
  /** This Worker's script name — wrangler's `name`. */
  script: string;
  /** This Worker's custom-domain hostname — its route pattern. */
  hostname: string;
  urls: {
    /** The bot's public origin (live-view links, the dashboards). */
    publicBaseUrl: string;
    /** The state Worker other Workers record firings on, when the profile has one —
     *  a template names it inside an `{{#if urls.stateWorkerUrl}}` block. */
    stateWorkerUrl?: string;
  };
  /** The Cloudflare Access application in front of the bot, when the installation has one. */
  access: { teamDomain: string; aud: string } | undefined;
}

/** Pure: the view for one Worker; `undefined` when the profile has no such Worker (an optional one left out). */
export function templateView(profile: DeploymentProfile, kind: WorkerKind): TemplateView | undefined {
  const worker = profile.workers[kind];
  if (!worker) return undefined;
  const urls = profileUrls(profile);
  return {
    account: profile.account,
    zone: profile.zone,
    script: worker.script,
    hostname: worker.hostname,
    urls: { publicBaseUrl: urls.publicBaseUrl, stateWorkerUrl: urls.stateWorkerUrl },
    access: profile.access,
  };
}

/** What the site's template may name: `{{account}}` (the profile's — where the project's own CI
 *  deploys the site), `{{script}}` (`<name>-docs`) and `{{hostname}}` (the host of the `docs` fact). */
export interface SiteView {
  account: string;
  script: string;
  hostname: string;
}

/** Pure: the site's view from the profile's account and the project's facts (project.json parsed:
 *  `name`, the identifier the script name is built from, and `docs`, the URL the site is published
 *  at), or the problem with the facts — never a value from the profile's Workers. */
export function siteView(
  profile: Pick<DeploymentProfile, "account">,
  facts: unknown,
): { ok: true; view: SiteView } | { ok: false; problem: string } {
  const f = facts as { name?: unknown; docs?: unknown } | null;
  if (typeof f?.name !== "string" || f.name === "") return { ok: false, problem: "`name` is missing" };
  if (typeof f.docs !== "string") return { ok: false, problem: "`docs` is missing" };
  let host: string;
  try {
    host = new URL(f.docs).host;
  } catch {
    return { ok: false, problem: `\`docs\` "${f.docs}" is not a URL` };
  }
  if (host === "") return { ok: false, problem: `\`docs\` "${f.docs}" has no host` };
  return { ok: true, view: { account: profile.account, script: `${f.name}-docs`, hostname: host } };
}

export type RenderOutcome = { ok: true; text: string } | { ok: false; problems: string[] };

const OPEN = /^\s*\/\/ \{\{#if ([A-Za-z0-9_.]+)\}\}\s*$/;
const CLOSE = /^\s*\/\/ \{\{\/if\}\}\s*$/;
const PLACEHOLDER = /\{\{([A-Za-z0-9_.]+)\}\}/g;

/** Pure: render one template against one view. Every line is kept byte for
 *  byte except placeholders (substituted), directive lines (removed), and the
 *  lines of a block whose condition is unset (dropped). Anything unresolved is
 *  a problem naming the line; the render is all-or-nothing. */
export function renderTemplate(template: string, view: TemplateView | SiteView): RenderOutcome {
  const problems: string[] = [];
  const out: string[] = [];
  const lines = template.split("\n");
  // The open block, if any; `nested` counts opens seen inside it (a problem, reported once each) so
  // their closes pair with them instead of ending the outer block early.
  let block: { line: number; keep: boolean; nested: number } | undefined;
  for (const [i, line] of lines.entries()) {
    const n = i + 1;
    const open = OPEN.exec(line);
    if (open) {
      if (block) {
        problems.push(`line ${n}: {{#if}} blocks do not nest`);
        block.nested++;
      } else block = { line: n, keep: lookup(view, open[1]) !== undefined, nested: 0 };
      continue;
    }
    if (CLOSE.test(line)) {
      if (!block) problems.push(`line ${n}: {{/if}} closes nothing`);
      else if (block.nested > 0) block.nested--;
      else block = undefined;
      continue;
    }
    if (block && !block.keep) continue;
    out.push(
      line.replace(PLACEHOLDER, (whole, path: string) => {
        const value = lookup(view, path);
        if (typeof value !== "string") {
          problems.push(`line ${n}: ${whole} has no value in the deployment profile`);
          return whole;
        }
        return value;
      }),
    );
  }
  if (block) problems.push(`line ${block.line}: {{#if ${nameAt(lines[block.line - 1])}}} is never closed`);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, text: [...GENERATED_HEADER, ...out].join("\n") };
}

function nameAt(line: string): string {
  return OPEN.exec(line)?.[1] ?? "?";
}

/** A dotted path into the view; `undefined` for anything not there (never throws). */
function lookup(view: TemplateView | SiteView, path: string): unknown {
  let cur: unknown = view;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(key in cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export interface ConfigTarget {
  kind: WorkerKind;
  dir: string;
  templatePath: string;
  outputPath: string;
}

/** Pure: the (template → rendered file) pairs of one installation, in Worker order; only Workers the profile has. */
export function workerConfigTargets(profile: DeploymentProfile): ConfigTarget[] {
  return WORKER_KINDS.filter((kind) => profile.workers[kind] !== undefined).map((kind) => ({
    kind,
    dir: WORKER_DIRS[kind],
    templatePath: `${WORKER_DIRS[kind]}/${TEMPLATE_FILE}`,
    outputPath: `${WORKER_DIRS[kind]}/${RENDERED_FILE}`,
  }));
}

/** The site's (template → rendered file) pair — beside the Workers' in `deploy init`, never in a plan. */
export const SITE_CONFIG_TARGET = {
  dir: SITE_DIR,
  templatePath: `${SITE_DIR}/${TEMPLATE_FILE}`,
  outputPath: `${SITE_DIR}/${RENDERED_FILE}`,
} as const;

export type RenderedConfig = { ok: true; path: string; text: string } | { ok: false; problems: string[] };

/** Pure over an injected reader: the site's rendered config from its template, the profile's account and
 *  the project's facts (project.json's text, or undefined when absent); every problem names its source. */
export function renderSiteConfig(
  profile: Pick<DeploymentProfile, "account">,
  factsText: string | undefined,
  readTemplate: (path: string) => string | undefined,
): RenderedConfig {
  if (factsText === undefined) return { ok: false, problems: [`${PROJECT_FACTS_FILE}: no such file`] };
  let facts: unknown;
  try {
    facts = JSON.parse(factsText);
  } catch {
    return { ok: false, problems: [`${PROJECT_FACTS_FILE}: not JSON`] };
  }
  const view = siteView(profile, facts);
  if (!view.ok) return { ok: false, problems: [`${PROJECT_FACTS_FILE}: ${view.problem}`] };
  const template = readTemplate(SITE_CONFIG_TARGET.templatePath);
  if (template === undefined) return { ok: false, problems: [`${SITE_CONFIG_TARGET.templatePath}: no such file`] };
  const r = renderTemplate(template, view.view);
  return r.ok
    ? { ok: true, path: SITE_CONFIG_TARGET.outputPath, text: r.text }
    : { ok: false, problems: r.problems.map((p) => `${SITE_CONFIG_TARGET.templatePath} ${p}`) };
}

export type RenderedConfigs =
  { ok: true; files: { kind: WorkerKind; path: string; text: string }[] } | { ok: false; problems: string[] };

/** Pure over an injected reader: every Worker's rendered config, or every problem (a template that is not
 *  there, a placeholder without a value) prefixed with the template's path. */
export function renderWorkerConfigs(
  profile: DeploymentProfile,
  readTemplate: (path: string) => string | undefined,
): RenderedConfigs {
  const files: { kind: WorkerKind; path: string; text: string }[] = [];
  const problems: string[] = [];
  for (const target of workerConfigTargets(profile)) {
    const template = readTemplate(target.templatePath);
    if (template === undefined) {
      problems.push(`${target.templatePath}: no such file`);
      continue;
    }
    const view = templateView(profile, target.kind);
    if (!view) continue; // unreachable: targets are the Workers the profile has
    const r = renderTemplate(template, view);
    if (!r.ok) problems.push(...r.problems.map((p) => `${target.templatePath} ${p}`));
    else files.push({ kind: target.kind, path: target.outputPath, text: r.text });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, files };
}

/** ONE Worker's rendered config — for a command that spawns wrangler in that Worker's directory
 *  alone (`deploy secrets`) and must not depend on every other template being present. */
export function renderWorkerConfig(
  profile: DeploymentProfile,
  kind: WorkerKind,
  readTemplate: (path: string) => string | undefined,
): RenderedConfig {
  const target = workerConfigTargets(profile).find((t) => t.kind === kind);
  const view = templateView(profile, kind);
  if (!target || !view) return { ok: false, problems: [`the profile has no ${kind} Worker`] };
  const template = readTemplate(target.templatePath);
  if (template === undefined) return { ok: false, problems: [`${target.templatePath}: no such file`] };
  const r = renderTemplate(template, view);
  return r.ok
    ? { ok: true, path: target.outputPath, text: r.text }
    : { ok: false, problems: r.problems.map((p) => `${target.templatePath} ${p}`) };
}
