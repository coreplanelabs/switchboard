import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../config.js";
import { InMemoryGithubApi, type PullSummary } from "../execution/githubApi.js";
import { githubCapabilityFor } from "../core/dispatch/run.js";
import { chatActorOf } from "../core/authz/actor.js";
import { classifyEvidenceRelevance } from "../core/intake.js";
import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";
import type { GithubPullSourceContext } from "../execution/githubReadSource.js";
import { normalizeGithubActivity } from "./githubActivity.js";
import { githubActivityTaskAccess } from "./githubActivityAccess.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const source = { host: "github.com" as const, appId: 1, installationId: 2 };
const task = (): GithubPullSourceContext => ({
  version: 1,
  source,
  repositoryId: 3,
  pullRequestId: 70,
  number: 7,
  head: { repositoryId: 30, ref: "fix", sha: "a".repeat(40) },
  baseRef: "main",
});
const pull = (): PullSummary => ({
  id: 70,
  source,
  number: 7,
  title: "Retry handling",
  body: "PRIVATE_PR",
  state: "open",
  draft: false,
  url: "https://github.com/acme/api/pull/7",
  author: "author",
  updatedAt: "2026-10-14T12:00:00Z",
  head: { repo: "acme/fork", repositoryId: 30, ref: "fix", sha: "a".repeat(40) },
  base: { repo: "acme/api", repositoryId: 3, ref: "main" },
});
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "swb-activity-access-"));
  directories.push(directory);
  const path = join(directory, "config.yaml");
  writeFileSync(
    path,
    `organization: acme
providers:
  anthropic: { type: anthropic, apiKeyEnv: ANTHROPIC_API_KEY }
defaults:
  agent: general
  models: { general: anthropic/general-model, coding: anthropic/coding-model }
grants:
  "slack:UDEV": { repos: ["acme/api", "acme/renamed"] }
restrict:
  repos: ["acme/api", "acme/renamed"]
`,
  );
  const config = new ConfigStore(path, join(directory, "overrides.json"));
  await config.setUserOverride("slack:UDEV", { github: { login: "ivy-dev", id: 4242 } });
  const api = new InMemoryGithubApi({
    "acme/api": {
      id: 3,
      source,
      private: true,
      pulls: [pull()],
      permissions: { "ivy-dev": { id: 4242, permission: "read" } },
    },
  });
  const msg = { userId: "slack:UDEV", channelId: "slack:DONE", threadKey: "slack:DONE:1" };
  const capability = (verifiedDirectAudience = true, incoming = msg) =>
    githubCapabilityFor({ config, githubApi: api }, chatActorOf(config, incoming), {
      requesterId: "slack:UDEV",
      verifiedDirectAudience,
    });
  const normalized = await normalizeGithubActivity(
    { ...source, repositoryId: 3 },
    { event: "issue_comment", delivery: "access-one" },
    {
      action: "created",
      installation: { id: 2 },
      repository: { id: 3, full_name: "acme/api" },
      issue: { number: 7, pull_request: {} },
      comment: {
        id: 5,
        body: "PRIVATE_COMMENT",
        user: { id: 4, login: "reviewer", type: "Bot" },
        html_url: "https://github.com/acme/api/pull/7#issuecomment-5",
        created_at: "2026-10-14T12:00:00Z",
        updated_at: "2026-10-14T12:00:00Z",
      },
    },
  );
  if (normalized.kind !== "normalized") throw new Error("expected normalized comment");
  const ledger = new InMemoryRunLedger(() => 123);
  const received = await ledger.receiveSourceEvent(normalized.event);
  if (received.kind === "refused") throw new Error("expected saved event");
  const record = await ledger.readSourceEvent(received.receipt.key);
  if (!record) throw new Error("expected canonical event");
  const repository = api.repos.get("acme/api")!;
  return { api, config, record, repository, capability, ledger };
}

describe("current GitHub activity access", () => {
  it("requires the bound requester, direct audience and current person-level permission for private comments", async () => {
    const { record, repository, capability, config } = await setup();
    expect(await githubActivityTaskAccess(record, task(), capability())).toEqual({ kind: "available" });
    expect(await githubActivityTaskAccess(record, task(), capability(false))).toEqual({
      kind: "held",
      reason: "access-unproved",
    });
    expect(
      await githubActivityTaskAccess(
        record,
        task(),
        capability(true, {
          userId: "slack:UDEV",
          channelId: "slack:CONE",
          threadKey: "slack:CONE:1",
        }),
      ),
    ).toEqual({ kind: "held", reason: "access-unproved" });
    repository.permissions = { "ivy-dev": { id: 4242, permission: "none" } };
    expect(await githubActivityTaskAccess(record, task(), capability())).toEqual({
      kind: "held",
      reason: "access-unproved",
    });
    repository.permissions = { "ivy-dev": { id: 4242, permission: "read" } };
    await config.setUserOverride("slack:UDEV", { github: { login: "ivy-dev", id: 9999 } });
    expect(await githubActivityTaskAccess(record, task(), capability())).toEqual({
      kind: "held",
      reason: "access-unproved",
    });
    await config.setUserOverride("slack:UDEV", { github: { login: "ivy-dev", id: 4242 } });
    expect(await githubActivityTaskAccess(record, task(), capability())).toEqual({ kind: "available" });
    repository.private = false;
    expect(await githubActivityTaskAccess(record, task(), capability(false))).toEqual({ kind: "available" });
    expect(
      await githubActivityTaskAccess(
        record,
        task(),
        capability(false, {
          userId: "slack:UOTHER",
          channelId: "slack:CONE",
          threadKey: "slack:CONE:1",
        }),
      ),
    ).toEqual({ kind: "held", reason: "access-unproved" });
  });

  it("checks fresh native identities rather than a repository name or PR number alone", async () => {
    const { record, repository, capability } = await setup();
    expect(await githubActivityTaskAccess(record, task(), capability())).toEqual({ kind: "available" });
    for (const changed of [
      { id: undefined },
      { id: 9 },
      { source: undefined },
      { source: { ...source, appId: 9 } },
      { source: { ...source, installationId: 9 } },
    ]) {
      const saved = { id: repository.id, source: repository.source };
      Object.assign(repository, changed);
      expect(await githubActivityTaskAccess(record, task(), capability())).toEqual({
        kind: "held",
        reason: "access-unproved",
      });
      Object.assign(repository, saved);
    }
    for (const changed of [
      { id: undefined },
      { id: 71 },
      { number: 8 },
      { source: undefined },
      { source: { ...source, installationId: 9 } },
      { base: { ...pull().base, repositoryId: 9 } },
    ]) {
      repository.pulls = [{ ...pull(), ...changed }];
      expect(await githubActivityTaskAccess(record, task(), capability())).toEqual({
        kind: "held",
        reason: "access-unproved",
      });
    }
    repository.pulls = [pull()];
    expect(await githubActivityTaskAccess(record, task(), capability())).toEqual({ kind: "available" });
  });

  it("keeps the original access capability for an in-flight check", async () => {
    const { record, capability } = await setup();
    const original = capability();
    const pending = githubActivityTaskAccess(record, task(), original);
    original.readableRepos = async () => [];
    expect(await pending).toEqual({ kind: "available" });
    expect(await githubActivityTaskAccess(record, task(), original)).toEqual({
      kind: "held",
      reason: "access-unproved",
    });
  });

  it("rechecks permission after a pending PR read before releasing the result", async () => {
    const { api, record, repository, capability } = await setup();
    const original = api.getPullRequest.bind(api);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(api, "getPullRequest").mockImplementation(async (repo, number) => {
      const value = await original(repo, number);
      entered();
      await held;
      return value;
    });
    const pending = githubActivityTaskAccess(record, task(), capability());
    await waiting;
    repository.permissions = { "ivy-dev": { id: 4242, permission: "none" } };
    release();
    expect(await pending).toEqual({ kind: "held", reason: "access-unproved" });
    repository.permissions = { "ivy-dev": { id: 4242, permission: "read" } };
    expect(await githubActivityTaskAccess(record, task(), capability())).toEqual({ kind: "available" });
  });
  it("follows a renamed repository by ID without pinning access to the task head", async () => {
    const { api, record, repository, capability } = await setup();
    api.repos.delete("acme/api");
    repository.pulls = [
      { ...pull(), base: { ...pull().base, repo: "acme/renamed" }, head: { ...pull().head, sha: "b".repeat(40) } },
    ];
    api.repos.set("acme/renamed", repository);
    expect(await githubActivityTaskAccess(record, task(), capability())).toEqual({ kind: "available" });
    api.repos.set("acme/api", { ...repository, id: 99, pulls: [pull()] });
    expect(await githubActivityTaskAccess(record, task(), capability())).toEqual({ kind: "available" });
    api.repos.set("acme/duplicate", { ...repository });
    expect(await githubActivityTaskAccess(record, task(), capability())).toEqual({
      kind: "held",
      reason: "access-unproved",
    });
  });

  it("holds unknown proof and private errors without returning source bytes", async () => {
    const { api, record, capability } = await setup();
    expect(await githubActivityTaskAccess(record, task(), undefined)).toEqual({
      kind: "held",
      reason: "access-unproved",
    });
    const missing = capability();
    delete missing.readableRepos;
    expect(await githubActivityTaskAccess(record, task(), missing)).toEqual({
      kind: "held",
      reason: "access-unproved",
    });
    for (const method of ["listRepos", "getPullRequest"] as const) {
      const failure = vi.spyOn(api, method).mockRejectedValue(new Error("PRIVATE_PROVIDER_BODY"));
      expect(await githubActivityTaskAccess(record, task(), capability())).toEqual({
        kind: "held",
        reason: "access-unproved",
      });
      failure.mockRestore();
    }
    const altered = structuredClone(record);
    altered.event.payload = { private: "PRIVATE_FORGED_BODY" };
    expect(await githubActivityTaskAccess(altered, task(), capability())).toEqual({
      kind: "held",
      reason: "invalid-record",
    });
    let reads = 0;
    const unsafe = Object.defineProperty({}, "source", {
      enumerable: true,
      get() {
        reads++;
        return source;
      },
    });
    expect(await githubActivityTaskAccess(record, unsafe, capability())).toEqual({
      kind: "held",
      reason: "access-unproved",
    });
    expect(reads).toBe(0);
    expect(await githubActivityTaskAccess(record, task(), capability())).toEqual({ kind: "available" });
  });

  it("holds a queued relevance call when current GitHub permission is removed", async () => {
    const { record, repository, capability } = await setup();
    const input = { taskContext: "Review retry handling.", message: "PRIVATE_COMMENT" };
    const sent: boolean[] = [];
    const validateInput = async () =>
      (await githubActivityTaskAccess(record, task(), capability())).kind === "available";
    const answer = { tool: "evidence_relevance", input: { answer: "relevant", reason: "Affects retries." } };
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = classifyEvidenceRelevance(input, {
      validateInput,
      model: async (prompt, options) => {
        entered();
        await queued;
        await options.beforeSend!();
        sent.push(prompt.user.includes("PRIVATE_COMMENT"));
        return answer;
      },
    });
    await waiting;
    repository.permissions = { "ivy-dev": { id: 4242, permission: "none" } };
    release();
    expect(await pending).toEqual({ kind: "held", reason: "context-unavailable" });
    expect(sent).toEqual([]);
    repository.permissions = { "ivy-dev": { id: 4242, permission: "read" } };
    expect(
      await classifyEvidenceRelevance(input, {
        validateInput,
        model: async (prompt, options) => {
          await options.beforeSend!();
          sent.push(prompt.user.includes("PRIVATE_COMMENT"));
          return answer;
        },
      }),
    ).toMatchObject({ kind: "classified", verdict: "relevant", source: "model" });
    expect(sent).toEqual([true]);
  });

  it("rechecks the same GitHub source before a relevance correction", async () => {
    const { record, repository, capability } = await setup();
    const sent: boolean[] = [];
    const result = await classifyEvidenceRelevance(
      { taskContext: "Review retry handling.", message: "PRIVATE_COMMENT" },
      {
        validateInput: async () => (await githubActivityTaskAccess(record, task(), capability())).kind === "available",
        model: async (prompt, options) => {
          await options.beforeSend!();
          sent.push(prompt.user.includes("PRIVATE_COMMENT"));
          repository.permissions = { "ivy-dev": { id: 4242, permission: "none" } };
          return { tool: "evidence_relevance", input: { answer: "invalid", reason: "Try again." } };
        },
      },
    );
    expect(result).toEqual({ kind: "held", reason: "context-unavailable" });
    expect(sent).toEqual([true]);
  });
});
