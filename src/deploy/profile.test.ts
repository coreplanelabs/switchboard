import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXAMPLE_ACCOUNT,
  IMAGE_MODES,
  isExampleProfile,
  parseProfile,
  PROFILE_EXAMPLE_PATH,
  profileUrls,
} from "./profile.js";
import { TEST_PROFILE } from "./testing/profile.js";

// The deployment profile: where an installation runs, as data the code reads
// and never contains. Parsing names every problem by field; the URLs the
// tooling needs are derived from it, so a hostname lives in exactly one place.

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(new URL(p, `file://${root}`), "utf8")) as unknown;

describe("parseProfile", () => {
  it("accepts the fixture and the committed example", () => {
    expect(parseProfile(TEST_PROFILE).ok).toBe(true);
    for (const p of [PROFILE_EXAMPLE_PATH]) {
      const r = parseProfile(read(p));
      expect(r.ok, p).toBe(true);
    }
  });

  it("the example is recognisable as the example, and only by its account", () => {
    const example = parseProfile(read(PROFILE_EXAMPLE_PATH));
    expect(example.ok && isExampleProfile(example.profile)).toBe(true);
    expect(isExampleProfile(TEST_PROFILE)).toBe(false);
    expect(EXAMPLE_ACCOUNT).toMatch(/^0{32}$/);
  });

  it("names each problem by its field: a bad account, a hostname with a scheme, the missing bot Worker, an unknown scheme is fine here (the source parser judges it)", () => {
    const r = parseProfile({
      ...TEST_PROFILE,
      account: "not-hex",
      workers: {
        ...TEST_PROFILE.workers,
        bot: { script: "Bot!", hostname: "https://switchboard.example.test" },
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^account: /),
        expect.stringMatching(/^workers\.bot\.script: /),
        expect.stringMatching(/^workers\.bot\.hostname: /),
      ]),
    );
    for (const p of r.problems) expect(p).not.toContain("not-hex");
    const noBot = parseProfile({ ...TEST_PROFILE, workers: { ...TEST_PROFILE.workers, bot: undefined } });
    expect(noBot.ok ? [] : noBot.problems).toEqual([expect.stringMatching(/^workers\.bot: /)]);
  });

  // Feature: docs/reference/specs/release-and-deploy.md item 14 — the bot is the one
  // required Worker; a profile leaves the others out and the tooling has no
  // step and no URL for them.
  it("memory, resident and sandbox are optional: a bot-only profile parses, and the URLs of the Workers it lacks are undefined while the bot's stand", () => {
    const botOnly = { ...TEST_PROFILE, workers: { bot: TEST_PROFILE.workers.bot } };
    expect(parseProfile(botOnly).ok).toBe(true);
    const u = profileUrls(botOnly);
    expect(u.publicBaseUrl).toBe("https://switchboard.example.test");
    expect(u.botAdminRestartUrl).toBe("https://switchboard.example.test/admin/restart");
    expect(u.healthUrl("bot")).toBe("https://switchboard.example.test/healthz");
    expect(u.stateWorkerUrl).toBeUndefined();
    expect(u.healthUrl("memory")).toBeUndefined();
    expect(u.baseUrl("sandbox")).toBeUndefined();
    const withMemory = { ...botOnly, workers: { ...botOnly.workers, memory: TEST_PROFILE.workers.memory } };
    expect(parseProfile(withMemory).ok).toBe(true);
    expect(profileUrls(withMemory).stateWorkerUrl).toBe("https://switchboard-memory.example.test");
  });

  it("a hostname outside the zone, or two Workers sharing a script name, is a problem", () => {
    const outside = parseProfile({
      ...TEST_PROFILE,
      workers: { ...TEST_PROFILE.workers, bot: { script: "switchboard", hostname: "switchboard.elsewhere.test" } },
    });
    expect(outside.ok ? [] : outside.problems).toEqual(["workers.bot.hostname: not under zone example.test"]);
    const clash = parseProfile({
      ...TEST_PROFILE,
      workers: { ...TEST_PROFILE.workers, sandbox: { script: "switchboard", hostname: "sb.example.test" } },
    });
    expect(clash.ok ? [] : clash.problems).toEqual(["workers: two Workers share a script name"]);
  });

  it("a Worker may name its own zone — a second domain the account owns — and its hostname is judged against that zone", () => {
    const ownZone = parseProfile({
      ...TEST_PROFILE,
      workers: {
        ...TEST_PROFILE.workers,
        sandbox: { script: "switchboard-sandbox", hostname: "sb.product.example", zone: "product.example" },
      },
    });
    expect(ownZone.ok).toBe(true);
    const outsideOwnZone = parseProfile({
      ...TEST_PROFILE,
      workers: {
        ...TEST_PROFILE.workers,
        sandbox: { script: "switchboard-sandbox", hostname: "sb.example.test", zone: "product.example" },
      },
    });
    expect(outsideOwnZone.ok ? [] : outsideOwnZone.problems).toEqual([
      "workers.sandbox.hostname: not under zone product.example",
    ]);
  });

  it("the docs site is not a Worker of the installation: a profile naming `workers.docs` parses with the key dropped", () => {
    // The project's site deploys from project.json's facts (wranglerTemplate.ts
    // `siteView`); a `workers.docs` entry is neither a step nor a URL.
    const withDocs = parseProfile({
      ...TEST_PROFILE,
      workers: { ...TEST_PROFILE.workers, docs: { script: "switchboard-docs", hostname: "docs.example.test" } },
    });
    expect(withDocs.ok).toBe(true);
    if (withDocs.ok) expect(Object.keys(withDocs.profile.workers)).toEqual(["memory", "bot", "resident", "sandbox"]);
  });

  it("the secrets source is optional; access is optional and strict when present", () => {
    expect(parseProfile({ ...TEST_PROFILE, secretsSource: "op://Vault/Switchboard" }).ok).toBe(true);
    expect(parseProfile({ ...TEST_PROFILE, access: { teamDomain: "team.cloudflareaccess.com", aud: "x" } }).ok).toBe(
      false,
    );
  });
});

describe("profileUrls", () => {
  it("derives every URL from the hostnames — health per Worker, the bot's public base and admin route, the state Worker", () => {
    const u = profileUrls(TEST_PROFILE);
    expect(u.healthUrl("memory")).toBe("https://switchboard-memory.example.test/healthz");
    expect(u.healthUrl("sandbox")).toBe("https://switchboard-sandbox.example.test/healthz");
    expect(u.publicBaseUrl).toBe("https://switchboard.example.test");
    expect(u.botAdminRestartUrl).toBe("https://switchboard.example.test/admin/restart");
    expect(u.stateWorkerUrl).toBe("https://switchboard-memory.example.test");
    expect(Object.keys(u).sort()).toEqual(
      ["baseUrl", "botAdminRestartUrl", "healthUrl", "publicBaseUrl", "stateWorkerUrl"].sort(),
    );
  });
});

// Feature: docs/reference/specs/release-and-deploy.md item 25 — where the container
// images come from is the profile's `images`: `build` (absent means build — the
// checkout, and this project's own production, deploy what they build) or
// `registry` (the release's images, copied into the account registry).
describe("the profile's image mode", () => {
  it("defaults to `build` when absent, keeps `registry` when named, and refuses anything else by field", () => {
    const { images: _images, ...without } = TEST_PROFILE;
    const absent = parseProfile(without);
    expect(absent.ok && absent.profile.images).toBe("build");
    const registry = parseProfile({ ...TEST_PROFILE, images: "registry" });
    expect(registry.ok && registry.profile.images).toBe("registry");
    expect(IMAGE_MODES).toEqual(["build", "registry"]);
    const bad = parseProfile({ ...TEST_PROFILE, images: "dockerhub" });
    expect(bad.ok ? [] : bad.problems).toEqual([expect.stringMatching(/^images: /)]);
  });

  it("the committed example says `registry` — the shape an installation deploying published images copies", () => {
    const example = parseProfile(read(PROFILE_EXAMPLE_PATH));
    expect(example.ok && example.profile.images).toBe("registry");
  });
});
