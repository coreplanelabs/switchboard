export const REQUIRED_VARIANTS: Record<string, string[]>;
export function missingVariants(
  packagePaths: string[],
  required?: Record<string, string[]>,
): { family: string; variant: string }[];

/** A package.json or a lockfile `packages[…]` record: the fields npm mirrors, loosely typed. */
export type PackageRecord = Record<string, unknown>;

export const MIRRORED_FIELDS: string[];
/** Either side may be absent: an unread manifest or a record npm never wrote
 *  compares as having none of the mirrored fields. */
export function manifestDrift(
  manifest: PackageRecord | undefined,
  record: PackageRecord | undefined,
  fields?: string[],
): { field: string; manifest: unknown; lockfile: unknown }[];
export function recordsToMirror(
  rootManifest: PackageRecord,
  lock: { packages?: Record<string, PackageRecord> },
  readManifest: (dir: string) => PackageRecord | undefined,
): { path: string; manifest: PackageRecord | undefined; record: PackageRecord | undefined }[];
