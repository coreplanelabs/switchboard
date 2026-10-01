import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { RunBearerStore } from "../core/modelProxy/runBearers.js";
import { GitBindings } from "../core/modelProxy/gitBindings.js";
import { createGithubDoorHandler } from "./githubDoor.js";

const execFileAsync = promisify(execFile);
async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    encoding: "utf8",
    timeout: 15_000,
    // The real peer must see only this fixture's helper, never a resident's
    // global helper or injected per-command Git configuration.
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_PARAMETERS: undefined,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout.trim();
}

/** git-http-backend is a local Git protocol peer; no external repository or
 * credential is involved in this proof. */
async function gitBackend(root: string, url: string, init?: RequestInit): Promise<Response> {
  const request = new URL(url);
  const payload = init?.body
    ? Buffer.from(
        await new Response(init.body, { headers: { "content-type": "application/octet-stream" } }).arrayBuffer(),
      )
    : Buffer.alloc(0);
  const child = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: request.pathname,
      QUERY_STRING: request.search.slice(1),
      REQUEST_METHOD: init?.method ?? "GET",
      CONTENT_TYPE: (init?.headers as Record<string, string> | undefined)?.["content-type"] ?? "",
      CONTENT_LENGTH: String(payload.length),
      REMOTE_USER: "bot",
    },
  });
  const closed = once(child, "close");
  // A rejected push can make Git close stdin before it consumes the body.
  // The backend's response and exit code still decide the result.
  let inputError: NodeJS.ErrnoException | undefined;
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    inputError = error;
  });
  child.stdin.end(payload);
  const chunks: Buffer[] = [];
  for await (const chunk of child.stdout) chunks.push(Buffer.from(chunk));
  const [code] = (await closed) as [number];
  if (inputError && inputError.code !== "EPIPE") throw inputError;
  if (code !== 0) throw new Error(`git-http-backend exited ${code}`);
  const output = Buffer.concat(chunks);
  const split = output.indexOf("\r\n\r\n");
  if (split < 0) throw new Error("git-http-backend returned no headers");
  const headerText = output.toString("utf8", 0, split);
  const headers = new Headers();
  let status = 200;
  for (const line of headerText.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else headers.set(name, value);
  }
  return new Response(output.subarray(split + 4), { status, headers });
}

describe("GitHub door against a real Git smart HTTP peer", () => {
  it("clones and pushes only the bound non-default branch with a run bearer", async () => {
    const root = mkdtempSync(join(tmpdir(), "switchboard-git-door-"));
    const repo = join(root, "o", "r.git");
    const source = join(root, "source");
    mkdirSync(join(root, "o"));
    await git("init", "--bare", repo);
    await git("-C", repo, "config", "http.receivepack", "true");
    await git("init", "-b", "main", source);
    await git("-C", source, "config", "user.name", "Test");
    await git("-C", source, "config", "user.email", "test@example.invalid");
    await git("-C", source, "commit", "--allow-empty", "-m", "start");
    await git("-C", source, "remote", "add", "origin", repo);
    await git("-C", source, "push", "origin", "main");
    await git("-C", repo, "symbolic-ref", "HEAD", "refs/heads/main");

    const bearers = new RunBearerStore({ clock: () => 1_000 });
    const bearer = bearers.mint({
      runId: "12345678-1234-1234-1234-123456789abc",
      modelRef: "x/y",
      providerName: "x",
      providerWire: "openai-chat",
      model: "y",
      maxTokens: 100,
      maxTurns: 10,
      expiresAt: 2_000,
      span: {} as never,
      publish: () => {},
      github: { identity: "write", repo: "o/r" },
    });
    const handler = createGithubDoorHandler({
      bearers,
      token: async () => "trusted-only",
      fetcher: (url, init) =>
        url.startsWith("https://api.github.com/")
          ? Promise.resolve(
              new Response(JSON.stringify({ default_branch: "main" }), {
                headers: { "content-type": "application/json" },
              }),
            )
          : gitBackend(root, url, init),
    });
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("missing port");
      const url = `http://127.0.0.1:${addr.port}/git/o/r.git`;
      const clone = join(root, "clone");
      const helper = `!f() { printf '%s\\n' 'username=x-access-token' 'password=${bearer}'; }; f`;
      await git("-c", `credential.helper=${helper}`, "clone", url, clone);
      await git("-C", clone, "checkout", "-b", "fix");
      await git("-C", clone, "config", "user.name", "Test");
      await git("-C", clone, "config", "user.email", "test@example.invalid");
      await git("-C", clone, "commit", "--allow-empty", "-m", "fix");
      await git("-c", `credential.helper=${helper}`, "-C", clone, "push", "origin", "fix");
      expect(await git("-C", repo, "rev-parse", "refs/heads/fix")).toBe(await git("-C", clone, "rev-parse", "HEAD"));
      await git("-C", clone, "commit", "--allow-empty", "-m", "second fix");
      await git("-c", `credential.helper=${helper}`, "-C", clone, "push", "origin", "fix");
      expect(await git("-C", repo, "rev-parse", "refs/heads/fix")).toBe(await git("-C", clone, "rev-parse", "HEAD"));
      const main = await git("-C", repo, "rev-parse", "refs/heads/main");
      await git("-C", clone, "checkout", "main");
      await git("-C", clone, "commit", "--allow-empty", "-m", "refused");
      await expect(git("-c", `credential.helper=${helper}`, "-C", clone, "push", "origin", "main")).rejects.toThrow();
      expect(await git("-C", repo, "rev-parse", "refs/heads/main")).toBe(main);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("attributes an existing-PR push accepted by Git before its run is revoked", async () => {
    const root = mkdtempSync(join(tmpdir(), "switchboard-git-door-existing-"));
    const repo = join(root, "o", "r.git");
    const source = join(root, "source");
    mkdirSync(join(root, "o"));
    await git("init", "--bare", repo);
    await git("-C", repo, "config", "http.receivepack", "true");
    await git("init", "-b", "main", source);
    await git("-C", source, "config", "user.name", "Test");
    await git("-C", source, "config", "user.email", "test@example.invalid");
    await git("-C", source, "commit", "--allow-empty", "-m", "start");
    await git("-C", source, "remote", "add", "origin", repo);
    await git("-C", source, "push", "origin", "main");
    await git("-C", repo, "symbolic-ref", "HEAD", "refs/heads/main");
    await git("-C", source, "checkout", "-b", "fix");
    await git("-C", source, "commit", "--allow-empty", "-m", "existing head");
    await git("-C", source, "push", "origin", "fix");
    const old = await git("-C", repo, "rev-parse", "refs/heads/fix");
    const runId = "12345678-1234-1234-1234-123456789abc";
    const bearers = new RunBearerStore({ clock: () => 1_000 });
    const bearer = bearers.mint({
      runId,
      modelRef: "x/y",
      providerName: "x",
      providerWire: "openai-chat",
      model: "y",
      maxTokens: 100,
      maxTurns: 10,
      expiresAt: 2_000,
      span: {} as never,
      publish: () => {},
      github: { identity: "write", repo: "o/r", ref: "fix" },
    });
    const bindings = new GitBindings();
    expect(
      bindings.register(
        runId,
        { repo: "o/r", ref: "fix" },
        { repo: "o/r", ref: "refs/heads/fix", refConfirmed: true },
        async () => true,
        true,
      ),
    ).toBe(true);
    expect(bindings.setPublication(runId, { ref: "fix", expectedHeadSha: old })).toBe(true);
    const recorded: string[] = [];
    expect(
      bindings.setPublicationRecorder(runId, {
        begin: async (update) => {
          recorded.push(`pending:${update.old}:${update.next}`);
          return true;
        },
        finish: async (update, outcome) => {
          recorded.push(`${outcome}:${update.old}:${update.next}`);
          return true;
        },
      }),
    ).toBe(true);
    let forwarded = 0;
    const handler = createGithubDoorHandler({
      bearers,
      bindings,
      token: async () => "trusted-only",
      fetcher: async (url, init) => {
        if (url.startsWith("https://api.github.com/"))
          return new Response(JSON.stringify({ default_branch: "main" }), {
            headers: { "content-type": "application/json" },
          });
        const response = await gitBackend(root, url, init);
        if (url.endsWith("/git-receive-pack")) {
          forwarded++;
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          bearers.revoke(runId);
          expect(bindings.setPublication(runId, { blocked: "run ended" })).toBe(true);
        }
        return response;
      },
    });
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("missing port");
      const url = `http://127.0.0.1:${addr.port}/git/o/r.git`;
      const helper = `!f() { printf '%s\\n' 'username=x-access-token' 'password=${bearer}'; }; f`;
      await git("-C", source, "remote", "set-url", "origin", url);
      await git("-C", source, "commit", "--allow-empty", "-m", "approved fix");
      const next = await git("-C", source, "rev-parse", "HEAD");
      await git("-c", `credential.helper=${helper}`, "-C", source, "push", "origin", "fix");
      expect(await git("-C", repo, "rev-parse", "refs/heads/fix")).toBe(next);
      expect(recorded).toEqual([`pending:${old}:${next}`, `accepted:${old}:${next}`]);
      expect(bindings.publicationOf(runId)).toEqual({ blocked: "run ended" });
      expect(forwarded).toBe(1);
      await git("-C", source, "commit", "--allow-empty", "-m", "not authorized");
      await expect(git("-c", `credential.helper=${helper}`, "-C", source, "push", "origin", "fix")).rejects.toThrow();
      expect(forwarded).toBe(1);
      expect(await git("-C", repo, "rev-parse", "refs/heads/fix")).toBe(next);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
