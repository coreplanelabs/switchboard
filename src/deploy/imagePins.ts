// Toolchain pins in the container images (features/execution.md item 10),
// parsed from the Dockerfiles so "pinned" is a test, not a habit.
//
// Why this exists: the resident image installed its package managers as
// `RUN npm install -g pnpm@latest yarn@latest`. That makes the pnpm version a
// property of WHEN the image was last built, not of any commit — and a routine
// rebuild (a commit that edited that very line) moved pnpm 10 → 11. pnpm 11
// stopped reading `package.json`'s `pnpm` field, so a repo keeping its
// `overrides` / `patchedDependencies` / `onlyBuiltDependencies` there installs
// against settings pnpm no longer sees: `pnpm install --frozen-lockfile` then
// fails with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH. Nothing in the repo changed,
// nothing in the repo could have caught it.
//
// Two rules, deliberately different in strictness:
//   - a global package-manager install must name an EXACT version — these are
//     what a repo's install/build runs through;
//   - a `FROM` tag must merely name something (a tag that is absent or
//     `latest` is floating) — `node:22-slim` is a major-pinned base and stays
//     legal, because a base bump is a visible layer change, not a silent
//     major of the build toolchain.

export interface ImagePin {
  /** The image (for `FROM`) or the package (for an install). */
  tool: string;
  /** The version specifier as written; "" when none was given. */
  spec: string;
  /** 1-based PHYSICAL line, so a finding points at the line to edit. */
  line: number;
  floating: boolean;
}

interface Token {
  text: string;
  line: number;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const INSTALL_VERBS = new Set(["install", "i", "add"]);
const GLOBAL_FLAGS = new Set(["-g", "--global"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
const COMMAND_SEPARATORS = new Set(["&&", "||", ";", "|"]);

/** Physical lines → logical statements (a trailing `\` continues), comments
 *  dropped, each token keeping the physical line it was written on. */
function statements(dockerfile: string): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  let continued = false;
  dockerfile.split("\n").forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (!continued && (trimmed === "" || trimmed.startsWith("#"))) return;
    const continues = trimmed.endsWith("\\");
    const body = continues ? trimmed.slice(0, -1) : trimmed;
    // Separators are glued to their neighbours as often as not (`set -eux;`),
    // so give each one its own token before splitting on whitespace. A `|` or
    // `;` inside a quoted argument would be split too — no image here writes
    // one, and a false separator can only ever split a command in two.
    const spaced = body.replace(/(&&|\|\||;|\|)/g, " $1 ");
    for (const text of spaced.split(/\s+/)) if (text !== "") current.push({ text, line });
    continued = continues;
    if (!continued && current.length > 0) {
      out.push(current);
      current = [];
    }
  });
  if (current.length > 0) out.push(current);
  return out;
}

/** One statement → the shell commands it chains. */
function commands(tokens: Token[]): Token[][] {
  const out: Token[][] = [[]];
  for (const token of tokens) {
    if (COMMAND_SEPARATORS.has(token.text)) out.push([]);
    else out[out.length - 1].push(token);
  }
  return out.filter((c) => c.length > 0);
}

/** `pnpm@10.34.5` → ["pnpm", "10.34.5"]; `@scope/pkg@1.0.0` → ["@scope/pkg",
 *  "1.0.0"]; `pnpm` → ["pnpm", ""]. */
function splitSpec(text: string): [string, string] {
  const at = text.lastIndexOf("@");
  if (at <= 0) return [text, ""];
  return [text.slice(0, at), text.slice(at + 1)];
}

function isFlag(text: string): boolean {
  return text.startsWith("-");
}

/** `image:tag` → floating iff the tag is absent or `latest`. A registry host
 *  with a port (`host:5000/img`) is not a shape this repo's images use; the
 *  last `:` after the final `/` is the tag. */
function fromPin(image: string, line: number): ImagePin {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  const hasTag = colon > slash;
  const spec = hasTag ? image.slice(colon + 1) : "";
  const tool = hasTag ? image.slice(0, colon) : image;
  return { tool, spec, line, floating: !hasTag || spec === "latest" };
}

/** Every toolchain pin the Dockerfile declares, in file order. */
export function imagePins(dockerfile: string): ImagePin[] {
  const pins: ImagePin[] = [];
  for (const statement of statements(dockerfile)) {
    const instruction = statement[0]?.text.toUpperCase();
    if (instruction === "FROM") {
      const image = statement.slice(1).find((t) => !isFlag(t.text));
      if (image) pins.push(fromPin(image.text, image.line));
      continue;
    }
    if (instruction !== "RUN") continue;
    for (const command of commands(statement.slice(1))) {
      const words = command.filter((t) => !isFlag(t.text));
      const [head, verb, ...rest] = words;
      if (!head) continue;
      const isGlobalInstall =
        PACKAGE_MANAGERS.has(head.text) &&
        verb !== undefined &&
        INSTALL_VERBS.has(verb.text) &&
        command.some((t) => GLOBAL_FLAGS.has(t.text));
      const isCorepackPrepare = head.text === "corepack" && verb?.text === "prepare";
      if (!isGlobalInstall && !isCorepackPrepare) continue;
      for (const token of rest) {
        const [tool, spec] = splitSpec(token.text);
        pins.push({ tool, spec, line: token.line, floating: !EXACT_VERSION.test(spec) });
      }
    }
  }
  return pins;
}

/** The pins a built image would resolve at build time rather than from the
 *  commit — what the fence in `imagePins.test.ts` requires to be empty. */
export function floatingImagePins(dockerfile: string): ImagePin[] {
  return imagePins(dockerfile).filter((p) => p.floating);
}
