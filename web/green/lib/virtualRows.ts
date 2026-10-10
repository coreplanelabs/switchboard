/** Variable row heights keep long conditions readable while bounding mounted rows. */
export function rowOffsets(
  keys: readonly string[],
  heights: Readonly<Record<string, number>>,
  estimate: number,
): number[] {
  const offsets = [0];
  for (const key of keys) offsets.push(offsets[offsets.length - 1] + (heights[key] ?? estimate));
  return offsets;
}
export function visibleWindow(offsets: readonly number[], scrollTop: number, viewport: number, overscan = 4) {
  const count = offsets.length - 1;
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle + 1] <= scrollTop) low = middle + 1;
    else high = middle;
  }
  const first = low;
  let last = first;
  while (last < count && offsets[last] < scrollTop + viewport) last++;
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + overscan) };
}
