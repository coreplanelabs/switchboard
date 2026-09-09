#!/usr/bin/env node
// The project's identity — its name, where it lives, where its docs are, who
// to write to, the image it publishes, how it describes itself — is stated
// once in project.json and copied by hand into the files that need it in
// prose: the community files, the README and its badges, the docs site's
// Worker route, the in-product docs redirect, the compose file's `image:`
// line. This check reads every one of those copies and fails when any of them
// disagrees with project.json, so changing the docs domain or the contact
// address is one edit plus the list of places this prints. The description and
// topics have no copy in the tree — `gh repo edit` reads them from project.json
// (docs/how-to/configure-the-repository.md) — so the check holds them to what
// GitHub accepts.
//
//   npm run check:project-facts

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  "docs/reference/specs/docs-site.md",
  "src/core/docsLink.ts",
  "docker-compose.yml",
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** GitHub's limits on what `gh repo edit` sets from these facts. */
const DESCRIPTION_MAX = 350;
const TOPICS_MAX = 20;
const TOPIC = /^[a-z0-9-]{1,50}$/;

/** The `image:` of every service under the compose file's top-level `services:`
 *  block — `services.<name>.image`, the key two levels in — and nothing else:
 *  an `image:` under an extension field (`x-…`) or a nested key is not a
 *  service the file runs. Two-space indentation, as the file is written. */
export function composeServiceImages(compose) {
  const images = [];
  let inServices = false;
  for (const line of compose.split("\n")) {
    if (/^\S/.test(line)) inServices = /^services:\s*$/.test(line);
    else if (inServices) {
      const m = /^ {4}image:\s*(\S+)/.exec(line);
      if (m) images.push(m[1]);
    }
  }
  return images;
}
/** A docs URL: any `docs.` host (so a stale copy under an old name is caught)
 *  or the configured docs host itself, which need not start with `docs.`. */
const docsUrlPattern = (docsHost) =>
  new RegExp(`https?://(?:docs\\.[A-Za-z0-9.-]+|${docsHost.replace(/\./g, "\\.")}(?![A-Za-z0-9.-]))`, "g");

/**
 * Pure: the disagreements between the facts and one set of file contents
 * (`files` maps path → text; package.json is parsed from its text).
 */
export function factsProblems(facts, files) {
  const problems = [];
  const say = (file, what) => problems.push({ file, what });

  // The repository's description and topics are set on GitHub from these two
  // facts, so they must already fit what GitHub accepts.
  const description = typeof facts.description === "string" ? facts.description.trim() : "";
  if (description === "") say("project.json", "description is missing or blank");
  else if (description.length > DESCRIPTION_MAX)
    say("project.json", `description is ${description.length} characters; GitHub allows ${DESCRIPTION_MAX}`);
  const topics = Array.isArray(facts.topics) ? facts.topics : [];
  if (topics.length === 0) say("project.json", "topics is missing or empty");
  else if (topics.length > TOPICS_MAX) say("project.json", `${topics.length} topics; GitHub allows ${TOPICS_MAX}`);
  for (const topic of topics) {
    if (typeof topic !== "string" || !TOPIC.test(topic))
      say("project.json", `topic "${topic}" is not 1–50 lowercase letters, digits and hyphens`);
  }

  const pkgText = files["package.json"];
  if (pkgText !== undefined) {
    const pkg = JSON.parse(pkgText);
    if (pkg.name !== facts.name) say("package.json", `name is "${pkg.name}", project.json says "${facts.name}"`);
    if (pkg.description !== undefined && pkg.description !== facts.description)
      say("package.json", `description is "${pkg.description}", project.json says "${facts.description}"`);
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

  // The release workflow names the image it pushes from the repository
  // (`ghcr.io/` + owner/name, lowercased — GitHub's namespace on its
  // registry), so the fact must be that name or the compose file would pull
  // an image no release publishes.
  const publishedImage = `ghcr.io${repoPath.toLowerCase()}`;
  if (facts.image !== publishedImage)
    say("project.json", `image is "${facts.image}", the release workflow publishes ${publishedImage}`);

  const compose = files["docker-compose.yml"];
  if (compose !== undefined) {
    const images = composeServiceImages(compose);
    for (const image of images) {
      if (image !== `${facts.image}:latest`)
        say("docker-compose.yml", `image "${image}" — project.json says ${facts.image}:latest`);
    }
    if (images.length === 0) say("docker-compose.yml", `no service runs the published image ${facts.image}:latest`);
  }
  // A `docs.` host is one of OURS — and so a stale copy when it differs — when
  // it names the project or the organization (`docs.switchboard.old.example`);
  // a third party's documentation (`docs.github.com`) is left alone.
  const ours = (host) => host.includes(facts.name) || host.includes(facts.organization);

  for (const [file, text] of Object.entries(files)) {
    if (file === "package.json") continue;
    for (const m of text.match(EMAIL) ?? []) {
      if (m !== facts.contact) say(file, `contact address "${m}" — project.json says ${facts.contact}`);
    }
    for (const m of text.match(docsUrlPattern(docsHost)) ?? []) {
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
    // A shields.io GitHub badge (`img.shields.io/github/<what>/<org>/<repo>`)
    // names the repository as its last two path segments; the README's release
    // badge is one.
    for (const m of text.matchAll(/img\.shields\.io\/github\/([A-Za-z0-9_./-]+)/g)) {
      const [owner, repo] = m[1].split("/").slice(-2);
      if (repo === repoName && `/${owner}/${repo}` !== repoPath)
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
