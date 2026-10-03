import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENTS } from "../agents/registry.js";
import { declaredProfile } from "../config/profile.js";
import {
  makeExecutor,
  resetResidentProbeCache,
  seedOwnerClaim,
  workspaceBindingFor,
  workspaceBindingOf,
} from "./factory.js";
import type { SandboxSeed } from "./seedPlan.js";

const run = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const checkoutBackupId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const container = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
const sha = "a".repeat(40);
const seed: SandboxSeed = {
  slug: "acme/repo",
  ref: "main",
  sha,
  fetchRef: "feature/provenance",
  fetchSha: sha,
  checkoutBackupId,
};
const context = {
  runId: run,
  requester: "slack:Uactor",
  threadKey: "slack:C1:1.0",
  repo: "acme/repo",
  ref: "feature/provenance",
  headSha: sha,
};

function replies(receipt: unknown = container, seedStatus = 200) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/exec") return new Response(JSON.stringify({ exitCode: 0 }));
      bodies.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
      if (path === "/status")
        return new Response(
          JSON.stringify({
            state: "degraded",
            reason: "disk-pressure",
            snapshot: {
              ref: "main",
              sha,
              checkoutBackupId,
              mirrorBackupId: "11111111-1111-1111-1111-111111111111",
              lockfileHash: "l",
              createdAt: "t",
            },
          }),
        );
      if (path === "/seed" && seedStatus !== 200)
        return new Response(JSON.stringify({ error: "unknown route" }), { status: seedStatus });
      if (path === "/seed")
        return new Response(
          JSON.stringify({
            seeded: true,
            cached: false,
            slug: seed.slug,
            ref: seed.fetchRef,
            sha,
            from: { ref: seed.ref, sha, checkoutBackupId },
            steps: { restore: 1, deps: null, fixup: 1 },
            ms: 2,
            ...(receipt === null ? {} : { preservationContainer: receipt }),
          }),
        );
      throw new Error(`unexpected route ${path}`);
    }),
  );
  return bodies;
}

async function select(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "swb-seed-owner-"));
  return makeExecutor(
    {
      execution: {
        type: "cloudflare",
        url: "https://sandbox.example",
        resident: { baseUrl: "https://resident.example" },
      },
      workspaceDir: join(dir, "workspaces"),
      dataDir: join(dir, "data"),
      githubCredentials: { assertProfileIdentity: () => {} },
    },
    {
      ...context,
      agent: AGENTS.coding,
      profile: declaredProfile(AGENTS.coding),
      githubDoor: { baseUrl: "https://door.example", bearer: "sbr_test.secret" },
      ...overrides,
    },
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetResidentProbeCache();
});

describe("initial sandbox seed owner provenance", () => {
  it("forms the claim only from resolved run context and the exact checkout backup, never the model or dependency archive", () => {
    expect(seedOwnerClaim(context, seed)).toEqual({
      run,
      requester: context.requester,
      thread: context.threadKey,
      repository: seed.slug,
      ref: seed.fetchRef,
      head: sha,
      seed: checkoutBackupId,
    });
    expect(seedOwnerClaim(context, { ...seed, checkoutBackupId: container })?.seed).toBe(container);
    expect(
      seedOwnerClaim({ ...context, ref: "feature/fix+retry" }, { ...seed, fetchRef: "feature/fix+retry" })?.ref,
    ).toBe("feature/fix+retry");
    expect(seedOwnerClaim({ ...context, headSha: undefined }, seed)).toBeUndefined();
    expect(seedOwnerClaim({ ...context, runId: undefined }, seed)).toBeUndefined();
  });

  it("refuses conflicting or malformed context rather than minting an owner with wrong fields", () => {
    for (const wrong of [
      { repo: "other/repo" },
      { ref: "another/ref" },
      { headSha: "not-a-sha" },
      { runId: "not-a-uuid" },
      { requester: "invalid" },
      { threadKey: "invalid" },
    ])
      expect(() => seedOwnerClaim({ ...context, ...wrong }, seed)).toThrow(/seed owner/);
  });

  it("posts the trusted claim and records the Worker container on the seeded selection and durable binding", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    const bodies = replies();
    const selected = await select();
    expect(bodies[1]?.preservation).toEqual(seedOwnerClaim(context, seed));
    expect(selected.seeded?.preservationContainer).toBe(container);
    expect(workspaceBindingFor(selected)?.container).toBe(container);
    expect(workspaceBindingOf(workspaceBindingFor(selected))?.container).toBe(container);
  });

  it("refuses a claimed seed with missing or malformed container before recording a binding or falling cold", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    for (const receipt of [null, "wrong", 42]) {
      replies(receipt);
      await expect(select()).rejects.toThrow(/preservation|seed owner/);
      resetResidentProbeCache();
    }
  });

  it("refuses a claimed seed when an older Worker has no /seed instead of falling cold", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    const bodies = replies(container, 404);
    await expect(select()).rejects.toThrow(/seed|unknown route|404/i);
    expect(bodies.some((body) => "seed" in body)).toBe(true);
  });

  it("keeps an unclaimed legacy seed working without a preservation receipt", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    const bodies = replies(null);
    const selected = await select({ runId: undefined });
    expect(bodies[1]?.preservation).toBeUndefined();
    expect(selected.seeded?.preservationContainer).toBeUndefined();
    expect(workspaceBindingFor(selected)?.container).toBeUndefined();
  });
});
