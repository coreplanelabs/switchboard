// Vendor third-party skills from skills/manifest.yaml (features/skills.md items 9–10).
//
//   npx tsx scripts/skills-sync.ts           resolve each source's ref → commit, pin it in the
//                                            manifest, fetch every listed SKILL.md at that commit,
//                                            rewrite skills/<name>/SKILL.md, then run the check
//   npx tsx scripts/skills-sync.ts --check   offline: verify the vendored tree matches the manifest
//                                            (exit 1 with one line per problem) — what CI runs
//
// The sync is the ONLY writer of vendored skills. It needs the network (GitHub
// API for the ref, raw.githubusercontent.com for the files). The API call is
// authenticated with GITHUB_TOKEN when set, else with `gh auth token` when the
// gh CLI is logged in (unauthenticated calls are rate-limited and were seen to
// 403). The check needs nothing.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { checkVendoredSkills, parseManifest, renderVendoredSkill, upstreamRawUrl, type ManifestSource } from "../src/skills/manifest.js";

const SKILLS_DIR = process.env.SWITCHBOARD_SKILLS_DIR ?? fileURLToPath(new URL("../skills", import.meta.url));
const MANIFEST_PATH = join(SKILLS_DIR, "manifest.yaml");

function check(): number {
  const problems = checkVendoredSkills(SKILLS_DIR);
  if (problems.length === 0) {
    console.log(`skills:check ok — ${SKILLS_DIR} matches manifest.yaml`);
    return 0;
  }
  for (const p of problems) console.error(`skills:check ${p}`);
  return 1;
}

function ghAuthToken(): string | undefined {
  try {
    const out = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || undefined;
  } catch {
    return undefined; // no gh, or not logged in — fall through to an unauthenticated call
  }
}

async function resolveCommit(src: ManifestSource): Promise<string> {
  const m = src.repo.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
  if (!m) throw new Error(`not a GitHub repo URL: ${src.repo}`);
  const headers: Record<string, string> = { accept: "application/vnd.github.sha", "user-agent": "switchboard-skills-sync" };
  const token = process.env.GITHUB_TOKEN ?? ghAuthToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/commits/${encodeURIComponent(src.ref)}`, { headers });
  if (!res.ok) throw new Error(`resolving ${src.repo}@${src.ref}: HTTP ${res.status}`);
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`resolving ${src.repo}@${src.ref}: unexpected response ${sha.slice(0, 80)}`);
  return sha;
}

async function sync(): Promise<number> {
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  const manifest = parseManifest(raw);
  const doc = YAML.parseDocument(raw); // edit in place so comments survive

  for (const [key, src] of Object.entries(manifest.sources)) {
    const commit = await resolveCommit(src);
    const moved = src.commit && src.commit !== commit;
    console.log(`${key}: ${src.ref} → ${commit.slice(0, 12)}${moved ? ` (was ${src.commit!.slice(0, 12)})` : src.commit ? " (unchanged)" : " (first pin)"}`);
    src.commit = commit;
    doc.setIn(["sources", key, "commit"], commit);
  }

  for (const entry of manifest.skills) {
    if (entry.local) {
      console.log(`${entry.name}: local (authored here, not synced)`);
      continue;
    }
    const src = manifest.sources[entry.source];
    const url = upstreamRawUrl(src, entry.path);
    const res = await fetch(url, { headers: { "user-agent": "switchboard-skills-sync" } });
    if (!res.ok) throw new Error(`${entry.name}: fetching ${url}: HTTP ${res.status}`);
    const rendered = renderVendoredSkill(await res.text(), entry, src);
    const target = join(SKILLS_DIR, entry.name, "SKILL.md");
    let before: string | undefined;
    try {
      before = readFileSync(target, "utf8");
    } catch {
      before = undefined;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rendered);
    console.log(`${entry.name}: ${before === undefined ? "added" : before === rendered ? "unchanged" : "updated"}`);
  }

  writeFileSync(MANIFEST_PATH, doc.toString());
  return check();
}

const mode = process.argv[2];
if (mode === "--check") process.exit(check());
if (mode === undefined) {
  sync().then(process.exit, (err) => {
    console.error(`skills:sync failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
} else {
  console.error(`usage: skills-sync.ts [--check]`);
  process.exit(2);
}
