import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Console } from "node:console";
import { Writable } from "node:stream";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREDENTIAL_FALLBACKS, processSecrets, publicEnv, Secret, SECRET_NAMES, secretsFrom } from "./secrets.js";
import { redactSecrets } from "./core/redact.js";
import { MANIFEST_PATH } from "./deploy/secrets.js";

// Feature: docs/reference/specs/routing-and-config.md item 19 — every credential
// the process reads from its environment is a `Secret`: the value comes out
// through `reveal()` and nowhere else, so a wrapped value cannot reach a log
// line, a JSON body, an error message or a command by accident.

const VALUE = "xoxb-1234567890-the-actual-token-value";
const secret = new Secret(VALUE, "SLACK_BOT_TOKEN");

describe("Secret — the value leaves through reveal() only", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reveal() is the value", () => {
    expect(secret.reveal()).toBe(VALUE);
    expect(secret.name).toBe("SLACK_BOT_TOKEN");
  });

  it("a template literal, concatenation and String() render the placeholder", () => {
    expect(`${secret}`).toBe("[secret:SLACK_BOT_TOKEN]");
    expect("token=" + secret).toBe("token=[secret:SLACK_BOT_TOKEN]");
    expect(String(secret)).toBe("[secret:SLACK_BOT_TOKEN]");
    expect(secret.valueOf()).toBe("[secret:SLACK_BOT_TOKEN]");
  });

  it("JSON.stringify — alone, nested, in an array — never carries the value", () => {
    for (const json of [JSON.stringify(secret), JSON.stringify({ secret }), JSON.stringify([secret, { a: secret }])]) {
      expect(json).not.toContain(VALUE);
      expect(json).toContain("[secret:SLACK_BOT_TOKEN]");
    }
  });

  it("util.inspect and console.log (what reaches stdout) show the placeholder", () => {
    expect(inspect(secret)).toBe("[secret:SLACK_BOT_TOKEN]");
    expect(inspect({ nested: secret }, { depth: 5, showHidden: true })).not.toContain(VALUE);
    // A Console on a captured stream is console.log's own path to stdout (vitest
    // intercepts the global console, so the global one cannot be observed).
    const written: string[] = [];
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        written.push(String(chunk));
        cb();
      },
    });
    const console = new Console({ stdout, stderr: stdout });
    console.log(secret);
    console.log("bearer:", secret, { secret });
    console.error(`${secret}`);
    console.log("%s %o", secret, secret);
    expect(written.join("")).not.toContain(VALUE);
    expect(written.join("")).toContain("[secret:SLACK_BOT_TOKEN]");
  });

  it("an Error built from a secret carries the placeholder in its message and its stack", () => {
    const err = new Error(`auth failed for ${secret}`);
    expect(err.message).toBe("auth failed for [secret:SLACK_BOT_TOKEN]");
    expect(err.stack).not.toContain(VALUE);
  });

  it("reflection finds nothing: no own value property, frozen, spread and structuredClone copy the name only", () => {
    expect(Object.keys(secret)).toEqual(["name"]);
    expect(Object.getOwnPropertyNames(secret)).toEqual(["name"]);
    expect(Object.isFrozen(secret)).toBe(true);
    expect(JSON.stringify({ ...secret })).toBe('{"name":"SLACK_BOT_TOKEN"}');
    expect(JSON.stringify(structuredClone(secret))).toBe('{"name":"SLACK_BOT_TOKEN"}');
  });

  it("the run stream's redaction net never sees the value — a wrapped value needs no redaction, and its placeholder passes the net value-free", () => {
    const line = `Authorization: Bearer ${secret}`;
    expect(line).not.toContain(VALUE);
    const redacted = redactSecrets(line);
    expect(redacted).not.toContain(VALUE);
    expect(redacted).toContain("[secret:");
  });
});

describe("SECRET_NAMES — one list, the manifest's", () => {
  it("is every name in deploy/secrets.manifest.json plus the documented dev fallbacks", () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", MANIFEST_PATH), "utf8")) as {
      secrets: Array<{ name: string }>;
    };
    const expected = new Set([...manifest.secrets.map((s) => s.name), ...CREDENTIAL_FALLBACKS]);
    expect(SECRET_NAMES).toEqual(expected);
    expect(SECRET_NAMES.has("SLACK_BOT_TOKEN")).toBe(true);
    expect(SECRET_NAMES.has("GH_TOKEN")).toBe(true);
    expect(SECRET_NAMES.has("PORT")).toBe(false);
  });
});

describe("secretsFrom — reading an environment", () => {
  const env = {
    SLACK_BOT_TOKEN: VALUE,
    MEMORY_TOKEN: "  ",
    MY_CUSTOM_BEARER: "custom-value",
    PORT: "3000",
  };
  const s = secretsFrom(env);

  it("get(<manifest name>) wraps the value under that name; unset and blank are undefined", () => {
    const got = s.get("SLACK_BOT_TOKEN");
    expect(got).toBeInstanceOf(Secret);
    expect(got?.name).toBe("SLACK_BOT_TOKEN");
    expect(got?.reveal()).toBe(VALUE);
    expect(s.get("SLACK_APP_TOKEN")).toBeUndefined();
    expect(s.get("MEMORY_TOKEN")).toBeUndefined();
  });

  it("get(<a name the manifest does not list>) is a programming error naming the manifest", () => {
    expect(() => s.get("MY_CUSTOM_BEARER")).toThrow(
      /MY_CUSTOM_BEARER is not a secret deploy\/secrets\.manifest\.json names/,
    );
    expect(() => s.get("PORT")).toThrow(/PORT is not a secret/);
  });

  it("require() fails by name when the secret is unset", () => {
    expect(s.require("SLACK_BOT_TOKEN").reveal()).toBe(VALUE);
    expect(() => s.require("SLACK_APP_TOKEN")).toThrow(/^SLACK_APP_TOKEN is not set$/);
    expect(() => s.require("MEMORY_TOKEN")).toThrow(/^MEMORY_TOKEN is not set$/);
  });

  it("trims the value at read time: a token with a trailing newline (the `.env` / secret-store shape) is the bare token; whitespace alone is absent", () => {
    const trimmed = secretsFrom({ MEMORY_TOKEN: "tok-with-newline\n", SANDBOX_TOKEN: "  padded \t", CUSTOM: "\nx\n" });
    expect(trimmed.get("MEMORY_TOKEN")?.reveal()).toBe("tok-with-newline");
    expect(trimmed.get("SANDBOX_TOKEN")?.reveal()).toBe("padded");
    expect(trimmed.named("CUSTOM")?.reveal()).toBe("x");
    expect(trimmed.require("MEMORY_TOKEN").reveal()).toBe("tok-with-newline");
    expect(secretsFrom({ MEMORY_TOKEN: "\n \t" }).get("MEMORY_TOKEN")).toBeUndefined();
  });

  it("named(<a variable the operator's config names>) wraps any variable — apiKeyEnv, tokenEnv, credentialKeyEnv", () => {
    expect(s.named("MY_CUSTOM_BEARER")?.reveal()).toBe("custom-value");
    expect(s.named("MY_CUSTOM_BEARER")?.name).toBe("MY_CUSTOM_BEARER");
    expect(s.named("SLACK_BOT_TOKEN")?.reveal()).toBe(VALUE);
    expect(s.named("NOT_SET")).toBeUndefined();
    expect(s.named("MEMORY_TOKEN")).toBeUndefined();
  });

  it("reads at call time, so a value set after construction is seen (the process-wide `processSecrets` follows process.env)", () => {
    const live: Record<string, string | undefined> = {};
    const late = secretsFrom(live);
    expect(late.get("SANDBOX_TOKEN")).toBeUndefined();
    live.SANDBOX_TOKEN = "later";
    expect(late.get("SANDBOX_TOKEN")?.reveal()).toBe("later");
    vi.stubEnv("SANDBOX_TOKEN", "from-process-env");
    expect(processSecrets.get("SANDBOX_TOKEN")?.reveal()).toBe("from-process-env");
    vi.unstubAllEnvs();
  });
});

describe("publicEnv — the environment without its secrets", () => {
  it("drops every secret name, keeps everything else, and is frozen", () => {
    const pub = publicEnv({
      SLACK_BOT_TOKEN: VALUE,
      GH_TOKEN: "ghp_x",
      SWITCHBOARD_INGRESS_TOKENS: "{}",
      PORT: "3000",
      SWITCHBOARD_CONFIG: "./config/config.yaml",
      PUBLIC_BASE_URL: "https://bot.example",
    });
    expect(pub).toEqual({
      PORT: "3000",
      SWITCHBOARD_CONFIG: "./config/config.yaml",
      PUBLIC_BASE_URL: "https://bot.example",
    });
    expect(Object.isFrozen(pub)).toBe(true);
    expect(JSON.stringify(pub)).not.toContain(VALUE);
  });

  it("defaults to process.env", () => {
    vi.stubEnv("SLACK_BOT_TOKEN", VALUE);
    vi.stubEnv("SWITCHBOARD_TEST_PUBLIC", "visible");
    const pub = publicEnv();
    expect(pub.SLACK_BOT_TOKEN).toBeUndefined();
    expect(pub.SWITCHBOARD_TEST_PUBLIC).toBe("visible");
    vi.unstubAllEnvs();
  });
});
