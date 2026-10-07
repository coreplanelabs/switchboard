export const MARKER: string;
export const FOOTER: string;
export type TargetSelector =
  | { kind: "affected" | "all"; label: string; args: string[] }
  | { kind: "only"; label: string; names: string[]; args: string[] };
export function parseTargetSelector(value?: string): TargetSelector;
export function releaseTargetTable(plan: unknown, selector: TargetSelector): string;
export function summaryBlock(releasePr: boolean, table: string): string;
export function commentBody(table: string, selector?: TargetSelector): string;
