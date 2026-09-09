import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHeaderPaths as specsCheckParseHeaderPaths } from "../../scripts/specs-check.mjs";
import { coveringSpecs, isSourcePath, parseHeaderPaths } from "./specCoverage.js";

// Spec coverage (docs/reference/specs/specs-coverage.md): a changed path maps
// to the specs whose **Code** / **Tests** header paths cover it, and a changed
// source path no spec covers is named — the review agent's input for the spec
// contradiction check, and the warn-then-error gate.

describe("parseHeaderPaths", () => {
  it("reads the backtick paths of the Code and Tests header lines, bare or inside a markdown link, with their line numbers", () => {
    const md = [
      "# A spec",
      "",
      "- **Code**: `src/core/x.ts` (`Thing`), [`src/core/y/`](../../../src/core/y/) and `deploy/cloudflare-bot/worker.ts`",
      "- **Tests**: [`src/core/x.test.ts`](../../../src/core/x.test.ts)",
      "- **Docs**: [Page](../../explanation/page.md)",
    ].join("\n");
    expect(parseHeaderPaths(md)).toEqual([
      { line: 3, path: "src/core/x.ts" },
      { line: 3, path: "src/core/y/" },
      { line: 3, path: "deploy/cloudflare-bot/worker.ts" },
      { line: 4, path: "src/core/x.test.ts" },
    ]);
  });

  it("ignores a bare identifier, a dotted symbol, a route and a glob — a path carries a directory and no wildcard", () => {
    const md = "- **Code**: `Actor`, `conversations.info`, `/runs`, `src/core/trace/*.test.ts`, `src/core/trace/`";
    expect(parseHeaderPaths(md).map((h) => h.path)).toEqual(["src/core/trace/"]);
  });

  it("reads nothing from other lines, including a proof reference in a criteria table", () => {
    const md = [
      "Prose mentioning `src/core/x.ts`.",
      "| Criterion | Proof |",
      "| a | `[unit]` `src/core/x.test.ts::does a` |",
      "- **Budgets**: `src/agents/registry.ts`",
    ].join("\n");
    expect(parseHeaderPaths(md)).toEqual([]);
  });
});

// `scripts/specs-check.mjs` applies the same header rule and `src/` may not
// import it (the image ships `src/` alone), so the two copies are pinned to
// each other here — a test may import from scripts/, tests are not shipped.
describe("parseHeaderPaths agrees with scripts/specs-check.mjs", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const SPECS = "docs/reference/specs";

  it("gives the same paths and lines for a spec text that exercises every branch of the rule", () => {
    const md = [
      "- **Code**: `src/core/x.ts` (`Thing`), [`src/core/y/`](../../../src/core/y/), `Actor`, `conversations.info`, `/runs`, `src/core/trace/*.test.ts`, `.github/workflows/ci.yml`, `deploy/cloudflare-bot`",
      "- **Tests**: [`src/core/x.test.ts`](../../../src/core/x.test.ts)",
      "- **Docs**: `docs/how-to/page.md`",
      "| a | `[unit]` `src/core/x.test.ts::does a` |",
    ].join("\n");
    expect(parseHeaderPaths(md)).toEqual(specsCheckParseHeaderPaths(md));
    expect(parseHeaderPaths(md).map((h) => h.path)).toEqual([
      "src/core/x.ts",
      "src/core/y/",
      ".github/workflows/ci.yml",
      "deploy/cloudflare-bot",
      "src/core/x.test.ts",
    ]);
  });

  it("gives the same answer as specs-check over every real spec in the tree", () => {
    const specs = readdirSync(join(root, SPECS)).filter((n) => n.endsWith(".md") && n !== "README.md");
    expect(specs.length).toBeGreaterThan(0);
    for (const name of specs) {
      const md = readFileSync(join(root, SPECS, name), "utf8");
      expect(parseHeaderPaths(md), name).toEqual(specsCheckParseHeaderPaths(md));
      expect(parseHeaderPaths(md).length, name).toBeGreaterThan(0);
    }
  });
});

describe("isSourcePath", () => {
  it("is a code file under src/, web/src/ or deploy/", () => {
    for (const p of [
      "src/core/x.ts",
      "src/index.mts",
      "web/src/pages/costs.vue",
      "web/src/lib/format.ts",
      "deploy/cloudflare-bot/worker.ts",
      "deploy/cloudflare-resident/worker.mjs",
    ])
      expect(isSourcePath(p), p).toBe(true);
  });

  it("is not a test, a snapshot, a fixture under testing/, a declaration, config, docs or a file outside the roots", () => {
    for (const p of [
      "src/core/x.test.ts",
      "src/core/x.spec.ts",
      "src/core/__snapshots__/x.test.ts.snap",
      "src/core/testing/fixtures.ts",
      "src/core/types.d.ts",
      "src/core/trace/clockAllowlist.json",
      "src/README.md",
      "web/package.json",
      "web/nuxt.config.ts",
      "deploy/cloudflare-bot/Dockerfile",
      "deploy/cloudflare-bot/wrangler.template.jsonc",
      "scripts/specs-check.mjs",
      "docs/reference/specs/x.md",
      "package.json",
    ])
      expect(isSourcePath(p), p).toBe(false);
  });
});

describe("coveringSpecs", () => {
  const specs = [
    { path: "docs/reference/specs/a.md", headerPaths: ["src/core/a.ts", "src/core/a.test.ts"] },
    { path: "docs/reference/specs/b.md", headerPaths: ["src/core/authz/", "deploy/cloudflare-bot"] },
    { path: "docs/reference/specs/c.md", headerPaths: ["src/core/a.ts"] },
  ];

  it("a changed path equal to a header path touches that spec, and says which header path matched", () => {
    const { touched, uncovered } = coveringSpecs(["src/core/a.test.ts"], specs);
    expect(touched).toEqual([{ spec: "docs/reference/specs/a.md", because: ["src/core/a.test.ts"] }]);
    expect(uncovered).toEqual([]);
  });

  it("a header path covers everything beneath it, with or without its trailing slash", () => {
    const { touched, uncovered } = coveringSpecs(
      ["src/core/authz/policy.ts", "deploy/cloudflare-bot/worker.ts"],
      specs,
    );
    expect(touched).toEqual([
      { spec: "docs/reference/specs/b.md", because: ["src/core/authz/", "deploy/cloudflare-bot"] },
    ]);
    expect(uncovered).toEqual([]);
  });

  it("a header path never covers a sibling that merely shares its prefix", () => {
    const { touched, uncovered } = coveringSpecs(["src/core/authzExtra.ts", "deploy/cloudflare-bottle/x.ts"], specs);
    expect(touched).toEqual([]);
    expect(uncovered).toEqual(["src/core/authzExtra.ts", "deploy/cloudflare-bottle/x.ts"]);
  });

  it("one changed path can touch several specs; a spec is listed once, in spec order, with only the header paths that matched", () => {
    const { touched } = coveringSpecs(["src/core/a.ts", "src/core/authz/x.ts"], specs);
    expect(touched).toEqual([
      { spec: "docs/reference/specs/a.md", because: ["src/core/a.ts"] },
      { spec: "docs/reference/specs/b.md", because: ["src/core/authz/"] },
      { spec: "docs/reference/specs/c.md", because: ["src/core/a.ts"] },
    ]);
  });

  it("uncovered lists only source paths with no covering spec — a test, a doc or a config file without a spec is not a finding", () => {
    const { touched, uncovered } = coveringSpecs(
      ["src/core/zed.ts", "src/core/zed.test.ts", "docs/how-to/x.md", "package.json", "web/src/pages/zed.vue"],
      specs,
    );
    expect(touched).toEqual([]);
    expect(uncovered).toEqual(["src/core/zed.ts", "web/src/pages/zed.vue"]);
  });

  it("no changed paths → nothing touched, nothing uncovered", () => {
    expect(coveringSpecs([], specs)).toEqual({ touched: [], uncovered: [] });
  });
});
