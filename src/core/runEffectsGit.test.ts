import { describe, expect, it } from "vitest";
import type { Executor } from "../execution/executor.js";
import { ProductionRunEffects, type EffectEnvelope, type EffectResult } from "./runEffects.js";
import { gitRunEffectsDeps } from "./runEffectsGit.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const TREE_A = "1".repeat(40);
const TREE_C = "3".repeat(40);

function gitWorld() {
  const commands: string[] = [];
  const results: EffectResult[] = [];
  let head = A;
  let tree = TREE_A;
  let remote = B;
  const executor: Executor = {
    async exec(command) {
      commands.push(command);
      if (command === "git remote get-url --push origin") return "https://github.com/acme/api.git\n";
      if (command === "git symbolic-ref --quiet --short HEAD") return "feat/exact-tree\n";
      if (command === "git rev-parse HEAD") return `${head}\n`;
      if (command === "git rev-parse 'HEAD^{tree}'") return `${tree}\n`;
      if (command === "git status --porcelain") return "";
      if (command.startsWith("git ls-remote")) return remote ? `${remote}\trefs/heads/feat/exact-tree\n` : "exit 2:\n";
      if (command === "git fetch origin 'main'") return "";
      if (command === "git rebase 'origin/main'") {
        head = C;
        tree = TREE_C;
        return "Successfully rebased\n";
      }
      if (command === "pytest -q tests/changed") return "passed\n";
      if (command === "pnpm -C packages/api test:changed") return "passed\n";
      if (command.startsWith("git push ")) return "exit 1:\nchild git has no publication credential";
      return `exit 1:\nunexpected command: ${command}`;
    },
    async publishGit(request) {
      commands.push(`runner publish ${request.source}:${request.destination}`);
      remote = request.source;
      return { previous: request.lease, published: request.source };
    },
    async readFile() {
      throw new Error("the declared gates do not inspect a root package.json");
    },
    async writeFile() {
      return "";
    },
  };
  const deps = gitRunEffectsDeps({
    executor,
    actor: "chat:user",
    admittedRepository: "acme/api",
    admittedBranch: "feat/exact-tree",
    admittedBase: "main",
    changedSetGates: [
      { name: "python changed tests", command: "pytest -q tests/changed" },
      { name: "api workspace tests", command: "pnpm -C packages/api test:changed" },
    ],
    authorize: () => true,
    persistEnvelope: async (value) => value,
    priorResult: async () => undefined,
    recordResult: async (result) => void results.push(result),
    occurredAt: () => 1,
  });
  return { commands, results, executor, deps };
}

const envelope: EffectEnvelope = {
  effectId: "effect-git-1",
  command: {
    kind: "push",
    repository: "acme/api",
    branch: "feat/exact-tree",
    expectedHead: A,
    base: "main",
    gateSet: "changed-set",
  },
};

describe("gitRunEffectsDeps — production exact-tree publication", () => {
  it("rebases before the repository-declared changed-set gates, then lease-pushes the gated commit and reconciles it", async () => {
    const world = gitWorld();
    const result = await new ProductionRunEffects(world.deps).execute(envelope);
    expect(result).toMatchObject({ outcome: "succeeded", before: B, after: C, tree: TREE_C, by: "runner" });
    const fetch = world.commands.indexOf("git fetch origin 'main'");
    const rebase = world.commands.indexOf("git rebase 'origin/main'");
    const python = world.commands.indexOf("pytest -q tests/changed");
    const workspace = world.commands.indexOf("pnpm -C packages/api test:changed");
    const push = world.commands.findIndex((command) => command.startsWith("runner publish "));
    expect(fetch).toBeGreaterThanOrEqual(0);
    expect(fetch).toBeLessThan(rebase);
    expect(rebase).toBeLessThan(python);
    expect(python).toBeLessThan(workspace);
    expect(workspace).toBeLessThan(push);
    expect(world.commands.some((command) => command.includes("vitest") || command.includes("tsconfig"))).toBe(false);
    expect(world.commands[push]).toBe(`runner publish ${C}:refs/heads/feat/exact-tree`);
    expect(world.commands.some((command) => command.startsWith("git push "))).toBe(false);
  });

  it("fails closed when no repository-declared changed-set gate is available", async () => {
    const world = gitWorld();
    const deps = gitRunEffectsDeps({
      executor: world.executor,
      actor: "chat:user",
      admittedRepository: "acme/api",
      admittedBranch: "feat/exact-tree",
      admittedBase: "main",
      authorize: () => true,
      persistEnvelope: async (value) => value,
      priorResult: async () => undefined,
      recordResult: async () => {},
      occurredAt: () => 1,
    });
    const result = await new ProductionRunEffects(deps).execute(envelope);
    expect(result).toMatchObject({ outcome: "refused", reason: "gate_failed" });
    expect(world.commands).toContain("false");
    expect(world.commands.some((command) => command.includes("vitest") || command.includes("tsconfig"))).toBe(false);
  });

  it("refuses a command for another branch before fetch, gates or transport", async () => {
    const world = gitWorld();
    const result = await new ProductionRunEffects(world.deps).execute({
      ...envelope,
      command: { ...envelope.command, branch: "main" },
    });
    expect(result).toMatchObject({ outcome: "refused", reason: "wrong_ref" });
    expect(world.commands).not.toContain("git fetch origin 'main'");
    expect(world.commands.some((command) => command.startsWith("runner publish "))).toBe(false);
  });

  it("allows a default-bound run to publish the validated branch it created, while keeping named bindings strict", async () => {
    const world = gitWorld();
    const defaultBound = gitRunEffectsDeps({
      executor: world.executor,
      actor: "chat:user",
      admittedRepository: "acme/api",
      admittedBase: "main",
      changedSetGates: [{ name: "python changed tests", command: "pytest -q tests/changed" }],
      authorize: () => true,
      persistEnvelope: async (value) => value,
      priorResult: async () => undefined,
      recordResult: async () => {},
      auditResult: async () => {},
      occurredAt: () => 1,
    });
    const result = await new ProductionRunEffects(defaultBound).execute(envelope);
    expect(result).toMatchObject({ outcome: "succeeded", destination: "refs/heads/feat/exact-tree" });

    const protectedWorld = gitWorld();
    const protectedResult = await new ProductionRunEffects(
      gitRunEffectsDeps({
        executor: protectedWorld.executor,
        actor: "chat:user",
        admittedRepository: "acme/api",
        admittedBase: "main",
        changedSetGates: [{ name: "python changed tests", command: "pytest -q tests/changed" }],
        authorize: () => true,
        persistEnvelope: async (value) => value,
        priorResult: async () => undefined,
        recordResult: async () => {},
        auditResult: async () => {},
        occurredAt: () => 1,
      }),
    ).execute({ ...envelope, command: { ...envelope.command, branch: "main" } });
    expect(protectedResult).toMatchObject({ outcome: "refused", reason: "wrong_ref" });
    expect(protectedWorld.commands.some((command) => command.startsWith("runner publish "))).toBe(false);
  });
});
