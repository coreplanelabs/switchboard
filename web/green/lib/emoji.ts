import type { App } from "vue";
import { standardEmoji, isStandardEmoji, type EmojiEntry } from "@core/core/emoji.js";

type Decoration = { node: Text; original: string; added: Node[] };
const decorations = new Set<Decoration>();

/** Restore Vue-owned text before Vue patches or removes it. */
function restore(root: Node) {
  for (const decoration of decorations) {
    if (!root.contains(decoration.node)) continue;
    for (const added of decoration.added) added.parentNode?.removeChild(added);
    decoration.node.data = decoration.original;
    decorations.delete(decoration);
  }
}
export const textRendering = {
  install(app: App) {
    app.mixin({
      // A component can still update after the environment's DOM globals are
      // gone (a test environment tears down before pending work drains), so the
      // hook guards the global before it dereferences it.
      beforeUpdate() {
        if (typeof Node !== "undefined" && this.$el instanceof Node) restore(this.$el);
      },
      beforeUnmount() {
        if (typeof Node !== "undefined" && this.$el instanceof Node) restore(this.$el);
      },
    });
  },
};

/** The one display-text hook. Addresses come only from the installed catalog.
 * Leave source code, editable text, SVG and unknown shortcodes unchanged. */
export function watchDisplayText(root: HTMLElement, catalog: Record<string, EmojiEntry>) {
  const observer = new MutationObserver(paint);
  function paint(records?: MutationRecord[]) {
    observer.disconnect();
    for (const decoration of decorations) {
      if (!decoration.node.isConnected || decoration.node.data !== "") {
        for (const added of decoration.added) added.parentNode?.removeChild(added);
        decorations.delete(decoration);
      }
    }
    // A clock tick changes one text node. Do not rescan the transcript for it.
    const changed = records
      ? records.flatMap((record) => (record.type === "characterData" ? [record.target] : [...record.addedNodes]))
      : [root];
    const nodes = new Set<Text>();
    function consider(node: Text) {
      if (
        root.contains(node) &&
        !node.parentElement?.closest(
          "pre,code,textarea,input,select,script,style,svg,[contenteditable],[data-raw-text]",
        ) &&
        (/:[a-zA-Z0-9_+'-]+:/.test(node.data) || /`[^`\n]+`/.test(node.data))
      )
        nodes.add(node);
    }
    for (const target of new Set(changed)) {
      if (target instanceof Text) consider(target);
      else {
        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) consider(walker.currentNode as Text);
      }
    }
    for (const node of nodes) {
      const parts = document.createDocumentFragment();
      let cursor = 0;
      for (const match of node.data.matchAll(/(?<![\\`])`([^`\n]+)`(?!`)|:([a-zA-Z0-9_+'-]+):/g)) {
        if (match[1] !== undefined) {
          parts.append(document.createTextNode(node.data.slice(cursor, match.index)));
          const code = document.createElement("code");
          code.textContent = match[1];
          code.className = "rounded bg-elevated px-1 font-mono text-[0.92em]";
          parts.append(code);
          cursor = match.index + match[0].length;
          continue;
        }
        const name = match[2];
        const entry = Object.hasOwn(catalog, name) ? catalog[name] : undefined;
        const path = entry?.path;
        const unicode =
          entry?.text && isStandardEmoji(entry.text) ? entry.text : !path ? standardEmoji(name) : undefined;
        if (!unicode && (!path || !/^\/assets\/emoji\/[a-zA-Z0-9_-]+\.(?:png|gif|webp|jpg)$/.test(path))) continue;
        parts.append(document.createTextNode(node.data.slice(cursor, match.index)));
        if (unicode) {
          parts.append(document.createTextNode(unicode));
          cursor = match.index + match[0].length;
          continue;
        }
        const image = document.createElement("img");
        image.src = path!;
        image.alt = match[0];
        image.title = match[0];
        image.className = "green-slack-emoji";
        image.width = 20;
        image.height = 20;
        image.loading = "lazy";
        parts.append(image);
        cursor = match.index + match[0].length;
      }
      if (cursor) {
        parts.append(document.createTextNode(node.data.slice(cursor)));
        const added = [...parts.childNodes];
        decorations.add({ node, original: node.data, added });
        node.before(parts);
        node.data = "";
      }
    }
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  }
  paint();
  return () => {
    observer.disconnect();
    restore(root);
  };
}
