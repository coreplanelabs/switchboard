#!/usr/bin/env node
// The project's identity — its name, where it lives, where its docs are, who
// to write to — is stated once in project.json and copied by hand into the
// files that need it in prose: the community files, the README, the docs
// site's Worker route, the in-product docs redirect. This check reads every
// one of those copies and fails when any of them disagrees with project.json,
// so changing the docs domain or the contact address is one edit plus the
// list of places this prints.
//
//   npm run check:project-facts

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The hand-written files that name the project. A file added here is checked;
 *  one not listed is not — test fixtures with made-up addresses stay out. */
export const CHECKED_FILES = [
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "SUPPORT.md",
  "GOVERNANCE.md",
  "NOTICE",
  "docs/README.md",
  "features/docs-site.md",
  "src/core/docsLink.ts",
  "deploy/cloudflare-docs/wrangler.jsonc",
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DOCS_URL = /https?:\/\/docs\.[A-Za-z0-9.-]+/g;

/**
 * Pure: the disagreements between the facts and one set of file contents
 * (`files` maps path → text; package.json is parsed from its text).
 */
export function factsProblems(facts, files) {
  const problems = [];
  const say = (file, what) => problems.push({ file, what });

  const pkgText = files["package.json"];
  if (pkgText !== undefined) {
    const pkg = JSON.parse(pkgText);
    if (pkg.name !== facts.name) say("package.json", `name is "${pkg.name}", project.json says "${facts.name}"`);
    if (pkg.homepage !== `${facts.repository}#readme`)
      say("package.json", `homepage should be ${facts.repository}#readme`);
    if (pkg.repository?.url !== `git+${facts.repository}.git`)
      say("package.json", `repository.url should be git+${facts.repository}.git`);
    if (pkg.bugs?.url !== `${facts.repository}/issues`)
      say("package.json", `bugs.url should be ${facts.repository}/issues`);
  }

  const docsHost = new URL(facts.docs).host;
  const repoPath = new URL(facts.repository).pathname; // /org/name
  const repoName = repoPath.split("/")[2];
  // A `docs.` host is one of OURS — and so a stale copy when it differs — when
  // it names the project or the organization (`docs.switchboard.old.example`);
  // a third party's documentation (`docs.github.com`) is left alone.
  const ours = (host) => host.includes(facts.name) || host.includes(facts.organization);

  for (const [file, text] of Object.entries(files)) {
    if (file === "package.json") continue;
    for (const m of text.match(EMAIL) ?? []) {
      if (m !== facts.contact) say(file, `contact address "${m}" — project.json says ${facts.contact}`);
    }
    for (const m of text.match(DOCS_URL) ?? []) {
      const host = new URL(m).host;
      if (host !== docsHost && ours(host)) say(file, `docs URL "${m}" — project.json says ${facts.docs}`);
    }
    // The docs Worker's custom domain is the docs host without a scheme.
    for (const m of text.matchAll(/"pattern":\s*"(docs\.[^"]+)"/g)) {
      if (m[1] !== docsHost) say(file, `route pattern "${m[1]}" — project.json says ${docsHost}`);
    }
    // github.com/<org>/<this repo> anywhere must be under the project's org.
    for (const m of text.matchAll(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g)) {
      if (m[2] === repoName && `/${m[1]}/${m[2]}` !== repoPath)
        say(file, `repository "${m[0]}" — project.json says ${facts.repository}`);
    }
  }

  for (const file of ["NOTICE", "GOVERNANCE.md"]) {
    const text = files[file];
    if (text !== undefined && !text.includes(facts.steward.name))
      say(file, `does not name the steward "${facts.steward.name}"`);
  }
  return problems;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const facts = JSON.parse(readFileSync(join(root, "project.json"), "utf8"));
  const files = { "package.json": readFileSync(join(root, "package.json"), "utf8") };
  for (const f of CHECKED_FILES) files[f] = readFileSync(join(root, f), "utf8");
  const problems = factsProblems(facts, files);
  if (problems.length === 0) {
    console.log(`check:project-facts ok — ${CHECKED_FILES.length + 1} file(s) agree with project.json`);
    return;
  }
  for (const p of problems) console.error(`  ${p.file}: ${p.what}`);
  console.error(
    `check:project-facts FAILED — ${problems.length} copy(ies) disagree with project.json; edit them to match (or project.json, if the fact changed)`,
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
