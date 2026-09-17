import { browser } from "./browser";

// View-as on the dashboard (record 0053): the two calls the picker and the
// banner make. The shell's CSP forbids form posts, so both are fetches; the
// server answers 204 with the cookie set or cleared, and the page reloads so
// every surface repaints as the person — or as the session itself again. A
// refusal (403 for a session without every grant, 400 for a bad id) is
// surfaced as its message, never swallowed.

export const VIEW_AS_URL = "/runs/view-as";
export const VIEW_AS_EXIT_URL = "/runs/view-as/exit";
/** The one sentence every disabled write control carries while viewing. */
export const viewingSentence = (person: { id: string; name?: string }): string =>
  `You are viewing as ${person.name ?? person.id}; writes are your own to make — exit view-as to write.`;

async function post(url: string, body?: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.ok) return { ok: true };
    const parsed = (await res.json().catch(() => null)) as { message?: unknown } | null;
    return { ok: false, message: typeof parsed?.message === "string" ? parsed.message : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Start viewing as `person`: on success the runs index reloads as that person. */
export async function enterViewAs(person: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await post(VIEW_AS_URL, { person });
  if (r.ok) browser.navigate("/runs");
  return r;
}

/** Stop viewing: the current page reloads as the session itself. */
export async function exitViewAs(): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await post(VIEW_AS_EXIT_URL);
  if (r.ok) browser.reload();
  return r;
}
