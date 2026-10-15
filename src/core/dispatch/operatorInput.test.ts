import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../config.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { threadSessionKey } from "../runLedger/sessionLog.js";
import { freshContext } from "./contextSeed.js";
import { prepareActionContext, requesterRepoContext } from "./operator.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "swb-action-context-"));
  directories.push(directory);
  const path = join(directory, "config.yaml");
  writeFileSync(
    path,
    `organization: acme
providers:
  anthropic: { type: anthropic }
defaults:
  agent: general
  models: { general: anthropic/general-model }
restrict:
  agents: [coding]
  repos: [acme/private]
`,
  );
  const config = new ConfigStore(path, join(directory, "overrides.json"));
  const ledger = new InMemoryRunLedger();
  const msg = { channelId: "slack:C1", userId: "slack:UREADER", threadKey: "slack:C1:1", text: "review PR #7" };
  return { config, ledger, msg };
}

describe("shared action context", () => {
  it("prepares authorized actions and repository candidates without a model call", async () => {
    const { config, msg } = fixture();
    const prepared = await prepareActionContext(
      {
        config,
        residentSlugs: async () => ["acme/private", "acme/api", "bad-slug"],
      },
      { msg },
    );

    expect(prepared.input.text).toBe("review PR #7");
    expect(
      prepared.input.projection.presets
        .filter(({ name }) => name === "general" || name === "coding")
        .map(({ name }) => name),
    ).toEqual(["general"]);
    expect(prepared.input.residentRepos).toEqual(["acme/api"]);
    expect(prepared.candidateStatus).toBe("available");
    expect(prepared.input.requesterId).toBe("slack:UREADER");
  });

  it("saves the requester's explicit target before returning the action context", async () => {
    const { config, ledger, msg } = fixture();
    const prepared = await prepareActionContext(
      { config, runLedger: ledger },
      { msg: { ...msg, text: "Fix the retry in acme/api" } },
    );

    expect(prepared.input.requesterTarget).toEqual({ repo: "acme/api", provenance: "Fix the retry in acme/api" });
    expect(await ledger.readRequesterTarget(threadSessionKey(msg.threadKey), msg.userId)).toEqual({
      repo: "acme/api",
      provenance: "Fix the retry in acme/api",
    });
  });

  it("does not promote another person's target or a specialist's repository to requester authority", async () => {
    const { config, ledger, msg } = fixture();
    const prepared = await prepareActionContext(
      { config, runLedger: ledger },
      {
        msg: { ...msg, text: "Fix it" },
        thread: [{ finished: true, agent: "review", repo: "acme/api", userId: msg.userId }],
        readTail: async () => ({
          turns: [{ text: "user: Fix acme/private", actor: "slack:UOTHER" }],
          unavailable: [],
          context: freshContext(),
        }),
      },
    );

    expect(prepared.input.newestFinishedRun?.repo).toBe("acme/api");
    expect(requesterRepoContext(prepared.input.tail, msg.userId, prepared.input.requesterTarget)).toEqual({});
    expect(await ledger.readRequesterTarget(threadSessionKey(msg.threadKey), msg.userId)).toBeNull();
  });

  it("holds unproved saved context before it can checkpoint a target", async () => {
    const { config, ledger, msg } = fixture();
    await expect(
      prepareActionContext(
        { config, runLedger: ledger },
        {
          msg: { ...msg, text: "Fix acme/api" },
          readTail: async () => ({ turns: [{ text: "user: earlier message", actor: msg.userId }], unavailable: [] }),
        },
      ),
    ).rejects.toThrow("Saved conversation dependencies are unproved.");
    expect(await ledger.readRequesterTarget(threadSessionKey(msg.threadKey), msg.userId)).toBeNull();
  });

  it("marks a target-store failure without inventing requester authority", async () => {
    const { config, ledger, msg } = fixture();
    const prepared = await prepareActionContext(
      {
        config,
        runLedger: {
          readSessionTail: ledger.readSessionTail.bind(ledger),
          readRequesterTarget: async () => {
            throw new Error("store unavailable");
          },
          checkpointRequesterTarget: ledger.checkpointRequesterTarget.bind(ledger),
        },
      },
      { msg: { ...msg, text: "Fix it" } },
    );

    expect(prepared.input.targetStoreUnavailable).toBe(true);
    expect(prepared.input.text).toBe("Fix it");
    expect(requesterRepoContext(prepared.input.tail, msg.userId, prepared.input.requesterTarget)).toEqual({});
  });
});
