import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareSandboxExecutor } from "./cloudflareSandbox.js";
import { createTracer } from "../core/trace/tracer.js";
import { recordingSink } from "../core/testing/recordingSink.js";
import {
  execFileSync,
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithBufferEncoding,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transpile } from "typescript";
import { disposeColdController } from "./coldPublicationBoundary.js";
import {
  COLD_PACK_MAX_BYTES,
  controllerPublicationPlan,
  parseColdPublication,
  sourcePublicationPackCommand,
  readColdPublicationPack,
  coldPublicationBaseResult,
  coldPublicationDiagnostics,
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

describe("cold publication refusal diagnostics", () => {
  // Execute the actual route operation without platform admission or a VM.
  // Existing controller-identity tests separately pin allocation and routing.
  const operation = (sandbox: unknown, controller: unknown, log: unknown, request = input) => {
    const worker = readFileSync("deploy/cloudflare-sandbox/worker.ts", "utf8");
    const start = worker.indexOf("      const operation = (async (): Promise<Response> => {");
    const end = worker.indexOf("      ctx.waitUntil(", start);
    if (start < 0 || end < 0) throw new Error("publication route operation missing");
    return new Function(
      "input",
      "sandbox",
      "controller",
      "parseColdPublication",
      "disposeColdController",
      "ctx",
      "OUTPUT_AFTER_EXIT_MS",
      "json",
      "console",
      transpile(`${worker.slice(start, end)}\nreturn operation;`),
    )(
      request,
      sandbox,
      controller,
      parseColdPublication,
      disposeColdController,
      { waitUntil: () => {} },
      20,
      (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
      { log },
    ) as Promise<Response>;
  };
  it.each([
    "valid",
    "unrelated default",
    "missing base",
    "foreign next",
    "malformed object",
    "truncated ancestry",
    "ambiguous merge base",
    "stale lease",
    "wrong repository",
    "fake old",
  ])(
    "bounds a shallow sibling rewrite after default HEAD advances: %s",
    async (damage) => {
      const fixture = mkdtempSync(join(tmpdir(), "cold-sibling-rewrite-"));
      try {
        const source = join(fixture, "source");
        const remote = join(fixture, "remote.git");
        const dir = join(fixture, "publisher");
        const pack = join(fixture, "transfer.pack");
        const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
        execFileSync("git", ["init", "-q", source]);
        execFileSync("git", ["init", "-q", "--bare", remote]);
        execFileSync("git", ["-C", remote, "config", "uploadpack.allowFilter", "true"]);
        const commit = (text: string) => {
          writeFileSync(join(source, "work.txt"), text);
          git("add", "-A");
          git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
          return git("rev-parse", "HEAD");
        };
        commit("historical boundary");
        writeFileSync(join(source, "unchanged.bin"), randomBytes(COLD_PACK_MAX_BYTES + 1_000_000));
        const base = commit("canonical baseline");
        let old = commit("reviewed branch");
        git("checkout", "-q", "-b", "rewrite", base);
        let next = commit("coherent repair");
        if (damage === "ambiguous merge base") {
          const left = old;
          const right = next;
          old = git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit-tree",
            git("rev-parse", `${left}^{tree}`),
            "-p",
            left,
            "-p",
            right,
            "-m",
            "old merge",
          );
          next = git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit-tree",
            git("rev-parse", `${right}^{tree}`),
            "-p",
            right,
            "-p",
            left,
            "-m",
            "new merge",
          );
        }
        git("checkout", "-q", "-b", "default-progress", base);
        let main = commit("advanced default");
        if (damage === "unrelated default") {
          git("checkout", "-q", "--orphan", "other-default");
          commit("unrelated baseline");
          main = commit("unrelated default tip");
        }
        git("push", "-q", remote, `${old}:refs/heads/${input.branch}`, `${main}:refs/heads/main`);
        execFileSync("git", ["-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
        writeFileSync(join(source, ".git", "shallow"), `${base}\n`);
        expect(git("rev-parse", "--is-shallow-repository")).toBe("true");
        for (const head of [old, main]) expect(() => git("merge-base", "--is-ancestor", head, next)).toThrow();
        if (damage !== "ambiguous merge base") expect(git("merge-base", old, next)).toBe(base);
        if (damage === "fake old")
          execFileSync("git", ["-C", remote, "update-ref", `refs/heads/${input.branch}`, base]);
        const request = { ...input, old, next };
        const otherRemote = join(fixture, "other.git");
        if (damage === "wrong repository") execFileSync("git", ["init", "-q", "--bare", otherRemote]);
        const local = (command: string) =>
          command
            .replaceAll("/workspace/publisher", dir)
            .replaceAll("/workspace/transfer.pack", pack)
            .replaceAll("/workspace/ancestry.pack", join(fixture, "ancestry.pack"))
            .replaceAll("/workspace/ancestry.rows", join(fixture, "ancestry.rows"))
            .replaceAll("/workspace/", `${fixture}/`)
            .replaceAll("https://door.example/git/acme/api.git", damage === "wrong repository" ? otherRemote : remote);
        const fetchedBases: string[] = [];
        let prepareError = "";
        const sandbox = {
          exportPublicationPack: async (_next: string, boundary?: string, fetched = false, ancestryOnly = false) => {
            try {
              runShell(sourcePublicationPackCommand(next, boundary, pack, source, fetched, ancestryOnly), {
                stdio: "pipe",
              });
              if (ancestryOnly && damage === "missing base")
                writeFileSync(
                  pack,
                  execFileSync("git", ["-C", source, "pack-objects", "--stdout"], { input: `${old}\n${next}\n` }),
                );
              if (ancestryOnly && damage === "foreign next")
                writeFileSync(
                  pack,
                  execFileSync("git", ["-C", source, "pack-objects", "--stdout"], { input: `${old}\n${base}\n` }),
                );
              if (ancestryOnly && damage === "malformed object") {
                const malformed = execFileSync(
                  "git",
                  ["-C", source, "hash-object", "--literally", "-t", "commit", "-w", "--stdin"],
                  { input: "invalid commit", encoding: "utf8" },
                ).trim();
                writeFileSync(
                  pack,
                  execFileSync("git", ["-C", source, "pack-objects", "--stdout"], {
                    input: `${old}\n${next}\n${base}\n${malformed}\n`,
                  }),
                );
              }
              const bytes = readFileSync(pack);
              return {
                kind: "exported",
                pack: (ancestryOnly && damage === "truncated ancestry"
                  ? bytes.subarray(0, bytes.length - 1)
                  : bytes
                ).toString("base64"),
              };
            } catch {
              return { kind: "refused", cause: "command-refused" };
            }
          },
        };
        const controller = {
          fetchPublicationBase: async (_body: { pack?: string }, from: "branch" | "default" | "ancestor") => {
            const plan = controllerPublicationPlan(request, undefined, from === "default" ? "default" : "branch");
            if (from === "ancestor") writeFileSync(join(fixture, "ancestry.pack"), Buffer.from(_body.pack!, "base64"));
            try {
              const stdout = runShell(local(from === "ancestor" ? plan.ancestryCommand : plan.fetchCommand), {
                env: { ...process.env, ...plan.env },
                encoding: "utf8",
                stdio: "pipe",
              });
              const result = coldPublicationBaseResult(0, stdout);
              if (result.kind === "fetched") fetchedBases.push(result.base);
              return result;
            } catch {
              return { kind: "refused", cause: "command-refused" };
            }
          },
          publishControlled: vi.fn(async (body, boundary) => {
            writeFileSync(pack, Buffer.from(body.pack, "base64"));
            const plan = controllerPublicationPlan(request, boundary);
            expect(plan.pushCommand).toContain(`--force-with-lease='refs/heads/${input.branch}:${old}'`);
            try {
              runShell(local(plan.prepareCommand), {
                env: { ...process.env, ...plan.prepareEnv },
                stdio: "pipe",
              });
            } catch (error) {
              prepareError =
                String((error as { stderr?: unknown }).stderr) + String((error as { stdout?: unknown }).stdout);
              throw error;
            }
            if (damage === "stale lease")
              execFileSync("git", ["-C", remote, "update-ref", `refs/heads/${input.branch}`, main]);
            try {
              runShell(local(plan.pushCommand), {
                env: { ...process.env, ...plan.env },
                stdio: "pipe",
              });
            } catch (error) {
              prepareError =
                String((error as { stderr?: unknown }).stderr) + String((error as { stdout?: unknown }).stdout);
              return { state: "unknown" };
            }
            return { state: "accepted" };
          }),
          destroy: async () => {},
        };
        // This route reads the real old/default bases; neither is an ancestor.
        // Supplying the known common base manually is deliberately not an effect.
        expect(readFileSync(join(source, ".git", "shallow"), "utf8")).toBe(`${base}\n`);
        const response = await operation(sandbox, controller, vi.fn(), request);
        const success = damage === "valid" || damage === "unrelated default";
        const expected = success ? 200 : damage === "stale lease" ? 503 : 409;
        expect(response.status, (await response.clone().text()) + prepareError).toBe(expected);
        if (damage !== "wrong repository" && damage !== "fake old")
          expect(fetchedBases.slice(0, 2)).toEqual([old, main]);
        if (success || damage === "stale lease") {
          expect(fetchedBases.at(-1)).toBe(base);
          expect(controller.publishControlled).toHaveBeenCalledOnce();
        } else expect(controller.publishControlled).not.toHaveBeenCalled();
        expect(
          execFileSync("git", ["-C", remote, "rev-parse", `refs/heads/${input.branch}`], { encoding: "utf8" }).trim(),
        ).toBe(success ? next : damage === "stale lease" ? main : damage === "fake old" ? base : old);
        execFileSync("git", ["-C", remote, "fsck", "--full", "--strict"], { stdio: "pipe" });
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
    30_000,
  );
  it("the actual Worker preserves failed export and both base failures without exposing private output or pushing", async () => {
    const log = vi.fn();
    const sandbox = {
      exportPublicationPack: vi.fn(async () => ({ kind: "refused", cause: "stream-over-limit", stderr: input.bearer })),
    };
    const controller = {
      fetchPublicationBase: vi.fn(async (_body, source) => ({
        kind: "refused",
        cause: source === "branch" ? "hash-format-refused" : "unavailable",
        stderr: input.bearer,
      })),
      publishControlled: vi.fn(),
      destroy: vi.fn(async () => {}),
    };
    const response = await operation(sandbox, controller, log);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({
      error: "publication refused by cold controller",
      phase: "cold-publication-graph-unavailable-or-over-limit",
      diagnostics: [
        { step: "requested-graph", cause: "stream-over-limit" },
        { step: "branch-base", cause: "hash-format-refused" },
        { step: "default-base", cause: "unavailable" },
        { step: "ancestry-graph", cause: "stream-over-limit" },
      ],
    });
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: "cold-publication.refused", phase: body.phase, diagnostics: body.diagnostics }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(input.bearer);
    expect(controller.publishControlled).not.toHaveBeenCalled();
    expect(controller.destroy).toHaveBeenCalledOnce();
    expect(controller.fetchPublicationBase.mock.calls.map(([, source]) => source)).toEqual(["branch", "default"]);
  });
  it("the actual Worker preserves unknown after a possible push and does not emit pre-effect refusal diagnostics", async () => {
    const pack = Buffer.from([80, 65, 67, 75, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]).toString("base64");
    const log = vi.fn();
    const controller = {
      fetchPublicationBase: vi.fn(),
      publishControlled: vi.fn(async () => ({ state: "unknown" })),
      destroy: vi.fn(async () => {}),
    };
    const response = await operation(
      { exportPublicationPack: async () => ({ kind: "exported", pack }) },
      controller,
      log,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "cold publication outcome unknown" });
    expect(controller.publishControlled).toHaveBeenCalledOnce();
    expect(controller.fetchPublicationBase).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(controller.destroy).toHaveBeenCalledOnce();
  });
  it("preserves pre-effect provenance while accepting the legacy refusal shape", async () => {
    const diagnostics = [
      { step: "requested-graph", cause: "command-refused" },
      { step: "branch-base", cause: "unavailable" },
      { step: "default-base", cause: "command-refused" },
    ];
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "publication refused by cold controller",
            phase: "cold-publication-graph-unavailable-or-over-limit",
            diagnostics,
          }),
          { status: 409 },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await new CloudflareSandboxExecutor(opts).publishBranchResult!(input)).toMatchObject({
      exitCode: 1,
      stderr: "publication refused by cold controller (phase: cold-publication-graph-unavailable-or-over-limit)",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(coldPublicationDiagnostics(diagnostics)).toEqual(diagnostics);
    const result = await new CloudflareSandboxExecutor(opts).publishBranchResult!(input);
    for (const path of ["src/core/codingPrPostStep.ts", "src/channels/adminCoordinator.ts"]) {
      const line = readFileSync(path, "utf8")
        .split("\n")
        .find((line) => line.includes("/^publication refused by cold controller"));
      expect(line).toBeDefined();
      const literal = line!.trim();
      const predicate = new RegExp(literal.slice(1, literal.lastIndexOf("/.test")));
      expect(predicate.test(result.stderr)).toBe(true);
      expect(predicate.test(`${result.stderr}; diagnostics: added`)).toBe(false);
    }
  });
  it.each(
    [
      [],
      [{ step: "branch-base", cause: "stream-over-limit" }],
      [{ step: "requested-graph", cause: "command-refused", detail: input.bearer }],
      [{ step: "requested-graph", cause: "invented" }],
      Array.from({ length: 6 }, () => ({ step: "requested-graph", cause: "command-refused" })),
      [
        { step: "default-base", cause: "unavailable" },
        { step: "branch-base", cause: "unavailable" },
      ],
    ].map((diagnostics) => [diagnostics]),
  )("malformed refusal diagnostics stay unknown without replay: %j", async (diagnostics) => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "publication refused by cold controller",
            phase: "cold-publication-graph-unavailable-or-over-limit",
            diagnostics,
          }),
          { status: 409 },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(new CloudflareSandboxExecutor(opts).publishBranchResult!(input)).rejects.toThrow(/outcome unknown/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("reads exact binary chunks and distinguishes nonbinary, measured excess and lost streams", async () => {
    async function* chunks(...values: unknown[]) {
      yield* values;
    }
    const bytes = new Uint8Array([80, 65, 67, 75, 0, 0, 0, 2, 0, 0, 0, 0]);
    expect(await readColdPublicationPack(chunks(bytes.subarray(0, 5), bytes.subarray(5)))).toEqual({
      kind: "exported",
      pack: Buffer.from(bytes).toString("base64"),
    });
    expect(await readColdPublicationPack(chunks("PACK"))).toEqual({ kind: "refused", cause: "stream-not-binary" });
    expect(await readColdPublicationPack(chunks(new Uint8Array(COLD_PACK_MAX_BYTES + 1)))).toEqual({
      kind: "refused",
      cause: "stream-over-limit",
    });
    async function* lost() {
      yield bytes;
      throw new Error(input.bearer);
    }
    expect(await readColdPublicationPack(lost())).toEqual({ kind: "refused", cause: "stream-unavailable" });
  });
  it("classifies a trusted fetch by exit status and exact hash format, never command prose", () => {
    expect(coldPublicationBaseResult(0, `${input.old}\n`)).toEqual({ kind: "fetched", base: input.old });
    expect(coldPublicationBaseResult(1, input.old)).toEqual({ kind: "refused", cause: "command-refused" });
    expect(coldPublicationBaseResult(0, `over limit ${input.old}`)).toEqual({
      kind: "refused",
      cause: "hash-format-refused",
    });
  });
});

// Production runs these commands in Linux sandboxes. Translate only the
// host-specific wrappers when exercising their Git behavior on macOS.
function runShell(command: string, options: ExecFileSyncOptionsWithStringEncoding): string;
function runShell(command: string, options?: ExecFileSyncOptionsWithBufferEncoding): Buffer;
function runShell(command: string, options?: ExecFileSyncOptions): string | Buffer {
  const hostCommand =
    process.platform === "darwin"
      ? command
          .replaceAll("stat -c %s ", "stat -f %z ")
          .replaceAll("ulimit -v 524288\n", "")
          .replaceAll(/timeout -k 5 (?:30|45|60) /g, "")
      : command;
  return execFileSync("bash", ["-c", hostCommand], { timeout: 120_000, ...options });
}

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
    expect(plan.prepareCommand).toContain("ulimit -v 524288");
    expect(plan.prepareCommand).toContain("timeout -k 5 60 git");
    expect(plan.fetchCommand).toContain("timeout -k 5 45 git");
    expect(plan.fetchCommand).toContain("timeout -k 5 30 git");
    expect(plan.pushCommand).toContain("timeout -k 5 60 git");
    expect(sourcePublicationPackCommand(input.next, input.old, "/workspace/transfer.pack")).toContain("stat -c %s");
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
      runShell(sourcePublicationPackCommand(next, undefined, pack, source));
      const graph = readFileSync(pack);
      const plan = controllerPublicationPlan({ ...input, next, old: undefined });
      const prepare = plan.prepareCommand
        .replaceAll("/workspace/publisher", join(fixture, "publisher"))
        .replaceAll("/workspace/transfer.pack", join(fixture, "transfer.pack"));
      const run = () => runShell(prepare, { env: { ...process.env, ...plan.prepareEnv } });
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
      runShell(sourcePublicationPackCommand(next, old, pack, source));
      const graph = readFileSync(pack);
      expect(graph.length).toBeLessThan(100_000);
      const plan = controllerPublicationPlan({ ...input, old, next });
      const prepare = plan.prepareCommand
        .replaceAll("/workspace/publisher", join(fixture, "publisher"))
        .replaceAll("/workspace/transfer.pack", pack);
      expect(() => runShell(prepare, { env: { ...process.env, ...plan.prepareEnv } })).not.toThrow();
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
      expect(() => runShell(prepare, { env: { ...process.env, ...plan.prepareEnv }, stdio: "ignore" })).toThrow();
      expect(() => sourcePublicationPackCommand("HEAD", old, pack, source)).toThrow();
      writeFileSync(join(source, "live.txt"), randomBytes(COLD_PACK_MAX_BYTES + 1_000_000));
      const oversized = commit();
      expect(() =>
        runShell(sourcePublicationPackCommand(oversized, next, pack, source), { stdio: "ignore" }),
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
        runShell(sourcePublicationPackCommand(rebasedNext, old, rebased, source), {
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
          runShell(local(plan.fetchCommand), {
            env: { ...process.env, ...plan.env },
            encoding: "utf8",
          }).trim(),
        ).toBe(old);
        expect(() =>
          runShell(sourcePublicationPackCommand(rebasedNext, old, pack, source, true), {
            stdio: "ignore",
          }),
        ).toThrow();
      }
      // A new ref first tries the bounded complete graph; the deleted
      // historical blob makes that attempt exceed the cap in this case.
      if (kind === "initial")
        expect(() =>
          runShell(sourcePublicationPackCommand(rebasedNext, undefined, pack, source), {
            stdio: "ignore",
          }),
        ).toThrow();
      const fetch = local(controllerPublicationPlan(request, undefined, "default").fetchCommand);
      expect(runShell(fetch, { env: { ...process.env, ...plan.env }, encoding: "utf8" }).trim()).toBe(base);
      runShell(sourcePublicationPackCommand(rebasedNext, base, pack, source, true));
      const update = controllerPublicationPlan(request, base);
      const prepare = update.prepareCommand
        .replaceAll("/workspace/publisher", dir)
        .replaceAll("/workspace/transfer.pack", pack);
      expect(() => runShell(prepare, { env: { ...process.env, ...update.prepareEnv } })).not.toThrow();
      expect(readFileSync(pack).length).toBeLessThan(100_000);
      expect(rebasedNext).not.toBe(next);
      // The trusted base only bounds the graph; the push still uses the
      // original lease, including the empty lease on the initial branch.
      expect(update.pushCommand).toContain(`--force-with-lease='refs/heads/${input.branch}:${request.old ?? ""}'`);
      runShell(local(update.pushCommand), { env: { ...process.env, ...update.env } });
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
            runShell(local(plan.fetchCommand), {
              env: { ...process.env, ...plan.env },
              stdio: "ignore",
            }),
          ).toThrow();
          rmSync(dir, { recursive: true, force: true });
        } else {
          const defaultHead = execFileSync("git", ["-C", remote, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
          expect(() =>
            runShell(sourcePublicationPackCommand(next, defaultHead, pack, source, true), {
              stdio: "ignore",
            }),
          ).toThrow();
        }
        runShell(sourcePublicationPackCommand(next, undefined, pack, source));
        expect(readFileSync(pack).length).toBeLessThan(COLD_PACK_MAX_BYTES);
        runShell(local(plan.prepareCommand), { env: { ...process.env, ...plan.prepareEnv } });
        expect(plan.pushCommand).toContain(`--force-with-lease='refs/heads/${input.branch}:'`);
        runShell(local(plan.pushCommand), { env: { ...process.env, ...plan.env } });
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
      expect(() => runShell(fetch, { env: { ...process.env, ...plan.env }, stdio: "ignore" })).toThrow();
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
      execFileSync("git", ["-C", source, "checkout", "-q", "-b", "diverged-default", ancestor]);
      const main = commit("independent default tip");
      execFileSync("git", ["-C", source, "push", "-q", remote, `${main}:refs/heads/main`]);
      execFileSync("git", ["-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
      expect(() => runShell(sourcePublicationPackCommand(next, old, pack, source), { stdio: "ignore" })).toThrow();
      const local = (command: string) =>
        command
          .replaceAll("/workspace/publisher", dir)
          .replaceAll("/workspace/transfer.pack", pack)
          .replaceAll("https://door.example/git/acme/api.git", remote);
      const plan = controllerPublicationPlan({ ...input, old, next });
      const base = runShell(local(plan.fetchCommand), {
        env: { ...process.env, ...plan.env },
        encoding: "utf8",
      }).trim();
      expect(base).toBe(old);
      runShell(sourcePublicationPackCommand(next, base, pack, source, true));
      expect(readFileSync(pack).length).toBeLessThan(100_000);
      const update = controllerPublicationPlan({ ...input, old, next }, base);
      runShell(local(update.prepareCommand), { env: { ...process.env, ...update.prepareEnv } });
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
      runShell(local(update.pushCommand), { env: { ...process.env, ...update.env } });
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
        runShell(local(plan.fetchCommand), {
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
          runShell(local(plan.fetchCommand), {
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
          runShell(local(update.prepareCommand), {
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
    expect(worker).toContain("sourcePublicationPackCommand(next, old, path, WORKDIR, baseFetched, ancestryOnly)");
    expect(worker).toContain('let pack = await graph("requested-graph", input.old);');
    expect(worker).toContain("if (!pack) {");
    expect(worker.indexOf('let pack = await graph("requested-graph", input.old);')).toBeLessThan(
      worker.indexOf('base = await fetchBase("branch")'),
    );
    expect(worker.indexOf('base = await fetchBase("branch")')).toBeLessThan(
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
  it.each([
    "cold-publication-base-unavailable-or-over-limit",
    "cold-publication-graph-unavailable-or-over-limit",
    "cold-publication-transfer-refused",
    "cold-publication-validation-refused",
  ])("preserves only the fixed pre-effect 409 phase %s without Worker text", async (phase) => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "publication refused by cold controller", phase }), { status: 409 }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await new CloudflareSandboxExecutor(opts).publishBranchResult!(input)).toEqual({
      stdout: "",
      stderr: `publication refused by cold controller (phase: ${phase})`,
      exitCode: 1,
      truncated: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    [409, { error: "synthetic-effect-secret" }],
    [409, { error: "publication refused by cold controller", phase: "invented-phase" }],
    [
      409,
      { error: "publication refused by cold controller", phase: "cold-publication-validation-refused", secret: "x" },
    ],
    [400, { error: "publication refused by cold controller", phase: "cold-publication-validation-refused" }],
    [503, { error: "publication refused by cold controller", phase: "cold-publication-validation-refused" }],
  ])("treats an untrusted %s publication answer as unknown, not a refusal", async (status, body) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fetch);
    await expect(new CloudflareSandboxExecutor(opts).publishBranchResult!(input)).rejects.toThrow(/outcome unknown/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["not-json", "x".repeat(2049)])("a malformed 409 body stays unknown with no replay", async (body) => {
    const fetch = vi.fn(async () => new Response(body, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    await expect(new CloudflareSandboxExecutor(opts).publishBranchResult!(input)).rejects.toThrow(/outcome unknown/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("the Worker sends only fixed pre-effect 409 phase codes, never SDK output", () => {
    const worker = readFileSync("deploy/cloudflare-sandbox/worker.ts", "utf8");
    expect(worker).toContain('phase: "cold-publication-transfer-refused"');
    expect(worker).toContain('phase: "cold-publication-validation-refused"');
    expect(worker).toContain('"cold-publication-base-unavailable-or-over-limit"');
    expect(worker).toContain('"cold-publication-graph-unavailable-or-over-limit"');
    expect(worker).toContain('json({ error: "publication refused by cold controller", phase: result.phase }, 409)');
    expect(worker).not.toMatch(/phase:\s*(?:prepared|written|pushed)\./);
  });
});
