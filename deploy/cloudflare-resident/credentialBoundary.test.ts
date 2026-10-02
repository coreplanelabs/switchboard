import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";
import { hasUnexpectedOwnedThreadDir } from "./orphanThreadUsers.js";
import { KeyedAsyncLock } from "./keyedAsyncLock.js";

const source = readSource("worker.ts");
const resident = source.slice(source.indexOf("export class ResidentDO"));
const method = (name: string) => methodOf(resident, name) ?? "";

describe("resident model credential boundary", () => {
  it("refuses an old thread directory owned by a candidate UID", () => {
    const root = "/workspace/threads";
    const current = `${root}/current-12345678`;
    const old = `${root}/old-87654321`;
    expect(hasUnexpectedOwnedThreadDir("", root, [])).toBe(false);
    expect(hasUnexpectedOwnedThreadDir(`${current}\n`, root, [current])).toBe(false);
    expect(hasUnexpectedOwnedThreadDir(`${current}\n${old}\n`, root, [current])).toBe(true);
    expect(hasUnexpectedOwnedThreadDir(`${old}\n`, root, [])).toBe(true);
    expect(hasUnexpectedOwnedThreadDir(`${root}/../other\n`, root, [])).toBe(true);
    expect(hasUnexpectedOwnedThreadDir(`${current}\u0000`, root, [current])).toBe(true);
    expect(hasUnexpectedOwnedThreadDir(`${current}\n\n`, root, [current])).toBe(true);
    const scan = method("poolUserHasOldThreadDir");
    expect(scan).toContain("result.truncated");
    expect(scan).toContain("[THREADS_DIR, OPS_DIR]");
    expect(scan).toContain("hasUnexpectedOwnedThreadDir(result.stdout, dir, dir === THREADS_DIR ? allowed : [])");
    const reserve = method("reserveSafePoolUser");
    expect(method("findFreePoolUser")).toContain("if (user) this.poolUsersInspecting.add(user)");
    expect(reserve).toContain("this.poolUserHasOldThreadDir(user, [])");
    expect(reserve).toContain("if (!safe) this.poolUsersInspecting.delete(user)");
    expect(method("reserveSafePoolUser")).toContain("this.poolUserHasOldStageContent(user)");
    expect(method("reserveSafePoolUser")).toContain("pool-user-contaminated: no clean pool user is available");
    expect(method("poolUserHasOldStageContent")).toContain("legacyStageContentScanCommand");
    expect(method("attachThreadTraced")).toContain("this.threadAttaches.run(threadKey, async () => {");
    expect(method("attachThreadTraced")).toContain("this.attachThreadBody(");
    expect(method("attachThreadBody")).not.toContain("withThreadAllocationLock");
    expect(method("claimRetainedThreadUser")).toContain("this.poolUserHasOldThreadDir(user");
    expect(method("claimRetainedThreadUser")).toContain("!THREAD_USERS.includes(user)");
    expect(method("allocateThreadUser")).toContain("this.reserveSafePoolUser(`thread:${threadKey}`, threadKey)");
    expect(method("allocateOpUser")).toContain("this.reserveSafePoolUser(owner)");
    expect(method("residentLevels")).toContain("for (const u of this.poolUsersInspecting) used.add(u)");
    expect(method("writeThreadFile")).toContain("this.threadWrites.run(threadKey");
    expect(method("writeThreadFileImpl")).toContain("legacyStageReuseScrubCommand(stageDir)");
  });

  it("serializes a failed attach rollback before the next same-thread binding read", async () => {
    const lock = new KeyedAsyncLock();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let binding: string | undefined;
    let secondEntered = false;
    const first = lock.run("thread", async () => {
      const prior = binding;
      binding = "provisional";
      await firstBlocked;
      binding = prior;
    });
    const second = lock.run("thread", async () => {
      secondEntered = true;
      expect(binding).toBeUndefined();
      binding = "committed";
    });
    await Promise.resolve();
    expect(secondEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(binding).toBe("committed");
  });
  it("mints only mirror-read permissions and checks the effective GitHub scope before caching", () => {
    const mint = source.slice(
      source.indexOf("export async function mintRepoScopedToken"),
      source.indexOf("/** Short-lived RS256 JWT"),
    );
    expect(mint).toContain("permissions: RESIDENT_MIRROR_PERMISSIONS");
    expect(mint).toContain("verifyGithubMintScope(data, slug, RESIDENT_MIRROR_PERMISSIONS)");
  });

  it("refuses a writable attach or command without a run-bound Git door", () => {
    expect(method("attachThreadBody")).toMatch(/if \(!readonly && !githubDoor\)[\s\S]*?status: 403/);
    expect(method("execThreadBody")).toMatch(
      /if \(!binding\.readonly && !binding\.githubDoorHost\)[\s\S]*?status: 403/,
    );
    expect(method("execThreadBody")).toMatch(/env\?\.GH_HOST !== binding\.githubDoorHost/);
  });

  it("scrubs a previous App token file on every door attach and never rewrites one for model use", () => {
    expect(method("attachThreadCreate")).toMatch(/mode\.scrubCredentials \|\| githubDoor/);
    expect(method("attachThreadCreate")).toMatch(/this\.scrubThreadCredentials\(binding\)/);
    expect(method("attachThreadCreate").indexOf("this.scrubThreadCredentials(binding)")).toBeLessThan(
      method("attachThreadCreate").indexOf("this.materializeThreadDeps("),
    );
    expect(method("attachThreadCreate")).not.toMatch(/writeThreadCredentials/);
    expect(source).not.toMatch(/private async writeThreadCredentials\(/);
    expect(method("execThreadBody")).not.toMatch(/mintRepoScopedToken/);
    const scrub = method("scrubThreadCredentialFiles");
    expect(scrub).toContain("legacyCredentialScrubCommand(binding.worktreePath, `/workspace/.stage-${binding.user}`)");
    expect(method("attachThreadCreate").indexOf("this.scrubThreadCredentialFiles(binding)")).toBeLessThan(
      method("attachThreadCreate").indexOf("this.ensureThreadWorktree("),
    );
    expect(method("scrubThreadCredentials").indexOf("this.scrubThreadCredentialFiles(binding)")).toBeLessThan(
      method("scrubThreadCredentials").indexOf("this.threadRunOk("),
    );
  });

  it("keeps a pool user reserved until its old credential-bearing thread directory is removed", () => {
    const evict = method("evictBinding");
    const remove = evict.indexOf('this.runOk(["rm", "-rf", threadDir], "evict")');
    const refused = evict.indexOf('return "cleanup-failed";', remove);
    const free = evict.indexOf('user: "",');
    expect(remove).toBeGreaterThan(-1);
    expect(refused).toBeGreaterThan(remove);
    expect(free).toBeGreaterThan(refused);
    expect(evict).toMatch(
      /if \(runtimeActive && !threadDir\.startsWith\(`\$\{THREADS_DIR\}\/`\)\) return "cleanup-failed";/,
    );
    expect(method("findFreePoolUser")).toContain("!b.evicted && b.user");
    expect(method("detachThread")).toContain('reason: "thread-cleanup-failed: pool user kept"');
    for (const caller of ["detachThread", "sweepWorktrees", "reclaimFinishedRefs"])
      expect(method(caller)).toContain("const activeNow = await this.isRuntimeActive().catch(() => true);");
    expect(method("reclaimFinishedRefs")).toContain(
      'eviction === "preserved" ? "preservation-held" : "cleanup-failed"',
    );
  });

  it("scrubs a superseded named-ref checkout before the same pool user can enter the replacement", () => {
    const attach = method("attachThreadBody");
    const scrub = attach.indexOf("this.scrubThreadCredentialFiles(prior)");
    const create = attach.indexOf("this.attachThreadCreate({");
    expect(scrub).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(scrub);
    expect(attach).toMatch(/if \(replacingNamedRef && prior && !prior\.evicted\)/);
    expect(attach).toMatch(
      /await this\.scrubThreadCredentialFiles\(prior\);[\s\S]*?catch \(err\) \{[\s\S]*?await rollback\(\);[\s\S]*?return this\.attachFailed\(err\)/,
    );
  });

  it("scrubs a retained checkout before an own-PR branch probe runs as its pool user", () => {
    const attach = method("attachThreadBody");
    const claim = attach.indexOf("this.claimRetainedThreadUser(storedPrior)");
    const scrub = attach.indexOf("this.scrubThreadCredentialFiles(storedPrior)");
    const rebind = attach.indexOf("this.rebindToOwnPr(storedPrior,");
    expect(claim).toBeGreaterThan(-1);
    expect(scrub).toBeGreaterThan(claim);
    expect(rebind).toBeGreaterThan(scrub);
    expect(attach).toMatch(
      /if \(reason\.ownPr !== null\) \{[\s\S]*?await this\.scrubThreadCredentialFiles\(storedPrior\);[\s\S]*?catch \(err\) \{[\s\S]*?return this\.attachFailed\(err\)/,
    );
    expect(method("rebindToOwnPr")).toContain("this.threadRun(");
  });
});
