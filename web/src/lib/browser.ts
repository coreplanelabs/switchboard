// Browser side effects behind one object so tests can spy on them (ESM
// exports are not spyable; methods on an object are).

export const browser = {
  navigate(href: string): void {
    window.location.assign(href);
  },
  reload(): void {
    window.location.reload();
  },
  /** The current address, path only (what a page compares its seed against). */
  pathname(): string {
    return window.location.pathname;
  },
  /** The current address's query string, `?` included (empty when none). */
  search(): string {
    return window.location.search;
  },
  /** Rewrite the address without a load or a history entry: a fresh
   *  conversation takes its own URL once it exists on the server. */
  replaceUrl(href: string): void {
    window.history.replaceState(window.history.state, "", href);
  },
  confirm(message: string): boolean {
    return window.confirm(message);
  },
  setTitle(title: string): void {
    document.title = title;
  },
  setFavicon(href: string): void {
    document.getElementById("favicon")?.setAttribute("href", href);
  },
  /** Copy text to the clipboard; a browser without one (or a test) does nothing. */
  copyText(text: string): Promise<void> {
    return navigator.clipboard?.writeText(text) ?? Promise.resolve();
  },
  /** A preference this browser keeps for its viewer (the rail's width, whether
   *  it is shown): `null` where nothing was kept or storage is blocked. */
  readPref(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  writePref(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // A private window or blocked site data keeps nothing; the page still works.
    }
  },
  /** Whether a media query holds now; false where the runtime has no `matchMedia`. */
  mediaMatches(query: string): boolean {
    return typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false;
  },
  /** Follow a media query as the viewport changes; returns the way to stop.
   *  Where the runtime has no `matchMedia` nothing is followed. */
  onMediaChange(query: string, handler: (matches: boolean) => void): () => void {
    if (typeof window.matchMedia !== "function") return () => {};
    const list = window.matchMedia(query);
    const onChange = (ev: MediaQueryListEvent) => handler(ev.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  },
};
