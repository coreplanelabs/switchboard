import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SECRETS_DIR } from "./secrets.js";
import { expandDir, wranglerBin } from "./secretsHost.js";

// Feature: docs/reference/specs/packaging.md item 3 and release-and-deploy.md item 24 —
// the two pure decisions in the secrets host: where a `secretsSource` directory
// is, and which wrangler a put runs. The rest of the file spawns `op` and
// wrangler and stays untested on purpose.

describe("wranglerBin", () => {
  const dir = "/srv/op/.switchboard/deploy/cloudflare";
  const root = "/srv/op/.switchboard";
  const at =
    (...present: string[]) =>
    (p: string) =>
      present.includes(p);

  it("prefers the Worker directory's own nested wrangler, then the workspace root's hoisted one — where `npm ci --workspace` puts a shared version", () => {
    const nested = `${dir}/node_modules/.bin/wrangler`;
    const hoisted = `${root}/node_modules/.bin/wrangler`;
    expect(wranglerBin(dir, root, at(nested, hoisted))).toBe(nested);
    expect(wranglerBin(dir, root, at(hoisted))).toBe(hoisted);
  });

  it("falls back to PATH only when neither placement has one", () => {
    expect(wranglerBin(dir, root, at())).toBe("wrangler");
  });
});

describe("expandDir", () => {
  const checkout = "/work/switchboard";
  const operator = "/srv/switchboard";

  it("`~` is the operator's home, an absolute path is as written — from a checkout and from the package alike", () => {
    for (const root of [checkout, operator]) {
      expect(expandDir("~/.secrets/switchboard", root)).toBe(join(homedir(), ".secrets/switchboard"));
      expect(expandDir("~", root)).toBe(homedir());
      expect(expandDir("/srv/secrets", root)).toBe("/srv/secrets");
    }
    expect(expandDir(DEFAULT_SECRETS_DIR, operator)).toBe(join(homedir(), ".secrets/switchboard"));
  });

  it("a relative path is under the operator root — the checkout, or the directory the package was run in, where the profile that named it lives", () => {
    expect(expandDir("deploy/secrets", checkout)).toBe("/work/switchboard/deploy/secrets");
    expect(expandDir("deploy/secrets", operator)).toBe("/srv/switchboard/deploy/secrets");
    expect(expandDir("./secrets", operator)).toBe("/srv/switchboard/secrets");
  });
});
