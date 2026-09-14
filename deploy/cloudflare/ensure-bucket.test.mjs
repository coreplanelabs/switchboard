import { describe, expect, it } from "vitest";
import { bucketNamesOf, decide } from "./ensure-bucket.mjs";

// Feature: docs/reference/specs/execution.md item 20 (record 0033) — `npm run
// deploy` creates the buckets the rendered config binds before wrangler
// validates them; a bucket that already exists is success, any other refusal
// is wrangler's own and stops the deploy.

describe("ensure-bucket — bucketNamesOf()", () => {
  it("reads every distinct bucket_name from the rendered JSONC and nothing from a config without r2_buckets", () => {
    const rendered = [
      "// generated",
      "{",
      '  "r2_buckets": [{ "binding": "ARTIFACTS", "bucket_name": "switchboard-artifacts" }],',
      '  "vars": { "ARTIFACTS_BUCKET_NAME": "switchboard-artifacts" }',
      "}",
    ].join("\n");
    expect(bucketNamesOf(rendered)).toEqual(["switchboard-artifacts"]);
    expect(bucketNamesOf('{ "vars": { "PUBLIC_BASE_URL": "https://x" } }')).toEqual([]);
    expect(bucketNamesOf('"bucket_name": "a"\n"bucket_name":"b"\n"bucket_name": "a"')).toEqual(["a", "b"]);
  });
});

describe("ensure-bucket — decide()", () => {
  it("exit 0 is created; wrangler's 'already exists' (code 10004) is success too; anything else is wrangler's refusal verbatim", () => {
    expect(decide("switchboard-artifacts", 0, "Created bucket 'switchboard-artifacts'")).toEqual({
      ok: true,
      kind: "created",
      name: "switchboard-artifacts",
    });
    expect(
      decide(
        "switchboard-artifacts",
        1,
        "✘ [ERROR] A request to the Cloudflare API (/accounts/x/r2/buckets) failed.\n\n  The bucket you tried to create already exists, and you own it. [code: 10004]",
      ),
    ).toEqual({ ok: true, kind: "exists", name: "switchboard-artifacts" });
    expect(decide("switchboard-artifacts", 1, "\n  Authentication error [code: 10000]\n")).toEqual({
      ok: false,
      name: "switchboard-artifacts",
      reason: "Authentication error [code: 10000]",
    });
    expect(decide("b", 3, "")).toEqual({ ok: false, name: "b", reason: "wrangler exited 3" });
  });
});
