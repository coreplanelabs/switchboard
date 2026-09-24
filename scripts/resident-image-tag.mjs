#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const RESIDENT_IMAGE_INPUTS = [
  "deploy/cloudflare-resident/Dockerfile",
  "deploy/cloudflare-resident/prepare-commit-msg",
];
export const RESIDENT_IMAGE_TAG_FILE = "deploy/cloudflare-resident/image-tag.txt";

/** A stable tag over exactly the files the resident Dockerfile reads from its context. */
export function residentImageTag(read = (path) => readFileSync(join(ROOT, path))) {
  const hash = createHash("sha256");
  for (const path of RESIDENT_IMAGE_INPUTS) {
    const bytes = read(path);
    hash.update(`${path}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return `sha256-${hash.digest("hex")}`;
}

function main() {
  const expected = `${residentImageTag()}\n`;
  if (process.argv.includes("--write")) {
    writeFileSync(join(ROOT, RESIDENT_IMAGE_TAG_FILE), expected);
    console.log(`resident-image-tag wrote ${RESIDENT_IMAGE_TAG_FILE}: ${expected.trim()}`);
    return;
  }
  let actual = "";
  try {
    actual = readFileSync(join(ROOT, RESIDENT_IMAGE_TAG_FILE), "utf8");
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
  }
  if (actual !== expected) {
    console.error(`${RESIDENT_IMAGE_TAG_FILE} is stale — run npm run resident-image-tag -- --write`);
    process.exitCode = 1;
    return;
  }
  console.log(`resident-image-tag ok — ${expected.trim()}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
