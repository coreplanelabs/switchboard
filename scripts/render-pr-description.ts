// Render a PrDescription JSON file to the GitHub PR body (docs/reference/specs/pr-description.md).
//
//   npx tsx scripts/render-pr-description.ts <description.json> --repo <owner/name> --head <40-char sha>
//
// Prints the markdown on stdout — pipe it into `gh pr edit <n> --body-file -`.
// The same renderer the bot will use; the sha is supplied here because anchors
// are stored as (path, from, to) and rendered against the head at render time.
import { readFileSync } from "node:fs";
import { parsePrDescription, renderPrDescriptionMarkdown } from "../src/core/prDescription.js";

function usage(): never {
  console.error(`usage: render-pr-description.ts <description.json> --repo <owner/name> --head <40-char sha>`);
  process.exit(2);
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v ?? usage();
}

const file = process.argv[2];
if (!file || file.startsWith("--")) usage();
const desc = parsePrDescription(JSON.parse(readFileSync(file, "utf8")));
process.stdout.write(renderPrDescriptionMarkdown(desc, { repo: arg("repo"), headSha: arg("head") }));
