#!/usr/bin/env node
// Choose CI work from the complete change range. Unknown inputs fail open: an
// extra check costs time, but a missed check can let a broken artifact ship.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BOT_CHECKS = ["check:consistency", "typecheck", "lint", "format:check", "check:dist"];
export const WORKERS = [
  "deploy/cloudflare",
  "deploy/cloudflare-memory",
  "deploy/cloudflare-resident",
  "deploy/cloudflare-sandbox",
];
export const IMAGES = ["deploy/cloudflare", "deploy/cloudflare-resident", "deploy/cloudflare-sandbox"];
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CODE = /\.(?:[cm]?[jt]sx?|vue)$/;

let consumers;

/** Source imports used by each verification surface, including its tests. */
function sourceConsumers() {
  if (consumers !== undefined) return consumers;
  const tracked = spawnSync("git", ["ls-files", "-z", "--", "src", "web/src", "web/vite.config.ts", ...WORKERS], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (tracked.status !== 0) return (consumers = null);
  const files = new Set(tracked.stdout.split("\0").filter(Boolean));
  const imports = new Map();
  const resolve = (from, spec) => {
    const target = spec.startsWith("@core/")
      ? `src/${spec.slice(6)}`
      : spec.startsWith(".")
        ? posix.normalize(posix.join(posix.dirname(from), spec))
        : undefined;
    if (!target || target.startsWith("../")) return undefined;
    const twin = target.replace(
      /\.(?:js|jsx|mjs|cjs)$/,
      (extension) => ({ ".js": ".ts", ".jsx": ".tsx", ".mjs": ".mts", ".cjs": ".cts" })[extension],
    );
    const candidates = [
      twin,
      target,
      ...[".ts", ".tsx", ".mts", ".js", ".vue", "/index.ts"].map((ext) => target + ext),
    ];
    return candidates.find((candidate) => files.has(candidate));
  };
  const dependencies = (file) => {
    if (imports.has(file)) return imports.get(file);
    if (!CODE.test(file)) return [];
    const source = readFileSync(join(ROOT, file), "utf8");
    const specs = [
      /\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
      /\bimport\s*['"]([^'"]+)['"]/g,
      /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    ].flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
    const found = specs.map((spec) => resolve(file, spec)).filter(Boolean);
    imports.set(file, found);
    return found;
  };
  const closure = (entries) => {
    const seen = new Set();
    const queue = [...entries];
    while (queue.length) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      queue.push(...dependencies(file));
    }
    return seen;
  };
  try {
    const web = closure(
      [...files].filter((file) => (file.startsWith("web/src/") || file === "web/vite.config.ts") && CODE.test(file)),
    );
    const workers = new Map(
      WORKERS.map((worker) => [
        worker,
        closure([...files].filter((file) => file.startsWith(`${worker}/`) && CODE.test(file))),
      ]),
    );
    return (consumers = { files, web, workers });
  } catch {
    return (consumers = null);
  }
}

const sha = (value) =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value) && !/^0+$/.test(value) ? value : undefined;

/** The event's base covers all commits in a push and the complete queue/PR diff. */
export function baseForEvent(name, event) {
  if (name === "push") return sha(event?.before);
  if (name === "pull_request") return sha(event?.pull_request?.base?.sha);
  if (name === "merge_group") return sha(event?.merge_group?.base_sha);
  return undefined;
}

export function fullPlan() {
  return {
    botChecks: BOT_CHECKS,
    botTests: true,
    web: true,
    docs: true,
    package: true,
    workers: WORKERS,
    images: IMAGES,
  };
}

/** Pure path selection; `none` keeps an otherwise empty matrix valid. */
export function planForPaths(paths) {
  const checks = new Set(["check:consistency"]);
  const workers = new Set();
  const images = new Set();
  const plan = { botChecks: [], botTests: false, web: false, docs: false, package: false, workers: [], images: [] };
  const source = () => {
    checks.add("typecheck");
    checks.add("lint");
    checks.add("format:check");
    plan.botTests = true;
  };
  const botArtifact = () => {
    checks.add("check:dist");
    plan.package = true;
    images.add("deploy/cloudflare");
  };
  for (const path of paths) {
    if (
      ["scripts/ci-plan.mjs", "scripts/ci-plan.d.mts", ".depot/workflows/ci.yml", ".github/workflows/ci.yml"].includes(
        path,
      )
    )
      return fullPlan();
    if (
      (/\.(?:[cm]?[jt]sx?|vue|css|jsonc?|ya?ml)$/.test(path) && path !== "package-lock.json") ||
      path === ".prettierignore"
    )
      checks.add("format:check");
    if (CODE.test(path)) checks.add("lint");
    if (CODE.test(path) && !/\.test\.[cm]?[jt]sx?$|\/testing\//.test(path)) plan.botTests = true;
    if (path.startsWith("docs/")) {
      plan.docs = true;
      if (path.startsWith("docs/.vitepress/")) plan.botTests = true;
      if (path === "docs/public/install.sh") {
        plan.package = true;
        plan.botTests = true;
      }
    } else if (path.startsWith("web/")) {
      plan.web = true;
      if (!/\.test\.[cm]?[jt]sx?$|\/testing\//.test(path)) {
        plan.botTests = true;
        plan.package = true;
        images.add("deploy/cloudflare");
      }
    } else if (path.startsWith("src/")) {
      source();
      if (!/\.test\.[cm]?[jt]sx?$|\/testing\//.test(path)) {
        botArtifact();
        const graph = sourceConsumers();
        if (!graph || !graph.files.has(path)) {
          plan.web = true;
          for (const worker of WORKERS) workers.add(worker);
        } else {
          if (graph.web.has(path)) plan.web = true;
          for (const worker of WORKERS) if (graph.workers.get(worker).has(path)) workers.add(worker);
        }
      }
    } else if (path.startsWith("scripts/")) {
      source();
      if (path === "scripts/check-dist.mjs") checks.add("check:dist");
      if (/^scripts\/(?:docs-gen|check-site)/.test(path)) plan.docs = true;
    } else if (path.startsWith("deploy/cloudflare-docs/")) {
      plan.docs = true;
      plan.botTests = true;
    } else if (WORKERS.some((worker) => path.startsWith(`${worker}/`))) {
      const worker = WORKERS.find((dir) => path.startsWith(`${dir}/`));
      workers.add(worker);
      if (!/\.test\.[cm]?[jt]sx?$|\/testing\//.test(path)) {
        plan.botTests = true;
        plan.package = true;
        if (IMAGES.includes(worker)) images.add(worker);
        if (path.endsWith("/package.json")) images.add("deploy/cloudflare");
      }
    } else if (path.startsWith("deploy/bin/")) {
      plan.package = true;
      plan.botTests = true;
    } else if (
      path.startsWith("deploy/hooks/") ||
      ["deploy/secrets.manifest.json", "deploy/profile.example.json"].includes(path)
    ) {
      plan.package = true;
      plan.botTests = true;
      images.add("deploy/cloudflare");
    } else if (path.startsWith("packages/switchboard/")) {
      plan.package = true;
      plan.botTests = true;
      if (path === "packages/switchboard/package.json") images.add("deploy/cloudflare");
    } else if (/^\.(?:github|depot)\/workflows\/.+\.ya?ml$/.test(path)) {
      plan.botTests = true;
    } else if (["package.json", "package-lock.json", ".nvmrc"].includes(path)) {
      return fullPlan();
    } else if (["tsconfig.json", "tsconfig.build.json", "tsconfig.scripts.json", "vitest.config.ts"].includes(path)) {
      source();
      if (path !== "vitest.config.ts") botArtifact();
    } else if (
      ["Dockerfile", ".dockerignore", "docker-entrypoint.sh", ".env.example", "config/config.example.yaml"].includes(
        path,
      )
    ) {
      plan.package = true;
      images.add("deploy/cloudflare");
      plan.botTests = true;
    } else if (path === "project.json") {
      plan.docs = true;
      plan.botTests = true;
      plan.package = true;
      images.add("deploy/cloudflare");
    } else if (["README.md", "LICENSE", "NOTICE"].includes(path)) {
      plan.package = true;
    } else if (
      /^(?:AGENTS\.md|CONTRIBUTING\.md|\.gitignore|\.prettierignore|\.prettierrc(?:\.json)?|eslint\.config\.[cm]?js|release-please-config\.json|\.release-please-manifest\.json|docker-compose\.yml|project\.json)$/.test(
        path,
      )
    ) {
      if (path.startsWith("eslint.config")) checks.add("lint");
    } else if (path.startsWith("config/")) {
      plan.package = true;
      plan.botTests = true;
      images.add("deploy/cloudflare");
    } else if (path.startsWith("skills/")) {
      plan.botTests = true;
      images.add("deploy/cloudflare");
    } else {
      return fullPlan();
    }
  }
  plan.botChecks = BOT_CHECKS.filter((check) => checks.has(check));
  plan.workers = WORKERS.filter((worker) => workers.has(worker));
  plan.images = IMAGES.filter((image) => images.has(image));
  if (plan.workers.length === 0) plan.workers = ["none"];
  if (plan.images.length === 0) plan.images = ["none"];
  return plan;
}

function diffPaths(base) {
  const result = spawnSync("git", ["diff", "--name-only", "--no-renames", "-z", base, "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.split("\0").filter(Boolean) : undefined;
}

function main() {
  const override = process.argv[2] === "--base" && process.argv.length === 4 ? process.argv[3] : undefined;
  let event;
  try {
    event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  } catch {
    event = {};
  }
  const base = override ?? baseForEvent(process.env.GITHUB_EVENT_NAME, event) ?? sha(process.env.CI_BASE_SHA);
  const paths = base ? diffPaths(base) : undefined;
  const plan = paths ? planForPaths(paths) : fullPlan();
  const reason = paths ? `${paths.length} changed path(s) against ${base}` : "no trustworthy diff; running every leg";
  console.log(`ci:plan — ${reason}`);
  console.log(JSON.stringify(plan));
  if (process.env.GITHUB_OUTPUT) {
    for (const [key, value] of Object.entries(plan)) {
      const output = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      appendFileSync(process.env.GITHUB_OUTPUT, `${output}=${JSON.stringify(value)}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
