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
};
