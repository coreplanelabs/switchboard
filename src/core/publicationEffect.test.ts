import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../execution/executor.js";
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

function effect(
  options: {
    failPush?: boolean;
    failFirstPush?: boolean;
    wrongRemote?: boolean;
    unbound?: boolean;
    newBranch?: boolean;
    dirty?: boolean;
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
  const executor: Executor = {
    exec: vi.fn(async (command) => {
      commands.push({ command });
      if (command === "git symbolic-ref --quiet --short HEAD") return branch;
      if (command === "git status --porcelain -uno") return options.dirty ? " M src/a.ts" : "";
      if (command.startsWith("git check-ref-format")) return branch;
      if (command.startsWith("git rev-parse --verify")) return next;
      if (command === "git remote get-url origin")
        return options.wrongRemote ? "https://other.example/o/r" : "https://door.example/git/o/r.git";
      if (command.startsWith("git ls-remote")) return `${next}\t${source}`;
      return "exit 1: unexpected command";
    }),
    publishBranch: vi.fn(async (input) => {
      publications.push(input);
      // An opaque shell using the model's bearer cannot borrow the effect's
      // pending grant even with the same source/destination and old head.
      const request = options.newBranch ? { ...update, old: "0".repeat(40) } : update;
      expect(bindings.takeToolPush("run", request, bearerHashOf(modelToken))).toBe(false);
      expect(bindings.takeToolPush("run", request, bearerHashOf(input.bearer))).toBe(true);
      pushAttempts++;
      if (options.failPush || (options.failFirstPush && pushAttempts === 1)) return "exit 1: remote rejected";
      if (!options.unbound) {
        const claim = options.newBranch
          ? await bindings.beginBranch("run", request)
          : await bindings.beginPublication("run", request);
        expect(await claim?.finish("accepted")).toBe(true);
      }
      return options.newBranch
        ? `To https://door.example/git/o/r.git\n * [new branch]      ${next.slice(0, 7)} -> ${branch}`
        : `To https://door.example/git/o/r.git\n + ${old.slice(0, 7)}...${next.slice(0, 7)} ${branch} -> ${branch} (forced update)`;
    }),
    readFile: async () => "",
    writeFile: async () => "",
  };
  const tool = publicationEffectTool({
    runId: "run",
    repo: "o/r",
    doorUrl: "https://door.example",
    branch,
    protectedBranches: ["main"],
    bindings,
    bearers: { issue: () => ({ token, expiresAt: 100 }) } as unknown as RunBearerStore,
  });
  const published: unknown[] = [];
  const run = (name: string) =>
    tool.run({ branch: name }, { executor, callId: "owned-call", publish: (event) => void published.push(event) });
  return { bindings, commands, publications, published, run };
}

describe("publish_branch — a runner-owned Git Door effect", () => {
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
});
