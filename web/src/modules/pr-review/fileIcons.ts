// The language icon beside a file in the Files changed list: the language is
// read off the path (a known file name first, then the extension), and each
// language names one bundled icon. Every icon name is a literal here, so the
// build's icon scan finds it — the CSP allows no runtime fetch.

const BY_FILENAME: Record<string, string> = {
  dockerfile: "docker",
  makefile: "makefile",
  "go.mod": "go",
  "go.sum": "go",
  ".gitignore": "gitignore",
  ".dockerignore": "dockerignore",
};

const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  vue: "vue",
  svelte: "svelte",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  scala: "scala",
  ex: "elixir",
  exs: "elixir",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  md: "markdown",
  mdx: "mdx",
  sh: "bash",
  bash: "bash",
  zsh: "zsh",
  sql: "sql",
  tf: "terraform",
  hcl: "hcl",
  dockerfile: "docker",
};

/** The language a path is written in, by its file name or extension; `text` when unknown. */
export function languageFromPath(path: string): string {
  const base = path.split("/").pop() || path;
  const lower = base.toLowerCase();
  const byName = BY_FILENAME[lower];
  if (byName) return byName;
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return "text";
  return BY_EXTENSION[lower.slice(dot + 1)] ?? "text";
}

const ICONS: Record<string, string> = {
  javascript: "i-simple-icons-javascript",
  typescript: "i-simple-icons-typescript",
  vue: "i-simple-icons-vuedotjs",
  jsx: "i-simple-icons-react",
  tsx: "i-simple-icons-react",
  svelte: "i-simple-icons-svelte",
  html: "i-simple-icons-html5",
  css: "i-simple-icons-css",
  scss: "i-simple-icons-sass",
  sass: "i-simple-icons-sass",
  less: "i-simple-icons-less",
  python: "i-simple-icons-python",
  go: "i-simple-icons-go",
  rust: "i-simple-icons-rust",
  java: "i-simple-icons-openjdk",
  c: "i-simple-icons-c",
  cpp: "i-simple-icons-cplusplus",
  csharp: "i-simple-icons-csharp",
  php: "i-simple-icons-php",
  ruby: "i-simple-icons-ruby",
  elixir: "i-simple-icons-elixir",
  scala: "i-simple-icons-scala",
  swift: "i-simple-icons-swift",
  kotlin: "i-simple-icons-kotlin",
  json: "i-simple-icons-json",
  yaml: "i-simple-icons-yaml",
  toml: "i-simple-icons-toml",
  xml: "i-simple-icons-xml",
  sql: "i-lucide-database",
  markdown: "i-simple-icons-markdown",
  mdx: "i-simple-icons-mdx",
  bash: "i-simple-icons-gnubash",
  zsh: "i-simple-icons-gnubash",
  docker: "i-simple-icons-docker",
  dockerignore: "i-simple-icons-docker",
  terraform: "i-simple-icons-terraform",
  hcl: "i-simple-icons-terraform",
  makefile: "i-lucide-hammer",
  gitignore: "i-simple-icons-git",
  text: "i-lucide-file-text",
};

/** The icon for a language `languageFromPath` names; the plain file for one without its own. */
export function iconForLanguage(language: string): string {
  return ICONS[language] ?? ICONS.text;
}

/** The icon beside a path in the file list. */
export function fileIcon(path: string): string {
  return iconForLanguage(languageFromPath(path));
}
