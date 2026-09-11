// Helpers for the plain-Node scans over the resident Worker's sources
// (lifecycle.test.ts, instanceStep.test.ts): the files are read as text,
// never loaded — worker.ts runs only under workerd. Under `testing/` so the
// package build and the deploy's affected-paths rule treat it as a test file.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One source of this directory, as text. */
export function readSource(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
}

/** The declaration of a member of the entry's classes at the class's own
 *  indentation (two spaces): a doc comment, a method (with or without a
 *  modifier, an `async`, a type parameter list) or a field. */
const MEMBER_AT_CLASS_INDENT =
  /^ {2}(?:\/\*\*|(?:private |public )?(?:async )?[A-Za-z_$][\w$]*(?:<[^>]*>)?\(|(?:private |public )?(?:readonly )?[A-Za-z_$][\w$]* *[=:])/m;

/** The text of one method of a class in `source`: from its declaration to the
 *  next member declared at the class's indentation, so a nested block closing
 *  at any indentation cannot end the window early. Null when the source
 *  declares no such method. */
export function methodOf(source: string, name: string): string | null {
  const start = source.search(new RegExp(`^ {2}(?:private |public )?(?:async )?${name}[<(]`, "m"));
  if (start === -1) return null;
  const rest = source.slice(start + 1);
  const next = rest.search(MEMBER_AT_CLASS_INDENT);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}
