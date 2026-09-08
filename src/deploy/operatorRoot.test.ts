import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../packageRoot.js";
import { OPERATOR_ROOT } from "./host.js";
import {
  assetPath,
  displayPath,
  HOME_DIR_NAME,
  HOME_ENV,
  INSTALLATION_MARKERS,
  installationPath,
  resolveOperatorRoot,
  WORK_AREA_DIR,
  workPath,
} from "./operatorRoot.js";

// Feature: docs/reference/specs/release-and-deploy.md item 24 — one value says
// where a deploy's files live: in a checkout every kind of file is under the
// repository root; from the published package the installation is one directory
// every command agrees on — SWITCHBOARD_HOME, a cwd that already holds an
// installation, else ~/.switchboard — so an operator runs `init` from wherever
// they are with no `mkdir` first; the shipped files are the package's assets,
// and the Worker directories a work area under the installation.

const PKG = "/home/op/.npm/_npx/abc/node_modules/@acme/switchboard/dist/assets";
const HOME = "/home/op";
const none = () => false;

describe("resolveOperatorRoot", () => {
  it("in a checkout every root is the repository, whatever directory the command was started in and whatever the env or home say", () => {
    const r = resolveOperatorRoot({
      packageRoot: "/work/switchboard",
      published: false,
      cwd: "/work/switchboard/web",
      home: HOME,
      env: { [HOME_ENV]: "/ignored" },
      exists: () => true,
    });
    expect(r).toEqual({
      mode: "checkout",
      root: "/work/switchboard",
      assets: "/work/switchboard",
      workArea: "/work/switchboard",
      chosenBy: "checkout",
    });
    expect(installationPath(r, "deploy/profile.json")).toBe("/work/switchboard/deploy/profile.json");
    expect(assetPath(r, "deploy/cloudflare/wrangler.template.jsonc")).toBe(
      "/work/switchboard/deploy/cloudflare/wrangler.template.jsonc",
    );
    expect(workPath(r, "deploy/cloudflare")).toBe("/work/switchboard/deploy/cloudflare");
  });

  it("from the published package with nothing to go on, the installation is ~/.switchboard — no mkdir before init; the shipped files stay in the package and the Worker directories go under its .switchboard/", () => {
    const r = resolveOperatorRoot({
      packageRoot: PKG,
      published: true,
      cwd: "/home/op/Downloads",
      home: HOME,
      env: {},
      exists: none,
    });
    expect(r).toEqual({
      mode: "package",
      root: join(HOME, HOME_DIR_NAME),
      assets: PKG,
      workArea: join(HOME, HOME_DIR_NAME, WORK_AREA_DIR),
      chosenBy: "home",
    });
    expect(installationPath(r, "deploy/profile.json")).toBe(join(HOME, HOME_DIR_NAME, "deploy/profile.json"));
    expect(installationPath(r, "config/config.yaml")).toBe(join(HOME, HOME_DIR_NAME, "config/config.yaml"));
    expect(assetPath(r, "deploy/secrets.manifest.json")).toBe(join(PKG, "deploy/secrets.manifest.json"));
    expect(workPath(r, "deploy/cloudflare/wrangler.jsonc")).toBe(
      join(HOME, HOME_DIR_NAME, WORK_AREA_DIR, "deploy/cloudflare/wrangler.jsonc"),
    );
    // Nothing under the installed package is ever written to.
    expect(workPath(r, "deploy/cloudflare")).not.toContain("node_modules");
  });

  it("a directory that already holds an installation keeps winning when the CLI runs inside it — any one marker file is enough", () => {
    for (const marker of INSTALLATION_MARKERS) {
      const r = resolveOperatorRoot({
        packageRoot: PKG,
        published: true,
        cwd: "/srv/switchboard",
        home: HOME,
        env: {},
        exists: (p) => p === join("/srv/switchboard", marker),
      });
      expect(r.root, marker).toBe("/srv/switchboard");
      expect(r.chosenBy, marker).toBe("cwd");
      expect(r.workArea, marker).toBe("/srv/switchboard/.switchboard");
    }
    expect(INSTALLATION_MARKERS).toEqual([".env", "config/config.yaml", "deploy/profile.json"]);
  });

  it("SWITCHBOARD_HOME names the installation outright, over both the cwd and the home default; blank is unset; ~ and ~/ are the home; a relative value is made absolute from the cwd", () => {
    const named = resolveOperatorRoot({
      packageRoot: PKG,
      published: true,
      cwd: "/srv/switchboard",
      home: HOME,
      env: { [HOME_ENV]: "/var/lib/switchboard" },
      exists: () => true,
    });
    expect(named.root).toBe("/var/lib/switchboard");
    expect(named.chosenBy).toBe(HOME_ENV);
    const blank = resolveOperatorRoot({
      packageRoot: PKG,
      published: true,
      cwd: "/x",
      home: HOME,
      env: { [HOME_ENV]: "  " },
      exists: none,
    });
    expect(blank.root).toBe(join(HOME, HOME_DIR_NAME));
    const tilde = resolveOperatorRoot({
      packageRoot: PKG,
      published: true,
      cwd: "/x",
      home: HOME,
      env: { [HOME_ENV]: "~/sb" },
      exists: none,
    });
    expect(tilde.root).toBe(join(HOME, "sb"));
    const bare = resolveOperatorRoot({
      packageRoot: PKG,
      published: true,
      cwd: "/x",
      home: HOME,
      env: { [HOME_ENV]: "~" },
      exists: none,
    });
    expect(bare.root).toBe(HOME);
    // A relative value is taken from the cwd once, so the root is absolute and cannot drift with a later command's cwd.
    const relative = resolveOperatorRoot({
      packageRoot: PKG,
      published: true,
      cwd: "/x/y",
      home: HOME,
      env: { [HOME_ENV]: "sb" },
      exists: none,
    });
    expect(relative.root).toBe("/x/y/sb");
  });

  it("with no home to fall back to, or no probe (the old three-field call), the working directory is the installation as before", () => {
    expect(
      resolveOperatorRoot({ packageRoot: PKG, published: true, cwd: "/work", env: {}, exists: none }),
    ).toMatchObject({
      root: "/work",
      chosenBy: "cwd",
    });
    expect(resolveOperatorRoot({ packageRoot: PKG, published: true, cwd: "/srv/switchboard" })).toEqual({
      mode: "package",
      root: "/srv/switchboard",
      assets: PKG,
      workArea: "/srv/switchboard/.switchboard",
      chosenBy: "cwd",
    });
  });

  it("a work-area path reads as the tree path in a checkout and under .switchboard/ from the package", () => {
    expect(displayPath("checkout", "deploy/cloudflare/wrangler.jsonc")).toBe("deploy/cloudflare/wrangler.jsonc");
    expect(displayPath("package", "deploy/cloudflare/wrangler.jsonc")).toBe(
      `${WORK_AREA_DIR}/deploy/cloudflare/wrangler.jsonc`,
    );
  });
});

describe("this process's root", () => {
  it("in the checkout is the repository root in checkout mode — every deploy path resolves exactly as before", () => {
    expect(OPERATOR_ROOT).toEqual({
      mode: "checkout",
      root: PACKAGE_ROOT,
      assets: PACKAGE_ROOT,
      workArea: PACKAGE_ROOT,
      chosenBy: "checkout",
    });
  });
});
