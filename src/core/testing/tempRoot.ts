import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// vitest's one global setup (vitest.config.ts): every temp directory a test
// makes lives under a root of this run's own, and the root goes when the run
// ends. The suites call `mkdtempSync(join(tmpdir(), "swb-…"))` in sixty-odd
// files and most never remove what they made — one `npm test` left about
// 7,500 directories in the shared temp dir, and one machine accumulated
// 950,000 of them (19 GB), which slowed every temp-dir glob and every tool
// that indexes the folder. Rather than a cleanup in each file, which the
// next test would forget, the root is the boundary: `os.tmpdir()`
// reads `TMPDIR` on every call, the worker processes inherit this process's
// environment, and so does every child a test spawns, so one `rm` at
// teardown takes the whole run's litter with it. `TMP` and `TEMP` are set
// too, for the platforms and tools that read those instead. A run killed
// before teardown leaves one directory, named for what it is.
//
// The prefix is the receipt: a test that lands anywhere but under a
// `swb-vitest-*` root has escaped the boundary, and tempRoot.test.ts fails.
export const TEMP_ROOT_PREFIX = "swb-vitest-";

export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), TEMP_ROOT_PREFIX));
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  return () => rmSync(root, { recursive: true, force: true });
}
