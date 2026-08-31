// Browser side effects behind one object so tests can spy on them (ESM
// exports are not spyable; methods on an object are).

export const browser = {
  navigate(href: string): void {
    window.location.assign(href);
  },
  reload(): void {
    window.location.reload();
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
};
