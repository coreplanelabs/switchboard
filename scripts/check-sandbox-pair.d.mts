export const PAIRS: { label: string; dockerfile: string; manifest: string }[];
export function imageTag(dockerfileText: string): string | null;
export function sdkPin(manifest: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): string | null;
export function lockfileSdkVersion(
  lockfile: { packages?: Record<string, { version?: string }> },
  workspacePath: string,
): string | null;
export function pairMismatches(
  pairs: { label: string; imageTag: string | null; sdkPin: string | null; locked?: string | null }[],
): { label: string; reason: string }[];
export function installAdvisories(
  pairs: { label: string; locked?: string | null; installed: string | null }[],
): string[];
export function installedSdkVersion(manifestPath: string, repoRoot?: string): string | null;
