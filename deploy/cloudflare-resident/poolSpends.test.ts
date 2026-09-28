import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

const source = readSource("worker.ts");
const resident = source.slice(source.indexOf("export class ResidentDO"));
const method = (name: string) => methodOf(resident, name) ?? "";

describe("resident pool UID generation fence", () => {
  it("initializes the ledger only after confirmed VM destruction, including an old DO with wiped state", () => {
    expect(method("initResident")).not.toContain("[SPENT_POOL_USERS_KEY]: []");
    expect(method("runProvisioning")).toContain("await this.destroyConfirmed()");
    const destroy = method("destroyConfirmed");
    expect(destroy.indexOf("await this.destroy()")).toBeLessThan(
      destroy.indexOf("this.ctx.storage.put(SPENT_POOL_USERS_KEY, [])"),
    );
    expect(destroy.indexOf("this.ctx.storage.put(SPENT_POOL_USERS_KEY, [])")).toBeLessThan(
      destroy.indexOf("this.destroying = pending"),
    );
  });

  it("durably spends a fresh UID before giving it to a thread or op", () => {
    const reserve = method("reserveSafePoolUser");
    expect(reserve).toContain("parseSpentPoolUsers(await this.ctx.storage.get<unknown>(SPENT_POOL_USERS_KEY)");
    expect(reserve.indexOf("this.markPoolUserSpent(user, owner)")).toBeLessThan(reserve.indexOf("return user"));
    expect(reserve).toContain("pool-recycle-required: all UIDs spent");
    expect(method("markPoolUserSpent")).toContain("this.ctx.storage.transaction");
    expect(method("allocateOpUser")).toContain("this.reserveSafePoolUser(owner)");
    expect(method("allocateThreadUser")).toContain("this.reserveSafePoolUser(`thread:${threadKey}`, threadKey)");
  });

  it("refuses old or unrecorded UIDs at the model-command boundary", () => {
    expect(method("threadRun")).toContain("this.poolUserOwnerMatches(user)");
    expect(method("claimRetainedThreadUser")).toContain("this.markPoolUserSpent(user, `thread:${binding.threadKey}`)");
    expect(method("threadPreflight")).toContain("this.poolUserOwnerMatches(binding.user, `thread:${threadKey}`)");
    expect(method("poolUserOwnerMatches")).toContain("mayRunAsPoolUser(");
    expect(method("attachThreadBody")).toContain("this.claimRetainedThreadUser(storedPrior)");
    expect(method("detachThread")).toContain("this.poolUserOwnerMatches(binding.user, `thread:${threadKey}`)");
    expect(method("killThreadUserProcesses")).toContain("this.poolUserOwnerMatches(user, `thread:${threadKey}`)");
    const cleanliness = method("worktreeCleanliness");
    expect(cleanliness.indexOf("this.poolUserOwnerMatches(binding.user")).toBeLessThan(
      cleanliness.indexOf("worktreeCleanlinessScript(binding.worktreePath, binding.user)"),
    );
    const evict = method("evictBinding");
    expect(evict).toContain("this.poolUserOwnerMatches(binding.user, `thread:${binding.threadKey}`)");
    expect(evict.indexOf("this.poolUserOwnerMatches(binding.user")).toBeLessThan(
      evict.indexOf("threadUserCacheCleanArgv"),
    );
    expect(method("residentLevels")).toContain("for (const user of spent?.keys() ?? THREAD_USERS) used.add(user)");
    expect(method("debugRecreateContainerChecked")).toContain("this.registeredRunsBeyondOps()");
  });
});

describe("resident pool UID binding index", () => {
  it("rebuilds before events and reads one UID row at the shell guard", () => {
    expect(resident).toContain("this.ctx.blockConcurrencyWhile(() => this.rebuildPoolBindingIndex())");
    expect(method("initResident")).toContain("await this.rebuildPoolBindingIndex()");
    const rebuild = method("rebuildPoolBindingIndex");
    expect(rebuild).toContain("txn.list<ThreadBinding>");
    expect(rebuild).toContain("rebuildPoolBindingIndex(bindings.values(), THREAD_USERS)");
    const guard = method("poolUserOwnerMatches");
    expect(guard).toContain("this.ctx.storage.get<unknown>(poolBindingKey(user))");
    expect(guard).not.toContain("this.ctx.storage.list<ThreadBinding>");
  });

  it("transacts primary binding changes with the claimant index", () => {
    const put = method("putThreadBinding");
    expect(put).toContain("this.ctx.storage.transaction");
    expect(put).toContain("releasePoolBinding(");
    expect(put).toContain("claimPoolBinding(");
    expect(put).toContain("await txn.put(key, next)");
    expect(method("deleteThreadBinding")).toContain("await txn.delete(key)");
    expect(source).not.toMatch(/this\.ctx\.storage\.(?:put|delete)\(threadBindingKey\(/);
    expect(method("allocateThreadUser")).toContain("this.putThreadBinding(binding)");
    expect(method("evictBinding")).toContain("this.putThreadBinding({");
  });
});
