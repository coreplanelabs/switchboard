import { describe, expect, it, vi } from "vitest";
import { inspectLiveCredentials } from "./credentialInspection.js";
import { HarnessRegistry, type LiveHarness } from "./harness/pi/relay.js";
import { emptyCredentialInspection } from "../execution/credentialInspection.js";

const expected = { backend: "resident" as const, repo: "example/repo", ref: "canary/test", head: "a".repeat(40) };
function setup() {
  const inspectCredentials = vi.fn(
    async (_input: import("../execution/credentialInspection.js").CredentialInspectionInput) => ({
      ...emptyCredentialInspection(),
      completed: true,
      bindingMatched: true,
      commandEnvironments: 1,
      harnessEnvironments: 1,
      filesChecked: 4,
      helperEntries: 2,
      unknownCount: 0,
    }),
  );
  const registry = new HarnessRegistry();
  const live = {
    runId: "run-one",
    backend: "resident",
    credentialInspectionProcess: () => ({ pid: 42, processBirth: "11111111-1111-1111-1111-111111111111:123" }),
    rules: { identity: "write", checkout: "/workspace/repo", branch: expected.ref },
    toolContext: { executor: { inspectCredentials }, signal: new AbortController().signal },
  } as unknown as LiveHarness;
  registry.register(live);
  return { registry, live, inspectCredentials };
}

describe("live credential inspection", () => {
  it("uses only the selected live harness executor and its trusted process id", async () => {
    const { registry, inspectCredentials } = setup();
    const result = await inspectLiveCredentials(registry, "run-one", expected);
    expect(result.completed).toBe(true);
    expect(inspectCredentials).toHaveBeenCalledOnce();
    expect(inspectCredentials.mock.calls[0]?.[0]).toMatchObject({
      runId: "run-one",
      pid: 42,
      processBirth: "11111111-1111-1111-1111-111111111111:123",
      ref: expected.ref,
      head: expected.head,
    });
  });

  it("refuses absent, unsupported, mismatched or stopped runs before executing", async () => {
    const { registry, live, inspectCredentials } = setup();
    expect((await inspectLiveCredentials(registry, "missing", expected)).completed).toBe(false);
    live.backend = "local";
    expect((await inspectLiveCredentials(registry, "run-one", expected)).completed).toBe(false);
    live.backend = "resident";
    live.rules.branch = "foreign";
    expect((await inspectLiveCredentials(registry, "run-one", expected)).completed).toBe(false);
    live.rules.branch = expected.ref;
    live.toolContext.signal = AbortSignal.abort();
    expect((await inspectLiveCredentials(registry, "run-one", expected)).completed).toBe(false);
    expect(inspectCredentials).not.toHaveBeenCalled();
  });

  it("discards a result when the live registration or process changes", async () => {
    const { registry, live, inspectCredentials } = setup();
    inspectCredentials.mockImplementationOnce(async () => {
      registry.replace({ ...live });
      return { ...emptyCredentialInspection(), completed: true };
    });
    expect((await inspectLiveCredentials(registry, "run-one", expected)).completed).toBe(false);
    inspectCredentials.mockImplementationOnce(async () => {
      registry.get("run-one")!.credentialInspectionProcess = () => ({
        pid: 43,
        processBirth: "11111111-1111-1111-1111-111111111111:123",
      });
      return { ...emptyCredentialInspection(), completed: true };
    });
    expect((await inspectLiveCredentials(registry, "run-one", expected)).completed).toBe(false);
  });

  it("refuses missing launch identity and discards a complete receipt after birth identity changes", async () => {
    const { registry, live, inspectCredentials } = setup();
    const complete = await inspectLiveCredentials(registry, "run-one", expected);
    const original = live.credentialInspectionProcess;
    live.credentialInspectionProcess = () => undefined;
    inspectCredentials.mockClear();
    expect(await inspectLiveCredentials(registry, "run-one", expected)).toEqual(emptyCredentialInspection());
    expect(inspectCredentials).not.toHaveBeenCalled();
    live.credentialInspectionProcess = original;
    inspectCredentials.mockImplementationOnce(async () => {
      live.credentialInspectionProcess = () => ({ pid: 42, processBirth: "11111111-1111-1111-1111-111111111111:124" });
      return complete;
    });
    expect(await inspectLiveCredentials(registry, "run-one", expected)).toEqual(emptyCredentialInspection());
  });

  it("drops raw exceptions and undeclared executor output", async () => {
    const { registry, inspectCredentials } = setup();
    const planted = "synthetic-secret-must-stay-private";
    inspectCredentials.mockRejectedValueOnce(new Error(planted));
    const result = await inspectLiveCredentials(registry, "run-one", expected);
    expect(result.completed).toBe(false);
    expect(JSON.stringify(result)).not.toContain(planted);
    inspectCredentials.mockResolvedValueOnce({
      ...emptyCredentialInspection(),
      completed: true,
      extra: planted,
    } as never);
    expect((await inspectLiveCredentials(registry, "run-one", expected)).completed).toBe(false);
  });
});
