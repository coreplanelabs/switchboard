#!/usr/bin/env node
// Write the title gate's vocabulary — the allowed types from
// release-please-config.json and the allowed scopes from the Areas table in
// docs/reference/code-map.md — into src/core/prTitleVocabulary.json, or check
// that the committed file is current. The bot's image ships src/ and neither
// source, and the `submit_pr_description` tool judges a title with the same
// predicate the CI gate runs (src/core/prTitle.mjs), so the lists travel as a
// generated module both read. Same mechanism as `docs:gen` / `docs:check`:
// the generator is the only writer, and a stale file is a red build.
//
//   npm run pr-title:gen      rewrite the file
//   npm run pr-title:check    what CI runs — exit 1 naming the file and the fix
//
// Plain JS with no dependencies, like the gate it feeds.

import { readFileSync, writeFileSync } from "node:fs";
import { CODE_MAP_PATH, RELEASE_CONFIG_PATH, renderPrTitleVocabulary, VOCABULARY_PATH } from "../src/core/prTitle.mjs";

const write = process.argv.includes("--write");
const tag = write ? "pr-title:gen" : "pr-title:check";

let next;
try {
  next = renderPrTitleVocabulary(
    JSON.parse(readFileSync(RELEASE_CONFIG_PATH, "utf8")),
    readFileSync(CODE_MAP_PATH, "utf8"),
  );
} catch (err) {
  console.error(`${tag} — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

let current;
try {
  current = readFileSync(VOCABULARY_PATH, "utf8");
} catch {
  current = undefined;
}

if (write) {
  if (current === next) {
    console.log(`${tag} ok — ${VOCABULARY_PATH} unchanged`);
  } else {
    writeFileSync(VOCABULARY_PATH, next);
    console.log(`${tag} — wrote ${VOCABULARY_PATH}`);
  }
} else if (current === next) {
  console.log(`${tag} ok — ${VOCABULARY_PATH} matches ${RELEASE_CONFIG_PATH} and ${CODE_MAP_PATH}`);
} else {
  console.error(
    `${tag} FAILED — ${VOCABULARY_PATH} ${current === undefined ? "is missing" : "is stale"}: ` +
      `the title vocabulary comes from ${RELEASE_CONFIG_PATH} and the Areas table in ${CODE_MAP_PATH}; run \`npm run pr-title:gen\` and commit the result`,
  );
  process.exit(1);
}
