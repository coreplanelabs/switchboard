import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ServerResponse } from "node:http";
import { describe, it } from "vitest";
import { parsePiLine, splitJsonl } from "../protocol.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { testSourceInputIntent } from "../../../testing/sourceInputs.js";
import { readPiSourceInputReceipt } from "../sourceInputReceipt.js";

const BIN = resolve(import.meta.dirname, "../../../../../node_modules/.bin/pi");

// These are native capability checks, not a source sender or an inbox ACK.
// A handled RPC command can still refer to a volatile queued custom message.
describe.skipIf(!existsSync(BIN))("native Pi source input persistence", () => {
  it("distinguishes a handled command from saved input through crash, restart and compaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "switchboard-pi-streaming-input-"));
    const agentDir = join(root, "agent");
    type Gate = { release(): void; destroy(): void };
    let gate: { arrived(value: Gate): void } | undefined;
    const heldResponses = new Set<ServerResponse>();
    function answer() {
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "local-completion",
          object: "chat.completion.chunk",
          created: 1,
          model: "never-call",
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
        })}\n\n`;
      return (
        chunk({ role: "assistant", content: "Local fixture answer." }, null) + chunk({}, "stop") + "data: [DONE]\n\n"
      );
    }
    function holdNextModelCall() {
      assert.equal(gate, undefined);
      let arrived: ((value: Gate) => void) | undefined;
      const ready = new Promise<Gate>((resolve) => {
        arrived = resolve;
      });
      assert(arrived);
      gate = { arrived };
      return ready;
    }
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (gate) {
          const original = gate;
          gate = undefined;
          response.flushHeaders();
          heldResponses.add(response);
          response.once("close", () => heldResponses.delete(response));
          original.arrived({
            release: () => {
              heldResponses.delete(response);
              response.end(answer());
            },
            destroy: () => response.destroy(),
          });
        } else response.end(answer());
      });
    });
    const owned: { child: ChildProcessWithoutNullStreams; closed: boolean }[] = [];
    let sequence = 0;
    function start(sessionFile: string) {
      const child = spawn(
        BIN,
        [
          "--mode",
          "rpc",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "-e",
          join(root, "probe.mjs"),
          "--tools",
          "",
          "--provider",
          "controlled",
          "--model",
          "never-call",
          "--session",
          sessionFile,
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            PI_CODING_AGENT_DIR: agentDir,
            PI_SKIP_VERSION_CHECK: "1",
            PI_OFFLINE: "1",
            PI_TELEMETRY: "0",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const pending = new Map<string, (value: Record<string, unknown> | Error) => void>();
      const events: Record<string, unknown>[] = [];
      const observers = new Set<(event: Record<string, unknown>) => void>();
      let stderr = "";
      let buffer = "";
      const state = { child, closed: false };
      owned.push(state);
      const ending = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          state.closed = true;
          for (const cancel of pending.values()) cancel(new Error("Owned Pi child exited before its response"));
          pending.clear();
          resolve({ code, signal });
        });
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.stdout.on("data", (chunk) => {
        buffer += String(chunk);
        const framed = splitJsonl(buffer);
        buffer = framed.rest;
        for (const line of framed.lines) {
          const event = parsePiLine(line);
          if (!event) continue;
          events.push(event);
          for (const observe of [...observers]) observe(event);
          if (event.type === "response" && typeof event.id === "string" && pending.has(event.id)) {
            const accept = pending.get(event.id);
            pending.delete(event.id);
            accept!(event);
          }
        }
      });
      return {
        observe(predicate: (event: Record<string, unknown>) => boolean) {
          const prior = events.find(predicate);
          if (prior) return Promise.resolve(prior);
          return new Promise<Record<string, unknown>>((resolve, reject) => {
            const observer = (event: Record<string, unknown>) => {
              if (!predicate(event)) return;
              clearTimeout(timer);
              observers.delete(observer);
              resolve(event);
            };
            const timer = setTimeout(() => {
              observers.delete(observer);
              reject(new Error("Owned Pi event deadline"));
            }, 12000);
            observers.add(observer);
          });
        },
        async command(request: Record<string, unknown>): Promise<Record<string, unknown>> {
          const id = `probe-${++sequence}`;
          const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(new Error(`Pi response deadline for ${id}: ${stderr}`));
            }, 12000);
            pending.set(id, (value) => {
              clearTimeout(timer);
              if (value instanceof Error) reject(value);
              else resolve(value);
            });
            child.stdin.write(JSON.stringify({ ...request, id }) + "\n");
          });
          assert.equal(response.success, true, JSON.stringify(response));
          const data = response.data;
          assert(data !== null && typeof data === "object" && !Array.isArray(data));
          return data as Record<string, unknown>;
        },
        async close() {
          child.stdin.end();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const result = await Promise.race([
            ending,
            new Promise((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("Owned Pi child did not exit after stdin ended")), 5000);
            }),
          ]).finally(() => clearTimeout(timer));
          assert.deepEqual(result, { code: 0, signal: null });
        },
        async kill() {
          if (!state.closed) child.kill("SIGKILL");
          const result = await ending;
          assert.deepEqual(result, { code: null, signal: "SIGKILL" });
          return result;
        },
      };
    }

    const failures: unknown[] = [];
    try {
      mkdirSync(agentDir);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      assert(address !== null && typeof address !== "string");
      const port = address.port;
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({
          defaultProvider: "controlled",
          defaultModel: "never-call",
          compaction: { enabled: false, keepRecentTokens: 16, reserveTokens: 128 },
        }),
      );
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            controlled: {
              baseUrl: `http://127.0.0.1:${port}/v1`,
              api: "openai-completions",
              apiKey: "CONTROLLED_FIXTURE_KEY",
              models: [
                {
                  id: "never-call",
                  name: "never-call",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 32000,
                  maxTokens: 128,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        }),
      );
      writeFileSync(
        join(root, "probe.mjs"),
        `export default function (pi) {
    pi.registerCommand("local-source-fixture", {
      description: "Isolated custom input persistence probe",
      handler: async (args) => {
        pi.sendMessage({ customType: "switchboard-source-input", content: "identical visible text", display: false,
          details: JSON.parse(args) }, { triggerTurn: false });
      },
    });
  }\n`,
      );
      function rows(result: Record<string, unknown>): Record<string, unknown>[] {
        const entries = result.entries;
        assert(Array.isArray(entries));
        return entries.filter(
          (entry) => entry.type === "custom_message" && entry.customType === "switchboard-source-input",
        );
      }
      const diskRows = (file: string) =>
        readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.type === "custom_message" && entry.customType === "switchboard-source-input");
      const sourceDetails = (file: string, id: string, seq: number) => {
        const intent = testSourceInputIntent().entries[0]!;
        intent.id = id;
        intent.phase = "begun";
        intent.native.sessionId = file;
        intent.witness.seq = seq;
        intent.renderedHash = createHash("sha256").update("identical visible text").digest("hex");
        return { version: 1, intent };
      };
      const fileReceipt = (details: ReturnType<typeof sourceDetails>) =>
        readPiSourceInputReceipt(details.intent, {
          path: details.intent.native.sessionId,
          content: readFileSync(details.intent.native.sessionId, "utf8"),
        });
      const send = (child: ReturnType<typeof start>, details: Record<string, unknown>) =>
        child.command({ type: "prompt", message: "/local-source-fixture " + JSON.stringify(details) });
      const seed = () => {
        const manager = SessionManager.create(root, join(root, "sessions"));
        for (let index = 0; index < 20; index++)
          manager.appendMessage({
            role: "user",
            timestamp: index + 1,
            content: [{ type: "text", text: `Synthetic old message ${index}. ` + "fixture context ".repeat(80) }],
          });
        const file = manager.getSessionFile();
        assert(file);
        assert.equal(existsSync(file), true);
        return file;
      };

      // The command can be handled while the native input remains only in memory.
      const uncertainFile = seed();
      const uncertain = start(uncertainFile);
      const heldCrashCall = holdNextModelCall();
      await uncertain.command({ type: "prompt", message: "Start the isolated crash arm." });
      const crashGate = await deadline(heldCrashCall);
      assert.equal((await uncertain.command({ type: "get_state" })).isStreaming, true);
      const uncertainDetails = sourceDetails(uncertainFile, "uncertain-original", 8);
      const uncertainResponse = await send(uncertain, uncertainDetails);
      assert.equal(uncertainResponse.disposition, "handled");
      assert.deepEqual(rows(await uncertain.command({ type: "get_entries" })), []);
      assert.deepEqual(diskRows(uncertainFile), []);
      assert.deepEqual(fileReceipt(uncertainDetails), { ok: false, reason: "native-unproved" });
      await uncertain.kill();
      crashGate.destroy();
      const uncertainRestart = start(uncertainFile);
      assert.equal((await uncertainRestart.command({ type: "get_state" })).sessionFile, uncertainFile);
      assert.deepEqual(rows(await uncertainRestart.command({ type: "get_entries" })), []);
      assert.deepEqual(fileReceipt(uncertainDetails), { ok: false, reason: "native-unproved" });
      await uncertainRestart.close();

      // Distinct originals with the same text are retained only after native flush.
      const stableFile = seed();
      assert.notEqual(stableFile, uncertainFile);
      const stable = start(stableFile);
      const heldStableCall = holdNextModelCall();
      await stable.command({ type: "prompt", message: "Start the isolated retained arm." });
      const stableGate = await deadline(heldStableCall);
      assert.equal((await stable.command({ type: "get_state" })).isStreaming, true);
      const first = sourceDetails(stableFile, "retained-first", 8);
      const second = sourceDetails(stableFile, "retained-second", 9);
      assert.equal((await send(stable, first)).disposition, "handled");
      assert.equal((await send(stable, second)).disposition, "handled");
      assert.deepEqual(rows(await stable.command({ type: "get_entries" })), []);
      assert.deepEqual(diskRows(stableFile), []);
      assert.deepEqual(fileReceipt(first), { ok: false, reason: "native-unproved" });
      assert.deepEqual(fileReceipt(second), { ok: false, reason: "native-unproved" });
      stableGate.release();
      await stable.observe((event) => event.type === "agent_settled");
      const before = rows(await stable.command({ type: "get_entries" }));
      assert.deepEqual(
        before.map((entry) => ({ content: entry.content, details: entry.details })),
        [
          { content: "identical visible text", details: first },
          { content: "identical visible text", details: second },
        ],
      );
      for (const entry of before) assert(typeof entry.id === "string" && entry.id.length > 0);
      assert.notEqual(before[0]!.id, before[1]!.id);
      assert.deepEqual(diskRows(stableFile), before);
      const firstReceipt = fileReceipt(first);
      const secondReceipt = fileReceipt(second);
      assert.equal(firstReceipt.ok, true);
      assert.equal(secondReceipt.ok, true);
      if (!firstReceipt.ok || !secondReceipt.ok) throw new Error("Original native receipt missing");
      assert.equal(firstReceipt.receipt.native.entryId, before[0]!.id);
      assert.equal(secondReceipt.receipt.native.entryId, before[1]!.id);
      await stable.close();
      const resumed = start(stableFile);
      assert.equal((await resumed.command({ type: "get_state" })).sessionFile, stableFile);
      assert.deepEqual(rows(await resumed.command({ type: "get_entries" })), before);
      assert.deepEqual(fileReceipt(first), firstReceipt);
      assert.deepEqual(fileReceipt(second), secondReceipt);
      await resumed.command({
        type: "compact",
        customInstructions: "Summarize only the synthetic fixture context.",
      });
      const compactEntries = await resumed.command({ type: "get_entries" });
      assert(Array.isArray(compactEntries.entries));
      assert.equal(compactEntries.entries.filter((entry) => entry.type === "compaction").length, 1);
      assert.deepEqual(rows(compactEntries), before);
      await resumed.close();
      const afterCompaction = start(stableFile);
      assert.equal((await afterCompaction.command({ type: "get_state" })).sessionFile, stableFile);
      assert.deepEqual(rows(await afterCompaction.command({ type: "get_entries" })), before);
      assert.deepEqual(diskRows(stableFile), before);
      assert.deepEqual(fileReceipt(first), firstReceipt);
      assert.deepEqual(fileReceipt(second), secondReceipt);
      await afterCompaction.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      for (const response of heldResponses) response.destroy();
      await Promise.all(
        owned
          .filter((state) => !state.closed)
          .map(async ({ child }) => {
            const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
            child.kill("SIGKILL");
            await closed;
          }),
      );
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 1)
      throw new AggregateError(failures, "Native fixture and cleanup failed", { cause: failures[0] });
    if (failures.length > 0) throw failures[0];
  }, 90_000);
});

function deadline<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    pending,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Local model request deadline")), 12000);
    }),
  ]).finally(() => clearTimeout(timer));
}
