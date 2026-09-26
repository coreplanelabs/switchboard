import { describe, expect, it } from "vitest";
import { secretsFrom } from "../secrets.js";
import { ARTIFACT_SECRETS, buildArtifactStore } from "./buildStore.js";
import { R2ArtifactStore } from "./store.js";

// Feature: docs/reference/specs/execution.md item 20 — the store a process runs
// with: none without the section; R2 with it; and a configured store with a
// missing secret or no public URL fails startup by name, never downgrades.

const cfg = { r2: { accountId: "acme-account", bucket: "switchboard-artifacts" } };
const all = {
  ARTIFACTS_R2_ACCESS_KEY_ID: "example-access-key",
  ARTIFACTS_R2_SECRET_ACCESS_KEY: "secret",
  ARTIFACTS_COPY_TOKEN: "copy-bearer",
};

describe("buildArtifactStore (item 20)", () => {
  it("no section → no store, whatever the secrets say", () => {
    expect(buildArtifactStore(undefined, secretsFrom(all), { copyBaseUrl: "https://bot.example.com" })).toBeUndefined();
    expect(buildArtifactStore(undefined, secretsFrom({}), { copyBaseUrl: undefined })).toBeUndefined();
  });

  it("the section with all three secrets and a public URL → the R2 store on the configured bucket", () => {
    const store = buildArtifactStore(cfg, secretsFrom(all), { copyBaseUrl: "https://bot.example.com" });
    expect(store).toBeInstanceOf(R2ArtifactStore);
    expect(store!.bucket).toBe("switchboard-artifacts");
  });

  it("publication receives configured retention or the artifact default", async () => {
    for (const retentionDays of [undefined, 2]) {
      const requests: Request[] = [];
      const store = buildArtifactStore({ ...cfg, retentionDays }, secretsFrom(all), {
        copyBaseUrl: "https://bot.example.com",
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          return Response.json({ path: "/pr-images/12345678-1234-4123-8123-123456789abc.png" });
        },
      });
      await store!.publishPrImage("runs/r1/out/1-shot.png");
      expect(await requests[0]!.json()).toEqual({ key: "runs/r1/out/1-shot.png", retentionDays: retentionDays ?? 30 });
    }
  });

  it("a missing secret fails by name — one or all three — and so does a missing PUBLIC_BASE_URL", () => {
    expect(ARTIFACT_SECRETS).toEqual([
      "ARTIFACTS_R2_ACCESS_KEY_ID",
      "ARTIFACTS_R2_SECRET_ACCESS_KEY",
      "ARTIFACTS_COPY_TOKEN",
    ]);
    const { ARTIFACTS_COPY_TOKEN: _dropped, ...twoOfThree } = all;
    expect(() => buildArtifactStore(cfg, secretsFrom(twoOfThree), { copyBaseUrl: "https://bot.example.com" })).toThrow(
      "artifacts: configured with ARTIFACTS_COPY_TOKEN unset — set the secret(s) or remove the section",
    );
    expect(() => buildArtifactStore(cfg, secretsFrom({}), { copyBaseUrl: "https://bot.example.com" })).toThrow(
      /ARTIFACTS_R2_ACCESS_KEY_ID, ARTIFACTS_R2_SECRET_ACCESS_KEY, ARTIFACTS_COPY_TOKEN unset/,
    );
    expect(() => buildArtifactStore(cfg, secretsFrom(all), { copyBaseUrl: undefined })).toThrow(
      /configured without PUBLIC_BASE_URL/,
    );
  });
});
