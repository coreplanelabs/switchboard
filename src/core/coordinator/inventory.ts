import { isCoordinatorInstance, type CoordinatorInstance } from "./contract.js";

export interface PipelineInventoryPage {
  items: CoordinatorInstance[];
  cursor?: string;
  /** Re-read this page under its original insertion watermark. */
  resumeCursor?: string;
}
export interface PipelineInventoryQuery {
  limit: number;
  cursor?: string;
  order?: "key";
}
/** A fixed insertion watermark prevents later additions from extending a census forever. */
export function inventoryPosition(
  input: PipelineInventoryQuery,
  watermark: number,
): { after: number; through: number } {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200)
    throw new Error("pipeline inventory limit invalid");
  if (input.order !== undefined && input.order !== "key") throw new Error("pipeline inventory order invalid");
  if (input.cursor === undefined) return { after: 0, through: watermark };
  try {
    if (input.cursor.length > 200) throw new Error();
    const value = JSON.parse(atob(input.cursor));
    if (
      Object.keys(value).sort().join() !== (input.order === "key" ? "after,order,through" : "after,through") ||
      value.order !== input.order ||
      !Number.isSafeInteger(value.after) ||
      !Number.isSafeInteger(value.through) ||
      value.after < 0 ||
      value.after >= value.through ||
      value.through > watermark
    )
      throw new Error();
    return value;
  } catch {
    throw new Error("pipeline inventory cursor invalid");
  }
}
export function inventoryCursor(after: number, through: number, order?: "key"): string | undefined {
  return after < through ? btoa(JSON.stringify({ after, through, ...(order ? { order } : {}) })) : undefined;
}
export function readInventoryPage(value: unknown): PipelineInventoryPage {
  const page = value as PipelineInventoryPage;
  if (
    !page ||
    !Array.isArray(page.items) ||
    !page.items.every(isCoordinatorInstance) ||
    (page.cursor !== undefined && typeof page.cursor !== "string") ||
    (page.resumeCursor !== undefined && typeof page.resumeCursor !== "string")
  )
    throw new Error("pipeline inventory response invalid");
  return page;
}
