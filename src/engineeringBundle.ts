import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { EngineeringRules } from "./engineering.js";
import { PACKAGE_ROOT } from "./packageRoot.js";

const manifestSchema = z.strictObject({
  schema: z.literal(1),
  files: z.array(z.string().regex(/^[a-z][a-z0-9-]*\.md$/)).min(1),
});

/** Includes and symlinks are not policy composition: the manifest is one flat list. */
export function loadEngineeringRules(dir = join(PACKAGE_ROOT, "engineering")): EngineeringRules {
  try {
    const readRequired = (file: string) => {
      const path = join(dir, file);
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!fstatSync(descriptor).isFile()) throw new Error(`engineering rule is not a regular file: ${file}`);
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(descriptor));
      } finally {
        closeSync(descriptor);
      }
    };
    const manifest = manifestSchema.parse(JSON.parse(readRequired("manifest.json")));
    if (new Set(manifest.files).size !== manifest.files.length) throw new Error("duplicate engineering rule file");
    const digest = createHash("sha256");
    const texts = manifest.files.map((file) => {
      const text = readRequired(file);
      if (!text.trim()) throw new Error(`empty engineering rule: ${file}`);
      digest.update(file).update("\0").update(text).update("\0");
      return text.trim();
    });
    const text = texts.join("\n\n");
    if (Buffer.byteLength(text, "utf8") > 8_000) throw new Error("engineering rules exceed the 8000-byte budget");
    return Object.freeze({ files: Object.freeze(manifest.files), sha256: digest.digest("hex"), text });
  } catch (cause) {
    throw new Error(
      `failed to load engineering rules from ${dir}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
