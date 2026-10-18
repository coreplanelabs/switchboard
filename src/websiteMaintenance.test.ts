import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("website maintenance", () => {
  it("skips work while paused and runs the same command after enabling it", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "switchboard-website-")));
    try {
      mkdirSync(join(root, "scripts"));
      const script = join(root, "scripts/website-maintenance.mjs");
      copyFileSync(new URL("../scripts/website-maintenance.mjs", import.meta.url), script);
      copyFileSync(new URL("../scripts/ci-plan.mjs", import.meta.url), join(root, "scripts/ci-plan.mjs"));
      const readPlan = () => {
        const result = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            "const { fullPlan, planForPaths } = await import(process.argv[2]); console.log(JSON.stringify({ docs: planForPaths(['docs/README.md']).docs, fallback: fullPlan().docs, runtime: fullPlan().web }));",
            "maintenance-test",
            join(root, "scripts/ci-plan.mjs"),
          ],
          { encoding: "utf8" },
        );
        return JSON.parse(result.stdout);
      };
      const output = join(root, "capture receipt");
      const args = [
        script,
        process.execPath,
        "-e",
        "require('fs').writeFileSync(process.argv[1], 'refreshed')",
        output,
      ];
      writeFileSync(join(root, "project.json"), JSON.stringify({ websiteMaintenance: false }));
      expect(readPlan()).toEqual({ docs: false, fallback: false, runtime: true });
      const paused = spawnSync(process.execPath, args, { encoding: "utf8" });
      expect({ status: paused.status, output: paused.stdout, wrote: existsSync(output) }).toEqual({
        status: 0,
        output: "Website maintenance paused; skipped. See CONTRIBUTING.md to enable and refresh it.\n",
        wrote: false,
      });
      writeFileSync(join(root, "project.json"), JSON.stringify({ websiteMaintenance: true }));
      expect(readPlan()).toEqual({ docs: true, fallback: true, runtime: true });
      const enabled = spawnSync(process.execPath, args, { encoding: "utf8" });
      expect({ status: enabled.status, receipt: readFileSync(output, "utf8") }).toEqual({
        status: 0,
        receipt: "refreshed",
      });
      const failed = spawnSync(process.execPath, [script, process.execPath, "-e", "process.exit(7)"], {
        encoding: "utf8",
      });
      expect(failed.status).toBe(7);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves deployment and verification flags through the npm workspace entry points", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "switchboard-site-npm-")));
    try {
      for (const directory of ["scripts", "docs", "deploy/cloudflare-docs", "node_modules/.bin"]) {
        mkdirSync(join(root, directory), { recursive: true });
      }
      copyFileSync(
        new URL("../scripts/website-maintenance.mjs", import.meta.url),
        join(root, "scripts/website-maintenance.mjs"),
      );
      copyFileSync(
        new URL("../deploy/cloudflare-docs/package.json", import.meta.url),
        join(root, "deploy/cloudflare-docs/package.json"),
      );
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          workspaces: ["deploy/cloudflare-docs"],
          scripts: { "deploy:gen": "node record.mjs config" },
        }),
      );
      writeFileSync(
        join(root, "docs/package.json"),
        JSON.stringify({ scripts: { build: "node ../record.mjs build" } }),
      );
      const events = join(root, "events.jsonl");
      writeFileSync(
        join(root, "record.mjs"),
        `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(events)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      );
      const wrangler = join(root, "node_modules/.bin/wrangler");
      writeFileSync(
        wrangler,
        `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(events)}, JSON.stringify(["wrangler", ...process.argv.slice(2)]) + "\\n");`,
      );
      chmodSync(wrangler, 0o755);
      const invoke = (script: string, flags: string[]) =>
        spawnSync("npm", ["run", script, "-w", "deploy/cloudflare-docs", "--", ...flags], {
          cwd: root,
          encoding: "utf8",
        });
      writeFileSync(join(root, "project.json"), JSON.stringify({ websiteMaintenance: false }));
      for (const [script, flags] of [
        ["deploy", ["--dry-run"]],
        ["verify", ["--outdir", "site check"]],
      ] as const) {
        const result = invoke(script, [...flags]);
        expect({
          status: result.status,
          paused: result.stdout.includes("Website maintenance paused"),
          effects: existsSync(events),
        }).toEqual({ status: 0, paused: true, effects: false });
      }
      writeFileSync(join(root, "project.json"), JSON.stringify({ websiteMaintenance: true }));
      for (const [script, flags, expected] of [
        ["deploy", [], [["config"], ["build"], ["wrangler", "deploy"]]],
        ["deploy", ["--dry-run"], [["config"], ["build"], ["wrangler", "deploy", "--dry-run"]]],
        ["verify", [], [["config"], ["wrangler", "deploy", "--dry-run"]]],
        [
          "verify",
          ["--outdir", "site check"],
          [["config"], ["wrangler", "deploy", "--dry-run", "--outdir", "site check"]],
        ],
      ] as const) {
        rmSync(events, { force: true });
        const result = invoke(script, [...flags]);
        const observed = existsSync(events)
          ? readFileSync(events, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          : [];
        expect({ status: result.status, events: observed }, result.stderr).toEqual({ status: 0, events: expected });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
