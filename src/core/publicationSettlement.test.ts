import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactStore } from "../artifacts/store.js";
import { InMemoryArtifactStore } from "../artifacts/store.js";
import type { PublicationSettlement } from "./publicationSettlement.js";
import { isPublicationSettlement } from "./publicationSettlement.js";
import { salvageBudgetPush } from "./codingPrPostStep.js";

const base = "a".repeat(40);
const source = "b".repeat(40);
const binding = {
  runId: "run-child",
  instanceId: "plan-change",
  step: "plan-change:U12/0/coding",
  repo: "acme/api",
  branch: "plan/change/u1",
  requester: "slack:UX",
  threadKey: "slack:C1:1",
  generation: "gen-1",
  baseHeadSha: base,
};

describe("publication settlement", () => {
  it.each(["direct", "door"] as const)("pins the transport when HEAD moves after admission: %s", async (transport) => {
    let moved = false;
    let pushedSource: string | undefined;
    const result = await salvageBudgetPush(
      {
        exec: async (cmd) => {
          if (cmd.includes("status")) return " M tracked.ts";
          if (cmd.includes("symbolic-ref")) return binding.branch;
          if (cmd.includes("rev-parse HEAD")) return moved ? "d".repeat(40) : source;
          if (cmd.includes(" push ")) {
            expect(cmd).toContain(`${source}:refs/heads/${binding.branch}`);
            pushedSource = source;
          }
          return "";
        },
        publishBranch: async (input) => {
          pushedSource = input.next;
          return "ok";
        },
      },
      {
        branch: binding.branch,
        cue: "ending",
        ...(transport === "door"
          ? {
              publicationDoor: { repo: binding.repo, origin: "https://door.example" },
              admitPush: async () => ({ release: () => {}, publicationBearer: "fixture-bearer" }),
            }
          : {}),
        settlement: {
          binding,
          record: async (value) => {
            if (value.publication.kind === "pending") moved = true;
            return true;
          },
        },
      },
    );
    expect(moved).toBe(true);
    expect(pushedSource).toBe(source);
    expect(result.settlement?.publication).toEqual({ kind: "accepted", head: source });
    expect(result.head).toBe(source);
  });

  it.each(["direct", "door"] as const)(
    "publishes the recorded source rather than a moving HEAD: %s",
    async (transport) => {
      let readHead = 0;
      let published = false;
      const later = "d".repeat(40);
      const executor = {
        exec: async (cmd: string) => {
          if (cmd.includes("status")) return " M tracked.ts";
          if (cmd.includes("symbolic-ref")) return binding.branch;
          if (cmd.includes("rev-parse HEAD")) return ++readHead === 1 ? source : later;
          if (cmd.includes(" push ")) {
            published = true;
            expect(cmd).toContain(`${source}:refs/heads/${binding.branch}`);
          }
          return "";
        },
        publishBranch: async (input: { next: string }) => {
          published = true;
          expect(input.next).toBe(source);
          return "ok";
        },
      };
      const result = await salvageBudgetPush(executor, {
        branch: binding.branch,
        cue: "ending",
        ...(transport === "door"
          ? {
              publicationDoor: { repo: binding.repo, origin: "https://door.example" },
              admitPush: async () => ({ release: () => {}, publicationBearer: "fixture-bearer" }),
            }
          : {}),
        settlement: { binding, record: async () => true },
      });
      expect(published).toBe(false);
      expect(result.settlement).toMatchObject({
        checkpoint: { kind: "created", head: source },
        publication: { kind: "rejected" },
      });
    },
  );

  it("redacts credentials and signed URLs before the first receipt write", async () => {
    const token = `ghp_${"z".repeat(24)}`;
    const signature = "signed-url-secret";
    const records: PublicationSettlement[] = [];
    const result = await salvageBudgetPush(
      {
        exec: async (cmd) => {
          if (cmd.includes("status")) return " M tracked.ts";
          if (cmd.includes("rev-parse HEAD")) return source;
          if (cmd.includes(" push "))
            return `exit 1: ${token} https://store.example/object?X-Amz-Signature=${signature}`;
          return "";
        },
      },
      {
        branch: binding.branch,
        cue: "ending",
        settlement: {
          binding,
          record: async (value) => {
            records.push(value);
            return true;
          },
        },
      },
    );
    const serialized = JSON.stringify({ records, result });
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(signature);
    expect(records.at(-1)?.checkpoint).toEqual({ kind: "created", head: source });
  });
  it.each(["failed", "unknown"] as const)(
    "keeps a commit ending unverified after %s without inventing a source head",
    async (kind) => {
      let pushed = false;
      const executor = {
        exec: async (cmd: string) => {
          if (cmd.includes("status")) return " M tracked.ts";
          if (cmd.includes(" commit ")) {
            if (kind === "unknown") throw new Error("commit acknowledgment lost");
            return "exit 1: commit refused";
          }
          if (cmd.includes(" push ")) pushed = true;
          return "";
        },
      };
      const result = await salvageBudgetPush(executor, {
        branch: binding.branch,
        cue: "ending",
        settlement: { binding, record: async () => true },
      });
      expect(result.settlement).toMatchObject({
        checkpoint: { kind: "unknown", stage: "commit" },
        publication: { kind: "not_attempted" },
      });
      expect(result.head).toBeUndefined();
      expect(pushed).toBe(false);
    },
  );
  it("records the local checkpoint before first publication and keeps transport failure separate from preservation", async () => {
    const recorded: unknown[] = [];
    const calls: string[] = [];
    const executor = {
      exec: async (cmd: string) => {
        calls.push(cmd);
        if (cmd.startsWith("git status")) return " M tracked.ts\n?? new.test.ts\n";
        if (cmd.includes("symbolic-ref")) return binding.branch;
        if (cmd.includes("remote get-url")) return "https://github.com/acme/api.git";
        if (cmd.includes("rev-parse HEAD")) return source;
        if (cmd.includes("rev-list")) return "1";
        if (cmd.startsWith("git push")) {
          expect(recorded).toContainEqual(expect.objectContaining({ checkpoint: { kind: "created", head: source } }));
          return "exit 128: remote: not found";
        }
        return "";
      },
    };
    const result = await salvageBudgetPush(executor, {
      branch: binding.branch,
      repo: binding.repo,
      cue: "ending",
      settlement: {
        binding,
        record: async (value) => {
          recorded.push(structuredClone(value));
          return true;
        },
      },
    });
    expect(result).toMatchObject({
      pushed: false,
      head: source,
      settlement: {
        checkpoint: { kind: "created", head: source },
        publication: { kind: "unknown" },
        preservation: { kind: "unavailable" },
        release: { kind: "pending" },
      },
    });
    expect(calls).toContain("git add -A");
  });

  it("does not classify a lost publication acknowledgment as a rejected push", async () => {
    const executor = {
      exec: async (cmd: string) => {
        if (cmd.includes("status")) return " M tracked.ts";
        if (cmd.includes("symbolic-ref")) return binding.branch;
        if (cmd.includes("remote get-url")) return "https://github.com/acme/api.git";
        if (cmd.includes("rev-parse HEAD")) return source;
        if (cmd.includes("rev-list")) return "1";
        if (cmd.startsWith("git push")) throw new Error("connection lost after request");
        return "";
      },
    };
    const result = await salvageBudgetPush(executor, {
      branch: binding.branch,
      repo: binding.repo,
      cue: "ending",
      settlement: { binding, record: async () => true },
    });
    expect(result).toMatchObject({ pushed: false, settlement: { publication: { kind: "unknown" } } });
  });
});

describe("checkpoint artifact preservation", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });
  const fixture = async (
    corrupt = false,
    moveRef = false,
    rewritten = false,
    unrelated = false,
    missingRemoteRef = false,
    unboundOrigin = false,
  ) => {
    const dir = await mkdtemp(join(tmpdir(), "publication-test-"));
    cleanup.push(dir);
    const checkout = join(dir, "work");
    await mkdir(checkout);
    const shell = async (cmd: string, cwd = checkout) =>
      (
        await promisify(execFile)("sh", ["-c", cmd.replace(/^sha256sum /, "shasum -a 256 ")], {
          cwd,
          env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        })
      ).stdout;
    await shell("git init -b main && git config user.name Tester && git config user.email tester@example.com");
    await writeFile(join(checkout, "tracked.ts"), "original\n");
    await shell("git add . && git commit -m base");
    const sharedAncestor = (await shell("git rev-parse HEAD")).trim();
    if (rewritten) {
      await writeFile(join(checkout, "tracked.ts"), "main advanced\n");
      await shell("git add . && git commit -m main-advanced");
    }
    const baseHeadSha = (await shell("git rev-parse HEAD")).trim();
    await shell(`git clone --bare . '${dir}/remote.git'`);
    if (missingRemoteRef) await shell(`git --git-dir='${dir}/remote.git' update-ref -d refs/heads/main`);
    if (unrelated) {
      await shell(`git switch --orphan '${binding.branch}'`);
      await writeFile(join(checkout, "tracked.ts"), "orphan\n");
      await shell("git add . && git commit -m orphan");
    } else {
      await shell(`git switch -c '${binding.branch}' ${rewritten ? sharedAncestor : ""}`);
    }
    await shell(`git remote add origin '${dir}/remote.git'`);
    await writeFile(join(checkout, "tracked.ts"), "changed\n");
    await writeFile(join(checkout, "new.test.ts"), "new test\n");
    const objects = new Map<string, Uint8Array>();
    let key = "";
    const store: ArtifactStore = Object.assign(new InMemoryArtifactStore(), {
      presignPut: async (value: string) => {
        key = value;
        return "https://store.example/put";
      },
      presignGet: async () => "https://store.example/get",
      head: async (value: string) =>
        objects.has(value) ? { size: objects.get(value)!.length, contentType: "application/octet-stream" } : null,
    });
    const records: PublicationSettlement[] = [];
    const executor = {
      exec: async (cmd: string) => {
        if (cmd.includes("remote get-url origin"))
          return unboundOrigin ? `${dir}/remote.git` : "https://github.com/acme/api.git";
        if (cmd.startsWith("curl")) {
          const upload = /-T '([^']+)'/.exec(cmd)?.[1];
          if (upload) {
            cleanup.push(upload);
            objects.set(key, await readFile(upload));
          } else {
            const download = /-o '([^']+)'/.exec(cmd)![1];
            cleanup.push(download);
            const bytes = Buffer.from(objects.get(key)!);
            if (corrupt) bytes[bytes.length - 1] ^= 1;
            await writeFile(download, bytes);
          }
          return "";
        }
        if (cmd.startsWith("git push")) {
          expect(records.at(-1)?.checkpoint.kind).toBe("created");
          return "exit 128: remote: not found";
        }
        try {
          if (moveRef && cmd.includes(" bundle create ")) await shell("git commit --allow-empty -m concurrent");
          return await shell(cmd);
        } catch (error) {
          return `exit 1: ${String(error)}`;
        }
      },
    };
    const result = await salvageBudgetPush(executor, {
      branch: binding.branch,
      repo: binding.repo,
      cue: "ending",
      settlement: {
        binding: { ...binding, baseHeadSha },
        store,
        record: async (value) => {
          records.push(structuredClone(value));
          return true;
        },
      },
    });
    return { result, records, dir, checkout, objects, key, shell, sharedAncestor, baseHeadSha };
  };

  it("recovers the exact commit with tracked and untracked files after the original checkout is removed", async () => {
    const f = await fixture();
    expect(f.result.settlement).toMatchObject({ publication: { kind: "unknown" }, preservation: { kind: "saved" } });
    expect(isPublicationSettlement(f.result.settlement)).toBe(true);
    await rm(f.checkout, { recursive: true });
    const restored = join(f.dir, "restore");
    await f.shell(`git clone '${f.dir}/remote.git' '${restored}'`, f.dir);
    const bundle = join(f.dir, "checkpoint.bundle");
    await writeFile(bundle, f.objects.get(f.key)!);
    await f.shell(
      `git bundle verify '${bundle}' && git fetch '${bundle}' '${binding.branch}' && git checkout --detach FETCH_HEAD`,
      restored,
    );
    expect((await f.shell("git rev-parse HEAD", restored)).trim()).toBe(f.result.head);
    expect(await readFile(join(restored, "tracked.ts"), "utf8")).toBe("changed\n");
    expect(await readFile(join(restored, "new.test.ts"), "utf8")).toBe("new test\n");
  });

  it("recovers a rewritten sibling head from its actual shared prerequisite after the original checkout is removed", async () => {
    const f = await fixture(false, false, true);
    expect(f.result.settlement).toMatchObject({ publication: { kind: "unknown" }, preservation: { kind: "saved" } });
    expect(f.key).toContain(`0-checkpoint-${f.baseHeadSha}-${f.result.head}.bundle`);
    const bundleHeader = Buffer.from(f.objects.get(f.key)!).subarray(0, 512).toString("utf8").split("\n\n")[0];
    expect(bundleHeader).toContain(`-${f.sharedAncestor} `);
    expect(bundleHeader).not.toContain(`-${f.baseHeadSha} `);
    await rm(f.checkout, { recursive: true });
    const restored = join(f.dir, "restore");
    await f.shell(`git clone '${f.dir}/remote.git' '${restored}'`, f.dir);
    const bundle = join(f.dir, "rewritten-checkpoint.bundle");
    await writeFile(bundle, f.objects.get(f.key)!);
    await f.shell(
      `git bundle verify '${bundle}' && git fetch '${bundle}' '${binding.branch}' && git checkout --detach FETCH_HEAD`,
      restored,
    );
    expect((await f.shell("git rev-parse HEAD", restored)).trim()).toBe(f.result.head);
    expect(await readFile(join(restored, "tracked.ts"), "utf8")).toBe("changed\n");
    expect(await readFile(join(restored, "new.test.ts"), "utf8")).toBe("new test\n");
  });

  it("refuses a bundle whose valid bytes package a later branch head", async () => {
    const f = await fixture(false, true);
    expect(f.result.settlement).toMatchObject({
      preservation: {
        kind: "unavailable",
        reason: "the stored checkpoint does not name the bound source and branch",
      },
    });
  });

  it("leaves unrelated histories unverified without a shared prerequisite", async () => {
    const f = await fixture(false, false, false, true);
    expect(f.result.settlement).toMatchObject({
      publication: { kind: "unknown" },
      preservation: { kind: "unavailable" },
    });
    expect(f.records.some((value) => value.preservation.kind === "saved")).toBe(false);
    expect(f.objects.size).toBe(0);
  });

  it("does not claim a rewritten checkpoint when the shared prerequisite has no durable remote ref", async () => {
    const f = await fixture(false, false, true, false, true);
    expect(f.result.settlement).toMatchObject({
      publication: { kind: "unknown" },
      preservation: { kind: "unavailable" },
    });
    expect(f.records.some((value) => value.preservation.kind === "saved")).toBe(false);
    expect(f.objects.size).toBe(0);
  });

  it("refuses a rewritten checkpoint when origin no longer names the bound repository", async () => {
    const f = await fixture(false, false, true, false, false, true);
    expect(f.result.settlement).toMatchObject({
      publication: { kind: "unknown" },
      preservation: { kind: "unavailable" },
    });
    expect(f.records.some((value) => value.preservation.kind === "saved")).toBe(false);
    expect(f.objects.size).toBe(0);
  });

  it("does not report preservation when readback has the right size but a different digest", async () => {
    const f = await fixture(true);
    expect(f.result.settlement).toMatchObject({
      publication: { kind: "unknown" },
      preservation: { kind: "unavailable", reason: "the stored checkpoint digest does not match" },
    });
    expect(f.records.some((value) => value.preservation.kind === "saved")).toBe(false);
  });
});
