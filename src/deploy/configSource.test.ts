import { describe, expect, it } from "vitest";
import {
  CONFIG_REPO_TOKEN_ENV,
  OP_TOKEN_ENV,
  parseConfigSource,
  readConfigSource,
  type ConfigSourceIO,
} from "./configSource.js";

// Where the bot's runtime config comes from at deploy time: a path, a file in
// a GitHub repository, or a 1Password field — one seam, every failure a
// refusal that names the source and the variable it needed.

describe("parseConfigSource", () => {
  it.each([
    ["config/config.production.yaml", { kind: "path", path: "config/config.production.yaml" }],
    ["./config/x.yaml", { kind: "path", path: "./config/x.yaml" }],
    ["/etc/switchboard/config.yaml", { kind: "path", path: "/etc/switchboard/config.yaml" }],
    [
      "github://acme/infrastructure/switchboard/config.production.yaml@main",
      {
        kind: "github",
        owner: "acme",
        repo: "infrastructure",
        path: "switchboard/config.production.yaml",
        ref: "main",
      },
    ],
    [
      "github://acme/infrastructure/switchboard/config.yaml",
      { kind: "github", owner: "acme", repo: "infrastructure", path: "switchboard/config.yaml", ref: "main" },
    ],
    ["op://Prod/Switchboard config/notesPlain", { kind: "op", ref: "op://Prod/Switchboard config/notesPlain" }],
  ])("%s", (input, expected) => {
    expect(parseConfigSource(input)).toEqual({ ok: true, source: expected });
  });

  it("refuses an empty value, a malformed github reference, a short op reference, and an unknown scheme", () => {
    expect(parseConfigSource("  ")).toMatchObject({ ok: false, problem: "configSource is empty" });
    expect(parseConfigSource("github://acme")).toMatchObject({ ok: false });
    expect(parseConfigSource("op://Vault/Item")).toMatchObject({ ok: false });
    expect(parseConfigSource("s3://bucket/key")).toMatchObject({
      ok: false,
      problem: expect.stringContaining("unknown scheme"),
    });
  });
});

function io(over: Partial<ConfigSourceIO> = {}): ConfigSourceIO {
  return {
    readFile: async () => undefined,
    fetch: async () => ({ status: 500, text: async () => "" }),
    opRead: async () => undefined,
    env: {},
    ...over,
  };
}

describe("readConfigSource", () => {
  it("a path source reads the file, and names it when it is absent", async () => {
    const ok = await readConfigSource(
      { kind: "path", path: "config/x.yaml" },
      io({ readFile: async (p) => (p === "config/x.yaml" ? "providers: {}\n" : undefined) }),
    );
    expect(ok).toEqual({ ok: true, text: "providers: {}\n", how: "config from config/x.yaml" });
    const missing = await readConfigSource({ kind: "path", path: "config/none.yaml" }, io());
    expect(missing).toEqual({ ok: false, problem: "configSource: config/none.yaml does not exist or cannot be read" });
  });

  it("a github source needs the token, asks the contents API for the raw file at the ref, and names a 404's likely causes", async () => {
    const src = { kind: "github", owner: "acme", repo: "infra", path: "sb/config.yaml", ref: "v1" } as const;
    expect(await readConfigSource(src, io())).toMatchObject({
      ok: false,
      problem: expect.stringContaining(`needs ${CONFIG_REPO_TOKEN_ENV}`),
    });
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const ok = await readConfigSource(
      src,
      io({
        env: { [CONFIG_REPO_TOKEN_ENV]: "ghp_x" },
        fetch: async (url, init) => {
          calls.push({ url, headers: init.headers });
          return { status: 200, text: async () => "memory:\n  enabled: true\n" };
        },
      }),
    );
    expect(ok).toEqual({
      ok: true,
      text: "memory:\n  enabled: true\n",
      how: "config from github://acme/infra/sb/config.yaml@v1",
    });
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/infra/contents/sb/config.yaml?ref=v1");
    // Each path segment is URL-encoded; the slashes between them are not.
    await readConfigSource(
      { ...src, path: "sb/prod config#1.yaml", ref: "release/2026" },
      io({
        env: { [CONFIG_REPO_TOKEN_ENV]: "ghp_x" },
        fetch: async (url, init) => {
          calls.push({ url, headers: init.headers });
          return { status: 200, text: async () => "" };
        },
      }),
    );
    expect(calls[1].url).toBe(
      "https://api.github.com/repos/acme/infra/contents/sb/prod%20config%231.yaml?ref=release%2F2026",
    );
    expect(calls[0].headers.authorization).toBe("Bearer ghp_x");
    expect(calls[0].headers.accept).toBe("application/vnd.github.raw+json");
    const notFound = await readConfigSource(
      src,
      io({ env: { [CONFIG_REPO_TOKEN_ENV]: "ghp_x" }, fetch: async () => ({ status: 404, text: async () => "" }) }),
    );
    expect(notFound).toMatchObject({
      ok: false,
      problem: expect.stringContaining("HTTP 404 (wrong path or ref, or the token cannot read this repository)"),
    });
  });

  it("an op source needs the service-account token and the CLI, and keeps op's last line on failure", async () => {
    const src = { kind: "op", ref: "op://Prod/Switchboard/config" } as const;
    expect(await readConfigSource(src, io())).toMatchObject({
      ok: false,
      problem: expect.stringContaining(`needs ${OP_TOKEN_ENV}`),
    });
    expect(await readConfigSource(src, io({ env: { [OP_TOKEN_ENV]: "ops_x" } }))).toMatchObject({
      ok: false,
      problem: expect.stringContaining("op) is not installed"),
    });
    expect(
      await readConfigSource(
        src,
        io({ env: { [OP_TOKEN_ENV]: "ops_x" }, opRead: async () => ({ code: 1, output: "[ERROR] item not found\n" }) }),
      ),
    ).toMatchObject({ ok: false, problem: expect.stringContaining("op read exited 1 — [ERROR] item not found") });
    expect(
      await readConfigSource(
        src,
        io({ env: { [OP_TOKEN_ENV]: "ops_x" }, opRead: async () => ({ code: 0, output: "providers: {}\n" }) }),
      ),
    ).toEqual({ ok: true, text: "providers: {}\n", how: "config from op://Prod/Switchboard/config" });
  });
});
