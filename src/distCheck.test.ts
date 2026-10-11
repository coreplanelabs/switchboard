import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("bot distribution check", () => {
  it.each([
    { extra: [], missing: false, status: 0, message: "no test files, every runtime input present" },
    { extra: [], missing: true, status: 1, message: "core/prTitleVocabulary.json" },
    { extra: ["example.test.js"], missing: false, status: 1, message: "1 test file(s) in dist/" },
    { extra: ["example.test.mjs"], missing: false, status: 1, message: "1 test file(s) in dist/" },
    { extra: ["testing/helper.js"], missing: false, status: 1, message: "1 test file(s) in dist/" },
  ])("accepts or rejects compiled output: $message ($extra)", ({ extra, missing, status, message }) => {
    const cwd = mkdtempSync(join(tmpdir(), "switchboard-dist-check-"));
    try {
      const files = ["core/prTitle.mjs", ...(missing ? [] : ["core/prTitleVocabulary.json"]), ...extra];
      for (const file of files) {
        const path = join(cwd, "dist", file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "");
      }
      const result = spawnSync(process.execPath, [join(root, "scripts/check-dist.mjs")], {
        cwd,
        encoding: "utf8",
      });
      expect(result.status).toBe(status);
      expect(result.stdout + result.stderr).toContain(message);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
