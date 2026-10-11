export const HISTORICAL_SOURCE_LINKS: readonly {
  document: string;
  path: string;
  commit: string;
}[];
export function repositorySourceLink(
  document: string,
  href: string,
  repository: string,
): { path: string; ref: string; href: string } | undefined;
