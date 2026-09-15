import { describe, expect, it } from "vitest";
import type { ExecOptions, Executor } from "../../../execution/executor.js";
import {
  ExecPiContainer,
  INLINE_LINE_CHARS,
  PiContainerError,
  WRITE_CHUNK_CHARS,
  aliveScript,
  identityScript,
  feedFileScript,
  killScript,
  readLogScript,
  removeScript,
  startScript,
  stdoutOf,
  writeFileScripts,
  writeLineScript,
} from "./container.js";
import { piRunPaths } from "./process.js";

// Feature: docs/reference/specs/harness-pi.md item 4 — the container seam over
// the run's own Executor: every operation is one command as the thread's user,
// the bearer travels in the exec's env and never in a command, the log is read
// as exact bytes, and a failed command is a named error, never a silent empty.

const paths = piRunPaths("run-7");

/** An executor that records every command and answers what the test says. */
function recordingExecutor(answers: string[] = []) {
  const calls: Array<{ command: string; opts: ExecOptions | undefined }> = [];
  const executor: Executor = {
    exec: async (command, opts) => {
      calls.push({ command, opts });
      return answers.shift() ?? "(no output)";
    },
    readFile: async () => "",
    writeFile: async () => "",
  };
  return { executor, calls };
}

describe("the container scripts", () => {
  it("writes a file with printf in chunks a command can carry: exact bytes, the first creating its directories at 700 (the umask before the mkdir, so the run's root under /tmp is the caller's alone)", () => {
    const [one] = writeFileScripts(`${paths.agentDir}/SYSTEM.md`, "hello 'quoted'\nline two");
    expect(one).toBe(
      `umask 077 && mkdir -p '/tmp/switchboard-pi-run-7/agent' && printf '%s' 'hello '\\''quoted'\\''\nline two' > '/tmp/switchboard-pi-run-7/agent/SYSTEM.md'`,
    );
    const big = "x".repeat(WRITE_CHUNK_CHARS * 2 + 5);
    const scripts = writeFileScripts("/tmp/f", big);
    expect(scripts).toHaveLength(3);
    expect(scripts[0]).toContain(" > '/tmp/f'");
    expect(scripts[1]).toMatch(/^printf '%s' 'x+' >> '\/tmp\/f'$/);
    expect(scripts[2]).toBe(`printf '%s' '${"x".repeat(5)}' >> '/tmp/f'`);
    expect(writeFileScripts("/tmp/empty", "")).toHaveLength(1);
  });

  it("starts pi detached behind a FIFO held open for writing, its pid recorded, its stdout filtered of streaming deltas into the log", () => {
    const script = startScript({ paths, args: ["--mode", "rpc", "-e", paths.extension], env: { X: "1" } });
    // The directories at 700 in a subshell: the run's root is the caller's alone, and pi's own umask is untouched.
    expect(
      script.startsWith(`(umask 077 && mkdir -p '${paths.dir}' '${paths.sessionDir}' '${paths.commandDir}') && `),
    ).toBe(true);
    expect(script).toContain(`mkfifo -m 600 '${paths.fifo}'`);
    expect(script).toContain("setsid -f sh -c ");
    expect(script).toContain("exec 3<>");
    expect(script).toContain("echo $$ > ");
    expect(script).toContain("<&3 2>>");
    expect(script).toContain("grep --line-buffered -v");
    expect(script).toContain(`"type":"message_update"`);
    expect(script.endsWith(`cat '${paths.pidFile}'`)).toBe(true);
    // The environment is not in the script: the bearer rides the exec's env channel.
    expect(script).not.toContain("X=1");
    expect(script).not.toContain("SWITCHBOARD_RUN_BEARER");
  });

  it("feeds one line to the FIFO, or a long one from a file it then removes", () => {
    expect(writeLineScript(paths.fifo, '{"type":"abort"}')).toBe(
      `printf '%s\\n' '{"type":"abort"}' >> '${paths.fifo}'`,
    );
    expect(feedFileScript(paths.fifo, `${paths.commandDir}/1.json`)).toBe(
      `cat '${paths.commandDir}/1.json' >> '${paths.fifo}' && printf '\\n' >> '${paths.fifo}' && rm -f '${paths.commandDir}/1.json'`,
    );
  });

  it("reads the log from a byte offset as one-line base64, asks whether a pid lives, ends a group then its leader", () => {
    expect(readLogScript(paths.log, 1024, 4096)).toBe(
      `tail -c +1025 '${paths.log}' | head -c 4096 | base64 | tr -d '\\n'`,
    );
    expect(aliveScript(4242)).toBe("kill -0 4242 2>/dev/null && echo alive || echo dead");
    // The container's identity is the kernel's boot id: one per VM boot, world-readable, never a failure.
    expect(identityScript()).toBe("cat /proc/sys/kernel/random/boot_id 2>/dev/null || true");
    expect(killScript(4242)).toBe(
      "kill -TERM -- -4242 2>/dev/null; kill -TERM 4242 2>/dev/null; sleep 1; kill -KILL -- -4242 2>/dev/null; kill -KILL 4242 2>/dev/null; true",
    );
  });
});

describe("stdoutOf — an executor's answer as the operation's stdout", () => {
  it("keeps stdout, drops the appended stderr, reads the empty marker as empty, and names a failed command", () => {
    expect(stdoutOf("read", "abc\n--- stderr ---\nnoise")).toBe("abc");
    expect(stdoutOf("read", "(no output)")).toBe("");
    expect(() => stdoutOf("start", "exit 127:\nsh: pi: not found")).toThrow(PiContainerError);
    expect(() => stdoutOf("start", "exit 127:\nsh: pi: not found")).toThrow(/start failed — exit 127/);
  });

  // harness-pi item 16: the resident answers an isolate swapped under a
  // command with `runtime-replaced: …` as the command's own text, and the
  // sandbox names a silent runtime `runtime-unreachable: …`; neither is what
  // the command printed, so `alive` must not read the first as "dead" nor
  // `read` decode it as log bytes — the operation fails naming the word.
  it("the executors' runtime word in place of a command's output is a failure naming it, never the command's stdout", () => {
    const replaced =
      "runtime-replaced: the resident runtime was replaced (a deploy) while this command ran\n" +
      "The command may have started; re-check its effects (e.g. git status, the files it writes) before re-running it.";
    expect(() => stdoutOf("alive", replaced)).toThrow(PiContainerError);
    expect(() => stdoutOf("alive", replaced)).toThrow(
      /^pi container: alive failed — runtime-replaced: the resident runtime was replaced/,
    );
    expect(() =>
      stdoutOf("read", "runtime-unreachable: the sandbox container's runtime did not answer (container abc)"),
    ).toThrow(/^pi container: read failed — runtime-unreachable: /);
    // A command's own output that mentions the word is the output it is.
    expect(stdoutOf("read", "grep: runtime-replaced matched 3 lines")).toBe("grep: runtime-replaced matched 3 lines");
  });
});

describe("ExecPiContainer — each operation is one command over the executor", () => {
  it("start runs the wrapper with the env on the exec and parses the pid from the last line", async () => {
    const { executor, calls } = recordingExecutor(["4242\n"]);
    const c = new ExecPiContainer(executor);
    const env = { SWITCHBOARD_RUN_BEARER: "sbr_run-7.secret", PI_CODING_AGENT_DIR: paths.agentDir };
    await expect(c.start({ paths, args: ["--mode", "rpc"], env })).resolves.toEqual({ pid: 4242 });
    expect(calls[0].opts?.env).toEqual(env);
    expect(calls[0].command).not.toContain("secret");
    expect(calls[0].opts?.timeoutMs).toBe(60_000);
  });

  it("start without a pid is a named failure", async () => {
    const { executor } = recordingExecutor(["(no output)"]);
    await expect(new ExecPiContainer(executor).start({ paths, args: [], env: {} })).rejects.toThrow(/no pid came back/);
  });

  it("writeLine feeds a short line inline and a long one through a numbered file", async () => {
    const { executor, calls } = recordingExecutor();
    const c = new ExecPiContainer(executor);
    await c.writeLine(paths, '{"type":"get_state"}');
    expect(calls[0].command).toBe(writeLineScript(paths.fifo, '{"type":"get_state"}'));
    const long = JSON.stringify({ type: "prompt", message: "m".repeat(INLINE_LINE_CHARS + 1) });
    await c.writeLine(paths, long);
    expect(calls[1].command).toContain(`> '${paths.commandDir}/1.json'`);
    expect(calls[calls.length - 1].command).toBe(feedFileScript(paths.fifo, `${paths.commandDir}/1.json`));
  });

  it("readLog decodes the base64 answer to exact bytes, and an empty answer to none", async () => {
    const { executor } = recordingExecutor([
      Buffer.from('{"type":"agent_start"}\n').toString("base64") + "\n",
      "(no output)",
    ]);
    const c = new ExecPiContainer(executor);
    expect(Buffer.from(await c.readLog(paths.log, 0, 4096)).toString("utf8")).toBe('{"type":"agent_start"}\n');
    expect(await c.readLog(paths.log, 23, 4096)).toHaveLength(0);
  });

  it("identity reads the boot id, and answers none for an empty or malformed word or a failed command", async () => {
    const { executor, calls } = recordingExecutor([
      "3f1c2a6e-9b0d-4d2e-8a1f-0c9e7b6a5d43\n",
      "(no output)",
      "not an id at all, with spaces\n",
      "exit 1:\nno shell",
    ]);
    const c = new ExecPiContainer(executor);
    expect(await c.identity()).toBe("3f1c2a6e-9b0d-4d2e-8a1f-0c9e7b6a5d43");
    expect(calls[0].command).toBe(identityScript());
    expect(await c.identity()).toBeUndefined();
    expect(await c.identity()).toBeUndefined();
    expect(await c.identity()).toBeUndefined();
  });

  it("alive reads the word, kill runs the script, tail never throws", async () => {
    const { executor, calls } = recordingExecutor(["alive\n", "dead\n", "(no output)", "exit 1:\nno such file"]);
    const c = new ExecPiContainer(executor);
    expect(await c.alive(4242)).toBe(true);
    expect(await c.alive(4242)).toBe(false);
    await c.kill(4242);
    expect(calls[2].command).toBe(killScript(4242));
    expect(await c.tail(paths.errLog, 2000)).toBe("");
  });

  it("remove takes the run's directory down as one tree, and nothing else", async () => {
    expect(removeScript(paths.dir)).toBe(`rm -rf '/tmp/switchboard-pi-run-7'`);
    const { executor, calls } = recordingExecutor();
    await new ExecPiContainer(executor).remove(paths);
    expect(calls.map((c) => c.command)).toEqual([`rm -rf '/tmp/switchboard-pi-run-7'`]);
  });

  it("a command the executor reports as failed is a PiContainerError naming the operation", async () => {
    const { executor } = recordingExecutor(["exit 1:\nmkfifo: cannot create fifo"]);
    await expect(new ExecPiContainer(executor).start({ paths, args: [], env: {} })).rejects.toThrow(
      /start failed — exit 1:\nmkfifo/,
    );
  });
});

/** The least of a filesystem the defect needs: directories with an owner and
 *  a mode, `mkdir -p`'s rule for a component it must create (the parent is
 *  the caller's own, or world-writable), and the sticky bit's rule for
 *  removal (an entry under `/tmp` goes only for its owner). `/tmp` is root's
 *  at 1777, as on the resident; a directory `mkdir -p` creates is its
 *  caller's, at 700 when `umask 077` came earlier in the command and at 755
 *  otherwise. Every other command is taken as done and answered with what the
 *  test scripted. */
class FakeDirectoryTree {
  readonly dirs = new Map<string, { owner: string; mode: number }>([
    ["/", { owner: "root", mode: 0o755 }],
    ["/tmp", { owner: "root", mode: 0o1777 }],
  ]);

  /** `mkdir -p <path>` as `user`: the line mkdir would print, or nothing on success. */
  mkdirP(path: string, user: string, mode: number): string | undefined {
    let current = "";
    for (const part of path.split("/").filter(Boolean)) {
      const parent = this.dirs.get(current || "/")!;
      current = `${current}/${part}`;
      if (this.dirs.has(current)) continue;
      if (parent.owner !== user && (parent.mode & 0o002) === 0)
        return `mkdir: cannot create directory '${current}': Permission denied`;
      this.dirs.set(current, { owner: user, mode });
    }
    return undefined;
  }

  /** `rm -rf <path>` as `user`: the line rm would print, or nothing on success (a missing path included). */
  rmRf(path: string, user: string): string | undefined {
    const entry = this.dirs.get(path);
    if (!entry) return undefined;
    if (entry.owner !== user) return `rm: cannot remove '${path}': Operation not permitted`;
    for (const dir of [...this.dirs.keys()]) if (dir === path || dir.startsWith(`${path}/`)) this.dirs.delete(dir);
    return undefined;
  }

  /** An executor running every command as `user`, the way the resident's /exec runs a thread's. */
  executorAs(user: string, answers: string[] = []): Executor {
    return {
      exec: async (command) => {
        for (const mkdir of command.matchAll(/mkdir -p ((?:'[^']*' ?)+)/g)) {
          const mode = command.slice(0, mkdir.index).includes("umask 077") ? 0o700 : 0o755;
          for (const [, path] of mkdir[1].matchAll(/'([^']*)'/g)) {
            const refused = this.mkdirP(path, user, mode);
            if (refused) return `exit 1:\n${refused}`;
          }
        }
        for (const [, path] of command.matchAll(/rm -rf '([^']*)'/g)) {
          const refused = this.rmRf(path, user);
          if (refused) return `exit 1:\n${refused}`;
        }
        return answers.shift() ?? "(no output)";
      },
      readFile: async () => "",
      writeFile: async () => "",
    };
  }
}

describe("ExecPiContainer on a resident, two thread users on one container", () => {
  // Production, the first review run on pi: a coding run as one pool user had
  // created a parent shared by every run two seconds earlier, and the
  // review's mkdir as another user was refused under it before any model
  // turn. The control builds that shape by hand: no path the harness derives
  // has a shared parent any more.
  it("the control: under one shared parent the first user's directory refuses the second user's mkdir, the failure a root of the run's own directly under /tmp removes", async () => {
    const tree = new FakeDirectoryTree();
    await new ExecPiContainer(tree.executorAs("worker2")).writeFile("/tmp/switchboard-pi/run-a/agent/SYSTEM.md", "a");
    expect(tree.dirs.get("/tmp/switchboard-pi")?.owner).toBe("worker2");
    await expect(
      new ExecPiContainer(tree.executorAs("worker3")).writeFile("/tmp/switchboard-pi/run-b/agent/SYSTEM.md", "b"),
    ).rejects.toThrow(
      /write failed .* exit 1:\nmkdir: cannot create directory '\/tmp\/switchboard-pi\/run-b': Permission denied/,
    );
  });

  it("two runs as two users both write their files, start their pi and remove their root: each run's root is its own directly under /tmp, made 700 by the user running it, so neither mkdir meets a parent the other owns", async () => {
    const tree = new FakeDirectoryTree();
    const runs = [
      { user: "worker2", paths: piRunPaths("run-a") },
      { user: "worker3", paths: piRunPaths("run-b") },
    ];
    for (const { user, paths: p } of runs) {
      const container = new ExecPiContainer(tree.executorAs(user, ["(no output)", "4242\n"]));
      await container.writeFile(`${p.agentDir}/SYSTEM.md`, "the prompt");
      await expect(container.start({ paths: p, args: [], env: {} })).resolves.toEqual({ pid: 4242 });
    }
    expect(tree.dirs.get("/tmp/switchboard-pi-run-a")).toEqual({ owner: "worker2", mode: 0o700 });
    expect(tree.dirs.get("/tmp/switchboard-pi-run-b")).toEqual({ owner: "worker3", mode: 0o700 });
    expect(tree.dirs.has("/tmp/switchboard-pi-run-a/agent/sessions")).toBe(true);
    expect(tree.dirs.has("/tmp/switchboard-pi-run-b/cmd")).toBe(true);
    // Nothing between /tmp and a run's root, shared or per user.
    const made = [...tree.dirs.keys()].filter((d) => d !== "/" && d !== "/tmp");
    expect(made.every((d) => d.startsWith("/tmp/switchboard-pi-run-"))).toBe(true);
    expect(tree.dirs.has("/tmp/switchboard-pi")).toBe(false);
    expect(tree.dirs.has("/tmp/switchboard-pi-worker2")).toBe(false);
    // Each run takes its own root down when it ends, and /tmp is as it was.
    for (const { user, paths: p } of runs) await new ExecPiContainer(tree.executorAs(user)).remove(p);
    expect([...tree.dirs.keys()]).toEqual(["/", "/tmp"]);
  });
});

// docs/reference/specs/harness-pi.md items 4 and 12: the seam's answer to
// where a fresh run's files go. The exec container names the predictable root
// its scripts make at 700 as the thread's user; no command runs for the answer.
describe("ExecPiContainer.makeRoot", () => {
  it("answers the predictable root under /tmp, the layout piRunPaths lays out, without running a command", async () => {
    const { executor, calls } = recordingExecutor();
    expect(await new ExecPiContainer(executor).makeRoot("run-7")).toEqual(piRunPaths("run-7"));
    expect(calls).toEqual([]);
  });
});

describe("ExecPiContainer.cwd", () => {
  it("answers the checkout the harness names, where the executor runs every command and so pi, without running a command", () => {
    const { executor, calls } = recordingExecutor();
    expect(new ExecPiContainer(executor).cwd(paths, "/workspace/threads/t/main")).toBe("/workspace/threads/t/main");
    expect(calls).toEqual([]);
  });
});
