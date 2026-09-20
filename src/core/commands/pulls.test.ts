import { describe, expect, it } from "vitest";
import { CommandRegistry, renderText } from "../commandRegistry.js";
import type { PullSweepService, SweepReport } from "../pullSweep.js";
import { callerWith } from "../testing/callers.js";
import { parsePullReference, pullsCommands, registerPullsCommands, type PullsCommandDeps } from "./pulls.js";

// Feature: docs/reference/specs/agent-ship.md item 20 — `pulls rebase` is the
// sweep a person runs: one named pull request or every open one the pipeline
// owns, answered as one line per pull request in user words, on every surface
// the registry serves.

const REPORT: SweepReport = {
  repo: "acme/api",
  results: [
    { repo: "acme/api", number: 7, outcome: "carried", line: "#7 rebased, patch unchanged, approval carried" },
    { repo: "acme/api", number: 9, outcome: "skipped", line: "#9 skipped, already current" },
  ],
};

function setup(service?: PullSweepService) {
  const asked: { repo: string; number?: number }[] = [];
  const sweep: PullSweepService = service ?? {
    sweep: async (target) => {
      asked.push(target);
      return REPORT;
    },
  };
  const registry = new CommandRegistry<PullsCommandDeps>({ audit: () => {} });
  registerPullsCommands(registry);
  const deps: PullsCommandDeps = { pulls: { service: async () => sweep } };
  return { registry, deps, asked };
}

const CALLER = callerWith("cli", "cli:local", "all");

describe("parsePullReference", () => {
  it("takes a number, #N, owner/name#N and a GitHub URL", () => {
    expect(parsePullReference("4")).toEqual({ number: 4 });
    expect(parsePullReference("#4")).toEqual({ number: 4 });
    expect(parsePullReference("acme/api#4")).toEqual({ repo: "acme/api", number: 4 });
    expect(parsePullReference("https://github.com/acme/api/pull/4")).toEqual({ repo: "acme/api", number: 4 });
  });
});

describe("pulls rebase — the sweep command", () => {
  it("registers one write under pulls:write, gated on the github capability, destructive with a risk line", () => {
    expect(pullsCommands.map((c) => c.id)).toEqual(["pulls.rebase"]);
    const def = pullsCommands[0]!;
    expect(def).toMatchObject({ action: "pulls:write", effect: "write" });
    expect(def.enabledWhen?.({ github: true } as never)).toBe(true);
    expect(def.enabledWhen?.({ github: false } as never)).toBe(false);
    expect(def.annotations?.destructive).toBe(true);
    expect(typeof def.annotations?.risk).toBe("function");
    expect(def.annotations!.risk!({ args: [], options: {} })).toMatch(/every open pull request/);
    expect(def.annotations!.risk!({ args: ["acme/api#4"], options: {} })).toMatch(/pull request acme\/api#4/);
  });

  it("sweeps the named repository whole and renders one line per pull request", async () => {
    const { registry, deps, asked } = setup();
    const res = await registry.invoke("pulls.rebase", { options: { repo: "acme/api" } }, CALLER, deps);
    expect(res.ok).toBe(true);
    expect(asked).toEqual([{ repo: "acme/api" }]);
    const text = renderText(pullsCommands[0]!, (res as { ok: true; value: unknown }).value as never);
    expect(text).toBe(
      [
        "Swept acme/api: 2 pull requests",
        "#7 rebased, patch unchanged, approval carried",
        "#9 skipped, already current",
      ].join("\n"),
    );
  });

  it("a full pull request reference names the repository and the number by itself", async () => {
    const { registry, deps, asked } = setup();
    const res = await registry.invoke("pulls.rebase", { args: ["acme/api#4"], options: {} }, CALLER, deps);
    expect(res.ok).toBe(true);
    expect(asked).toEqual([{ repo: "acme/api", number: 4 }]);
  });

  it("a bare number takes the repository from the thread's binding", async () => {
    const { registry, deps, asked } = setup();
    const caller = {
      ...CALLER,
      origin: { channelId: "slack:C1", threadKey: "slack:C1:1.0", repo: async () => "acme/api" },
    };
    const res = await registry.invoke("pulls.rebase", { args: ["#7"], options: {} }, caller, deps);
    expect(res.ok).toBe(true);
    expect(asked).toEqual([{ repo: "acme/api", number: 7 }]);
  });

  it("without a repository anywhere the refusal says how to name one", async () => {
    const { registry, deps } = setup();
    const res = await registry.invoke("pulls.rebase", { args: ["7"], options: {} }, CALLER, deps);
    expect(res).toMatchObject({ ok: false, error: "invalid_input" });
    expect((res as { message?: string }).message).toMatch(/--repo owner\/name/);
  });

  it("without a wired sweep service the command answers unavailable, not a crash", async () => {
    const registry = new CommandRegistry<PullsCommandDeps>({ audit: () => {} });
    registerPullsCommands(registry);
    const res = await registry.invoke("pulls.rebase", { options: { repo: "acme/api" } }, CALLER, {});
    expect(res).toMatchObject({ ok: false, error: "unavailable" });
    expect((res as { message?: string }).message).toMatch(/no sweep service is wired/);
  });

  it("a service failure is unavailable with the reason, never a thrown error", async () => {
    const { registry, deps } = setup({
      sweep: async () => {
        throw new Error("GitHub GET pulls failed: HTTP 502");
      },
    });
    const res = await registry.invoke("pulls.rebase", { options: { repo: "acme/api" } }, CALLER, deps);
    expect(res).toMatchObject({ ok: false, error: "unavailable" });
    expect((res as { message?: string }).message).toMatch(/HTTP 502/);
  });
});
