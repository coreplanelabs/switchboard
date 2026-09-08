import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { PROFILE_EXAMPLE_PATH } from "../deploy/profile.js";
import { PACKAGE_ROOT, RUNS_FROM_PUBLISHED_PACKAGE } from "../packageRoot.js";
import { OPERATOR_ROOT } from "../deploy/host.js";
import { meatOnPath } from "../core/meatProcess.js";
import type { InitTemplates, PlannedFile } from "./plan.js";

// `switchboard init`, the host half: the templates come from the PACKAGE (the
// checkout this CLI runs from, `/app` in the container, `dist/assets` in the
// published package — src/packageRoot.ts), the files go to
// the WORKING DIRECTORY (what `ask` and the bot read `./config/config.yaml`
// and `.env` from), and the one file that carries secrets is created — or,
// under --force, replaced — at mode 600. The prompt exists only on a terminal:
// a secret is typed with the echo off, and a process without a TTY gets no
// prompt at all, so a missing flag there is a refusal, never a hang.

/** Where each template lives under the package root. */
export const TEMPLATE_PATHS: Readonly<Record<keyof InitTemplates, string>> = {
  env: ".env.example",
  config: "config/config.example.yaml",
  profile: PROFILE_EXAMPLE_PATH,
};

/** The three examples, read from the package; a missing one is an error naming it. */
export async function readTemplates(root: string = PACKAGE_ROOT): Promise<InitTemplates> {
  const read = async (key: keyof InitTemplates): Promise<string> => {
    const path = join(root, TEMPLATE_PATHS[key]);
    if (!existsSync(path)) throw new Error(`${TEMPLATE_PATHS[key]}: no such file under ${root}`);
    return readFile(path, "utf8");
  };
  return { env: await read("env"), config: await read("config"), profile: await read("profile") };
}

/** True when `cwd` is the package root itself — the checkout `deploy/` lives in. Symlinks resolved on both sides. */
export function isCheckoutRoot(cwd: string = process.cwd(), root: string = PACKAGE_ROOT): boolean {
  try {
    return realpathSync(resolve(cwd)) === realpathSync(root);
  } catch {
    return false;
  }
}

/** Write a planned file under `cwd`, creating its directory, at its mode. The
 *  bytes go to a fresh temp file beside the target, created at 600 (a name
 *  nobody has open, so the mode is the creation mode — `writeFile`'s mode is
 *  ignored on a file that already exists), then chmod'ed to the planned mode and
 *  renamed over the target: a secret never exists on disk at a looser mode, and a
 *  `--force` replacement of a 644 `.env` ends at 600 too. The temp file is
 *  removed if anything fails before the rename. */
export async function writePlannedFile(file: PlannedFile, cwd: string = process.cwd()): Promise<void> {
  const path = join(cwd, file.path);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, file.text, { mode: 0o600, flag: "wx" });
    await chmod(temp, file.mode);
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

/** The mode bits of a file, for the tests and the receipt: `0o600` for `.env`. */
export function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/** How the command asks for what a flag did not give: the question, and whether the answer is a secret. */
export type Prompter = (question: string, opts: { secret: boolean }) => Promise<string>;

/**
 * A prompter over the process's terminal, or undefined when stdin or stdout is
 * not a TTY (a pipe, CI, the tutorial's receipt run) — the command then never
 * asks and refuses on a missing flag. A secret answer is read with readline's
 * output pointed at nothing, so the terminal shows the question and never the
 * keystrokes; a plain answer echoes as typed.
 */
export function ttyPrompter(
  io: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream } = { stdin: process.stdin, stdout: process.stdout },
): Prompter | undefined {
  if (!io.stdin.isTTY || !io.stdout.isTTY) return undefined;
  return async (question, { secret }) => {
    if (!secret) {
      const rl = createInterface({ input: io.stdin, output: io.stdout, terminal: true });
      try {
        return (await rl.question(question)).trim();
      } finally {
        rl.close();
      }
    }
    io.stdout.write(question);
    const silent = new Writable({ write: (_chunk, _enc, cb) => cb() });
    const rl = createInterface({ input: io.stdin, output: silent, terminal: true });
    try {
      return (await rl.question("")).trim();
    } finally {
      rl.close();
      io.stdout.write("\n");
    }
  };
}

/** One string fact from `project.json` at the package root; a missing one is an error naming it. */
function projectFact(name: "image" | "npmPackage", root: string): string {
  const facts = JSON.parse(readFileSync(join(root, "project.json"), "utf8")) as Record<string, unknown>;
  const value = facts[name];
  if (typeof value !== "string") throw new Error(`project.json: no \`${name}\` fact`);
  return value;
}

/** `project.json`'s `image` fact, from the package root. */
export function publishedImage(root: string = PACKAGE_ROOT): string {
  return projectFact("image", root);
}

/** `project.json`'s `npmPackage` — the npm package name — from the package root. */
export function publishedPackage(root: string = PACKAGE_ROOT): string {
  return projectFact("npmPackage", root);
}

/** What `src/core/commands/setup.ts` binds to on a real host (see `SetupCommandDeps`). The directory
 *  is the operator root (src/deploy/operatorRoot.ts) — the checkout, or from the package the installation
 *  `SWITCHBOARD_HOME` / a cwd that holds one / `~/.switchboard` names — so `init` needs no `mkdir` first. */
export function hostSetupIO(cwd: string = OPERATOR_ROOT.root, startedIn: string = process.cwd()) {
  return {
    templates: () => readTemplates(),
    // Where the files went when that is not where the operator stands — `init` prints it.
    root: () => (resolve(cwd) === resolve(startedIn) ? undefined : cwd),
    exists: async (path: string) => existsSync(join(cwd, path)),
    write: (file: PlannedFile) => writePlannedFile(file, cwd),
    // A file the operator NAMED (`--github-private-key-file app.pem`) is where the operator stands,
    // not in the installation: `init` run from ~/Downloads reads ~/Downloads/app.pem.
    readFile: async (path: string): Promise<string | undefined> => {
      const abs = resolve(startedIn, path);
      return existsSync(abs) ? readFile(abs, "utf8") : undefined;
    },
    inCheckout: () => isCheckoutRoot(cwd),
    image: () => publishedImage(),
    // The name to run `ask` as next — only when this process IS the published package.
    package: () => (RUNS_FROM_PUBLISHED_PACKAGE ? publishedPackage() : undefined),
    env: process.env,
    meatBinary: meatOnPath(process.env),
    prompt: ttyPrompter(),
  };
}
