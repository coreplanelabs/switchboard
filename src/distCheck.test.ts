import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("bot distribution check", () => {
  it.each([
    { extra: [], missing: false, status: 0, message: "no test files, every runtime input present" },
    { extra: [], missing: true, status: 1, message: "core/prTitleVocabulary.json" },
    { extra: ["example.test.js"], missing: false, status: 1, message: "1 test file(s) in dist/" },
    { extra: ["example.test.mjs"], missing: false, status: 1, message: "1 test file(s) in dist/" },
    { extra: ["testing/helper.js"], missing: false, status: 1, message: "1 test file(s) in dist/" },
    { extra: [], missing: false, bundle: "absent", status: 1, message: "web app manifest not found" },
    { extra: [], missing: false, bundle: "legacy", status: 1, message: "no entry green/main.ts" },
    { extra: [], missing: false, bundle: "both", status: 1, message: "obsolete dashboard entry remains in the bundle" },
  ])(
    "accepts or rejects compiled output: $message ($extra)",
    ({ extra, missing, status, message, bundle = "green" }) => {
      const cwd = mkdtempSync(join(tmpdir(), "switchboard-dist-check-"));
      try {
        // Copy the production checker beside real transpiled runtime code. The
        // fixture cannot borrow a previous local build or import a fake loader.
        mkdirSync(join(cwd, "scripts"));
        writeFileSync(join(cwd, "scripts/check-dist.mjs"), readFileSync(join(root, "scripts/check-dist.mjs")));
        writeFileSync(join(cwd, "package.json"), JSON.stringify({ type: "module" }));
        const loader = ts.transpileModule(readFileSync(join(root, "src/channels/webAssets.ts"), "utf8"), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText;
        mkdirSync(join(cwd, "dist/channels"), { recursive: true });
        writeFileSync(join(cwd, "dist/channels/webAssets.js"), loader);
        if (bundle !== "absent") {
          const webDist = join(cwd, "web/dist");
          mkdirSync(join(webDist, ".vite"), { recursive: true });
          mkdirSync(join(webDist, "assets"));
          const chunk = { file: "assets/green-fixture.js", isEntry: true, css: ["assets/green-fixture.css"] };
          const manifest =
            bundle === "legacy"
              ? { "src/main.ts": chunk }
              : {
                  "green/main.ts": chunk,
                  ...(bundle === "both" ? { "src/main.ts": chunk } : {}),
                };
          writeFileSync(join(webDist, ".vite/manifest.json"), JSON.stringify(manifest));
          writeFileSync(join(webDist, "assets/green-fixture.js"), "export {};\n");
          writeFileSync(join(webDist, "assets/green-fixture.css"), ":root { color-scheme: light dark; }\n");
        }
        const files = ["core/prTitle.mjs", ...(missing ? [] : ["core/prTitleVocabulary.json"]), ...extra];
        for (const file of files) {
          const path = join(cwd, "dist", file);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, "");
        }
        const result = spawnSync(process.execPath, [join(cwd, "scripts/check-dist.mjs")], {
          cwd,
          encoding: "utf8",
        });
        expect(result.status, result.stdout + result.stderr).toBe(status);
        expect(result.stdout + result.stderr).toContain(message);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});
