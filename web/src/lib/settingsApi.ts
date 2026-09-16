// The settings page's one way to write: `POST /api/<group>.<verb>` with the
// command's named input as JSON (src/channels/commandHttp.ts maps it onto the
// definition's args and options by name). The page carries no rule about who
// may do what — a refusal comes back as the handler's own sentence and is shown
// as is (record 0041). `fetch` is injected so tests can see the request.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CommandFailure {
  /** The registry's error code (`unauthorized`, `invalid_input`, …) or `HTTP <status>`. */
  error: string;
  message: string;
}

export type CommandAnswer = { ok: true; value: unknown } | { ok: false; failure: CommandFailure };

/** One write. The body is the command's input by name; a `scope` of `me` is
 *  never composed here — the page configures the shared tiers only. */
export async function postCommand(
  fetchFn: FetchLike,
  id: string,
  body: Record<string, unknown>,
): Promise<CommandAnswer> {
  try {
    const res = await fetchFn(`/api/${id}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
    if (!res.ok) {
      return {
        ok: false,
        failure: {
          error: typeof parsed?.error === "string" ? parsed.error : `HTTP ${res.status}`,
          message: typeof parsed?.message === "string" ? parsed.message : `HTTP ${res.status}`,
        },
      };
    }
    return { ok: true, value: parsed };
  } catch (err) {
    return { ok: false, failure: { error: "network", message: err instanceof Error ? err.message : String(err) } };
  }
}

/** One read. Reads take their input as a kebab-case query string. */
export async function getCommand(
  fetchFn: FetchLike,
  id: string,
  query: Record<string, string | undefined>,
): Promise<CommandAnswer> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") q.set(k, v);
  const suffix = q.size > 0 ? `?${q.toString()}` : "";
  try {
    const res = await fetchFn(`/api/${id}${suffix}`, { credentials: "same-origin" });
    const parsed = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
    if (!res.ok) {
      return {
        ok: false,
        failure: {
          error: typeof parsed?.error === "string" ? parsed.error : `HTTP ${res.status}`,
          message: typeof parsed?.message === "string" ? parsed.message : `HTTP ${res.status}`,
        },
      };
    }
    return { ok: true, value: parsed };
  } catch (err) {
    return { ok: false, failure: { error: "network", message: err instanceof Error ? err.message : String(err) } };
  }
}

/** The house classes for a native control: the search form's (SessionSearch.vue). */
export const INPUT_CLASS =
  "min-w-0 rounded border border-accented bg-default px-2 py-1 text-sm text-highlighted placeholder:text-dimmed disabled:opacity-60";
export const SELECT_CLASS =
  "rounded border border-accented bg-default px-2 py-1 font-mono text-xs text-toned disabled:opacity-60";
