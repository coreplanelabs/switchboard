import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute } from "node:path";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function sameDirectory(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function leaf(name: string): string {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error(`Invalid screenshot output name: ${name}`);
  }
  return name;
}

export interface PinnedDirectory {
  names(): string[];
  read(name: string): Buffer | undefined;
  publish(name: string, bytes: Buffer): void;
  remove(name: string): void;
  ensureChild(name: string): void;
}

/**
 * Run synchronous file operations relative to a verified directory inode. Node
 * has no openat API: opening each component without following its leaf symlink,
 * then comparing it with the new cwd, prevents a parent-path swap from moving
 * subsequent relative operations to another directory. The root is the CLI's
 * trusted repository cwd; this scope runs only on its main thread and never
 * awaits while the process-wide cwd is changed.
 */
export function withPinnedDirectory<T>(
  root: string,
  relativeDirectory: string,
  action: (directory: PinnedDirectory) => T,
): T | undefined {
  const parts = relativeDirectory ? relativeDirectory.split("/") : [];
  if (!isAbsolute(root) || parts.some((part) => !part || part === "." || part === ".." || /[\\\0]/.test(part))) {
    throw new Error(`Invalid screenshot output directory: ${relativeDirectory}`);
  }
  if (typeof constants.O_DIRECTORY !== "number" || typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("Screenshot output needs O_DIRECTORY and O_NOFOLLOW");
  }

  const savedPath = process.cwd();
  const saved = statSync(".", { bigint: true });
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let active = true;
  let result: T | undefined;
  let failure: unknown;
  let failed = false;
  try {
    const rootFd = openSync(root, flags);
    let finalFd: number | undefined = rootFd;
    try {
      process.chdir(root);
      if (!sameDirectory(fstatSync(rootFd, { bigint: true }), statSync(".", { bigint: true }))) {
        throw new Error("Screenshot output root changed while opening it");
      }

      let absent = false;
      for (const part of parts) {
        let fd: number;
        try {
          fd = openSync(part, flags);
        } catch (error) {
          if (!missing(error)) throw error;
          absent = true;
          break;
        }
        try {
          process.chdir(part);
          if (!sameDirectory(fstatSync(fd, { bigint: true }), statSync(".", { bigint: true }))) {
            throw new Error(`Screenshot output directory changed while opening: ${part}`);
          }
        } catch (error) {
          closeSync(fd);
          throw error;
        }
        if (finalFd !== undefined) closeSync(finalFd);
        finalFd = fd;
      }

      if (!absent) {
        const expected = fstatSync(finalFd!, { bigint: true });
        const assertPinned = (): void => {
          if (!active || !sameDirectory(expected, statSync(".", { bigint: true }))) {
            throw new Error("Screenshot output directory is no longer pinned");
          }
        };
        const directory: PinnedDirectory = {
          names() {
            assertPinned();
            return readdirSync(".");
          },
          read(name) {
            assertPinned();
            let fd: number;
            try {
              fd = openSync(leaf(name), constants.O_RDONLY | constants.O_NOFOLLOW);
            } catch (error) {
              if (missing(error)) return undefined;
              throw error;
            }
            try {
              if (!fstatSync(fd).isFile()) throw new Error(`Screenshot output is not a regular file: ${name}`);
              return readFileSync(fd);
            } finally {
              closeSync(fd);
            }
          },
          publish(name, bytes) {
            assertPinned();
            const destination = leaf(name);
            const temporary = `.${destination}.${randomUUID()}.tmp`;
            const fd = openSync(
              temporary,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o644,
            );
            try {
              try {
                writeFileSync(fd, bytes);
              } finally {
                closeSync(fd);
              }
              renameSync(temporary, destination);
            } catch (error) {
              try {
                unlinkSync(temporary);
              } catch (cleanupError) {
                if (!missing(cleanupError)) {
                  throw new AggregateError([error, cleanupError], "Screenshot output cleanup failed", {
                    cause: cleanupError,
                  });
                }
              }
              throw error;
            }
          },
          remove(name) {
            assertPinned();
            unlinkSync(leaf(name));
          },
          ensureChild(name) {
            assertPinned();
            try {
              mkdirSync(leaf(name));
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
            }
          },
        };
        result = action(directory);
        if (result && typeof (result as { then?: unknown }).then === "function") {
          throw new Error("Screenshot directory operations must be synchronous");
        }
      }
    } finally {
      active = false;
      if (finalFd !== undefined) closeSync(finalFd);
    }
  } catch (error) {
    failed = true;
    failure = error;
  }

  try {
    process.chdir(savedPath);
    if (!sameDirectory(saved, statSync(".", { bigint: true })) || process.cwd() !== savedPath) {
      throw new Error("Original working directory changed before restoration");
    }
  } catch (restoreError) {
    // A replaced saved path must not leave later work in an attacker directory.
    process.chdir("/");
    if (failed)
      throw new AggregateError([failure, restoreError], "Screenshot output and cwd restoration failed", {
        cause: restoreError,
      });
    throw restoreError;
  }
  if (failed) throw failure;
  return result;
}
