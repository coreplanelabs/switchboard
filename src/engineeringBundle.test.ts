import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEngineeringRules } from "./engineeringBundle.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function bundle(files: string[] = ["general.md", "errors.md"]) {
  const dir = mkdtempSync(join(tmpdir(), "engineering-rules-"));
  directories.push(dir);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema: 1, files }));
  writeFileSync(join(dir, "general.md"), "## General\n\nUse local conventions.\n");
  writeFileSync(join(dir, "errors.md"), "## Errors\n\nPropagate unexpected failures.\n");
  return dir;
}

describe("engineering rule bundle", () => {
  it("loads the shipped policy independently of the operator working directory", () => {
    const previous = process.cwd();
    try {
      process.chdir(bundle());
      expect(loadEngineeringRules().files).toEqual([
        "general.md",
        "design.md",
        "errors.md",
        "observability.md",
        "verification.md",
      ]);
    } finally {
      process.chdir(previous);
    }
  });

  it("loads required files in manifest order with stable content identity", () => {
    const dir = bundle();
    const result = loadEngineeringRules(dir);
    expect(result.files).toEqual(["general.md", "errors.md"]);
    expect(result.text).toBe("## General\n\nUse local conventions.\n\n## Errors\n\nPropagate unexpected failures.");
    expect(loadEngineeringRules(dir)).toEqual(result);
    writeFileSync(join(dir, "errors.md"), "## Errors\n\nReturn an explicit failure.\n");
    const changed = loadEngineeringRules(dir);
    expect(changed.text).toContain("Return an explicit failure.");
    expect(changed.sha256).not.toBe(result.sha256);
  });

  it.each([["general.md", "general.md"], ["../outside.md"], []])(
    "refuses duplicate, unsafe or empty file lists: %j",
    (...files) => {
      expect(() => loadEngineeringRules(bundle(files))).toThrow(/engineering|manifest/i);
    },
  );

  it("reports a missing or empty required file instead of loading partial rules", () => {
    const dir = bundle();
    rmSync(join(dir, "errors.md"));
    expect(() => loadEngineeringRules(dir)).toThrow(/errors\.md/);
    writeFileSync(join(dir, "errors.md"), " \n");
    expect(() => loadEngineeringRules(dir)).toThrow(/errors\.md/);
    mkdirSync(join(dir, "nested"));
    expect(() => loadEngineeringRules(join(dir, "nested"))).toThrow(/manifest\.json/);
  });

  it("refuses malformed manifests, oversized text and symlinks with the original cause", () => {
    const dir = bundle();
    writeFileSync(join(dir, "manifest.json"), "{broken");
    expect(() => loadEngineeringRules(dir)).toThrow(/manifest|JSON|property/i);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema: 2, files: ["general.md"] }));
    expect(() => loadEngineeringRules(dir)).toThrow(/engineering/);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema: 1, files: ["general.md"] }));
    writeFileSync(join(dir, "general.md"), Buffer.from([0xff]));
    expect(() => loadEngineeringRules(dir)).toThrow(/encoded data|encoding/i);
    writeFileSync(join(dir, "general.md"), "é".repeat(4_001));
    expect(() => loadEngineeringRules(dir)).toThrow(/8000-byte/);
    rmSync(join(dir, "general.md"));
    symlinkSync(join(dir, "errors.md"), join(dir, "general.md"));
    expect(() => loadEngineeringRules(dir)).toThrow(/ELOOP/);
    try {
      loadEngineeringRules(dir);
    } catch (error) {
      expect(error).toMatchObject({ cause: { code: "ELOOP" } });
    }
  });

  it("ships every listed rule in the bot image", () => {
    expect(loadEngineeringRules().files).toEqual([
      "general.md",
      "design.md",
      "errors.md",
      "observability.md",
      "verification.md",
    ]);
    expect(readFileSync("Dockerfile", "utf8")).toContain("COPY engineering ./engineering");
  });
});
