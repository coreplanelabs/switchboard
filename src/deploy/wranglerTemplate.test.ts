import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripJsonc } from "../agentEnv/bootstrap.js";
import { DOCKERFILES, registryName } from "./images.js";
import { publishedImagesOnHost } from "./run.js";
import { parseProfile, PROFILE_ENV, PROFILE_EXAMPLE_PATH, PROFILE_PATH, type DeploymentProfile } from "./profile.js";
import { TEST_PROFILE, TEST_PUBLISHED_IMAGES, TEST_REGISTRY_PROFILE } from "./testing/profile.js";
import {
  GENERATED_HEADER,
  RENDERED_FILE,
  renderSiteConfig,
  renderTemplate,
  renderWorkerConfig,
  renderWorkerConfigs,
  SITE_CONFIG_TARGET,
  SITE_DIR,
  siteView,
  TEMPLATE_FILE,
  templateView,
  workerConfigTargets,
} from "./wranglerTemplate.js";

// Every Worker's wrangler.jsonc is generated from the template next to it and
// the deployment profile: the template is valid JSONC (placeholders live inside
// strings, optional blocks are comment-line directives), the renderer fails on
// anything it cannot resolve, and the file on disk is the render — never a
// hand edit.

describe("templateView", () => {
  it("binds a Worker's script and hostname, the account and zone, and the URLs the other Workers are reached at", () => {
    const view = templateView(TEST_PROFILE, "resident", TEST_PUBLISHED_IMAGES);
    expect(view).toEqual({
      account: TEST_PROFILE.account,
      zone: "example.test",
      script: "switchboard-resident",
      hostname: "switchboard-resident.example.test",
      image: "./Dockerfile",
      urls: {
        publicBaseUrl: "https://switchboard.example.test",
        stateWorkerUrl: "https://switchboard-memory.example.test",
      },
      access: undefined,
      bot: { script: "switchboard" },
    });
  });

  // run-history item 47: the state Worker binds the bot's `ShipCoordinator` across
  // scripts, so its template names the bot's script — the one every profile has.
  it("the committed state Worker template binds the bot's ShipCoordinator Workflow by the bot's script name", () => {
    const template = readFileSync(new URL(`../../deploy/cloudflare-memory/${TEMPLATE_FILE}`, import.meta.url), "utf8");
    const rendered = renderTemplate(template, templateView(TEST_PROFILE, "memory", TEST_PUBLISHED_IMAGES)!);
    expect(rendered.ok ? "" : rendered.problems.join("\n")).toBe("");
    const text = rendered.ok ? rendered.text : "";
    expect(text).toContain('"binding": "SHIP_COORDINATOR"');
    expect(text).toContain('"class_name": "ShipCoordinator"');
    expect(text).toContain('"script_name": "switchboard"');
    expect(text).toContain('"name": "switchboard-ship-coordinator"');
  });

  it("carries the Access application when the profile has one, and is undefined for a Worker the profile lacks", () => {
    const withAccess: DeploymentProfile = {
      ...TEST_PROFILE,
      access: { teamDomain: "acme.cloudflareaccess.com", aud: "a".repeat(64) },
    };
    expect(templateView(withAccess, "bot", TEST_PUBLISHED_IMAGES)?.access).toEqual({
      teamDomain: "acme.cloudflareaccess.com",
      aud: "a".repeat(64),
    });
    const { sandbox: _sandbox, ...withoutSandbox } = TEST_PROFILE.workers;
    expect(
      templateView({ ...TEST_PROFILE, workers: withoutSandbox }, "sandbox", TEST_PUBLISHED_IMAGES),
    ).toBeUndefined();
  });
});

// Feature: docs/reference/specs/docs-site.md item 12 — the project's docs site is not a Worker of
// the installation: its script name and hostname are project facts, and the profile contributes
// only the account the project's own CI deploys it to.
describe("siteView / renderSiteConfig", () => {
  const FACTS = { name: "switchboard", docs: "https://docs.example.test/" };

  it("binds `<name>-docs` and the docs host to the profile's account — nothing from the profile's Workers", () => {
    expect(siteView(TEST_PROFILE, FACTS)).toEqual({
      ok: true,
      view: { account: TEST_PROFILE.account, script: "switchboard-docs", hostname: "docs.example.test" },
    });
    expect(siteView({ account: "f".repeat(32) }, { name: "gateway", docs: "https://openproduct.example" })).toEqual({
      ok: true,
      view: { account: "f".repeat(32), script: "gateway-docs", hostname: "openproduct.example" },
    });
  });

  it("names the fact that is missing or malformed, never guessing a host", () => {
    expect(siteView(TEST_PROFILE, { docs: "https://d.example" })).toEqual({ ok: false, problem: "`name` is missing" });
    expect(siteView(TEST_PROFILE, { name: "switchboard" })).toEqual({ ok: false, problem: "`docs` is missing" });
    expect(siteView(TEST_PROFILE, { name: "switchboard", docs: "docs.example.test" })).toEqual({
      ok: false,
      problem: '`docs` "docs.example.test" is not a URL',
    });
    expect(siteView(TEST_PROFILE, null)).toEqual({ ok: false, problem: "`name` is missing" });
  });

  it("renders the site's template from the facts file's text; a missing or non-JSON facts file, a bad fact or a missing template is a problem naming its source", () => {
    const template =
      '{ "name": "{{script}}", "account_id": "{{account}}", "routes": [{ "pattern": "{{hostname}}" }] }\n';
    const read = (path: string) => (path === SITE_CONFIG_TARGET.templatePath ? template : undefined);
    expect(renderSiteConfig(TEST_PROFILE, JSON.stringify(FACTS), read)).toEqual({
      ok: true,
      path: `${SITE_DIR}/${RENDERED_FILE}`,
      text: `${GENERATED_HEADER.join("\n")}\n{ "name": "switchboard-docs", "account_id": "${TEST_PROFILE.account}", "routes": [{ "pattern": "docs.example.test" }] }\n`,
    });
    expect(renderSiteConfig(TEST_PROFILE, undefined, read)).toEqual({
      ok: false,
      problems: ["project.json: no such file"],
    });
    expect(renderSiteConfig(TEST_PROFILE, "{ nope", read)).toEqual({ ok: false, problems: ["project.json: not JSON"] });
    expect(renderSiteConfig(TEST_PROFILE, JSON.stringify({ name: "switchboard" }), read)).toEqual({
      ok: false,
      problems: ["project.json: `docs` is missing"],
    });
    expect(renderSiteConfig(TEST_PROFILE, JSON.stringify(FACTS), () => undefined)).toEqual({
      ok: false,
      problems: [`${SITE_DIR}/${TEMPLATE_FILE}: no such file`],
    });
    expect(renderSiteConfig(TEST_PROFILE, JSON.stringify(FACTS), () => '"{{urls.publicBaseUrl}}"')).toEqual({
      ok: false,
      problems: [`${SITE_DIR}/${TEMPLATE_FILE} line 1: {{urls.publicBaseUrl}} has no value in the deployment profile`],
    });
  });
});

const VIEW = templateView(TEST_PROFILE, "bot", TEST_PUBLISHED_IMAGES)!;

describe("renderTemplate", () => {
  it("substitutes every placeholder, keeps everything else byte for byte, and prefixes the generated header", () => {
    const template = [
      '{ "name": "{{script}}", "account_id": "{{account}}",',
      '  "routes": [{ "pattern": "{{hostname}}" }] }',
      "",
    ].join("\n");
    const r = renderTemplate(template, VIEW);
    expect(r).toEqual({
      ok: true,
      text: [
        ...GENERATED_HEADER,
        '{ "name": "switchboard", "account_id": "1234567890abcdef1234567890abcdef",',
        '  "routes": [{ "pattern": "switchboard.example.test" }] }',
        "",
      ].join("\n"),
    });
  });

  it("resolves dotted placeholders (`urls.publicBaseUrl`, `access.aud`)", () => {
    const r = renderTemplate('"{{urls.publicBaseUrl}}" "{{urls.stateWorkerUrl}}"', VIEW);
    expect(r).toMatchObject({ ok: true });
    if (r.ok)
      expect(r.text.split("\n").at(-1)).toBe(
        '"https://switchboard.example.test" "https://switchboard-memory.example.test"',
      );
  });

  it("an `{{#if access}}` block is kept, directives removed, when the profile has Access — and dropped whole when it has not", () => {
    const template = [
      '  "vars": {',
      '    "PUBLIC_BASE_URL": "{{urls.publicBaseUrl}}",',
      "    // {{#if access}}",
      '    "ACCESS_TEAM_DOMAIN": "{{access.teamDomain}}",',
      '    "ACCESS_AUD": "{{access.aud}}",',
      "    // {{/if}}",
      '    "STATE_WORKER_URL": "{{urls.stateWorkerUrl}}"',
      "  }",
    ].join("\n");
    const without = renderTemplate(template, VIEW);
    expect(without.ok && without.text.split("\n").slice(GENERATED_HEADER.length)).toEqual([
      '  "vars": {',
      '    "PUBLIC_BASE_URL": "https://switchboard.example.test",',
      '    "STATE_WORKER_URL": "https://switchboard-memory.example.test"',
      "  }",
    ]);
    const withAccess = renderTemplate(template, {
      ...VIEW,
      access: { teamDomain: "acme.cloudflareaccess.com", aud: "b".repeat(64) },
    });
    expect(withAccess.ok && withAccess.text.split("\n").slice(GENERATED_HEADER.length)).toEqual([
      '  "vars": {',
      '    "PUBLIC_BASE_URL": "https://switchboard.example.test",',
      '    "ACCESS_TEAM_DOMAIN": "acme.cloudflareaccess.com",',
      `    "ACCESS_AUD": "${"b".repeat(64)}",`,
      '    "STATE_WORKER_URL": "https://switchboard-memory.example.test"',
      "  }",
    ]);
  });

  it("refuses a placeholder the profile has no value for — a missing Access field outside its block, an unknown name — naming the line", () => {
    expect(renderTemplate('"a"\n"{{access.teamDomain}}"', VIEW)).toEqual({
      ok: false,
      problems: ["line 2: {{access.teamDomain}} has no value in the deployment profile"],
    });
    expect(renderTemplate('"{{hostnme}}"', VIEW)).toEqual({
      ok: false,
      problems: ["line 1: {{hostnme}} has no value in the deployment profile"],
    });
  });

  it("refuses unbalanced or nested directives", () => {
    expect(renderTemplate("// {{#if access}}\nx", VIEW)).toEqual({
      ok: false,
      problems: ["line 1: {{#if access}} is never closed"],
    });
    expect(renderTemplate("x\n// {{/if}}", VIEW)).toEqual({
      ok: false,
      problems: ["line 2: {{/if}} closes nothing"],
    });
    expect(renderTemplate("// {{#if access}}\n// {{#if access}}\n// {{/if}}\n// {{/if}}", VIEW)).toEqual({
      ok: false,
      problems: ["line 2: {{#if}} blocks do not nest"],
    });
  });
});

// Feature: docs/reference/specs/release-and-deploy.md item 14 — a profile without a state
// Worker renders the bot's config without STATE_WORKER_URL.
describe("templateView / renderTemplate for a bot-only profile", () => {
  const botOnly = { ...TEST_PROFILE, workers: { bot: TEST_PROFILE.workers.bot } };

  it("the bot's view carries no state Worker URL; the Workers the profile lacks have no view", () => {
    const view = templateView(botOnly, "bot", TEST_PUBLISHED_IMAGES)!;
    expect(view.urls).toEqual({
      publicBaseUrl: "https://switchboard.example.test",
      stateWorkerUrl: undefined,
    });
    for (const kind of ["memory", "resident", "sandbox"] as const)
      expect(templateView(botOnly, kind, TEST_PUBLISHED_IMAGES)).toBeUndefined();
    expect(workerConfigTargets(botOnly).map((t) => t.kind)).toEqual(["bot"]);
  });

  it("the committed bot template renders against a bot-only profile with nothing left unfilled — its STATE_WORKER_URL line drops; the full profile keeps it", () => {
    const template = readFileSync(new URL(`../../deploy/cloudflare/${TEMPLATE_FILE}`, import.meta.url), "utf8");
    const without = renderTemplate(template, templateView(botOnly, "bot", TEST_PUBLISHED_IMAGES)!);
    expect(without.ok ? "" : without.problems.join("\n")).toBe("");
    expect(without.ok && without.text).not.toContain("STATE_WORKER_URL");
    expect(without.ok && without.text).toContain('"PUBLIC_BASE_URL": "https://switchboard.example.test"');
    const withState = renderTemplate(template, templateView(TEST_PROFILE, "bot", TEST_PUBLISHED_IMAGES)!);
    expect(withState.ok && withState.text).toContain('"STATE_WORKER_URL": "https://switchboard-memory.example.test"');
  });
});

// Feature: docs/reference/specs/execution.md item 16 — the cold per-thread
// sandbox is the platform's largest predefined instance type. The template
// carries the number and its reasoning; this test keeps the two from drifting
// apart and fails when someone steps the size down again without changing the
// spec.
describe("the sandbox Worker's container", () => {
  it("the cold per-thread sandbox runs on standard-4 — 4 vCPU / 12 GiB / 20 GB, the largest predefined type — so one thread can typecheck a large monorepo", () => {
    const template = readFileSync(new URL(`../../deploy/cloudflare-sandbox/${TEMPLATE_FILE}`, import.meta.url), "utf8");
    const rendered = renderTemplate(template, templateView(TEST_PROFILE, "sandbox", TEST_PUBLISHED_IMAGES)!);
    expect(rendered.ok ? "" : rendered.problems.join("\n")).toBe("");
    if (!rendered.ok) return;
    const config = JSON.parse(stripJsonc(rendered.text)) as { containers: Array<{ instance_type: unknown }> };
    expect(config.containers).toHaveLength(1);
    expect(config.containers[0].instance_type).toBe("standard-4");
  });
});

describe("workerConfigTargets / renderWorkerConfigs", () => {
  it("one template → one wrangler.jsonc per Worker the profile has, in deploy order; the docs site is not among them", () => {
    expect(workerConfigTargets(TEST_PROFILE).map((t) => [t.kind, t.templatePath, t.outputPath])).toEqual([
      ["memory", `deploy/cloudflare-memory/${TEMPLATE_FILE}`, `deploy/cloudflare-memory/${RENDERED_FILE}`],
      ["bot", `deploy/cloudflare/${TEMPLATE_FILE}`, `deploy/cloudflare/${RENDERED_FILE}`],
      ["resident", `deploy/cloudflare-resident/${TEMPLATE_FILE}`, `deploy/cloudflare-resident/${RENDERED_FILE}`],
      ["sandbox", `deploy/cloudflare-sandbox/${TEMPLATE_FILE}`, `deploy/cloudflare-sandbox/${RENDERED_FILE}`],
    ]);
    const { sandbox: _sandbox, ...withoutSandbox } = TEST_PROFILE.workers;
    expect(workerConfigTargets({ ...TEST_PROFILE, workers: withoutSandbox }).map((t) => t.kind)).toEqual([
      "memory",
      "bot",
      "resident",
    ]);
  });

  it("renders every target from its template; a missing template or an unresolved placeholder is a problem naming the file", () => {
    const ok = renderWorkerConfigs(
      TEST_PROFILE,
      (path) => `{ "name": "{{script}}" } // ${path}\n`,
      TEST_PUBLISHED_IMAGES,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.files.map((f) => f.path)).toEqual(workerConfigTargets(TEST_PROFILE).map((t) => t.outputPath));
      expect(ok.files[1].text).toBe(
        `${GENERATED_HEADER.join("\n")}\n{ "name": "switchboard" } // deploy/cloudflare/${TEMPLATE_FILE}\n`,
      );
    }
    const missing = renderWorkerConfigs(
      TEST_PROFILE,
      (path) => (path.includes("memory") ? undefined : "{}"),
      TEST_PUBLISHED_IMAGES,
    );
    expect(missing).toEqual({ ok: false, problems: [`deploy/cloudflare-memory/${TEMPLATE_FILE}: no such file`] });
    const bad = renderWorkerConfigs(TEST_PROFILE, () => '"{{access.aud}}"', TEST_PUBLISHED_IMAGES);
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.problems[0]).toBe(
        `deploy/cloudflare-memory/${TEMPLATE_FILE} line 1: {{access.aud}} has no value in the deployment profile`,
      );
  });

  it("renderWorkerConfig renders ONE Worker from its own template alone — other templates may be absent; its problems name that template; an unknown Worker is a problem", () => {
    const only = renderWorkerConfig(
      TEST_PROFILE,
      "memory",
      (path) => (path === `deploy/cloudflare-memory/${TEMPLATE_FILE}` ? '{ "name": "{{script}}" }\n' : undefined),
      TEST_PUBLISHED_IMAGES,
    );
    expect(only).toEqual({
      ok: true,
      path: `deploy/cloudflare-memory/${RENDERED_FILE}`,
      text: `${GENERATED_HEADER.join("\n")}\n{ "name": "switchboard-memory" }\n`,
    });
    expect(renderWorkerConfig(TEST_PROFILE, "bot", () => undefined, TEST_PUBLISHED_IMAGES)).toEqual({
      ok: false,
      problems: [`deploy/cloudflare/${TEMPLATE_FILE}: no such file`],
    });
    expect(renderWorkerConfig(TEST_PROFILE, "bot", () => '"{{access.aud}}"', TEST_PUBLISHED_IMAGES)).toEqual({
      ok: false,
      problems: [`deploy/cloudflare/${TEMPLATE_FILE} line 1: {{access.aud}} has no value in the deployment profile`],
    });
    const { sandbox: _sandbox, ...withoutSandbox } = TEST_PROFILE.workers;
    expect(
      renderWorkerConfig({ ...TEST_PROFILE, workers: withoutSandbox }, "sandbox", () => "{}", TEST_PUBLISHED_IMAGES),
    ).toEqual({
      ok: false,
      problems: ["the profile has no sandbox Worker"],
    });
  });
});

// The standing guard: every rendered wrangler.jsonc on disk (gitignored,
// written by `npm run deploy:gen` — which `npm test` runs first) IS the render
// of its template with the profile in force: the installation's own when it
// has one, else the example. A hand edit to a rendered file, or a template
// change without a re-render, fails here (and in `npm run deploy:check`).
describe("the rendered wrangler.jsonc files", () => {
  const readDisk = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
  const example = parseProfile(JSON.parse(readFileSync(PROFILE_EXAMPLE_PATH, "utf8")));
  const inForce = parseProfile(
    JSON.parse(readFileSync(existsSync(PROFILE_PATH) ? PROFILE_PATH : PROFILE_EXAMPLE_PATH, "utf8")),
  );
  const profile = inForce.ok ? inForce.profile : undefined;
  // With SWITCHBOARD_DEPLOY_PROFILE exported, the files on disk were rendered
  // from whatever it names (possibly a github:// reference this synchronous
  // test cannot read); the override path is proven in loadProfile.test.ts.
  const generated =
    profile !== undefined &&
    process.env[PROFILE_ENV] === undefined &&
    [...workerConfigTargets(profile), SITE_CONFIG_TARGET].every((t) => existsSync(t.outputPath));

  it("the four Workers' templates render against the committed example with nothing left unfilled", () => {
    if (!example.ok) throw new Error(example.problems.join("; "));
    const rendered = renderWorkerConfigs(example.profile, readDisk, TEST_PUBLISHED_IMAGES);
    expect(rendered.ok, JSON.stringify(rendered)).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.files).toHaveLength(4);
    for (const f of rendered.files) expect(f.text, f.path).not.toMatch(/\{\{|\}\}/);
  });

  it("the site's template renders against the committed project.json and the example's account: `<name>-docs` on the docs host", () => {
    if (!example.ok) throw new Error(example.problems.join("; "));
    const facts = JSON.parse(readFileSync("project.json", "utf8")) as { name: string; docs: string };
    const rendered = renderSiteConfig(example.profile, readFileSync("project.json", "utf8"), readDisk);
    expect(rendered.ok, JSON.stringify(rendered)).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
    expect(rendered.text).toContain(`"name": "${facts.name}-docs"`);
    expect(rendered.text).toContain(`"account_id": "${example.profile.account}"`);
    expect(rendered.text).toContain(`"pattern": "${new URL(facts.docs).host}"`);
  });

  it.skipIf(!generated)(
    "each generated file equals the render of its template with the profile in force, byte for byte",
    () => {
      // The files on disk were rendered by `deploy:gen` with THIS checkout's images (project.json at its version).
      const published = publishedImagesOnHost();
      if (!published.ok) throw new Error(published.problem);
      const rendered = renderWorkerConfigs(profile!, readDisk, published.images);
      expect(rendered.ok, JSON.stringify(rendered)).toBe(true);
      if (!rendered.ok) return;
      for (const f of rendered.files) expect(readFileSync(f.path, "utf8"), f.path).toBe(f.text);
      const site = renderSiteConfig(profile!, readDisk("project.json"), readDisk);
      expect(site.ok, JSON.stringify(site)).toBe(true);
      if (site.ok) expect(readFileSync(site.path, "utf8")).toBe(site.text);
    },
  );
});

// Feature: docs/reference/specs/release-and-deploy.md item 25 — a Worker's `image` is
// rendered from the profile's image mode: its Dockerfile in `build` mode, the
// release's image in the account registry in `registry` mode. The committed
// templates carry `{{image}}` for exactly the Workers with a container.
describe("the image mode in the committed templates", () => {
  const template = (dir: string) => readFileSync(new URL(`../../${dir}/${TEMPLATE_FILE}`, import.meta.url), "utf8");
  const imageOf = (text: string) => {
    const config = JSON.parse(stripJsonc(text)) as { containers?: Array<{ image: string }> };
    return config.containers?.map((c) => c.image);
  };
  const dirs = {
    bot: "deploy/cloudflare",
    resident: "deploy/cloudflare-resident",
    sandbox: "deploy/cloudflare-sandbox",
  } as const;

  it("the bot, resident and sandbox templates name `{{image}}`; the memory template has no container", () => {
    for (const dir of Object.values(dirs)) expect(template(dir), dir).toMatch(/"image": "\{\{image\}\}"/);
    expect(template("deploy/cloudflare-memory")).not.toContain("{{image}}");
    expect(templateView(TEST_PROFILE, "memory", TEST_PUBLISHED_IMAGES)).not.toHaveProperty("image");
  });

  it("`build` renders each Worker's Dockerfile — the bot's at the repository root — and `registry` the account registry's copy at the version", () => {
    for (const [kind, dir] of Object.entries(dirs) as [keyof typeof dirs, string][]) {
      const build = renderTemplate(template(dir), templateView(TEST_PROFILE, kind, TEST_PUBLISHED_IMAGES)!);
      expect(build.ok ? imageOf(build.text) : build.problems).toEqual([DOCKERFILES[kind]]);
      const registry = renderTemplate(template(dir), templateView(TEST_REGISTRY_PROFILE, kind, TEST_PUBLISHED_IMAGES)!);
      expect(registry.ok ? imageOf(registry.text) : registry.problems).toEqual([
        `registry.cloudflare.com/${TEST_PROFILE.account}/${registryName(TEST_PUBLISHED_IMAGES.names[kind])}:1.2.3`,
      ]);
    }
  });

  it("renderWorkerConfigs in registry mode leaves nothing unfilled and never names a Dockerfile", () => {
    const rendered = renderWorkerConfigs(
      TEST_REGISTRY_PROFILE,
      (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
      TEST_PUBLISHED_IMAGES,
    );
    expect(rendered.ok, JSON.stringify(rendered)).toBe(true);
    if (!rendered.ok) return;
    for (const f of rendered.files) {
      expect(f.text, f.path).not.toMatch(/\{\{|\}\}/);
      expect(f.text, f.path).not.toContain('Dockerfile"');
    }
  });
});
