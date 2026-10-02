import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareSandboxExecutor } from "./cloudflareSandbox.js";
import { createTracer } from "../core/trace/tracer.js";
import { recordingSink } from "../core/testing/recordingSink.js";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COLD_PACK_MAX_BYTES,
  controllerPublicationPlan,
  parseColdPublication,
  sourcePublicationPackCommand,
} from "./coldPublication.js";

const input = {
  repo: "acme/api",
  doorOrigin: "https://door.example",
  branch: "plan/fix/u1",
  next: "a".repeat(40),
  old: "b".repeat(40),
  bearer: "synthetic-effect-secret",
};
const opts = {
  url: "https://sandbox.example",
  token: "operator",
  threadKey: "slack:CX:1.0",
  resolveEnvs: vi.fn(async () => ({ GH_ENTERPRISE_TOKEN: "model-only" })),
};
afterEach(() => vi.unstubAllGlobals());

describe("isolated cold publication plan", () => {
  it("accepts only a bounded typed graph and builds an exact lease in the fresh repository", () => {
    const plan = controllerPublicationPlan(input);
    expect(plan.command).toContain(`--force-with-lease='refs/heads/plan/fix/u1:${input.old}'`);
    expect(plan.command).toContain(`${input.next}:refs/heads/plan/fix/u1`);
    expect(plan.command).not.toContain(input.bearer);
    expect(plan.env.GIT_CONFIG_VALUE_0).toContain(input.bearer);
    expect(JSON.stringify(plan.prepareEnv)).not.toContain(input.bearer);
    expect(plan.prepareEnv.GIT_CONFIG_COUNT).toBe("2");
    expect(plan.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(plan.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(plan.env.GIT_CONFIG_VALUE_1).toBe("/dev/null");
    expect(plan.env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe("");
    expect(plan.env.PATH).toBe("/usr/bin:/bin");
    expect(plan.prepareCommand).toContain("fsck");
    expect(plan.pushCommand).not.toContain("fsck");
    expect(plan.command).toContain("fsck");
    expect(plan.command).toContain("verify-pack");
    expect(plan.command).not.toContain("/workspace/checkout");
    expect(controllerPublicationPlan({ ...input, old: undefined }).command).toContain(
      "--force-with-lease='refs/heads/plan/fix/u1:'",
    );
    for (const changed of [
      { repo: "other;id" },
      { branch: "../main" },
      { next: "HEAD" },
      { old: "gone" },
      { doorOrigin: "http://door.example" },
      { bearer: "" },
    ])
      expect(() => controllerPublicationPlan({ ...input, ...changed })).toThrow();
  });
  it("validates a synthetic graph without consulting model hooks, configuration or alternates", () => {
    const fixture = mkdtempSync(join(tmpdir(), "cold-graph-"));
    try {
      const source = join(fixture, "source");
      execFileSync("git", ["init", "-q", source]);
      writeFileSync(join(source, "fixture.txt"), "synthetic fixture\n");
      execFileSync("git", ["-C", source, "add", "fixture.txt"]);
      execFileSync(
        "git",
        [
          "-C",
          source,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-qm",
          "fixture",
        ],
        {
          env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid" },
        },
      );
      const next = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const marker = join(fixture, "hook-ran");
      mkdirSync(join(source, ".git", "hooks"), { recursive: true });
      writeFileSync(join(source, ".git", "hooks", "pre-push"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
      const pack = join(fixture, "transfer.pack");
      execFileSync("bash", ["-c", sourcePublicationPackCommand(next, undefined, pack, source)]);
      const graph = readFileSync(pack);
      const plan = controllerPublicationPlan({ ...input, next, old: undefined });
      const prepare = plan.prepareCommand
        .replaceAll("/workspace/publisher", join(fixture, "publisher"))
        .replaceAll("/workspace/transfer.pack", join(fixture, "transfer.pack"));
      const run = () =>
        execFileSync("bash", ["-c", prepare], { env: { ...process.env, ...plan.prepareEnv }, timeout: 120_000 });
      writeFileSync(pack, graph);
      expect(() => run()).not.toThrow();
      expect(existsSync(marker)).toBe(false);
      rmSync(join(fixture, "publisher"), { recursive: true, force: true });
      writeFileSync(pack, graph.subarray(0, graph.length - 1));
      expect(() => run()).toThrow();
      rmSync(join(fixture, "publisher"), { recursive: true, force: true });
      // A syntactically complete pack that omits the commit's tree/blob is
      // still not a publishable immutable graph in an empty controller.
      const incomplete = execFileSync("git", ["-C", source, "pack-objects", "--stdout", "--revs", "--filter=tree:0"], {
        input: `${next}\n`,
      });
      writeFileSync(pack, incomplete);
      expect(() => run()).toThrow();
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
  it("exports only the bounded publication graph, not an established repository's deleted history", () => {
    const fixture = mkdtempSync(join(tmpdir(), "cold-incremental-"));
    try {
      const source = join(fixture, "source");
      const pack = join(fixture, "transfer.pack");
      execFileSync("git", ["init", "-q", source]);
      const commit = () => {
        execFileSync("git", ["-C", source, "add", "-A"]);
        execFileSync("git", [
          "-C",
          source,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-qm",
          "fixture",
        ]);
        return execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      };
      // Unrelated historical bytes are larger than the transport cap; the
      // actual next commit and both snapshots still fit comfortably.
      const deleted = randomBytes(COLD_PACK_MAX_BYTES + 1_000_000);
      writeFileSync(join(source, "deleted.bin"), deleted);
      const historical = commit();
      rmSync(join(source, "deleted.bin"));
      writeFileSync(join(source, "live.txt"), "old snapshot\n");
      const old = commit();
      writeFileSync(join(source, "live.txt"), "next snapshot\n");
      const next = commit();
      const full = execFileSync("git", ["-C", source, "pack-objects", "--stdout", "--revs"], {
        input: `${next}\n`,
        maxBuffer: COLD_PACK_MAX_BYTES + 4_000_000,
      });
      expect(full.length).toBeGreaterThan(COLD_PACK_MAX_BYTES);
      execFileSync("bash", ["-c", sourcePublicationPackCommand(next, old, pack, source)]);
      const graph = readFileSync(pack);
      expect(graph.length).toBeLessThan(100_000);
      const plan = controllerPublicationPlan({ ...input, old, next });
      const prepare = plan.prepareCommand
        .replaceAll("/workspace/publisher", join(fixture, "publisher"))
        .replaceAll("/workspace/transfer.pack", pack);
      expect(() =>
        execFileSync("bash", ["-c", prepare], { env: { ...process.env, ...plan.prepareEnv } }),
      ).not.toThrow();
      expect(() =>
        execFileSync("git", ["-C", join(fixture, "publisher"), "cat-file", "-t", historical], { stdio: "ignore" }),
      ).toThrow();
      rmSync(join(fixture, "publisher"), { recursive: true, force: true });
      // A correctly formatted pack that excludes the old snapshot is not a
      // complete graph, even if the new commit itself is tiny.
      const incomplete = execFileSync("git", ["-C", source, "pack-objects", "--stdout"], {
        input: `${old}\n${next}\n`,
      });
      writeFileSync(pack, incomplete);
      expect(() =>
        execFileSync("bash", ["-c", prepare], { env: { ...process.env, ...plan.prepareEnv }, stdio: "ignore" }),
      ).toThrow();
      expect(() => sourcePublicationPackCommand("HEAD", old, pack, source)).toThrow();
      writeFileSync(join(source, "live.txt"), randomBytes(COLD_PACK_MAX_BYTES + 1_000_000));
      const oversized = commit();
      expect(() =>
        execFileSync("bash", ["-c", sourcePublicationPackCommand(oversized, next, pack, source)], { stdio: "ignore" }),
      ).toThrow();
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
  it.each(["initial", "rebased"])("fetches a repository-bound immutable base for %s cold publication", (kind) => {
    const fixture = mkdtempSync(join(tmpdir(), "cold-base-"));
    try {
      const source = join(fixture, "source");
      const remote = join(fixture, "remote.git");
      const pack = join(fixture, "transfer.pack");
      execFileSync("git", ["init", "-q", source]);
      execFileSync("git", ["init", "-q", "--bare", remote]);
      execFileSync("git", ["-C", remote, "config", "uploadpack.allowFilter", "true"]);
      const commit = (content: string) => {
        writeFileSync(join(source, "live.txt"), content);
        execFileSync("git", ["-C", source, "add", "-A"]);
        execFileSync("git", [
          "-C",
          source,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-qm",
          "fixture",
        ]);
        return execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      };
      writeFileSync(join(source, "deleted.bin"), randomBytes(COLD_PACK_MAX_BYTES + 1_000_000));
      commit("history");
      rmSync(join(source, "deleted.bin"));
      const base = commit("base snapshot");
      execFileSync("git", ["-C", source, "push", "-q", remote, `${base}:refs/heads/main`]);
      execFileSync("git", ["-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
      const old = commit("outdated branch");
      if (kind === "rebased")
        execFileSync("git", ["-C", source, "push", "-q", remote, `${old}:refs/heads/${input.branch}`]);
      const next = commit("rebased next commit");
      // A rebased next commit need not descend from the old publication ref.
      // The old-only exporter must refuse; an independently fetched base
      // supplies a verified boundary in the same bound remote instead.
      const rebased = join(fixture, "rebased");
      execFileSync("git", ["-C", source, "checkout", "-q", "-b", "rebased", base]);
      const rebasedNext = commit("fresh publication");
      expect(() =>
        execFileSync("bash", ["-c", sourcePublicationPackCommand(rebasedNext, old, rebased, source)], {
          stdio: "ignore",
        }),
      ).toThrow();
      const request = { ...input, old: kind === "rebased" ? old : undefined, next: rebasedNext };
      const plan = controllerPublicationPlan(request);
      const dir = join(fixture, "publisher");
      const local = (command: string) =>
        command.replaceAll("/workspace/publisher", dir).replaceAll("https://door.example/git/acme/api.git", remote);
      if (kind === "rebased") {
        expect(
          execFileSync("bash", ["-c", local(plan.fetchCommand)], {
            env: { ...process.env, ...plan.env },
            encoding: "utf8",
          }).trim(),
        ).toBe(old);
        expect(() =>
          execFileSync("bash", ["-c", sourcePublicationPackCommand(rebasedNext, old, pack, source, true)], {
            stdio: "ignore",
          }),
        ).toThrow();
      }
      // A new ref first tries the bounded complete graph; the deleted
      // historical blob makes that attempt exceed the cap in this case.
      if (kind === "initial")
        expect(() =>
          execFileSync("bash", ["-c", sourcePublicationPackCommand(rebasedNext, undefined, pack, source)], {
            stdio: "ignore",
          }),
        ).toThrow();
      const fetch = local(controllerPublicationPlan(request, undefined, "default").fetchCommand);
      expect(
        execFileSync("bash", ["-c", fetch], { env: { ...process.env, ...plan.env }, encoding: "utf8" }).trim(),
      ).toBe(base);
      execFileSync("bash", ["-c", sourcePublicationPackCommand(rebasedNext, base, pack, source, true)]);
      const update = controllerPublicationPlan(request, base);
      const prepare = update.prepareCommand
        .replaceAll("/workspace/publisher", dir)
        .replaceAll("/workspace/transfer.pack", pack);
      expect(() =>
        execFileSync("bash", ["-c", prepare], { env: { ...process.env, ...update.prepareEnv } }),
      ).not.toThrow();
      expect(readFileSync(pack).length).toBeLessThan(100_000);
      expect(rebasedNext).not.toBe(next);
      // The trusted base only bounds the graph; the push still uses the
      // original lease, including the empty lease on the initial branch.
      expect(update.pushCommand).toContain(`--force-with-lease='refs/heads/${input.branch}:${request.old ?? ""}'`);
      execFileSync("bash", ["-c", local(update.pushCommand)], { env: { ...process.env, ...update.env } });
      expect(
        execFileSync("git", ["-C", remote, "rev-parse", `refs/heads/${input.branch}`], { encoding: "utf8" }).trim(),
      ).toBe(rebasedNext);
      execFileSync("git", ["-C", remote, "fsck", "--full", "--strict"], { stdio: "pipe" });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
  it.each(["empty repository", "unrelated default HEAD"])(
    "publishes a bounded complete initial ref against an %s with an empty-ref lease",
    (kind) => {
      const fixture = mkdtempSync(join(tmpdir(), "cold-first-ref-"));
      try {
        const source = join(fixture, "source");
        const remote = join(fixture, "remote.git");
        const dir = join(fixture, "publisher");
        const pack = join(fixture, "transfer.pack");
        execFileSync("git", ["init", "-q", source]);
        execFileSync("git", ["init", "-q", "--bare", remote]);
        if (kind === "unrelated default HEAD") {
          const defaultSource = join(fixture, "default");
          execFileSync("git", ["init", "-q", defaultSource]);
          writeFileSync(join(defaultSource, "main.txt"), "unrelated history\n");
          execFileSync("git", ["-C", defaultSource, "add", "-A"]);
          execFileSync("git", [
            "-C",
            defaultSource,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "default",
          ]);
          execFileSync("git", ["-C", defaultSource, "push", "-q", remote, "HEAD:refs/heads/main"]);
          execFileSync("git", ["-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
        }
        writeFileSync(join(source, "work.txt"), "publish this branch\n");
        execFileSync("git", ["-C", source, "add", "-A"]);
        execFileSync("git", [
          "-C",
          source,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-qm",
          "feature",
        ]);
        const next = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        const request = { ...input, next, old: undefined };
        const plan = controllerPublicationPlan(request);
        const local = (command: string) =>
          command
            .replaceAll("/workspace/publisher", dir)
            .replaceAll("/workspace/transfer.pack", pack)
            .replaceAll("https://door.example/git/acme/api.git", remote);
        if (kind === "empty repository") {
          expect(() =>
            execFileSync("bash", ["-c", local(plan.fetchCommand)], {
              env: { ...process.env, ...plan.env },
              stdio: "ignore",
            }),
          ).toThrow();
          rmSync(dir, { recursive: true, force: true });
        } else {
          const defaultHead = execFileSync("git", ["-C", remote, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
          expect(() =>
            execFileSync("bash", ["-c", sourcePublicationPackCommand(next, defaultHead, pack, source, true)], {
              stdio: "ignore",
            }),
          ).toThrow();
        }
        execFileSync("bash", ["-c", sourcePublicationPackCommand(next, undefined, pack, source)]);
        expect(readFileSync(pack).length).toBeLessThan(COLD_PACK_MAX_BYTES);
        execFileSync("bash", ["-c", local(plan.prepareCommand)], { env: { ...process.env, ...plan.prepareEnv } });
        expect(plan.pushCommand).toContain(`--force-with-lease='refs/heads/${input.branch}:'`);
        execFileSync("bash", ["-c", local(plan.pushCommand)], { env: { ...process.env, ...plan.env } });
        expect(
          execFileSync("git", ["-C", remote, "rev-parse", `refs/heads/${input.branch}`], {
            encoding: "utf8",
          }).trim(),
        ).toBe(next);
        execFileSync("git", ["-C", remote, "fsck", "--full", "--strict"], { stdio: "pipe" });
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
  it("refuses a missing trusted base without changing the Door's typed ref or lease", () => {
    const fixture = mkdtempSync(join(tmpdir(), "cold-missing-base-"));
    try {
      const empty = join(fixture, "empty.git");
      execFileSync("git", ["init", "-q", "--bare", empty]);
      const plan = controllerPublicationPlan({ ...input, old: undefined });
      const fetch = plan.fetchCommand
        .replaceAll("/workspace/publisher", join(fixture, "publisher"))
        .replaceAll("https://door.example/git/acme/api.git", empty);
      expect(() =>
        execFileSync("bash", ["-c", fetch], { env: { ...process.env, ...plan.env }, stdio: "ignore" }),
      ).toThrow();
      expect(plan.fetchCommand).toContain("https://door.example/git/acme/api.git");
      expect(plan.fetchCommand).not.toContain("/workspace/checkout");
      expect(plan.prepareEnv).not.toHaveProperty("GIT_CONFIG_VALUE_0", expect.stringContaining(input.bearer));
      expect(() => controllerPublicationPlan(input, "not-a-sha")).toThrow();
      expect(controllerPublicationPlan(input, input.next).pushCommand).toContain(
        `--force-with-lease='refs/heads/plan/fix/u1:${input.old}'`,
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
  it("publishes a small update to a large unchanged branch even when default HEAD diverged", () => {
    const fixture = mkdtempSync(join(tmpdir(), "cold-diverged-"));
    try {
      const source = join(fixture, "source");
      const remote = join(fixture, "remote.git");
      const dir = join(fixture, "publisher");
      const pack = join(fixture, "transfer.pack");
      execFileSync("git", ["init", "-q", source]);
      execFileSync("git", ["init", "-q", "--bare", remote]);
      execFileSync("git", ["-C", remote, "config", "uploadpack.allowFilter", "true"]);
      const commit = (content: string) => {
        writeFileSync(join(source, "live.txt"), content);
        execFileSync("git", ["-C", source, "add", "-A"]);
        execFileSync("git", [
          "-C",
          source,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-qm",
          "fixture",
        ]);
        return execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      };
      // The unchanged blob cannot fit through either bounded transfer. The
      // default branch independently advances after the publication branch.
      writeFileSync(join(source, "unchanged.bin"), randomBytes(COLD_PACK_MAX_BYTES + 1_000_000));
      const ancestor = commit("common ancestor");
      const old = commit("branch tip");
      execFileSync("git", ["-C", source, "push", "-q", remote, `${old}:refs/heads/${input.branch}`]);
      const next = commit("tiny update");
      execFileSync("git", ["-C", source, "checkout", "-q", "-b", "main", ancestor]);
      const main = commit("independent default tip");
      execFileSync("git", ["-C", source, "push", "-q", remote, `${main}:refs/heads/main`]);
      execFileSync("git", ["-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
      expect(() =>
        execFileSync("bash", ["-c", sourcePublicationPackCommand(next, old, pack, source)], { stdio: "ignore" }),
      ).toThrow();
      const local = (command: string) =>
        command
          .replaceAll("/workspace/publisher", dir)
          .replaceAll("/workspace/transfer.pack", pack)
          .replaceAll("https://door.example/git/acme/api.git", remote);
      const plan = controllerPublicationPlan({ ...input, old, next });
      const base = execFileSync("bash", ["-c", local(plan.fetchCommand)], {
        env: { ...process.env, ...plan.env },
        encoding: "utf8",
      }).trim();
      expect(base).toBe(old);
      execFileSync("bash", ["-c", sourcePublicationPackCommand(next, base, pack, source, true)]);
      expect(readFileSync(pack).length).toBeLessThan(100_000);
      const update = controllerPublicationPlan({ ...input, old, next }, base);
      execFileSync("bash", ["-c", local(update.prepareCommand)], { env: { ...process.env, ...update.prepareEnv } });
      const oldBlob = execFileSync("git", ["-C", source, "rev-parse", `${old}:live.txt`], {
        encoding: "utf8",
      }).trim();
      const oldBlobIsMissing = () =>
        expect(() =>
          execFileSync("git", ["-C", dir, "cat-file", "-e", oldBlob], {
            env: { ...process.env, ...update.prepareEnv },
            stdio: "ignore",
          }),
        ).toThrow();
      oldBlobIsMissing();
      execFileSync("bash", ["-c", local(update.pushCommand)], { env: { ...process.env, ...update.env } });
      oldBlobIsMissing();
      expect(
        execFileSync("git", ["-C", remote, "rev-parse", `refs/heads/${input.branch}`], {
          encoding: "utf8",
        }).trim(),
      ).toBe(next);
      execFileSync("git", ["-C", remote, "fsck", "--full", "--strict"], { stdio: "pipe" });
      // A moved branch cannot be silently substituted for the typed old tip.
      rmSync(dir, { recursive: true, force: true });
      expect(() =>
        execFileSync("bash", ["-c", local(plan.fetchCommand)], {
          env: { ...process.env, ...plan.env },
          stdio: "ignore",
        }),
      ).toThrow();
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
  it.each(["missing blob", "missing tree", "malformed tree", "promised blob used as tree"])(
    "rejects a new graph with a %s even when the trusted base promises unchanged blobs",
    (damage) => {
      const fixture = mkdtempSync(join(tmpdir(), "cold-untrusted-"));
      try {
        const source = join(fixture, "source");
        const dir = join(fixture, "publisher");
        const pack = join(fixture, "transfer.pack");
        execFileSync("git", ["init", "-q", source]);
        const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
        git("config", "uploadpack.allowFilter", "true");
        const commit = () => {
          git("add", "-A");
          git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
          return git("rev-parse", "HEAD");
        };
        writeFileSync(join(source, "unchanged.txt"), "trusted unchanged blob\n");
        const old = commit();
        git("update-ref", `refs/heads/${input.branch}`, old);
        const local = (command: string) =>
          command
            .replaceAll("/workspace/publisher", dir)
            .replaceAll("/workspace/transfer.pack", pack)
            .replaceAll("https://door.example/git/acme/api.git", source);
        const plan = controllerPublicationPlan({ ...input, old });
        expect(
          execFileSync("bash", ["-c", local(plan.fetchCommand)], {
            env: { ...process.env, ...plan.env },
            encoding: "utf8",
          }).trim(),
        ).toBe(old);
        // These objects did not exist at the trusted origin when base was
        // fetched. Its promise must never excuse their omission or corruption.
        writeFileSync(join(source, "new.txt"), "untrusted new blob\n");
        let next = commit();
        if (damage === "promised blob used as tree") {
          const tree = git("rev-parse", `${old}:unchanged.txt`);
          next = execFileSync("git", ["-C", source, "hash-object", "--literally", "-t", "commit", "-w", "--stdin"], {
            input: `tree ${tree}\nparent ${old}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nwrong object type\n`,
            encoding: "utf8",
          }).trim();
          writeFileSync(pack, execFileSync("git", ["-C", source, "pack-objects", "--stdout"], { input: `${next}\n` }));
        } else if (damage === "malformed tree") {
          const tree = execFileSync(
            "git",
            ["-C", source, "hash-object", "--literally", "-t", "tree", "-w", "--stdin"],
            {
              input: "invalid tree",
              encoding: "utf8",
            },
          ).trim();
          next = execFileSync("git", ["-C", source, "hash-object", "--literally", "-t", "commit", "-w", "--stdin"], {
            input: `tree ${tree}\nparent ${old}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\ninvalid\n`,
            encoding: "utf8",
          }).trim();
          writeFileSync(
            pack,
            execFileSync("git", ["-C", source, "pack-objects", "--stdout"], { input: `${next}\n${tree}\n` }),
          );
        } else {
          const omitted = git("rev-parse", damage === "missing blob" ? `${next}:new.txt` : `${next}^{tree}`);
          const objects = git("rev-list", "--objects", "--no-object-names", next, `^${old}`)
            .split("\n")
            .filter((oid) => oid !== omitted)
            .join("\n");
          writeFileSync(
            pack,
            execFileSync("git", ["-C", source, "pack-objects", "--stdout"], { input: `${objects}\n` }),
          );
        }
        const update = controllerPublicationPlan({ ...input, old, next }, old);
        expect(() =>
          execFileSync("bash", ["-c", local(update.prepareCommand)], {
            env: { ...process.env, ...update.prepareEnv },
            stdio: "pipe",
          }),
        ).toThrow();
        expect(git("rev-parse", `refs/heads/${input.branch}`)).toBe(old);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
  it("the Worker tries a complete initial-ref graph before looking for a trusted fallback", () => {
    const worker = readFileSync("deploy/cloudflare-sandbox/worker.ts", "utf8");
    expect(worker).toContain("sourcePublicationPackCommand(next, old, path, WORKDIR, baseFetched)");
    expect(worker).toContain("let pack = await sandbox.exportPublicationPack(input.next, input.old);");
    expect(worker).toContain("if (!pack) {");
    expect(worker.indexOf("let pack = await sandbox.exportPublicationPack(input.next, input.old);")).toBeLessThan(
      worker.indexOf("controller.fetchPublicationBase(input)"),
    );
    expect(worker.indexOf("controller.fetchPublicationBase(input)")).toBeLessThan(
      worker.indexOf("controller.publishControlled({ ...input, pack }, base)"),
    );
  });
  it("refuses oversized, malformed and incomplete untrusted object graphs", () => {
    expect(
      parseColdPublication({ ...input, pack: `UEFDSw${"A".repeat(Math.ceil(COLD_PACK_MAX_BYTES / 3) * 4)}` }),
    ).toBeNull();
    expect(parseColdPublication({ ...input, pack: "AAAA" })).toBeNull();
    expect(parseColdPublication({ ...input, pack: "UEFDSwAAAAIAAAAB" })).toBeNull();
    expect(parseColdPublication({ ...input, pack: "UEFDSwAAAAIAAAAB", env: { GH_TOKEN: "forged" } })).toBeNull();
  });
  it("sends one typed request without model env, refresher, command or retry after response loss", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new Error("synthetic-private-error synthetic-effect-secret");
    });
    vi.stubGlobal("fetch", fetch);
    const executor = new CloudflareSandboxExecutor({
      ...opts,
      resolveEnvs: vi.fn(async () => {
        throw new Error("must not resolve model env");
      }),
    });
    const log = recordingSink();
    const span = createTracer({ clock: () => 1 }).start("cold-publication", { sinks: [log] });
    await expect(executor.publishBranchResult!({ ...input, span })).rejects.toThrow(/outcome unknown/);
    span.end("ok");
    expect(JSON.stringify(log)).not.toContain(input.bearer);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://sandbox.example/publish");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual(input);
    expect(body).not.toHaveProperty("env");
    expect(body).not.toHaveProperty("command");
  });
  it("accepts only the count-free fixed success shape without reflecting Worker output", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0, truncated: false })),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await new CloudflareSandboxExecutor(opts).publishBranchResult!(input)).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("does not accept a forged success with extra receipt fields", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            stdout: "",
            stderr: "",
            exitCode: 0,
            truncated: false,
            accepted: true,
            secret: input.bearer,
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(new CloudflareSandboxExecutor(opts).publishBranchResult!(input)).rejects.toThrow(/outcome unknown/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("a lost HTTP answer after the Worker might have pushed stays unknown", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "synthetic-effect-secret" }), { status: 503 }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(new CloudflareSandboxExecutor(opts).publishBranchResult!(input)).rejects.toThrow(/outcome unknown/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("bounds refusals to fixed text even when the Worker returns credential bytes", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "synthetic-effect-secret" }), { status: 409 }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await new CloudflareSandboxExecutor(opts).publishBranchResult!(input);
    expect(result).toEqual({
      stdout: "",
      stderr: "publication refused by cold controller",
      exitCode: 1,
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain(input.bearer);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
