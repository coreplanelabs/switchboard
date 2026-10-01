import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareSandboxExecutor } from "./cloudflareSandbox.js";
import { ResidentExecutor } from "./resident.js";
import { TracingExecutor } from "./tracingExecutor.js";
import { emptyCredentialInspection } from "./credentialInspection.js";
import { createTracer } from "../core/trace/tracer.js";
import { recordingSink } from "../core/testing/recordingSink.js";

const input = {
  runId: "run-one",
  pid: 42,
  processBirth: "11111111-1111-1111-1111-111111111111:123",
  repo: "example/repo",
  ref: "canary/test",
  head: "a".repeat(40),
};
afterEach(() => vi.unstubAllGlobals());
describe("remote credential inspection", () => {
  it("sends once on resident without refresh, reattach or raw error tracing", async () => {
    const resolveEnvs = vi.fn(async () => ({ GH_ENTERPRISE_TOKEN: "synthetic-run-credential" }));
    const execute = new ResidentExecutor({
      baseUrl: "https://resident.example",
      token: "synthetic-operator",
      resource: "repo:example/repo",
      threadKey: "thread",
      resolveEnvs,
    });
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "synthetic-private-error", needs: "attach" }), { status: 400 }),
    );
    vi.stubGlobal("fetch", fetch);
    const log = recordingSink();
    const span = createTracer({ clock: () => 1 }).start("inspection", { sinks: [log] });
    const wrapped = new TracingExecutor(execute, span);
    expect(await wrapped.inspectCredentials!(input)).toEqual(emptyCredentialInspection());
    span.end("ok");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toMatch(/\/inspect-credentials$/);
    const body = JSON.parse(String(init.body));
    expect(body.env).toEqual({ GH_ENTERPRISE_TOKEN: "synthetic-run-credential" });
    expect(body).not.toHaveProperty("command");
    expect(body.input).toMatchObject(input);
    expect(JSON.stringify(log)).not.toContain("synthetic-private-error");
  });
  it("refuses cold inspection before a root-controlled runtime can forge the receipt", async () => {
    const forged = {
      ...emptyCredentialInspection(),
      completed: true,
      bindingMatched: true,
      commandEnvironments: 1,
      harnessEnvironments: 1,
      filesChecked: 5,
      helperEntries: 2,
      unknownCount: 0,
    };
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ stdout: JSON.stringify(forged), stderr: "", exitCode: 0, truncated: false })),
    );
    vi.stubGlobal("fetch", fetch);
    const resolveEnvs = vi.fn(async () => ({}));
    const cold = new CloudflareSandboxExecutor({
      url: "https://sandbox.example",
      token: "synthetic-operator",
      threadKey: "thread",
      resolveEnvs,
      scrubLegacyCredentials: true,
    });
    expect(await cold.inspectCredentials(input)).toEqual(emptyCredentialInspection());
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveEnvs).not.toHaveBeenCalled();
  });
});
