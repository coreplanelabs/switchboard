export const PAIRS: { label: string; dockerfile: string; manifest: string }[];
export function imageTag(dockerfileText: string): string | null;
export function sdkPin(manifest: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): string | null;
export function pairMismatches(
  pairs: { label: string; imageTag: string | null; sdkPin: string | null }[],
): { label: string; reason: string }[];
export function installMismatches(
  pairs: { label: string; sdkPin: string | null; installed: string | null }[],
): { label: string; reason: string }[];
export function installedSdkVersion(manifestPath: string): string | null;
