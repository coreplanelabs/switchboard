export const ALLOWED_LICENSES: string[];
export const EXCEPTIONS: Record<string, string>;
export interface LicenseReportEntry {
  licenses?: string | string[];
  path?: string;
  repository?: string;
}
export interface Offending {
  id: string;
  licenses: string;
  path: string;
}
export function evaluate(
  report: Record<string, LicenseReportEntry>,
  options?: { allowed?: string[]; exceptions?: Record<string, string> },
): Offending[];
export interface NpmLsNode {
  name?: string;
  version?: string;
  path?: string;
  license?: unknown;
  extraneous?: boolean;
  dependencies?: Record<string, NpmLsNode>;
}
export function reportFromNpmLs(tree: NpmLsNode): Record<string, LicenseReportEntry>;
