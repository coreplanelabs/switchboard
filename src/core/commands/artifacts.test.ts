import { describe, expect, it } from "vitest";
import type { ArtifactsConfig } from "../../artifacts/config.js";
import { lifecycleRulesFor, type ArtifactsBucketIO, type LifecycleRule } from "../../deploy/artifactsBucket.js";
import { CommandRegistry, bindCommands, renderText, type Caller } from "../commandRegistry.js";
import { callerWith } from "../testing/callers.js";
import {
  artifactsCheck,
  artifactsLifecycle,
  registerArtifactsCommands,
  type ArtifactsCommandDeps,
} from "./artifacts.js";

// Feature: docs/reference/specs/execution.md item 20 (record 0033) — the operator's
// bucket commands: `artifacts lifecycle` applies the config's retention as the
// bucket's rules and reads them back, `artifacts check` reports whether the
// bucket is private; both refuse by name without an `artifacts:` section and
// never leave the CLI.

const cli: Caller = callerWith("cli", "cli:local", "all");
const admin: Caller = callerWith("chat", "slack:UADMIN", "all");
const mcp = (...actions: string[]): Caller => callerWith("mcp", "mcp:alice", actions);

const CONFIG: ArtifactsConfig = { r2: { accountId: "acct-1", bucket: "switchboard-artifacts" }, retentionDays: 14 };

/** A Cloudflare double: records every call, stores what was put, answers the domain reads by
 *  script. A test that needs one call to fail spreads its own method over `io`. */
function bucketDouble(
  over: {
    managed?: { domain: string; enabled: boolean };
    custom?: Array<{ domain: string; enabled: boolean }>;
  } = {},
) {
  const calls: string[] = [];
  let stored: LifecycleRule[] | undefined;
  const io: ArtifactsBucketIO = {
    putLifecycle: async (account, bucket, rules) => {
      calls.push(`put ${account}/${bucket} ${rules.map((r) => r.id).join(",")}`);
      stored = [...rules];
      return { ok: true, value: undefined };
    },
    getLifecycle: async (account, bucket) => {
      calls.push(`get ${account}/${bucket}`);
      return { ok: true, value: { rules: stored ?? [] } };
    },
    managedDomain: async (account, bucket) => {
      calls.push(`managed ${account}/${bucket}`);
      return { ok: true, value: over.managed ?? { domain: "pub-abc.r2.dev", enabled: false } };
    },
    customDomains: async (account, bucket) => {
      calls.push(`custom ${account}/${bucket}`);
      return { ok: true, value: over.custom ?? [] };
    },
  };
  return { io, calls, stored: () => stored };
}

function bind(config: ArtifactsConfig | undefined, bucket: ArtifactsBucketIO) {
  const registry = new CommandRegistry<ArtifactsCommandDeps>({ audit: () => {} });
  registerArtifactsCommands(registry);
  const deps: ArtifactsCommandDeps = { artifacts: { config: async () => config, bucket } };
  return bindCommands(registry, deps);
}

describe("artifacts.lifecycle", () => {
  it("is CLI-only, deploy:write, a write — like deploy.restart; hidden from chat and MCP", async () => {
    expect(artifactsLifecycle).toMatchObject({
      action: "deploy:write",
      effect: "write",
      surfaces: { chat: false, mcp: false, http: false },
    });
    const commands = bind(CONFIG, bucketDouble().io);
    expect(await commands.invoke("artifacts.lifecycle", {}, admin)).toMatchObject({ ok: false, error: "not_found" });
    expect(await commands.invoke("artifacts.lifecycle", {}, mcp("deploy:write"))).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("--dry-run prints the two rules with the configured days and touches nothing", async () => {
    const d = bucketDouble();
    const commands = bind(CONFIG, d.io);
    const res = await commands.invoke("artifacts.lifecycle", { options: { dryRun: true } }, cli);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.value).toEqual({
      account: "acct-1",
      bucket: "switchboard-artifacts",
      retentionDays: 14,
      rules: lifecycleRulesFor(14),
      applied: false,
      readBack: false,
    });
    expect(renderText(commands.get("artifacts.lifecycle")!, res.value)).toBe(
      [
        "dry run — would apply 2 lifecycle rule(s) to switchboard-artifacts (account acct-1); nothing touched:",
        "  - switchboard-artifacts-expire: delete every object 14 days after it was written",
        "  - switchboard-artifacts-abort-multipart: abort an incomplete multipart upload after 1 day",
      ].join("\n"),
    );
    expect(d.calls).toEqual([]);
  });

  it("puts the configuration once and reads it back equal; the default retention is 30 days", async () => {
    const d = bucketDouble();
    const commands = bind({ r2: CONFIG.r2 }, d.io);
    const res = await commands.invoke("artifacts.lifecycle", {}, cli);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.value).toMatchObject({ retentionDays: 30, applied: true, readBack: true, rules: lifecycleRulesFor(30) });
    expect(d.calls).toEqual([
      "put acct-1/switchboard-artifacts switchboard-artifacts-expire,switchboard-artifacts-abort-multipart",
      "get acct-1/switchboard-artifacts",
    ]);
    expect(d.stored()).toEqual(lifecycleRulesFor(30));
    expect(renderText(commands.get("artifacts.lifecycle")!, res.value)).toMatch(
      /^applied 2 lifecycle rule\(s\) to switchboard-artifacts \(account acct-1\) and read them back equal:\n {2}- switchboard-artifacts-expire: delete every object 30 days/,
    );
  });

  it("a refused put, a failed read-back and a read-back that differs are each named; nothing claims success", async () => {
    const refused = bind(CONFIG, {
      ...bucketDouble().io,
      putLifecycle: async () => ({ ok: false, problem: "PUT … answered HTTP 403 — the token lacks the permission" }),
    });
    expect(await refused.invoke("artifacts.lifecycle", {}, cli)).toMatchObject({
      ok: false,
      error: "unavailable",
      message: expect.stringMatching(
        /applying the lifecycle rules to switchboard-artifacts failed — PUT … answered HTTP 403/,
      ),
    });
    const unread = bind(CONFIG, {
      ...bucketDouble().io,
      getLifecycle: async () => ({ ok: false, problem: "GET … answered HTTP 502" }),
    });
    expect(await unread.invoke("artifacts.lifecycle", {}, cli)).toMatchObject({
      ok: false,
      error: "unavailable",
      message: expect.stringMatching(
        /this is a bug: the rules were applied .* but their read-back failed \(GET … answered HTTP 502\) and no automatic confirmation was completed/,
      ),
    });
    const differs = bind(CONFIG, {
      ...bucketDouble().io,
      getLifecycle: async () => ({ ok: true, value: { rules: [lifecycleRulesFor(14)[0]] } }),
    });
    expect(await differs.invoke("artifacts.lifecycle", {}, cli)).toMatchObject({
      ok: false,
      error: "unavailable",
      message: expect.stringMatching(/the read-back differs — rule switchboard-artifacts-abort-multipart is missing/),
    });
  });
});

describe("artifacts.check", () => {
  it("is CLI-only, deploy:write, a read; hidden from chat and MCP", async () => {
    expect(artifactsCheck).toMatchObject({
      action: "deploy:write",
      effect: "read",
      surfaces: { chat: false, mcp: false, http: false },
    });
    const commands = bind(CONFIG, bucketDouble().io);
    expect(await commands.invoke("artifacts.check", {}, admin)).toMatchObject({ ok: false, error: "not_found" });
    expect(await commands.invoke("artifacts.check", {}, mcp("deploy:write"))).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("answers private: true for a disabled managed domain and no enabled custom domain", async () => {
    const d = bucketDouble({ custom: [{ domain: "files.example.com", enabled: false }] });
    const commands = bind(CONFIG, d.io);
    const res = await commands.invoke("artifacts.check", {}, cli);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.value).toEqual({
      account: "acct-1",
      bucket: "switchboard-artifacts",
      private: true,
      open: [],
      managedDomain: { domain: "pub-abc.r2.dev", enabled: false },
      customDomains: [{ domain: "files.example.com", enabled: false }],
    });
    expect(renderText(commands.get("artifacts.check")!, res.value)).toBe(
      "switchboard-artifacts (account acct-1) is private: the managed domain pub-abc.r2.dev is disabled and none of its 1 custom domain(s) is enabled",
    );
    expect(d.calls).toEqual(["managed acct-1/switchboard-artifacts", "custom acct-1/switchboard-artifacts"]);
  });

  it("answers private: false naming each open setting; a failed read is named", async () => {
    const open = bind(
      CONFIG,
      bucketDouble({
        managed: { domain: "pub-abc.r2.dev", enabled: true },
        custom: [{ domain: "files.example.com", enabled: true }],
      }).io,
    );
    const res = await open.invoke("artifacts.check", {}, cli);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.value).toMatchObject({
      private: false,
      open: ["the managed r2.dev domain pub-abc.r2.dev is enabled", "the custom domain files.example.com is enabled"],
    });
    expect(renderText(open.get("artifacts.check")!, res.value)).toBe(
      [
        "switchboard-artifacts (account acct-1) is NOT private:",
        "  - the managed r2.dev domain pub-abc.r2.dev is enabled",
        "  - the custom domain files.example.com is enabled",
      ].join("\n"),
    );
    const failing = bind(CONFIG, {
      ...bucketDouble().io,
      managedDomain: async () => ({ ok: false, problem: "CLOUDFLARE_API_TOKEN is not set — …" }),
    });
    expect(await failing.invoke("artifacts.check", {}, cli)).toMatchObject({
      ok: false,
      error: "unavailable",
      message: expect.stringMatching(
        /reading switchboard-artifacts's managed domain failed — CLOUDFLARE_API_TOKEN is not set/,
      ),
    });
  });
});

describe("artifacts.* without an artifacts: section", () => {
  it("both commands refuse by name before any call", async () => {
    const d = bucketDouble();
    const commands = bind(undefined, d.io);
    for (const id of ["artifacts.lifecycle", "artifacts.check"]) {
      expect(await commands.invoke(id, {}, cli)).toMatchObject({
        ok: false,
        error: "unavailable",
        message: expect.stringMatching(
          /^artifacts: is not configured — name the bucket under `artifacts.r2` in config.yaml/,
        ),
      });
    }
    expect(d.calls).toEqual([]);
  });
});
