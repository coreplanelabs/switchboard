export const PAIRS: { label: string; dockerfile: string; manifest: string }[];
export function imageTag(dockerfileText: string): string | null;
export function sdkPin(manifest: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): string | null;
export function pairMismatches(
  pairs: { label: string; imageTag: string | null; sdkPin: string | null }[],
): { label: string; reason: string }[];
