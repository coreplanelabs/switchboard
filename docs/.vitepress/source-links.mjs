import { existsSync } from "node:fs";
import { posix, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

// These immutable records cite the source snapshots named in their own text.
// The records remain unchanged when a later implementation retires a file.
export const HISTORICAL_SOURCE_LINKS = [
  {
    document: "decisions/0041-the-settings-page-is-a-surface-over-the-registry-and-configures-the-shared-tiers.md",
    path: "web/src/lib/navSections.ts",
    commit: "95b4face165e6f62b5d32273557ba97004e24c68",
  },
  {
    document: "decisions/0043-the-home-page-is-a-chat-the-browser-is-a-channel-and-a-turn-is-a-run.md",
    path: "web/src/pages/UnitPage.vue",
    commit: "1546268599d07637b5123700d8d054f728c3e7e0",
  },
];
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Only an existing source or the exact registered record citation can leave the docs tree. */
export function repositorySourceLink(document, href, repository) {
  if (!/^\.\.?\//.test(href)) return;
  const [file, hash] = href.split("#");
  const target = posix.normalize(posix.join(posix.dirname(document), file));
  if (!target.startsWith("../") && !target.startsWith("plans/")) return;
  const path = posix.normalize(posix.join("docs", target));
  if (path.startsWith("../")) return;
  const historical = HISTORICAL_SOURCE_LINKS.find((link) => link.document === document && link.path === path);
  if (!historical && !existsSync(resolve(ROOT, path))) return;
  const ref = historical?.commit ?? "main";
  const view = path.endsWith("/") ? "tree" : "blob";
  return { path, ref, href: `${repository}/${view}/${ref}/${path}${hash ? `#${hash}` : ""}` };
}
