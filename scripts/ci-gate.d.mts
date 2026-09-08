export interface NeedsJob {
  result: "success" | "failure" | "cancelled" | "skipped" | string;
  outputs?: Record<string, string>;
}
export function failedJobs(needs: Record<string, NeedsJob | undefined>): { id: string; result: string }[];
export function parseNeeds(raw: string | undefined): Record<string, NeedsJob>;
