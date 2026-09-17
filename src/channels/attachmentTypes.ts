// Shared inbound file classification for channel adapters.
import { extname } from "node:path";

const PDF_TYPE = "application/pdf";
// Text-ish mimetypes beyond the `text/*` family that Slack may report.
// `application/json` is deliberately absent: JSON is a common container for
// credentials (service-account keys, token dumps), so a file is never inlined
// just because Slack tags it application/json — the denylist below plus the
// extension allowlist decide, never the JSON mimetype on its own.
const TEXT_MIME_TYPES = new Set([
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/x-sh",
  "application/javascript",
  "application/typescript",
]);
// Mimetypes Slack assigns when it can't identify a file — fall back to the
// filename extension to decide whether it's a text/code file.
const GENERIC_MIME_TYPES = new Set(["application/octet-stream", "binary/octet-stream", ""]);
// Extensions inlined as text under the generic-mimetype fallback. JSON (`.json`,
// `.jsonl`) and config formats (`.env`, `.ini`, `.cfg`, `.conf`) are absent by
// design — the first two are frequent secret containers, the rest are covered by
// the secret-file denylist — so a generic-typed config/JSON file is not "fair
// game" for inlining just because of its extension.
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".log",
  ".csv",
  ".tsv",
  ".rst",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cc",
  ".cs",
  ".php",
  ".swift",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".r",
  ".pl",
  ".lua",
  ".dart",
  ".scala",
  ".clj",
  ".ex",
  ".exs",
  ".vue",
  ".svelte",
  ".graphql",
  ".proto",
  ".dockerfile",
]);
// Secret-file denylist — filename shapes whose contents are likely credentials,
// private keys, or secret config. Matching files are skipped-with-note and their
// bytes NEVER reach the model prompt. This OVERRIDES text classification
// (checked before the text-mimetype/extension allowlist), because the whole risk
// is a secret file whose mimetype/extension otherwise reads as harmless text.
//
// Matched on the filename, case-insensitive, and independent of
// `node:path.extname` — which returns "" for dotfiles like `.env` and `.npmrc`,
// so an extname-based check would miss exactly the files that matter most.
const SECRET_FILE_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".npmrc", ".netrc", ".ini", ".cfg", ".conf"];
const SECRET_FILE_PREFIXES = ["id_rsa"];

/** Does this filename look like a secret/credential/key/config file? Case-
 *  insensitive; conservative (a false match only skips a file, never leaks one).
 *  Exported for tests. */
export function isSecretFile(name: string | undefined): boolean {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return false;
  // `.env` in any position: bare `.env`, dotfiles (`.env.local`,
  // `.env.production`), and suffixed configs (`config.env`, `prod.env`).
  if (n.includes(".env")) return true;
  // SSH / private-key material by filename prefix (`id_rsa`, `id_rsa.pub`, …).
  if (SECRET_FILE_PREFIXES.some((p) => n.startsWith(p))) return true;
  // Credential JSON blobs — the common shapes secrets ship in.
  if (n === "credentials.json") return true;
  if (n.endsWith(".json") && (n.includes("service-account") || n.endsWith("-key.json"))) return true;
  // Secret-ish extensions, including dotfiles `extname` can't see.
  return SECRET_FILE_EXTENSIONS.some((ext) => n.endsWith(ext));
}

/** Classify a file for document ingestion: a PDF, an inlinable text/code file,
 *  or neither. A secret-file denylist match (`isSecretFile`) is classified as
 *  neither — before any text check — so credentials never inline. Otherwise text
 *  detection prefers the mimetype and falls back to the filename extension only
 *  when Slack reports a generic/unknown type. Exported for tests. */
export function classifyDocument(mimetype: string | undefined, name: string | undefined): "pdf" | "text" | null {
  if (mimetype === PDF_TYPE) return "pdf";
  // Secret-file denylist OVERRIDES text classification: a credentials/key/config
  // file is skipped, never decoded into the prompt, even when its mimetype
  // (application/json, text/plain) or extension would otherwise mark it text.
  if (isSecretFile(name)) return null;
  const mt = mimetype ?? "";
  if (mt.startsWith("text/") || TEXT_MIME_TYPES.has(mt)) return "text";
  if (GENERIC_MIME_TYPES.has(mt) && TEXT_EXTENSIONS.has(extname(name ?? "").toLowerCase())) {
    return "text";
  }
  return null;
}
