import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor } from "./executor.js";
import { shellQuote } from "./shellQuote.js";
import { advanceWorkspace } from "./workspaceAdvance.js";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
async function repository() {
  const root = mkdtempSync(join(tmpdir(), "workspace-advance-"));
  dirs.push(root);
  const remote = join(root, "remote.git"),
    repo = join(root, "checkout");
  mkdirSync(repo);
  const setup = new LocalExecutor(root);
  const identity = {
    GIT_AUTHOR_NAME: "Contract",
    GIT_AUTHOR_EMAIL: "contract@example.invalid",
    GIT_COMMITTER_NAME: "Contract",
    GIT_COMMITTER_EMAIL: "contract@example.invalid",
  };
  const executor = new LocalExecutor(repo, async () => identity);
  for (const command of [
    `git init --bare ${shellQuote(remote)}`,
    `git clone ${shellQuote(remote)} ${shellQuote(repo)}`,
  ])
    expect((await setup.execResult(command)).exitCode).toBe(0);
  await executor.writeFile("source.txt", "before\n");
  expect((await executor.execResult("git add . && git commit -m before && git push origin HEAD:main")).exitCode).toBe(
    0,
  );
  const old = (await executor.execResult("git rev-parse HEAD")).stdout.trim();
  await executor.writeFile("source.txt", "after\n");
  expect((await executor.execResult("git add . && git commit -m after && git push origin HEAD:main")).exitCode).toBe(0);
  const target = (await executor.execResult("git rev-parse HEAD")).stdout.trim();
  expect((await executor.execResult(`git reset --hard ${old}`)).exitCode).toBe(0);
  return { executor, old, target };
}
describe("executor workspace advance", () => {
  it("a hard stop during the final command cannot confirm an advance", async () => {
    const control = new AbortController();
    let calls = 0;
    const old = "a".repeat(40);
    const target = "b".repeat(40);
    await expect(
      advanceWorkspace(
        async () => {
          calls++;
          if (calls === 8) control.abort();
          return {
            exitCode: 0,
            stdout: calls === 1 || calls === 4 ? old : calls === 8 ? target : "",
            stderr: "",
            truncated: false,
          };
        },
        target,
        { signal: control.signal },
      ),
    ).rejects.toThrow("stopped");
  });
  it("fetches the requested commit and confirms a real checkout before returning", async () => {
    const h = await repository();
    await expect(h.executor.moveTo(h.target)).resolves.toEqual({ sha: h.target });
    expect(await h.executor.readFile("source.txt")).toBe("after\n");
    expect((await h.executor.execResult("git rev-parse HEAD")).stdout.trim()).toBe(h.target);
  });
  it.each(["source.txt", "private.txt"])(
    "keeps private bytes and old HEAD when %s has unsaved changes",
    async (path) => {
      const h = await repository();
      await h.executor.writeFile(path, "private bytes");
      await expect(h.executor.moveTo(h.target)).rejects.toThrow("preserves changed private files");
      expect(await h.executor.readFile(path)).toBe("private bytes");
      expect((await h.executor.execResult("git rev-parse HEAD")).stdout.trim()).toBe(h.old);
    },
  );
  it("a hard stop prevents advance", async () => {
    const h = await repository();
    const control = new AbortController();
    control.abort();
    await expect(h.executor.moveTo(h.target, { signal: control.signal })).rejects.toThrow("stopped");
    expect((await h.executor.execResult("git rev-parse HEAD")).stdout.trim()).toBe(h.old);
  });
  it("keeps an unpublished commit reachable when the requested head replaces it", async () => {
    const h = await repository();
    await h.executor.writeFile("private.txt", "private bytes");
    expect((await h.executor.execResult("git add private.txt && git commit -m private")).exitCode).toBe(0);
    const privateHead = (await h.executor.execResult("git rev-parse HEAD")).stdout.trim();
    await expect(h.executor.moveTo(h.target)).rejects.toThrow("unpublished commits");
    expect((await h.executor.execResult("git rev-parse HEAD")).stdout.trim()).toBe(privateHead);
    expect(await h.executor.readFile("private.txt")).toBe("private bytes");
  });
  it("refuses checkout when an ignored private file would be overwritten", async () => {
    const h = await repository();
    await h.executor.execResult(`git checkout --detach ${h.target}`);
    await h.executor.writeFile("private.txt", "public source");
    expect(
      (await h.executor.execResult("git add private.txt && git commit -m source && git push origin HEAD:main"))
        .exitCode,
    ).toBe(0);
    const target = (await h.executor.execResult("git rev-parse HEAD")).stdout.trim();
    await h.executor.execResult(`git checkout --detach ${h.old}`);
    await h.executor.execResult("printf 'private.txt\\n' >> .git/info/exclude");
    await h.executor.writeFile("private.txt", "private bytes");
    await expect(h.executor.moveTo(target)).rejects.toThrow();
    expect(await h.executor.readFile("private.txt")).toBe("private bytes");
    expect((await h.executor.execResult("git rev-parse HEAD")).stdout.trim()).toBe(h.old);
  });
});
