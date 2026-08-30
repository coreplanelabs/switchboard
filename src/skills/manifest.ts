import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { parseSkillMarkdown } from "./frontmatter.js";
import type { Skill, SkillUpstream } from "./types.js";

// The skills manifest (features/skills.md items 9–10): third-party skills are
// VENDORED, never hand-copied. `skills/manifest.yaml` names each upstream
// source (a GitHub repo + ref, pinned to a commit by the sync) and each skill we
// take from it (its path there, and which of our agents it is scoped to).
// `scripts/skills-sync.ts` resolves the ref, fetches every file at that commit,
// and writes `skills/<name>/SKILL.md` with the upstream body byte-for-byte under
// our frontmatter overlay. `checkVendoredSkills` is the offline half: it proves
// the vendored tree matches the manifest (run by the suite and by CI), so a
// hand-edited body, a hand-copied skill, or a manifest bumped without a sync
// fails loudly instead of drifting. Adding a third-party skill is one manifest
// entry + a sync; inheriting upstream changes is a sync.

export interface ManifestSource {
  /** GitHub repository URL (https://github.com/<owner>/<repo>). */
  repo: string;
  /** The ref the sync resolves (a branch or tag). */
  ref: string;
  /** The commit the vendored files were fetched at; absent until the first sync. */
  commit?: string;
}

export interface ManifestSkill {
  name: string;
  /** Key into `sources`. */
  source: string;
  /** Path of the SKILL.md inside the upstream repo. */
  path: string;
  /** Our scoping — which agents may list/load it (frontmatter `agents`). */
  agents: string[];
}

export interface SkillsManifest {
  sources: Record<string, ManifestSource>;
  skills: ManifestSkill[];
}

const GITHUB_REPO_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)\/?$/;
const SHA_RE = /^[0-9a-f]{40}$/;
// A skill name is also the vendored directory name (`skills/<name>/SKILL.md`),
// so it must be a plain slug — never a path (defense in depth: the manifest is
// trusted checked-in config, but a `..` here would make the sync write outside
// the skills dir).
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** sha-256 (hex) of a skill body — what the sync records and the check recomputes. */
export function bodyDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} must be a mapping`);
  return v as Record<string, unknown>;
}

function asString(v: unknown, what: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${what} must be a non-empty string`);
  return v.trim();
}

/** Parse + validate manifest YAML. Every problem throws with the offending
 *  entry named — the manifest is checked-in configuration, so a bad entry is a
 *  build bug to surface, not a skill to silently skip. */
export function parseManifest(raw: string): SkillsManifest {
  const doc = asRecord(YAML.parse(raw), "manifest");
  const sourcesRaw = asRecord(doc.sources, "manifest `sources`");
  const sources: Record<string, ManifestSource> = {};
  for (const [key, v] of Object.entries(sourcesRaw)) {
    const rec = asRecord(v, `source "${key}"`);
    const repo = asString(rec.repo, `source "${key}" repo`);
    if (!GITHUB_REPO_RE.test(repo)) throw new Error(`source "${key}": repo must be a GitHub URL (https://github.com/<owner>/<repo>), got ${repo}`);
    const ref = asString(rec.ref, `source "${key}" ref`);
    let commit: string | undefined;
    if (rec.commit !== undefined) {
      const c = asString(rec.commit, `source "${key}" commit`);
      if (!SHA_RE.test(c)) throw new Error(`source "${key}": commit must be a 40-char sha, got ${c}`);
      commit = c;
    }
    sources[key] = { repo: repo.replace(/\/$/, ""), ref, ...(commit ? { commit } : {}) };
  }
  if (!Array.isArray(doc.skills)) throw new Error("manifest `skills` must be a list");
  const skills: ManifestSkill[] = [];
  const seen = new Set<string>();
  for (const v of doc.skills) {
    const rec = asRecord(v, "skill entry");
    const name = asString(rec.name, "skill entry name");
    if (!NAME_RE.test(name)) throw new Error(`skill "${name}": name must be a lowercase slug ([a-z0-9-]) — it is the vendored directory name`);
    if (seen.has(name)) throw new Error(`duplicate skill "${name}" in manifest`);
    seen.add(name);
    const source = asString(rec.source, `skill "${name}" source`);
    if (!sources[source]) throw new Error(`skill "${name}": source "${source}" is not declared under sources`);
    const path = asString(rec.path, `skill "${name}" path`);
    const agents = rec.agents;
    if (!Array.isArray(agents) || agents.length === 0 || !agents.every((a) => typeof a === "string" && a.trim() !== "")) {
      throw new Error(`skill "${name}": agents must be a non-empty list of agent names`);
    }
    skills.push({ name, source, path, agents: (agents as string[]).map((a) => a.trim()) });
  }
  return { sources, skills };
}

function ownerRepo(src: ManifestSource): string {
  const m = src.repo.match(GITHUB_REPO_RE);
  if (!m) throw new Error(`not a GitHub repo URL: ${src.repo}`);
  return `${m[1]}/${m[2]}`;
}

function pinned(src: ManifestSource): string {
  if (!src.commit) throw new Error(`source ${src.repo} is not pinned to a commit — run skills:sync`);
  return src.commit;
}

/** The human-facing URL of the upstream file at the pinned commit (recorded as the skill's `source`). */
export function upstreamFileUrl(src: ManifestSource, path: string): string {
  return `${src.repo}/blob/${pinned(src)}/${path}`;
}

/** The raw-content URL the sync fetches. */
export function upstreamRawUrl(src: ManifestSource, path: string): string {
  return `https://raw.githubusercontent.com/${ownerRepo(src)}/${pinned(src)}/${path}`;
}

/** Turn an upstream SKILL.md into our vendored SKILL.md: the upstream body
 *  byte-for-byte, under a frontmatter that keeps upstream's name + description
 *  and adds our `agents`, the pinned `source` URL, and the `upstream`
 *  provenance block. The upstream name must equal the manifest entry — a
 *  mismatch means the skill moved or was renamed upstream, which is a manifest
 *  edit, not something to paper over. */
export function renderVendoredSkill(upstreamRaw: string, entry: ManifestSkill, src: ManifestSource): string {
  const commit = pinned(src);
  const up = parseUpstreamSkill(upstreamRaw);
  if (up.name !== entry.name) throw new Error(`upstream skill is named "${up.name}", manifest entry is "${entry.name}" (${entry.path})`);
  const fm = YAML.stringify({
    name: up.name,
    description: up.description,
    agents: entry.agents,
    source: upstreamFileUrl(src, entry.path),
    upstream: { repo: src.repo, commit, path: entry.path, bodySha256: bodyDigest(up.body) },
  }).trimEnd();
  return `---\n${fm}\n---\n\n${up.body}\n`;
}

/** Upstream files carry only name + description (no `agents`), so the strict
 *  bundled parser cannot read them; this reads the two fields we need and the
 *  body, and fails on anything that is not a SKILL.md at all. */
function parseUpstreamSkill(raw: string): { name: string; description: string; body: string } {
  const m = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) throw new Error("upstream skill has no YAML frontmatter");
  const rec = asRecord(YAML.parse(m[1]), "upstream frontmatter");
  return {
    name: asString(rec.name, "upstream skill name"),
    description: asString(rec.description, "upstream skill description"),
    body: raw.slice(m[0].length).trim(),
  };
}

/** Offline drift check over a skills dir containing `manifest.yaml`: every
 *  manifest entry is vendored (`<name>/SKILL.md`), every vendored skill is in
 *  the manifest, each vendored file's `upstream.commit` is the source's pinned
 *  commit, its body's sha-256 is the one the sync recorded (a hand-edited body
 *  is caught without a network call), its `agents` are the manifest's, and the
 *  directory is named after the skill. Returns one message per problem (empty = clean); never throws on
 *  a bad file — the message names it, so the caller can print them all. */
export function checkVendoredSkills(dir: string): string[] {
  const problems: string[] = [];
  const manifestPath = join(dir, "manifest.yaml");
  if (!existsSync(manifestPath)) return [`${manifestPath}: missing`];
  const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
  const byName = new Map(manifest.skills.map((s) => [s.name, s]));

  const vendored = new Map<string, Skill>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(entry.name, "SKILL.md");
    if (!existsSync(join(dir, file))) continue;
    let skill: Skill;
    try {
      skill = parseSkillMarkdown(readFileSync(join(dir, file), "utf8"));
    } catch (err) {
      problems.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (skill.name !== entry.name) {
      problems.push(`${file}: is named "${skill.name}" but lives in directory "${entry.name}"`);
      continue;
    }
    vendored.set(skill.name, skill);
    const m = byName.get(skill.name);
    if (!m) {
      problems.push(`${file}: skill "${skill.name}" is not in manifest.yaml (hand-copied? add a manifest entry and run skills:sync)`);
      continue;
    }
    const want = manifest.sources[m.source].commit;
    const have = skill.upstream?.commit;
    if (!skill.upstream || have !== want) {
      problems.push(`${file}: vendored at commit ${have ?? "(none)"}, manifest pins ${want ?? "(unpinned)"} — run skills:sync`);
    }
    // The body is what a hand edit actually touches: recompute its digest and
    // compare with what the sync recorded — offline, no upstream fetch needed.
    if (skill.upstream && bodyDigest(skill.body) !== skill.upstream.bodySha256) {
      problems.push(`${file}: body differs from what skills:sync wrote (sha256 ${bodyDigest(skill.body).slice(0, 12)} ≠ recorded ${skill.upstream.bodySha256.slice(0, 12)}) — never hand-edit a vendored skill; run skills:sync`);
    }
    if (JSON.stringify(skill.agents) !== JSON.stringify(m.agents)) {
      problems.push(`${file}: agents [${skill.agents.join(", ")}] but manifest says [${m.agents.join(", ")}] — run skills:sync`);
    }
  }
  for (const m of manifest.skills) {
    if (!vendored.has(m.name)) problems.push(`${m.name}: in manifest.yaml but ${m.name}/SKILL.md is missing — run skills:sync`);
  }
  return problems;
}

export type { SkillUpstream };
