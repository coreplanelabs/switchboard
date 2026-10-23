import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStagingScratchDirectory } from "./stagingScratch.js";

describe("frozen staging inputs", () => {
  const source = { account: "staging-account", configSource: "op://Vault/Item/field" };

  it("uses one config source path across workflow runs for the same staging source", () => {
    const root = mkdtempSync(join(tmpdir(), "staging-input-test-"));
    try {
      const first = createStagingScratchDirectory("39975756537", source, root);
      const configPath = join(first, "config.yaml");
      writeFileSync(configPath, "organization: example\n", { mode: 0o600 });
      expect(readFileSync(configPath, "utf8")).toBe("organization: example\n");
      rmSync(first, { recursive: true });

      const retry = createStagingScratchDirectory("39975756537", source, root);
      expect(join(retry, "config.yaml")).toBe(configPath);
      rmSync(retry, { recursive: true });
      const otherRun = createStagingScratchDirectory("39975756538", source, root);
      expect(join(otherRun, "config.yaml")).toBe(configPath);
      const otherSource = createStagingScratchDirectory(
        "39975756538",
        { ...source, configSource: "op://Vault/Other/field" },
        root,
      );
      expect(join(otherSource, "config.yaml")).not.toBe(configPath);
      const otherAccount = createStagingScratchDirectory("39975756538", { ...source, account: "other-account" }, root);
      expect(join(otherAccount, "config.yaml")).not.toBe(configPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps local runs isolated when no workflow run id exists", () => {
    const root = mkdtempSync(join(tmpdir(), "staging-input-test-"));
    try {
      const first = createStagingScratchDirectory(undefined, source, root);
      const second = createStagingScratchDirectory(undefined, source, root);
      expect(first).not.toBe(second);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
