import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bodyDigest, checkVendoredSkills, parseManifest, renderVendoredSkill, upstreamFileUrl, upstreamRawUrl } from "./manifest.js";
import { parseSkillMarkdown } from "./frontmatter.js";

// Feature: docs/reference/specs/skills.md items 9–10 — third-party skills are vendored
// from a pinned upstream commit through a manifest, never hand-copied, so
// updates are inherited by re-syncing and the vendored files provably match
// what the manifest says they are.

const MANIFEST = `
sources:
  addyosmani/agent-skills:
    repo: https://github.com/addyosmani/agent-skills
    ref: main
    commit: d2c37ef6225dd8726cdd369a8030307f48592d26
skills:
  - name: code-review-and-quality
    source: addyosmani/agent-skills
    path: skills/code-review-and-quality/SKILL.md
    agents: [review]
  - name: test-driven-development
    source: addyosmani/agent-skills
    path: skills/test-driven-development/SKILL.md
    agents: [coding]
`;

const UPSTREAM = `---
name: code-review-and-quality
description: Conducts multi-axis code review.
---

# Code Review and Quality

Body line one.

Body line two.
`;

// A first-party skill: authored in this repo, listed in the manifest as
// `local: true` — no source, no upstream block, no sync; git is its integrity.
const LOCAL_MANIFEST = `${MANIFEST}  - name: pr-tour
    local: true
    agents: [coding]
`;

const LOCAL_SKILL = `---
name: pr-tour
description: How to write the PR body Tour.
agents: [coding]
---

# PR Tour

Step shape and rules.
`;

describe("parseManifest", () => {
  it("parses sources and skills, resolving each skill's source", () => {
    const m = parseManifest(MANIFEST);
    expect(Object.keys(m.sources)).toEqual(["addyosmani/agent-skills"]);
    expect(m.sources["addyosmani/agent-skills"]).toEqual({
      repo: "https://github.com/addyosmani/agent-skills",
      ref: "main",
      commit: "d2c37ef6225dd8726cdd369a8030307f48592d26",
    });
    expect(m.skills.map((s) => s.name)).toEqual(["code-review-and-quality", "test-driven-development"]);
    expect(m.skills[0]).toMatchObject({ source: "addyosmani/agent-skills", path: "skills/code-review-and-quality/SKILL.md", agents: ["review"] });
  });

  it("a source may be unpinned (no commit yet) — sync fills it in", () => {
    const m = parseManifest(MANIFEST.replace(/\n {4}commit: .*/, ""));
    expect(m.sources["addyosmani/agent-skills"].commit).toBeUndefined();
  });

  it("rejects a skill whose source is not declared", () => {
    expect(() => parseManifest(MANIFEST.replace("source: addyosmani/agent-skills\n    path: skills/test", "source: nobody/nowhere\n    path: skills/test"))).toThrow(
      /test-driven-development.*source "nobody\/nowhere" is not declared/,
    );
  });

  it("rejects duplicate skill names, a non-GitHub repo URL, a malformed commit, and missing fields", () => {
    expect(() => parseManifest(MANIFEST.replace("name: test-driven-development", "name: code-review-and-quality"))).toThrow(/duplicate skill "code-review-and-quality"/);
    expect(() => parseManifest(MANIFEST.replace("https://github.com/addyosmani/agent-skills", "https://gitlab.com/x/y"))).toThrow(/repo must be a GitHub URL/);
    expect(() => parseManifest(MANIFEST.replace("d2c37ef6225dd8726cdd369a8030307f48592d26", "main"))).toThrow(/commit must be a 40-char sha/);
    expect(() => parseManifest(MANIFEST.replace("    agents: [review]\n", ""))).toThrow(/code-review-and-quality.*agents/);
    expect(() => parseManifest("skills: []")).toThrow(/sources/);
  });

  // First-party skills (docs/reference/specs/skills.md item 11): `local: true` replaces
  // source/path — the file is authored here, never synced.
  it("parses a local entry (no source/path); rejects a local entry that also names a source or path, and a non-local entry missing them", () => {
    const m = parseManifest(LOCAL_MANIFEST);
    expect(m.skills.find((s) => s.name === "pr-tour")).toEqual({ name: "pr-tour", local: true, agents: ["coding"] });
    expect(() => parseManifest(LOCAL_MANIFEST.replace("local: true", "local: true\n    source: addyosmani/agent-skills"))).toThrow(/pr-tour.*local.*source/);
    expect(() => parseManifest(MANIFEST.replace("    source: addyosmani/agent-skills\n    path: skills/test-driven-development/SKILL.md\n", ""))).toThrow(/test-driven-development.*source/);
  });

  // The name is the vendored directory name: a path-shaped name would make the
  // sync write outside skills/.
  it("rejects a skill name that is not a plain slug (a path, `..`, uppercase)", () => {
    for (const bad of ["../escape", "a/b", "Code-Review", "has space", "-leading"]) {
      expect(() => parseManifest(MANIFEST.replace("name: test-driven-development", `name: "${bad}"`))).toThrow(/name must be a lowercase slug/);
    }
  });
});

describe("upstream URLs", () => {
  const src = { repo: "https://github.com/addyosmani/agent-skills", ref: "main", commit: "d2c37ef6225dd8726cdd369a8030307f48592d26" };
  it("blob URL for humans, raw URL for the fetch, both pinned to the commit", () => {
    expect(upstreamFileUrl(src, "skills/x/SKILL.md")).toBe("https://github.com/addyosmani/agent-skills/blob/d2c37ef6225dd8726cdd369a8030307f48592d26/skills/x/SKILL.md");
    expect(upstreamRawUrl(src, "skills/x/SKILL.md")).toBe("https://raw.githubusercontent.com/addyosmani/agent-skills/d2c37ef6225dd8726cdd369a8030307f48592d26/skills/x/SKILL.md");
  });
});

describe("renderVendoredSkill", () => {
  const m = parseManifest(MANIFEST);
  const entry = m.skills[0];
  if (entry.local) throw new Error("fixture: MANIFEST's first skill must be a vendored entry");
  const src = m.sources[entry.source];

  it("keeps the upstream body byte-for-byte and overlays our frontmatter (agents, pinned source, upstream)", () => {
    const out = renderVendoredSkill(UPSTREAM, entry, src);
    const skill = parseSkillMarkdown(out);
    expect(skill.name).toBe("code-review-and-quality");
    expect(skill.description).toBe("Conducts multi-axis code review.");
    expect(skill.agents).toEqual(["review"]);
    expect(skill.source).toBe("https://github.com/addyosmani/agent-skills/blob/d2c37ef6225dd8726cdd369a8030307f48592d26/skills/code-review-and-quality/SKILL.md");
    expect(skill.upstream).toEqual({
      repo: "https://github.com/addyosmani/agent-skills",
      commit: "d2c37ef6225dd8726cdd369a8030307f48592d26",
      path: "skills/code-review-and-quality/SKILL.md",
      bodySha256: bodyDigest(skill.body),
    });
    expect(skill.upstream!.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    // The body is the upstream body, untouched — the whole point of vendoring.
    expect(skill.body).toBe(parseSkillMarkdown(UPSTREAM.replace("---\n\n#", "agents: [x]\n---\n\n#")).body);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("refuses an upstream whose name does not match the manifest entry (a moved/renamed skill)", () => {
    expect(() => renderVendoredSkill(UPSTREAM.replace("name: code-review-and-quality", "name: something-else"), entry, src)).toThrow(
      /upstream skill is named "something-else", manifest entry is "code-review-and-quality"/,
    );
  });

  it("refuses an unpinned source — a vendored file must record the commit it came from", () => {
    expect(() => renderVendoredSkill(UPSTREAM, entry, { ...src, commit: undefined })).toThrow(/not pinned/);
  });
});

describe("checkVendoredSkills (the offline drift check)", () => {
  function fixture(manifest: string, files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "skills-check-"));
    writeFileSync(join(dir, "manifest.yaml"), manifest);
    for (const [slug, content] of Object.entries(files)) {
      mkdirSync(join(dir, slug));
      writeFileSync(join(dir, slug, "SKILL.md"), content);
    }
    return dir;
  }
  const m = parseManifest(MANIFEST);
  const crq = renderVendoredSkill(UPSTREAM, m.skills[0], m.sources["addyosmani/agent-skills"]);
  const tdd = renderVendoredSkill(UPSTREAM.replace("code-review-and-quality", "test-driven-development"), m.skills[1], m.sources["addyosmani/agent-skills"]);

  it("passes when every manifest entry is vendored at the pinned commit with the manifest's scoping, and nothing extra exists", () => {
    const dir = fixture(MANIFEST, { "code-review-and-quality": crq, "test-driven-development": tdd });
    expect(checkVendoredSkills(dir)).toEqual([]);
  });

  it("reports a manifest entry with no vendored file", () => {
    const dir = fixture(MANIFEST, { "code-review-and-quality": crq });
    expect(checkVendoredSkills(dir)).toEqual([expect.stringMatching(/test-driven-development.*missing.*skills:sync/)]);
  });

  it("reports a vendored skill the manifest does not know (a hand-copied skill)", () => {
    const dir = fixture(MANIFEST, { "code-review-and-quality": crq, "test-driven-development": tdd, rogue: crq.replace("name: code-review-and-quality", "name: rogue") });
    expect(checkVendoredSkills(dir)).toEqual([expect.stringMatching(/rogue.*not in manifest/)]);
  });

  it("reports a vendored file whose pinned commit or agents differ from the manifest (edited by hand, or the manifest moved without a sync)", () => {
    // Rendered as if synced from an older pin / with a different scoping than the manifest now says.
    const stale = renderVendoredSkill(UPSTREAM, m.skills[0], { ...m.sources["addyosmani/agent-skills"], commit: "0000000000000000000000000000000000000000" });
    const rescoped = renderVendoredSkill(UPSTREAM.replace("code-review-and-quality", "test-driven-development"), { ...m.skills[1], agents: ["review"] }, m.sources["addyosmani/agent-skills"]);
    const dir = fixture(MANIFEST, { "code-review-and-quality": stale, "test-driven-development": rescoped });
    const problems = checkVendoredSkills(dir);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/code-review-and-quality.*commit 0000000.*manifest pins d2c37ef/);
    expect(problems[1]).toMatch(/test-driven-development.*agents \[review\].*manifest says \[coding\]/);
  });

  // A check that compares frontmatter only lets a hand
  // edit to the body — the thing most likely to be tweaked — pass cleanly.
  it("reports a vendored file whose BODY was edited by hand (digest mismatch), with no network call", () => {
    const edited = crq.trimEnd() + "\nHAND EDITED LINE\n";
    const dir = fixture(MANIFEST, { "code-review-and-quality": edited, "test-driven-development": tdd });
    expect(checkVendoredSkills(dir)).toEqual([expect.stringMatching(/code-review-and-quality\/SKILL.md: body differs from what skills:sync wrote .*never hand-edit/)]);
  });

  it("a body that is byte-identical after a round trip (trailing newline only) is NOT drift", () => {
    const dir = fixture(MANIFEST, { "code-review-and-quality": crq.trimEnd() + "\n\n\n", "test-driven-development": tdd });
    expect(checkVendoredSkills(dir)).toEqual([]);
  });

  it("a local skill passes with no upstream block; is reported when missing, agents-drifted, or carrying an upstream block it must not have", () => {
    const clean = fixture(LOCAL_MANIFEST, { "code-review-and-quality": crq, "test-driven-development": tdd, "pr-tour": LOCAL_SKILL });
    expect(checkVendoredSkills(clean)).toEqual([]);
    const missing = fixture(LOCAL_MANIFEST, { "code-review-and-quality": crq, "test-driven-development": tdd });
    expect(checkVendoredSkills(missing)).toEqual([expect.stringMatching(/pr-tour.*missing/)]);
    const rescoped = fixture(LOCAL_MANIFEST, { "code-review-and-quality": crq, "test-driven-development": tdd, "pr-tour": LOCAL_SKILL.replace("agents: [coding]", "agents: [review]") });
    expect(checkVendoredSkills(rescoped)).toEqual([expect.stringMatching(/pr-tour.*agents \[review\].*manifest says \[coding\]/)]);
    const vendoredish = LOCAL_SKILL.replace(
      "agents: [coding]\n",
      // hex-looking values with letters: an all-digit scalar parses as a YAML number, not a string
      "agents: [coding]\nupstream:\n  repo: https://github.com/x/y\n  commit: " + "a".repeat(40) + "\n  path: p\n  bodySha256: " + "a".repeat(64) + "\n",
    );
    const confused = fixture(LOCAL_MANIFEST, { "code-review-and-quality": crq, "test-driven-development": tdd, "pr-tour": vendoredish });
    expect(checkVendoredSkills(confused)).toEqual([expect.stringMatching(/pr-tour.*local skill.*upstream/)]);
  });

  it("reports a vendored file whose directory name differs from its skill name (and the manifest entry it leaves unvendored)", () => {
    const dir = fixture(MANIFEST, { "code-review-and-quality": crq, "test-driven-development": tdd.replace("name: test-driven-development", "name: tdd") });
    expect(checkVendoredSkills(dir)).toEqual([
      expect.stringMatching(/test-driven-development\/SKILL.md.*named "tdd"/),
      expect.stringMatching(/test-driven-development.*missing/),
    ]);
  });
});

// The repo's own skills/ dir is what ships in the image: it must pass the same
// check, so a hand-edited or hand-copied skill fails the suite (and CI's
// `npm run skills:check`) rather than drifting silently from upstream.
describe("the bundled skills/ dir passes the drift check", () => {
  it("every skills/<slug>/SKILL.md is in manifest.yaml at the pinned commit, and vice-versa", () => {
    expect(checkVendoredSkills(fileURLToPath(new URL("../../skills", import.meta.url)))).toEqual([]);
  });
});
