import { describe, expect, it } from "vitest";
import type { ExecOptions, Executor } from "../../../execution/executor.js";
import {
  ExecPiContainer,
  INLINE_LINE_CHARS,
  PiContainerError,
  WRITE_CHUNK_CHARS,
  aliveScript,
  feedFileScript,
  killScript,
  readLogScript,
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
  it("writes a file with printf in chunks a command can carry — exact bytes, the first creating it under umask 077", () => {
    const [one] = writeFileScripts("/tmp/switchboard-pi/run-7/agent/SYSTEM.md", "hello 'quoted'\nline two");
    expect(one).toBe(
      `mkdir -p '/tmp/switchboard-pi/run-7/agent' && umask 077 && printf '%s' 'hello '\\''quoted'\\''\nline two' > '/tmp/switchboard-pi/run-7/agent/SYSTEM.md'`,
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

  it("alive reads the word, kill runs the script, tail never throws", async () => {
    const { executor, calls } = recordingExecutor(["alive\n", "dead\n", "(no output)", "exit 1:\nno such file"]);
    const c = new ExecPiContainer(executor);
    expect(await c.alive(4242)).toBe(true);
    expect(await c.alive(4242)).toBe(false);
    await c.kill(4242);
    expect(calls[2].command).toBe(killScript(4242));
    expect(await c.tail(paths.errLog, 2000)).toBe("");
  });

  it("a command the executor reports as failed is a PiContainerError naming the operation", async () => {
    const { executor } = recordingExecutor(["exit 1:\nmkfifo: cannot create fifo"]);
    await expect(new ExecPiContainer(executor).start({ paths, args: [], env: {} })).rejects.toThrow(
      /start failed — exit 1:\nmkfifo/,
    );
  });
});
