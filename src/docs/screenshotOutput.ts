import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
const worker = fileURLToPath(new URL("../../scripts/screenshot-output-worker.mts", import.meta.url));

/** The output worker owns cwd changes; the capture process never makes them. */
function call(
  root: string,
  directory: string,
  operation: string,
  args: readonly string[] = [],
  input?: Buffer,
): Buffer | undefined {
  const child = spawnSync(tsx, [worker, operation, root, directory, ...args], { input, maxBuffer: 16 * 1024 * 1024 });
  if (child.error) throw child.error;
  if (child.status === 2) return undefined;
  if (child.status !== 0) {
    throw new Error(
      `Screenshot output ${operation} failed: ${child.stderr.toString("utf8") || child.signal || child.status}`,
    );
  }
  return child.stdout;
}

export function listOutputFiles(root: string, directory: string): string[] {
  return JSON.parse(call(root, directory, "list")!.toString("utf8")) as string[];
}

export function readOutputFile(root: string, directory: string, name: string): Buffer | undefined {
  return call(root, directory, "read", [name]);
}

export function publishOutputFile(root: string, directory: string, name: string, bytes: Buffer): void {
  call(root, directory, "publish", [name], bytes);
}

export function ensureOutputDirectory(root: string, directory: string): void {
  call(root, directory, "ensure");
}

export function removeUnexpectedOutputFiles(
  root: string,
  directory: string,
  suffix: string,
  expected: ReadonlySet<string>,
): string[] {
  const bytes = call(root, directory, "cleanup", [suffix], Buffer.from(JSON.stringify([...expected])));
  return JSON.parse(bytes!.toString("utf8")) as string[];
}
