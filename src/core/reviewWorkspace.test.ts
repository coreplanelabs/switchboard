// Feature: docs/reference/specs/agent-review.md — settlement uses the acknowledged checkout.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AGENTS } from "../agents/registry.js";
import { LocalExecutor, type ExecResult } from "../execution/executor.js";
import { CloudflareSandboxExecutor } from "../execution/cloudflareSandbox.js";
import { ResidentExecutor } from "../execution/resident.js";
import { checkoutOfSelection, type ExecutorSelection } from "../execution/factory.js";
import { shellQuote } from "../execution/shellQuote.js";
import { RunControl } from "./runRegistry/runControl.js";
import { authorizeAttachedHead } from "./dispatch/authorize.js";
import { ConfigStore } from "../config.js";
import { NO_CAPABILITIES } from "./capabilities.js";
import { startRequestRoot } from "./requestTrace.js";
import { createCardShell } from "./statusCardFrame.js";
import { settleReviewedHead, type SettleReviewedHeadInput } from "./reviewRound.js";

const OLD_HEAD = "8cf2ba4a9572efcded46c8b0268a41d778aa305c";
const NEW_HEAD = "f2cb741ac2547acad79e49540aa60d1ed2818a39";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function workspace(
  intercept?: (command: string, result: ExecResult, repo: LocalExecutor) => Promise<ExecResult>,
) {
  const root = mkdtempSync(join(tmpdir(), "review-workspace-"));
  roots.push(root);
  const workdir = join(root, "workspace"),
    checkout = join(workdir, "checkout with spaces"),
    remote = join(root, "remote.git");
  mkdirSync(checkout, { recursive: true });
  const identity = {
    GIT_AUTHOR_NAME: "Contract",
    GIT_AUTHOR_EMAIL: "contract@example.invalid",
    GIT_COMMITTER_NAME: "Contract",
    GIT_COMMITTER_EMAIL: "contract@example.invalid",
    GIT_AUTHOR_DATE: "1234567890 +0000",
    GIT_COMMITTER_DATE: "1234567890 +0000",
  };
  const repo = new LocalExecutor(checkout, async () => identity);
  const rootExecutor = new LocalExecutor(root);
  expect((await rootExecutor.execResult(`git init --bare ${shellQuote(remote)}`)).exitCode).toBe(0);
  for (const command of [
    "git init --object-format=sha1",
    "git config core.autocrlf false",
    "git checkout -b feature",
    `git remote add origin ${shellQuote(remote)}`,
  ])
    expect((await repo.execResult(command)).exitCode).toBe(0);
  await repo.writeFile("source.txt", "before\n");
  expect((await repo.execResult("git add . && git commit -m before && git push origin HEAD:feature")).exitCode).toBe(0);
  expect((await repo.execResult("git rev-parse HEAD")).stdout.trim()).toBe(OLD_HEAD);
  const old = OLD_HEAD;
  await repo.writeFile("source.txt", "after\n");
  expect((await repo.execResult("git add . && git commit -m after && git push origin HEAD:feature")).exitCode).toBe(0);
  expect((await repo.execResult("git rev-parse HEAD")).stdout.trim()).toBe(NEW_HEAD);
  const target = NEW_HEAD;
  expect((await repo.execResult(`git checkout --detach ${old}`)).exitCode).toBe(0);
  const sdkRoot = new LocalExecutor(workdir),
    commands: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      commands.push(body.command);
      if (typeof body.command !== "string") return new Response("{}");
      const result = await sdkRoot.execResult(body.command);
      return new Response(JSON.stringify(intercept ? await intercept(body.command, result, repo) : result));
    }),
  );
  const executor = new CloudflareSandboxExecutor({
    url: "https://sandbox.example",
    token: "fixture",
    threadKey: "cli:review",
    resolveEnvs: async () => ({}),
  });
  const followUp = vi.fn(async (input) => {
    expect((await repo.execResult("git rev-parse HEAD")).stdout.trim()).toBe(target);
    input.toolContext.onVerdict({ verdict: "approve", summary: "new head reviewed", head: target, findings: [] });
    return "New head reviewed.";
  });
  const input: SettleReviewedHeadInput & { checkout: () => string | undefined } = {
    checkout: () => checkout,
    pr: { repo: "acme/api", number: 7 },
    baseRef: "main",
    reviewHead: old,
    verdict: { verdict: "approve", summary: "old head reviewed", head: old, findings: [] },
    answer: "Old head reviewed.",
    messages: [],
    executor,
    turn: { agent: AGENTS.review, toolContext: { executor }, onEvent: () => {}, control: new RunControl(), followUp },
    fetchPrHead: async () => target,
    fetchPrCommits: async ({ sha }) => ({
      commits:
        sha === old
          ? [{ sha: old, message: "before" }]
          : [
              { sha: old, message: "before" },
              { sha: target, message: "after" },
            ],
      files: ["source.txt"],
      filesTruncated: false,
    }),
    preReviewStopped: () => false,
    notify: { reply: async () => {}, headMoved: () => {} },
    logKey: "fixture",
  };
  return { root, repo, old, target, checkout, commands, input, followUp };
}
async function admit(w: Awaited<ReturnType<typeof workspace>>, selection: ExecutorSelection) {
  writeFileSync(
    join(w.root, "config.yaml"),
    "organization: acme\nproviders:\n  openai:\n    wire: openai-responses\n    apiKeyEnv: OPENAI_API_KEY\ndefaults:\n  agent: general\n  models:\n    general: openai/gpt-4o\n    review: openai/gpt-4o\n",
  );
  const replies: string[] = [];
  return await authorizeAttachedHead(
    {
      config: new ConfigStore(join(w.root, "config.yaml"), join(w.root, "overrides.json")),
      capabilities: NO_CAPABILITIES,
      fetchPrHead: async () => NEW_HEAD,
    },
    {
      agent: AGENTS.review,
      resume: undefined,
      selection,
      repoCtx: { repo: "acme/api", ref: "feature", pr: 7, headSha: NEW_HEAD },
      msg: { userId: "cli:owner", channelId: "cli:local", threadKey: "cli:task", text: "Review" },
      io: {
        reply: async (text) => {
          replies.push(text);
        },
        status: async () => ({ update: () => {}, done: async () => {} }),
        history: async () => [],
      },
      refuse: async (_reason, side) => {
        await side?.();
      },
      card: { update: () => {}, done: async () => {} },
      shell: createCardShell({ label: "Review", startedAt: 0, now: () => 0 }),
      closeLines: () => ({}),
      clock: () => 0,
      stopSignal: new AbortController().signal,
      root: startRequestRoot({ clock: () => 0 }, { channel: "cli", receivedAt: 0 }).root,
    },
  );
}

describe("review settlement in a bound non-root checkout", () => {
  it("keeps an unchanged native binding working and holds a mid-review directory change without claiming a new review", async () => {
    for (const mode of ["unchanged", "changed_mid", "changed_initial"] as const) {
      const changed = mode !== "unchanged";
      const w = await workspace();
      const next = join(w.root, "new acknowledged checkout");
      const remote = (await w.repo.execResult("git remote get-url origin")).stdout.trim();
      const setup = new LocalExecutor(w.root);
      expect((await setup.execResult(`git clone ${shellQuote(remote)} ${shellQuote(next)}`)).exitCode).toBe(0);
      const fresh = new LocalExecutor(next);
      expect((await fresh.execResult(`git checkout --detach ${NEW_HEAD}`)).exitCode).toBe(0);
      await w.repo.writeFile("private.txt", "original owner bytes\n");
      let current = w.checkout;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          if (new URL(String(url)).pathname.endsWith("/attach")) {
            if (body.sha === NEW_HEAD) {
              if (changed) current = next;
              else expect((await w.repo.execResult(`git checkout --detach ${NEW_HEAD}`)).exitCode).toBe(0);
            }
            return new Response(
              JSON.stringify({
                ok: true,
                ref: "feature",
                sha: body.sha === NEW_HEAD ? NEW_HEAD : OLD_HEAD,
                workspace: current,
                ownerFence: 7,
                user: "worker1",
                container: "fixture-container",
              }),
            );
          }
          return new Response(JSON.stringify(await new LocalExecutor(current).execResult(body.command)));
        }),
      );
      const executor = new ResidentExecutor({
        baseUrl: "https://resident.example",
        token: "fixture",
        resource: "repo:acme/api",
        threadKey: "cli:task",
        runId: "fixture",
        ownerGen: "g1",
        ownerFence: 7,
        refHint: "feature",
        sha: OLD_HEAD,
      });
      const binding = await executor.attach();
      const selection = { executor, backend: "resident" as const, resident: true, binding };
      const input = { ...w.input, executor, checkout: () => checkoutOfSelection(selection) };
      const prompts: string[] = [];
      const submitted: Array<{ head: string; summary: string }> = [];
      input.turn = {
        ...input.turn,
        toolContext: { executor },
        followUp: async (args) => {
          prompts.push(args.text);
          submitted.push({ head: NEW_HEAD, summary: "new review" });
          args.toolContext.onVerdict?.({ verdict: "approve", head: NEW_HEAD, summary: "new review", findings: [] });
          return "new review";
        },
      };
      if (mode === "changed_initial") {
        expect(await admit(w, selection)).toMatchObject({
          kind: "allowed",
          verifiedAtAttach: true,
          repoCtx: { headSha: NEW_HEAD },
        });
        expect(selection.binding.workspace).toBe(next);
        expect((await w.repo.execResult("git rev-parse HEAD")).stdout.trim()).toBe(OLD_HEAD);
      } else if (changed) {
        await expect(settleReviewedHead(input)).rejects.toThrow("acknowledged checkout changed during review");
        expect(prompts).toEqual([]);
        expect(submitted).toEqual([]);
        expect((await w.repo.execResult("git rev-parse HEAD")).stdout.trim()).toBe(OLD_HEAD);
      } else {
        expect(await settleReviewedHead(input)).toMatchObject({
          answer: "new review",
          reviewHead: NEW_HEAD,
          observedHead: NEW_HEAD,
          verdict: { head: NEW_HEAD },
        });
        expect(prompts).toHaveLength(1);
        expect(submitted).toEqual([{ head: NEW_HEAD, summary: "new review" }]);
      }
      expect(executor.binding).toMatchObject({
        sha: NEW_HEAD,
        workspace: changed ? next : w.checkout,
        ownerFence: 7,
        ownerGen: "g1",
        user: "worker1",
      });
      expect(await w.repo.readFile("private.txt")).toBe("original owner bytes\n");
      expect((await fresh.execResult("git rev-parse HEAD")).stdout.trim()).toBe(NEW_HEAD);
    }
  });
  it("re-provisions the acknowledged seeded checkout during initial attached-head admission", async () => {
    const w = await workspace();
    const result = await admit(w, {
      executor: w.input.executor,
      backend: "sandbox",
      seeded: { slug: "acme/api", ref: "feature", sha: OLD_HEAD, workspace: w.checkout, cached: false, ms: 0 },
    });
    expect(result).toMatchObject({ kind: "allowed", verifiedAtAttach: true, repoCtx: { headSha: NEW_HEAD } });
    expect((await w.repo.execResult("git rev-parse HEAD")).stdout.trim()).toBe(NEW_HEAD);
    expect(await w.repo.readFile("source.txt")).toBe("after\n");
  });

  it("confirms the old head and advances the acknowledged nested checkout before re-review", async () => {
    const w = await workspace();
    const result = await settleReviewedHead(w.input);
    expect(result).toMatchObject({ reviewHead: NEW_HEAD, observedHead: NEW_HEAD, verdict: { head: NEW_HEAD } });
    expect(w.followUp).toHaveBeenCalledTimes(1);
    expect(await w.repo.readFile("source.txt")).toBe("after\n");
  });
  it.each(["source.txt", "private.txt"])(
    "preserves literal HEAD and private %s bytes when work is dirty or untracked",
    async (path) => {
      const w = await workspace();
      await w.repo.writeFile(path, "private bytes\n");
      await expect(settleReviewedHead(w.input)).rejects.toThrow("workspace advance preserves changed private files");
      expect((await w.repo.execResult("git rev-parse HEAD")).stdout.trim()).toBe(OLD_HEAD);
      expect(await w.repo.readFile(path)).toBe("private bytes\n");
      expect(w.followUp).not.toHaveBeenCalled();
    },
  );
  it.each(["", "relative", "/tmp/unsafe\npath", "/tmp/unsafe\0path"])(
    "refuses a malformed supplied binding without changing the literal old checkout: %s",
    async (checkout) => {
      const w = await workspace();
      w.input.checkout = () => checkout;
      await w.repo.writeFile("private.txt", "held bytes\n");
      await expect(settleReviewedHead(w.input)).rejects.toThrow("workspace checkout binding is invalid");
      expect((await w.repo.execResult("git rev-parse HEAD")).stdout.trim()).toBe(OLD_HEAD);
      expect(await w.repo.readFile("private.txt")).toBe("held bytes\n");
    },
  );
  it("does not guess a missing non-root binding or reset the known old checkout", async () => {
    const w = await workspace();
    const missing: SettleReviewedHeadInput = { ...w.input };
    delete missing.checkout;
    await expect(settleReviewedHead(missing)).rejects.toThrow("workspace advance command did not complete");
    expect((await w.repo.execResult("git rev-parse HEAD")).stdout.trim()).toBe(OLD_HEAD);
    expect(await w.repo.readFile("source.txt")).toBe("before\n");
  });
  it("a stop preserves the literal old HEAD and source instead of starting a re-review", async () => {
    const w = await workspace();
    w.input.turn.control.requestStop("hard");
    await settleReviewedHead(w.input);
    expect((await w.repo.execResult("git rev-parse HEAD")).stdout.trim()).toBe(OLD_HEAD);
    expect(await w.repo.readFile("source.txt")).toBe("before\n");
    expect(w.followUp).not.toHaveBeenCalled();
  });
  it("holds a truncated fetch outcome without changing the literal old source", async () => {
    const w = await workspace(async (command, result) =>
      command.includes(" fetch origin ") ? { ...result, truncated: true } : result,
    );
    await expect(settleReviewedHead(w.input)).rejects.toThrow("workspace advance command did not complete");
    expect((await w.repo.execResult("git rev-parse HEAD")).stdout.trim()).toBe(OLD_HEAD);
    expect(await w.repo.readFile("source.txt")).toBe("before\n");
  });
  it("refuses a concurrent HEAD change and does not undo the acknowledged external source", async () => {
    const w = await workspace(async (command, result, repo) => {
      if (command.includes(" fetch origin "))
        expect((await repo.execResult(`git checkout --detach ${NEW_HEAD}`)).exitCode).toBe(0);
      return result;
    });
    await expect(settleReviewedHead(w.input)).rejects.toThrow("workspace changed while its advance was prepared");
    expect((await w.repo.execResult("git rev-parse HEAD")).stdout.trim()).toBe(NEW_HEAD);
    expect(await w.repo.readFile("source.txt")).toBe("after\n");
  });
  it("preserves ignored private bytes during a confirmed move to the literal new review head", async () => {
    const w = await workspace();
    await w.repo.writeFile(".git/info/exclude", "private.txt\n");
    await w.repo.writeFile("private.txt", "ignored private bytes\n");
    expect(await settleReviewedHead(w.input)).toMatchObject({
      reviewHead: NEW_HEAD,
      observedHead: NEW_HEAD,
      verdict: { head: NEW_HEAD },
    });
    expect(await w.repo.readFile("private.txt")).toBe("ignored private bytes\n");
    expect(await w.repo.readFile("source.txt")).toBe("after\n");
  });
  it("holds an unavailable acknowledged binding rather than falling back to transport cwd", async () => {
    const w = await workspace();
    w.input.checkout = () => undefined;
    await expect(settleReviewedHead(w.input)).rejects.toThrow("review checkout binding is unavailable");
    expect((await w.repo.execResult("git rev-parse HEAD")).stdout.trim()).toBe(OLD_HEAD);
    expect(await w.repo.readFile("source.txt")).toBe("before\n");
  });
  it("reads the acknowledged checkout rather than losing the observed head in the transport root", async () => {
    const w = await workspace();
    w.input.verdict = undefined;
    w.input.fetchPrHead = async () => w.old;
    expect(await settleReviewedHead(w.input)).toMatchObject({ observedHead: OLD_HEAD, reviewHead: OLD_HEAD });
    expect(w.followUp).not.toHaveBeenCalled();
  });
});
