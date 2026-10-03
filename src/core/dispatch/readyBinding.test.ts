import { describe, expect, it, vi } from "vitest";
import { LocalExecutor } from "../../execution/executor.js";
import type { ExecutorSelection, WorkspaceBinding } from "../../execution/factory.js";
import { commitResumedPilotBinding, resumedPilotBindingFor } from "./readyBinding.js";

describe("resumed pilot binding commit", () => {
  const original: WorkspaceBinding = {
    backend: "sandbox",
    workspace: "/workspace/checkout",
    container: "33333333-3333-3333-3333-333333333333",
    sandboxKey: "run:11111111-1111-1111-1111-111111111111",
    publicationBaseSha: "a".repeat(40),
    seeded: {
      slug: "acme/widgets",
      ref: "plan/p/u1",
      workspace: "/workspace/checkout",
      sourceSha: "b".repeat(40),
      depsBackupId: "deps-archive",
    },
  };
  const selection: ExecutorSelection = {
    executor: new LocalExecutor("/tmp/ready-binding-test"),
    backend: "sandbox",
    seeded: {
      ...original.seeded!,
      sha: "c".repeat(40),
      sourceSha: "c".repeat(40),
      cached: true,
      ms: 0,
    },
  };

  it("awaits an acknowledged owner-fenced dependency-source binding before continuation", async () => {
    let acknowledge!: (result: "ok") => void;
    const committed = new Promise<"ok">((resolve) => {
      acknowledge = resolve;
    });
    const commitState = vi.fn(() => committed);
    const pending = commitResumedPilotBinding({ commitState }, selection, "repo-resident", original);
    let continued = false;
    void pending.then(() => {
      continued = true;
    });
    await Promise.resolve();
    expect(continued).toBe(false);
    expect(commitState).toHaveBeenCalledWith({
      binding: {
        ...original,
        seeded: { ...original.seeded, sourceSha: "c".repeat(40) },
      },
    });
    acknowledge("ok");
    expect(await pending).toBe(true);
    expect(continued).toBe(true);
  });

  it.each(["fenced", "unavailable"] as const)("does not continue when the binding commit is %s", async (result) => {
    const commitState = vi.fn(async () => result);
    expect(await commitResumedPilotBinding({ commitState }, selection, "repo-resident", original)).toBe(false);
    expect(original.seeded?.sourceSha).toBe("b".repeat(40));
  });

  it("does not continue when the run has no tracked ledger write", async () => {
    expect(await commitResumedPilotBinding(undefined, selection, "repo-resident", original)).toBe(false);
  });

  it("keeps the recorded sandbox owner across repeated reattachments", () => {
    const first = resumedPilotBindingFor(selection, "repo-resident", original);
    expect(first).toMatchObject({ container: original.container, sandboxKey: original.sandboxKey });
    const second = resumedPilotBindingFor(selection, "repo-resident", first!);
    expect(second).toMatchObject({ container: original.container, sandboxKey: original.sandboxKey });
  });
});
