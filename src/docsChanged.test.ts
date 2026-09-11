import { describe, expect, it } from "vitest";
import { docsTouched } from "../scripts/docs-changed.mjs";

// The docs site deploys on a push that changed one of its inputs, and only then.
// Its inputs are the pages and build under `docs/`, the Worker that serves it,
// and `project.json`: the site reads its title, its hero and its hostname from
// the facts at build time, so a push that changes a fact must republish the site
// or the published one is silently older than main.

describe("docsTouched", () => {
  it("names the site's inputs a push changed: pages, the Worker, project.json", () => {
    const files = [
      "docs/tutorials/get-started.md",
      "docs/.vitepress/config.ts",
      "deploy/cloudflare-docs/wrangler.template.jsonc",
      "project.json",
      "src/core/dispatcher.ts",
      "README.md",
    ];
    expect(docsTouched(files)).toEqual([
      "docs/tutorials/get-started.md",
      "docs/.vitepress/config.ts",
      "deploy/cloudflare-docs/wrangler.template.jsonc",
      "project.json",
    ]);
  });

  it("a push that changed none of them is empty — a code-only push does not deploy the site", () => {
    expect(docsTouched(["src/core/dispatcher.ts", "web/src/App.vue", "deploy/cloudflare/worker.ts"])).toEqual([]);
  });

  it("only the root project.json is an input, not another file of that name or a path that merely starts with docs", () => {
    expect(docsTouched(["web/project.json", "docs-site/index.md", "documents/a.md", "project.json.bak"])).toEqual([]);
  });
});
