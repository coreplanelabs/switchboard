/** `: <error>` from a state-Worker JSON `{error}` body, or empty — shared by
 *  every client of the state Worker (run store, schedule store), so a refused
 *  request is reported with the Worker's own words. */
export async function errorSuffix(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return parsed?.error ? `: ${String(parsed.error)}` : "";
  } catch {
    return "";
  }
}
