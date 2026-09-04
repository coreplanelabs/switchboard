import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKERS, loadManifest, planSecretPuts, type Manifest } from "../../deploy/bin/put-secrets.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const manifest = loadManifest(resolve(ROOT, "deploy/secrets.manifest.json"));

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
        if (s.workers.includes(worker)) expect(env, `${s.name} is not in ${dir}/worker.ts Env`).toContain(s.name);
      }
    }
  });

  it("every bot secret reaches the container: the shim forwards each manifest `bot` entry (a secret on the Worker the container never sees is a silent misconfiguration — MCP_CREDENTIAL_KEY, 2026-09-04)", () => {
    const src = readFileSync(resolve(ROOT, "deploy/cloudflare/worker.ts"), "utf8");
    const fn = /function containerEnv\(env: Env\)[\s\S]*?\n\}/.exec(src);
    if (!fn) throw new Error("deploy/cloudflare/worker.ts: no containerEnv()");
    const list = /const FORWARDED_OPTIONAL = \[([\s\S]*?)\]/.exec(src);
    if (!list) throw new Error("deploy/cloudflare/worker.ts: no FORWARDED_OPTIONAL");
    const forwarded = new Set([...list[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]));
    for (const m of fn[0].matchAll(/^\s*([A-Z][A-Z0-9_]*): env\.\1,/gm)) forwarded.add(m[1]);
    for (const s of manifest.secrets) {
      if (s.workers.includes("bot")) expect(forwarded, `${s.name} is put on the bot Worker but never forwarded into the container`).toContain(s.name);
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
});

describe("planSecretPuts", () => {
  const m: Manifest = {
    secrets: [
      { name: "A", workers: ["bot", "resident"] },
      { name: "B", workers: ["bot"], optional: true },
      { name: "C", workers: ["memory"] },
    ],
  };
  const files = (present: string[]) => (name: string) => present.includes(name);

  it("selects the Worker's secrets, in manifest order", () => {
    expect(planSecretPuts(m, "bot", files(["A", "B"]))).toEqual({ puts: ["A", "B"], skippedOptional: [], missing: [] });
    expect(planSecretPuts(m, "resident", files(["A"]))).toEqual({ puts: ["A"], skippedOptional: [], missing: [] });
  });

  it("a missing local file for a required secret is reported, never silently skipped", () => {
    expect(planSecretPuts(m, "bot", files(["B"]))).toEqual({ puts: ["B"], skippedOptional: [], missing: ["A"] });
  });

  it("a missing optional secret is skipped and named", () => {
    expect(planSecretPuts(m, "bot", files(["A"]))).toEqual({ puts: ["A"], skippedOptional: ["B"], missing: [] });
  });

  it("an explicit name list narrows the put, and an unknown name is refused", () => {
    expect(planSecretPuts(m, "bot", files(["A", "B"]), ["B"])).toEqual({ puts: ["B"], skippedOptional: [], missing: [] });
    expect(() => planSecretPuts(m, "bot", files(["A"]), ["C"])).toThrow(/C is not a bot secret/);
    expect(() => planSecretPuts(m, "bot", files(["A"]), ["NOPE"])).toThrow(/NOPE is not a bot secret/);
  });

  it("an unknown Worker is refused", () => {
    expect(() => planSecretPuts(m, "edge", files([]))).toThrow(/unknown worker "edge"/);
  });
});
