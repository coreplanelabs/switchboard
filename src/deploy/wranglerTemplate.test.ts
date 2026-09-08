import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseProfile, PROFILE_ENV, PROFILE_EXAMPLE_PATH, PROFILE_PATH, type DeploymentProfile } from "./profile.js";
import { TEST_PROFILE } from "./testing/profile.js";
import {
  GENERATED_HEADER,
  RENDERED_FILE,
  renderTemplate,
  renderWorkerConfigs,
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
    const view = templateView(TEST_PROFILE, "resident");
    expect(view).toEqual({
      account: TEST_PROFILE.account,
      zone: "example.test",
      script: "switchboard-resident",
      hostname: "switchboard-resident.example.test",
      urls: {
        publicBaseUrl: "https://switchboard.example.test",
        stateWorkerUrl: "https://switchboard-memory.example.test",
      },
      access: undefined,
    });
  });

  it("carries the Access application when the profile has one, and is undefined for a Worker the profile lacks", () => {
    const withAccess: DeploymentProfile = {
      ...TEST_PROFILE,
      access: { teamDomain: "acme.cloudflareaccess.com", aud: "a".repeat(64) },
    };
    expect(templateView(withAccess, "bot")?.access).toEqual({
      teamDomain: "acme.cloudflareaccess.com",
      aud: "a".repeat(64),
    });
    const { docs: _docs, ...withoutDocs } = TEST_PROFILE.workers;
    expect(templateView({ ...TEST_PROFILE, workers: withoutDocs }, "docs")).toBeUndefined();
  });
});

const VIEW = templateView(TEST_PROFILE, "bot")!;

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

describe("workerConfigTargets / renderWorkerConfigs", () => {
  it("one template → one wrangler.jsonc per Worker the profile has, the docs Worker included only when present", () => {
    expect(workerConfigTargets(TEST_PROFILE).map((t) => [t.kind, t.templatePath, t.outputPath])).toEqual([
      ["memory", `deploy/cloudflare-memory/${TEMPLATE_FILE}`, `deploy/cloudflare-memory/${RENDERED_FILE}`],
      ["bot", `deploy/cloudflare/${TEMPLATE_FILE}`, `deploy/cloudflare/${RENDERED_FILE}`],
      ["resident", `deploy/cloudflare-resident/${TEMPLATE_FILE}`, `deploy/cloudflare-resident/${RENDERED_FILE}`],
      ["sandbox", `deploy/cloudflare-sandbox/${TEMPLATE_FILE}`, `deploy/cloudflare-sandbox/${RENDERED_FILE}`],
      ["docs", `deploy/cloudflare-docs/${TEMPLATE_FILE}`, `deploy/cloudflare-docs/${RENDERED_FILE}`],
    ]);
    const { docs: _docs, ...withoutDocs } = TEST_PROFILE.workers;
    expect(workerConfigTargets({ ...TEST_PROFILE, workers: withoutDocs }).map((t) => t.kind)).toEqual([
      "memory",
      "bot",
      "resident",
      "sandbox",
    ]);
  });

  it("renders every target from its template; a missing template or an unresolved placeholder is a problem naming the file", () => {
    const ok = renderWorkerConfigs(TEST_PROFILE, (path) => `{ "name": "{{script}}" } // ${path}\n`);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.files.map((f) => f.path)).toEqual(workerConfigTargets(TEST_PROFILE).map((t) => t.outputPath));
      expect(ok.files[1].text).toBe(
        `${GENERATED_HEADER.join("\n")}\n{ "name": "switchboard" } // deploy/cloudflare/${TEMPLATE_FILE}\n`,
      );
    }
    const missing = renderWorkerConfigs(TEST_PROFILE, (path) => (path.includes("memory") ? undefined : "{}"));
    expect(missing).toEqual({ ok: false, problems: [`deploy/cloudflare-memory/${TEMPLATE_FILE}: no such file`] });
    const bad = renderWorkerConfigs(TEST_PROFILE, () => '"{{access.aud}}"');
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.problems[0]).toBe(
        `deploy/cloudflare-memory/${TEMPLATE_FILE} line 1: {{access.aud}} has no value in the deployment profile`,
      );
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
    workerConfigTargets(profile).every((t) => existsSync(t.outputPath));

  it("the five templates render against the committed example with nothing left unfilled", () => {
    if (!example.ok) throw new Error(example.problems.join("; "));
    const rendered = renderWorkerConfigs(example.profile, readDisk);
    expect(rendered.ok, JSON.stringify(rendered)).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.files).toHaveLength(5);
    for (const f of rendered.files) expect(f.text, f.path).not.toMatch(/\{\{|\}\}/);
  });

  it.skipIf(!generated)(
    "each generated file equals the render of its template with the profile in force, byte for byte",
    () => {
      const rendered = renderWorkerConfigs(profile!, readDisk);
      expect(rendered.ok, JSON.stringify(rendered)).toBe(true);
      if (!rendered.ok) return;
      for (const f of rendered.files) expect(readFileSync(f.path, "utf8"), f.path).toBe(f.text);
    },
  );
});
