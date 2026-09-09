import { join } from "node:path";

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

export interface OperatorRoot {
  mode: RootMode;
  /** The installation's own files: the profile, the config, `.env`, a relative `configSource` or `secretsSource`. */
  root: string;
  /** The shipped files: templates, manifests, examples, `project.json`, the Worker sources. */
  assets: string;
  /** The Worker directories wrangler runs in and their rendered configs: the root itself in a checkout, `<root>/.switchboard` from the package. */
  workArea: string;
}

/** Pure: the root for where this process runs from — the package root and whether it is the published package — and the directory it was started in. */
export function resolveOperatorRoot(input: { packageRoot: string; published: boolean; cwd: string }): OperatorRoot {
  if (!input.published)
    return { mode: "checkout", root: input.packageRoot, assets: input.packageRoot, workArea: input.packageRoot };
  return { mode: "package", root: input.cwd, assets: input.packageRoot, workArea: join(input.cwd, WORK_AREA_DIR) };
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
