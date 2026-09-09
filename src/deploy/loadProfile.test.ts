import { describe, expect, it } from "vitest";
import type { ConfigSourceIO } from "./configSource.js";
import { EXAMPLE_ACCOUNT, PROFILE_ENV, PROFILE_EXAMPLE_PATH, PROFILE_PATH } from "./profile.js";
import { loadProfileOnHost, renderWorkerConfigsOnHost } from "./run.js";
import { TEST_PROFILE } from "./testing/profile.js";
import { renderWorkerConfigs, workerConfigTargets } from "./wranglerTemplate.js";
import { existsSync, readFileSync } from "node:fs";

// The host's profile loader: the env var wins — a path, or the `github://` /
// `op://` forms `configSource` takes, read through the same loaders (a
// production profile can live in an infrastructure repository) — then the
// installation's own gitignored file, then the checked-in example. The example
// is the example wherever it was read from, so `deploy all`'s refusal cannot
// be sidestepped by pointing the env var at it (or at a copy with the
// placeholder account).

const noIO: ConfigSourceIO = {
  readFile: async () => undefined,
  fetch: async () => ({ status: 500, text: async () => "" }),
  opRead: async () => undefined,
  env: {},
};

describe("loadProfileOnHost", () => {
  // Skipped on a machine that has written its own gitignored profile — there the fallback is that file, by design.
  it.skipIf(existsSync(PROFILE_PATH))(
    "with no installation profile and no override, reads the example and says so (this repository carries only the example)",
    async () => {
      const loaded = await loadProfileOnHost({});
      expect(loaded).toMatchObject({ origin: "example", path: PROFILE_EXAMPLE_PATH });
      expect(loaded.profile.account).toBe(EXAMPLE_ACCOUNT);
    },
  );

  it("an override pointing at the example is still the example", async () => {
    const loaded = await loadProfileOnHost({ [PROFILE_ENV]: PROFILE_EXAMPLE_PATH });
    expect(loaded).toMatchObject({ origin: "example", path: PROFILE_EXAMPLE_PATH });
  });

  it("an override that names a missing file is an error naming the variable, never a fall-through", async () => {
    await expect(loadProfileOnHost({ [PROFILE_ENV]: "/nonexistent/profile.json" })).rejects.toThrow(
      `${PROFILE_ENV}=/nonexistent/profile.json: no such file`,
    );
  });

  it("a github:// override is read through the config-source loader with CONFIG_REPO_TOKEN and is a real profile", async () => {
    const ref = "github://acme/infrastructure/switchboard/profile.json@main";
    const calls: string[] = [];
    const io: ConfigSourceIO = {
      ...noIO,
      env: { CONFIG_REPO_TOKEN: "ghp_x" },
      fetch: async (url) => {
        calls.push(url);
        return { status: 200, text: async () => JSON.stringify(TEST_PROFILE) };
      },
    };
    const loaded = await loadProfileOnHost({ [PROFILE_ENV]: ref }, io);
    expect(loaded).toEqual({ profile: TEST_PROFILE, origin: "profile", path: ref });
    expect(calls).toEqual([
      "https://api.github.com/repos/acme/infrastructure/contents/switchboard/profile.json?ref=main",
    ]);
  });

  it("a github:// override that cannot be read, or is not a profile, is an error naming the reference and the cause", async () => {
    const ref = "github://acme/infrastructure/switchboard/profile.json@main";
    await expect(loadProfileOnHost({ [PROFILE_ENV]: ref }, noIO)).rejects.toThrow(
      `${PROFILE_ENV}=${ref}: configSource github://acme/infrastructure/… needs CONFIG_REPO_TOKEN`,
    );
    const notJson: ConfigSourceIO = {
      ...noIO,
      env: { CONFIG_REPO_TOKEN: "ghp_x" },
      fetch: async () => ({ status: 200, text: async () => "not json" }),
    };
    await expect(loadProfileOnHost({ [PROFILE_ENV]: ref }, notJson)).rejects.toThrow(`${ref}: not valid JSON`);
    const invalid: ConfigSourceIO = {
      ...noIO,
      env: { CONFIG_REPO_TOKEN: "ghp_x" },
      fetch: async () => ({ status: 200, text: async () => JSON.stringify({ account: "nope" }) }),
    };
    await expect(loadProfileOnHost({ [PROFILE_ENV]: ref }, invalid)).rejects.toThrow(
      `${ref}: invalid deployment profile`,
    );
  });
});

describe("renderWorkerConfigsOnHost", () => {
  // The writer is injected: the real one targets the gitignored files that
  // wranglerTemplate.test.ts reads in another worker, and a test must neither
  // race that read nor overwrite an installation's own render with the example.
  it("writes every Worker's gitignored wrangler.jsonc as the render of its template with the profile in force (the example, named explicitly here so a machine with its own profile agrees), and says so", async () => {
    const lines: string[] = [];
    const written = new Map<string, string>();
    const env = { [PROFILE_ENV]: PROFILE_EXAMPLE_PATH };
    expect(
      await renderWorkerConfigsOnHost({ log: (l) => lines.push(l) }, env, (path, text) => {
        written.set(path, text);
      }),
    ).toEqual([]);
    expect(lines).toEqual([`[deploy:all] rendered 4 Worker config(s) from ${PROFILE_EXAMPLE_PATH}`]);
    const example = await loadProfileOnHost(env);
    const rendered = renderWorkerConfigs(example.profile, (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined));
    if (!rendered.ok) throw new Error(rendered.problems.join("; "));
    expect([...written.keys()]).toEqual(workerConfigTargets(example.profile).map((t) => t.outputPath));
    for (const f of rendered.files) expect(written.get(f.path), f.path).toBe(f.text);
    // The rendered files are ignored: rendering leaves the tree clean for the deploy's own check.
    expect(readFileSync(".gitignore", "utf8")).toContain("deploy/*/wrangler.jsonc");
  });
});
