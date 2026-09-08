import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WORKER_SPECS } from "./plan.js";
import {
  DEFAULT_SECRETS_DIR,
  MANIFEST_PATH,
  parseManifest,
  parseSecretsSource,
  planSecretPuts,
  secretRef,
  wranglerFailureLine,
  type SecretsManifest,
} from "./secrets.js";

const dirOf = (name: string) => WORKER_SPECS.find((w) => w.name === name)!.dir;

// Which secrets a Worker holds is the manifest's; where the values come from is
// the profile's `secretsSource`; the plan joins the two and refuses before any
// upload when a required value is absent.

describe("parseManifest", () => {
  it("accepts the committed manifest", () => {
    const parsed = parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")));
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  });

  it("names problems by field: a lowercase name, an unknown Worker, an empty Worker list, a duplicate", () => {
    const bad = parseManifest({
      secrets: [
        { name: "lower", workers: ["bot"] },
        { name: "A", workers: ["edge"] },
        { name: "B", workers: [] },
      ],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.problems.some((p) => p.startsWith("secrets.0.name:"))).toBe(true);
      expect(bad.problems.some((p) => p.startsWith("secrets.1.workers.0:"))).toBe(true);
      expect(bad.problems.some((p) => p.startsWith("secrets.2.workers:"))).toBe(true);
    }
    expect(
      parseManifest({
        secrets: [
          { name: "A", workers: ["bot"] },
          { name: "A", workers: ["memory"] },
        ],
      }),
    ).toEqual({ ok: false, problems: ["secrets: duplicate name(s) A"] });
  });
});

describe("parseSecretsSource / secretRef", () => {
  it("the default is a directory of <NAME> files; a path is a directory; an op item reference is an item whose fields are the secrets", () => {
    expect(parseSecretsSource(undefined)).toEqual({ ok: true, source: { kind: "dir", path: DEFAULT_SECRETS_DIR } });
    expect(parseSecretsSource("/etc/switchboard/secrets")).toEqual({
      ok: true,
      source: { kind: "dir", path: "/etc/switchboard/secrets" },
    });
    expect(parseSecretsSource("op://Acme/Switchboard secrets")).toEqual({
      ok: true,
      source: { kind: "op", vault: "Acme", item: "Switchboard secrets" },
    });
    expect(secretRef({ kind: "dir", path: "~/.secrets/switchboard" }, "MEMORY_TOKEN")).toBe(
      "~/.secrets/switchboard/MEMORY_TOKEN",
    );
    expect(secretRef({ kind: "op", vault: "Acme", item: "Switchboard secrets" }, "MEMORY_TOKEN")).toBe(
      "op://Acme/Switchboard secrets/MEMORY_TOKEN",
    );
  });

  it("refuses an empty value, an op reference with a field or without an item, and an unknown scheme", () => {
    expect(parseSecretsSource("  ")).toEqual({ ok: false, problem: "secretsSource is empty" });
    expect(parseSecretsSource("op://Acme/Item/FIELD")).toMatchObject({
      ok: false,
      problem: expect.stringContaining("expected op://Vault/Item"),
    });
    expect(parseSecretsSource("op://Acme")).toMatchObject({ ok: false });
    expect(parseSecretsSource("s3://bucket/prefix")).toMatchObject({
      ok: false,
      problem: expect.stringContaining("unknown scheme"),
    });
  });
});

describe("planSecretPuts", () => {
  const m: SecretsManifest = {
    secrets: [
      { name: "A", workers: ["bot", "resident"] },
      { name: "B", workers: ["bot"], optional: true },
      { name: "C", workers: ["memory"] },
    ],
  };
  const present = (...names: string[]) => new Set(names);

  it("selects the Worker's secrets in manifest order, bound to the Worker's directory", () => {
    expect(planSecretPuts(m, "bot", present("A", "B"))).toEqual({
      ok: true,
      plan: { worker: "bot", dir: dirOf("bot"), puts: ["A", "B"], skippedOptional: [], missing: [] },
    });
    expect(planSecretPuts(m, "resident", present("A"))).toEqual({
      ok: true,
      plan: { worker: "resident", dir: dirOf("resident"), puts: ["A"], skippedOptional: [], missing: [] },
    });
  });

  it("a required secret with no value is `missing`, never silently skipped; an optional one is skipped and named", () => {
    expect(planSecretPuts(m, "bot", present("B"))).toMatchObject({ ok: true, plan: { puts: ["B"], missing: ["A"] } });
    expect(planSecretPuts(m, "bot", present("A"))).toMatchObject({
      ok: true,
      plan: { puts: ["A"], skippedOptional: ["B"], missing: [] },
    });
  });

  it("`only` narrows the put; a name that is not one of the Worker's secrets is a problem naming the manifest's", () => {
    expect(planSecretPuts(m, "bot", present("A", "B"), ["B"])).toMatchObject({ ok: true, plan: { puts: ["B"] } });
    expect(planSecretPuts(m, "bot", present("A"), ["C"])).toEqual({
      ok: false,
      problem: "C is not a bot secret (manifest: A, B)",
    });
    expect(planSecretPuts(m, "bot", present("A"), ["C", "NOPE"])).toEqual({
      ok: false,
      problem: "C, NOPE are not bot secrets (manifest: A, B)",
    });
  });
});

describe("wranglerFailureLine — what a failed `wrangler secret put` gets quoted as", () => {
  it("prefers the [ERROR] line(s), without the ✘ glyph — an authentication error names the API call and the code", () => {
    const out = [
      "⛅️ wrangler 4.129.1",
      "────────────────────",
      "✘ [ERROR] A request to the Cloudflare API (/accounts/abc/workers/scripts/switchboard/secrets) failed.",
      "  Authentication error [code: 10000]",
      "📎 It looks like you are authenticating Wrangler via a custom API token set in an environment variable.",
      '🪵  Logs were written to "/Users/me/Library/Preferences/.wrangler/logs/wrangler-<date>.log"',
    ].join("\n");
    expect(wranglerFailureLine(out)).toBe(
      "[ERROR] A request to the Cloudflare API (/accounts/abc/workers/scripts/switchboard/secrets) failed.",
    );
    expect(wranglerFailureLine("✘ [ERROR] Required Worker name missing. Please specify the Worker name")).toBe(
      "[ERROR] Required Worker name missing. Please specify the Worker name",
    );
  });

  it("falls back to the last non-empty line, and to nothing for empty output", () => {
    expect(wranglerFailureLine("something\n\nlast words\n\n")).toBe("last words");
    expect(wranglerFailureLine("")).toBe("");
  });
});
