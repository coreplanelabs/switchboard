import { describe, expect, it } from "vitest";
import { shellQuote } from "../../execution/shellQuote.js";
import {
  ExecControlResetError,
  ExecInfraError,
  ExecSandboxRestartedError,
  type ExecOptions,
  type Executor,
  infraReasonOfRequestFailure,
  requestFailedMessage,
} from "../../execution/executor.js";
import { CONTAINER_GONE_WORDING } from "../../execution/residentWake.js";
import { STOPPED_CONTAINER_WORDING } from "../../execution/residentRefresh.js";
import {
  ResidentLeaseSpentError,
  residentAnswerReason,
  residentWakeBudgetStrike,
  residentWakeStrike,
} from "../../execution/resident.js";
import { sandboxEmptyFailureMessage, sandboxNoAnswerMessage } from "../../execution/cloudflareSandbox.js";
import { SANDBOX_START_BACKOFF_MS, SANDBOX_START_WAIT_MAX_MS } from "../../execution/sandboxErrors.js";
import {
  CONTAINER_DOWN_WORDING,
  identityOrNothing,
  CURL_MAX_TIME_S,
  ExecHarnessContainer,
  HARNESS_PORT_ENV,
  HarnessContainerControlResetError,
  HarnessContainerDownError,
  HarnessContainerError,
  HarnessContainerRuntimeReplacedError,
  INLINE_LINE_CHARS,
  isControlReset,
  OP_TIMEOUT_MS,
  PROBE_WAIT_BACKOFF_MS,
  PROBE_WAIT_MAX_MS,
  identityChangedCondition,
  infraErrorOf,
  isContainerGone,
  HarnessControlFileLostError,
  selfAndCauses,
  replacedBecause,
  replacedVerdict,
  saysTransportLost,
  PORT_ARG,
  WRITE_CHUNK_CHARS,
  aliveScript,
  identityScript,
  feedFileScript,
  killScript,
  logFilter,
  parseHttpResponse,
  readLogScript,
  removeScript,
  requestEnv,
  requestScript,
  startScript,
  stdoutOf,
  writeFileScripts,
  writeLineScript,
  type HarnessRequest,
  DETACHED_STDIO,
} from "./container.js";
import { PI_STDOUT_FILTER, piRunPaths } from "./pi/process.js";

// Feature: docs/reference/specs/harness.md item 9 and harness-pi.md item 4 —
// the container seam over the run's own Executor: every operation is one
// command as the thread's user, the bearer travels in the exec's env and never
// in a command, the log is read as exact bytes, a request into the container
// is curl over loopback, and a failed command is a named error, never a
// silent empty. Nothing here names a harness: the program, its arguments, the
// stdout filter and the layout are the start's inputs.

const paths = piRunPaths("run-7");
/** pi's start, as the harness makes it: pi on the PATH, its streaming deltas filtered at the source. */
const piStart = (args: string[], env: Record<string, string> = {}) => ({
  paths,
  command: "pi",
  args,
  env,
  stdoutFilter: PI_STDOUT_FILTER,
});

/** An executor that records every command and answers what the test says. */
function recordingExecutor(answers: Array<string | Error> = []) {
  const calls: Array<{ command: string; opts: ExecOptions | undefined }> = [];
  const executor: Executor = {
    exec: async (command, opts) => {
      calls.push({ command, opts });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? "(no output)";
    },
    readFile: async () => "",
    writeFile: async () => "",
  };
  return { executor, calls };
}

describe("the container scripts", () => {
  it("writes a file with printf in chunks a command can carry: exact bytes, the first creating its directories at 700 (the umask before the mkdir, so the run's root under /var/tmp is the caller's alone)", () => {
    const [one] = writeFileScripts(`${paths.agentDir}/SYSTEM.md`, "hello 'quoted'\nline two");
    expect(one).toBe(
      `umask 077 && mkdir -p '/var/tmp/switchboard-pi-run-7/agent' && printf '%s' 'hello '\\''quoted'\\''\nline two' > '/var/tmp/switchboard-pi-run-7/agent/SYSTEM.md'`,
    );
    const big = "x".repeat(WRITE_CHUNK_CHARS * 2 + 5);
    const scripts = writeFileScripts("/tmp/f", big);
    expect(scripts).toHaveLength(3);
    expect(scripts[0]).toContain(" > '/tmp/f'");
    expect(scripts[1]).toMatch(/^printf '%s' 'x+' >> '\/tmp\/f'$/);
    expect(scripts[2]).toBe(`printf '%s' '${"x".repeat(5)}' >> '/tmp/f'`);
    expect(writeFileScripts("/tmp/empty", "")).toHaveLength(1);
  });

  // The golden is the script the seam wrote before the program, the filter
  // and the layout became inputs, plus the one change since: the detached
  // wrapper's stdio goes to /dev/null, so the exec that forked it owns none of
  // its descriptors (execution.md item 24).
  it("pi's start is the script the seam wrote before the program, the filter and the layout were inputs, with the wrapper's stdio redirected away from the exec's pipes", () => {
    expect(startScript(piStart(["--mode", "rpc", "-e", paths.extension], { X: "1" }))).toBe(
      "(umask 077 && mkdir -p '/var/tmp/switchboard-pi-run-7' '/var/tmp/switchboard-pi-run-7/agent/sessions' '/var/tmp/switchboard-pi-run-7/cmd') && rm -f '/var/tmp/switchboard-pi-run-7/rpc.in' && mkfifo -m 600 '/var/tmp/switchboard-pi-run-7/rpc.in' && : > '/var/tmp/switchboard-pi-run-7/rpc.log' && : > '/var/tmp/switchboard-pi-run-7/rpc.err' && setsid -f sh -c 'exec 3<>'\\''/var/tmp/switchboard-pi-run-7/rpc.in'\\''; echo $$ > '\\''/var/tmp/switchboard-pi-run-7/pi.pid'\\''; pi '\\''--mode'\\'' '\\''rpc'\\'' '\\''-e'\\'' '\\''/var/tmp/switchboard-pi-run-7/extension.js'\\'' <&3 2>>'\\''/var/tmp/switchboard-pi-run-7/rpc.err'\\'' | grep --line-buffered -v '\\''\"type\":\"message_update\"'\\'' >> '\\''/var/tmp/switchboard-pi-run-7/rpc.log'\\''' </dev/null >/dev/null 2>&1 && sleep 0.3 && cat '/var/tmp/switchboard-pi-run-7/pi.pid'",
    );
  });

  it("starts the process detached behind a FIFO held open for writing, its pid recorded, its stdout through the filter into the log; the environment is not in the script", () => {
    const script = startScript(piStart(["--mode", "rpc", "-e", paths.extension], { X: "1" }));
    // The directories at 700 in a subshell: the run's root is the caller's alone, and the process's own umask is untouched.
    expect(
      script.startsWith(`(umask 077 && mkdir -p '${paths.dir}' '${paths.sessionDir}' '${paths.commandDir}') && `),
    ).toBe(true);
    expect(script).toContain(`mkfifo -m 600 '${paths.fifo}'`);
    expect(script).toContain("setsid -f sh -c ");
    // The wrapper's stdio to /dev/null: the exec's own stdout and stderr close
    // when the exec's shell exits, whatever the detached process holds.
    expect(script).toMatch(/setsid -f sh -c '(?:[^']|'\\'')*' <\/dev\/null >\/dev\/null 2>&1 && sleep 0\.3/);
    expect(script).toContain(DETACHED_STDIO);
    expect(script).toContain("exec 3<>");
    expect(script).toContain("echo $$ > ");
    expect(script).toContain("<&3 2>>");
    // The filter stage sits inside the wrapper's own quoting, so its quotes are the wrapper's.
    expect(script).toContain("grep --line-buffered -v");
    expect(script).toContain(`"type":"message_update"`);
    expect(logFilter(PI_STDOUT_FILTER)).toBe(`grep --line-buffered -v '"type":"message_update"'`);
    expect(script.endsWith(`cat '${paths.pidFile}'`)).toBe(true);
    // The environment is not in the script: the bearer rides the exec's env channel.
    expect(script).not.toContain("X=1");
    expect(script).not.toContain("SWITCHBOARD_RUN_BEARER");
  });

  it("another program with no filter carries no grep — its stdout lands in the log as it comes — and a program name a shell would read twice is refused", () => {
    const script = startScript({ paths, command: "opencode", args: ["serve", "--hostname", "127.0.0.1"], env: {} });
    expect(script).not.toContain("grep");
    expect(script).toContain(
      `opencode '\\''serve'\\'' '\\''--hostname'\\'' '\\''127.0.0.1'\\'' <&3 2>>'\\''${paths.errLog}'\\'' >> '\\''${paths.log}'\\'''`,
    );
    expect(() => startScript({ paths, command: "pi; rm -rf /", args: [], env: {} })).toThrow(HarnessContainerError);
    expect(() => startScript({ paths, command: "$(pi)", args: [], env: {} })).toThrow(/not a program name/);
  });

  it("keepLog: the wrapper creates the log when it is missing and appends instead of truncating it, so a restarted writer (the tailer, whose stdout is a feed read by offset) keeps what a recorded offset points into; pi never sets it and its script is unchanged", () => {
    const kept = startScript({
      paths,
      command: "node",
      args: ["/tmp/switchboard-oc-run-7/tailer.js"],
      env: {},
      keepLog: true,
    });
    expect(kept).toContain(`: >> ${shellQuote(paths.log)}`);
    expect(kept).not.toContain(`: > ${shellQuote(paths.log)}`);
    expect(kept).toContain(`: >> ${shellQuote(paths.errLog)}`);
    expect(kept).not.toContain(`: > ${shellQuote(paths.errLog)}`);
    const fresh = startScript({ paths, command: "node", args: [], env: {} });
    expect(fresh).toContain(`: > ${shellQuote(paths.log)}`);
    expect(fresh).not.toContain(": >>");
  });

  it("a start that names a port exports it first and says it on the first line — picked in the container with node for `free`, as given for a number — and the port's placeholder among the arguments becomes the variable; the placeholder with no port named is refused by name", () => {
    const free = startScript({
      paths,
      command: "opencode",
      args: ["serve", "--port", PORT_ARG],
      env: {},
      port: "free",
    });
    expect(free.startsWith(`export ${HARNESS_PORT_ENV}="$(node -e '`)).toBe(true);
    expect(free).toContain(`)" && echo "$${HARNESS_PORT_ENV}" && (umask 077`);
    expect(free).toContain(`'\\''--port'\\'' "$${HARNESS_PORT_ENV}" <&3`);
    const given = startScript({ paths, command: "opencode", args: ["--port", PORT_ARG], env: {}, port: 41000 });
    expect(given.startsWith(`export ${HARNESS_PORT_ENV}=41000 && echo "$${HARNESS_PORT_ENV}" && (umask 077`)).toBe(
      true,
    );
    // The placeholder with no port named is a harness bug: refused by name, never handed to the program as a word.
    expect(() => startScript({ paths, command: "opencode", args: [PORT_ARG], env: {} })).toThrow(
      /harness container: start failed — the arguments carry \{port\} but the start names no port/,
    );
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

  it("a request is curl into loopback with the status line and headers, its own bound under the executor's, no Expect dance, the body from stdin or from the file the command removes, never -f; a secret header's value rides the exec's environment, never the command text; a method, port, path or header name a shell or HTTP would misread is refused", () => {
    const req: HarnessRequest = {
      method: "POST",
      port: 41000,
      path: "/api/session/ses_1/prompt",
      headers: { "content-type": "application/json", "x-request-id": "r-1" },
      body: '{"text":"hello \'there\'"}',
    };
    expect(requestScript(req)).toBe(
      `printf '%s' '{"text":"hello '\\''there'\\''"}' | curl -sS -i --max-time ${CURL_MAX_TIME_S} -X POST -H 'Expect:' -H 'content-type: application/json' -H 'x-request-id: r-1' --data-binary @- 'http://127.0.0.1:41000/api/session/ses_1/prompt'`,
    );
    expect(CURL_MAX_TIME_S * 1000).toBeLessThan(OP_TIMEOUT_MS);
    expect(requestScript({ method: "GET", port: 41000, path: "/api/health" })).toBe(
      `curl -sS -i --max-time ${CURL_MAX_TIME_S} -X GET -H 'Expect:' 'http://127.0.0.1:41000/api/health'`,
    );
    expect(requestScript({ ...req, body: "x" }, `${paths.commandDir}/3.body`)).toBe(
      `curl -sS -i --max-time ${CURL_MAX_TIME_S} -X POST -H 'Expect:' -H 'content-type: application/json' -H 'x-request-id: r-1' --data-binary '@${paths.commandDir}/3.body' 'http://127.0.0.1:41000/api/session/ses_1/prompt'; s=$?; rm -f '${paths.commandDir}/3.body'; exit $s`,
    );
    // A secret header — a server's per-run password — is named in the text and valued in the environment, as the bearer is on a start.
    const secret: HarnessRequest = {
      ...req,
      body: undefined,
      secretHeaders: { authorization: "Basic c2I6c2VjcmV0", "x-api-key": "key-secret-2" },
    };
    expect(requestScript(secret)).toBe(
      `curl -sS -i --max-time ${CURL_MAX_TIME_S} -X POST -H 'Expect:' -H 'content-type: application/json' -H 'x-request-id: r-1' -H "authorization: $SWITCHBOARD_REQUEST_H1" -H "x-api-key: $SWITCHBOARD_REQUEST_H2" 'http://127.0.0.1:41000/api/session/ses_1/prompt'`,
    );
    expect(requestScript(secret)).not.toContain("c2I6c2VjcmV0");
    expect(requestScript(secret)).not.toContain("key-secret-2");
    expect(requestEnv(secret)).toEqual({
      SWITCHBOARD_REQUEST_H1: "Basic c2I6c2VjcmV0",
      SWITCHBOARD_REQUEST_H2: "key-secret-2",
    });
    expect(requestEnv(req)).toEqual({});
    // A header value's line break would end the header: it is folded to a space.
    expect(requestScript({ method: "GET", port: 1, path: "/", headers: { "x-a": "one\r\ntwo" } })).toContain(
      "'x-a: one  two'",
    );
    expect(() => requestScript({ method: "get", port: 41000, path: "/" })).toThrow(/not a method/);
    expect(() => requestScript({ method: "GET", port: 0, path: "/" })).toThrow(/not a port/);
    expect(() => requestScript({ method: "GET", port: 70000, path: "/" })).toThrow(/not a port/);
    expect(() => requestScript({ method: "GET", port: 41000, path: "api" })).toThrow(/not a path/);
    expect(() => requestScript({ method: "GET", port: 41000, path: "/a b" })).toThrow(/not a path/);
    expect(() => requestScript({ method: "GET", port: 41000, path: "/", headers: { "x a": "1" } })).toThrow(
      /not a header name/,
    );
    expect(() => requestScript({ method: "GET", port: 41000, path: "/", secretHeaders: { 'x"a': "1" } })).toThrow(
      /not a header name/,
    );
  });

  it("parses curl's answer: the status, the headers lowercased, the body after the blank line, an interim 1xx block skipped, and no HTTP answer at all a named failure", () => {
    expect(
      parseHttpResponse(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Request-Id: r1\r\n\r\n" + '{"healthy":true}',
      ),
    ).toEqual({
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "r1" },
      body: '{"healthy":true}',
    });
    expect(
      parseHttpResponse("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\n\r\nbusy"),
    ).toEqual({
      status: 503,
      headers: { "retry-after": "2" },
      body: "busy",
    });
    expect(parseHttpResponse("HTTP/2 204 \nserver: x\n\n")).toEqual({
      status: 204,
      headers: { server: "x" },
      body: "",
    });
    expect(() => parseHttpResponse("")).toThrow(/no HTTP answer came back \(empty\)/);
    expect(() => parseHttpResponse("curl: (7) Failed to connect")).toThrow(HarnessContainerError);
  });
});

describe("stdoutOf — an executor's answer as the operation's stdout", () => {
  it("keeps stdout, drops the appended stderr, reads the empty marker as empty, and names a failed command", () => {
    expect(stdoutOf("read", "abc\n--- stderr ---\nnoise")).toBe("abc");
    expect(stdoutOf("read", "(no output)")).toBe("");
    expect(() => stdoutOf("start", "exit 127:\nsh: pi: not found")).toThrow(HarnessContainerError);
    expect(() => stdoutOf("start", "exit 127:\nsh: pi: not found")).toThrow(/start failed — exit 127/);
  });

  // harness-pi item 16: an executor that hands the word for a replaced runtime
  // back as a command's text — `runtime-replaced: …`, `runtime-unreachable: …`
  // — is not reporting what the command printed, so `alive` must not read it
  // as "dead" nor `read` decode it as log bytes: the operation fails with the
  // typed word. The word counts wherever it sits in the answer: behind the
  // executors' `exit N:` prefix, behind a sentence of the executor's own. The
  // seam's own commands print a pid, a port, a boot id, `alive`/`dead`, base64,
  // an HTTP answer or nothing, never the word, so an answer carrying it is the
  // executor's.
  it("the executors' runtime word anywhere in a command's answer is the typed HarnessContainerRuntimeReplacedError naming the operation, never the command's stdout; isContainerGone knows it and the executor's own typed error", () => {
    const replaced =
      "runtime-replaced: the resident runtime was replaced (a deploy) while this command ran\n" +
      "The command may have started; re-check its effects (e.g. git status, the files it writes) before re-running it.";
    expect(() => stdoutOf("alive", replaced)).toThrow(HarnessContainerRuntimeReplacedError);
    expect(() => stdoutOf("alive", replaced)).toThrow(
      /^harness container: alive failed — runtime-replaced: the resident runtime was replaced/,
    );
    expect(() =>
      stdoutOf("read", "runtime-unreachable: the sandbox container's runtime did not answer (container abc)"),
    ).toThrow(HarnessContainerRuntimeReplacedError);
    expect(() => stdoutOf("alive", "exit 127:\nruntime-replaced: the resident runtime was replaced")).toThrow(
      HarnessContainerRuntimeReplacedError,
    );
    expect(() => stdoutOf("read", "resident /exec: the run met runtime-replaced: deploy")).toThrow(
      HarnessContainerRuntimeReplacedError,
    );
    // The typed word is a container failure too, so every reader of the seam's failures still sees one.
    expect(new HarnessContainerRuntimeReplacedError("read", replaced)).toBeInstanceOf(HarnessContainerError);
    // A failure without the word is the plain failure it was.
    expect(() => stdoutOf("read", "exit 1:\ntail: cannot open '/tmp/x' for reading")).not.toThrow(
      HarnessContainerRuntimeReplacedError,
    );
    expect(() => stdoutOf("read", "exit 1:\ntail: cannot open '/tmp/x' for reading")).toThrow(HarnessContainerError);
    expect(isContainerGone(new ExecSandboxRestartedError("the sandbox restarted (waited 42 s)", 42_000))).toBe(true);
    expect(isContainerGone(new HarnessContainerRuntimeReplacedError("read", replaced))).toBe(true);
    expect(isContainerGone(new HarnessContainerError("read", "exit 1"))).toBe(false);
    expect(isContainerGone(new Error("runtime-replaced in a plain error"))).toBe(false);
  });
});

// Feature: docs/reference/specs/harness.md item 6 — one more command before the
// crash judgement: what a process found dead without the executor's word is
// judged by, on the seam, before either harness reads a crash.
describe("replacedVerdict — one more container command before a dead process is judged to have died where it ran", () => {
  const answering = (identity: () => Promise<string | undefined>) => ({ identity });

  it("the command failing with the executor's typed word — the resident's ExecSandboxRestartedError, the seam's HarnessContainerRuntimeReplacedError — is the verdict by the word, whatever was recorded", async () => {
    const seam = new HarnessContainerRuntimeReplacedError("identity", "runtime-replaced: the runtime was replaced");
    await expect(
      replacedVerdict(
        answering(async () => {
          throw seam;
        }),
        "vm-a",
      ),
    ).resolves.toEqual({ condition: "word", said: seam });
    const resident = new ExecSandboxRestartedError("the sandbox restarted under the run (waited 42 s)", 42_000);
    await expect(
      replacedVerdict(
        answering(async () => {
          throw resident;
        }),
        undefined,
      ),
    ).resolves.toEqual({ condition: "word", said: resident });
  });

  it("the command answering another word than the one recorded when the process started is the verdict by the changed identity, both words on it", async () => {
    await expect(
      replacedVerdict(
        answering(async () => "vm-b"),
        "vm-a",
      ),
    ).resolves.toEqual({
      condition: "identity",
      was: "vm-a",
      now: "vm-b",
    });
  });

  it("no verdict — the crash judgement stands — for the same word, no word recorded, no word answered, or a command that failed for any reason but the executor's word", async () => {
    await expect(
      replacedVerdict(
        answering(async () => "vm-a"),
        "vm-a",
      ),
    ).resolves.toBeUndefined();
    await expect(
      replacedVerdict(
        answering(async () => "vm-b"),
        undefined,
      ),
    ).resolves.toBeUndefined();
    await expect(
      replacedVerdict(
        answering(async () => undefined),
        "vm-a",
      ),
    ).resolves.toBeUndefined();
    await expect(
      replacedVerdict(
        answering(async () => {
          throw new HarnessContainerError("identity", "exit 127: cat: not found");
        }),
        "vm-a",
      ),
    ).resolves.toBeUndefined();
  });

  it("replacedBecause derives the why from the condition's tag: the executor's words, whitespace folded and capped, for `word`; the changed identity's sentence for `identity`, whatever was said", () => {
    expect(replacedBecause("word", "runtime-replaced:  the runtime\nwas replaced")).toBe(
      "the executor said: runtime-replaced: the runtime was replaced",
    );
    expect(replacedBecause("identity", undefined)).toBe(identityChangedCondition());
    expect(replacedBecause("identity", "ignored")).toBe(identityChangedCondition());
    expect(identityChangedCondition()).toMatch(/^the changed identity was the condition: /);
    // `transport`: the standing transport failure on a resident-backed run —
    // the words are the failing command's, and the sentence says the run
    // resumes through a re-attach instead of ending.
    expect(replacedBecause("transport", "resident /exec:  Peer closed\nWebSocket: 1006")).toBe(
      "a container command failed on its transport (resident /exec: Peer closed WebSocket: 1006) and the one more command named no replacement; the run is registered on its resident, so it resumes through a re-attach instead of ending",
    );
  });
});

describe("replacedVerdict — the one more command waits through a container that is down (the restore window), bounded like the start gate", () => {
  /** An `identity` that answers `down` times with the platform's not-running text before it answers `then`. */
  function downThen(down: number, then: () => Promise<string | undefined>) {
    let asked = 0;
    const identity = async () => {
      asked++;
      if (asked <= down)
        throw new HarnessContainerDownError(
          "identity",
          "resident /exec: The container is not running, consider calling start()",
        );
      return then();
    };
    return { container: { identity }, asked: () => asked };
  }
  /** A probe whose sleeps are recorded and instant, on a clock the sleeps advance. */
  function probe(opts: { signal?: AbortSignal; deadline?: number } = {}) {
    const slept: number[] = [];
    const noted: string[] = [];
    const clock = { now: 1_700_000_000_000 };
    return {
      slept,
      noted,
      clock,
      wait: {
        sleep: async (ms: number) => {
          slept.push(ms);
          clock.now += ms;
        },
        now: () => clock.now,
        note: (text: string) => void noted.push(text),
        ...opts,
      },
    };
  }

  it("the backoff is the executor's own start backoff (execution.md item 23), the bound the seam's own five minutes — shorter than a fresh run's start budget, since a run's work is in flight", () => {
    expect(PROBE_WAIT_MAX_MS).toBe(5 * 60_000);
    expect(PROBE_WAIT_MAX_MS).toBeLessThan(SANDBOX_START_WAIT_MAX_MS);
    expect(PROBE_WAIT_BACKOFF_MS).toBe(SANDBOX_START_BACKOFF_MS);
    expect(PROBE_WAIT_BACKOFF_MS).toEqual([5_000, 10_000, 15_000]);
  });

  it("one restore, one wait, whatever route the resident answered it by: the hydrate path's `restore in progress` 503 and the wake path's strike after the client's own 60 s budget ran out on a still-restoring resident are both the down answer from identity — typed by the one decision on the resident's state — so the one more command re-sends both through the same pauses and both decide by the changed identity once the container answers; never a give-up at 60 s on one route and five minutes on the other", async () => {
    const restoring = { error: "not-serviceable: restore in progress", state: "restoring", reason: "rehydrating" };
    const byHydratePath = () =>
      new ExecInfraError(`resident /exec: ${restoring.error}`, residentAnswerReason(503, restoring));
    // The strike as the client's wake path throws it, its reason drawn from the
    // last engine view by the client's own decision — so a reverted decision
    // fails this test.
    const byWakePath = () =>
      residentWakeBudgetStrike("/exec", "not-serviceable: The container just exited", 60_000, {
        kind: "status",
        state: "restoring",
        reason: "rehydrating",
      });
    for (const down of [byHydratePath, byWakePath]) {
      const { executor, calls } = recordingExecutor([down(), down(), "vm-b\n"]);
      const p = probe();
      await expect(replacedVerdict(new ExecHarnessContainer(executor), "vm-a", p.wait)).resolves.toMatchObject({
        condition: "identity",
        was: "vm-a",
        now: "vm-b",
      });
      expect(calls).toHaveLength(3);
      expect(p.slept).toEqual([5_000, 10_000]);
      expect(p.noted[1]).toBe("the container answered after 15s of waiting");
    }
  });

  it("a container down under the one more command is a wait, never the judgement: the probe is re-sent after the backoff until the container answers — the word, a changed identity or the same word decide as they always did — and the notes say the wait began and how long it took", async () => {
    // Down twice, then the executor's word.
    const seam = new HarnessContainerRuntimeReplacedError("identity", "runtime-replaced: the runtime was replaced");
    const word = downThen(2, async () => {
      throw seam;
    });
    const p1 = probe();
    await expect(replacedVerdict(word.container, "vm-a", p1.wait)).resolves.toEqual({ condition: "word", said: seam });
    expect(word.asked()).toBe(3);
    expect(p1.slept).toEqual([5_000, 10_000]);
    expect(p1.noted).toHaveLength(2);
    expect(p1.noted[0]).toMatch(
      /^the one more command finds the container down \(.*The container is not running.*\); waiting for it to answer, up to 300s$/,
    );
    expect(p1.noted[1]).toBe("the container answered after 15s of waiting");

    // Down three times, then another identity.
    const renamed = downThen(3, async () => "vm-b");
    const p2 = probe();
    await expect(replacedVerdict(renamed.container, "vm-a", p2.wait)).resolves.toEqual({
      condition: "identity",
      was: "vm-a",
      now: "vm-b",
    });
    expect(p2.slept).toEqual([5_000, 10_000, 15_000]);
    expect(p2.noted[1]).toBe("the container answered after 30s of waiting");

    // Down twice, then the same word: no verdict, the failure stands.
    const same = downThen(2, async () => "vm-a");
    const p3 = probe();
    await expect(replacedVerdict(same.container, "vm-a", p3.wait)).resolves.toBeUndefined();
    expect(same.asked()).toBe(3);
    expect(p3.slept).toEqual([5_000, 10_000]);
  });

  it("a wait that runs out decides: once the next pause would pass the bound the probe stops, the note says the container did not answer, and there is no verdict", async () => {
    const never = downThen(Number.POSITIVE_INFINITY, async () => "unreachable");
    const p = probe();
    await expect(replacedVerdict(never.container, "vm-a", p.wait)).resolves.toBeUndefined();
    const total = p.slept.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(PROBE_WAIT_MAX_MS);
    expect(total + 15_000).toBeGreaterThan(PROBE_WAIT_MAX_MS);
    expect(p.slept.slice(0, 3)).toEqual([5_000, 10_000, 15_000]);
    expect(new Set(p.slept.slice(3))).toEqual(new Set([15_000]));
    expect(never.asked()).toBe(p.slept.length + 1);
    expect(p.noted.at(-1)).toBe(`the container did not answer within 300s; the wait ran out (after ${total / 1000}s)`);
  });

  it("the bound is wall-clock time from the wait's start, not the sum of the pauses: a probe that itself takes a minute is counted, so a hanging container runs the wait out after five minutes of clock, not twenty-one attempts", async () => {
    const p = probe();
    let asked = 0;
    const hanging = {
      identity: async () => {
        asked++;
        p.clock.now += 60_000; // each command hangs to the executor's own timeout
        throw new HarnessContainerDownError("identity", "resident /exec gave no answer within 60s");
      },
    };
    await expect(replacedVerdict(hanging, "vm-a", p.wait)).resolves.toBeUndefined();
    // 60 s command + 5 s, 60 + 10, 60 + 15, 60 + 15 … : the clock reaches the bound after a handful, never 21.
    expect(asked).toBeLessThanOrEqual(6);
    expect(asked).toBeGreaterThanOrEqual(4);
    expect(p.noted.at(-1)).toMatch(/^the container did not answer within 300s; the wait ran out \(after \d+s\)$/);
  });

  it("the wait observes the run: a hard stop's signal ends it at once — mid-pause, without waiting the pause out — and the run's deadline ends it before the next re-send; both say why, and neither is a verdict", async () => {
    const control = new AbortController();
    const p = probe({ signal: control.signal });
    let asked = 0;
    const down = {
      identity: async () => {
        asked++;
        if (asked === 2) control.abort();
        throw new HarnessContainerDownError(
          "identity",
          "resident /exec: The container is not running, consider calling start()",
        );
      },
    };
    await expect(replacedVerdict(down, "vm-a", p.wait)).resolves.toBeUndefined();
    expect(asked).toBe(2);
    expect(p.slept).toEqual([5_000]);
    expect(p.noted.at(-1)).toBe("the wait ended after 5s: a hard stop was requested");

    // The deadline: the wait began with 12 s of lease left; after the first pause only 7 s remain, the second pause would pass it.
    const d = probe();
    const deadline = d.clock.now + 12_000;
    const still = downThen(Number.POSITIVE_INFINITY, async () => "unreachable");
    await expect(replacedVerdict(still.container, "vm-a", { ...d.wait, deadline })).resolves.toBeUndefined();
    expect(d.slept).toEqual([5_000]);
    expect(d.noted.at(-1)).toBe("the wait ended after 5s: the run's deadline passed");

    // A signal already aborted when the container first answers down ends the wait with no pause at all.
    const gone = new AbortController();
    gone.abort();
    const g = probe({ signal: gone.signal });
    const once = downThen(Number.POSITIVE_INFINITY, async () => "unreachable");
    await expect(replacedVerdict(once.container, "vm-a", g.wait)).resolves.toBeUndefined();
    expect(g.slept).toEqual([]);
    expect(once.asked()).toBe(1);
  });

  it("a sleep that rejects ends the wait with that failure — never a wait that hangs or an unhandled rejection — and the stop listener is removed", async () => {
    const control = new AbortController();
    const boom = new Error("the sleep was torn down");
    const p = probe({ signal: control.signal });
    const down = downThen(Number.POSITIVE_INFINITY, async () => "unreachable");
    await expect(
      replacedVerdict(down.container, "vm-a", {
        ...p.wait,
        sleep: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    expect(down.asked()).toBe(1);
    // The abort listener the pause armed is gone with the failure: a later stop reaches nothing.
    control.abort();
  });

  it("without a probe to wait with, a container down under the command judges nothing, as any other failed command", async () => {
    const down = downThen(1, async () => "vm-b");
    await expect(replacedVerdict(down.container, "vm-a")).resolves.toBeUndefined();
    expect(down.asked()).toBe(1);
  });

  /** An `identity` that answers with a control reset `reset` times (the
   *  container unchanged) before it answers `then`. */
  function resetThen(reset: number, then: () => Promise<string | undefined>) {
    let asked = 0;
    const identity = async () => {
      asked++;
      if (asked <= reset)
        throw new HarnessContainerControlResetError(
          "identity",
          "control-reset: the resident's Durable Object was reset (a deploy); the container and its processes are as they were; the command's outcome is unknown",
        );
      return then();
    };
    return { container: { identity }, asked: () => asked };
  }

  it("a control reset over the one more command is a re-send, never a judgement: the probe is re-sent after the backoff until the container answers, and the note names the reset (a same-kernel reset keeps the container)", async () => {
    const seam = new HarnessContainerRuntimeReplacedError("identity", "runtime-replaced: the runtime was replaced");
    // Reset twice (the container unchanged), then the executor's word.
    const reset = resetThen(2, async () => {
      throw seam;
    });
    const p = probe();
    await expect(replacedVerdict(reset.container, "vm-a", p.wait)).resolves.toEqual({ condition: "word", said: seam });
    expect(reset.asked()).toBe(3);
    expect(p.slept).toEqual([5_000, 10_000]);
    expect(p.noted[0]).toMatch(
      /^the one more command met the resident's control plane reset \(the container is unchanged\); re-sending it, up to 300s$/,
    );
    expect(p.noted.at(-1)).toBe("the container answered after 15s of waiting");
  });

  it("a control plane that keeps resetting past the wait runs out and decides nothing, never a judgement from the reset", async () => {
    const reset = resetThen(Number.POSITIVE_INFINITY, async () => "unreachable");
    const p = probe();
    await expect(replacedVerdict(reset.container, "vm-a", p.wait)).resolves.toBeUndefined();
    // The start note named the reset; the wait runs out on the executor's own
    // five-minute bound, shared with the down-wait (never a verdict from a reset).
    expect(p.noted[0]).toMatch(/met the resident's control plane reset .*re-sending it, up to 300s/);
    expect(p.noted.at(-1)).toMatch(/the container did not answer within 300s; the wait ran out/);
  });

  it("without a probe, a control reset over the one more command judges nothing, as any other failure (no infinite re-send)", async () => {
    const reset = resetThen(1, async () => "vm-b");
    await expect(replacedVerdict(reset.container, "vm-a")).resolves.toBeUndefined();
    expect(reset.asked()).toBe(1);
  });
});

describe("saysTransportLost — the third failure shape: a container command failed on its transport with no word", () => {
  it("the executor's typed word decides first: an infra failure whose reason a wait can clear — the transport lost, the deadline passed, the empty failure shape, the Worker unavailable — is the shape whatever its words, on the error or anywhere in its cause chain; the live shape, `Network connection lost.` typed transport-lost, among them", () => {
    expect(saysTransportLost(new ExecInfraError("resident /exec: Network connection lost.", "transport-lost"))).toBe(
      true,
    );
    expect(saysTransportLost(new ExecInfraError("resident /exec: fetch failed", "transport-lost"))).toBe(true);
    expect(saysTransportLost(new ExecInfraError("resident /exec HTTP 502", "worker-unavailable"))).toBe(true);
    expect(saysTransportLost(new ExecInfraError(sandboxNoAnswerMessage("/exec", 60_000), "deadline-passed"))).toBe(
      true,
    );
    expect(saysTransportLost(new ExecInfraError(sandboxEmptyFailureMessage("/exec"), "empty-failure"))).toBe(true);
    // Wrapped on the way up: the typed word sits in the cause chain, and decides.
    const wrapped = new Error("the read failed", {
      cause: new ExecInfraError("resident /exec: fetch failed", "transport-lost"),
    });
    expect(saysTransportLost(wrapped)).toBe(true);
    expect(infraErrorOf(wrapped)?.reason).toBe("transport-lost");
    expect(infraErrorOf(new Error("plain"))).toBeUndefined();
    expect([...selfAndCauses(wrapped)]).toHaveLength(2);
  });

  it("a failure whose words name the container's transport or the container down — the resident client's 1006 infra failure typed answered, the SDK's `Network connection lost`, not running, starting, just exited, its supervisor closed, the WebSocket closed without a frame, the connection reset — and the seam's typed down answer: the words decide for an answered or untyped failure", () => {
    expect(
      saysTransportLost(
        new ExecInfraError(
          "resident /exec: Peer closed WebSocket: 1006 WebSocket disconnected without sending Close frame.",
          "answered",
        ),
      ),
    ).toBe(true);
    expect(saysTransportLost(new ExecInfraError("resident /exec: Network connection lost.", "answered"))).toBe(true);
    expect(saysTransportLost(new Error("resident /exec: Network connection lost."))).toBe(true);
    expect(saysTransportLost(new HarnessContainerError("read", "resident /exec: Network connection lost"))).toBe(true);
    expect(saysTransportLost(new Error("resident /exec: The container is not running, consider calling start()"))).toBe(
      true,
    );
    expect(saysTransportLost(new Error("Container is starting. Please retry in a moment."))).toBe(true);
    expect(saysTransportLost(new Error("not-serviceable: The container just exited"))).toBe(true);
    expect(saysTransportLost(new Error("Process supervisor is closed"))).toBe(true);
    expect(saysTransportLost(new Error("read ECONNRESET"))).toBe(true);
    expect(saysTransportLost(new Error("socket hang up"))).toBe(true);
    expect(saysTransportLost(new HarnessContainerDownError("identity", "The container is not running"))).toBe(true);
    for (const text of [
      "The container is not running, consider calling start()",
      "Container is starting",
      "the container just exited",
      "Process supervisor is closed",
      "Peer closed WebSocket: 1006 WebSocket disconnected without sending Close frame.",
      "read ECONNRESET",
      "connection reset by peer",
      "socket hang up",
      "Network connection lost.",
      "Network connection lost",
      "resident /exec: Network connection lost.",
    ])
      expect(CONTAINER_DOWN_WORDING.test(text), text).toBe(true);
    // One source for each platform wording: the resident client's gone-for-a-moment
    // list and the resident's stopped-container list are composed, never re-typed.
    expect(CONTAINER_DOWN_WORDING.source).toContain(CONTAINER_GONE_WORDING.source);
    expect(CONTAINER_DOWN_WORDING.source).toContain(STOPPED_CONTAINER_WORDING.source);
    expect(CONTAINER_GONE_WORDING.test("The container just exited")).toBe(true);
    expect(CONTAINER_GONE_WORDING.test("Container is starting. Please retry in a moment.")).toBe(true);
  });

  it("never the word (the typed gone errors, the word in a text), never a control file lost, never a command that failed as a command, never a typed refusal or the run's own stop whatever their words (an attach refused, a streak, a strike whose words are the container's, the abort) nor an answered failure whose words are not the container's — never a bare string", () => {
    expect(
      saysTransportLost(new ExecInfraError("resident /exec: Network connection lost.", "refused")),
      "a refusal is no wait, whatever it says",
    ).toBe(false);
    expect(saysTransportLost(new ExecInfraError("resident /exec: The container just exited", "aborted"))).toBe(false);
    expect(saysTransportLost(new ExecInfraError("resident /exec: worktree evicted", "answered"))).toBe(false);
    expect(
      saysTransportLost(
        new ExecInfraError("resident /exec: worktree still unavailable after a re-attach (evicted)", "refused"),
      ),
    ).toBe(false);
    expect(
      saysTransportLost(
        new ExecInfraError(
          "resident /exec: runtime replaced 2 times in a row with no successful operation between",
          "refused",
        ),
      ),
    ).toBe(false);
    expect(saysTransportLost(new ExecSandboxRestartedError("the sandbox restarted under the run", 1))).toBe(false);
    expect(saysTransportLost(new HarnessContainerRuntimeReplacedError("read", "runtime-replaced: swapped"))).toBe(
      false,
    );
    expect(
      saysTransportLost(
        new ExecInfraError("runtime-unreachable: the sandbox container's runtime did not answer", "answered"),
      ),
    ).toBe(false);
    expect(
      saysTransportLost(new Error("runtime-replaced: the resident runtime was replaced (Peer closed WebSocket)")),
    ).toBe(false);
    expect(saysTransportLost(new HarnessControlFileLostError("send", "/var/tmp/x/fifo", "/var/tmp/x"))).toBe(false);
    expect(saysTransportLost(new HarnessContainerError("read", "exit 1:\ntail: cannot open"))).toBe(false);
    expect(saysTransportLost(new Error("the model call failed"))).toBe(false);
    expect(saysTransportLost("Peer closed WebSocket: 1006")).toBe(false);
    expect(new HarnessContainerDownError("identity", "x")).toBeInstanceOf(HarnessContainerError);
    expect(isContainerGone(new HarnessContainerDownError("identity", "x"))).toBe(false);
  });
});

describe("ExecHarnessContainer — each operation is one command over the executor", () => {
  it("start runs the wrapper with the env on the exec and parses the pid from the last line", async () => {
    const { executor, calls } = recordingExecutor(["4242\n"]);
    const c = new ExecHarnessContainer(executor);
    const env = { SWITCHBOARD_RUN_BEARER: "sbr_run-7.secret", PI_CODING_AGENT_DIR: paths.agentDir };
    await expect(c.start(piStart(["--mode", "rpc"], env))).resolves.toEqual({ pid: 4242 });
    expect(calls[0].opts?.env).toEqual(env);
    expect(calls[0].command).not.toContain("secret");
    expect(calls[0].opts?.timeoutMs).toBe(60_000);
  });

  it("a start that names a port reads it from the first line and the pid from the last; a port that did not come back is a named failure", async () => {
    const { executor } = recordingExecutor(["41523\n4242\n", "4242\n", "nope\n4242\n"]);
    const c = new ExecHarnessContainer(executor);
    const start = { paths, command: "opencode", args: ["serve", "--port", PORT_ARG], env: {}, port: "free" as const };
    await expect(c.start(start)).resolves.toEqual({ pid: 4242, port: 41523 });
    await expect(c.start(start)).rejects.toThrow(/no port came back/);
    await expect(c.start(start)).rejects.toThrow(/no port came back/);
  });

  it("start without a pid is a named failure", async () => {
    const { executor } = recordingExecutor(["(no output)"]);
    await expect(new ExecHarnessContainer(executor).start(piStart([]))).rejects.toThrow(/no pid came back/);
  });

  it("writeLine feeds a short line inline and a long one through a numbered file", async () => {
    const { executor, calls } = recordingExecutor();
    const c = new ExecHarnessContainer(executor);
    await c.writeLine(paths, '{"type":"get_state"}');
    expect(calls[0].command).toBe(writeLineScript(paths.fifo, '{"type":"get_state"}'));
    const long = JSON.stringify({ type: "prompt", message: "m".repeat(INLINE_LINE_CHARS + 1) });
    await c.writeLine(paths, long);
    expect(calls[1].command).toContain(`> '${paths.commandDir}/1.json'`);
    expect(calls[calls.length - 1].command).toBe(feedFileScript(paths.fifo, `${paths.commandDir}/1.json`));
  });

  it("a send that fails because the FIFO is gone is the control-file-lost failure by name, with the file and the root; any other send failure stays what it was", async () => {
    const { executor } = recordingExecutor([`exit 1: bash: line 4: ${paths.fifo}: No such file or directory`]);
    const c = new ExecHarnessContainer(executor);
    const err = await c.writeLine(paths, '{"type":"abort"}').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessControlFileLostError);
    expect((err as HarnessControlFileLostError).file).toBe(paths.fifo);
    expect((err as HarnessControlFileLostError).root).toBe(paths.dir);
    expect((err as Error).message).toContain(`${paths.fifo} under ${paths.dir} vanished while the run was live`);
    // Never the replaced-container verdict: the container answered the command.
    expect(isContainerGone(err)).toBe(false);
    const other = recordingExecutor(["exit 1: bash: something else went wrong"]);
    await expect(new ExecHarnessContainer(other.executor).writeLine(paths, "x")).rejects.toThrow(
      /^harness container: send failed — exit 1: bash: something else/,
    );
  });

  it("a long line whose command-file write fails because the file's directory is gone names the command file, not the FIFO; the feed into a gone FIFO after a good write names the FIFO", async () => {
    const long = JSON.stringify({ type: "prompt", message: "m".repeat(INLINE_LINE_CHARS + 1) });
    const file = `${paths.commandDir}/1.json`;
    const write = recordingExecutor([`exit 1: bash: line 1: ${file}: No such file or directory`]);
    const lostOnWrite = await new ExecHarnessContainer(write.executor).writeLine(paths, long).catch((e: unknown) => e);
    expect(lostOnWrite).toBeInstanceOf(HarnessControlFileLostError);
    expect((lostOnWrite as HarnessControlFileLostError).file).toBe(file);
    expect((lostOnWrite as HarnessControlFileLostError).root).toBe(paths.dir);
    expect((lostOnWrite as Error).message).toMatch(/^harness container: write failed — /);
    expect(write.calls).toHaveLength(1);

    const feed = recordingExecutor([
      "(no output)",
      "(no output)",
      `exit 1: bash: line 4: ${paths.fifo}: No such file or directory`,
    ]);
    const lostOnFeed = await new ExecHarnessContainer(feed.executor).writeLine(paths, long).catch((e: unknown) => e);
    expect(lostOnFeed).toBeInstanceOf(HarnessControlFileLostError);
    expect((lostOnFeed as HarnessControlFileLostError).file).toBe(paths.fifo);
    expect(feed.calls[feed.calls.length - 1].command).toBe(feedFileScript(paths.fifo, file));
  });

  it("readLog decodes the base64 answer to exact bytes, and an empty answer to none", async () => {
    const { executor } = recordingExecutor([
      Buffer.from('{"type":"agent_start"}\n').toString("base64") + "\n",
      "(no output)",
    ]);
    const c = new ExecHarnessContainer(executor);
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
    const c = new ExecHarnessContainer(executor);
    expect(await c.identity()).toBe("3f1c2a6e-9b0d-4d2e-8a1f-0c9e7b6a5d43");
    expect(calls[0].command).toBe(identityScript());
    expect(await c.identity()).toBeUndefined();
    expect(await c.identity()).toBeUndefined();
    expect(await c.identity()).toBeUndefined();
  });

  // A refusal no wait clears is no name and never the container's verdict:
  // the executor's attach not opened because the run's lease is inside its
  // write-up reserve (execution.md item 9) answers `undefined` — neither a
  // container down to wait on nor a replaced one — so the one more command
  // judges nothing on it and the run ends as its budget ends it.
  it("identity answers no name on the executor's lease-spent refusal — a `refused` no wait clears, never HarnessContainerDownError, never a replaced verdict", async () => {
    const spent = new ResidentLeaseSpentError(
      "/exec",
      "the run has 30s of wall clock left, inside the 60s write-up reserve, so no attach was opened",
      30_000,
    );
    const { executor } = recordingExecutor([spent]);
    const c = new ExecHarnessContainer(executor);
    expect(await c.identity()).toBeUndefined();
  });

  // The record's survival clause: the container gone under the question is a
  // fact the loop keys on, never a container with no name.
  it("identity rethrows the executor's typed word that the container is gone — the resident's ExecSandboxRestartedError, the seam's own for the word as text — instead of answering none", async () => {
    const restarted = new ExecSandboxRestartedError("the sandbox restarted under the run (waited 42 s)", 42_000);
    const { executor } = recordingExecutor([restarted, "runtime-replaced: the resident runtime was replaced"]);
    const c = new ExecHarnessContainer(executor);
    await expect(c.identity()).rejects.toBe(restarted);
    await expect(c.identity()).rejects.toBeInstanceOf(HarnessContainerRuntimeReplacedError);
  });

  it("identity throws the container down under the question — the platform's not-running or starting text the resident answers with, and the executors' typed infra reasons a wait can clear (the transport lost, the deadline passed, the empty failure shape, the Worker unavailable — the resident's 5xx in the restore window among them), each built by the executor's own helper — as the typed HarnessContainerDownError, for the one more command to wait on; the type decides first: a typed refusal no wait clears is no name even when its words are the container's (the resident client's strike on a definite engine view), as are the run's own stop, a Worker answer whose words are not the container's, a command the container itself failed, or an empty answer; the strike after the client's budget ran out on a resident still restoring waits like the restore's own 503", async () => {
    const deadline = new DOMException("the 90s call deadline passed", "TimeoutError");
    const network = new TypeError("fetch failed");
    const stopped = new AbortController();
    stopped.abort();
    /** A resident answer as the client types it: the status first, then the body. */
    const answer = (status: number, data: Record<string, unknown>) =>
      new ExecInfraError(`resident /exec: ${String(data.error)}`, residentAnswerReason(status, data));
    const { executor } = recordingExecutor([
      // The resident forwards the SDK's words in its answer (a 409 with no word for a replacement it did not know): judged by the words.
      answer(409, { error: "The container is not running, consider calling start()" }),
      answer(409, { error: "Peer closed WebSocket: 1006 WebSocket disconnected without sending Close frame." }),
      // The executors' own failures, as they build them (src/execution/executor.ts, resident.ts, cloudflareSandbox.ts).
      new ExecInfraError(requestFailedMessage("resident", "/exec", deadline), infraReasonOfRequestFailure(deadline)),
      new ExecInfraError(requestFailedMessage("resident", "/exec", network), infraReasonOfRequestFailure(network)),
      new ExecInfraError(sandboxNoAnswerMessage("/exec", 60_000), "deadline-passed"),
      new ExecInfraError(requestFailedMessage("sandbox", "/exec", network), infraReasonOfRequestFailure(network)),
      new ExecInfraError(sandboxEmptyFailureMessage("/exec"), "empty-failure"),
      // The resident unavailable for a moment — the restore window's answers, typed by the state the resident puts on them.
      answer(503, { error: "not-serviceable: restore in progress", state: "restoring", reason: "rehydrating" }),
      answer(503, { error: "mirror-busy: mutex not acquired within 30000ms", state: "warm", reason: "mirror-busy" }),
      new ExecInfraError("resident /exec HTTP 502", residentAnswerReason(502, {})),
      // The wake path's strike after the client's own budget ran out on a resident still restoring: the same restore, the same wait here.
      residentWakeBudgetStrike("/exec", "not-serviceable: The container just exited", 60_000, {
        kind: "status",
        state: "restoring",
        reason: "rehydrating",
      }),
      // Typed refusals no wait clears — no name BY THE TYPE, the strike's words the container's own.
      residentWakeStrike(
        "/exec",
        "not-serviceable: The container just exited",
        "the resident is down (no-snapshot: nothing to rehydrate from), which no wake recovers from; not waiting",
        "refused",
      ),
      answer(503, {
        error: "not-serviceable: no-snapshot: nothing to rehydrate from",
        state: "down",
        reason: "no-snapshot",
      }),
      answer(503, { error: "not-serviceable: registry record or repo facts missing", reason: "unregistered" }),
      new ExecInfraError("resident /exec HTTP 400", residentAnswerReason(400, {})),
      new ExecInfraError(
        "resident /exec: worktree still unavailable after a re-attach (evicted: …) — the resident may be mid-restore; try again shortly.",
        "refused",
      ),
      new ExecInfraError(
        "resident /exec: runtime replaced 2 times in a row with no successful operation between (…) — a deploy storm or a flapping resident, not a one-off deploy.",
        "refused",
      ),
      // The run's own stop aborting the request: nothing to wait for.
      new ExecInfraError(
        requestFailedMessage("resident", "/exec", new DOMException("This operation was aborted", "AbortError")),
        infraReasonOfRequestFailure(new DOMException("This operation was aborted", "AbortError"), stopped.signal),
      ),
      // Answers whose words are not the container's: the SDK's, and a deterministic 500 the resident answered (no state on it).
      answer(200, { error: "Command execution failed" }),
      answer(500, { error: "TypeError: Cannot read properties of undefined" }),
      "exit 1:\nno shell",
      "(no output)",
    ]);
    const c = new ExecHarnessContainer(executor);
    for (let i = 0; i < 11; i++) await expect(c.identity()).rejects.toBeInstanceOf(HarnessContainerDownError);
    // No name, so the one more command judges at once — the down strike first: its words say the container just exited, its type says nothing is coming back.
    for (let i = 0; i < 9; i++) expect(await c.identity()).toBeUndefined();
    // A command the container ran and failed, or an empty answer, is no identity — the container answered.
    expect(await c.identity()).toBeUndefined();
    expect(await c.identity()).toBeUndefined();
  });

  it("identityOrNothing is the name for the record, outside the one more command: a container down or unreachable names nothing there, a container gone under the question is still thrown, and an answer is the answer", async () => {
    const restarted = new ExecSandboxRestartedError("the sandbox restarted under the run (waited 42 s)", 42_000);
    const { executor } = recordingExecutor([
      new ExecInfraError("resident /exec HTTP 502", "worker-unavailable"),
      new ExecInfraError("resident /exec: The container is not running, consider calling start()", "answered"),
      restarted,
      "3f1c2a6e-9b0d-4d2e-8a1f-0c9e7b6a5d43\n",
    ]);
    const c = new ExecHarnessContainer(executor);
    expect(await identityOrNothing(c)).toBeUndefined();
    expect(await identityOrNothing(c)).toBeUndefined();
    await expect(identityOrNothing(c)).rejects.toBe(restarted);
    expect(await identityOrNothing(c)).toBe("3f1c2a6e-9b0d-4d2e-8a1f-0c9e7b6a5d43");
  });

  it("request runs curl over the executor with the body on stdin, parses a 2xx and a 5xx alike — a body carrying the executors' runtime word included — writes a long body to a file first, hands a secret header's value through the exec's environment, and rethrows the container-gone word like every other operation", async () => {
    const restarted = new ExecSandboxRestartedError("the sandbox restarted under the run (waited 42 s)", 42_000);
    const { executor, calls } = recordingExecutor([
      "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n" + '{"healthy":true}' + "\n--- stderr ---\n",
      "HTTP/1.1 500 Internal Server Error\r\ncontent-length: 5\r\n\r\noops!",
      "(no output)", // the long body's first chunk written
      "(no output)", // …and its second
      "HTTP/1.1 202 Accepted\r\n\r\n",
      restarted,
      "runtime-unreachable: the sandbox container's runtime did not answer",
      "exit 7:\ncurl: (7) Failed to connect to 127.0.0.1 port 41000",
      "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nthe log says runtime-replaced: the resident runtime was replaced",
      "HTTP/1.1 204 No Content\r\n\r\n",
    ]);
    const c = new ExecHarnessContainer(executor);
    const get: HarnessRequest = { method: "GET", port: 41000, path: "/api/health" };
    await expect(c.request(paths, get)).resolves.toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"healthy":true}',
    });
    expect(calls[0].command).toBe(requestScript(get));
    expect(calls[0].opts?.timeoutMs).toBe(60_000);
    const post: HarnessRequest = { ...get, method: "POST", path: "/api/session", body: '{"a":1}' };
    await expect(c.request(paths, post)).resolves.toEqual({
      status: 500,
      headers: { "content-length": "5" },
      body: "oops!",
    });
    expect(calls[1].command).toBe(requestScript(post));
    // A body past the inline size goes through a file under the run's command directory, removed by the request's own command.
    const long: HarnessRequest = { ...post, body: "b".repeat(INLINE_LINE_CHARS + 1) };
    await expect(c.request(paths, long)).resolves.toEqual({ status: 202, headers: {}, body: "" });
    expect(calls[2].command).toContain(`> '${paths.commandDir}/1.body'`);
    expect(calls[3].command).toContain(`>> '${paths.commandDir}/1.body'`);
    expect(calls[4].command).toBe(requestScript(long, `${paths.commandDir}/1.body`));
    await expect(c.request(paths, get)).rejects.toBe(restarted);
    await expect(c.request(paths, get)).rejects.toBeInstanceOf(HarnessContainerRuntimeReplacedError);
    await expect(c.request(paths, get)).rejects.toThrow(/request failed — exit 7/);
    // The server's body is anyone's text: the executors' runtime word in a 200 is that 200, not a container gone.
    await expect(c.request(paths, get)).resolves.toEqual({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "the log says runtime-replaced: the resident runtime was replaced",
    });
    // A secret header's value reaches curl through the exec's environment; the command text carries its name alone.
    const secret: HarnessRequest = { ...get, secretHeaders: { authorization: "Basic c2I6c2VjcmV0" } };
    await expect(c.request(paths, secret)).resolves.toEqual({ status: 204, headers: {}, body: "" });
    expect(calls[9].command).toBe(requestScript(secret));
    expect(calls[9].command).not.toContain("c2I6c2VjcmV0");
    expect(calls[9].opts?.env).toEqual({ SWITCHBOARD_REQUEST_H1: "Basic c2I6c2VjcmV0" });
    expect(calls[0].opts?.env).toBeUndefined();
  });

  it("alive reads the word, kill runs the script, tail never throws", async () => {
    const { executor, calls } = recordingExecutor(["alive\n", "dead\n", "(no output)", "exit 1:\nno such file"]);
    const c = new ExecHarnessContainer(executor);
    expect(await c.alive(4242)).toBe(true);
    expect(await c.alive(4242)).toBe(false);
    await c.kill(4242);
    expect(calls[2].command).toBe(killScript(4242));
    expect(await c.tail(paths.errLog, 2000)).toBe("");
  });

  it("remove takes the run's directory down as one tree, and nothing else", async () => {
    expect(removeScript(paths.dir)).toBe(`rm -rf '/var/tmp/switchboard-pi-run-7'`);
    const { executor, calls } = recordingExecutor();
    await new ExecHarnessContainer(executor).remove(paths);
    expect(calls.map((c) => c.command)).toEqual([`rm -rf '/var/tmp/switchboard-pi-run-7'`]);
  });

  it("a command the executor reports as failed is a HarnessContainerError naming the operation", async () => {
    const { executor } = recordingExecutor(["exit 1:\nmkfifo: cannot create fifo"]);
    await expect(new ExecHarnessContainer(executor).start(piStart([]))).rejects.toThrow(
      /start failed — exit 1:\nmkfifo/,
    );
  });
});

// Feature: docs/reference/specs/harness-pi.md item 16 — a Durable Object reset
// over a live container (the executor's `ExecControlResetError`) is
// resolved at the seam: an idempotent op is re-sent once (the container is
// unchanged, a re-read is safe); a write is never blindly re-sent (its outcome
// is unknown). Neither is ever the replaced verdict — `isContainerGone` never
// matches a control reset and its message never carries the runtime word.
describe("ExecHarnessContainer — a Durable Object control reset over a live container", () => {
  const controlReset = () =>
    new ExecControlResetError(
      "control-reset: the resident's Durable Object was reset (a deploy); the container and its processes are as they were; the command's outcome is unknown",
    );

  it("an idempotent op (readLog) re-sends the command ONCE on a control reset and returns its bytes; the executor is called twice", async () => {
    const bytes = Buffer.from("hello").toString("base64");
    const { executor, calls } = recordingExecutor([controlReset(), bytes]);
    const c = new ExecHarnessContainer(executor);
    await expect(c.readLog(paths.log, 0, 1024)).resolves.toEqual(new Uint8Array(Buffer.from("hello")));
    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe(readLogScript(paths.log, 0, 1024));
    expect(calls[1].command).toBe(calls[0].command); // the same command, re-sent once
  });

  it("an idempotent op that meets a control reset TWICE is the seam's HarnessContainerControlResetError naming the op — never a container-gone, never the runtime word", async () => {
    const { executor, calls } = recordingExecutor([controlReset(), controlReset()]);
    const c = new ExecHarnessContainer(executor);
    const err = await c.alive(4242).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessContainerControlResetError);
    expect((err as Error).message).toMatch(/^harness container: alive failed — control-reset:/);
    expect((err as Error).message).not.toMatch(/runtime-replaced|runtime-unreachable/);
    expect(calls).toHaveLength(2); // re-sent once, then given up
    // A control reset is judged as outcome-unknown-container-unchanged, never a replacement.
    expect(isControlReset(err)).toBe(true);
    expect(isContainerGone(err)).toBe(false);
  });

  it("a write (writeLine into the FIFO) is NEVER re-sent on a control reset — its outcome is unknown, raised as the seam's control reset at once", async () => {
    const { executor, calls } = recordingExecutor([controlReset()]);
    const c = new ExecHarnessContainer(executor);
    const err = await c.writeLine(paths, '{"type":"steer","message":"go"}').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessContainerControlResetError);
    expect((err as Error).message).toMatch(/^harness container: send failed — control-reset:/);
    expect(calls).toHaveLength(1); // never re-sent
    expect(isControlReset(err)).toBe(true);
    expect(isContainerGone(err)).toBe(false);
  });

  it("a GET request re-sends once on a control reset; a POST request is raised at once, never re-sent", async () => {
    const ok = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{}";
    const get: HarnessRequest = { method: "GET", port: 41000, path: "/api/health" };
    const post: HarnessRequest = { method: "POST", port: 41000, path: "/api/session/prompt", body: '{"text":"hi"}' };

    const read = recordingExecutor([controlReset(), ok]);
    await expect(new ExecHarnessContainer(read.executor).request(paths, get)).resolves.toMatchObject({ status: 200 });
    expect(read.calls).toHaveLength(2); // re-sent once

    const write = recordingExecutor([controlReset()]);
    const err = await new ExecHarnessContainer(write.executor).request(paths, post).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessContainerControlResetError);
    expect(write.calls).toHaveLength(1); // never re-sent
  });

  // identity() is the one more command a dead process's judgement rests on
  // (`replacedVerdict`). A control reset over it is the container unchanged, so
  // it is thrown — a re-send for the caller — never returned as `undefined`,
  // which reads as a container with no name (a judgement).
  it("identity() re-sends once on a single control reset and answers the word — a control reset over the probe is a re-send", async () => {
    const { executor, calls } = recordingExecutor([controlReset(), "3f1c2a6e-9b0d-4d2e-8a1f-0c9e7b6a5d43\n"]);
    const c = new ExecHarnessContainer(executor);
    expect(await c.identity()).toBe("3f1c2a6e-9b0d-4d2e-8a1f-0c9e7b6a5d43");
    expect(calls).toHaveLength(2); // re-sent once
  });

  it("identity() rethrows a control reset it meets twice — never `undefined` — so the caller re-attaches instead of judging a container with no name", async () => {
    const { executor } = recordingExecutor([controlReset(), controlReset()]);
    const c = new ExecHarnessContainer(executor);
    const err = await c.identity().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessContainerControlResetError);
    expect(isControlReset(err)).toBe(true);
    expect(isContainerGone(err)).toBe(false);
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
    ["/var", { owner: "root", mode: 0o755 }],
    ["/var/tmp", { owner: "root", mode: 0o1777 }],
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
      exec: async (command: string) => {
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

describe("ExecHarnessContainer on a resident, two thread users on one container", () => {
  // Production, the first review run on pi: a coding run as one pool user had
  // created a parent shared by every run two seconds earlier, and the
  // review's mkdir as another user was refused under it before any model
  // turn. The control builds that shape by hand: no path the harness derives
  // has a shared parent any more.
  it("the control: under one shared parent the first user's directory refuses the second user's mkdir, the failure a root of the run's own directly under /tmp removes", async () => {
    const tree = new FakeDirectoryTree();
    await new ExecHarnessContainer(tree.executorAs("worker2")).writeFile(
      "/tmp/switchboard-pi/run-a/agent/SYSTEM.md",
      "a",
    );
    expect(tree.dirs.get("/tmp/switchboard-pi")?.owner).toBe("worker2");
    await expect(
      new ExecHarnessContainer(tree.executorAs("worker3")).writeFile("/tmp/switchboard-pi/run-b/agent/SYSTEM.md", "b"),
    ).rejects.toThrow(
      /write failed .* exit 1:\nmkdir: cannot create directory '\/tmp\/switchboard-pi\/run-b': Permission denied/,
    );
  });

  it("two runs as two users both write their files, start their process and remove their root: each run's root is its own directly under /var/tmp, made 700 by the user running it, so neither mkdir meets a parent the other owns", async () => {
    const tree = new FakeDirectoryTree();
    const runs = [
      { user: "worker2", paths: piRunPaths("run-a") },
      { user: "worker3", paths: piRunPaths("run-b") },
    ];
    for (const { user, paths: p } of runs) {
      const container = new ExecHarnessContainer(tree.executorAs(user, ["(no output)", "4242\n"]));
      await container.writeFile(`${p.agentDir}/SYSTEM.md`, "the prompt");
      await expect(container.start({ ...piStart([]), paths: p })).resolves.toEqual({ pid: 4242 });
    }
    expect(tree.dirs.get("/var/tmp/switchboard-pi-run-a")).toEqual({ owner: "worker2", mode: 0o700 });
    expect(tree.dirs.get("/var/tmp/switchboard-pi-run-b")).toEqual({ owner: "worker3", mode: 0o700 });
    expect(tree.dirs.has("/var/tmp/switchboard-pi-run-a/agent/sessions")).toBe(true);
    expect(tree.dirs.has("/var/tmp/switchboard-pi-run-b/cmd")).toBe(true);
    // Nothing between /tmp and a run's root, shared or per user.
    const made = [...tree.dirs.keys()].filter((d) => d !== "/" && d !== "/tmp" && d !== "/var" && d !== "/var/tmp");
    expect(made.every((d) => d.startsWith("/var/tmp/switchboard-pi-run-"))).toBe(true);
    expect(tree.dirs.has("/var/tmp/switchboard-pi")).toBe(false);
    expect(tree.dirs.has("/var/tmp/switchboard-pi-worker2")).toBe(false);
    // Each run takes its own root down when it ends, and /tmp is as it was.
    for (const { user, paths: p } of runs) await new ExecHarnessContainer(tree.executorAs(user)).remove(p);
    expect([...tree.dirs.keys()]).toEqual(["/", "/tmp", "/var", "/var/tmp"]);
  });
});

// docs/reference/specs/harness-pi.md items 4 and 12: the seam's answer to
// where a fresh run's files go. The exec container names the root the harness
// proposed, which its scripts make at 700 as the thread's user; no command
// runs for the answer.
describe("ExecHarnessContainer.makeRoot", () => {
  it("answers the root the harness proposed, without running a command", async () => {
    const { executor, calls } = recordingExecutor();
    expect(await new ExecHarnessContainer(executor).makeRoot(piRunPaths("run-7").dir)).toBe(
      "/var/tmp/switchboard-pi-run-7",
    );
    expect(await new ExecHarnessContainer(executor).makeRoot("/tmp/switchboard-oc-run-7")).toBe(
      "/tmp/switchboard-oc-run-7",
    );
    expect(calls).toEqual([]);
  });
});

describe("ExecHarnessContainer.cwd", () => {
  it("answers the checkout the harness names, where the executor runs every command and so the process, without running a command", () => {
    const { executor, calls } = recordingExecutor();
    expect(new ExecHarnessContainer(executor).cwd(paths, "/workspace/threads/t/main")).toBe(
      "/workspace/threads/t/main",
    );
    expect(calls).toEqual([]);
  });
});
