import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore, R2ArtifactStore } from "../artifacts/store.js";
import type { RunEvent } from "../core/runEvents.js";
import { BASH_TIMEOUT_MAX_MS } from "../execution/bashTimeout.js";
import { MAX_READ_BYTES } from "../execution/binaryRead.js";
import type { Executor } from "../execution/executor.js";
import { Secret } from "../secrets.js";
import { attachFileTool, MAX_ARTIFACT_BYTES, type UploadTicketCapability } from "./attach.js";
import { TOOLSETS, type ToolContext } from "./workspace.js";
import { ConsoleIO } from "../cli.js";
import { HttpIO } from "../channels/http.js";
import { McpIO } from "../channels/mcp.js";
import type { ChannelIO } from "../core/types.js";

// Feature: docs/reference/specs/agent-coding.md item 10 — a run's screenshot
// reaches the person: `attach_file` reads the workspace file as bytes off the
// Executor seam and posts it through the channel's file upload; each missing
// half is named, never papered over.

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function executor(files: Record<string, Uint8Array | Error>, opts: { bytes?: false } = {}): Executor {
  const base: Executor = { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
  if (opts.bytes === false) return base;
  return {
    ...base,
    readBytes: async (path) => {
      const f = files[path];
      if (!f) throw new Error(`read-failed: cat: ${path}: No such file or directory`);
      if (f instanceof Error) throw f;
      return f;
    },
  };
}

function attaching(fail?: Error) {
  const posted: Array<{ name: string; bytes: Uint8Array; lead: string }> = [];
  const attach: ToolContext["attach"] = async (file) => {
    if (fail) throw fail;
    posted.push(file);
  };
  return { posted, attach };
}

describe("attach_file toolset wiring", () => {
  it("is in the coding (full) toolset only — a read-only or workspace-less agent never posts files", () => {
    const names = (key: string) => (TOOLSETS[key] ?? []).map((t) => t.name);
    expect(names("full")).toContain("attach_file");
    for (const key of ["readonly", "web", "assistant", "explore", "conductor", "none"]) {
      expect(names(key), key).not.toContain("attach_file");
    }
    expect(attachFileTool.sideEffectFree).toBeUndefined(); // it posts: strictly in order
    expect(attachFileTool.description).toContain(String(MAX_READ_BYTES));
  });
});

describe("attach_file", () => {
  it("posts the file's bytes under its own name with the comment as the lead", async () => {
    const { posted, attach } = attaching();
    const out = await attachFileTool.run(
      { path: "shots/verdict-dark.png", comment: "PR verdict mock — dark" },
      { executor: executor({ "shots/verdict-dark.png": png }), attach },
    );
    expect(out).toBe("attached verdict-dark.png (7 bytes) to the conversation");
    expect(posted).toEqual([{ name: "verdict-dark.png", bytes: png, lead: "PR verdict mock — dark" }]);
  });

  it("the lead defaults to the file name when no comment is given", async () => {
    const { posted, attach } = attaching();
    await attachFileTool.run({ path: "out.pdf", comment: "  " }, { executor: executor({ "out.pdf": png }), attach });
    expect(posted[0]).toMatchObject({ name: "out.pdf", lead: "out.pdf" });
  });

  it("without the channel's upload it says the conversation takes no files — and reads nothing", async () => {
    let reads = 0;
    const ex: Executor = {
      ...executor({}),
      readBytes: async () => {
        reads++;
        return png;
      },
    };
    const out = await attachFileTool.run({ path: "a.png" }, { executor: ex });
    expect(out).toMatch(/not available here: this conversation's channel takes no file uploads — link to the file/);
    expect(reads).toBe(0);
  });

  it("on an executor without a byte read it says the workspace cannot hand files over — and posts nothing", async () => {
    const { posted, attach } = attaching();
    const out = await attachFileTool.run({ path: "a.png" }, { executor: executor({}, { bytes: false }), attach });
    expect(out).toMatch(/not available here: this workspace cannot hand files over — link to the file/);
    expect(posted).toEqual([]);
  });

  it("a missing file, an over-cap file and an empty file are each named; nothing is posted", async () => {
    const { posted, attach } = attaching();
    const ctx = {
      executor: executor({
        "big.mp4": new Error("big.mp4 is over the 10485760-byte cap of a binary read"),
        "empty.png": new Uint8Array(0),
      }),
      attach,
    };
    expect(await attachFileTool.run({ path: "gone.png" }, ctx)).toBe(
      "error: could not read gone.png: read-failed: cat: gone.png: No such file or directory",
    );
    expect(await attachFileTool.run({ path: "big.mp4" }, ctx)).toMatch(/could not read big.mp4: .*over the .*cap/);
    expect(await attachFileTool.run({ path: "empty.png" }, ctx)).toBe("error: empty.png is empty — nothing to attach");
    expect(await attachFileTool.run({ path: "  " }, ctx)).toBe("error: path is required");
    expect(posted).toEqual([]);
  });

  it("a refused upload (a missing scope, an API error) is reported with the platform's message, never swallowed", async () => {
    const { attach } = attaching(new Error("An API error occurred: missing_scope"));
    const out = await attachFileTool.run({ path: "a.png" }, { executor: executor({ "a.png": png }), attach });
    expect(out).toBe("error: the channel refused the upload of a.png: An API error occurred: missing_scope");
  });
});

// Feature: docs/reference/specs/agent-coding.md item 10 / execution.md item 20 (record
// 0033) — the store path: the CONTAINER moves the bytes (a presigned PUT, then
// the channel's one-shot upload URL); the bot measures, mints, verifies by HEAD,
// records the `artifact` event and completes the share. Each step's failure
// stops the chain and names itself; the bot never holds the file.
describe("attach_file through the artifact store", () => {
  const SIZE = 3_145_728;
  const PUT_URL = /^curl -fsS -T 'shots\/page\.png' -H 'Content-Type: image\/png' '(memory:\/\/test\/[^']+)'$/;

  /** An executor whose `exec` records every command and answers by prefix: the
   *  PUT lands the bytes in the in-memory store (as R2 would), the rest is scripted. */
  function storeExecutor(
    store: InMemoryArtifactStore,
    over: { stat?: string; put?: string; post?: string; sizeInStore?: number } = {},
  ) {
    const commands: Array<{ command: string; timeoutMs?: number }> = [];
    const log: string[] = [];
    const exec: Executor["exec"] = async (command, opts) => {
      commands.push({ command, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
      if (command.startsWith("stat ")) {
        log.push("stat");
        return over.stat ?? `${SIZE}\n`;
      }
      if (command.startsWith("curl -fsS -T ")) {
        log.push("put");
        if (over.put !== undefined) return over.put;
        const url = new URL(/'([^']+)'$/.exec(command)![1]);
        const key = decodeURIComponent(url.pathname.slice(1));
        store.put(key, new Uint8Array(over.sizeInStore ?? SIZE), url.searchParams.get("content-type") ?? "");
        return "";
      }
      if (command.startsWith("curl -fsS --upload-file ")) {
        log.push("post");
        return over.post ?? "";
      }
      return `exit 127: unexpected command ${command}`;
    };
    return { commands, log, executor: { exec, readFile: async () => "", writeFile: async () => "" } as Executor };
  }

  function ticketing(log: string[], over: { mint?: Error; complete?: Error } = {}) {
    const minted: Array<{ name: string; size: number }> = [];
    const completed: string[] = [];
    const uploadTicket: UploadTicketCapability = async (file) => {
      log.push("ticket");
      if (over.mint) throw over.mint;
      minted.push(file);
      return {
        url: "https://files.slack.com/upload/v1/ticket-1?x=y",
        complete: async (lead) => {
          log.push("complete");
          if (over.complete) throw over.complete;
          completed.push(lead);
        },
      };
    };
    return { uploadTicket, minted, completed };
  }

  function harness(
    over: Parameters<typeof storeExecutor>[1] & {
      remainingMs?: number;
      artifactUrl?: (key: string) => string | undefined;
      reply?: (text: string) => Promise<void>;
    } = {},
  ) {
    const store = new InMemoryArtifactStore({ bucket: "test" });
    const { commands, log, executor } = storeExecutor(store, over);
    const tickets = ticketing(log);
    const replies: string[] = [];
    const events: RunEvent[] = [];
    let seq = 0;
    const ctx: ToolContext = {
      executor,
      artifacts: {
        store,
        runId: "r1",
        nextSeq: () => ++seq,
        ...(over.artifactUrl ? { artifactUrl: over.artifactUrl } : {}),
        reply: over.reply ?? (async (t) => void replies.push(t)),
      },
      uploadTicket: tickets.uploadTicket,
      publish: (e) => {
        log.push(e.type);
        events.push(e);
      },
      ...(over.remainingMs !== undefined ? { remainingMs: () => over.remainingMs! } : {}),
    };
    return { store, commands, log, executor, tickets, replies, events, ctx };
  }

  it("happy path: stat → presigned PUT → HEAD → artifact event → ticket → POST → complete, each command under the 20-minute cap, and the result names the size", async () => {
    const h = harness();
    const out = await attachFileTool.run({ path: "shots/page.png", comment: "the page" }, h.ctx);
    expect(out).toBe("attached page.png (3145728 bytes) to the conversation and the run page");
    expect(h.commands.map((c) => c.command.split(" ").slice(0, 3).join(" "))).toEqual([
      "stat -c %s",
      "curl -fsS -T",
      "curl -fsS --upload-file",
    ]);
    expect(h.commands[0]!.command).toBe("stat -c %s -- 'shots/page.png'");
    expect(h.commands[1]!.command).toMatch(PUT_URL);
    expect(h.commands[1]!.command).toContain("runs/r1/out/1-page.png");
    expect(h.commands[2]!.command).toBe(
      "curl -fsS --upload-file 'shots/page.png' -X POST 'https://files.slack.com/upload/v1/ticket-1?x=y'",
    );
    expect(h.commands.map((c) => c.timeoutMs)).toEqual([30_000, BASH_TIMEOUT_MAX_MS, BASH_TIMEOUT_MAX_MS]);
    // The event is recorded once the store holds the verified object, BEFORE the share completes.
    expect(h.log).toEqual(["stat", "put", "artifact", "ticket", "post", "complete"]);
    expect(h.events).toEqual([
      {
        type: "artifact",
        direction: "out",
        key: "runs/r1/out/1-page.png",
        name: "page.png",
        size: SIZE,
        contentType: "image/png",
      },
    ]);
    expect(h.tickets.minted).toEqual([{ name: "page.png", size: SIZE }]);
    expect(h.tickets.completed).toEqual(["the page"]);
    expect(h.replies).toEqual([]);
    expect(await h.store.head("runs/r1/out/1-page.png")).toEqual({ size: SIZE, contentType: "image/png" });
  });

  it("two files of one name in one run take keys 1- and 2-, and two events", async () => {
    const h = harness();
    await attachFileTool.run({ path: "shots/page.png" }, h.ctx);
    await attachFileTool.run({ path: "shots/page.png" }, h.ctx);
    expect(h.events.map((e) => (e.type === "artifact" ? e.key : e.type))).toEqual([
      "runs/r1/out/1-page.png",
      "runs/r1/out/2-page.png",
    ]);
    expect(h.tickets.completed).toEqual(["page.png", "page.png"]); // the lead defaults to the name
  });

  it("a HEAD that answers a different size stops the chain: no ticket, no complete, no event; both sizes named", async () => {
    const h = harness({ sizeInStore: 1024 });
    const out = await attachFileTool.run({ path: "shots/page.png" }, h.ctx);
    expect(out).toBe(
      "error: the artifact store holds 1024 bytes for page.png, not the 3145728 measured — nothing was posted",
    );
    expect(h.log).toEqual(["stat", "put"]);
    expect(h.events).toEqual([]);
    expect(h.tickets.minted).toEqual([]);
  });

  it("a failed PUT carries curl's words; nothing is verified, recorded or minted", async () => {
    const h = harness({ put: "exit 22:\ncurl: (22) The requested URL returned error: 403" });
    const out = await attachFileTool.run({ path: "shots/page.png" }, h.ctx);
    expect(out).toBe(
      "error: the upload of page.png to the artifact store failed: exit 22:\ncurl: (22) The requested URL returned error: 403",
    );
    expect(h.log).toEqual(["stat", "put"]);
    expect(h.events).toEqual([]);
  });

  it("a failed POST to the channel keeps the store copy and its event: no complete, curl's words and where the file is", async () => {
    const h = harness({ post: "exit 56:\ncurl: (56) Recv failure: Connection reset by peer" });
    const out = await attachFileTool.run({ path: "shots/page.png" }, h.ctx);
    expect(out).toBe(
      "error: the upload of page.png to the channel failed: exit 56:\ncurl: (56) Recv failure: Connection reset by peer; the file is kept on the run page",
    );
    expect(h.log).toEqual(["stat", "put", "artifact", "ticket", "post"]);
    expect(h.tickets.completed).toEqual([]);
    expect(h.events).toHaveLength(1);
  });

  it("a `complete` the channel refuses carries the platform's words; the event stands", async () => {
    const store = new InMemoryArtifactStore({ bucket: "test" });
    const { log, executor } = storeExecutor(store);
    const tickets = ticketing(log, { complete: new Error("An API error occurred: file_not_found") });
    const events: RunEvent[] = [];
    const ctx: ToolContext = {
      executor,
      artifacts: { store, runId: "r1", nextSeq: () => 1, reply: async () => {} },
      uploadTicket: tickets.uploadTicket,
      publish: (e) => void events.push(e),
    };
    const out = await attachFileTool.run({ path: "shots/page.png" }, ctx);
    expect(out).toBe(
      "error: the channel refused to complete the upload of page.png: An API error occurred: file_not_found; the file is kept on the run page",
    );
    expect(events).toHaveLength(1);
  });

  it("a refused ticket is named and the store copy kept; a missing file and an empty file are stat's words, nothing minted", async () => {
    const store = new InMemoryArtifactStore({ bucket: "test" });
    const { log, executor } = storeExecutor(store);
    const tickets = ticketing(log, { mint: new Error("An API error occurred: missing_scope") });
    const ctx: ToolContext = {
      executor,
      artifacts: { store, runId: "r1", nextSeq: () => 1, reply: async () => {} },
      uploadTicket: tickets.uploadTicket,
    };
    expect(await attachFileTool.run({ path: "shots/page.png" }, ctx)).toBe(
      "error: the channel refused an upload ticket for page.png: An API error occurred: missing_scope; the file is kept on the run page",
    );
    const missing = harness({ stat: "exit 1:\nstat: cannot statx 'shots/page.png': No such file or directory" });
    expect(await attachFileTool.run({ path: "shots/page.png" }, missing.ctx)).toBe(
      "error: could not read shots/page.png: exit 1:\nstat: cannot statx 'shots/page.png': No such file or directory",
    );
    const empty = harness({ stat: "0\n" });
    expect(await attachFileTool.run({ path: "shots/page.png" }, empty.ctx)).toBe(
      "error: shots/page.png is empty — nothing to attach",
    );
    for (const h of [missing, empty]) {
      expect(h.log).toEqual(["stat"]);
      expect(h.events).toEqual([]);
    }
  });

  it("a file over 1 GiB is refused by name before any mint", async () => {
    const h = harness({ stat: `${MAX_ARTIFACT_BYTES + 1}\n` });
    const out = await attachFileTool.run({ path: "shots/page.png" }, h.ctx);
    expect(out).toBe(
      `error: shots/page.png is ${MAX_ARTIFACT_BYTES + 1} bytes; attach_file takes files up to ${MAX_ARTIFACT_BYTES} bytes (1 GiB) — link to the file instead`,
    );
    expect(h.log).toEqual(["stat"]);
    expect(h.tickets.minted).toEqual([]);
  });

  it("a run with three minutes left cannot move a 1 GB file: refused before any mint, naming the budget; a 3 MiB screenshot still goes, clipped to the clock", async () => {
    const big = harness({ stat: "1000000000\n", remainingMs: 3 * 60_000 });
    const out = await attachFileTool.run({ path: "shots/page.png" }, big.ctx);
    expect(out).toMatch(
      /^error: page\.png is 1000000000 bytes and needs about 98\ds to move at 1024 KB\/s; the run has 120s of command budget left/,
    );
    expect(big.log).toEqual(["stat"]);
    const small = harness({ remainingMs: 3 * 60_000 });
    expect(await attachFileTool.run({ path: "shots/page.png" }, small.ctx)).toContain("attached page.png");
    expect(small.commands.map((c) => c.timeoutMs)).toEqual([30_000, 120_000, 120_000]);
    // Inside the write-up reserve nothing runs at all.
    const spent = harness({ remainingMs: 30_000 });
    expect(await attachFileTool.run({ path: "shots/page.png" }, spent.ctx)).toMatch(/^error: run budget exhausted/);
    expect(spent.log).toEqual(["stat"]);
  });

  // record 0033: a channel without an upload ticket — the CLI harness, HTTP, MCP —
  // takes the store-only path. The lead carries the FILE's own link (the run page's artifact
  // proxy, with the run's live token while the run is live), the result names the key, and
  // nothing pretends a channel upload happened.
  it("a channel without an upload ticket gets the lead and the file's proxy link through `reply`; the result names the key; the store copy and event stand", async () => {
    const h = harness({
      artifactUrl: (key) => `https://bot.example.com/runs/r1/artifacts/${key}?t=live-token`,
    });
    delete h.ctx.uploadTicket;
    const out = await attachFileTool.run({ path: "shots/page.png", comment: "the page" }, h.ctx);
    expect(out).toBe(
      "attached page.png (3145728 bytes) to the run page as runs/r1/out/1-page.png; this conversation's channel takes no file uploads, so the lead and the file's link were posted instead",
    );
    expect(h.replies).toEqual([
      "the page\n📎 page.png (3145728 bytes) — https://bot.example.com/runs/r1/artifacts/runs/r1/out/1-page.png?t=live-token",
    ]);
    expect(h.log).toEqual(["stat", "put", "artifact"]);
  });

  it("without a public URL the lead still names the file and its key on the run page — never a bare 'attached' with nowhere to look", async () => {
    const h = harness();
    delete h.ctx.uploadTicket;
    await attachFileTool.run({ path: "shots/page.png" }, h.ctx);
    expect(h.replies).toEqual(["page.png\n📎 page.png (3145728 bytes) is on the run page as runs/r1/out/1-page.png"]);
  });

  it("the three ticketless channel shapes — the CLI harness, HTTP, MCP — carry `reply` and no `uploadTicket`; through the harness the lead with the link lands on its stream", async () => {
    const chunks: string[] = [];
    const out = { write: (chunk: string) => (chunks.push(chunk), true) } as unknown as NodeJS.WritableStream;
    const console = new ConsoleIO(out, "cli:work");
    for (const io of [console, new HttpIO(), new McpIO()] as ChannelIO[]) {
      expect(typeof io.reply).toBe("function");
      expect(io.uploadTicket).toBeUndefined();
    }
    const h = harness({
      artifactUrl: (key) => `https://bot.example.com/runs/r1/artifacts/${key}?t=live-token`,
      reply: (text) => console.reply(text),
    });
    delete h.ctx.uploadTicket;
    const result = await attachFileTool.run({ path: "shots/page.png", comment: "the page" }, h.ctx);
    expect(result).toMatch(/^attached page\.png \(3145728 bytes\) to the run page as runs\/r1\/out\/1-page\.png;/);
    expect(chunks.join("")).toBe(
      "\nthe page\n📎 page.png (3145728 bytes) — https://bot.example.com/runs/r1/artifacts/runs/r1/out/1-page.png?t=live-token\n",
    );
    expect(h.tickets.minted).toEqual([]);
  });

  it("with a store the inline path is not taken: no readBytes, no attachFile; without a store it runs exactly as before", async () => {
    const h = harness();
    let inline = 0;
    h.ctx.attach = async () => void inline++;
    h.executor.readBytes = async () => {
      inline++;
      return png;
    };
    await attachFileTool.run({ path: "shots/page.png" }, h.ctx);
    expect(inline).toBe(0);
    const { posted, attach } = attaching();
    const out = await attachFileTool.run({ path: "a.png" }, { executor: executor({ "a.png": png }), attach });
    expect(out).toBe("attached a.png (7 bytes) to the conversation");
    expect(posted).toHaveLength(1);
  });

  it("the command strings carry the presigned query but never the secret access key or the copy bearer (R2 store over a fetch double)", async () => {
    const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const COPY = "copy-bearer-value";
    const store = new R2ArtifactStore({
      accountId: "acme-account",
      bucket: "switchboard-artifacts",
      accessKeyId: new Secret("example-access-key", "ARTIFACTS_R2_ACCESS_KEY_ID"),
      secretAccessKey: new Secret(SECRET, "ARTIFACTS_R2_SECRET_ACCESS_KEY"),
      copy: { baseUrl: "https://bot.example.com", token: new Secret(COPY, "ARTIFACTS_COPY_TOKEN") },
      fetch: (async () =>
        new Response(null, {
          status: 200,
          headers: { "content-length": String(SIZE), "content-type": "image/png" },
        })) as unknown as typeof fetch,
      clock: () => Date.UTC(2026, 8, 14),
    });
    const commands: string[] = [];
    const exec: Executor["exec"] = async (command) => {
      commands.push(command);
      return command.startsWith("stat ") ? `${SIZE}\n` : "";
    };
    const { uploadTicket } = ticketing([]);
    const ctx: ToolContext = {
      executor: { exec, readFile: async () => "", writeFile: async () => "" },
      artifacts: { store, runId: "r1", nextSeq: () => 1, reply: async () => {} },
      uploadTicket,
    };
    expect(await attachFileTool.run({ path: "shots/page.png" }, ctx)).toContain("attached page.png");
    const all = commands.join("\n");
    expect(all).toContain("X-Amz-Credential=example-access-key");
    expect(all).toContain("X-Amz-Signature=");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(encodeURIComponent(SECRET));
    expect(all).not.toContain(COPY);
  });
});
