import { describe, expect, it } from "vitest";
import { parseAppConfigText } from "../config.js";
import { ARTIFACT_DEFAULTS, validateArtifacts } from "./config.js";

// Feature: docs/reference/specs/execution.md item 20 — the `artifacts:` section:
// present, it turns the store on and every knob is checked at load; absent, the
// store is off. A typo is refused by name, never read as a working setting.

const BASE = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
`;

describe("the artifacts config section (item 20)", () => {
  it("parses the documented block and leaves the defaults to the code", () => {
    const cfg = parseAppConfigText(
      BASE +
        `
artifacts:
  r2:
    accountId: acme-account
    bucket: switchboard-artifacts
  retentionDays: 30
  inbound:
    maxBytesPerMessage: 2147483648
    copyTimeoutMs: 1200000
`,
    );
    expect(cfg.artifacts).toEqual({
      r2: { accountId: "acme-account", bucket: "switchboard-artifacts" },
      retentionDays: 30,
      inbound: { maxBytesPerMessage: 2_147_483_648, copyTimeoutMs: 1_200_000 },
    });
    expect(parseAppConfigText(BASE).artifacts).toBeUndefined();
    expect(ARTIFACT_DEFAULTS).toEqual({
      retentionDays: 30,
      maxBytesPerMessage: 2 * 1024 * 1024 * 1024,
      copyTimeoutMs: 20 * 60_000,
      presignTtlSeconds: 600,
    });
  });

  it("refuses an unknown key at every level, a missing bucket or account, a bad bucket name and a non-integer knob, each by name", () => {
    const r2 = { accountId: "acme-account", bucket: "switchboard-artifacts" };
    expect(() => validateArtifacts({ r2, foo: 1 } as never)).toThrow("artifacts.foo is not a known key");
    expect(() => validateArtifacts({ r2: { ...r2, region: "auto" } } as never)).toThrow(
      "artifacts.r2.region is not a known key",
    );
    expect(() => validateArtifacts({ r2: { accountId: r2.accountId } } as never)).toThrow(
      "artifacts.r2.bucket must be a non-empty string",
    );
    expect(() => validateArtifacts({ r2: { ...r2, bucket: "Switchboard Artifacts" } })).toThrow(/valid bucket name/);
    expect(() => validateArtifacts({ r2, retentionDays: "30d" } as never)).toThrow(
      "artifacts.retentionDays must be an integer >= 1",
    );
    expect(() => validateArtifacts({ r2, inbound: { copyTimeoutMs: 0 } })).toThrow(
      "artifacts.inbound.copyTimeoutMs must be an integer >= 1",
    );
    expect(() => validateArtifacts({ r2, inbound: { maxBytes: 1 } } as never)).toThrow(
      "artifacts.inbound.maxBytes is not a known key",
    );
    expect(() => parseAppConfigText(BASE + "artifacts:\n  r2:\n    bucket: b\n")).toThrow(
      /artifacts\.r2\.accountId must be a non-empty string/,
    );
  });
});
