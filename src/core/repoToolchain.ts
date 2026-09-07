// The onboard-time command table, derived from what the repo root actually
// holds (features/resident-repos.md item 52). Before this, an onboard that named
// no commands got `npm install` / `npm run build --if-present` / `npm test`
// unconditionally — and 2026-09-03 two residents went `down` at their first
// install: a pnpm workspace (`npm install` → EOVERRIDE) and a Terraform repo
// with no package.json at all. Pure: the caller fetches the root listing and
// package.json (`src/execution/githubRepoInspect.ts`); this decides.

/** The package manager the root lockfile / `packageManager` field names, or
 *  `none` when the root holds no `package.json`. */
export type Toolchain = "npm" | "pnpm" | "yarn" | "bun" | "none";

/** What the inspector reads at the repo root: the top-level entry names and,
 *  when present, the parsed `package.json` fields that decide commands. */
export interface RepoRootFacts {
  entries: readonly string[];
  packageJson?: { scripts?: Record<string, unknown>; packageManager?: unknown } | null;
}

/** The command table the resident stores: `build` and `test` always (its
 *  `parseCommands` requires them), `install` only when there is something to
 *  install. */
export interface DetectedCommands {
  toolchain: Toolchain;
  commands: { install?: string; build: string; test: string };
  /** Why a command is what it is, in the operator's words — shown in the
   *  onboard reply so a surprising table is explained, not just stated. */
  notes: string[];
}

/** A step the repo has no script for. The resident requires a non-empty
 *  `build`/`test`, and `true` is the smallest honest command: it exits 0 and
 *  does nothing, and the reply names it as "no build step". */
export const NO_OP_COMMAND = "true";

/** The table an onboard falls back to when the root cannot be inspected at all
 *  (no GitHub credential, or the API call failed): the historical npm defaults
 *  (verbatim what U3 proved on jshttp/vary). */
export const NPM_FALLBACK_COMMANDS = {
  install: "npm install --no-audit --no-fund",
  build: "npm run build --if-present",
  test: "npm test",
} as const;

// Every manager this table can name is baked into the resident image
// (`deploy/cloudflare-resident/Dockerfile`: npm + bun from the base, pnpm + yarn
// installed at build time) — a detected install command must exist where it
// runs, or detection only moves the failure.
const LOCKFILE_TOOLCHAIN: ReadonlyArray<readonly [string, Toolchain]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

/** `pnpm@10.10.0` → `pnpm`; anything else → undefined. */
function toolchainFromPackageManager(value: unknown): Toolchain | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.split("@")[0]?.trim();
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" ? name : undefined;
}

function hasScript(pkg: RepoRootFacts["packageJson"], name: string): boolean {
  const scripts = pkg?.scripts;
  return (
    typeof scripts === "object" && scripts !== null && typeof (scripts as Record<string, unknown>)[name] === "string"
  );
}

/** Decide the command table from the root facts. Precedence for the package
 *  manager: `packageManager` field → lockfile → npm. A repo without a root
 *  `package.json` gets no install and no-op build/test — never `npm` commands
 *  that can only fail. */
export function detectCommands(facts: RepoRootFacts): DetectedCommands {
  const entries = new Set(facts.entries);
  const notes: string[] = [];
  if (!entries.has("package.json")) {
    const lock = LOCKFILE_TOOLCHAIN.find(([file]) => entries.has(file));
    notes.push(
      `no package.json at the repo root${lock ? ` (a ${lock[0]} without one is not a root package)` : ""} — nothing to install or build; pass --test/--build to set real commands`,
    );
    return { toolchain: "none", commands: { build: NO_OP_COMMAND, test: NO_OP_COMMAND }, notes };
  }

  const pkg = facts.packageJson ?? null;
  const fromField = toolchainFromPackageManager(pkg?.packageManager);
  const lock = LOCKFILE_TOOLCHAIN.find(([file]) => entries.has(file));
  const toolchain: Toolchain = fromField ?? lock?.[1] ?? "npm";
  if (fromField) notes.push(`package manager from package.json packageManager (${String(pkg?.packageManager)})`);
  else if (lock) notes.push(`package manager from ${lock[0]}`);
  else notes.push("no lockfile at the repo root — assuming npm");

  const install =
    toolchain === "pnpm"
      ? "pnpm install --frozen-lockfile"
      : toolchain === "yarn"
        ? entries.has(".yarnrc.yml")
          ? "yarn install --immutable"
          : "yarn install --frozen-lockfile"
        : toolchain === "bun"
          ? "bun install --frozen-lockfile"
          : NPM_FALLBACK_COMMANDS.install;

  let build: string;
  if (hasScript(pkg, "build")) build = `${toolchain} run build`;
  else {
    build = NO_OP_COMMAND;
    notes.push("no build script — build is a no-op");
  }
  let test: string;
  if (hasScript(pkg, "test")) test = toolchain === "npm" ? "npm test" : `${toolchain} test`;
  else {
    test = NO_OP_COMMAND;
    notes.push("no test script — test is a no-op; pass --test to set one");
  }
  return { toolchain, commands: { install, build, test }, notes };
}
