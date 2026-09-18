export interface LockPackage {
  optional?: boolean;
  devOptional?: boolean;
  link?: boolean;
}
export function expectedPackagePaths(packages: Record<string, LockPackage>): string[];
export function nodeModulesRoots(packages: Record<string, LockPackage>): string[];
export function extraneousEntries(
  root: string,
  entries: readonly string[],
  packages: Record<string, LockPackage>,
): string[];
export function evaluateDepsDrift(
  packages: Record<string, LockPackage>,
  disk: { exists: (path: string) => boolean; list: (root: string) => string[] | null },
): { missing: string[]; extraneous: string[]; checked: number };
