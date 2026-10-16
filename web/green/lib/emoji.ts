/** Enrich only the safe markdown DOM. Never read image addresses from model text. */
export function watchSlackEmoji(root: HTMLElement, catalog: Record<string, { path: string }>) {
  function paint() {
    for (const prose of root.querySelectorAll<HTMLElement>(".md")) {
      const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (!node.parentElement?.closest("pre,code") && /:[a-zA-Z0-9_+-]+:/.test(node.data)) nodes.push(node);
      }
      for (const node of nodes) {
        const parts = document.createDocumentFragment();
        let cursor = 0,
          changed = false;
        for (const match of node.data.matchAll(/:([a-zA-Z0-9_+-]+):/g)) {
          const path = Object.hasOwn(catalog, match[1]) ? catalog[match[1]]?.path : undefined;
          if (!path || !/^\/assets\/emoji\/[a-zA-Z0-9_-]+\.(?:png|gif|webp)$/.test(path)) continue;
          parts.append(document.createTextNode(node.data.slice(cursor, match.index)));
          const image = document.createElement("img");
          image.src = path;
          image.alt = match[0];
          image.title = match[0];
          image.className = "green-slack-emoji";
          image.width = 20;
          image.height = 20;
          image.loading = "lazy";
          parts.append(image);
          cursor = match.index + match[0].length;
          changed = true;
        }
        if (changed) {
          parts.append(document.createTextNode(node.data.slice(cursor)));
          node.replaceWith(parts);
        }
      }
    }
  }
  paint();
  const observer = new MutationObserver(paint);
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}
