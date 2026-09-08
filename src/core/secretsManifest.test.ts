import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKER_SPECS } from "../deploy/plan.js";
import { MANIFEST_PATH, parseManifest } from "../deploy/secrets.js";

const ROOT = resolve(import.meta.dirname, "../..");
/** Worker → its deploy/ directory name — the four Workers that hold secrets, from the deploy specs. */
const WORKERS: Record<string, string> = Object.fromEntries(
  WORKER_SPECS.map((w) => [w.name, w.dir.replace(/^deploy\//, "")]),
);
const parsed = parseManifest(JSON.parse(readFileSync(resolve(ROOT, MANIFEST_PATH), "utf8")));
if (!parsed.ok) throw new Error(parsed.problems.join("; "));
const manifest = parsed.manifest;

/** Property names of the `interface Env { … }` block in a Worker's worker.ts. */
function envInterfaceKeys(workerDir: string): Set<string> {
  const src = readFileSync(resolve(ROOT, "deploy", workerDir, "worker.ts"), "utf8");
  // Body = everything up to the first `}` that starts a line, whatever the
  // indentation inside; a member is any line that opens with a SCREAMING name.
  const m = /(?:export )?interface Env\s*\{([\s\S]*?)^\}/m.exec(src);
  if (!m) throw new Error(`${workerDir}/worker.ts: no Env interface`);
  const keys = new Set<string>();
  for (const line of m[1].split("\n")) {
    const k = /^\s*([A-Z][A-Z0-9_]*)\??:/.exec(line);
    if (k) keys.add(k[1]);
  }
  if (keys.size === 0) throw new Error(`${workerDir}/worker.ts: Env interface has no SCREAMING_SNAKE members`);
  return keys;
}

describe("deploy/secrets.manifest.json", () => {
  it("names every Worker and nothing else", () => {
    expect(Object.keys(WORKERS).sort()).toEqual(["bot", "memory", "resident", "sandbox"]);
    for (const s of manifest.secrets) for (const w of s.workers) expect(WORKERS).toHaveProperty(w);
  });

  it("has unique, SCREAMING_SNAKE names, each on at least one Worker", () => {
    const names = manifest.secrets.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of manifest.secrets) {
      expect(s.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(s.workers.length).toBeGreaterThan(0);
    }
  });

  it("every secret it puts on a Worker is a field of that Worker's Env interface (no dead or misspelled entries)", () => {
    for (const [worker, dir] of Object.entries(WORKERS)) {
      const env = envInterfaceKeys(dir);
      for (const s of manifest.secrets) {
        if ((s.workers as readonly string[]).includes(worker))
          expect(env, `${s.name} is not in ${dir}/worker.ts Env`).toContain(s.name);
      }
    }
  });

  it("every bot secret reaches the container: the shim forwards each manifest `bot` entry (a secret on the Worker the container never sees is a silent misconfiguration — MCP_CREDENTIAL_KEY once was)", () => {
    const src = readFileSync(resolve(ROOT, "deploy/cloudflare/worker.ts"), "utf8");
    const fn = /function containerEnv\(env: Env\)[\s\S]*?\n\}/.exec(src);
    if (!fn) throw new Error("deploy/cloudflare/worker.ts: no containerEnv()");
    const list = /const FORWARDED_OPTIONAL = \[([\s\S]*?)\]/.exec(src);
    if (!list) throw new Error("deploy/cloudflare/worker.ts: no FORWARDED_OPTIONAL");
    const forwarded = new Set([...list[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]));
    for (const m of fn[0].matchAll(/^\s*([A-Z][A-Z0-9_]*): env\.\1,/gm)) forwarded.add(m[1]);
    for (const s of manifest.secrets) {
      if (s.workers.includes("bot"))
        expect(forwarded, `${s.name} is put on the bot Worker but never forwarded into the container`).toContain(
          s.name,
        );
    }
  });

  it("no Worker directory still carries a secrets.txt (the manifest replaced them)", () => {
    for (const dir of Object.values(WORKERS)) {
      expect(() => readFileSync(resolve(ROOT, "deploy", dir, "secrets.txt"))).toThrow();
    }
  });

  it("STATE_WORKER_URL is a var, never a secret — it is a public URL", () => {
    expect(manifest.secrets.map((s) => s.name)).not.toContain("STATE_WORKER_URL");
  });

  it("the image carries the manifest: src/secrets.ts reads it at startup, so a container without it cannot start", () => {
    const dockerfile = readFileSync(resolve(ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^COPY deploy\/secrets\.manifest\.json \.\/deploy\/$/m);
  });

  it("the build context carries the manifest: .dockerignore excludes deploy/ but not this file (a COPY of an ignored path fails the image build)", () => {
    const rules = readFileSync(resolve(ROOT, ".dockerignore"), "utf8");
    expect(dockerIgnores(rules, MANIFEST_PATH)).toBe(false);
    // The matcher itself, against the file's own shape: the directory rule
    // covers its children, a later negation wins, an unrelated path is kept.
    expect(dockerIgnores(rules, "deploy/cloudflare/worker.ts")).toBe(true);
    expect(dockerIgnores(rules, "deploy/cloudflare/package.json")).toBe(false);
    expect(dockerIgnores(rules, "deploy/profile.example.json")).toBe(false);
    expect(dockerIgnores(rules, "src/index.ts")).toBe(false);
    expect(dockerIgnores("deploy\n!deploy/x.json\ndeploy/x.json\n", "deploy/x.json")).toBe(true);
  });
});

/** Whether `.dockerignore` text excludes `path` from the build context, the way
 *  Docker decides it: patterns are root-anchored and matched segment by segment
 *  (`*` within a segment, `**` across segments); a pattern that names a directory
 *  covers everything under it; the LAST matching rule wins, `!` re-includes. */
function dockerIgnores(text: string, path: string): boolean {
  const target = path.split("/");
  let ignored = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const pattern = (negated ? line.slice(1) : line).replace(/^\/+|\/+$/g, "").split("/");
    if (segmentsMatch(pattern, target)) ignored = !negated;
  }
  return ignored;
}

function segmentsMatch(pattern: string[], target: string[]): boolean {
  if (pattern.length === 0) return true; // the pattern named an ancestor directory (or `**` consumed the rest)
  if (target.length === 0) return false;
  const [head, ...rest] = pattern;
  if (head === "**") return segmentsMatch(rest, target) || segmentsMatch(pattern, target.slice(1));
  const re = new RegExp(`^${head.split("*").map(escapeRegExp).join("[^/]*")}$`);
  return re.test(target[0]) && segmentsMatch(rest, target.slice(1));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
