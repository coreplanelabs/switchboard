import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../packageRoot.js";
import { OPERATOR_ROOT } from "./host.js";
import {
  assetPath,
  displayPath,
  installationPath,
  resolveOperatorRoot,
  WORK_AREA_DIR,
  workPath,
} from "./operatorRoot.js";

// Feature: docs/reference/specs/release-and-deploy.md item 24 — one value says
// where a deploy's files live: in a checkout every kind of file is under the
// repository root; from the published package the installation's files are the
// operator's directory, the shipped ones the package's assets, and the Worker
// directories a work area under the operator's directory.

const PKG = "/home/op/.npm/_npx/abc/node_modules/@acme/switchboard/dist/assets";

describe("resolveOperatorRoot", () => {
  it("in a checkout every root is the repository, whatever directory the command was started in", () => {
    const r = resolveOperatorRoot({ packageRoot: "/work/switchboard", published: false, cwd: "/work/switchboard/web" });
    expect(r).toEqual({
      mode: "checkout",
      root: "/work/switchboard",
      assets: "/work/switchboard",
      workArea: "/work/switchboard",
    });
    expect(installationPath(r, "deploy/profile.json")).toBe("/work/switchboard/deploy/profile.json");
    expect(assetPath(r, "deploy/cloudflare/wrangler.template.jsonc")).toBe(
      "/work/switchboard/deploy/cloudflare/wrangler.template.jsonc",
    );
    expect(workPath(r, "deploy/cloudflare")).toBe("/work/switchboard/deploy/cloudflare");
  });

  it("from the published package the installation is the working directory, the shipped files stay in the package, and the Worker directories go under .switchboard/", () => {
    const r = resolveOperatorRoot({ packageRoot: PKG, published: true, cwd: "/srv/switchboard" });
    expect(r).toEqual({
      mode: "package",
      root: "/srv/switchboard",
      assets: PKG,
      workArea: "/srv/switchboard/.switchboard",
    });
    expect(installationPath(r, "deploy/profile.json")).toBe("/srv/switchboard/deploy/profile.json");
    expect(installationPath(r, "config/config.yaml")).toBe("/srv/switchboard/config/config.yaml");
    expect(assetPath(r, "deploy/secrets.manifest.json")).toBe(join(PKG, "deploy/secrets.manifest.json"));
    expect(workPath(r, "deploy/cloudflare/wrangler.jsonc")).toBe(
      "/srv/switchboard/.switchboard/deploy/cloudflare/wrangler.jsonc",
    );
    // Nothing under the installed package is ever written to.
    expect(workPath(r, "deploy/cloudflare")).not.toContain("node_modules");
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
    });
  });
});
