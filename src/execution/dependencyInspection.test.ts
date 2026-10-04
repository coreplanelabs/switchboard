import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectDependencyInspection,
  dependencyInspectionCommand,
  parseDependencyInspection,
} from "./dependencyInspection.js";

describe("dependency inspection", () => {
  it("attributes malformed workspace manifests without a prior package label", () => {
    const root = mkdtempSync(join(tmpdir(), "dependency-inspection-"));
    try {
      mkdirSync(join(root, "node_modules/library"), { recursive: true });
      mkdirSync(join(root, "packages/widget"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ dependencies: { library: "1" }, workspaces: ["packages/widget"] }),
      );
      writeFileSync(join(root, "node_modules/library/package.json"), '{"name":"library"}');
      writeFileSync(join(root, "packages/widget/package.json"), "{");
      const git = (...args: string[]) => {
        const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      git("init", "-q");
      git("add", "package.json", "packages/widget/package.json");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
      const result = spawnSync("bash", ["-c", dependencyInspectionCommand(root, git("rev-parse", "HEAD"))], {
        encoding: "utf8",
      });
      expect(parseDependencyInspection({ ...result, exitCode: result.status })).toEqual({
        kind: "invalid",
        reason: "manifest",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("identifies a scoped executable permission failure without changing private work", () => {
    const root = mkdtempSync(join(tmpdir(), "dependency-inspection-"));
    try {
      const git = (...args: string[]) => {
        const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      mkdirSync(join(root, "node_modules/@example/cli"), { recursive: true });
      mkdirSync(join(root, "node_modules/.bin"));
      writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "@example/cli": "1" } }));
      writeFileSync(
        join(root, "node_modules/@example/cli/package.json"),
        JSON.stringify({ name: "@example/cli", bin: { example: "run.js" } }),
      );
      writeFileSync(join(root, "node_modules/@example/cli/run.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
      symlinkSync("../@example/cli/run.js", join(root, "node_modules/.bin/example"));
      git("init", "-q");
      git("add", "package.json");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
      const head = git("rev-parse", "HEAD");
      writeFileSync(join(root, "private.txt"), "retain these bytes");
      const execute = (pin: string) => {
        const result = spawnSync("bash", ["-c", dependencyInspectionCommand(root, pin)], { encoding: "utf8" });
        return { ...result, exitCode: result.status };
      };
      const run = () => execute(head);
      expect(parseDependencyInspection(run())).toEqual({ kind: "ready" });
      chmodSync(join(root, "node_modules/@example/cli/run.js"), 0o644);
      expect(parseDependencyInspection(run())).toEqual({
        kind: "invalid",
        reason: "bin-link",
        package: "@example/cli",
        bin: "example",
      });
      expect(readFileSync(join(root, "private.txt"), "utf8")).toBe("retain these bytes");
      expect(parseDependencyInspection(execute("a".repeat(40)))).toEqual({ kind: "unknown" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds producer labels for root, workspace and executable names", () => {
    const root = mkdtempSync(join(tmpdir(), "dependency-inspection-"));
    try {
      mkdirSync(join(root, "node_modules/library"), { recursive: true });
      mkdirSync(join(root, "packages/widget"), { recursive: true });
      const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();
      writeFileSync(join(root, "package.json"), "{}");
      git("init", "-q");
      git("add", "package.json");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
      const head = git("rev-parse", "HEAD");
      const large = "x".repeat(100_000);
      for (const place of ["root", "workspace", "bin"]) {
        writeFileSync(
          join(root, "package.json"),
          JSON.stringify(
            place === "root"
              ? { dependencies: { [large]: "1" } }
              : place === "workspace"
                ? { workspaces: ["packages/widget"] }
                : { dependencies: { library: "1" } },
          ),
        );
        writeFileSync(join(root, "packages/widget/package.json"), JSON.stringify({ dependencies: { [large]: "1" } }));
        writeFileSync(join(root, "node_modules/library/package.json"), JSON.stringify({ bin: { [large]: "missing" } }));
        const result = spawnSync("bash", ["-c", dependencyInspectionCommand(root, head)], { encoding: "utf8" });
        expect(result.stdout.length).toBeLessThan(2048);
        const parsed = parseDependencyInspection({ ...result, exitCode: result.status });
        expect(parsed.kind).toBe("invalid");
        if (parsed.kind === "invalid") {
          expect(parsed.package?.length ?? 0).toBeLessThanOrEqual(256);
          expect(parsed.bin).toBeUndefined();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("collects both streams with bounded bytes before decoding and refuses overflow", async () => {
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });
    for (const [out, err, expected] of [
      ['{"kind":"ready"}', "", "ready"],
      ["x".repeat(100_000), "", "unknown"],
      ['{"kind":"ready"}', "x".repeat(100_000), "unknown"],
    ]) {
      expect(
        (
          await collectDependencyInspection({
            stdout: stream(out!),
            stderr: stream(err!),
            exitCode: Promise.resolve(0),
          })
        ).kind,
      ).toBe(expected);
    }
  });

  it("refuses partial, private or malformed process output", () => {
    const good = { stdout: '{"kind":"ready"}\n', stderr: "", exitCode: 0, truncated: false };
    expect(parseDependencyInspection(good)).toEqual({ kind: "ready" });
    for (const bad of [
      { ...good, stderr: "private error" },
      { ...good, truncated: true },
      { ...good, timedOut: true },
      { ...good, stdout: '{"kind":"ready","raw":"private"}' },
      { ...good, exitCode: 2 },
      { ...good, stdout: "private output" },
      { ...good, stdout: '{"kind":"invalid","reason":"private"}', exitCode: 2 },
    ])
      expect(parseDependencyInspection(bad)).toEqual({ kind: "unknown" });
    expect(() => dependencyInspectionCommand("/workspace/tree", "HEAD")).toThrow();
  });
});
