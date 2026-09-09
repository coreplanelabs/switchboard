import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SECRETS_DIR } from "./secrets.js";
import { expandDir } from "./secretsHost.js";

// Feature: docs/reference/specs/packaging.md item 3 — the one pure decision in
// the secrets host: where a `secretsSource` directory is. The rest of the file
// spawns `op` and wrangler and stays untested on purpose.

describe("expandDir", () => {
  const checkout = { root: "/work/switchboard", published: false };
  const pkg = { root: "/home/op/.npm/_npx/abc/node_modules/@acme/switchboard/dist/assets", published: true };

  it("`~` is the operator's home, an absolute path is as written — from a checkout and from the package alike", () => {
    for (const at of [checkout, pkg]) {
      expect(expandDir("~/.secrets/switchboard", at)).toBe(join(homedir(), ".secrets/switchboard"));
      expect(expandDir("~", at)).toBe(homedir());
      expect(expandDir("/srv/secrets", at)).toBe("/srv/secrets");
    }
    expect(expandDir(DEFAULT_SECRETS_DIR, pkg)).toBe(join(homedir(), ".secrets/switchboard"));
  });

  it("a relative path is under the checkout", () => {
    expect(expandDir("deploy/secrets", checkout)).toBe("/work/switchboard/deploy/secrets");
  });

  it("from the published package a relative path is refused, naming where it would have landed and the forms that work", () => {
    expect(() => expandDir("deploy/secrets", pkg)).toThrow(
      `secretsSource deploy/secrets: a relative directory resolves inside the installed package (${pkg.root}), not an operator's secrets — use an absolute path or ~/<dir> (the default is ${DEFAULT_SECRETS_DIR})`,
    );
  });
});
