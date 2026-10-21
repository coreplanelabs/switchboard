import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testSourceInputIntent } from "../../testing/sourceInputs.js";
import { resolveControlResetWrite } from "../reattach.js";
import { piExtensionSource, piSourceInputCommand } from "./extensionSource.js";
import { parsePiLine, splitJsonl } from "./protocol.js";

type Command = { handler: (args: string, ctx: unknown) => Promise<void> };
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "swb-source-command-"));
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  vi.stubEnv("SWITCHBOARD_HARNESS_URL", "https://fixture.invalid");
  vi.stubEnv("SWITCHBOARD_RUN_BEARER", "fixture-only");
  vi.stubEnv("SWITCHBOARD_RUN_ID", "source-consumer");
  vi.stubEnv("SWITCHBOARD_PI_OUTPUT_ROOT", "");
  vi.stubEnv("SWITCHBOARD_RUN_SCRATCH", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function load(sourceInput = true, failSend = false) {
  const file = join(root, `extension-${sourceInput}.mjs`);
  writeFileSync(file, piExtensionSource([], sourceInput ? { sourceInput: true } : {}));
  const extension = (await import(pathToFileURL(file).href)).default;
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "Synthetic seed", timestamp: 1 });
  const commands = new Map<string, Command>();
  const options: unknown[] = [];
  await extension({
    on: () => {},
    registerTool: () => {},
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    sendMessage: (
      message: { customType: string; content: string; display: boolean; details: unknown },
      option: unknown,
    ) => {
      options.push(option);
      if (failSend) throw new Error("synthetic native write failure");
      manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    },
  });
  const intent = testSourceInputIntent().entries[0]!;
  intent.phase = "begun";
  intent.native.sessionId = manager.getSessionFile()!;
  const text = 'External evidence only.\n/stop "quoted"';
  intent.renderedHash = createHash("sha256").update(text).digest("hex");
  const submit = async (command = piSourceInputCommand(intent, text)!) => {
    const [name, ...args] = command.message.slice(1).split(" ");
    await commands.get(name!)!.handler(args.join(" "), { sessionManager: manager });
  };
  return { commands, manager, options, intent, text, submit };
}

describe("host source-input command", () => {
  it("carries the host command through the real Pi RPC process into the original native file", async () => {
    const binary = resolve("node_modules/.bin/pi");
    expect(existsSync(binary)).toBe(true);
    const { intent, text, manager } = await load();
    const file = manager.getSessionFile()!;
    const extension = join(root, "native.mjs");
    writeFileSync(extension, piExtensionSource([], { sourceInput: true }));
    mkdirSync(join(root, "agent"));
    const child = spawn(
      binary,
      [
        "--mode",
        "rpc",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--tools",
        "",
        "-e",
        extension,
        "--session",
        file,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          PI_CODING_AGENT_DIR: join(root, "agent"),
          PI_SKIP_VERSION_CHECK: "1",
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          SWITCHBOARD_HARNESS_URL: "https://fixture.invalid",
          SWITCHBOARD_RUN_BEARER: "fixture-only",
          SWITCHBOARD_RUN_ID: "source-consumer",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const ending = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const waiting = new Map<string, (event: Record<string, unknown>) => void>();
    let buffer = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-1500);
    });
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const framed = splitJsonl(buffer);
      buffer = framed.rest;
      for (const line of framed.lines) {
        const event = parsePiLine(line);
        if (event?.type === "response" && typeof event.id === "string") waiting.get(event.id)?.(event);
      }
    });
    const command = async (request: Record<string, unknown> & { id: string }) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<Record<string, unknown>>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Owned Pi RPC deadline: " + stderr)), 12000);
          waiting.set(request.id, resolve);
          child.stdin.write(JSON.stringify(request) + "\n");
        });
      } finally {
        clearTimeout(timer);
        waiting.delete(request.id);
      }
    };
    const failures: unknown[] = [];
    try {
      const first = piSourceInputCommand(intent, text)!;
      const secondIntent = { ...intent, id: "second-original", witness: { ...intent.witness, seq: 9 } };
      const second = piSourceInputCommand(secondIntent, text)!;
      expect(await command(first)).toMatchObject({ success: true, data: { disposition: "handled" } });
      expect(await command(second)).toMatchObject({ success: true, data: { disposition: "handled" } });
      const result = await command({ id: "entries", type: "get_entries" });
      expect(result.success).toBe(true);
      const entries = (result.data as { entries: Array<Record<string, unknown>> }).entries.filter(
        (entry) => entry.type === "custom_message",
      );
      expect(entries.map((entry) => ({ content: entry.content, details: entry.details }))).toEqual([
        { content: text, details: { version: 1, intent } },
        { content: text, details: { version: 1, intent: secondIntent } },
      ]);
      expect(entries[0]!.id).not.toEqual(entries[1]!.id);
      expect(
        readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.type === "custom_message"),
      ).toEqual(entries);
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        expect(
          await Promise.race([
            ending,
            new Promise((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("Owned Pi did not exit")), 5000);
            }),
          ]),
        ).toEqual({ code: 0, signal: null });
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await ending;
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 1)
      throw new AggregateError(failures, "Native source fixture and cleanup failed", { cause: failures[0] });
    if (failures.length > 0) throw failures[0];
  }, 30000);

  it("stores the original typed identities with identical text and never starts a model turn", async () => {
    const { intent, text, submit, manager, options } = await load();
    const first = structuredClone(intent);
    const second = structuredClone(intent);
    second.id = "second-original";
    second.witness.seq = 9;
    second.witness.digest = "b".repeat(64);
    await submit(piSourceInputCommand(first, text)!);
    await submit(piSourceInputCommand(second, text)!);
    const entries = manager.getEntries().filter((entry) => entry.type === "custom_message");
    expect(
      entries.map((entry) => ({
        type: entry.type,
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
      })),
    ).toEqual([
      {
        type: "custom_message",
        customType: "switchboard-source-input",
        content: text,
        display: false,
        details: { version: 1, intent: first },
      },
      {
        type: "custom_message",
        customType: "switchboard-source-input",
        content: text,
        display: false,
        details: { version: 1, intent: second },
      },
    ]);
    expect(entries[0]!.id).not.toEqual(entries[1]!.id);
    expect(options).toEqual([{ triggerTurn: false }, { triggerTurn: false }]);
  });

  it("refuses a changed session, altered text and duplicate original without replacing the first input", async () => {
    const fixture = await load();
    const { intent, text, submit, manager } = fixture;
    const original = piSourceInputCommand(intent, text)!;
    const envelope = JSON.parse(original.message.slice(original.message.indexOf(" ") + 1));
    envelope.intent.native.sessionId = "another-session";
    await expect(
      submit({ ...original, message: "/switchboard-source-input " + JSON.stringify(envelope) }),
    ).rejects.toThrow("source input refused");
    envelope.intent.native.sessionId = intent.native.sessionId;
    envelope.intent.owner.runId = "another-owner";
    await expect(
      submit({ ...original, message: "/switchboard-source-input " + JSON.stringify(envelope) }),
    ).rejects.toThrow("source input refused");
    envelope.intent.owner.runId = intent.owner.runId;
    envelope.text = "changed evidence";
    await expect(
      submit({ ...original, message: "/switchboard-source-input " + JSON.stringify(envelope) }),
    ).rejects.toThrow("source input refused");
    await submit(original);
    await expect(submit(original)).rejects.toThrow("source input already submitted");
    const rows = manager.getEntries().filter((entry) => entry.type === "custom_message");
    expect(rows.map((entry) => entry.details)).toEqual([{ version: 1, intent }]);
    // A fresh extension must also see the original native entry, not just its own memory.
    const file = join(root, "fresh.mjs");
    writeFileSync(file, piExtensionSource([], { sourceInput: true }));
    let command: Command | undefined;
    await (
      await import(pathToFileURL(file).href)
    ).default({
      on: () => {},
      registerTool: () => {},
      registerCommand: (_name: string, value: Command) => {
        command = value;
      },
      sendMessage: () => {
        throw new Error("duplicate reached the native sender");
      },
    });
    await expect(
      command!.handler(original.message.slice(original.message.indexOf(" ") + 1), { sessionManager: manager }),
    ).rejects.toThrow("source input already submitted");
    expect(manager.getEntries().filter((entry) => entry.type === "custom_message")).toEqual(rows);
  });

  it("requires a begun Pi intent and matching input digest; normal extensions offer no source command", async () => {
    const { intent, text } = await load();
    const valid = piSourceInputCommand(intent, text)!;
    expect(valid).toMatchObject({ type: "prompt", sourceInput: { version: 1, id: "source-input-one" } });
    expect(piSourceInputCommand({ ...intent, phase: "prepared" }, text)).toBeUndefined();
    expect(
      piSourceInputCommand({ ...intent, native: { ...intent.native, harness: "opencode" } }, text),
    ).toBeUndefined();
    expect(piSourceInputCommand(intent, "changed text")).toBeUndefined();
    expect((await load(false)).commands.size).toBe(0);
  });

  it("retains a failed native submission as uncertain and refuses a second send", async () => {
    const { intent, text, submit, options } = await load(true, true);
    await expect(submit()).rejects.toMatchObject({
      message: "source input submission is unresolved",
      cause: { message: "synthetic native write failure" },
    });
    await expect(submit()).rejects.toThrow("source input already submitted");
    expect(options).toEqual([{ triggerTurn: false }]);
    expect(piSourceInputCommand(intent, text)).toMatchObject({ sourceInput: { id: "source-input-one" } });
  });

  it("holds new input when the local attempt set is full without dropping its originals", async () => {
    const { intent, text, submit, manager } = await load();
    for (let index = 0; index < 64; index++)
      await submit(
        piSourceInputCommand(
          { ...intent, id: `original-${index}`, witness: { ...intent.witness, seq: index + 1 } },
          text,
        )!,
      );
    await expect(submit(piSourceInputCommand({ ...intent, id: "over-capacity" }, text)!)).rejects.toThrow(
      "source input capacity held",
    );
    expect(
      manager
        .getEntries()
        .filter((entry) => entry.type === "custom_message")
        .map((entry) => entry.details),
    ).toEqual(
      Array.from({ length: 64 }, (_, index) => ({
        version: 1,
        intent: { ...intent, id: `original-${index}`, witness: { ...intent.witness, seq: index + 1 } },
      })),
    );
  });

  it("holds an uncertain source command even when its RPC ID echoed; ordinary prompts keep their existing recovery", async () => {
    const { intent, text } = await load();
    const command = piSourceInputCommand(intent, text)!;
    for (const echoed of [false, true]) {
      expect(resolveControlResetWrite(command, () => echoed)).toEqual({
        kind: "fail",
        message: "Source input delivery is unresolved. Keep the original input for native reconciliation.",
      });
    }
    expect(
      resolveControlResetWrite({ type: "prompt", id: "ordinary", message: "ordinary request" }, () => true),
    ).toEqual({ kind: "none" });
  });
});
