import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHECKED_FILES, factsProblems } from "../scripts/check-project-facts.mjs";

// project.json is the one statement of who the project is; every hand-written
// copy of its name, repository, docs URL and contact address is checked
// against it, so changing a fact is one edit plus the list this check prints.

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(new URL(p, `file://${root}`), "utf8");

const facts = {
  name: "switchboard",
  displayName: "Switchboard",
  organization: "acme",
  repository: "https://github.com/acme/switchboard",
  docs: "https://docs.switchboard.example.com",
  contact: "dev@example.com",
  steward: { name: "Acme Labs", url: "https://acme.example" },
  commands: {},
};

const goodPkg = JSON.stringify({
  name: "switchboard",
  homepage: "https://github.com/acme/switchboard#readme",
  repository: { url: "git+https://github.com/acme/switchboard.git" },
  bugs: { url: "https://github.com/acme/switchboard/issues" },
});

describe("factsProblems", () => {
  it("is silent when every copy agrees", () => {
    const files = {
      "package.json": goodPkg,
      "SECURITY.md": "email <dev@example.com> or the Security tab",
      "docs/README.md": "published at https://docs.switchboard.example.com/ and https://github.com/acme/switchboard",
      "deploy/cloudflare-docs/wrangler.jsonc":
        '"routes": [{ "pattern": "docs.switchboard.example.com", "custom_domain": true }]',
      NOTICE: "Copyright 2026 Acme Labs",
      "GOVERNANCE.md": "stewarded by Acme Labs",
    };
    expect(factsProblems(facts, files)).toEqual([]);
  });

  it("names a stale contact address, docs URL, route pattern, and repository owner", () => {
    const files = {
      "SECURITY.md": "email <security@old.example>",
      "docs/README.md":
        "https://docs.switchboard.old.example/ and https://github.com/someone-else/switchboard; see also https://docs.github.com/en/actions",
      "deploy/cloudflare-docs/wrangler.jsonc": '"pattern": "docs.old.example"',
    };
    const what = factsProblems(facts, files).map((p) => `${p.file}: ${p.what}`);
    expect(what).toEqual([
      'SECURITY.md: contact address "security@old.example" — project.json says dev@example.com',
      'docs/README.md: docs URL "https://docs.switchboard.old.example" — project.json says https://docs.switchboard.example.com',
      'docs/README.md: repository "github.com/someone-else/switchboard" — project.json says https://github.com/acme/switchboard',
      'deploy/cloudflare-docs/wrangler.jsonc: route pattern "docs.old.example" — project.json says docs.switchboard.example.com',
    ]);
  });

  it("leaves a third party's docs host alone, and flags one under the organization's name", () => {
    const files = {
      "README.md": "see https://docs.github.com/en/actions and https://docs.anthropic.com/",
      "SUPPORT.md": "old: https://docs.acme.example/switchboard",
    };
    const what = factsProblems(facts, files).map((p) => `${p.file}: ${p.what}`);
    expect(what).toEqual([
      'SUPPORT.md: docs URL "https://docs.acme.example" — project.json says https://docs.switchboard.example.com',
    ]);
  });

  it("a docs host without a `docs.` prefix — a product domain — is checked too: exact copies pass, a stale sibling is flagged", () => {
    const apex = { ...facts, docs: "https://openswitchboard.example" };
    const files = {
      "README.md": "read at https://openswitchboard.example/start and https://docs.github.com/",
      // A lookalike host must not match the configured host: the dots are literal, not wildcards.
      "CONTRIBUTING.md": "not ours: https://openswitchboardXexample/",
      "SUPPORT.md": "old: https://docs.switchboard.example.com/",
    };
    const what = factsProblems(apex, files).map((p) => `${p.file}: ${p.what}`);
    expect(what).toEqual([
      'SUPPORT.md: docs URL "https://docs.switchboard.example.com" — project.json says https://openswitchboard.example',
    ]);
  });

  it("leaves other repositories under the org alone, and checks package.json's four fields", () => {
    const files = {
      "package.json": JSON.stringify({ name: "other", homepage: "x", repository: { url: "y" }, bugs: { url: "z" } }),
      "README.md": "see https://github.com/acme/infrastructure",
    };
    const problems = factsProblems(facts, files);
    expect(problems.filter((p) => p.file === "README.md")).toEqual([]);
    expect(problems.filter((p) => p.file === "package.json")).toHaveLength(4);
  });

  it("requires NOTICE and GOVERNANCE to name the steward", () => {
    expect(factsProblems(facts, { NOTICE: "Copyright 2026 Someone" })[0]?.what).toMatch(/steward/);
  });
});

describe("the repository's own facts", () => {
  it("every checked file exists and agrees with project.json", () => {
    const own = JSON.parse(read("project.json")) as typeof facts;
    const files: Record<string, string> = { "package.json": read("package.json") };
    for (const f of CHECKED_FILES) files[f] = read(f);
    expect(factsProblems(own, files)).toEqual([]);
  });
});
