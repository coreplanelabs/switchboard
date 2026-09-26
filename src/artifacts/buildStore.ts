import type { Secrets } from "../secrets.js";
import { ARTIFACT_DEFAULTS, type ArtifactsConfig } from "./config.js";
import { R2ArtifactStore, type ArtifactStore } from "./store.js";

// The store a process runs with (docs/reference/specs/execution.md item 20):
// R2 when `artifacts:` is configured, none otherwise. Fail-closed and loud: a
// configured store with a missing secret throws at startup naming it, because a
// store that silently downgraded would leave a run believing its file was kept.

/** The three bot secrets a configured store needs; the manifest declares them optional on the bot. */
export const ARTIFACT_SECRETS = [
  "ARTIFACTS_R2_ACCESS_KEY_ID",
  "ARTIFACTS_R2_SECRET_ACCESS_KEY",
  "ARTIFACTS_COPY_TOKEN",
] as const;

export function buildArtifactStore(
  cfg: ArtifactsConfig | undefined,
  secrets: Secrets,
  opts: { copyBaseUrl: string | undefined; fetch?: typeof fetch },
): ArtifactStore | undefined {
  if (!cfg) return undefined;
  const missing = ARTIFACT_SECRETS.filter((name) => !secrets.get(name));
  if (missing.length > 0) {
    throw new Error(`artifacts: configured with ${missing.join(", ")} unset — set the secret(s) or remove the section`);
  }
  if (!opts.copyBaseUrl) {
    throw new Error(
      "artifacts: configured without PUBLIC_BASE_URL — the copy route is the bot's own Worker, reached at that URL",
    );
  }
  return new R2ArtifactStore({
    accountId: cfg.r2.accountId,
    bucket: cfg.r2.bucket,
    retentionDays: cfg.retentionDays,
    accessKeyId: secrets.get("ARTIFACTS_R2_ACCESS_KEY_ID")!,
    secretAccessKey: secrets.get("ARTIFACTS_R2_SECRET_ACCESS_KEY")!,
    copy: {
      baseUrl: opts.copyBaseUrl,
      token: secrets.get("ARTIFACTS_COPY_TOKEN")!,
      timeoutMs: cfg.inbound?.copyTimeoutMs ?? ARTIFACT_DEFAULTS.copyTimeoutMs,
    },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}
