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
// Pure: the view a profile gives a Worker, and the text → text render. Reading
// and writing files is the command's job (src/core/commands/deploy.ts) through
// its injected file access.

import { WORKER_DIRS } from "./plan.js";
import { profileUrls, WORKER_KINDS, type DeploymentProfile, type WorkerKind } from "./profile.js";

export const TEMPLATE_FILE = "wrangler.template.jsonc";
export const RENDERED_FILE = "wrangler.jsonc";

/** The first lines of every rendered file: what it is and how it changes. */
export const GENERATED_HEADER: readonly string[] = [
  "// GENERATED — do not edit. `npm run deploy:gen` (the CLI's `deploy init`) renders this file from",
  "// wrangler.template.jsonc in this directory and the deployment profile (deploy/profile.json).",
  "// Change the template or the profile and re-render; `npm run deploy:check` fails on a hand edit.",
];

/** What a template may name: `{{account}}`, `{{zone}}`, `{{script}}`, `{{hostname}}`,
 *  `{{urls.publicBaseUrl}}`, `{{urls.stateWorkerUrl}}`, `{{urls.docsBaseUrl}}` (inside an
 *  `{{#if urls.docsBaseUrl}}` block — the docs Worker is optional), and inside an
 *  `{{#if access}}` block `{{access.teamDomain}}` / `{{access.aud}}`. */
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
    /** The state Worker other Workers record firings on. */
    stateWorkerUrl: string;
    /** The installation's docs site (its `/docs` redirect target), when the profile has a docs Worker —
     *  a template names it inside an `{{#if urls.docsBaseUrl}}` block. */
    docsBaseUrl?: string;
  };
  /** The Cloudflare Access application in front of the bot, when the installation has one. */
  access: { teamDomain: string; aud: string } | undefined;
}

/** Pure: the view for one Worker; `undefined` when the profile has no such Worker (the optional docs Worker). */
export function templateView(profile: DeploymentProfile, kind: WorkerKind): TemplateView | undefined {
  const worker = profile.workers[kind];
  if (!worker) return undefined;
  const urls = profileUrls(profile);
  return {
    account: profile.account,
    zone: profile.zone,
    script: worker.script,
    hostname: worker.hostname,
    urls: { publicBaseUrl: urls.publicBaseUrl, stateWorkerUrl: urls.stateWorkerUrl, docsBaseUrl: urls.docsBaseUrl },
    access: profile.access,
  };
}

export type RenderOutcome = { ok: true; text: string } | { ok: false; problems: string[] };

const OPEN = /^\s*\/\/ \{\{#if ([A-Za-z0-9_.]+)\}\}\s*$/;
const CLOSE = /^\s*\/\/ \{\{\/if\}\}\s*$/;
const PLACEHOLDER = /\{\{([A-Za-z0-9_.]+)\}\}/g;

/** Pure: render one template against one view. Every line is kept byte for
 *  byte except placeholders (substituted), directive lines (removed), and the
 *  lines of a block whose condition is unset (dropped). Anything unresolved is
 *  a problem naming the line; the render is all-or-nothing. */
export function renderTemplate(template: string, view: TemplateView): RenderOutcome {
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
function lookup(view: TemplateView, path: string): unknown {
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
