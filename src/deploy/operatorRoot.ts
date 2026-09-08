import { isAbsolute, join, resolve } from "node:path";

/** `~` and `~/x` are the home (when known); anything else is made absolute from the cwd. */
function expandHome(value: string, home: string | undefined, cwd: string): string {
  if (home && (value === "~" || value.startsWith("~/"))) return join(home, value.slice(1));
  return isAbsolute(value) ? value : resolve(cwd, value);
}

// Where a deploy's files live, resolved once per process (src/deploy/host.ts
// `OPERATOR_ROOT`; docs/reference/specs/release-and-deploy.md item 24). The deploy commands read three kinds of file, and in a checkout all
// three sit under the repository root: the installation's own (`deploy/profile.json`,
// `config/config.yaml`, `.env`), the shipped ones (the Worker templates and
// sources, the secrets manifest, the examples) and the Worker directories
// wrangler runs in, with their rendered `wrangler.jsonc`. From the published
// npm package there is no repository: the installation's files are in the
// directory the operator ran `init` in, the shipped ones are the package's
// `dist/assets/` (src/packageRoot.ts), and the Worker directories are
// materialised from those assets under `<root>/.switchboard/` (src/deploy/workArea.ts).
// One value says which is which; every path a deploy command touches goes
// through it, so the checkout path is exactly what it was and the package path
// never reads or writes inside the installed package.

export type RootMode = "checkout" | "package";

/** The work area under an operator's directory: the shipped tree, materialised, plus each Worker's install. */
export const WORK_AREA_DIR = ".switchboard";

/** The installation directory when nothing else names one: `~/.switchboard`. An operator runs
 *  `npx <package> init` from wherever they are and needs no `mkdir` first. */
export const HOME_DIR_NAME = ".switchboard";
/** Names the installation outright, over the cwd and the home default. */
export const HOME_ENV = "SWITCHBOARD_HOME";
/** Any one of these under the cwd makes the cwd the installation — the pre-home behaviour, kept for a
 *  directory an operator already set up (or wants two of, one per directory). */
export const INSTALLATION_MARKERS = [".env", "config/config.yaml", "deploy/profile.json"] as const;

/** Why the root is where it is. `init` reports the root when it is not the cwd (`wrote to <root>:`); the tests pin the reason. */
export type RootChosenBy = "checkout" | typeof HOME_ENV | "cwd" | "home";

export interface OperatorRoot {
  mode: RootMode;
  /** The installation's own files: the profile, the config, `.env`, a relative `configSource` or `secretsSource`. */
  root: string;
  /** The shipped files: templates, manifests, examples, `project.json`, the Worker sources. */
  assets: string;
  /** The Worker directories wrangler runs in and their rendered configs: the root itself in a checkout, `<root>/.switchboard` from the package. */
  workArea: string;
  chosenBy: RootChosenBy;
}

/** Pure: the root for where this process runs from. A checkout is its own root. From the published
 *  package the installation is, in order: `SWITCHBOARD_HOME` when set (`~` and `~/…` are the home;
 *  a relative value is taken from the cwd, so the root is always absolute); the cwd when it already
 *  holds an installation (any INSTALLATION_MARKERS file, probed with `exists`); else `<home>/.switchboard`.
 *  Without a home or a probe the cwd is the installation, as before. */
export function resolveOperatorRoot(input: {
  packageRoot: string;
  published: boolean;
  cwd: string;
  home?: string;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
}): OperatorRoot {
  if (!input.published)
    return {
      mode: "checkout",
      root: input.packageRoot,
      assets: input.packageRoot,
      workArea: input.packageRoot,
      chosenBy: "checkout",
    };
  const pick = (root: string, chosenBy: RootChosenBy): OperatorRoot => ({
    mode: "package",
    root,
    assets: input.packageRoot,
    workArea: join(root, WORK_AREA_DIR),
    chosenBy,
  });
  const named = input.env?.[HOME_ENV]?.trim();
  if (named) return pick(expandHome(named, input.home, input.cwd), HOME_ENV);
  if (!input.exists || !input.home) return pick(input.cwd, "cwd");
  if (INSTALLATION_MARKERS.some((m) => input.exists!(join(input.cwd, m)))) return pick(input.cwd, "cwd");
  return pick(join(input.home, HOME_DIR_NAME), "home");
}

/** An installation file (`deploy/profile.json`, `config/config.yaml`), or a relative source path, under the root. */
export function installationPath(at: Pick<OperatorRoot, "root">, rel: string): string {
  return join(at.root, rel);
}

/** A shipped file (a template, the manifest, an example) at its tree path. */
export function assetPath(at: Pick<OperatorRoot, "assets">, rel: string): string {
  return join(at.assets, rel);
}

/** A Worker directory, or a file rendered into one, at its tree path under the work area. */
export function workPath(at: Pick<OperatorRoot, "workArea">, rel: string): string {
  return join(at.workArea, rel);
}

/** How a work-area path reads in output, relative to the root: `deploy/…` in a checkout, `.switchboard/deploy/…` from the package. */
export function displayPath(mode: RootMode, rel: string): string {
  return mode === "checkout" ? rel : `${WORK_AREA_DIR}/${rel}`;
}
