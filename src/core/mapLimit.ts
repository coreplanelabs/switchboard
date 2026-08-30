/**
 * `Promise.all(items.map(fn))` with at most `limit` calls in flight at once.
 * Results land in input order; the first rejection rejects the whole map (start
 * nothing new after it), like `Promise.all`. A `limit` at or above
 * `items.length` is plain full concurrency; a `limit` below 1 is treated as 1.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const workers = Array.from({ length: Math.min(items.length, Math.max(1, Math.floor(limit))) }, worker);
  await Promise.all(workers);
  return results;
}
