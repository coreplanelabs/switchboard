import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, Executor } from "../execution/executor.js";
import { ResidentExecutor } from "../execution/resident.js";
import { TracingExecutor } from "../execution/tracingExecutor.js";
import { createTracer } from "./trace/tracer.js";
import { GitBindings } from "./modelProxy/gitBindings.js";
import { bearerHashOf, type RunBearerStore } from "./modelProxy/runBearers.js";
import { publicationEffectTool } from "./publicationEffect.js";

const old = "a".repeat(40);
const next = "b".repeat(40);
const token = `sbr_run.${"c".repeat(64)}`;
const modelToken = `sbr_run.${"d".repeat(64)}`;
const branch = "fix/owned";
const source = `refs/heads/${branch}`;
const update = { ref: source, old, next };
afterEach(() => vi.unstubAllGlobals());

function effect(
  options: {
    failPush?: boolean;
    failFirstPush?: boolean;
    wrongRemote?: boolean;
    unbound?: boolean;
    newBranch?: boolean;
    dirty?: boolean;
    checkedOut?: string;
    missingCheckout?: boolean;
    statusResult?: Partial<ExecResult>;
    pushResult?: Partial<ExecResult>;
    remoteResult?: Partial<ExecResult>;
    missingStructured?: "execResult" | "publishBranchResult";
    resident?: boolean;
  } = {},
) {
  const bindings = new GitBindings();
  bindings.register("run", { repo: "o/r", ref: source }, undefined, async () => true, !options.newBranch);
  if (options.newBranch) bindings.setBranchRecorder("run", { begin: async () => true, finish: async () => true });
  else {
    bindings.setPublication("run", { ref: branch, expectedHeadSha: old });
    bindings.setPublicationRecorder("run", { begin: async () => true, finish: async () => true });
  }
  bindings.requireToolPush("run");
  const commands: Array<{ command: string }> = [];
  const publications: Array<{ branch: string; next: string; old?: string; bearer: string }> = [];
  let pushAttempts = 0;
  const checkout = options.resident ? "/workspace/threads/t/wt" : "/workspace/checkout";
  const git = (args: string) => `git -C '${checkout}' ${args}`;
  const executor: Executor = {
    exec: vi.fn(async () => "(no output)"),
    execResult: vi.fn(async (command) => {
      commands.push({ command });
      let stdout: string | undefined;
      if (command === git("symbolic-ref --quiet --short HEAD")) stdout = options.checkedOut ?? branch;
      else if (command === git("status --porcelain -uno")) stdout = options.dirty ? " M src/a.ts" : "";
      else if (command.startsWith(git("check-ref-format"))) stdout = branch;
      else if (command.startsWith(git("rev-parse --verify"))) stdout = next;
      if (command === git("remote get-url origin"))
        stdout = options.wrongRemote ? "https://other.example/o/r" : "https://door.example/git/o/r.git";
      else if (command.startsWith(git("ls-remote"))) stdout = `${next}\t${source}`;
      else if (stdout === undefined) return { stdout: "", stderr: "unexpected command", exitCode: 1, truncated: false };
      return {
        stdout,
        stderr: "",
        exitCode: 0,
        truncated: false,
        ...(command === git("status --porcelain -uno") ? options.statusResult : {}),
        ...(command.startsWith(git("ls-remote")) ? options.remoteResult : {}),
      };
    }),
    publishBranchResult: vi.fn(async (input) => {
      publications.push(input);
      // An opaque shell using the model's bearer cannot borrow the effect's
      // pending grant even with the same source/destination and old head.
      const request = options.newBranch ? { ...update, old: "0".repeat(40) } : update;
      expect(bindings.takeToolPush("run", request, bearerHashOf(modelToken))).toBe(false);
      expect(bindings.takeToolPush("run", request, bearerHashOf(input.bearer))).toBe(true);
      pushAttempts++;
      if (options.failPush || (options.failFirstPush && pushAttempts === 1))
        return { stdout: "", stderr: "remote rejected", exitCode: 1, truncated: false };
      if (!options.unbound) {
        const claim = options.newBranch
          ? await bindings.beginBranch("run", request)
          : await bindings.beginPublication("run", request);
        expect(await claim?.finish("accepted")).toBe(true);
      }
      const stdout = options.newBranch
        ? `To https://door.example/git/o/r.git\n * [new branch]      ${next.slice(0, 7)} -> ${branch}`
        : `To https://door.example/git/o/r.git\n + ${old.slice(0, 7)}...${next.slice(0, 7)} ${branch} -> ${branch} (forced update)`;
      return { stdout, stderr: "", exitCode: 0, truncated: false, ...options.pushResult };
    }),
    readFile: async () => "",
    writeFile: async () => "",
  };
  if (options.missingStructured) delete executor[options.missingStructured];
  let boundary: Executor = executor;
  if (options.resident) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const result =
          new URL(url).pathname === "/publish"
            ? await executor.publishBranchResult!(body)
            : await executor.execResult!(body.command);
        return new Response(JSON.stringify(result));
      }),
    );
    boundary = new TracingExecutor(
      new ResidentExecutor({
        baseUrl: "https://resident.example",
        token: "operator-test-token",
        resource: "repo:o/r",
        threadKey: "slack:CX:1.0",
      }),
      createTracer({ clock: () => 1000 }).start("publication", { sinks: [] }),
      "resident",
    );
  }
  const tool = publicationEffectTool({
    runId: "run",
    repo: "o/r",
    doorUrl: "https://door.example",
    branch,
    checkout: () => (options.missingCheckout ? undefined : checkout),
    protectedBranches: ["main"],
    bindings,
    bearers: { issue: () => ({ token, expiresAt: 100 }) } as unknown as RunBearerStore,
  });
  const published: unknown[] = [];
  const run = (name: string) =>
    tool.run(
      { branch: name },
      { executor: boundary, callId: "owned-call", publish: (event) => void published.push(event) },
    );
  return { bindings, commands, publications, published, run, executor };
}

describe("publish_branch — a runner-owned Git Door effect", () => {
  it("publishes the owned branch from a cold /workspace checkout and refuses another owner or ref", async () => {
    const root = mkdtempSync(join(tmpdir(), "switchboard-cold-publication-"));
    const workspace = join(root, "workspace");
    const checkout = join(workspace, "checkout");
    mkdirSync(checkout, { recursive: true });
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      git("init", "--initial-branch", branch);
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "source");
      git("remote", "add", "origin", "https://door.example/git/o/r.git");
      const sourceCommit = git("rev-parse", "HEAD");
      const bindings = new GitBindings();
      bindings.register("run", { repo: "o/r", ref: source }, undefined, async () => true, true);
      bindings.setPublication("run", { ref: branch, expectedHeadSha: old });
      bindings.setPublicationRecorder("run", { begin: async () => true, finish: async () => true });
      bindings.requireToolPush("run");
      const commands: string[] = [];
      const publications: string[] = [];
      const executor: Executor = {
        exec: async () => "",
        execResult: async (command) => {
          commands.push(command);
          if (command.includes("ls-remote"))
            return { stdout: `${sourceCommit}\t${source}`, stderr: "", exitCode: 0, truncated: false };
          const result = spawnSync("bash", ["-c", command.replaceAll("/workspace/checkout", checkout)], {
            cwd: workspace,
            encoding: "utf8",
          });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.status ?? 1,
            truncated: false,
          };
        },
        publishBranchResult: async (input) => {
          publications.push(input.branch);
          expect(input.next).toBe(sourceCommit);
          expect(input.old).toBe(old);
          expect(
            bindings.takeToolPush("run", { ref: source, old, next: sourceCommit }, bearerHashOf(input.bearer)),
          ).toBe(true);
          const claim = await bindings.beginPublication("run", { ref: source, old, next: sourceCommit });
          expect(await claim?.finish("accepted")).toBe(true);
          return { stdout: "accepted", stderr: "", exitCode: 0, truncated: false };
        },
        readFile: async () => "",
        writeFile: async () => "",
      };
      const makeTool = (runId: string) =>
        publicationEffectTool({
          runId,
          repo: "o/r",
          doorUrl: "https://door.example",
          branch,
          checkout: () => "/workspace/checkout",
          protectedBranches: ["main"],
          bindings,
          bearers: { issue: () => ({ token, expiresAt: 100 }) } as unknown as RunBearerStore,
        });
      const call = (runId: string, selectedBranch: string) =>
        makeTool(runId).run({ branch: selectedBranch }, { executor, callId: "owned-call" });
      expect(await call("run", "other")).toContain("run's owned branch");
      expect(await call("foreign", branch)).toContain("did not admit");
      const hiddenCheckout = join(workspace, "hidden-checkout");
      renameSync(checkout, hiddenCheckout);
      try {
        expect(await call("run", branch)).toContain("owned branch is not checked out");
      } finally {
        renameSync(hiddenCheckout, checkout);
      }
      expect(publications).toHaveLength(0);
      expect(await call("run", branch)).toBe("accepted");
      expect(publications).toEqual([branch]);
      expect(bindings.publicationOf("run")).toEqual({ ref: branch, expectedHeadSha: sourceCommit });
      expect(commands.some((command) => command.startsWith("git -C '/workspace/checkout' symbolic-ref"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds the one-use transport credential, source, endpoint, old head and result to the originating call", async () => {
    const { bindings, commands, publications, published, run } = effect();
    expect(await run(branch)).toContain(`To https://door.example/git/o/r.git`);
    expect(bindings.publicationOf("run")).toEqual({ ref: branch, expectedHeadSha: next });
    expect(publications).toMatchObject([{ repo: "o/r", branch, next, old, bearer: token }]);
    expect(commands.every(({ command }) => !command.includes(token))).toBe(true);
    expect(published).toEqual([
      { type: "publication_push_authorized", callId: "owned-call", ref: branch, expectedHeadSha: old },
    ]);
    expect(bindings.takeToolPush("run", update, bearerHashOf(token))).toBe(false);
  });

  it("refuses wrong endpoint, foreign branch and blocked authority before any write; recovery can retry", async () => {
    const bad = effect({ wrongRemote: true });
    expect(await bad.run(branch)).toContain("origin does not name");
    expect(bad.publications).toHaveLength(0);
    const dirty = effect({ dirty: true });
    expect(await dirty.run(branch)).toContain("tracked tree is not clean");
    expect(dirty.publications).toHaveLength(0);
    const wrongCheckout = effect({ checkedOut: "fix/other" });
    expect(await wrongCheckout.run(branch)).toContain("owned branch is not checked out");
    expect(wrongCheckout.publications).toHaveLength(0);
    const missingCheckout = effect({ missingCheckout: true });
    expect(await missingCheckout.run(branch)).toContain("selected checkout is unavailable");
    expect(missingCheckout.commands).toHaveLength(0);
    const good = effect();
    expect(await good.run("main")).toContain("non-protected branch");
    expect(await good.run("other")).toContain("run's owned branch");
    expect(good.publications).toHaveLength(0);
    expect(await good.run(branch)).toContain(`To https://door.example`);
    const retry = effect({ failFirstPush: true });
    expect(await retry.run(branch)).toContain("remote rejected");
    expect(retry.bindings.hasToolPush("run", bearerHashOf(token))).toBe(false);
    expect(await retry.run(branch)).toContain(`To https://door.example`);
  });

  it("publishes a new owned branch with a separate credential and a durable branch intent", async () => {
    const { publications, published, run } = effect({ newBranch: true });
    expect(await run(branch)).toContain("[new branch]");
    expect(publications[0]?.old).toBeUndefined();
    expect(published).toEqual([]);
  });

  it("does not report an accepted publication when the Door has not committed the outcome", async () => {
    expect(await effect({ unbound: true }).run(branch)).toContain("did not commit");
    expect(await effect({ failPush: true }).run(branch)).toContain("remote rejected");
  });

  it.each(["execResult", "publishBranchResult"] as const)(
    "requires %s before granting publication",
    async (missingStructured) => {
      const missing = effect({ missingStructured });
      expect(await missing.run(branch)).toContain("no structured publication transport");
      expect(missing.publications).toHaveLength(0);
      expect(missing.commands).toHaveLength(0);
    },
  );

  it.each([{ truncated: true }, { exitCode: 1 }, { exitCode: 124 }, { stdout: "(no output)" }])(
    "refuses incomplete or nonempty status facts before grant: %j",
    async (statusResult) => {
      const bad = effect({ statusResult });
      expect(await bad.run(branch)).toContain("tracked tree is not clean");
      expect(bad.publications).toHaveLength(0);
      expect(bad.published).toHaveLength(0);
    },
  );

  it("publishes a clean tree through resident and tracing without parsing the rendered empty-output sentinel", async () => {
    const good = effect({ resident: true });
    expect(await good.run(branch)).toContain("To https://door.example");
    expect(good.bindings.publicationOf("run")).toEqual({ ref: branch, expectedHeadSha: next });
    expect(good.executor.exec).not.toHaveBeenCalled();
    expect(good.commands[0]?.command).toBe("git -C '/workspace/threads/t/wt' symbolic-ref --quiet --short HEAD");
  });

  it.each([{ truncated: true }, { exitCode: 1, stdout: "accepted" }])(
    "refuses unsuccessful typed transport facts and clears the grant: %j",
    async (pushResult) => {
      const bad = effect({ pushResult });
      expect(await bad.run(branch)).toContain("publication refused");
      expect(bad.bindings.hasToolPush("run", bearerHashOf(token))).toBe(false);
      expect(bad.commands.some(({ command }) => command.includes("ls-remote"))).toBe(false);
    },
  );

  it.each([{ truncated: true }, { exitCode: 1 }, { stdout: `${old}\t${source}` }])(
    "requires a complete matching remote head after acceptance: %j",
    async (remoteResult) => {
      const bad = effect({ remoteResult });
      expect(await bad.run(branch)).toContain("remote head cannot be verified");
      expect(bad.bindings.hasToolPush("run", bearerHashOf(token))).toBe(false);
    },
  );
});
